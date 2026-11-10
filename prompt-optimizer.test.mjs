import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './src/server.mjs';
import { optimizePrompt } from './src/prompt-optimizer.mjs';

test('optimization uses selected model, preserves session state and validates model failures', async t => {
  const state = await mkdtemp(join(tmpdir(), 'sih-prompt-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const {draft} = JSON.parse(body.messages[1].content);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({model: body.model, choices: [{finish_reason: 'stop', message: {content: JSON.stringify({
      prompt: draft === '你好' ? draft : '请先制定任务计划，核对项目说明和依赖，按原文列出发现。只读检查。',
      use_plan: draft !== '你好', improvements: ['保留用户目标和限制'], questions: [],
    })}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const app = await createApp({state, env: {SKILLINTER_MODEL: 'fixture',
    SKILLINTER_MODEL_URL: 'http://127.0.0.1:' + provider.address().port + '/v1/chat/completions'}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await new Promise(resolve => provider.close(resolve)); await rm(state, {recursive: true, force: true}); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, body) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const task = await (await post('/api/tasks', {})).json();
  const response = await post('/api/prompts/optimize', {taskId: task.id, prompt: '帮我检查项目，只读', model: 'selected-model', effort: 'low'});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.use_plan, true);
  assert.match(result.prompt, /只读/);
  assert.equal(requests[0].model, 'selected-model');
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.equal(requests[0].tools, undefined);
  assert.deepEqual((await (await fetch(base + '/api/tasks/' + task.id)).json()).runs, []);
  const short = await (await post('/api/prompts/optimize', {prompt: '你好'})).json();
  assert.equal(short.prompt, '你好');
  assert.equal(short.use_plan, false);
  assert.equal((await post('/api/prompts/optimize', {prompt: ''})).status, 422);
  assert.equal((await post('/api/prompts/optimize', {prompt: 'a', effort: 'invalid'})).status, 422);
  assert.equal((await post('/api/prompts/optimize', {taskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', prompt: 'a'})).status, 404);
  for (const reply of [{content: 'not json'}, {content: '{}'}, {content: '', finishReason: 'length'}]) {
    await assert.rejects(optimizePrompt({model: {invoke: async () => reply}, prompt: 'test', context: {},
      signal: new AbortController().signal}), error => error.status === 502);
  }
});
