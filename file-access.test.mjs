import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';
import { executeTool } from './src/tools.mjs';

const call = (name, args) => ({type: 'function', id: name, function: {name, arguments: JSON.stringify(args)}});

async function fixture() {
  const prefix = join(resolve(tmpdir()), 'skillinter-files-');
  const dir = await mkdtemp(prefix);
  const project = join(dir, 'project');
  const state = join(dir, 'private');
  await Promise.all([mkdir(project), mkdir(state)]);
  const cleanup = async () => { if (dir.startsWith(prefix)) await rm(dir, {recursive: true, force: true}); };
  return {dir, project, state, cleanup};
}

test('file tools enforce project boundaries and change only the requested UTF-8 text', async t => {
  const {dir, project, state, cleanup} = await fixture();
  t.after(cleanup);
  const outside = join(dir, 'outside.txt');
  await writeFile(outside, 'outside');
  await writeFile(join(state, 'private.txt'), 'private');
  await writeFile(join(project, 'note.txt'), '\uFEFFfirst\r\nreplace this\r\nlast\r\n');
  await symlink(dir, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const scope = {mode: 'project_write', projectPath: project, state};
  const execute = (name, args, mode = scope.mode) => executeTool(call(name, args), state, undefined, {...scope, mode});
  assert.equal((await execute('read_file', {path: outside})).error.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal((await execute('read_file', {path: '../outside.txt'})).error.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal((await execute('read_file', {path: 'link/outside.txt'})).error.code, 'SYMLINK_NOT_ALLOWED');
  assert.equal((await execute('create_file', {path: 'link/new.txt', content: 'bad'})).error.code, 'SYMLINK_NOT_ALLOWED');
  assert.equal((await execute('read_file', {path: join(state, 'private.txt')}, 'full')).error.code, 'PROTECTED_PATH');
  assert.equal((await execute('create_file', {path: 'note.txt', content: 'bad'}, 'project_read')).error.code, 'WRITE_NOT_ALLOWED');
  assert.equal((await execute('create_file', {path: 'note.txt', content: 'bad'})).error.code, 'FILE_EXISTS');
  const {data: {file}} = await execute('read_file', {path: join(project, 'note.txt')});
  assert.match(file.sha256, /^[a-f\d]{64}$/);
  const edit = {path: 'note.txt', old_text: 'first\nreplace this', new_text: 'first\nupdated', expected_sha256: file.sha256};
  const change = await execute('replace_in_file', edit);
  assert.equal(change.data.file.operation, 'modified');
  assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), '\uFEFFfirst\r\nupdated\r\nlast\r\n');
  assert.equal((await execute('replace_in_file', edit)).error.code, 'EDIT_CONFLICT');
  assert.equal((await execute('read_file', {path: outside}, 'full')).data.file.content, 'outside');
  const created = await execute('create_file', {path: join(dir, 'new.txt'), content: 'ok\n'}, 'full');
  assert.equal(created.data.file.operation, 'created');
  assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'ok\n');
  if (process.platform === 'win32') {
    assert.equal((await execute('read_file', {path: '\\\\.\\NUL'}, 'full')).error.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal((await execute('create_file', {path: 'note.txt:stream', content: 'bad'})).error.code, 'PATH_OUTSIDE_WORKSPACE');
  }
});

test('the chosen chat scope reaches the model and persists with projects across restarts', async t => {
  const {dir, project, state, cleanup} = await fixture();
  const target = join(project, 'notes.txt');
  const outside = join(dir, 'other.txt');
  await writeFile(target, 'alpha');
  await writeFile(outside, 'outside');
  const requests = [];
  const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const latest = request.messages.at(-1);
    const prompt = request.messages.findLast(message => message.role === 'user').content;
    const answer = latest.role === 'user'
      ? {tool_calls: [call('read_file', {path: prompt === 'edit' ? 'notes.txt' : outside})]}
      : prompt === 'edit' && JSON.parse(latest.content).data?.file?.content === 'alpha'
        ? {tool_calls: [call('replace_in_file', {path: 'notes.txt', old_text: 'alpha', new_text: 'beta',
          expected_sha256: JSON.parse(latest.content).data.file.sha256})]}
        : {content: 'done'};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{finish_reason: 'stop', message: answer}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const env = {SKILLINTER_MODEL: 'fixture', SKILLINTER_MODEL_URL: 'http://127.0.0.1:' + provider.address().port + '/v1/chat/completions'};
  let app;
  t.after(async () => {
    if (app) await app.close();
    await new Promise(resolve => provider.close(resolve));
    await cleanup();
  });
  async function launch() {
    app = await createApp({state, env});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = 'http://127.0.0.1:' + app.server.address().port;
    return (route, body, method = body ? 'POST' : 'GET') => fetch(base + route, {method,
      ...(body ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {})});
  }
  let request = await launch();
  assert.equal((await request('/api/projects', {path: state})).status, 403);
  const added = await (await request('/api/projects', {path: project})).json();
  assert.equal((await (await request('/api/projects', {path: project})).json()).id, added.id);
  const {id} = await (await request('/api/tasks', {project_id: added.id})).json();
  const route = '/api/tasks/' + id;
  const setAccess = (mode, confirmed = false) => request(route + '/file-access', {mode, project_id: added.id, confirmed}, 'PUT');
  async function run(prompt, requestId, extra = {}) {
    const response = await request(route + '/runs', {prompt, request: requestId, ...extra});
    assert.equal(response.status, 201);
    const run = await response.json();
    return (await request('/api/runs/' + run.id + '/events')).text();
  }
  assert.equal((await setAccess('full')).status, 422);
  const denied = await run('outside', 'denied', {fileScope: {mode: 'full'}});
  assert.match(denied, /PATH_OUTSIDE_WORKSPACE/);
  const edited = await run('edit', 'edit');
  assert.match(edited, /"operation":"modified"/);
  assert.equal(await readFile(target, 'utf8'), 'beta');
  assert.ok(requests.find(item => item.messages.at(-1).content === 'edit').tools.some(tool => tool.function.name === 'replace_in_file'));
  assert.equal((await setAccess('project_read')).status, 200);
  await run('edit', 'readonly');
  assert.ok(requests.at(-1).tools.every(tool => tool.function.name !== 'replace_in_file'));
  assert.equal((await setAccess('full', true)).status, 200);
  assert.match(await run('outside', 'full'), /"content":"outside"/);
  await app.close();
  app = undefined;
  request = await launch();
  const persisted = await (await request(route)).json();
  assert.equal(persisted.project_id, added.id);
  assert.equal(persisted.file_access, 'full');
  assert.equal(persisted.runs.length, 4);
  assert.equal((await (await request('/api/projects')).json())[0].id, added.id);
});
