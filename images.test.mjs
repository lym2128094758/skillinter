import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './src/server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=', 'base64');

test('image uploads preview safely, reach the vision request, and persist through a follow-up', async t => {
  const state = await mkdtemp(join(tmpdir(), 'skillinter-image-test-'));
  const requests = [];
  let rejectImage = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(rejectImage ? 400 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify(rejectImage ? {error: 'unsupported image input'} :
      {choices: [{finish_reason: 'stop', message: {content: '已收到图片'}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const app = await createApp({state, env: {SKILLINTER_MODEL: 'vision-fixture',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.close(); await new Promise(resolve => provider.close(resolve));
    if (state.startsWith(join(tmpdir(), 'skillinter-image-test-'))) await rm(state, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, binary = false) => fetch(base + path, {method: 'POST',
    headers: {'content-type': binary ? 'application/octet-stream' : 'application/json'}, body: binary ? body : JSON.stringify(body)});
  const {id: task} = await (await post('/api/tasks', {})).json();
  const route = `/api/tasks/${task}`;
  assert.equal((await post(route + '/files?name=fake.png', Buffer.from('<svg onload="alert(1)">'), true)).status, 422);
  const largerImage = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
  const large = await post(route + '/files?name=large.png', largerImage, true);
  assert.equal(large.status, 201);
  const largeFile = await large.json();
  assert.deepEqual(Buffer.from(await (await fetch(base + route + '/files/' + largeFile.id + '/preview')).arrayBuffer()), largerImage);
  const upload = await post(route + '/files?name=picture.png', png, true);
  assert.equal(upload.status, 201);
  const file = await upload.json();
  assert.equal(file.kind, 'image');
  const preview = await fetch(base + route + '/files/' + file.id + '/preview');
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const other = await (await post('/api/tasks', {})).json();
  assert.equal((await fetch(base + '/api/tasks/' + other.id + '/files/' + file.id + '/preview')).status, 404);
  const pending = await (await post(route + '/files?name=pending.png', png, true)).json();
  const remove = (path) => fetch(base + path, {method: 'DELETE', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal((await remove('/api/tasks/' + other.id + '/files/' + pending.id)).status, 404);
  const removed = await remove(route + '/files/' + pending.id);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {deleted: true, id: pending.id});
  assert.equal((await fetch(base + route + '/files/' + pending.id + '/preview')).status, 404);
  assert.equal((await (await fetch(base + route)).json()).files.some(item => item.id === pending.id), false);
  assert.equal((await post(route + '/runs', {request: 'empty', prompt: ''})).status, 422);
  const first = await (await post(route + '/runs', {request: 'first', prompt: '', file: file.id})).json();
  await (await fetch(base + '/api/runs/' + first.id + '/events')).text();
  const content = requests[0].messages.at(-1).content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[0].image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(requests[0].messages[0].content.includes(png.toString('base64')), false);
  assert.equal((await remove(route + '/files/' + file.id)).status, 409);
  assert.equal((await fetch(base + route + '/files/' + file.id + '/preview')).status, 200);
  const second = await (await post(route + '/runs', {request: 'followup', prompt: '再说说刚才的图片'})).json();
  await (await fetch(base + '/api/runs/' + second.id + '/events')).text();
  assert.deepEqual(requests[1].messages[1].content, content);
  assert.equal(requests[1].messages.at(-1).content, '再说说刚才的图片');
  rejectImage = true;
  const third = await (await post(route + '/runs', {request: 'unsupported', prompt: '图片请求'})).json();
  await (await fetch(base + '/api/runs/' + third.id + '/events')).text();
  const saved = await (await fetch(base + route)).json();
  assert.equal(saved.runs[0].prompt, '');
  assert.equal(saved.title, 'picture.png');
  assert.equal(saved.runs[0].input_file, file.id);
  assert.equal(saved.runs[0].status, 'completed');
  assert.match(saved.runs[2].error, /图片请求被服务商拒绝.*支持图片输入/);
});
