import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';
import { executeRun } from './src/runner.mjs';
import { Store } from './src/store.mjs';

test('material preflight checks mixed attachments and permission-bound project inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sih-preflight-'));
  const app = await createApp({state: join(root, 'state'), env: {}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, data) => fetch(origin + path, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify(data)});
  const task = await (await post('/api/tasks', {})).json();
  const route = '/api/tasks/' + task.id;
  const artifacts = [
    ['broken.jsonl', '{"ok":true}\ninvalid'],
    ['copy.jsonl', '{"ok":true}\ninvalid'],
    ['empty.txt', ''],
    ['notes.md', '# Experiment'],
    ['report.pdf', '%PDF-1.7\n'],
    ['opaque.dat', Buffer.from([0, 255, 128])],
  ];
  for (const [name, body] of artifacts) {
    const response = await fetch(origin + route + '/files?name=' + name,
      {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body});
    assert.equal(response.status, 201);
  }
  async function run(taskRoute, request, preflight) {
    const response = await post(taskRoute + '/preflight', {request, prompt: '检查材料', preflight});
    assert.equal(response.status, 201);
    const {id} = await response.json();
    const stream = await (await fetch(origin + '/api/runs/' + id + '/events')).text();
    const record = (await (await fetch(origin + taskRoute)).json()).runs.find(run => run.id === id);
    assert.equal(record.status, 'completed', JSON.stringify(record));
    const {report, trace, artifact} = record.preflight;
    assert.deepEqual(await (await fetch(origin + taskRoute + '/files/' + artifact.id)).json(), report);
    const graph = JSON.parse(await readFile(new URL('./web/catalog/graph.json', import.meta.url), 'utf8'));
    assert.ok(trace.graph.nodes.every(node => graph.nodes.some(item => item.id === node.nodeId)));
    const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(events.filter(event => event.type === 'preflight_step').map(event => event.payload.id),
      trace.graph.nodes.map(node => node.id));
    return report;
  }
  const report = await run(route, 'mixed', {source: 'attachments', goal: 'structure'});
  assert.equal(report.coverage.read, 6);
  assert.deepEqual(report.files[0].issues[0], {code: 'INVALID_JSON_LINE', message: '此行不是合法 JSON。', line: 2});
  assert.equal(report.files[1].issues[0].related, 'broken.jsonl');
  assert.equal(report.files[2].issues[0].code, 'EMPTY_CONTENT');
  assert.match(report.files[4].structure, /内部结构待核验/);
  assert.equal(report.files[5].structure, '需要适用的格式解析器');
  assert.doesNotMatch(JSON.stringify(report), /# Experiment/);
  assert.equal((await post(route + '/preflight', {request: 'mixed', prompt: '检查材料', preflight: {source: 'attachments', goal: 'integrity'}})).status, 409);
  assert.equal((await post(route + '/preflight', {request: 'blocked', prompt: '检查材料', preflight: {source: 'project', goal: 'structure'}})).status, 409);

  const projectPath = join(root, 'lab');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'README.md'), '# steps');
  await writeFile(join(projectPath, 'pyproject.toml'), '[project]\nname = "sample"');
  await writeFile(join(projectPath, 'notebook.ipynb'), '{"cells":[],"nbformat":4}');
  const project = await (await post('/api/projects', {path: projectPath})).json();
  const bound = await (await post('/api/tasks', {project_id: project.id})).json();
  const projectRoute = '/api/tasks/' + bound.id;
  assert.equal((await post(projectRoute + '/preflight', {request: 'outside', prompt: '检查材料',
    preflight: {source: 'project', goal: 'structure', paths: ['../outside']}})).status, 422);
  const reproduction = await run(projectRoute, 'repro', {source: 'project', goal: 'reproducibility'});
  assert.deepEqual(reproduction.evidence.map(item => item.paths), [['README.md'], ['pyproject.toml']]);
  assert.deepEqual(reproduction.issues, []);
  assert.equal(reproduction.trace.graph.nodes.at(-1).id, 'reproducibility');
  const explicit = await run(projectRoute, 'missing', {source: 'project', goal: 'integrity', paths: ['missing.json']});
  assert.equal(explicit.coverage.read, 0);
  assert.equal(explicit.files[0].issues[0].code, 'NOT_FOUND');
  assert.equal(explicit.trace.graph.nodes.length, 2);
});

test('main chat selects built-in methods from the goal and observed inputs, or records an empty selection', async () => {
  const store = new Store(':memory:');
  try {
    const {id: task} = store.createTask();
    const selected = store.addAttachment(task, 'invalid.jsonl', 'material', Buffer.from('{"ok":true}\ninvalid'));
    store.addAttachment(task, 'README.md', 'material', Buffer.from('# Experiment'));
    const {id: other} = store.createTask();
    store.addAttachment(other, 'opaque.txt', 'txt', Buffer.from('No structured format'));
    const {id: empty} = store.createTask();
    async function check(task, goal, {source = 'attachments', paths = [], file_ids} = {}) {
      const {id} = store.begin(task, `${goal}-${source}-${paths.join()}-${file_ids?.join() ?? ''}`, `检查材料 ${goal}`, {});
      const model = {label: 'intent fixture', async invoke({messages, tools}) {
        assert.ok(tools.some(tool => tool.function.name === 'material_preflight'));
        if (messages.at(-1).role === 'tool') return {content: '处理完毕'};
        return {tool_calls: [{id: 'inspect', function: {name: 'material_preflight', arguments: JSON.stringify({source, goal, paths, file_ids})}}]};
      }};
      await executeRun({id, task, prompt: `检查材料 ${goal}`, store, workspace: '.', model, skillAccess: true,
        signal: new AbortController().signal, context: {goal, materials: store.task(task).files}});
      return {record: store.task(task).runs.find(run => run.id === id), events: store.events(id, 0)};
    }
    const integrity = await check(task, 'integrity');
    const structure = await check(task, 'structure');
    const reproduction = await check(task, 'reproducibility');
    assert.deepEqual(integrity.record.capabilityFit.selected, ['material-integrity']);
    assert.deepEqual(structure.record.capabilityFit.selected, ['material-structure']);
    assert.deepEqual(reproduction.record.capabilityFit.selected, ['material-reproduction-readiness']);
    assert.deepEqual(integrity.record.capabilityFit.files, structure.record.capabilityFit.files);
    assert.match(integrity.record.preflight.report.files[0].structure, /未选择结构检查/);
    assert.equal(structure.record.preflight.report.files[0].issues[0].code, 'INVALID_JSON_LINE');
    const receipt = structure.events.find(event => event.type === 'tool_result').payload.output.data;
    assert.deepEqual(receipt.findings.map(({path, line, code}) => [path, line, code]), [['invalid.jsonl', 2, 'INVALID_JSON_LINE']]);
    assert.deepEqual((await check(task, 'structure', {file_ids: [selected.id]})).record.preflight.report.files.map(file => file.id), [selected.id]);
    assert.ok(reproduction.record.preflight.report.issues.some(issue => issue.code === 'EVIDENCE_NOT_FOUND'));
    assert.ok(structure.events.find(event => event.type === 'capability_fit').seq < structure.events.find(event => event.type === 'preflight_plan').seq);
    for (const [result, reason] of [[await check(other, 'structure'), /没有匹配的结构检查器/],
      [await check(empty, 'integrity'), /没有可读取的材料/], [await check(task, 'unspecified'), /需要明确目标/],
      [await check(task, 'integrity', {source: 'project'}), /开启项目读取权限/]]) {
      assert.deepEqual(result.record.capabilityFit.selected, []);
      assert.match(result.record.answer, reason);
      assert.equal(result.record.preflight, undefined);
      assert.equal(result.events.some(event => event.type === 'preflight_plan'), false);
      assert.deepEqual(result.record.artifacts, []);
    }
    const outside = await check(task, 'integrity', {source: 'project', paths: ['../outside']});
    assert.ok(outside.events.some(event => event.type === 'tool_result' && event.payload.output.error.code === 'INVALID_ARGUMENT'));

    const prompt = '请检查本会话附件里的 JSON Lines 格式并指出无效行。';
    const {id} = store.begin(empty, 'native-missing-attachment', prompt, {});
    await executeRun({id, task: empty, prompt, store, workspace: '.', model: {label: 'unused', invoke() { assert.fail('Must not call the model'); }},
      signal: new AbortController().signal, skillAccess: true, context: {materials: []}});
    assert.equal(store.task(empty).runs.find(run => run.id === id).capabilityFit.status, 'needs_input');
    assert.equal(store.events(id, 0).some(event => event.type === 'model' || event.type === 'preflight_plan'), false);
    const {id: direct} = store.begin(task, 'native-structure', prompt, {});
    await executeRun({id: direct, task, prompt, store, workspace: '.', model: {label: 'unused', invoke() { assert.fail('Must not call the model'); }},
      signal: new AbortController().signal, skillAccess: true, context: {goal: prompt, materials: store.task(task).files}});
    assert.equal(store.events(direct, 0).some(event => event.type === 'model'), false);
    assert.match(store.task(task).runs.find(run => run.id === direct).answer, /invalid\.jsonl · 第 2 行 · 此行不是合法 JSON/);
  } finally { store.db.close(); }
});
