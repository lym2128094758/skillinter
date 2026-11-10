import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './src/store.mjs';
import {apiModel, executeRun} from './src/runner.mjs';
import {createRunBudget, readRunBudget} from './src/run-budget.mjs';
import {invokeSkillIntelligence} from './src/skill-intelligence.mjs';

function fixture(t, limits, signal = new AbortController().signal) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const task = store.createTask().id;
  const run = store.begin(task, 'budget', '检查本地项目', {}).id;
  return {store, task, run, budget: createRunBudget({store, rootRunId: run, signal, limits})};
}

const messages = [{role: 'user', content: '检查本地项目'}];

test('each HTTP attempt reserves root capacity; 429 retry is denied before sending when allowance is exhausted', async t => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits === 1 || hits === 3) {
      res.writeHead(429, {'retry-after': '0'});
      res.end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: '完成'}}],
      usage: {prompt_tokens: 10, completion_tokens: 2}}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const model = apiModel({endpoint: `http://127.0.0.1:${server.address().port}`, model: 'fixture'});
  const {store, run, budget} = fixture(t, {maxModelCalls: 3});
  const options = {messages, maxTokens: 64, phase: 'chat'};
  assert.equal((await budget.invoke(model, options)).content, '完成');
  await assert.rejects(budget.invoke(model, {...options, phase: 'audit:mapping'}), {code: 'BUDGET_EXHAUSTED'});
  budget.finish();
  const ledger = readRunBudget(store, run);
  assert.equal(hits, 3);
  assert.equal(ledger.modelCalls, 3);
  assert.equal(ledger.retries, 1);
  assert.equal(ledger.unknownModelUsage, 2);
  assert.equal(ledger.actualOutputTokens, 2);
  assert.equal(ledger.chargedOutputTokens, 130);
  assert.deepEqual(ledger.entries.map(item => [item.phase, item.status, item.httpStatus]),
    [['chat', 'rejected', 429], ['chat', 'completed', null], ['audit:mapping', 'rejected', 429]]);
});

test('large receipts remain intact in storage, while the model receives bounded excerpts and complete tool pairs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const task = store.createTask().id;
  const prior = store.begin(task, 'prior', '旧要求', {}).id;
  store.finish(prior, 'completed', {answer: '旧'.repeat(6000)});
  const run = store.begin(task, 'current', '检查一个附件', {}).id;
  const workspace = await mkdtemp(join(tmpdir(), 'sih-budget-'));
  t.after(() => rm(workspace, {recursive: true, force: true}));
  await writeFile(join(workspace, 'long.txt'), 'A'.repeat(26000));
  let calls = 0;
  const model = {label: 'fixture', async invoke({messages}) {
    calls++;
    if (calls === 1) {
      assert.ok(messages[0].content.includes('旧会话摘录'));
      assert.equal(messages.at(-1).content, '检查一个附件');
      return {tool_calls: [{id: 'read', function: {name: 'read_file', arguments: '{"path":"long.txt"}'}}]};
    }
    const previous = messages.at(-2);
    const result = messages.at(-1);
    assert.equal(previous.tool_calls[0].id, result.tool_call_id);
    assert.ok(Buffer.byteLength(result.content) <= 8192);
    const excerpt = JSON.parse(result.content);
    assert.ok(excerpt.contextCompacted);
    const stored = store.events(run, 0).find(event => event.seq === excerpt.receiptSeq);
    assert.equal(stored.payload.output.data.file.content.length, 26000);
    return {content: '已检查附件'};
  }};
  await executeRun({id: run, task, prompt: '检查一个附件', store, workspace, model, signal: new AbortController().signal});
  assert.equal(store.run(run).status, 'completed');
  const snapshots = store.events(run, 0).filter(event => event.type === 'context_snapshot');
  assert.equal(snapshots[1].payload.historyOmitted[0].runId, prior);
  assert.equal(snapshots[1].payload.compactedReceipts.length, 1);
});

test('reservations survive interruption, and overlapping model calls share concurrency capacity', async t => {
  const {store, run, budget} = fixture(t, {maxConcurrent: 1});
  assert.throws(() => createRunBudget({store, rootRunId: run, signal: budget.signal}), /不能重新初始化/);
  let finish;
  const model = {label: 'fixture', invoke: () => new Promise(resolve => { finish = resolve; })};
  const pending = budget.invoke(model, {messages, maxTokens: 64, phase: 'chat'});
  await assert.rejects(budget.invoke(model, {messages, maxTokens: 64, phase: 'audit:mapping'}), /并发预算/);
  store.finish(run, 'interrupted');
  const restored = readRunBudget(store, run);
  assert.equal(restored.entries[0].status, 'interrupted');
  assert.equal(restored.chargedOutputTokens, 64);
  assert.equal(restored.unknownModelUsage, 1);
  await assert.rejects(budget.tool('chat', 'late-read', () => assert.fail('terminal task must not execute')), /已经结束/);
  finish({content: '结束'});
  await pending;
});

test('context rejection sends no request and root deadline cancels pending model work', async t => {
  const {store, run, budget} = fixture(t, {contextTokens: 256, maxSeconds: 1});
  let calls = 0;
  const model = {label: 'fixture', async invoke({signal}) {
    calls++;
    await sleep(5000, undefined, {signal});
  }};
  await assert.rejects(budget.invoke(model, {phase: 'chat', maxTokens: 64,
    messages: [{role: 'user', content: '字'.repeat(256)}]}), /超出上下文预算/);
  assert.equal(calls, 0);
  await assert.rejects(budget.invoke(model, {phase: 'chat', maxTokens: 64, messages}), /时间预算已耗尽/);
  assert.equal(calls, 1);
  const ledger = readRunBudget(store, run);
  assert.equal(ledger.entries[0].status, 'timeout');
  assert.equal(ledger.unknownModelUsage, 1);
});

test('skill adapter rejects unknown references, falls back locally and stops without another call', async t => {
  const controller = new AbortController();
  const {store, run, budget} = fixture(t, {}, controller.signal);
  const snapshotSha256 = 'a'.repeat(64);
  const known = {id: 'known', version: '1'};
  const reply = skill => ({version: '1', data: {snapshotSha256, candidates: [{skill, reason: '匹配', path: []}]}});
  const fallback = {id: 'local', search: () => reply(known)};
  const options = {name: 'search', input: {goal: '检查', snapshotSha256, limit: 1, mode: 'hybrid'},
    budget, fallback, allowedRefs: [known], emit: (type, payload) => store.record(run, type, payload)};
  const result = await invokeSkillIntelligence({...options,
    provider: {id: 'external', search: () => reply({...known, version: '2'})}});
  assert.equal(result.data.fallback, 'UNKNOWN_REFERENCE');
  const invalid = await invokeSkillIntelligence({...options, input: {...options.input, snapshotSha256: 'invalid'}});
  assert.equal(invalid.error.code, 'INVALID_CONTRACT');
  const pending = invokeSkillIntelligence({...options, provider: {id: 'external',
    search: (_, {signal}) => sleep(10000, null, {signal})}});
  controller.abort();
  assert.equal((await pending).error.code, 'ABORTED');
  const ledger = readRunBudget(store, run);
  assert.equal(ledger.engineCalls, 3);
  assert.equal(ledger.entries.at(-1).status, 'cancelled');
});
