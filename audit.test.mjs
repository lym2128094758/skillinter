import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';
import { auditWorkflow, auditLimits, reportFingerprint } from './src/workflow.mjs';
import { recordedModel } from './src/replay.mjs';
import { cases, ready } from './bench/cases.mjs';
import { projectSkillGraph, skillRegistry } from './src/audit-skills.mjs';

test('audit submission replans, persists, cites the uploaded cell and replays the recorded plan', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-audit-'));
  const plans = cases.find(item => item.id === '29-tool-failure-replan').plans;
  const received = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(200, {'content-type': 'application/json'});
    const plan = plans[Math.floor((received.length - 1) / 2)] ?? ready();
    const content = received.at(-1).messages[0].content.includes('仅决定')
      ? {status: 'ready', questions: [], rationale: plan.rationale, mappings: plan.steps[0].arguments.mappings.map(({target, source, sourceUnit}) => ({target, source, sourceUnit}))}
      : {profile: false, rationale: '本次只需逐行校验'};
    res.end(JSON.stringify({usage: {prompt_tokens: 500, completion_tokens: 200},
      choices: [{finish_reason: 'stop', message: {content: JSON.stringify(content)}}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state, env: {SKILLINTER_MODEL: 'fixture',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); await new Promise(resolve => provider.close(resolve)); await rm(state, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = path => fetch(base + path);
  const post = (path, body, binary = false) => fetch(base + path, {method: 'POST',
    headers: {'content-type': binary ? 'application/octet-stream' : 'application/json'}, body: binary ? body : JSON.stringify(body)});
  const {id: task} = await (await post('/api/tasks', {})).json();
  const {id: other} = await (await post('/api/tasks', {})).json();
  const route = `/api/tasks/${task}`;
  const text = 'sample_id,mass_g\nA,<script>bad</script>\nB,-0.02';
  const upload = await (await post(`${route}/files?name=sample.csv`, text, true)).json();
  const workflow = cases[0].request;
  const body = {prompt: '统一单位并检查范围', request: 'audit', file: upload.id, workflow};
  assert.equal((await post(`${route}/runs`, {...body, workflow: {fields: []}})).status, 422);
  const submitted = await post(`${route}/runs`, body);
  assert.equal(submitted.status, 201);
  const {id} = await submitted.json();
  assert.match(await (await get(`/api/runs/${id}/events`)).text(), /audit_replan/);
  const {runs: [run]} = await (await get(route)).json();
  assert.equal(run.status, 'completed');
  assert.equal(run.audit.report.validation.issueCount, 2);
  assert.equal(run.audit.report.metrics.inputTokens, 2000);
  assert.equal(run.audit.report.metrics.replans, 1);
  assert.equal(received.length, 4);
  assert.match(received[2].messages[1].content, /MAPPING_INVALID/);
  assert.equal((await post(`${route}/runs`, body)).status, 200);
  assert.equal((await post(`${route}/runs`, {...body, workflow: {fields: workflow.fields.slice(0, 1)}})).status, 409);
  const source = run.audit.report.validation.issues[0].evidence.url;
  assert.equal((await get(source.replace(task, other))).status, 404);
  const preview = await get(source);
  assert.match(preview.headers.get('content-security-policy'), /sandbox/);
  assert.match(await preview.text(), /&lt;script&gt;bad&lt;\/script&gt;/);
  const replayFile = run.artifacts.find(file => file.name === 'replay.json');
  const replay = await (await get(`${route}/files/${replayFile.id}`)).json();
  const {report} = await auditWorkflow({file: {...replay.source, bytes: Buffer.from(replay.source.text)}, task,
    goal: replay.goal, request: replay.request, limits: replay.limits, model: recordedModel(replay)});
  assert.equal(reportFingerprint(report), replay.reportHash);
});

test('real audit events project two distinct skill plans and an empty selection', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-skill-events-'));
  const app = await createApp({state});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); if (state.startsWith(join(tmpdir(), 'skillinter-skill-events-'))) await rm(state, {recursive: true, force: true}); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const get = async path => (await fetch(base + path)).json();
  const graph = await get('/catalog/graph.json');
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  assert.ok(skillRegistry.skills.every(skill => nodeIds.has(skill.nodeId)));
  const traces = {};
  for (const variant of ['unit', 'plain', 'missing-unit']) {
    const response = await fetch(base + '/api/demo', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({variant})});
    assert.equal(response.status, 201);
    const {task, run} = await response.json();
    const body = await (await fetch(base + '/api/runs/' + run + '/events')).text();
    const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const {runs: [record]} = await get('/api/tasks/' + task);
    const artifact = record.artifacts.find(item => item.name === 'plan.json');
    const plan = await get('/api/tasks/' + task + '/files/' + artifact.id);
    assert.deepEqual(plan.graph, projectSkillGraph(events));
    assert.deepEqual(plan, record.audit.skillTrace);
    assert.equal(plan.registry.sha256, skillRegistry.sha256);
    traces[variant] = plan;
    if (variant === 'missing-unit') {
      assert.deepEqual(plan.selection.candidates, []);
      assert.equal(record.status, 'needs_input');
      assert.equal(record.audit.report.metrics.modelCalls, 0);
      assert.equal(record.audit.report.metrics.toolCalls, 1);
      assert.deepEqual(plan.graph.nodes, []);
      assert.equal(plan.selection.missing[0].expectedUnit, 'mg');
      assert.equal((await fetch(base + plan.selection.missing[0].evidence.url)).status, 200);
    } else {
      assert.equal(record.status, 'completed');
      const receipts = events.filter(event => event.type === 'audit_skill_step').map(event => event.payload);
      const alignment = receipts.find(receipt => receipt.artifact?.type === 'field_mapping');
      const validation = receipts.find(receipt => receipt.artifact?.type === 'row_findings');
      assert.ok(alignment && validation);
      assert.deepEqual(validation.inputs, [alignment.artifact]);
      assert.ok(plan.graph.nodes.every(node => node.state === 'succeeded'));
    }
  }
  assert.ok(traces.unit.graph.nodes.some(node => node.id === 'unit-align'));
  assert.ok(traces.plain.graph.nodes.some(node => node.id === 'field-align'));
  assert.ok(traces.unit.graph.nodes.some(node => node.id === 'column-profile'));
  assert.ok(!traces.plain.graph.nodes.some(node => node.id === 'column-profile'));
});

test('truncated mapping and optional decisions fail without executing a partial plan', async () => {
  const sample = cases.find(item => item.id === '36-multiple-records');
  const source = {id: 'source', name: 'sample.csv', bytes: Buffer.from(sample.text), sha256: 'fixture'};
  const mapping = {status: 'ready', questions: [], rationale: '列名给出了明确单位',
    mappings: ready().steps[0].arguments.mappings.map(({target, source, sourceUnit}) => ({target, source, sourceUnit}))};
  for (const truncatedStage of ['mapping', 'steps']) {
    let calls = 0;
    const result = await auditWorkflow({file: source, task: 'test', goal: sample.goal, request: sample.request,
      model: {label: 'test-provider', async invoke() {
        calls++;
        const truncated = truncatedStage === 'mapping' || calls === 2;
        return {content: truncated ? '{' : JSON.stringify(mapping), finishReason: truncated ? 'length' : 'stop',
          usage: {prompt_tokens: 20, completion_tokens: truncated ? 2048 : 50}};
      }}});
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.error.code, 'OUTPUT_TRUNCATED');
    assert.equal(result.report.metrics.toolCalls, 1);
    assert.deepEqual(result.report.plans, []);
    assert.equal(result.replay.transcript.at(-1).stage, truncatedStage);
    assert.equal(result.report.metrics.modelCalls, truncatedStage === 'mapping' ? 1 : 2);
  }
  const ordinary = auditLimits('test-provider');
  const expanded = auditLimits('test-provider', undefined, true);
  assert.equal(expanded.maxTokensPerPlan, ordinary.maxTokensPerPlan * 2);
  assert.equal(expanded.maxOutputTokens, ordinary.maxOutputTokens * 2);
  assert.equal(expanded.maxSeconds, ordinary.maxSeconds);
});

test('expanded audit retry reaches the provider and is part of submission identity', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-expanded-retry-'));
  const received = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    received.push(request);
    const truncated = received.length === 1;
    const content = request.messages[0].content.includes('仅决定')
      ? {status: 'ready', questions: [], rationale: '来源列名直接给出了字段和单位',
        mappings: ready().steps[0].arguments.mappings.map(({target, source, sourceUnit}) => ({target, source, sourceUnit}))}
      : {profile: false, rationale: '无需列统计'};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({usage: {prompt_tokens: 50, completion_tokens: 50}, choices: [
      {finish_reason: truncated ? 'length' : 'stop', message: {content: truncated ? '{' : JSON.stringify(content)}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const app = await createApp({state, env: {SKILLINTER_MODEL: 'test-provider',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.close(); await new Promise(resolve => provider.close(resolve));
    if (state.startsWith(join(tmpdir(), 'skillinter-expanded-retry-'))) await rm(state, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const {id: task} = await (await post('/api/tasks', {})).json();
  const route = `/api/tasks/${task}`;
  const file = await (await fetch(base + route + '/files?name=sample.csv', {method: 'POST',
    headers: {'content-type': 'application/octet-stream'}, body: 'sample_id,mass_g\nA,0.02'})).json();
  const body = {request: 'truncated', prompt: '统一单位并逐行检查', file: file.id, workflow: cases[0].request};
  const first = await (await post(route + '/runs', body)).json();
  await (await fetch(base + '/api/runs/' + first.id + '/events')).text();
  const retry = {...body, request: 'expanded', expandedBudget: true};
  const second = await (await post(route + '/runs', retry)).json();
  await (await fetch(base + '/api/runs/' + second.id + '/events')).text();
  const detail = await (await fetch(base + route)).json();
  assert.equal(detail.runs[0].audit.report.error.code, 'OUTPUT_TRUNCATED');
  assert.equal(detail.runs[1].status, 'completed');
  assert.deepEqual(received.map(request => request.max_tokens), [2048, 4096, 4096]);
  assert.equal((await post(route + '/runs', {...retry, expandedBudget: false})).status, 409);
  assert.equal((await post(route + '/runs', {...retry, expandedBudget: 'yes'})).status, 422);
});

test('invalid optional output retries that stage while preserving the accepted mapping', async () => {
  const sample = cases.find(item => item.id === '36-multiple-records');
  const mapping = {status: 'ready', questions: [], rationale: '原始表头带有单位',
    mappings: ready().steps[0].arguments.mappings.map(({target, source, sourceUnit}) => ({target, source, sourceUnit}))};
  const answers = [mapping, {type: 'object', properties: {}}, {profile: true, rationale: '用户要求检查列统计'}];
  const stages = [];
  const result = await auditWorkflow({file: {id: 'source', name: 'sample.csv', bytes: Buffer.from(sample.text), sha256: 'fixture'},
    task: 'test', goal: sample.goal, request: sample.request, emit(type, payload) {
      if (type === 'audit_model') stages.push(payload.stage);
    }, model: {label: 'test-provider', async invoke() {
      return {content: JSON.stringify(answers.shift()), finishReason: 'stop', usage: {prompt_tokens: 20, completion_tokens: 50}};
    }}});
  assert.equal(result.report.status, 'completed');
  assert.deepEqual(stages, ['mapping', 'steps', 'steps']);
  assert.equal(result.report.metrics.replans, 1);
  assert.equal(result.report.metrics.modelCalls, 3);
  assert.ok(result.report.profile.columns.length);
  const replayed = await auditWorkflow({file: {...result.replay.source, bytes: Buffer.from(result.replay.source.text)},
    task: 'test', goal: sample.goal, request: sample.request, model: recordedModel(result.replay)});
  assert.equal(reportFingerprint(replayed.report), result.replay.reportHash);
});
