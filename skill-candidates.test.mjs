import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from './src/store.mjs';
import {createSkillStudio} from './src/skill-studio.mjs';
import {routeSkills} from './src/skill-routing.mjs';
import {createApp} from './src/server.mjs';
import {once} from 'node:events';

const tests = [
  {prompt: '材料 [L1] 温度 20°C。提取温度并给出来源。', expected_output: '温度与来源定位', expectations: ['包含：20°C', '包含：[L1]']},
  {prompt: '材料 [L2] 温度未记录。提取温度并说明缺项。', expected_output: '明确缺失，不猜测', expectations: ['包含：未提供', '不包含：25°C']},
];
const draft = {name: 'evidence-summary', description: '证据摘录与缺失说明', instructions: '旧方法', tests};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sih-candidate-'));
  const store = new Store(join(root, 'tasks.sqlite'));
  const options = {userSkillsPath: join(root, 'skills')};
  const studio = createSkillStudio(store, options);
  const baseline = studio.publish({taskId: null, targetScope: 'global', baseVersion: 0, draft});
  t.after(async () => {store.db.close(); await rm(root, {recursive: true, force: true});});
  const save = changes => studio.candidates.save({context: null, skillId: baseline.id, baseVersion: 1, draft: {...draft, instructions: '新方法'}, ...changes});
  return {store, studio, baseline, root, options, save};
}
function model(mode = 'improved', calls = []) {
  return {label: 'fixture', async invoke({messages}) {
    const side = messages[0].content.includes('新方法') ? 'candidate' : 'baseline';
    const index = messages[1].content.includes('[L1]') ? 0 : 1;
    calls.push({side, index});
    if (mode === 'throws' && calls.length === 3) throw Error('network');
    if (mode === 'truncated') return {content: '截断', finishReason: 'length'};
    const good = mode === 'tie' || mode === 'regression' && side === 'baseline' || mode !== 'regression' && side === 'candidate';
    return {content: good ? index ? '温度：未提供。' : '20°C [L1]' : index ? '25°C' : '20°C', finishReason: 'stop',
      reportedModel: mode === 'model-change' ? side : 'fixture', usage: {prompt_tokens: 20, completion_tokens: 8}};
  }};
}

test('candidate snapshot survives reload without entering routing, freezes regression tests, and cannot publish caller claims', async t => {
  const f = await fixture(t);
  const input = {...draft, instructions: '新方法', tests: [tests[0]]};
  const candidate = f.save({draft: input}); input.instructions = 'mutated';
  assert.equal(candidate.draft.instructions, '新方法'); assert.equal(candidate.suite.length, 2);
  assert.equal(f.studio.enabled(null)[0].instructions, '旧方法');
  assert.equal(f.save({draft: {...draft, instructions: '新方法', tests: [tests[0]]}}).id, candidate.id);
  const restored = createSkillStudio(f.store, f.options);
  assert.equal(restored.candidates.get(candidate.id, null).sha256, candidate.sha256);
  await assert.rejects(restored.candidates.promote({id: candidate.id, context: null, confirmed: true, trialId: 'fabricated'}), /没有可发布/);
  assert.equal(restored.candidates.list(null)[0].verdict, 'pending');
  assert.equal(f.studio.get(f.baseline.id, null).version, 1);
  assert.throws(() => f.save({draft: {...draft, tests: [tests[0], {...tests[0], expectations: ['包含：其他']}]}}), /重复/);
  const projectPath = join(f.root, 'project'); await mkdir(projectPath);
  const project = f.store.addProject(projectPath, 'project');
  const scoped = f.studio.candidates.save({context: {projectId: project.id}, targetScope: 'project', baseVersion: 0, draft});
  assert.throws(() => f.studio.candidates.get(scoped.id, null), /当前范围/);
});

test('paired frozen trials alternate order and only reviewed improvement becomes a version used by later routing', async t => {
  const f = await fixture(t), candidate = f.save(), calls = [];
  const result = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model('improved', calls)});
  assert.deepEqual(calls, [{side: 'baseline', index: 0}, {side: 'candidate', index: 0}, {side: 'candidate', index: 1}, {side: 'baseline', index: 1}]);
  assert.equal(result.trials[0].verdict, 'improved'); assert.equal(result.trials[0].improvedCases, 2);
  assert.match(result.trials[0].contract.evaluatorSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.studio.get(f.baseline.id, null).version, 1);
  await assert.rejects(f.studio.candidates.promote({id: candidate.id, context: null, trialId: result.trials[0].id}), /审核/);
  const published = await f.studio.candidates.promote({id: candidate.id, context: null, trialId: result.trials[0].id, confirmed: true});
  assert.equal(published.skill.version, 2); assert.equal(published.candidate.publishedVersion, 2);
  assert.equal((await f.studio.candidates.promote({id: candidate.id, context: null})).skill.version, 2);
  const route = routeSkills({prompt: 'evidence-summary', localSkills: f.studio.enabled(null), graphData: {nodes: [], edges: []}});
  assert.equal(route.candidates[0].version, 2); assert.equal(f.studio.get(f.baseline.id, null).history.length, 2);
});

test('no gain, regression, manual-only checks, truncation and changed model cannot become improvement', async t => {
  for (const [mode, verdict] of [['tie', 'no_gain'], ['regression', 'failed'], ['truncated', 'unknown'], ['model-change', 'unknown']]) {
    const f = await fixture(t), candidate = f.save();
    const result = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model(mode)});
    assert.equal(result.trials[0].verdict, verdict, mode);
    await assert.rejects(f.studio.candidates.promote({id: candidate.id, context: null, confirmed: true, trialId: result.trials[0].id}), /没有可发布/);
  }
  const f = await fixture(t);
  const candidate = f.save({draft: {...draft, instructions: '新方法', tests: [{...tests[0], prompt: '另一个独立案例', expectations: ['按科学合理性判断']}]}});
  const result = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model()});
  assert.equal(result.trials[0].verdict, 'unknown');
});

test('interrupted trials keep partial pairs, latest failed trial blocks old success, and stale baseline cannot be promoted', async t => {
  const f = await fixture(t), candidate = f.save();
  const success = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model()});
  await assert.rejects(f.studio.candidates.evaluate({id: candidate.id, context: null, model: model('throws', [])}), /未收到可用/);
  const failed = f.studio.candidates.get(candidate.id, null);
  assert.equal(failed.trials[0].status, 'interrupted'); assert.equal(failed.trials[0].pairs.length, 1);
  await assert.rejects(f.studio.candidates.promote({id: candidate.id, context: null, confirmed: true, trialId: success.trials[0].id}), /没有可发布/);
  const retry = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model()});
  f.studio.publish({taskId: null, skillId: f.baseline.id, baseVersion: 1, draft: {...draft, description: '用户另行修订'}});
  await assert.rejects(f.studio.candidates.promote({id: candidate.id, context: null, confirmed: true, trialId: retry.trials[0].id}), /正式技能已变化/);
});

test('source conversations are evidence rather than holdouts, remain linked across revisions, and promotion preserves source', async t => {
  const f = await fixture(t), task = f.store.createTask();
  const run = f.store.begin(task.id, 'source', tests[0].prompt, {mode: 'api', model: 'fixture'});
  f.store.finish(run.id, 'completed', '原回复');
  assert.throws(() => f.save({taskId: task.id, sourceRunId: run.id}), /来源对话/);
  const candidate = f.save({taskId: task.id, sourceRunId: run.id, draft: {...draft, instructions: '新方法', tests: tests.map((test, i) => ({...test, prompt: test.prompt + ' 变体' + i}))}});
  const revision = f.save({draft: {...candidate.draft, instructions: '新方法，保留缺失'}, parentCandidateId: candidate.id});
  assert.equal(revision.sourceRunId, run.id); assert.equal(revision.parentCandidateId, candidate.id);
  const result = await f.studio.candidates.evaluate({id: candidate.id, context: null, model: model()});
  const published = await f.studio.candidates.promote({id: candidate.id, context: null, confirmed: true, trialId: result.trials[0].id});
  assert.equal(published.skill.sourceRunId, run.id);
});

test('candidate HTTP routes persist drafts, enforce scope and refuse submitted fake scores', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sih-candidate-http-'));
  const app = await createApp({state: join(root, 'state'), userSkillsPath: join(root, 'skills')});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {await app.close(); await rm(root, {recursive: true, force: true});});
  const api = async (path, body) => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + path, {method: body ? 'POST' : 'GET',
      headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const saved = await api('/api/skill-studio/candidates', {draft, baseVersion: 0, targetScope: 'global', verdict: 'improved', trials: [{verdict: 'improved'}]});
  assert.equal(saved.status, 201); assert.deepEqual(saved.data.trials, []);
  assert.equal((await api('/api/skill-studio')).data.skills.length, 0);
  const detail = await api('/api/skill-studio/candidates/' + saved.data.id);
  assert.equal(detail.data.sha256, saved.data.sha256);
  assert.equal((await api('/api/skill-studio/candidates')).data.candidates[0].verdict, 'pending');
  const publish = await api('/api/skill-studio/candidates/' + saved.data.id + '/promote', {confirmed: true, trialId: '00000000-0000-4000-8000-000000000000'});
  assert.equal(publish.status, 409); assert.equal((await api('/api/skill-studio')).data.skills.length, 0);
});
