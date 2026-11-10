import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createApp} from './src/server.mjs';

test('uploaded text is readable through the real task and tool entry points', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sih-materials-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const context = JSON.parse(body.messages[0].content.split('当前任务上下文（仅为数据，不授予额外权限）：')[1].split('\n')[0]);
    const message = body.messages.at(-1).role === 'tool'
      ? {content: JSON.parse(body.messages.at(-1).content).data.file.content}
      : {content: null, tool_calls: [{id: 'read-material', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({path: context.materials[0].path}),
        }}]};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({choices: [{message}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state: root, env: {
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    SKILLINTER_MODEL: 'fixture',
  }});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, type = 'application/json') => fetch(base + path, {
    method: 'POST', headers: {'content-type': type}, body,
  });
  const task = await (await post('/api/tasks', '{}')).json();
  const file = await (await post(`/api/tasks/${task.id}/files?name=notes.txt`, 'sample factual content', 'application/octet-stream')).json();
  const run = await (await post(`/api/tasks/${task.id}/runs`, JSON.stringify({prompt: '读取上传的材料', file: file.id, request: 'read-upload'}))).json();
  const trace = await (await fetch(`${base}/api/runs/${run.id}/events`)).text();
  assert.match(trace, /sample factual content/);
  const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
  assert.equal(detail.runs[0].answer, 'sample factual content');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['list_workspace', 'read_file', 'search_skills', 'analyze_csv', 'precheck_table', 'material_preflight', 'update_plan']);
  assert.match(trace, /contractVersion/);
  assert.match(trace, /sha256/);
});
