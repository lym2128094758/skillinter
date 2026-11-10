import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';
import { Store } from './src/store.mjs';
import { createSkillStudio } from './src/skill-studio.mjs';

test('draft creation and comparison retry truncated model output once without publishing incomplete content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sih-studio-retry-'));
  const store = new Store(join(root, 'tasks.sqlite'));
  t.after(async () => { store.db.close(); await rm(root, {recursive: true, force: true}); });
  const studio = createSkillStudio(store, {userSkillsPath: join(root, 'skills')});
  const draft = {name: 'bounded-review', description: '静态代码核对', instructions: '核对边界输入，未运行测试时明确写未运行测试。', tests: []};
  const limits = [];
  const prepared = await studio.draft({feedback: '静态代码核对', model: {label: 'fixture', async invoke({maxTokens, messages}) {
    limits.push(maxTokens);
    assert.equal(messages.filter(message => message.role === 'system').length, 1);
    return limits.length === 1 ? {finishReason: 'length', content: '{"incomplete":'} : {finishReason: 'stop', content: JSON.stringify(draft)};
  }}});
  assert.deepEqual(limits, [4096, 8192]);
  assert.deepEqual(prepared.draft, draft);
  assert.equal(studio.list(null).length, 0);
  let calls = 0;
  const comparison = await studio.compare({draft, test: {prompt: '检查一个函数', expected_output: '标明测试状态', expectations: ['包含：未运行测试']},
    model: {label: 'fixture', async invoke() { calls++; return calls % 2 ? {finishReason: 'length', content: ''} : {finishReason: 'stop', content: '未运行测试'}; }}});
  assert.equal(calls, 4);
  assert.equal(comparison.candidate.checks[0].status, 'passed');
  assert.deepEqual(comparison.candidate.attempts.map(attempt => attempt.maxTokens), [4096, 8192]);
  await assert.rejects(studio.draft({feedback: 'x', model: {label: 'fixture', async invoke() { return {finishReason: 'length', content: ''}; }}}), /输出达到长度上限/);
  assert.equal(studio.list(null).length, 0);
});

test('chat evidence becomes a project skill with isolated comparison, version history and main-chat loading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'skillinter-studio-'));
  const projectPath = join(root, 'example');
  await mkdir(projectPath);
  const sample = {prompt: '审核样例', expected_output: '给出证据定位', expectations: ['包含：定位', '给出复核条件']};
  const draft = {name: '文献证据核验', description: '检查引用并定位原文', instructions: '列出结论，标注【定位】。', tests: [sample]};
  const next = {...draft, instructions: '先写复核条件，再标注【定位】。'};
  const requests = [];
  const tool = (name, args) => ({tool_calls: [{id: name, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
  const provider = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({data: [{id: 'fixture'}]}));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const [system] = request.messages;
    const last = request.messages.at(-1);
    let message;
    if (system.content.includes('技能编写助手')) message = {content: JSON.stringify(draft)};
    else if (system.content.includes('独立的文本试跑')) {
      message = {content: system.content.includes('定位') ? '请核对【定位】' : '普通回答'};
    } else if (last.role === 'tool') {
      const data = JSON.parse(last.content).data;
      message = data?.matches
        ? tool('load_skill', {skill_id: data.matches.find(match => match.tool === 'load_skill').id})
        : {content: data.instructions};
    } else if (last.content === '检索适用技能') {
      message = tool('search_skills', {query: '文献证据核验', executable_only: true});
    } else {
      message = {content: system.content.includes(next.instructions) ? next.instructions : '成功核验：结论附定位。'};
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({model: 'fixture', usage: {prompt_tokens: 30, completion_tokens: 15},
      choices: [{finish_reason: 'stop', message}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state: join(root, 'state'), env: {SKILLINTER_MODEL: 'fixture',
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, status, body) {
    const response = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function run(task, request, prompt, skillId, skillVersion) {
    const started = await call(`/api/tasks/${task}/runs`, 201, {request, prompt, skillId, skillVersion});
    const events = await (await fetch(`${base}/api/runs/${started.id}/events`)).text();
    const result = (await call(`/api/tasks/${task}`, 200)).runs.find(row => row.id === started.id);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return {...result, events};
  }

  const project = await call('/api/projects', 201, {path: projectPath});
  const {id: task} = await call('/api/tasks', 201, {project_id: project.id});
  const {id: other} = await call('/api/tasks', 201, {});
  const original = await run(task, 'origin', '审核引用并给出定位');
  const studio = '/api/skill-studio';
  const prepared = await call(studio + '/draft', 200, {taskId: task, runId: original.id});
  assert.deepEqual({...prepared, attempts: undefined}, {draft, baseVersion: 0, sourceRunId: original.id, attempts: undefined});
  assert.equal(prepared.attempts[0].maxTokens, 4096);
  assert.match(requests.at(-1).messages.at(-1).content, /成功核验/);
  assert.deepEqual((await call(studio + '?task=' + task, 200)).skills, []);

  const compared = await call(studio + '/compare', 200, {taskId: task, draft, test: sample});
  assert.equal(compared.baseline.version, null);
  assert.equal(compared.baseline.checks[0].status, 'failed');
  assert.deepEqual(compared.candidate.checks.map(check => check.status), ['passed', 'review']);
  const trialRequests = requests.slice(-2);
  assert.deepEqual(trialRequests.map(request => request.messages.at(-1).content), [sample.prompt, sample.prompt]);
  assert.ok(trialRequests.every(request => !request.tools && request.stream && request.model === 'fixture'));

  const {skill} = await call(studio + '/publish', 201, {taskId: task, baseVersion: 0, draft, sourceRunId: original.id});
  assert.equal(skill.version, 1);
  assert.equal(skill.sourceRunId, original.id);
  assert.deepEqual((await call(studio + '?task=' + other, 200)).skills, []);
  await call(studio + '/' + skill.id + '?task=' + other, 404);
  await call(`/api/tasks/${other}/runs`, 404, {request: 'blocked', prompt: '加载', skillId: skill.id});
  const updatedComparison = await call(studio + '/compare', 200, {taskId: task, skillId: skill.id, baseVersion: 1, draft: next, test: sample});
  assert.equal(updatedComparison.baseline.version, 1);
  await call(studio + '/publish', 200, {taskId: task, skillId: skill.id, baseVersion: 1, draft: next});
  await call(studio + '/publish', 409, {taskId: task, skillId: skill.id, baseVersion: 1, draft: next});
  const detail = await call(studio + '/' + skill.id + '?task=' + task, 200);
  assert.deepEqual(detail.versions.map(version => version.version), [2, 1]);

  const {id: fresh} = await call('/api/tasks', 201, {project_id: project.id});
  await call(`/api/tasks/${fresh}/runs`, 409, {request: 'explicit', prompt: '按选中的技能审核', skillId: skill.id, skillVersion: 1});
  const explicit = await run(fresh, 'explicit', '按选中的技能审核', skill.id, 2);
  assert.equal(explicit.answer, next.instructions);
  assert.equal(explicit.config.customSkill.version, 2);
  assert.deepEqual(explicit.loadedSkills, [explicit.config.customSkill]);
  const discovered = await run(fresh, 'discovery', '检索适用技能');
  assert.equal(discovered.answer, next.instructions);
  assert.equal(discovered.loadedSkills[0].version, 2);
  assert.match(discovered.events, /custom_skill_loaded/);

  const freshRoute = '/api/tasks/' + fresh;
  const uploaded = await fetch(base + freshRoute + '/files?name=observations.jsonl', {method: 'POST',
    headers: {'content-type': 'application/octet-stream'}, body: '{"private_source":"do not forward"}\ninvalid'});
  assert.equal(uploaded.status, 201);
  const checked = await call(freshRoute + '/preflight', 201, {request: 'check-materials', prompt: '检查输入材料',
    preflight: {source: 'attachments', goal: 'structure'}});
  await (await fetch(base + '/api/runs/' + checked.id + '/events')).text();
  await call(studio + '/draft', 200, {taskId: fresh, runId: checked.id});
  const evidence = JSON.parse(requests.at(-1).messages.at(-1).content).evidence;
  assert.deepEqual(evidence.preflight.findings, ['INVALID_JSON_LINE']);
  assert.deepEqual(evidence.preflight.steps.map(step => step.id), ['inventory', 'integrity', 'structure']);
  assert.doesNotMatch(JSON.stringify(evidence), /private_source/);

  const markdown = '---\nname: lab-notes\ndescription: >\n  Check a lab note\n  before sharing it.\n---\n# Procedure\nRecord missing evidence.\n';
  const imported = await call(studio + '/import', 200, {name: 'SKILL.md', content: markdown});
  assert.equal(imported.draft.description, 'Check a lab note before sharing it.');
  assert.deepEqual(imported.draft.tests, []);
  assert.match(imported.draft.instructions, /Record missing evidence/);
  assert.equal((await call(studio, 200)).skills.length, 0);
  await call(studio + '/import', 422, {name: 'SKILL.md', content: '# Missing metadata'});
  await call(studio + '/import', 422, {name: 'skill.json', content: '{"name":"invalid"}'});
  await call(studio + '/publish', 422, {baseVersion: 0, targetScope: 'project', draft: imported.draft});
  const created = await call(studio + '/publish', 201, {taskId: task, baseVersion: 0, targetScope: 'global', draft: imported.draft});
  assert.equal(created.skill.projectId, null);
  await call(studio + '/publish', 409, {taskId: task, baseVersion: 0, targetScope: 'global', draft: imported.draft});
  assert.ok((await call(studio + '?task=' + other, 200)).skills.some(skill => skill.id === created.skill.id));
  const exported = JSON.stringify({...created.skill, version: 1});
  const restored = await call(studio + '/import', 200, {name: 'skill.json', content: exported});
  assert.deepEqual(restored.draft, imported.draft);
  const directory = join(root, 'incoming');
  await mkdir(join(directory, 'lab-notes'), {recursive: true});
  await writeFile(join(directory, 'lab-notes', 'SKILL.md'), markdown);
  await writeFile(join(directory, 'other.md'), markdown.replace('lab-notes', 'other-notes'));
  await writeFile(join(directory, 'invalid.md'), '# Not a skill');
  const directoryImport = await call(studio + '/import-directory', 200,
    {taskId: task, targetScope: 'project', path: directory});
  assert.equal(directoryImport.truncated, false);
  assert.equal(directoryImport.candidates.filter(item => item.draft).length, 2);
  assert.equal(directoryImport.candidates.filter(item => item.error).length, 1);
  assert.ok(directoryImport.candidates.some(item => item.path === 'lab-notes/SKILL.md'));
  await call(studio + '/import-directory', 422, {targetScope: 'project', path: directory});
  await call(studio + '/import-directory', 422, {path: 'relative/path'});
  await call(studio + '/import-directory', 422, {path: join(root, 'state')});
  const projectImport = await call(studio + '/publish', 201,
    {taskId: task, targetScope: 'project', baseVersion: 0, draft: imported.draft});
  assert.equal(projectImport.skill.projectId, project.id);
  assert.ok(!(await call(studio + '?task=' + other, 200)).skills.some(skill => skill.id === projectImport.skill.id));
  const taskCount = (await call('/api/tasks', 200)).length;
  const directDraft = {...imported.draft, name: 'direct-project-import'};
  const independentImport = await call(studio + '/import', 200,
    {projectId: project.id, targetScope: 'project', name: 'skill.json', content: JSON.stringify(directDraft)});
  const savedWithoutChat = await call(studio + '/publish', 201,
    {projectId: project.id, targetScope: 'project', baseVersion: 0, draft: independentImport.draft});
  assert.equal(savedWithoutChat.skill.projectId, project.id);
  assert.equal(dirname(dirname(savedWithoutChat.skill.storagePath)), join(await realpath(projectPath), '.sih', 'skills'));
  assert.ok((await call(studio + '?project=' + project.id, 200)).skills.some(skill => skill.id === savedWithoutChat.skill.id));
  assert.equal((await call(studio + '/locations?project=' + project.id, 200)).project, join(projectPath, '.sih', 'skills'));
  assert.equal((await call('/api/tasks', 200)).length, taskCount);
});
