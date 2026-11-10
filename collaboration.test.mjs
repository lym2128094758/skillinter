import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from './src/server.mjs';
import {validate} from './src/schema.mjs';

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'sih-collab-'));
  const path = join(root, 'project');
  await mkdir(path);
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const reply = respond(body);
    if (reply === null) return;
    if (reply === 429) {
      res.writeHead(429, {'retry-after': '0'}).end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({
      choices: [{finish_reason: 'stop', message: reply}], usage: {prompt_tokens: 12, completion_tokens: 3},
    }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state: join(root, 'state'), userSkillsPath: join(root, 'skills'), env: {
    SKILLINTER_MODEL: 'collaboration-fixture',
    SKILLINTER_MODEL_URL: 'http://127.0.0.1:' + provider.address().port + '/v1/chat/completions',
  }});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(root, {recursive: true, force: true});
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function api(route, body, method = 'POST', status = 200) {
    const response = await fetch(base + route, body === undefined ? {} :
      {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const project = await api('/api/projects', {path}, 'POST', 201);
  const newTask = projectId => api('/api/tasks', {project_id: projectId}, 'POST', 201);
  const start = (task, prompt) => api('/api/tasks/' + task.id + '/runs', {prompt, request: randomUUID()}, 'POST', 201);
  async function wait(run) {
    const response = await fetch(base + '/api/runs/' + run.id + '/events', {signal: AbortSignal.timeout(10000)});
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1)?.type, 'finished');
    return {events, ...events.at(-1).payload};
  }
  return {root, path, project, api, newTask, start, wait, requests, base};
}

const call = (id, name, args) => ({id, type: 'function', function: {name, arguments: JSON.stringify(args)}});
const jobs = ['a', 'b'].map((id, index) => ({role: index ? 'review' : 'analysis',
  goal: '核对文件 ' + id, inputs: [{path: id + '.txt', offset: 0, limit: 10}], acceptance: '引用真实文件内容'}));
const isWorker = body => body.messages[0].content.startsWith('你是 SIH 的独立只读 Worker。');
const plan = title => call('plan', 'update_plan', {expected_revision: 0, explanation: '',
  steps: [{id: 'review', title, status: 'in_progress', depends_on: []}]});

test('chat dispatches isolated workers, retains sibling evidence on HTTP failure, and records comparison costs', async t => {
  let mode = 'single';
  const f = await fixture(t, body => {
    const last = body.messages.at(-1);
    if (isWorker(body)) {
      const [{excerpt, seq}] = JSON.parse(last.content).excerpts;
      return mode === 'failure' && excerpt === 'B-ONLY' ? 429 : {content: excerpt + ' · 回执 ' + seq};
    }
    if (last.role !== 'tool') {
      if (mode === 'single') return {tool_calls: jobs.map(({inputs}, i) => call('r' + i, 'read_file', inputs[0]))};
      if (mode === 'outside') return {tool_calls: [call('w', 'delegate_readonly', {jobs: [{...jobs[0], inputs: [{path: '../private.txt', offset: 0, limit: 1}]}]})]};
      return {tool_calls: [...(mode === 'failure' ? [plan('并行核对材料')] : []), call('w', 'delegate_readonly', {jobs})]};
    }
    const outputs = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    return {content: mode === 'single' ? outputs.map(result => result.data.file.content).join(' + ') :
      !outputs.at(-1).ok ? outputs.at(-1).error.code :
        outputs.at(-1).data.workers.map(worker => worker.summary.split(' · ')[0] || worker.status).join(' + ')};
  });
  await writeFile(join(f.path, 'a.txt'), 'A-ONLY');
  await writeFile(join(f.path, 'b.txt'), 'B-ONLY');
  await writeFile(join(f.root, 'private.txt'), 'OUTSIDE-SECRET');
  const prompt = '请分别核对两份指定材料，按文件汇总。ROOT-HISTORY-MARKER';
  async function run(variant) {
    mode = variant;
    const task = await f.newTask(f.project.id);
    const started = await f.start(task, prompt);
    const result = await f.wait(started);
    assert.equal(result.status, 'completed', result.error);
    const {workers} = await f.api('/api/runs/' + started.id + '/workers');
    const {data: budget} = await f.api('/api/runs/' + started.id + '/budget');
    return {...result, workers, budget, id: started.id, task};
  }
  const single = await run('single');
  const paired = await run('paired');
  assert.equal(single.answer, 'A-ONLY + B-ONLY');
  assert.equal(paired.answer, single.answer);
  assert.equal(single.budget.modelCalls, 2);
  assert.equal(paired.budget.modelCalls, 4);
  assert.equal(paired.budget.toolCalls, 2);
  assert.equal(paired.budget.engineCalls, 1);
  const snapshot = paired.events.find(event => event.type === 'skill_registry_snapshot').payload;
  for (const worker of paired.workers) {
    assert.equal(worker.rootRunId, paired.id);
    assert.equal(worker.snapshotSha256, snapshot.sha256);
    assert.equal(worker.usage.modelCalls, 1);
    assert.equal(worker.reads.length, 1);
    assert.equal(worker.reads[0].seq, worker.evidenceRefs[0]);
    assert.match(worker.reads[0].sha256, /^[a-f0-9]{64}$/);
    const [artifact] = worker.artifacts;
    const response = await fetch(f.base + '/api/tasks/' + paired.task.id + '/files/' + artifact.id);
    assert.equal(response.headers.get('x-content-sha256'), artifact.sha256);
    const report = await response.json();
    assert.equal(report.sources[0].seq, worker.evidenceRefs[0]);
    assert.equal(report.summary, worker.summary);
  }
  const {workers: contracts} = await f.api('/api/tools/contract');
  const result = paired.events.find(event => event.type === 'tool_result' && event.payload.name === 'delegate_readonly');
  assert.deepEqual(validate(contracts[0].returns, result.payload.output), []);
  const partial = await run('failure');
  assert.equal(partial.answer, 'A-ONLY + failed');
  assert.deepEqual(partial.workers.map(worker => worker.status), ['completed', 'failed']);
  assert.deepEqual(partial.workers.map(worker => worker.artifacts.length), [1, 0]);
  assert.equal(partial.budget.modelCalls, 4);
  assert.equal(partial.budget.retries, 0);
  const partialTask = await f.api('/api/tasks/' + partial.task.id);
  const receipt = partialTask.runs[0].planReceipts.find(receipt => receipt.name === 'delegate_readonly');
  assert.equal(receipt.ok, false);
  assert.match(receipt.message, /1\/2/);
  const outside = await run('outside');
  assert.equal(outside.answer, 'INVALID_ARGUMENTS');
  assert.equal(outside.workers.length, 0);
  const settings = await f.api('/api/settings');
  await f.api('/api/settings', {revision: settings.revision, maxSteps: 3}, 'PATCH');
  const budgetDenied = await run('paired');
  assert.equal(budgetDenied.answer, 'WORKER_BUDGET');
  assert.equal(budgetDenied.workers.length, 0);
  assert.equal(budgetDenied.budget.modelCalls, 2);
  for (const request of f.requests.filter(isWorker)) {
    assert.equal(request.tools, undefined);
    const messages = JSON.stringify(request.messages);
    assert.equal(messages.includes('ROOT-HISTORY-MARKER') || messages.includes('OUTSIDE-SECRET'), false);
    assert.notEqual(messages.includes('A-ONLY'), messages.includes('B-ONLY'));
  }
});

test('stopping a root chat cancels both in-flight Worker requests and preserves their read receipts', async t => {
  const started = Promise.withResolvers();
  let workerRequests = 0;
  const f = await fixture(t, body => {
    if (isWorker(body)) {
      if (++workerRequests === 2) started.resolve();
      return null;
    }
    return {tool_calls: [call('w', 'delegate_readonly', {jobs})]};
  });
  await writeFile(join(f.path, 'a.txt'), 'a');
  await writeFile(join(f.path, 'b.txt'), 'b');
  const run = await f.start(await f.newTask(f.project.id), '独立核对两份文件');
  const completed = f.wait(run);
  await Promise.race([started.promise, completed.then(() => assert.fail('应先进入两个 Worker 的模型请求'))]);
  assert.equal((await f.api('/api/runs/' + run.id + '/stop', {})).status, 'stopped');
  assert.equal((await completed).status, 'stopped');
  const {workers} = await f.api('/api/runs/' + run.id + '/workers');
  assert.deepEqual(workers.map(worker => [worker.status, worker.reads.length]), [['stopped', 1], ['stopped', 1]]);
  const {data} = await f.api('/api/runs/' + run.id + '/budget');
  assert.equal(data.modelCalls, 3);
  assert.equal(data.inFlight, 0);
  assert.equal(data.entries.filter(entry => entry.kind === 'model' && entry.status === 'cancelled').length, 2);
});

test('confirmed project memory is scoped, versioned and withdrawn when the source fingerprint changes', async t => {
  const f = await fixture(t, body => {
    const goal = body.messages.at(-1);
    if (goal.role === 'user' && goal.content === '核对实验规程') return {tool_calls: [plan('OLD-PROJECT-PLAN')]};
    if (goal.role === 'user' && goal.content === '不对，核对这个项目的规程') return {tool_calls: [plan('新项目计划')]};
    return {content: body.messages[0].content.includes('MEMORY-FACT') ? '答复引用 MEMORY-FACT' : '无需引用旧事实'};
  });
  const source = join(f.path, 'protocol.txt');
  await writeFile(source, '原始规程');
  const otherPath = join(f.root, 'other-project');
  await mkdir(otherPath);
  const other = await f.api('/api/projects', {path: otherPath}, 'POST', 201);
  const base = '/api/projects/' + f.project.id + '/memories';
  const otherBase = '/api/projects/' + other.id + '/memories';
  const input = {kind: 'fact', title: '实验规程', text: 'MEMORY-FACT', sourcePath: 'protocol.txt', triggers: ['规程'], confirmed: true};
  await f.api(base, {...input, sourcePath: '../private.txt'}, 'POST', 422);
  const fact = await f.api(base, input, 'POST', 201);
  const preference = await f.api(base, {kind: 'preference', title: '报告格式', text: '使用表格', sourcePath: '', triggers: ['规程'], confirmed: true}, 'POST', 201);
  assert.equal((await f.api(otherBase)).memories.length, 0);
  await f.api(otherBase + '/' + fact.id, {revision: 1, enabled: false}, 'PATCH', 404);
  const task = await f.newTask(f.project.id);
  const first = await f.wait(await f.start(task, '核对实验规程'));
  assert.equal(first.answer, '答复引用 MEMORY-FACT');
  assert.deepEqual(first.events.filter(event => event.type === 'project_memory_used').map(event => event.payload.status), ['used', 'used']);
  await writeFile(source, '修订规程');
  assert.equal((await f.api(base + '/' + fact.id + '/verify')).status, 'changed');
  const previousRun = await f.start(task, '再次核对实验规程');
  const second = await f.wait(previousRun);
  assert.equal(second.events.find(event => event.type === 'project_memory_used' && event.payload.id === fact.id).payload.status, 'changed');
  assert.equal(second.events.find(event => event.type === 'request_context').payload.context.projectMemory.used.some(item => item.id === fact.id), false);
  const edited = await f.api(base + '/' + fact.id, {...input, revision: 1, text: '修订后的规程'}, 'PUT');
  assert.notEqual(edited.source.sha256, fact.source.sha256);
  assert.equal((await f.api(base + '/' + fact.id + '/verify')).status, 'current');
  await f.api(base + '/' + fact.id, {revision: 1, enabled: false}, 'PATCH', 409);
  const disabled = await f.api(base + '/' + fact.id, {revision: edited.revision, enabled: false}, 'PATCH');
  assert.equal(disabled.enabled, false);
  await f.api(base + '/' + preference.id, {revision: preference.revision}, 'DELETE');
  await f.api('/api/tasks/' + task.id + '/file-access', {mode: 'project_read', project_id: other.id}, 'PUT');
  const moved = await f.wait(await f.start(task, '不对，核对这个项目的规程'));
  assert.equal(moved.answer, '无需引用旧事实');
  assert.equal(moved.events.some(event => event.type === 'project_memory_used'), false);
  assert.equal(moved.events.find(event => event.type === 'task_plan').payload.revision, 1);
  assert.equal(JSON.stringify(f.requests.at(-1)).includes('OLD-PROJECT-PLAN'), false);
  assert.equal(JSON.stringify(f.requests.at(-1)).includes('MEMORY-FACT'), false);
  const experiencePath = '/api/skill-studio/experiences?task=' + task.id;
  assert.equal((await f.api(experiencePath)).experiences.length, 0);
  await f.api(experiencePath + '&run=' + previousRun.id, undefined, 'GET', 404);
});
