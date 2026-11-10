import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { createApp } from './src/server.mjs';
import { skillMarkdown } from './src/skill-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sih-libraries-'));
  const home = join(root, 'home'), userSkillsPath = join(root, 'sih-skills'), projectPath = join(root, 'project');
  await mkdir(home); await mkdir(projectPath);
  const app = await createApp({state: join(root, 'state'), userSkillsPath, skillLibraryHome: home});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, body, status = 200) {
    const response = await fetch(base + path, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function skill(path, name, instructions = 'Do ' + name) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, skillMarkdown({name, description: 'Use ' + name, instructions}));
    return path;
  }
  return {root, home, userSkillsPath, projectPath, call, skill};
}

test('discover agent and plugin libraries, compare visible scopes, import missing bundles once without overwrites', async t => {
  const {home, projectPath, call, skill} = await fixture(t);
  const endpoint = '/api/skill-studio';
  const existing = {name: 'existing', description: 'Already installed', instructions: 'Keep existing instructions.', tests: []};
  const saved = await call(endpoint + '/publish', {targetScope: 'global', baseVersion: 0, draft: existing}, 201);
  const codex = join(home, '.codex', 'skills');
  await skill(join(codex, 'same', 'SKILL.md'), 'existing', existing.instructions);
  await skill(join(codex, 'conflict', 'SKILL.md'), 'existing', 'Different instructions.');
  await skill(join(codex, 'renamed', 'SKILL.md'), 'another-name', existing.instructions);
  const source = await skill(join(codex, '.system', 'new-package', 'SKILL.md'), 'new-package');
  await skill(join(dirname(source), 'skills', 'nested-skill', 'SKILL.md'), 'nested-skill');
  await mkdir(join(dirname(source), 'scripts'));
  await writeFile(join(dirname(source), 'scripts', 'do.mjs'), 'throw new Error("must not execute");');
  await mkdir(join(dirname(source), 'assets'));
  await writeFile(join(dirname(source), 'assets', 'pixel.bin'), Buffer.from([0, 255, 123]));
  await writeFile(join(dirname(source), 'LICENSE'), 'Keep upstream attribution.');
  await writeFile(join(dirname(source), '.env'), 'DO_NOT_COPY=private');
  const plugin = await skill(join(home, '.claude', 'plugins', 'cache', 'market', 'plugin', '1', 'skills', 'nested', 'SKILL.md'), 'plugin-skill', 'Long valid guidance.\n'.repeat(4000));
  // Identical packages across agents are imported only once.
  await skill(join(home, '.agents', 'skills', 'duplicate', 'SKILL.md'), 'new-package');
  const {id: projectId} = await call('/api/projects', {path: projectPath}, 201);
  await skill(join(projectPath, '.claude', 'skills', 'local', 'SKILL.md'), 'project-only');
  const sources = await call(endpoint + '/libraries?project=' + projectId);
  assert.ok(sources.sources.some(item => item.agent === 'Codex'));
  assert.ok(sources.sources.some(item => item.agent === 'Claude 插件'));
  assert.ok(sources.sources.some(item => item.scope === '项目'));
  const paths = [codex, dirname(dirname(plugin)), join(home, '.agents', 'skills')];
  const scan = await call(endpoint + '/scan-libraries', {paths, targetScope: 'global'});
  assert.deepEqual(scan.summary, {missing: 3, exists: 3, conflict: 1, invalid: 0});
  const ids = scan.candidates.filter(item => item.status === 'missing').map(item => item.id);
  await call(endpoint + '/import-missing', {token: scan.token, ids: [scan.candidates.find(item => item.status === 'conflict').id]}, 422);
  const imported = await call(endpoint + '/import-missing', {token: scan.token, ids});
  assert.equal(imported.imported, 3); assert.equal(imported.failed, 0);
  const dest = imported.results.find(item => item.name === 'new-package').path;
  assert.equal(await readFile(dest, 'utf8'), await readFile(source, 'utf8'));
  assert.equal(await readFile(join(dirname(dest), 'LICENSE'), 'utf8'), 'Keep upstream attribution.');
  assert.deepEqual(await readFile(join(dirname(dest), 'assets', 'pixel.bin')), Buffer.from([0, 255, 123]));
  assert.equal(await readFile(join(dirname(dest), 'scripts', 'do.mjs'), 'utf8'), 'throw new Error("must not execute");');
  await assert.rejects(readFile(join(dirname(dest), '.env')), {code: 'ENOENT'});
  const retry = await call(endpoint + '/import-missing', {token: scan.token, ids});
  assert.equal(retry.imported, 0); assert.equal(retry.skipped, 3);
  assert.equal((await call(endpoint + '/' + saved.skill.id)).skill.instructions, existing.instructions);
  const rescan = await call(endpoint + '/scan-libraries', {paths});
  assert.equal(rescan.summary.missing, 0);
  // A global skill also prevents unnecessary duplicates in a project import.
  const projectScan = await call(endpoint + '/scan-libraries', {projectId, targetScope: 'project', paths: [codex]});
  assert.equal(projectScan.summary.missing, 0);
  await call(endpoint + '/import-missing', {projectId, token: scan.token, ids}, 409);
});

test('stale, invalid, linked and excessive packages stay unimported; project target does not leak to global scope', async t => {
  const {root, home, projectPath, call, skill} = await fixture(t);
  const endpoint = '/api/skill-studio';
  const library = join(home, '.codex', 'skills');
  const changed = await skill(join(library, 'changed', 'SKILL.md'), 'changed');
  const linked = await skill(join(library, 'linked', 'SKILL.md'), 'linked');
  const large = await skill(join(library, 'large', 'SKILL.md'), 'large');
  await writeFile(join(dirname(large), 'huge.bin'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await mkdir(join(library, 'invalid'));
  await writeFile(join(library, 'invalid', 'SKILL.md'), 'not a skill');
  await symlink(projectPath, join(dirname(linked), 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await call(endpoint + '/scan-libraries', {paths: [library]});
  assert.equal(snapshot.summary.invalid, 1);
  await writeFile(changed, skillMarkdown({name: 'changed', description: 'modified', instructions: 'Changed since scan'}));
  const result = await call(endpoint + '/import-missing', {token: snapshot.token, ids: snapshot.candidates.filter(item => item.status === 'missing').map(item => item.id)});
  assert.equal(result.imported, 0); assert.equal(result.failed, 3);
  assert.ok(result.results.some(item => /变化/.test(item.message)));
  assert.ok(result.results.some(item => /链接/.test(item.message)));
  assert.ok(result.results.some(item => /字节/.test(item.message)));
  const {id: projectId} = await call('/api/projects', {path: projectPath}, 201);
  const local = await skill(join(projectPath, '.agents', 'skills', 'local', 'SKILL.md'), 'local');
  const scan = await call(endpoint + '/scan-libraries', {projectId, targetScope: 'project', paths: [dirname(local)]});
  const imported = await call(endpoint + '/import-missing', {projectId, token: scan.token, ids: scan.candidates.map(item => item.id)});
  assert.equal(imported.imported, 1);
  assert.equal(dirname(dirname(imported.results[0].path)), join(await realpath(projectPath), '.sih', 'skills'));
  assert.equal((await call(endpoint)).skills.length, 0);
  assert.equal((await call(endpoint + '?project=' + projectId)).skills.length, 1);
  const globalScan = await call(endpoint + '/scan-libraries', {projectId, targetScope: 'global', paths: [dirname(local)]});
  assert.equal(globalScan.summary.missing, 1, 'A project-only skill does not block promotion to the global library');
  await call(endpoint + '/scan-libraries', {paths: [join(root, 'state')]}, 422);
  await call(endpoint + '/scan-libraries', {paths: [join(root, 'no-such-library')]}, 422);
  await call(endpoint + '/scan-libraries', {paths: [library], targetScope: 'project'}, 422);
});
