import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { createSettings } from '../src/settings.mjs';
import { config } from '../src/config.mjs';

export async function localModel(id, effort = 'default') {
  const project = fileURLToPath(new URL('..', import.meta.url));
  const filename = join(project, config.statePath, 'tasks.sqlite');
  const store = new Store(':memory:');
  try {
    if (existsSync(filename)) {
      const db = new DatabaseSync(filename, {readOnly: true});
      try {
        const saved = JSON.parse(db.prepare('SELECT value FROM preferences WHERE id = 1').get().value);
        store.savePreferences(0, saved);
      } finally { db.close(); }
    }
    const settings = await createSettings({store, env: process.env});
    const {model} = settings.snapshot({model: id, effort});
    if (!model) throw new Error('请先配置模型 API 或设置 SKILLINTER_MODEL_URL 和 SKILLINTER_MODEL。');
    return model;
  } finally { store.db.close(); }
}
