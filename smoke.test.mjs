import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';

test('tools, event replay, request deduplication, stop and restart', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-test-'));
  const legacy = new DatabaseSync(join(state, 'tasks.sqlite'));
  legacy.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated TEXT NOT NULL); INSERT INTO tasks VALUES ('old-task', '原有任务', '2026-11-01')");
  legacy.close();
  let app;
  t.after(async () => { if (app) await app.close(); await rm(state, {recursive: true, force: true}); });
  async function launch() {
    app = await createApp({state});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    return (path, payload, headers = {}, method = payload ? 'POST' : 'GET') => fetch(base + path, {
      headers: {...headers, ...(payload ? {'content-type': 'application/json'} : {})},
      method, body: payload ? JSON.stringify(payload) : undefined,
    });
  }
  let request = await launch();
  assert.deepEqual((await (await request('/api/tasks')).json()).map(({title, pinned, archived}) => ({title, pinned, archived})), [
    {title: '原有任务', pinned: 0, archived: 0},
  ]);
  assert.match(await (await request('/')).text(), /<title>Skillinter<\/title>/);
  assert.equal((await request('/api/tasks', {}, {origin: 'http://example.test'})).status, 403);
  const task = await (await request('/api/tasks', {})).json();
  const route = `/api/tasks/${task.id}/runs`;
  const edit = changes => request(`/api/tasks/${task.id}`, changes, {}, 'PATCH');
  assert.equal((await edit({title: ' '})).status, 422);
  assert.equal((await edit({title: '实验任务', pinned: true})).status, 200);
  assert.deepEqual(await (await request('/api/status')).json(), {model: '未连接模型', connected: false});
  assert.equal((await request(route, {request: 'ordinary', prompt: '分析问题'})).status, 409);
  const first = {request: 'one', prompt: '列出工作区文件', diagnostic: true};
  const {id} = await (await request(route, first)).json();
  assert.equal((await edit({archived: true})).status, 409);
  await writeFile(join(state, 'workspaces', task.id, 'sample.txt'), 'fixture');
  const replay = await request(route, first);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, id);
  assert.equal((await request(route, {...first, prompt: '不同请求'})).status, 409);
  assert.equal((await request(route, {request: 'two', prompt: '等待结束', diagnostic: true})).status, 409);
  const events = await (await request(`/api/runs/${id}/events`)).text();
  assert.match(events, /tool_result/);
  assert.match(events, /sample\.txt/);
  assert.match(events, /completed/);
  const lastId = [...events.matchAll(/^id: (\d+)$/gm)].at(-2)[1];
  const resumed = await (await request(`/api/runs/${id}/events`, undefined, {'last-event-id': lastId})).text();
  assert.doesNotMatch(resumed, /"type":"started"/);
  assert.match(resumed, /completed/);
  const second = await (await request(route, {request: 'two', prompt: '继续', diagnostic: true})).json();
  assert.match(await (await request(`/api/runs/${second.id}/events`)).text(), /已有 0 轮历史回复/);
  const third = await (await request(route, {request: 'three', prompt: '停止测试', diagnostic: true})).json();
  assert.equal((await (await request(`/api/runs/${third.id}/stop`, {})).json()).status, 'stopped');
  assert.equal((await edit({archived: true})).status, 200);
  assert.equal((await request(route, {request: 'four', prompt: '请继续', diagnostic: true})).status, 409);
  assert.ok(!(await (await request('/api/tasks')).json()).some(row => row.id === task.id));
  await app.close();
  app = undefined;
  request = await launch();
  const restored = await (await request(`/api/tasks/${task.id}`)).json();
  assert.deepEqual(restored.runs.map(run => run.status), ['completed', 'completed', 'stopped']);
  assert.deepEqual((await (await request('/api/tasks?archived=1')).json()).map(({id, title, pinned}) => ({id, title, pinned})), [
    {id: task.id, title: '实验任务', pinned: 1},
  ]);
  assert.equal((await edit({archived: false})).status, 200);
  assert.ok((await (await request('/api/tasks')).json()).some(row => row.id === task.id && row.pinned));
});

test('settings test a draft, encrypt the key, preserve origin boundaries and apply the budget', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-settings-'));
  const received = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({path: req.url, authorization: req.headers.authorization, body: JSON.parse(body)});
    res.setHeader('content-type', 'application/json');
    const call = {id: 'inventory', type: 'function', function: {name: 'list_workspace', arguments: '{"limit":0}'}};
    res.end(JSON.stringify({choices: [{message: {content: null, tool_calls: [call]}}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  let app;
  t.after(async () => {
    if (app) await app.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(state, {recursive: true, force: true});
  });
  async function boot() {
    app = await createApp({state});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    return (path, method = 'GET', body) => fetch(base + path, {method,
      headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  }
  let request = await boot();
  const initial = await (await request('/api/settings')).json();
  const port = provider.address().port;
  const key = initial.canStoreKey ? 'fixture-key-not-stored-as-plain-text-53819' : undefined;
  const draft = {mode: 'api', endpoint: `http://127.0.0.1:${port}/v1`, model: 'fixture-model', revision: initial.revision, maxSteps: 1, key};
  assert.equal((await request('/api/settings', 'PUT', {...draft, endpoint: 'http://example.test/v1'})).status, 422);
  assert.equal((await request('/api/settings/test', 'POST', draft)).status, 200);
  assert.equal(received[0].path, '/v1/chat/completions');
  assert.equal(received[0].authorization, key ? `Bearer ${key}` : undefined);
  assert.equal((await (await request('/api/settings')).json()).mode, 'unconfigured');
  const saveResponse = await request('/api/settings', 'PUT', draft);
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200, saved.error);
  assert.equal(saved.hasKey, Boolean(key));
  assert.equal(Object.hasOwn(saved, 'key'), false);
  assert.equal(Object.hasOwn(saved, 'secret'), false);
  assert.equal((await request('/api/settings', 'PUT', draft)).status, 409);
  await app.close();
  app = undefined;
  if (key) assert.equal((await readFile(join(state, 'tasks.sqlite'))).includes(Buffer.from(key)), false);
  request = await boot();
  const loaded = await (await request('/api/settings')).json();
  assert.equal(loaded.hasKey, Boolean(key));
  assert.equal((await (await request('/api/status')).json()).model, 'fixture-model');
  const {id: task} = await (await request('/api/tasks', 'POST', {})).json();
  const {id: run} = await (await request(`/api/tasks/${task}/runs`, 'POST', {request: 'budget', prompt: '检查文件'})).json();
  const trace = await (await request(`/api/runs/${run}/events`)).text();
  assert.match(trace, /模型调用次数上限/);
  const start = trace.split('\n').find(line => line.startsWith('data: ') && JSON.parse(line.slice(6)).type === 'started');
  const config = JSON.parse(start.slice(6)).payload;
  assert.equal(config.model, 'fixture-model');
  assert.equal(config.maxSteps, 1);
  assert.equal(config.effort, 'default');
  assert.equal(typeof config.started, 'number');
  assert.equal(received.length, 2);
  assert.equal(received[1].authorization, key ? `Bearer ${key}` : undefined);
  const alternate = {...draft, revision: loaded.revision, endpoint: `http://localhost:${port}/v1`, key: ''};
  assert.equal((await request('/api/settings/test', 'POST', alternate)).status, 200);
  assert.equal(received[2].authorization, undefined);
  assert.equal((await (await request('/api/settings')).json()).hasKey, Boolean(key));
  const budget = await (await request('/api/settings', 'PATCH', {revision: loaded.revision, maxSteps: 5})).json();
  assert.equal(budget.maxSteps, 5);
  assert.equal(budget.activeModel, 'fixture-model');
  assert.equal(budget.hasKey, Boolean(key));
  const expanded = await (await request('/api/settings', 'PATCH', {revision: budget.revision, maxSteps: 200})).json();
  assert.equal(expanded.maxSteps, 200);
  assert.equal((await request('/api/settings', 'PATCH', {revision: expanded.revision, maxSteps: 201})).status, 422);
  assert.equal((await (await request('/api/settings', 'PUT', {...draft, revision: expanded.revision, maxSteps: 200, clearKey: true, key: ''})).json()).hasKey, false);
});

test('CSV attachments produce a downloadable, traceable skill result', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-csv-'));
  const app = await createApp({state});
  t.after(async () => { await app.close(); await rm(state, {recursive: true, force: true}); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = path => fetch(base + path);
  const post = (path, body, type = 'application/json') => fetch(base + path, {method: 'POST', headers: {'content-type': type}, body});
  const newTask = async () => (await post('/api/tasks', '{}')).json();
  const {id: task} = await newTask();
  const {id: other} = await newTask();
  const bytes = Buffer.from('\ufeffname,score\r\n"甲,乙",2\r\n"丙\n丁",4\r\n戊,\r\n');
  const upload = await post(`/api/tasks/${task}/files?name=${encodeURIComponent('试验.csv')}`, bytes, 'application/octet-stream');
  assert.equal(upload.status, 201);
  const input = await upload.json();
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(input.sha256, digest);
  const payload = JSON.stringify({prompt: '分析 CSV 数据并统计均值', request: 'csv', file: input.id});
  assert.equal((await post(`/api/tasks/${other}/runs`, payload)).status, 404);
  const {id} = await (await post(`/api/tasks/${task}/runs`, payload)).json();
  const trace = await (await get(`/api/runs/${id}/events`)).text();
  assert.match(trace, /skill_selected/);
  assert.match(trace, /skill_completed/);
  assert.match(trace, /xlsx/);
  const detail = await (await get(`/api/tasks/${task}`)).json();
  const run = detail.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.input_file, input.id);
  assert.equal(run.skill.sourceSha256, digest);
  const report = await get(`/api/tasks/${task}/files/${run.artifacts[0].id}`);
  assert.match(report.headers.get('content-disposition'), /attachment/);
  const reportBytes = Buffer.from(await report.arrayBuffer());
  assert.equal(createHash('sha256').update(reportBytes).digest('hex'), run.artifacts[0].sha256);
  assert.match(reportBytes.toString(), /score：空值 1；非数值 0；有效数值 2；均值 3；最小 2；最大 4/);
  const graph = await (await get('/catalog/graph.json')).json();
  assert.ok(graph.nodes.some(node => node.id === run.skill.id));
  const invalid = await (await post(`/api/tasks/${task}/files?name=broken.csv`, 'column\n"unclosed', 'application/octet-stream')).json();
  const failed = await (await post(`/api/tasks/${task}/runs`, JSON.stringify({prompt: '分析 CSV', request: 'broken', file: invalid.id}))).json();
  const failedTrace = await (await get(`/api/runs/${failed.id}/events`)).text();
  assert.match(failedTrace, /未闭合的引号/);
  assert.doesNotMatch(failedTrace, /skill_completed/);
});
