import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {Store} from '../src/store.mjs';
import {executeRun} from '../src/runner.mjs';
import {readRunBudget} from '../src/run-budget.mjs';
import {readRunWorkers} from '../src/readonly-workers.mjs';
import {localModel} from './local-model.mjs';
import {config} from '../src/config.mjs';

const [source, outputDirectory, requestedModel = 'deepseek-v4.1-flash-1017', mode = 'run'] = process.argv.slice(2);
if (!source || !outputDirectory || !['run', '--verify'].includes(mode)) {
  throw new Error('用法：node scripts/check-repro-audit.mjs <SkillNet 源码目录> <结果目录> [模型 ID] [--verify]');
}
const output = resolve(outputDirectory);
const commit = '0af2de6a9c8b129e174e3442b67c5f7cb4324db9a';
const read = (path, offset, limit) => ({path, offset, limit});
const groups = [
  [read('README.md', 68, 6), read('README.md', 137, 15), read('requirements-dev.txt', 0, 2)],
  [read('requirements.txt', 0, 15), read('docs/evidence/frontier-ci.json', 0, 9)],
];
const checks = [
  {id: 'python', task: '最低 Python 版本', status: 'verified', anchors: [['README.md', 70], ['requirements.txt', 1]], includes: ['3.11']},
  {id: 'test_setup', task: '安装开发依赖的命令', status: 'verified', anchors: [['README.md', 139]], includes: ['pip install -r requirements-dev.txt']},
  {id: 'test_command', task: '运行 pytest 的命令', status: 'verified', anchors: [['README.md', 140]], includes: ['pytest tests -q']},
  {id: 'dependency_lock', task: '给定依赖声明是否锁定了全部精确版本', status: 'missing',
    anchors: [['requirements-dev.txt', 2], ['requirements.txt', 3]], includes: []},
  {id: 'head_ci', task: '给定历史记录能否证明本次固定提交的 CI 已通过', status: 'uncertain',
    anchors: [['docs/evidence/frontier-ci.json', 3], ['docs/evidence/frontier-ci.json', 8]], includes: ['bdcf10e']},
  {id: 'paid_coverage', task: 'README 描述的 CI 是否覆盖付费在线实验', status: 'missing', anchors: [['README.md', 152]], includes: ['付费']},
];
const paths = [...new Set(groups.flat().map(file => file.path))];
const git = (...args) => execFileSync('git', ['-C', source, ...args], {maxBuffer: 250_000, windowsHide: true});
const input = new Map(paths.map(path => [path, git('show', commit + ':' + path)]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lines = text => text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
const protocol = {version: 3, source: 'https://github.com/qing1989620/skillnet-demo', commit, checks, groups,
  harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true}).trim(),
  modelCallsPerArm: 6, secondsPerArm: config.runBudget.maxSeconds, effort: 'default',
  inputSha256: Object.fromEntries([...input].map(([path, bytes]) => [path, sha(bytes)]))};

const prompt = [
  '复现核对：根据指定公开项目材料，给出能否复跑离线 pytest 的准备清单。核对的是材料证据，请勿运行实验。',
  '当前材料固定提交为 ' + commit + '。结论只限读到的片段，不查网络。',
  '清单项目：' + checks.map(check => check.id + ' = ' + check.task).join('；') + '。',
  'status 表示该项复现条件是否具备：verified = 条件已满足；missing = 材料明确说明该条件缺失或未覆盖；uncertain = 不能判断条件是否满足。',
  '即使“缺失”有明确原文证据，status 仍写 missing，而不是 verified。不可把“结论可核实”和“条件已满足”混用。',
  'missing 要有直接证据否定本项条件；未提供本次证据或证据只对应其他对象，应写 uncertain。历史版本的成功记录不能判定当前版本成功或失败。',
  '每项 claim 最多 100 字，evidence 只引最相关的一行，quote 最多 80 字。不得复述过程。',
  '引用前自检：read_file 的 offset 从 0 起，content 第 i 行的原文件行号 = offset + i（i 从 1 起）。空行也占行号。逐项对齐原文后再输出。',
  '最终只返回 JSON {"findings":[{"id":"…","status":"…","claim":"…","evidence":[{"path":"…","line":1,"quote":"该行的连续原文"}]}]}。line 为从 1 开始的原文件行号。引用简短原文并准确保留大小写。',
].join('\n');
const modes = {
  single: '请用一批 read_file 读取以下五段，再自行汇总。参数：' + JSON.stringify(groups.flat()),
  workers: '请调用一次 delegate_readonly，创建两个独立 Worker。不要自行读取。把 status 定义原样交给 Worker：verified=复现条件已满足，missing=直接证据否定本项条件，uncertain=证据不足或证据只对应其他对象。' +
    '每个 Worker 只返回相关项的 id、status、40 字内结论及一条 path/line/quote 引用，quote 最多 60 字，整个回复最多 450 字，不写过程。' +
    'Worker 引用行号必须按 offset + content 行序核对（包括空行）。保留 CI 的提交哈希和付费范围。Worker 失败时主任务仍输出全部 findings，各项标 uncertain 和空 evidence，不询问用户。输入清单（按组分给两个 Worker）：' + JSON.stringify(groups),
};

function parseFindings(answer) {
  try {
    const value = JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    return Array.isArray(value?.findings) ? value.findings : [];
  } catch { return []; }
}

function score(findings, receipts) {
  const expected = new Set(checks.map(check => check.id));
  const validCitation = value => {
    if (!value || typeof value.quote !== 'string' || value.quote.trim().length < 5 || !Number.isSafeInteger(value.line) || value.line < 1) return false;
    const bytes = input.get(value.path);
    const original = bytes && lines(bytes.toString('utf8'))[value.line - 1];
    if (!original?.includes(value.quote.trim())) return false;
    return receipts.some(receipt => receipt.path === value.path && receipt.sha256 === protocol.inputSha256[value.path] &&
      value.line > receipt.offset && value.line <= receipt.offset + receipt.linesReturned &&
      lines(receipt.excerpt)[value.line - receipt.offset - 1]?.includes(value.quote.trim()));
  };
  const rows = checks.map(check => {
    const matches = findings.filter(item => item?.id === check.id);
    const item = matches[0];
    const citations = Array.isArray(item?.evidence) ? item.evidence : [];
    const passed = matches.length === 1 && item.status === check.status && typeof item.claim === 'string' && item.claim.trim() &&
      check.includes.every(value => item.claim.includes(value)) && citations.length > 0 && citations.every(validCitation) &&
      citations.some(value => check.anchors.some(([path, line]) => value.path === path && value.line === line));
    return {id: check.id, passed: Boolean(passed), item: item ?? null};
  });
  const citations = findings.flatMap(item => Array.isArray(item?.evidence) ? item.evidence : []);
  return {passed: rows.filter(item => item.passed).length, total: rows.length, missingItems: rows.filter(row => !row.item).length,
    validCitations: citations.filter(validCitation).length, totalCitations: citations.length,
    extraItems: findings.filter(item => !expected.has(item?.id)).length, rows};
}

// Resolve against actual read receipts only. Expected answers never participate.
function resolveCitations(findings, receipts) {
  const corrections = [], issues = [];
  const resolved = findings.map(item => ({...item, evidence: (Array.isArray(item.evidence) ? item.evidence : []).map(citation => {
    if (typeof citation?.quote !== 'string' || citation.quote.trim().length < 5) {
      issues.push({id: item.id, code: 'INVALID_CITATION', citation});
      return citation;
    }
    const quote = citation.quote.trim();
    const candidates = new Set();
    for (const receipt of receipts) {
      if (receipt.path !== citation.path || receipt.sha256 !== protocol.inputSha256[citation.path]) continue;
      for (const [index, text] of lines(receipt.excerpt).slice(0, receipt.linesReturned).entries()) {
        if (text.includes(quote)) candidates.add(receipt.offset + index + 1);
      }
    }
    if (candidates.has(citation.line)) return citation;
    if (candidates.size !== 1) {
      issues.push({id: item.id, code: candidates.size ? 'AMBIGUOUS_CITATION' : 'CITATION_NOT_FOUND', citation});
      return citation;
    }
    const [line] = candidates;
    corrections.push({id: item.id, path: citation.path, quote: citation.quote, originalLine: citation.line, resolvedLine: line});
    return {...citation, line};
  })}));
  return {findings: resolved, corrections, issues};
}

async function verifyDelivery(arm, result) {
  const resolved = resolveCitations(parseFindings(result.answer ?? ''), result.receipts);
  const quality = score(resolved.findings, result.receipts);
  const accepted = result.status === 'completed' && quality.passed === quality.total &&
    quality.extraItems === 0 && resolved.issues.length === 0 &&
    (arm !== 'workers' || result.workers.length === 2 && result.workers.every(worker => worker.status === 'completed'));
  const verification = {accepted, rawQuality: result.quality, deliveredQuality: quality,
    corrections: resolved.corrections, issues: resolved.issues};
  await writeFile(join(output, arm + '-delivery.json'), JSON.stringify({findings: resolved.findings}, null, 2) + '\n');
  await writeFile(join(output, arm + '-verification.json'), JSON.stringify(verification, null, 2) + '\n');
  console.log(JSON.stringify({arm, accepted, rawPassed: result.quality.passed, deliveredPassed: quality.passed,
    total: quality.total, corrections: resolved.corrections.length, unresolved: resolved.issues.length}));
  return accepted;
}

if (mode === '--verify') {
  const recorded = JSON.parse(await readFile(join(output, 'protocol.json'), 'utf8'));
  assert.equal(recorded.commit, commit);
  assert.deepEqual(recorded.inputSha256, protocol.inputSha256);
  for (const arm of ['single', 'workers']) {
    const result = JSON.parse(await readFile(join(output, arm + '.json'), 'utf8'));
    assert.deepEqual(score(parseFindings(result.answer ?? ''), result.receipts), result.quality);
    if (!await verifyDelivery(arm, result)) process.exitCode = 1;
  }
} else {
  await mkdir(output, {recursive: true});
  const model = await localModel(requestedModel, protocol.effort);
  await writeFile(join(output, 'protocol.json'), JSON.stringify({...protocol, prompt, modes, requestedModel: model.label}, null, 2) + '\n', {flag: 'wx'});
  const prefix = join(resolve(tmpdir()), 'sih-repro-audit-');
  const projectPath = await mkdtemp(prefix);
  async function runArm(arm) {
    const store = new Store(':memory:');
    let heartbeat;
    try {
      const project = store.addProject(projectPath, 'SkillNet public snapshot');
      const task = store.createTask(project.id).id;
      const scope = {mode: 'project_read', projectPath, projectId: project.id};
      store.setFileAccess(task, scope.mode, project.id, false);
      const goal = prompt + '\n' + modes[arm];
      const {id} = store.begin(task, arm, goal, {mode: 'repro-audit', fileScope: scope, model: model.label});
      const start = performance.now();
      heartbeat = setInterval(() => {
        const budget = readRunBudget(store, id);
        console.log(JSON.stringify({arm, elapsedSeconds: Math.round((performance.now() - start) / 1000),
          modelCalls: budget.modelCalls, toolCalls: budget.toolCalls, inFlight: budget.inFlight,
          latest: budget.entries.at(-1)}));
      }, 30_000);
      await executeRun({id, task, prompt: goal, store, workspace: projectPath, scope, model, signal: new AbortController().signal,
        maxSteps: protocol.modelCallsPerArm, budgetLimits: {maxSeconds: protocol.secondsPerArm},
        skillAccess: true, entry: {}, toolAllowlist: arm === 'workers' ? ['delegate_readonly'] : ['read_file']});
      const elapsedMs = Math.round(performance.now() - start);
      const saved = store.task(task).runs[0];
      const events = store.events(id, 0);
      await writeFile(join(output, arm + '-events.json'), JSON.stringify(events, null, 2) + '\n');
      const workers = readRunWorkers(store, id);
      const receipts = workers.flatMap(worker => worker.reads.filter(read => read.ok)).concat(events.flatMap(event => {
        const file = event.type === 'tool_result' && event.payload.name === 'read_file' && event.payload.output?.data?.file;
        return file ? [{seq: event.seq, path: file.path, sha256: file.sha256, offset: file.offset, linesReturned: file.lines_returned,
          excerpt: file.content, truncated: event.payload.output.data.truncated}] : [];
      }));
      const budget = readRunBudget(store, id);
      const result = {arm, runId: id, status: saved.status, error: saved.error, elapsedMs, answer: saved.answer, workers, receipts,
        budget, model: model.label, reportedModels: [...new Set(budget.entries.map(entry => entry.reportedModel).filter(Boolean))],
        quality: score(parseFindings(saved.answer ?? ''), receipts)};
      await writeFile(join(output, arm + '.json'), JSON.stringify(result, null, 2) + '\n');
      if (!await verifyDelivery(arm, result)) process.exitCode = 1;
      const {passed, total, validCitations, totalCitations, missingItems} = result.quality;
      console.log(JSON.stringify({arm, status: result.status, error: result.error, passed, total, validCitations, totalCitations, missingItems, elapsedMs,
        modelCalls: budget.modelCalls, toolCalls: budget.toolCalls, inputTokens: budget.actualInputTokens, outputTokens: budget.actualOutputTokens,
        unknownUsage: budget.unknownModelUsage, workers: workers.map(worker => worker.status)}));
      return saved.status;
    } finally { clearInterval(heartbeat); store.db.close(); }
  }

  try {
    for (const [path, bytes] of input) {
      const target = join(projectPath, path);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, bytes);
    }
    const single = await runArm('single');
    if (single !== 'completed') {
      console.log('单 Agent 未完成，跳过 Worker 对照。');
      process.exitCode = 1;
    } else if (await runArm('workers') !== 'completed') {
      process.exitCode = 1;
    }
  } finally {
    assert.equal(dirname(projectPath), dirname(prefix));
    if (projectPath.startsWith(prefix)) await rm(projectPath, {recursive: true, force: true});
  }
}
