import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './src/store.mjs';
import {createSkillStudio} from './src/skill-studio.mjs';
import {createSkillRegistry} from './src/skill-registry.mjs';
import {createSkillDiscovery} from './src/skill-discovery.mjs';
import {createSkillnetConnection} from './src/skillnet-provider.mjs';
import {executeRun} from './src/runner.mjs';
import {readRunBudget} from './src/run-budget.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sih-intelligence-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const store = new Store(':memory:');
  t.after(async () => { store.db.close(); await rm(root, {recursive: true, force: true}); });
  const project = store.addProject(projectPath, 'example');
  const task = store.createTask(project.id).id;
  const studio = createSkillStudio(store, {userSkillsPath: join(root, 'skills')});
  return {root, store, studio, task, project, projectPath};
}

test('engine-selected UUID enters the frozen dependency chain and real file receipts follow that order', async t => {
  const f = await fixture(t);
  await writeFile(join(f.projectPath, 'input.txt'), 'real project content');
  const publish = name => f.studio.publish({taskId: f.task, baseVersion: 0, draft: {
    name, description: 'A published task method.', instructions: 'Read input.txt and cite the receipt.', tests: [],
  }});
  const a = publish('first-method'), b = publish('second-method');
  const registry = createSkillRegistry({store: f.store, studio: f.studio, projectFor: () => f.project.id});
  registry.relation({context: f.task, source: b.id, target: a.id, type: 'depend_on',
    expectedRevision: registry.snapshot(f.task).revision});
  const run = f.store.begin(f.task, 'engine', '执行一个新任务', {}).id;
  const call = (name, args) => ({tool_calls: [{id: name, function: {name, arguments: JSON.stringify(args)}}]});
  let turn = 0;
  const model = {label: 'fixture', async invoke() {
    turn++;
    if (turn === 1 || turn === 3) return call('read_file', {path: 'input.txt'});
    if (turn === 2 || turn === 4) {
      const receipt = f.store.events(run, 0).findLast(event => event.type === 'tool_result' && event.payload.name === 'read_file');
      return call('finish_skill', {skill_id: receipt.payload.skillId, status: 'applied', summary: '读取真实输入', evidence: [receipt.seq]});
    }
    return {content: '已按方法链读取项目文件。'};
  }};
  const provider = {id: 'test-engine', async search(input, {allowedRefs}) {
    assert.equal(allowedRefs.length, 2);
    assert.ok(allowedRefs.every(card => !Object.hasOwn(card, 'instructions')));
    return {version: 'test-1', data: {snapshotSha256: input.snapshotSha256,
      candidates: [{skill: {id: b.id, version: '1'}, reason: 'engine picked second', path: []}]}};
  }};
  await executeRun({id: run, task: f.task, prompt: '执行一个新任务', store: f.store, workspace: f.root,
    scope: {mode: 'project_read', projectPath: f.projectPath, projectId: f.project.id}, model, maxSteps: 8,
    localSkills: f.studio.list(f.task), skillAccess: true, skillEngine: provider,
    skillRegistrySnapshot: registry.snapshot(f.task), signal: new AbortController().signal});
  assert.equal(f.store.run(run).status, 'completed', f.store.run(run).error);
  const reads = f.store.events(run, 0).filter(event => event.type === 'tool_result' && event.payload.name === 'read_file');
  assert.deepEqual(reads.map(event => event.payload.skillId), [a.id, b.id]);
  assert.ok(reads.every(event => event.payload.output.data.file.content === 'real project content'));
  assert.equal(readRunBudget(f.store, run).engineCalls, 1);
});

test('public source preview stays isolated, persists provenance and imports only after review into the requested project', async t => {
  const f = await fixture(t);
  const service = createSkillDiscovery({store: f.store, studio: f.studio});
  const source = 'https://github.com/example/skills/blob/main/method/SKILL.md';
  const body = '---\nname: reviewed-method\ndescription: Read project files with evidence\n---\nRead input.txt and report its actual contents.\n';
  const sha = createHash('sha256').update(body).digest('hex');
  const commit = 'a'.repeat(40);
  const provider = {id: 'fixture-source', async discover() {
    return {version: '1', data: {sources: [{source, commit, license: 'MIT', contentSha256: sha, title: 'reviewed-method', body,
      pinnedUrl: source.replace('/main/', '/' + commit + '/'), licenseSha256: 'b'.repeat(64), licensePath: 'LICENSE', retrievedAt: '2026-11-10T00:00:00Z'}]}};
  }};
  const run = f.store.begin(f.task, 'discover', '检查公开来源', {}).id;
  const preview = await service.preview({context: f.task, run, provider, tags: ['software testing'], sources: [source],
    confirmed: true, signal: new AbortController().signal});
  assert.equal(f.studio.list(f.task).length, 0);
  assert.equal(readRunBudget(f.store, run).modelCalls, 0);
  assert.equal(service.get(preview.id, f.task).candidates[0].body, body);
  assert.throws(() => service.import({id: preview.id, candidateId: preview.candidates[0].id, context: f.task, targetScope: 'project'}), /确认导入/);
  const args = {id: preview.id, candidateId: preview.candidates[0].id, context: f.task, targetScope: 'project', confirmed: true};
  const saved = service.import(args);
  assert.equal(saved.skill.projectId, f.project.id);
  assert.equal(service.import(args).reused, true);
  assert.equal(f.studio.list(null).length, 0);
  assert.equal(f.studio.list(f.task).length, 1);
  const provenance = f.store.events(run, 0).find(event => event.type === 'skill_discovery_imported').payload;
  assert.equal(provenance.contentSha256, sha);
  assert.equal(provenance.packageScope, 'SKILL.md-only');
  const other = f.store.addProject(join(f.root, 'another'), 'another');
  assert.throws(() => service.get(preview.id, {projectId: other.id}), /不属于当前项目/);
});

test('engine settings persist with revision conflicts and disabled connection preserves the local path', async t => {
  const f = await fixture(t);
  const service = createSkillnetConnection({store: f.store, state: f.root});
  const initial = service.view();
  assert.equal(service.provider(), null);
  const value = service.save({...initial, enabled: true, sourcePath: f.root});
  assert.equal(value.revision, 1);
  assert.throws(() => service.save(initial), /已变化/);
  const reloaded = createSkillnetConnection({store: f.store, state: f.root});
  assert.equal(reloaded.view().sourcePath, f.root);
  reloaded.save({...value, enabled: false});
  assert.equal(reloaded.provider(), null);
});
