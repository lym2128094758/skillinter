import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/server.mjs';
import {config} from '../src/config.mjs';

const output = resolve(process.argv[2] ?? 'D:/gpt/outputs/skillinter-citation-learning');
const model = 'deepseek-v4.1-flash-1017';
const deadlineMs = 60000;
await mkdir(output, {recursive: true});
const state = join(output, 'private-state');
await mkdir(state, {recursive: true});
const sourceState = resolve(config.statePath, 'tasks.sqlite');
assert.ok(existsSync(sourceState), '需要已配置的本机模型');
if (!existsSync(join(state, 'tasks.sqlite'))) {
  const original = new DatabaseSync(sourceState, {readOnly: true});
  const seed = new Store(join(state, 'tasks.sqlite'));
  try {
    const saved = JSON.parse(original.prepare('SELECT value FROM preferences WHERE id=1').get().value);
    seed.savePreferences(0, {...saved, model, maxSteps: 12});
  } finally {original.close(); seed.db.close();}
}
const app = await createApp({state, userSkillsPath: join(output, 'private-skills'), env: {}});
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;
const proof = existsSync(join(output, 'progress.json')) ? JSON.parse(await readFile(join(output, 'progress.json'), 'utf8')) :
  {model, sourcePolicy: '开发用例；初始方法只做 README 初筛，改进目标是实际依赖审查。'};
proof.base = base;
async function save(name, data) {
  await writeFile(join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n');
}
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, body === undefined ? {signal: AbortSignal.timeout(deadlineMs)} :
    {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(deadlineMs)});
  const result = await response.json();
  if (!response.ok) throw new Error(path + ' · ' + JSON.stringify(result));
  return result;
}
async function task(project, title, mode = 'project_write') {
  const value = await api('/api/tasks', {project_id: project.id});
  await api('/api/tasks/' + value.id, {title, model_id: model, effort: 'default'}, 'PATCH');
  await api('/api/tasks/' + value.id + '/file-access', {mode, project_id: project.id, confirmed: true}, 'PUT');
  return value;
}
async function run(current, prompt, skill) {
  const started = await api('/api/tasks/' + current.id + '/runs', {request: crypto.randomUUID(), prompt,
    ...(skill ? {skillId: skill.id, skillVersion: skill.version} : {})});
  let value;
  const timer = setInterval(() => console.log(JSON.stringify({task: current.id, run: started.id, status: 'running'})), 30000);
  const deadline = setTimeout(() => {
    void api('/api/runs/' + started.id + '/stop', {}).catch(() => {});
  }, deadlineMs);
  try {
    const stream = await fetch(base + '/api/runs/' + started.id + '/events', {signal: AbortSignal.timeout(deadlineMs + 5000)});
    const events = (await stream.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    value = (await api('/api/tasks/' + current.id)).runs.find(item => item.id === started.id);
    await save(started.id, {taskId: current.id, run: value, events});
    console.log(JSON.stringify({run: started.id, status: value.status, error: value.error}));
    return value;
  } finally {clearInterval(timer); clearTimeout(deadline);}
}
const sourceText = '# Project setup\n\nInstall dependencies from requirements.txt.\n\nUse a Python 3.11 environment.\n';
const declaration = {version: 1, preserve_inputs: ['README.md', 'requirements.txt'], artifacts: [{
  path: 'report.json', format: 'json', require_change: true, checks: [
    {kind: 'json_length', pointer: '/findings', expected: '1'},
    {kind: 'json_citations', pointer: '/findings', expected: ''},
  ],
}]};
const goal = '使用当前技能审查本项目是否具备精确的依赖版本锁定。将一条 id=dependency_lock 的 findings 写入 report.json，' +
  '每条包含 status(verified/missing/uncertain)、claim 及 evidence[{path,line,quote}]。条件满足才是 verified，明确未满足是 missing，证据不足是 uncertain。保留输入不变。' +
  '任务很短，直接读取、写产物并核验即可，避免重复查看已加载的技能与建立冗长计划。';
try {
  // First verify the normal HTTP chat path without an installed skill.
  const citationPath = join(output, 'citation-project');
  if (!proof.chat) {
  await mkdir(citationPath, {recursive: true});
  await writeFile(join(citationPath, 'protocol.md'), '# Environment\n\nPython 3.11 is required.\n', {flag: 'wx'});
  const citationProject = await api('/api/projects', {path: citationPath});
  const citationTask = await task(citationProject, '主聊天 · 引用核验', 'project_read');
  const cited = await run(citationTask, '用 read_file 读取 protocol.md，核对最低 Python 版本。最终仅返回一个 JSON 对象，不写其他段落：' +
    '{"findings":[{"id":"python","status":"verified","claim":"版本结论","evidence":[{"path":"protocol.md","line":1,"quote":"该行连续原文"}]}]}。' +
    'line 请填写从1起的准确原行号，不能使用 file/lines 别名。');
  assert.equal(cited.status, 'completed', cited.error);
  assert.equal(cited.citationVerification?.status, 'passed');
  assert.equal(JSON.parse(cited.answer).findings[0].evidence[0].line, 3);
  proof.chat = {taskId: citationTask.id, runId: cited.id, verification: cited.citationVerification};
  await save('progress', proof);
  }
  const browser = spawn(process.execPath, ['scripts/check-citation-ui.mjs', base, proof.chat.taskId, output],
    {stdio: 'inherit', windowsHide: true});
  const [browserCode] = await once(browser, 'exit');
  assert.equal(browserCode, 0, '主聊天浏览器验收未通过');

  const projectPath = join(output, 'learning-project');
  await mkdir(projectPath, {recursive: true});
  await writeFile(join(projectPath, 'README.md'), sourceText);
  await writeFile(join(projectPath, 'requirements.txt'), 'fastapi>=0.110,<1\npytest>=8,<10\n');
  const project = await api('/api/projects', {path: projectPath});
  const sourceTask = proof.source ? {id: proof.source.taskId} : await task(project, '技能改进 · 来源任务');
  const installed = (await api('/api/skill-studio?task=' + sourceTask.id)).skills.find(item=>item.name==='dependency-evidence-review');
  const {skill} = installed ? await api('/api/skill-studio/' + installed.id + '?task=' + sourceTask.id) :
    await api('/api/skill-studio/publish', {taskId: sourceTask.id, targetScope: 'project', baseVersion: 0, draft: {
    name: 'dependency-evidence-review', description: '根据项目复现说明初筛依赖准备情况，并保留原文。',
    instructions: '这是 README 初筛方法。只读取 README.md，依据说明中的直接证据判断依赖条件。' +
      '说明没有给出精确版本时，标 uncertain，避免从文件名猜测内容。' +
      '写出用户要求的 report.json，引用 README 中相关的一行。核对产物后记录技能完成。',
    tests: [], delivery: declaration,
  }});
  const first = proof.source ? {id: proof.source.runId} : await run(sourceTask, goal, skill);
  if (!proof.source) assert.equal(first.status, 'completed', first.error);
  const firstReport = proof.source?.report ?? JSON.parse(await readFile(join(projectPath, 'report.json'), 'utf8'));
  proof.source = {taskId: sourceTask.id, runId: first.id, skillId: skill.id, version: skill.version,
    report: firstReport, targetStatus: 'missing', goalMet: firstReport.findings[0].status === 'missing'};
  await save('progress', proof);
  // A real follow-up message supplies the evaluator's correction.
  if (!proof.feedbackRun) {
    const feedback = await run(sourceTask, '技能方法需要修正：指南要求只读 README，但本轮正确结果实际上依赖 requirements.txt，方法与真实操作不一致。' +
      '不要再执行文件操作，本轮只确认这个方法缺口。应允许读取实际声明，区分全部精确固定、存在范围约束和证据不足。', skill);
    proof.feedbackRun = feedback.id;
    await save('progress', proof);
  }
  const experiences = (await api('/api/skill-studio/experiences?task=' + sourceTask.id + '&run=' + first.id)).experiences;
  const experience = experiences.find(item => item.signals.some(signal => signal.code === 'USER_CORRECTION'));
  assert.ok(experience, '应从真实后续纠正提取来源');
  const proposal = proof.proposal?.proposal ?? await api('/api/skill-studio/experiences/' + experience.id + '/propose', {
    taskId: sourceTask.id, skillId: skill.id,
    feedback: '只做最小修订，instructions 最多200字；tests恰好2条，每个prompt最多100字且自带小材料，其他字段短写。' +
      '允许读取 requirements.txt 实际声明，区分全部精确固定、范围约束、无证据三种状态。保持原产物契约，不写固定答案。' +
      '写 report.json 后用 verify_skill_output 核对原文行号，失败则修复重验。测试不得复用来源数据。',
  });
  const candidate = await api('/api/skill-studio/candidates/' + proposal.candidateId + '?task=' + sourceTask.id);
  proof.proposal = {experience, proposal, candidate};
  await save('progress', proof);
  const cases = [
    {name: 'heldout-bounded', readme: '# Different project\n\nSee requirements.txt for its supported dependencies.\n',
      requirements: '# Input B\n\nrequests>=2.30,<3\n', expected: 'missing'},
    {name: 'heldout-pinned', readme: '# Third project\n\nDependency details are kept separately.\n',
      requirements: '# Input C\n\nclick==8.1.7\npackaging==24.2\n', expected: 'verified'},
  ].map(item => ({name: item.name, prompt: goal + ' 本次是独立材料 ' + item.name + '。',
    files: [{path: 'README.md', content: item.readme}, {path: 'requirements.txt', content: item.requirements}],
    acceptance: {...declaration, artifacts: [{...declaration.artifacts[0], checks: [
      ...declaration.artifacts[0].checks, {kind: 'json_equals', pointer: '/findings/0/status', expected: JSON.stringify(item.expected)},
    ]}]}}));
  const plan = await api('/api/skill-studio/candidates/' + candidate.id + '/execution-plans', {
    taskId: sourceTask.id, spec: {cases, budget: {maxCalls: 10, maxSeconds: 60, maxOutputTokens: 8192}},
  });
  await api('/api/skill-studio/execution-plans/' + plan.id + '/run', {taskId: sourceTask.id});
  let evaluated;
  const comparisonDeadline = setTimeout(() => {
    void api('/api/skill-studio/execution-plans/' + plan.id + '/stop', {taskId: sourceTask.id}).catch(() => {});
  }, deadlineMs);
  try {
  while (true) {
    evaluated = await api('/api/skill-studio/execution-plans/' + plan.id + '?task=' + sourceTask.id);
    await save('paired-trial', evaluated);
    const trial = evaluated.trials[0];
    console.log(JSON.stringify({trial: trial.id, status: trial.status,
      pairs: trial.pairs.map(pair => ({baseline: pair.baseline?.status, candidate: pair.candidate?.status}))}));
    if (trial.status !== 'running') break;
    await sleep(15000);
  }
  } finally {clearTimeout(comparisonDeadline);}
  const trial = evaluated.trials[0];
  proof.comparison = {planId: plan.id, trialId: trial.id, verdict: trial.verdict,
    baselinePassed: trial.baselinePassed, candidatePassed: trial.candidatePassed, total: trial.total};
  await save('progress', proof);
  if (trial.verdict !== 'improved') {
    proof.passed = false;
    proof.publication = null;
    proof.reason = trial.reason;
    proof.limitation = '真实配对未证明改进，按正式门槛保留候选，不发布、不声称学习成功。';
    await save('result', proof);
    console.log(JSON.stringify({verdict: trial.verdict, publication: false, reason: trial.reason}));
    process.exitCode = 1;
  } else {
  const release = await api('/api/skill-studio/candidates/' + candidate.id + '/promote',
    {taskId: sourceTask.id, trialId: trial.id, confirmed: true});
  proof.publication = {skillId: release.skill.id, version: release.skill.version, scope: 'isolated demonstration project'};
  await writeFile(join(projectPath, 'README.md'), '# New batch\n\nUse requirements.txt as the dependency declaration.\n');
  await writeFile(join(projectPath, 'requirements.txt'), '# Unseen batch D\n\nrich==13.9.4\n');
  const reuseTask = await task(project, '技能改进 · 新批次复用');
  const reused = await run(reuseTask, goal, release.skill);
  const reuseReport = JSON.parse(await readFile(join(projectPath, 'report.json'), 'utf8'));
  assert.equal(reused.status, 'completed', reused.error);
  assert.equal(reuseReport.findings[0].status, 'verified');
  assert.ok(reused.loadedSkills.some(item => item.id === skill.id && item.version === release.skill.version));
  proof.reuse = {taskId: reuseTask.id, runId: reused.id, report: reuseReport, deliveries: reused.skillDeliveries};
  proof.passed = true;
  await save('result', proof);
  console.log(JSON.stringify({passed: true, chat: proof.chat.runId, comparison: proof.comparison, reuse: reused.id}));
  }
} catch (error) {
  await save('result', {...proof, passed: false, error: error.message});
  console.error(error.message);
  process.exitCode = 1;
} finally {await app.close();}
