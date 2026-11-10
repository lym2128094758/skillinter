import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './src/server.mjs';
import { projectTestTool } from './src/project-tests.mjs';
import { validate } from './src/schema.mjs';

const call = (name, params = {}) => ({id: name, type: 'function', function: {name, arguments: JSON.stringify(params)}});
const tools = (...tool_calls) => ({tool_calls});
const runTests = () => call('run_project_tests');

async function testFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sih-project-test-'));
  const project = join(root, 'project');
  await mkdir(project);
  const fixture = {project};
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    try {
      const reply = fixture.reply(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({choices: [{finish_reason: 'stop', message: reply}]}));
    } catch (error) {
      fixture.providerError = error;
      res.writeHead(500).end();
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state: join(root, 'state'), env: {SKILLINTER_MODEL: 'test-fixture',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, {recursive: true, force: true});
    if (fixture.providerError) throw fixture.providerError;
  });
  async function api(path, body, status = 200, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {method,
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(10_000)});
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const {id: projectId} = await api('/api/projects', {path: project}, 201);
  const {id: taskId} = await api('/api/tasks', {project_id: projectId}, 201);
  const taskPath = `/api/tasks/${taskId}`;
  return Object.assign(fixture, {api, projectId, taskId, taskPath, async submit(request, extra = {}) {
    const {id} = await api(taskPath + '/runs', {prompt: '请运行项目测试，并以实际结果为准', request, ...extra}, 201);
    const route = `/api/runs/${id}`;
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}/events`, {signal: AbortSignal.timeout(15_000)});
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const events = [];
    let buffer = '';
    async function next(predicate) {
      while (true) {
        const separator = buffer.indexOf('\n\n');
        if (separator === -1) {
          const {value, done} = await reader.read();
          assert.ok(!done, 'run ended before the expected event');
          buffer += value;
          continue;
        }
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const line = frame.split('\n').find(line => line.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (predicate(event)) return event;
      }
    }
    return {id, route, events, next: type => next(event => event.type === type),
      decision: (id, decision, status) => api(route + '/project-test-decision', {id, decision}, status),
      async finished() { const event = await next(item => item.type === 'finished'); await reader.cancel(); return event.payload; }};
  }});
}

test('main chat waits for approval, repairs a failing project, reruns tests and captures evidence', {timeout: 40_000}, async t => {
  const f = await testFixture(t);
  const source = join(f.project, 'answer.mjs');
  const marker = join(f.project, 'ran.log');
  await writeFile(source, 'export const answer = 1;\n');
  await writeFile(join(f.project, 'answer.test.mjs'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { answer } from './answer.mjs';
test('answer', () => { appendFileSync('ran.log', 'run\\n'); assert.equal(answer, 2); });
`);
  const draft = {name: 'test-and-repair', description: '运行项目测试并修复', instructions: 'Use test results to guide the repair.', tests: []};
  const {skill} = await f.api('/api/skill-studio/publish', {taskId: f.taskId, targetScope: 'project', baseVersion: 0, draft}, 201);
  await writeFile(join(dirname(skill.storagePath), 'SIH.requirements.json'), JSON.stringify({required_tools: ['run_project_tests'], required_files: [], required_commands: ['node --test']}));
  const plan = status => ({id: 'test', title: '运行测试并修复', status, depends_on: []});
  let turn = 0;
  f.reply = ({messages, tools: available}) => {
    assert.ok(available.some(tool => tool.function.name === 'run_project_tests'));
    const last = messages.at(-1);
    const result = last.role === 'tool' && JSON.parse(last.content);
    const receipts = () => JSON.parse(/服务端工具回执索引：(.*)/.exec(messages[0].content)[1]);
    const finish = evidence => call('finish_skill', {skill_id: skill.id, status: 'applied', summary: '项目测试通过', evidence});
    switch (++turn) {
      case 1: return tools(call('update_plan', {expected_revision: 0, explanation: '先跑测试', steps: [plan('in_progress')]}), runTests());
      case 2:
        assert.equal(result.data.status, 'failed');
        assert.equal(receipts().at(-1).ok, false);
        return tools(finish([receipts().at(-1).seq]), call('read_file', {path: 'answer.mjs'}));
      case 3:
        return tools(call('replace_in_file', {path: 'answer.mjs', expected_sha256: result.data.file.sha256,
          old_text: 'answer = 1', new_text: 'answer = 2'}), runTests());
      case 4:
        assert.equal(result.data.status, 'passed');
        return tools(finish([receipts().at(-1).seq]), call('update_plan', {expected_revision: 1, explanation: '重跑通过', steps: [plan('completed')]}));
      default: return {content: '已修复。'};
    }
  };
  const run = await f.submit('repair', {skillId: skill.id, skillVersion: skill.version});
  const first = (await run.next('project_test_request')).payload;
  assert.match(first.command, /^node --test/);
  assert.equal(first.cwd, f.project);
  await assert.rejects(readFile(marker), {code: 'ENOENT'});
  await run.decision('wrong-id', 'approve', 409);
  await run.decision(first.id, 'approve');
  await run.decision(first.id, 'approve', 409);
  const second = (await run.next('project_test_request')).payload;
  assert.notEqual(second.id, first.id);
  assert.equal(await readFile(marker, 'utf8'), 'run\n');
  assert.match(await readFile(source, 'utf8'), /answer = 2/);
  await run.decision(second.id, 'approve');
  assert.equal((await run.finished()).status, 'completed');
  assert.equal(await readFile(marker, 'utf8'), 'run\nrun\n');
  const receipts = run.events.filter(event => event.type === 'tool_result' && event.payload.name === 'run_project_tests');
  assert.deepEqual(receipts.map(event => event.payload.output.data.exitCode), [1, 0]);
  for (const {payload} of receipts) assert.deepEqual(validate(projectTestTool.returns, payload.output), []);
  assert.ok(run.events.some(event => event.type === 'tool_result' && event.payload.output.error.code === 'NO_EVIDENCE'));
  const {runs: [saved]} = await f.api(f.taskPath);
  assert.deepEqual(saved.planReceipts.filter(item => item.name === 'run_project_tests').map(item => item.ok), [false, true]);
  assert.deepEqual(saved.skillApplications.at(-1).evidence, [receipts[1].seq]);
  assert.equal(saved.plan.steps[0].status, 'completed');
  f.reply = ({messages}) => {
    assert.match(JSON.stringify(messages), /projectTestStatus.*failed.*projectTestStatus.*passed/s);
    return {content: JSON.stringify({...draft, name: 'reusable-project-repair'})};
  };
  const created = await f.api('/api/skill-studio/draft', {taskId: f.taskId, runId: run.id, feedback: '提炼失败后修复和重跑的做法'});
  assert.equal(created.draft.name, 'reusable-project-repair');
});

test('project tests cannot bypass permission, refusal, guidance or stop', {timeout: 40_000}, async t => {
  const f = await testFixture(t);
  await writeFile(join(f.project, 'wait.test.mjs'), `
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('wait', async () => { writeFileSync('child.pid', String(process.pid)); await new Promise(resolve => setTimeout(resolve, 30000)); });
`);
  const setScope = mode => f.api(f.taskPath + '/file-access', {mode, project_id: f.projectId}, 200, 'PUT');
  let offered;
  f.reply = ({messages, tools: available}) => {
    offered = available.some(tool => tool.function.name === 'run_project_tests');
    const latest = messages.at(-1);
    return latest.role === 'user' && !latest.content.includes('不用') ? tools(runTests()) : {content: '收到。'};
  };
  await setScope('project_read');
  const readOnly = await f.submit('readonly');
  await readOnly.finished();
  assert.equal(offered, false);
  assert.ok(readOnly.events.some(event => event.payload.output?.error.code === 'TEST_NOT_ALLOWED'));
  await setScope('project_write');
  const declined = await f.submit('declined');
  await declined.decision((await declined.next('project_test_request')).payload.id, 'decline');
  await declined.finished();
  assert.ok(declined.events.every(event => event.type !== 'project_test_started'));
  const guided = await f.submit('guided');
  const stale = (await guided.next('project_test_request')).payload.id;
  await f.api(guided.route + '/guide', {prompt: '不用测试了', request: 'guide'});
  await guided.decision(stale, 'approve', 409);
  await guided.finished();
  assert.ok(guided.events.some(event => event.payload.output?.error.code === 'APPROVAL_SUPERSEDED'));
  const stopped = await f.submit('stopped');
  await stopped.decision((await stopped.next('project_test_request')).payload.id, 'approve');
  await stopped.next('project_test_started');
  const marker = join(f.project, 'child.pid');
  let pid;
  for (let attempt = 0; attempt < 40 && !pid; attempt++) {
    try { pid = Number(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pid) await sleep(50);
  }
  assert.ok(pid, 'test child actually started');
  assert.equal((await f.api(stopped.route + '/stop', {})).status, 'stopped');
  assert.equal((await stopped.finished()).status, 'stopped');
  assert.ok(stopped.events.some(event => event.payload.output?.error.code === 'ABORTED'));
  assert.ok(stopped.events.some(event => event.type === 'project_test_interrupted' && event.payload.volatile.elapsedMs > 0));
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
});
