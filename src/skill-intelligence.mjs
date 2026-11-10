import {createHash, randomUUID} from 'node:crypto';
import {object, validate} from './schema.mjs';
import {failure, resultSchema, success} from './tool-contract.mjs';

const text = (maxLength = 1000) => ({type: 'string', minLength: 1, maxLength});
const list = (items, maxItems = 20) => ({type: 'array', items, maxItems});
const sha = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const ref = object({id: text(180), version: text(80)});
const limit = {type: 'integer', minimum: 1, maximum: 20};
const relation = object({source: ref, target: ref, type: {enum: ['depend_on', 'compose_with', 'similar_to']}});
const errors = {
  ENGINE_UNAVAILABLE: '技能引擎不可用。', ENGINE_TIMEOUT: '技能引擎响应超时。', ABORTED: '技能引擎调用已取消。',
  INVALID_CONTRACT: '技能引擎输入或返回不符合契约。', SNAPSHOT_CHANGED: '技能引擎返回的快照与本轮不一致。',
  UNKNOWN_REFERENCE: '技能引擎引用了本轮不可用的技能。', BUDGET_EXHAUSTED: '根任务额度不足，技能引擎未能完成。',
  SOURCE_NOT_ALLOWED: '技能来源未获授权或不能固定版本。', PROVIDER_ERROR: '技能引擎调用失败。',
};
const schemas = {
  search: {
    parameters: object({goal: text(8000), snapshotSha256: sha, limit, mode: {enum: ['local', 'semantic', 'hybrid']}}),
    data: object({snapshotSha256: sha, candidates: list(object({skill: ref, reason: text(), path: list(ref, 8)}))}),
  },
  plan: {
    parameters: object({snapshotSha256: sha, candidates: list(ref), relations: list(relation, 80), inputSummary: text(8000)}),
    data: object({snapshotSha256: sha, relations: list(relation, 80), missing: list(text()), conflicts: list(text())}),
  },
  discover: {
    parameters: object({publicTags: {...list(text(120)), minItems: 1}, allowedSources: {...list(text(300)), minItems: 1}, limit}),
    data: object({sources: list(object({source: text(300), commit: {type: 'string', pattern: '^[a-f0-9]{40}$'},
      license: text(180), contentSha256: sha, title: text()}))}),
  },
  propose: {
    parameters: object({snapshotSha256: sha, parent: ref, parentSha256: sha, evidenceSeqs: list({type: 'integer', minimum: 1}, 40),
      correction: text(8000), operator: {enum: ['distill', 'mutate', 'compose', 'generate']}}),
    data: object({snapshotSha256: sha, parent: ref, parentSha256: sha, draft: text(60000), diff: text(60000)}),
  },
};
Object.assign(schemas.discover.data.properties.sources.items.properties, {
  body: {type: 'string', minLength: 1, maxLength: 65536},
  pinnedUrl: text(1500), licenseSha256: sha, licensePath: text(300), retrievedAt: text(80),
});

export const skillIntelligenceContract = {
  version: 2, timeoutMs: 30000, errors,
  operations: Object.entries(schemas).map(([name, {parameters, data}]) => ({name, parameters, timeoutMs: name === 'discover' ? 60000 : 30000,
    idempotent: name !== 'propose', authorization: '宿主冻结允许的引用和来源，不授予写入权限。',
    returns: resultSchema(object({provider: text(80), version: text(80), fallback: {anyOf: [{enum: [null]}, {enum: Object.keys(errors)}]}, result: data}))})),
  authorization: '宿主绑定冻结快照和授权来源。引擎输出仅为建议。外部发现只接收获准公开的标签，候选草案不得写入正式库。',
};

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = ({id, version}) => JSON.stringify([id, version]);
const sourceAllowed = source => {
  try { const url = new URL(source); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};

export async function invokeSkillIntelligence({name, input, provider, fallback, allowedRefs = [], relations = [], budget, signal = budget.signal, emit = () => {}}) {
  const schema = schemas[name];
  const refs = new Set(allowedRefs.map(key));
  const known = ref => refs.has(key(ref));
  const linked = relations => relations.every(edge => known(edge.source) && known(edge.target));
  const invocationId = randomUUID();
  if (!Object.hasOwn(schemas, name) || validate(schema.parameters, input).length) return failure(errors, 'INVALID_CONTRACT');
  if (name === 'discover' && !input.allowedSources.every(sourceAllowed)) return failure(errors, 'SOURCE_NOT_ALLOWED');
  if (name === 'plan' && (!input.candidates.every(known) || !linked(input.relations)) ||
      name === 'propose' && !known(input.parent)) return failure(errors, 'UNKNOWN_REFERENCE');

  async function attempt(engine) {
    const started = performance.now();
    const timeoutMs = skillIntelligenceContract.operations.find(item => item.name === name).timeoutMs;
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, budget.remainingMs())));
    const bound = AbortSignal.any([budget.signal, signal, timeout]);
    let data, code, version = null;
    try {
      if (!engine?.[name]) code = 'ENGINE_UNAVAILABLE';
      else {
        const reply = await budget.engine('skill-intelligence', name, requestSignal =>
          withAbort(requestSignal, () => engine[name](structuredClone(input), {
            signal: requestSignal, ...(name === 'search' ? {allowedRefs: structuredClone(allowedRefs), relations: structuredClone(relations)} : {}),
          })), bound);
        version = reply?.version;
        data = reply?.data;
        if (validate(text(80), engine.id).length || validate(text(80), version).length || validate(schema.data, data).length) code = 'INVALID_CONTRACT';
        else if (input.snapshotSha256 && data.snapshotSha256 !== input.snapshotSha256) code = 'SNAPSHOT_CHANGED';
        else if (name === 'search' && (data.candidates.length > input.limit ||
          !data.candidates.every(item => known(item.skill) && item.path.every(known)))) code = 'UNKNOWN_REFERENCE';
        else if (name === 'plan' && !linked(data.relations) ||
          name === 'propose' && (key(data.parent) !== key(input.parent) || data.parentSha256 !== input.parentSha256)) code = 'UNKNOWN_REFERENCE';
        else if (name === 'discover' && (data.sources.length > input.limit ||
          !data.sources.every(item => input.allowedSources.includes(item.source) &&
            (!item.body || createHash('sha256').update(item.body).digest('hex') === item.contentSha256) &&
            (!item.pinnedUrl || item.pinnedUrl.includes('/blob/' + item.commit + '/'))))) code = 'SOURCE_NOT_ALLOWED';
      }
    } catch (error) {
      code = budget.deadline.aborted || error.code === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' :
        signal.aborted || budget.signal.aborted ? 'ABORTED' : timeout.aborted ? 'ENGINE_TIMEOUT' :
          Object.hasOwn(errors, error.code) ? error.code : 'PROVIDER_ERROR';
    }
    emit('skill_engine_call', {invocationId, name, provider: engine?.id ?? null, version: typeof version === 'string' ? version.slice(0, 80) : null,
      inputSha256: digest(input), responseSha256: code ? null : digest(data), elapsedMs: Math.round(performance.now() - started),
      code: code ?? 'OK'});
    return code ? failure(errors, code) : success({provider: engine.id, version, fallback: null, result: data});
  }

  const primary = await attempt(provider);
  if (primary.ok || !fallback || signal.aborted || ['ABORTED', 'BUDGET_EXHAUSTED'].includes(primary.error.code)) return primary;
  const local = await attempt(fallback);
  emit('skill_engine_fallback', {invocationId, name, reason: primary.error.code, outcome: local.error.code});
  return local.ok ? success({...local.data, fallback: primary.error.code}) : local;
}

async function withAbort(signal, call) {
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, {once: true});
  });
  try { return await Promise.race([aborted, Promise.resolve().then(() => { signal.throwIfAborted(); return call(); })]); }
  finally { signal.removeEventListener('abort', cancel); }
}
