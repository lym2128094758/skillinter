import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './src/store.mjs';
import { createSkillStudio } from './src/skill-studio.mjs';
import { skillMarkdown } from './src/skill-files.mjs';

test('skills live on disk, migrate without changing IDs, reload edits, and retain revision conflicts and history', () => {
  const root = mkdtempSync(join(tmpdir(), 'sih-skill-files-'));
  const store = new Store(join(root, 'tasks.sqlite'));
  const userSkillsPath = join(root, 'user-skills');
  const studio = createSkillStudio(store, {userSkillsPath});
  const draft = {name: 'legacy-review', description: 'Review evidence', instructions: 'Use original sources.', tests: []};
  try {
    const id = randomUUID();
    store.query('INSERT INTO studio_skills (id, project_id, active_version) VALUES (?, NULL, 1)', 'run', id);
    store.query('INSERT INTO studio_skill_versions VALUES (?, 1, ?, NULL, ?)', 'run', id, JSON.stringify(draft), new Date().toISOString());
    const [migrated] = studio.list(null);
    assert.equal(migrated.id, id);
    assert.equal(migrated.version, 1);
    assert.equal(readFileSync(migrated.storagePath, 'utf8'), skillMarkdown(draft));
    assert.equal(studio.list(null)[0].version, 1);

    writeFileSync(migrated.storagePath, skillMarkdown({...draft, instructions: 'Require a clickable source.'}));
    const edited = studio.resolve(null, id);
    assert.equal(edited.instructions, 'Require a clickable source.');
    assert.equal(edited.version, 2);
    assert.throws(() => studio.publish({baseVersion: 1, skillId: id, draft}), /版本已更新/);
    const third = studio.publish({baseVersion: 2, skillId: id, draft: {...draft, instructions: 'Add the source and date.'}});
    assert.equal(readFileSync(third.storagePath, 'utf8'), skillMarkdown({...draft, instructions: 'Add the source and date.'}));
    assert.deepEqual(studio.get(id, null).history.map(item => item.version), [3, 2, 1]);

    writeFileSync(third.storagePath, '# Invalid edited skill');
    assert.deepEqual(studio.list(null), []);
    assert.ok(studio.issues()[0].message.includes('SKILL.md'));
    writeFileSync(third.storagePath, skillMarkdown(draft));
    assert.equal(studio.list(null)[0].version, 4);

    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    const project = store.addProject(projectPath, 'project');
    const task = store.createTask(project.id);
    const projectRoot = studio.locations(task.id).project;
    cpSync(dirname(third.storagePath), join(projectRoot, 'copied-review'), {recursive: true});
    const list = studio.enabled(task.id);
    assert.equal(list.length, 2);
    const projectSkill = list.find(item => item.projectId === project.id);
    assert.equal(projectSkill.instructions, draft.instructions);
    assert.notEqual(projectSkill.id, id);
    assert.equal(studio.resolve(null, projectSkill.id), null);

    const secondStore = new Store(join(root, 'fresh.sqlite'));
    try {
      const fresh = createSkillStudio(secondStore, {userSkillsPath});
      assert.equal(fresh.list(null)[0].instructions, draft.instructions);
    } finally { secondStore.db.close(); }
    rmSync(third.storagePath);
    assert.deepEqual(studio.list(null), []);
    assert.equal(studio.resolve(null, id), null);
  } finally {
    store.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
