import {config} from './config.mjs';
import {contextSnapshot} from './context-manager.mjs';

export class BudgetError extends Error {
  code = 'BUDGET_EXHAUSTED';
  constructor(message) { super(message); }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function readRunBudget(store, rootRunId) {
  const events = store.query("SELECT type, payload FROM events WHERE run = ? AND type GLOB 'budget_*' ORDER BY seq", 'all', rootRunId);
  const initial = events.find(event => event.type === 'budget_started');
  if (!initial) return null;
  const {limits, startedAt} = JSON.parse(initial.payload);
  const entries = new Map();
  let endedAt = null;
  for (const {type, payload} of events) {
    const event = JSON.parse(payload);
    if (type === 'budget_reserved') entries.set(event.id, event);
    if (type === 'budget_settled' && entries.has(event.id)) Object.assign(entries.get(event.id), event);
    if (type === 'budget_finished') endedAt = event.endedAt;
  }
  const run = store.run(rootRunId);
  const terminal = run.status !== 'running';
  if (terminal && endedAt === null) {
    const event = store.query("SELECT payload FROM events WHERE run = ? AND type = 'finished' ORDER BY seq DESC LIMIT 1", 'get', rootRunId);
    endedAt = event ? JSON.parse(event.payload).ended : null;
  }
  const ledger = [...entries.values()].map(entry => ({...entry,
    status: entry.status ?? (terminal ? 'interrupted' : 'in_flight')}));
  return {rootRunId, limits, elapsedMs: Math.max(0, (endedAt ?? Date.now()) - startedAt),
    ...totals(ledger), entries: ledger};
}

function totals(entries) {
  const usage = {modelCalls: 0, toolCalls: 0, engineCalls: 0, retries: 0, inFlight: 0, estimatedInputTokens: 0,
    actualInputTokens: 0, actualOutputTokens: 0, chargedInputTokens: 0, chargedOutputTokens: 0, unknownModelUsage: 0};
  for (const entry of entries) {
    usage[entry.kind + 'Calls']++;
    if (!entry.status || entry.status === 'in_flight') usage.inFlight++;
    if (entry.kind !== 'model') continue;
    if (entry.attempt > 1) usage.retries++;
    usage.estimatedInputTokens += entry.estimatedInputTokens;
    usage.actualInputTokens += entry.inputTokens ?? 0;
    usage.actualOutputTokens += entry.outputTokens ?? 0;
    usage.chargedInputTokens += entry.inputTokens ?? entry.estimatedInputTokens;
    usage.chargedOutputTokens += entry.outputTokens ?? entry.outputReserved;
    if (entry.inputTokens == null || entry.outputTokens == null) usage.unknownModelUsage++;
  }
  return usage;
}

export function createRunBudget({store, rootRunId, signal, limits: overrides}) {
  const limits = Object.freeze({...config.runBudget, maxModelCalls: 5, ...overrides});
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(limits.maxSeconds * 1000);
  const bound = AbortSignal.any([signal, deadline]);
  const entries = [];
  let closed = false;
  const record = (type, payload) => store.record(rootRunId, type, {rootRunId, ...payload});
  record('budget_started', {limits, startedAt});

  function check(kind, input = 0, output = 0) {
    signal.throwIfAborted();
    if (deadline.aborted || Date.now() >= startedAt + limits.maxSeconds * 1000) throw new BudgetError('根任务时间预算已耗尽');
    if (closed) throw new BudgetError('根任务预算已关闭');
    const usage = totals(entries);
    let message;
    if (kind === 'model' && usage.modelCalls >= limits.maxModelCalls) message = '本轮共享模型调用预算已耗尽';
    else if (kind === 'tool' && usage.toolCalls >= limits.maxToolCalls) message = '根任务工具调用预算已耗尽';
    else if (kind === 'engine' && usage.engineCalls >= limits.maxToolCalls) message = '根任务引擎调用预算已耗尽';
    else if (entries.filter(entry => !entry.status && entry.kind === kind).length >= limits.maxConcurrent) message = '根任务并发预算已耗尽';
    else if (kind === 'model' && usage.chargedInputTokens + input > limits.maxInputTokens) message = '根任务累计输入预算已耗尽';
    else if (kind === 'model' && usage.chargedOutputTokens + output > limits.maxOutputTokens) message = '根任务累计输出预算已耗尽';
    if (message) {
      record('budget_denied', {kind, message});
      throw new BudgetError(message);
    }
  }

  // Reserve synchronously before I/O. Each root run is owned by one live process.
  function reserve(kind, details, requestSignal = bound) {
    requestSignal.throwIfAborted();
    check(kind, details.estimatedInputTokens, details.outputReserved);
    const entry = {id: entries.length + 1, kind, ...details, startedAt: Date.now()};
    record('budget_reserved', entry);
    entries.push(entry);
    return ({status, usage, reportedModel, finishReason, httpStatus} = {}) => {
      if (entry.status) return;
      const aborted = deadline.aborted || requestSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
      const settlement = {id: entry.id, status: requestSignal.aborted ? aborted : status ?? 'failed',
        elapsedMs: Math.max(0, Date.now() - entry.startedAt),
        ...(kind === 'model' ? {inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens),
          reportedModel: reportedModel ?? null, finishReason: finishReason ?? null, httpStatus: httpStatus ?? null} : {})};
      record('budget_settled', settlement);
      Object.assign(entry, settlement);
    };
  }

  async function operation(kind, phase, name, call, requestSignal = bound) {
    const combined = AbortSignal.any([bound, requestSignal]);
    const settle = reserve(kind, {phase, name}, combined);
    try {
      const result = await call(combined);
      settle({status: result?.ok === false ? 'failed' : 'completed'});
      return result;
    } catch (error) {
      settle({status: error?.name === 'TimeoutError' ? 'timeout' : 'failed'});
      if (deadline.aborted && !signal.aborted) throw new BudgetError('根任务时间预算已耗尽');
      throw error;
    }
  }

  return {
    rootRunId, signal: bound, deadline, limits, remainingMs: () => Math.max(0, startedAt + limits.maxSeconds * 1000 - Date.now()),
    canCallModel: () => totals(entries).modelCalls < limits.maxModelCalls,
    modelUsage: phase => totals(entries.filter(entry => entry.kind === 'model' && entry.phase.startsWith(phase))),
    tool: (phase, name, call, requestSignal) => operation('tool', phase, name, call, requestSignal),
    engine: (phase, name, call, requestSignal) => operation('engine', phase, name, call, requestSignal),
    async invoke(model, {phase, reduction, ...options}) {
      const maxTokens = options.maxTokens ?? 4096;
      const requestSignal = AbortSignal.any([bound, options.signal ?? bound]);
      const context = contextSnapshot(options.messages, options.tools, maxTokens, reduction);
      const contextLimit = Math.min(limits.contextTokens, model.contextTokens ?? limits.contextTokens);
      record('context_snapshot', {phase, ...context, contextLimit});
      if (context.estimatedTokens + maxTokens > contextLimit) {
        const message = '本次请求超出上下文预算，请缩小输入或分段处理。';
        record('budget_denied', {kind: 'model', message});
        throw new BudgetError(message);
      }
      const prepareAttempt = attempt => reserve('model', {phase, attempt, model: model.label,
        estimatedInputTokens: context.estimatedTokens, outputReserved: maxTokens, contextSha256: context.sha256}, requestSignal);
      const args = {...options, maxTokens, signal: requestSignal};
      let settle;
      try {
        if (model.accountsProviderAttempts) {
          args.prepareAttempt = prepareAttempt;
          args.beforeRetry = () => check('model', context.estimatedTokens, maxTokens);
        } else settle = prepareAttempt(1);
        const result = await model.invoke(args);
        settle?.({status: 'completed', ...result});
        requestSignal.throwIfAborted();
        const usage = totals(entries);
        if (usage.chargedInputTokens > limits.maxInputTokens || usage.chargedOutputTokens > limits.maxOutputTokens) {
          const message = '服务商报告的用量超出根任务预算，已停止继续执行。';
          record('budget_denied', {kind: 'model', message});
          throw new BudgetError(message);
        }
        return result;
      } catch (error) {
        settle?.({status: error?.name === 'TimeoutError' ? 'timeout' : 'failed'});
        if (deadline.aborted && !signal.aborted) throw new BudgetError('根任务时间预算已耗尽');
        throw error;
      }
    },
    finish() {
      if (closed) return;
      closed = true;
      record('budget_finished', {endedAt: Date.now(), elapsedMs: Date.now() - startedAt, ...totals(entries)});
    },
  };
}
