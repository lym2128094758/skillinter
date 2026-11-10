import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const model = process.argv[2] || 'deepseek-v4.1-flash-1017';
const output = resolve(process.argv[3] || 'D:/gpt/outputs/skillinter-project-delivery', new Date().toISOString().replace(/[:.]/g, '-'));
const projectPath = join(output, 'project');
const base = 'http://127.0.0.1:3095';
await mkdir(projectPath, {recursive: true});
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, body === undefined ? {signal: AbortSignal.timeout(10000)} :
    {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  const value = await response.json();
  if (!response.ok || value.ok === false) throw Error(path + ': ' + (value.error?.message ?? value.error ?? response.status));
  return value;
}
const inputs = {
  'README.md': '# Vision project handoff\n\nThis is a synthetic delivery review example.\nCheck deliverables against delivery-manifest.json.\n',
  'delivery-manifest.json': JSON.stringify({required: ['README.md', 'predictions.json', 'model-card.md']}, null, 2) + '\n',
  'predictions.json': JSON.stringify({records: [{sample: 'A', label: 'cat'}, {sample: 'B', label: 'dog'}]}, null, 2) + '\n',
};
for (const [path, content] of Object.entries(inputs)) await writeFile(join(projectPath, path), content);
const preserve = Object.keys(inputs);
const contract = (path, checks) => ({version: 1, preserve_inputs: preserve,
  artifacts: [{path, format: 'json', require_change: true, checks}]});
const type = (pointer, expected) => ({kind: 'json_type', pointer, expected});
const definitions = [
  {name: 'project-material-inventory', description: '按交付清单检查项目材料是否存在，形成交接清点结果。',
    instructions: '读取项目说明和交付清单，列出真实文件，逐项核对 required 中路径；不从名字推测内容。' +
      '写 inventory.json，含 required 数组、missing 数组、checked 数组。保持输入不变。调用 verify_skill_output 通过后 finish_skill。尽量在同批按顺序提交可合并的实际工具调用。',
    tests: [], delivery: contract('inventory.json', [type('/required', 'array'), type('/missing', 'array'), type('/checked', 'array')])},
  {name: 'project-delivery-review', description: '基于已经完成的材料清点，交付带原文依据和缺项的项目交接报告。',
    instructions: '前置材料清点完成后，读取 inventory.json 和交付清单。写 review-report.json，包含 verdict、missing 和 findings。' +
      'verdict 为 ready / needs_work / unknown；缺少必需材料应 needs_work。findings 每项为 id、status、claim、evidence[{path,line,quote}]，' +
      '引用本轮真实读过的清单原文（空行也计行号），missing 状态表示条件未满足。核验失败先修复再重验，不能仅说已完成。',
    tests: [], delivery: contract('review-report.json', [type('/verdict', 'string'), type('/missing', 'array'),
      {kind: 'json_citations', pointer: '/findings', expected: ''}])},
];
const proof = {startedAt: new Date().toISOString(), model, budgetSeconds: 60,
  scope: '合成项目，只验证主聊天技能依赖和产物链路，不代表真实业务收益。', projectPath};
let run, timer;
try {
  const project = await api('/api/projects', {path: projectPath});
  const task = await api('/api/tasks', {project_id: project.id});
  proof.taskId = task.id;
  await api('/api/tasks/' + task.id, {title: '项目交付核对 · 完整示例', model_id: model, effort: 'default'}, 'PATCH');
  await api('/api/tasks/' + task.id + '/file-access', {project_id: project.id, mode: 'project_write', confirmed: true}, 'PUT');
  const skills = [];
  for (const draft of definitions) skills.push((await api('/api/skill-studio/publish',
    {taskId: task.id, targetScope: 'project', baseVersion: 0, draft})).skill);
  proof.skills = skills.map(({id, name, version}) => ({id, name, version}));
  const registry = (await api('/api/skill-registry?task=' + task.id)).data;
  await api('/api/skill-registry/relations?task=' + task.id,
    {source: skills[1].id, target: skills[0].id, type: 'depend_on', expectedRevision: registry.revision});
  proof.relation = {source: skills[1].id, target: skills[0].id, type: 'depend_on'};
  const started = Date.now();
  run = await api('/api/tasks/' + task.id + '/runs', {request: crypto.randomUUID(),
    skillId: skills[1].id, skillVersion: skills[1].version,
    prompt: '检查这个计算机视觉项目是否满足清单中的交付要求。先完成材料清点，再按技能依赖生成交付报告。' +
      '自主核对实际文件，保持输入不变。用实际回执完成两个技能的核验与应用。任务短，请简洁执行，能同批顺序完成的工具不要分多轮。'});
  proof.runId = run.id;
  timer = setTimeout(() => {void api('/api/runs/' + run.id + '/stop', {}).catch(() => {});}, 60000);
  const response = await fetch(base + '/api/runs/' + run.id + '/events', {signal: AbortSignal.timeout(65000)});
  proof.events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  clearTimeout(timer);
  proof.elapsedMs = Date.now() - started;
  proof.run = (await api('/api/tasks/' + task.id)).runs.find(item => item.id === run.id);
  assert.equal(proof.run.status, 'completed', proof.run.error ?? '60秒内未完成');
  proof.report = JSON.parse(await readFile(join(projectPath, 'review-report.json'), 'utf8'));
  assert.equal(proof.report.verdict, 'needs_work');
  assert.deepEqual(proof.report.missing, ['model-card.md']);
  for (const [path, content] of Object.entries(inputs)) assert.equal(await readFile(join(projectPath, path), 'utf8'), content);
  const applied = proof.events.filter(event => event.type === 'skill_application' && event.payload.status === 'applied');
  assert.ok(applied.findIndex(event => event.payload.id === skills[0].id) >= 0);
  assert.ok(applied.findIndex(event => event.payload.id === skills[1].id) > applied.findIndex(event => event.payload.id === skills[0].id));
  assert.ok(skills.every(skill => proof.run.skillDeliveries.some(item => item.id === skill.id && item.status === 'passed')));
  proof.passed = true;
} catch (error) {
  if (run) await api('/api/runs/' + run.id + '/stop', {}).catch(() => {});
  proof.passed = false; proof.error = error.message; process.exitCode = 1;
} finally {
  clearTimeout(timer);
  proof.sourceSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({passed: proof.passed, model, taskId: proof.taskId, error: proof.error, output}));
}
