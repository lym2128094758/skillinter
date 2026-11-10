import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createApp} from '../src/server.mjs';

const [sourcePath, python = 'python'] = process.argv.slice(2);
if (!sourcePath) throw new Error('用法：node scripts/check-skillnet.mjs <SkillNet目录> <Python程序>');
const root = await mkdtemp(join(tmpdir(), 'sih-skillnet-live-'));
const requests = [];
let currentTask;
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  requests.push({model: input.model, maxTokens: input.max_tokens});
  const last = input.messages.at(-1);
  const receiptMatch = /服务端工具回执索引：(.*)/.exec(input.messages[0].content);
  const receipts = receiptMatch ? JSON.parse(receiptMatch[1]) : [];
  const call = (name, args) => ({tool_calls: [{id: name, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
  const message = last.role !== 'tool' ? call('read_file', {path: 'input.txt'}) :
    JSON.parse(last.content).data?.file && receipts.length ? call('finish_skill', {skill_id: receipts.at(-1).skillId, status: 'applied',
      summary: '已读取真实项目输入', evidence: [receipts.at(-1).seq]}) : {content: '已读取输入并保留证据。'};
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({model: 'mechanical-test-adapter', usage: {prompt_tokens: 50, completion_tokens: 20},
    choices: [{finish_reason: 'stop', message}]}));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const app = await createApp({state: join(root, 'state'), env: {
  SKILLINTER_MODEL: 'mechanical-test-adapter', SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
  SIH_GITHUB_TOKEN: process.env.SIH_GITHUB_TOKEN,
}});
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = `http://127.0.0.1:${app.server.address().port}`;
async function api(path, body) {
  const response = await fetch(base + path, body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  const data = await response.json();
  assert.ok(response.ok, data.error);
  return data;
}
const report = {transport: 'local-python-json', model: 'deterministic HTTP test adapter', paidModelCalls: 0};
try {
  const config = {revision: 0, enabled: true, sourcePath: resolve(sourcePath), python, encoder: 'auto'};
  report.connection = await api('/api/skill-intelligence/test', config);
  await api('/api/skill-intelligence/settings', config);
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'input.txt'), 'verified local project contents');
  const project = await api('/api/projects', {path: projectPath});
  const task = currentTask = await api('/api/tasks', {project_id: project.id});
  const {skill} = await api('/api/skill-studio/publish', {taskId: task.id, baseVersion: 0, draft: {
    name: '项目输入证据核对', description: '核对项目文件，读取输入文件并给出真实证据', instructions: '读取 input.txt 并保留回执。', tests: [],
  }});
  async function run(request, explicit) {
    const started = await api('/api/tasks/' + task.id + '/runs', {request, prompt: '使用项目输入证据核对，核对项目输入文件并给出证据',
      ...(explicit ? {skillId: explicit.id, skillVersion: explicit.version} : {})});
    const stream = await (await fetch(base + '/api/runs/' + started.id + '/events')).text();
    const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const saved = (await api('/api/tasks/' + task.id)).runs.find(run => run.id === started.id);
    assert.equal(saved.status, 'completed', saved.error);
    assert.ok(events.some(event => event.type === 'tool_result' && event.payload.name === 'read_file' &&
      event.payload.output.data.file.content === 'verified local project contents' && event.payload.skillId));
    return {started, events, saved};
  }
  const routed = await run('real-engine');
  assert.ok(routed.events.some(event => event.type === 'skill_engine_call' && event.payload.provider === 'skillnet-local' && event.payload.code === 'OK'));
  assert.ok(routed.events.some(event => event.type === 'skill_route' && event.payload.candidates.some(candidate => candidate.id === skill.id)));
  report.routed = {runId: routed.started.id, engine: routed.events.find(event => event.type === 'skill_engine_details').payload,
    budget: (await api('/api/runs/' + routed.started.id + '/budget')).data, actualFileRead: true};
  const callsBeforeStop = requests.length;
  const cancelled = await api('/api/tasks/' + task.id + '/runs', {request: 'cancel-engine', prompt: '核对项目文件'});
  const response = await fetch(base + '/api/runs/' + cancelled.id + '/events');
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('"kind":"engine"')) {
    const {value, done} = await reader.read();
    assert.equal(done, false, 'engine reservation must be visible before cancellation');
    received += new TextDecoder().decode(value);
  }
  const stopped = await api('/api/runs/' + cancelled.id + '/stop', {});
  assert.equal(stopped.status, 'stopped');
  assert.equal(requests.length, callsBeforeStop);
  await reader.cancel();
  report.cancellation = {status: stopped.status, additionalModelRequests: requests.length - callsBeforeStop};
  if (process.env.SIH_GITHUB_TOKEN) {
    const preview = await api('/api/skill-intelligence/discover', {taskId: task.id, request: 'public-source', confirmed: true,
      tags: ['software testing'], sources: ['https://github.com/github/awesome-copilot/blob/main/skills/acquire-codebase-knowledge/SKILL.md']});
    assert.equal(preview.candidates.length, 1);
    const candidate = preview.candidates[0];
    const imported = await api('/api/skill-intelligence/discoveries/' + preview.id + '/import',
      {taskId: task.id, candidateId: candidate.id, confirmed: true, targetScope: 'project'});
    const adopted = await run('imported-method', imported.skill);
    assert.ok(adopted.events.some(event => event.type === 'tool_result' && event.payload.skillId === imported.skill.id));
    assert.ok(adopted.saved.skillApplications.some(item => item.id === imported.skill.id && item.status === 'applied'));
    report.discovery = {source: candidate.source, pinnedUrl: candidate.pinnedUrl, contentSha256: candidate.contentSha256,
      commit: candidate.commit, license: candidate.license, importedVersion: imported.skill.version, adopted: true};
  } else report.discovery = {status: 'not_run', reason: 'SIH_GITHUB_TOKEN not provided; anonymous GitHub may be rate limited'};
  await api('/api/skill-intelligence/settings', {...config, revision: 1, python: 'sih-missing-python'});
  const fallback = await run('missing-engine');
  assert.ok(fallback.events.some(event => event.type === 'skill_engine_fallback'));
  report.fallback = {completed: fallback.saved.status === 'completed'};
  report.fixtureModelRequests = requests.length;
  const output = resolve('.skillinter/evaluation');
  await mkdir(output, {recursive: true});
  await writeFile(join(output, 'phase-c-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: true, engine: report.connection.encoder.kind,
    discovery: report.discovery, report: join(output, 'phase-c-live.json')}));
} catch (error) {
  if (currentTask) {
    const task = await api('/api/tasks/' + currentTask.id);
    for (const run of task.runs.filter(run => run.status === 'failed')) {
      const stream = await (await fetch(base + '/api/runs/' + run.id + '/events')).text();
      console.log(stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
        .filter(event => event.type === 'skill_engine_details').map(event => event.payload));
    }
  }
  throw error;
} finally {
  await app.close();
  await new Promise(resolve => provider.close(resolve));
  await rm(root, {recursive: true, force: true});
}
