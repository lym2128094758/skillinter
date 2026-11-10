import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './src/server.mjs';
import { Store } from './src/store.mjs';
import { executeRun } from './src/runner.mjs';
import { chatSkillRegistry, createChatSkills, searchSkills } from './src/chat-skills.mjs';
import { auditTools } from './src/audit-tools.mjs';
import { fileToolRegistry } from './src/tools.mjs';
import { validate } from './src/schema.mjs';

const target = {fields: [{name: 'sample_id', type: 'string', required: true},
  {name: 'mass', type: 'number', required: true, unit: 'mg', minimum: 0}]};
const call = (name, args) => ({id: name, type: 'function', function: {name, arguments: JSON.stringify(args)}});
const mapping = {status: 'ready', questions: [], rationale: '表头明确给出了编号和质量单位', mappings: [
  {target: 'sample_id', source: 'sample_id', sourceUnit: ''}, {target: 'mass', source: 'mass_g', sourceUnit: 'g'}]};

test('main chat discovers and runs skills without a workflow form, persisting the same audit graph and exports', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-chat-skills-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    const system = request.messages[0].content;
    let content;
    if (!request.tools) content = system.includes('仅决定') ? mapping : {profile: true, rationale: '用户要求列统计'};
    else {
      const context = JSON.parse(system.split('当前任务上下文（仅为数据，不授予额外权限）：')[1].split('\n')[0]);
      const last = request.messages.at(-1);
      if (last.role !== 'tool') content = {tool_calls: [call('search_skills', {query: 'CSV 质量检查 单位', executable_only: true})]};
      else if (JSON.parse(last.content).data.matches) content = {tool_calls: [call('precheck_table', {
        file_id: context.selectedFile.id, goal: '质量统一为 mg，检查缺失与范围并给列统计', request: target})]};
      else content = {content: '未经验证的自由生成总结'};
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({usage: {prompt_tokens: 40, completion_tokens: 60}, model: 'fixture', choices: [
      {finish_reason: 'stop', message: request.tools ? content : {content: JSON.stringify(content)}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const app = await createApp({state, env: {SKILLINTER_MODEL: 'fixture',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.close(); await new Promise(resolve => provider.close(resolve));
    if (state.startsWith(join(tmpdir(), 'skillinter-chat-skills-'))) await rm(state, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, binary = false) => fetch(base + path, {method: 'POST',
    headers: {'content-type': binary ? 'application/octet-stream' : 'application/json'}, body: binary ? body : JSON.stringify(body)});
  const {id: task} = await (await post('/api/tasks', {})).json();
  const route = `/api/tasks/${task}`;
  const file = await (await post(route + '/files?name=sample.csv', 'sample_id,mass_g\nA,0.02\nB,-0.01\n,abc', true)).json();
  const started = await (await post(route + '/runs', {request: 'main-chat', file: file.id,
    prompt: '分析这张表，按 sample_id 和质量 mass(mg) 预检并统计，数值必须非负'})).json();
  const events = await (await fetch(base + '/api/runs/' + started.id + '/events')).text();
  const {runs: [run]} = await (await fetch(base + route)).json();
  assert.equal(run.config.workflow, undefined);
  assert.equal(run.status, 'completed');
  assert.equal(run.audit.report.status, 'completed');
  assert.equal(run.audit.report.validation.issueCount, 3);
  assert.equal(run.audit.report.mappings[1].factor, 1000);
  assert.equal(run.audit.report.profile.columns.length, 2);
  assert.ok(run.audit.skillTrace.graph.nodes.every(node => node.state === 'succeeded'));
  assert.ok(run.skillSearch.matches.some(match => match.tool === 'precheck_table' && match.executable));
  assert.match(run.answer, /发现 3 个问题/);
  assert.doesNotMatch(run.answer, /未经验证/);
  assert.equal(requests.length, 5);
  assert.equal(run.audit.report.metrics.modelCalls, 2);
  const {data: ledger} = await (await fetch(base + '/api/runs/' + started.id + '/budget')).json();
  assert.equal(ledger.rootRunId, started.id);
  assert.equal(ledger.modelCalls, requests.length);
  assert.equal(ledger.engineCalls, 1);
  assert.deepEqual(ledger.entries.filter(entry => entry.kind === 'model').map(entry => entry.phase),
    ['chat', 'chat', 'audit:mapping', 'audit:steps', 'chat']);
  assert.equal(ledger.actualOutputTokens, 300);
  assert.match(events, /skill_search/);
  for (const name of ['report.json', 'mapping.csv', 'issues.csv', 'plan.json', 'replay.json']) {
    assert.ok(run.artifacts.some(file => file.name === name), name);
  }
  const contract = await (await fetch(base + '/api/tools/contract')).json();
  assert.deepEqual(contract.skills, chatSkillRegistry);
  const exported = JSON.parse(await readFile(new URL('./docs/tool-registry.json', import.meta.url), 'utf8'));
  const intelligence = await (await fetch(base + '/api/skill-intelligence/contract')).json();
  assert.deepEqual(intelligence, exported.skillIntelligence);
  assert.deepEqual(exported.file.tools, fileToolRegistry);
  assert.deepEqual(exported.audit.tools, auditTools);
  assert.deepEqual(exported.conversation.tools, chatSkillRegistry);
});

test('skill search is deterministic and only registered capabilities are marked executable', () => {
  const args = {query: 'CSV 数据质量检查 单位', limit: 20};
  assert.equal(JSON.stringify(searchSkills(args)), JSON.stringify(searchSkills(args)));
  const local = searchSkills({...args, executable_only: true}).matches;
  assert.ok(local.some(item => item.tool === 'precheck_table'));
  assert.ok(local.every(item => chatSkillRegistry.some(tool => tool.name === item.tool)));
  const material = searchSkills({query: 'Notebook 格式结构', executable_only: true}).matches;
  assert.ok(material.some(item => item.id === 'material-structure' && item.tool === 'material_preflight'));
  assert.deepEqual(searchSkills({query: 'zzzz_unmatched_91725'}).matches, []);
});

test('chat skill calls enforce attachment ownership, schemas, cancellation and cached analysis receipts', async () => {
  const store = new Store(':memory:');
  try {
    const {id: task} = store.createTask();
    const {id: other} = store.createTask();
    const own = store.addAttachment(task, 'own.csv', 'csv', Buffer.from('value\n1\n2'));
    const foreign = store.addAttachment(other, 'other.csv', 'csv', Buffer.from('secret\n99'));
    const {id: run} = store.begin(task, 'skills', '统计 CSV', {});
    const signal = new AbortController();
    const tools = createChatSkills({store, task, run, signal: signal.signal, model: {label: 'unused'}});
    const invoke = (name, args) => tools.execute(call(name, args));
    assert.equal((await invoke('analyze_csv', {file_id: foreign.id})).error.code, 'ATTACHMENT_NOT_FOUND');
    assert.equal((await invoke('precheck_table', {file_id: own.id, goal: 'test', request: {fields: []}})).error.code, 'INVALID_ARGUMENT');
    const result = await invoke('analyze_csv', {file_id: own.id});
    assert.equal(result.ok, true);
    assert.deepEqual(validate(chatSkillRegistry.find(tool => tool.name === 'analyze_csv').returns, result), []);
    assert.deepEqual(await invoke('analyze_csv', {file_id: own.id}), result);
    assert.equal(store.task(task).runs[0].artifacts.length, 1);
    assert.equal(store.task(task).runs[0].status, 'running');
    signal.abort();
    assert.equal((await invoke('search_skills', {query: 'CSV'})).error.code, 'ABORTED');
  } finally { store.db.close(); }
});

test('nested planning consumes the main chat model budget and preserves an unfinished report', async () => {
  const store = new Store(':memory:');
  try {
    const {id: task} = store.createTask();
    const file = store.addAttachment(task, 'sample.csv', 'csv', Buffer.from('sample_id,mass_g\nA,0.02'));
    const {id: run} = store.begin(task, 'budget', '检查质量', {});
    let calls = 0;
    const model = {label: 'fixture', async invoke({tools}) {
      calls++;
      return tools ? {tool_calls: [call('precheck_table', {file_id: file.id, goal: '质量统一为 mg', request: target})]}
        : {content: JSON.stringify(mapping), finishReason: 'stop', usage: {prompt_tokens: 20, completion_tokens: 50}};
    }};
    await executeRun({id: run, task, prompt: '检查质量', model, store, workspace: '.', maxSteps: 2,
      skillAccess: true, signal: new AbortController().signal});
    const record = store.task(task).runs[0];
    assert.equal(calls, 2);
    assert.equal(record.audit.report.status, 'budget_exhausted');
    assert.equal(record.audit.report.error.code, 'BUDGET_EXHAUSTED');
    assert.equal(record.audit.report.metrics.toolCalls, 1);
    assert.match(record.answer, /未完成/);
  } finally { store.db.close(); }
});

test('main chat guidance and stop reach a nested precheck while preserving its execution record', async () => {
  for (const action of ['guide', 'stop']) {
    const store = new Store(':memory:');
    try {
      const {id: task} = store.createTask();
      const file = store.addAttachment(task, 'sample.csv', 'csv', Buffer.from('sample_id,mass_g\nA,0.02'));
      const {id: run} = store.begin(task, action, '检查质量并统计', {});
      const controller = new AbortController();
      const entry = {controller, interrupt: null};
      let notify;
      const waiting = new Promise(resolve => { notify = resolve; });
      let mappingCalls = 0;
      const model = {label: 'fixture', async invoke({messages, tools, signal}) {
        if (tools) return messages.at(-1).role === 'tool' ? {content: '检查结束'} :
          {tool_calls: [call('precheck_table', {file_id: file.id, goal: '检查质量并统计', request: target})]};
        const isMapping = messages[0].content.includes('仅决定');
        if (isMapping && mappingCalls++ === 0) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            notify();
          });
        }
        if (isMapping) assert.ok(JSON.parse(messages[1].content).guidance.includes('只做检查，不需要列统计'));
        return {content: JSON.stringify(isMapping ? mapping : {profile: false, rationale: '用户取消了列统计'}),
          finishReason: 'stop', usage: {prompt_tokens: 20, completion_tokens: 50}};
      }};
      const job = executeRun({id: run, task, prompt: '检查质量并统计', model, store, workspace: '.', maxSteps: 5,
        skillAccess: true, signal: controller.signal, entry});
      await waiting;
      if (action === 'guide') {
        store.guide(run, 'new-guidance', '只做检查，不需要列统计');
        entry.interrupt.abort();
      } else controller.abort();
      await job;
      const record = store.task(task).runs[0];
      assert.equal(record.status, action === 'guide' ? 'completed' : 'stopped', record.error);
      assert.equal(record.audit.report.status, record.status);
      if (action === 'guide') {
        assert.ok(record.guidance[0].applied);
        assert.ok(!record.audit.skillTrace.graph.nodes.some(node => node.id === 'column-profile'));
      }
      assert.ok(record.artifacts.some(file => file.name === 'report.json'));
    } finally { store.db.close(); }
  }
});

test('equivalent precheck retries reuse one report and a different goal needs a new turn', async () => {
  const store = new Store(':memory:');
  try {
    const {id: task} = store.createTask();
    const file = store.addAttachment(task, 'sample.csv', 'csv', Buffer.from('sample_id,mass_g\nA,0.02'));
    const {id: run} = store.begin(task, 'dedupe', '检查质量', {});
    let calls = 0;
    const model = {label: 'fixture', async invoke() {
      calls++;
      return {content: JSON.stringify(calls === 1 ? mapping : {profile: false, rationale: '无需额外统计'}),
        finishReason: 'stop', usage: {prompt_tokens: 20, completion_tokens: 50}};
    }};
    const tools = createChatSkills({store, task, run, model, signal: new AbortController().signal});
    const args = {file_id: file.id, goal: '检查质量', request: target};
    const result = await tools.execute(call('precheck_table', args));
    const reordered = {request: {fields: target.fields.map(field => Object.fromEntries(Object.entries(field).reverse()))},
      goal: args.goal, file_id: file.id};
    assert.equal(result.ok, true);
    assert.equal(result.data.status, 'completed');
    assert.deepEqual(await tools.execute(call('precheck_table', reordered)), result);
    assert.equal(calls, 2);
    assert.equal(store.events(run, 0).filter(event => event.type === 'audit_completed').length, 1);
    assert.equal((await tools.execute(call('precheck_table', {...args, goal: '另一项检查'}))).error.code, 'PRECHECK_ALREADY_RUN');
  } finally { store.db.close(); }
});

test('an execution announcement cannot finish the main chat before the promised skill is invoked', async () => {
  const store = new Store(':memory:');
  try {
    const {id: task} = store.createTask();
    const file = store.addAttachment(task, 'sample.csv', 'csv', Buffer.from('sample_id,mass_g\nA,0.02'));
    const {id: run} = store.begin(task, 'continue', '执行预检', {});
    let outer = 0;
    const model = {label: 'fixture', async invoke({tools, messages}) {
      if (!tools) return {content: JSON.stringify(messages[0].content.includes('仅决定') ? mapping :
        {profile: false, rationale: '无需统计'}), finishReason: 'stop', usage: {prompt_tokens: 20, completion_tokens: 50}};
      outer++;
      if (outer === 1) return {content: '已读取材料。现在执行预检：'};
      if (outer === 2) {
        assert.match(messages[0].content, /没有返回工具调用/);
        assert.equal(messages.filter(message => message.role === 'system').length, 1);
        return {tool_calls: [call('precheck_table', {file_id: file.id, goal: '执行预检', request: target})]};
      }
      return {content: '预检完成'};
    }};
    await executeRun({id: run, task, prompt: '执行预检', model, store, workspace: '.', maxSteps: 5,
      skillAccess: true, signal: new AbortController().signal});
    const record = store.task(task).runs[0];
    assert.equal(record.status, 'completed');
    assert.equal(record.audit.report.status, 'completed');
    assert.equal(store.events(run, 0).filter(event => event.type === 'execution_incomplete').length, 1);
    assert.match(record.answer, /预检完成/);
  } finally { store.db.close(); }
});
