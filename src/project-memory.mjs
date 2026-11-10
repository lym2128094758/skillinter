import {createHash, randomUUID} from 'node:crypto';
import {projectRelativePath} from './file-scope.mjs';
import {object, validate} from './schema.mjs';
import {RequestError} from './store.mjs';
import {preflightSnapshot} from './tools.mjs';

const text = maxLength => ({type: 'string', minLength: 1, maxLength});
const revision = {type: 'integer', minimum: 1};
const definition = object({kind: {enum: ['preference', 'fact']}, title: text(100), text: text(1200),
  triggers: {type: 'array', items: text(60), minItems: 1, maxItems: 8}, sourcePath: {type: 'string', maxLength: 300},
  confirmed: {enum: [true]}});
const editDefinition = object({...definition.properties, revision});
const toggleDefinition = object({enabled: {type: 'boolean'}, revision});
const normalize = value => value.normalize('NFKC').trim().toLowerCase();
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const display = row => ({id: row.id, revision: row.revision, enabled: Boolean(row.enabled), updatedAt: row.updated_at,
  confirmed: true, ...JSON.parse(row.document)});

export function createProjectMemory(store, state) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS project_memories (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, document TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS project_memory_scope ON project_memories(project_id, updated_at);`);
  const rows = projectId => store.query(
    'SELECT * FROM project_memories WHERE project_id=? ORDER BY updated_at DESC,id', 'all', projectId);
  function get(projectId, id) {
    const row = store.query('SELECT * FROM project_memories WHERE project_id=? AND id=?', 'get', projectId, id);
    if (!row) throw new RequestError(404, '该项目没有这条记忆。');
    return display(row);
  }
  function checkRevision(result) {
    if (!result.changes) throw new RequestError(409, '记忆已被修改或删除，请刷新后重试。');
  }
  const scopeFor = projectId => ({mode: 'project_read', projectPath: store.project(projectId).path, state});
  async function checkSource(scope, path, signal) {
    const {bytes, error} = await preflightSnapshot(scope, path, signal);
    return bytes ? {ok: true, sha256: fingerprint(bytes)} : {ok: false, code: error.code};
  }

  return {
    list(projectId) { store.project(projectId); return rows(projectId).map(display); },
    async save(projectId, id, body, signal) {
      const scope = scopeFor(projectId);
      if (validate(id ? editDefinition : definition, body).length) throw new RequestError(422, '请填写记忆内容、触发词并确认保存。');
      const title = body.title.trim(), content = body.text.trim();
      const triggers = [...new Set(body.triggers.map(normalize))];
      const sourcePath = body.sourcePath.trim();
      if (!title || !content || triggers.some(trigger => !trigger) ||
          (body.kind === 'fact' ? !projectRelativePath(sourcePath) : Boolean(sourcePath))) {
        throw new RequestError(422, '项目事实需要有效的项目相对文件路径，用户偏好只记录人工确认。');
      }
      if (/sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [^-]+PRIVATE KEY-----/i.test(title + '\n' + content)) {
        throw new RequestError(422, '记忆内容含疑似凭据，请移除后重试。');
      }
      if (id && get(projectId, id).revision !== body.revision) throw new RequestError(409, '记忆已被修改，请刷新。');
      const source = sourcePath ? await checkSource(scope, sourcePath, signal) : null;
      signal.throwIfAborted();
      if (source && !source.ok) throw new RequestError(422, '无法读取记忆来源文件（' + source.code + '）。');
      const document = JSON.stringify({kind: body.kind, title, text: content, triggers,
        source: source ? {kind: 'file', path: sourcePath, sha256: source.sha256} : {kind: 'user-confirmed'}});
      const updatedAt = new Date().toISOString();
      return store.transaction(() => {
        if (id) {
          checkRevision(store.query('UPDATE project_memories SET document=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?',
            'run', document, updatedAt, id, projectId, body.revision));
        } else {
          if (rows(projectId).length >= 100) throw new RequestError(409, '每个项目最多保存 100 条记忆。');
          id = randomUUID();
          store.query('INSERT INTO project_memories VALUES(?,?,1,1,?,?)', 'run', id, projectId, updatedAt, document);
        }
        return get(projectId, id);
      });
    },
    toggle(projectId, id, body) {
      if (validate(toggleDefinition, body).length) throw new RequestError(422, '记忆状态或版本无效。');
      get(projectId, id);
      checkRevision(store.query('UPDATE project_memories SET enabled=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?',
        'run', Number(body.enabled), new Date().toISOString(), id, projectId, body.revision));
      return get(projectId, id);
    },
    remove(projectId, id, body) {
      if (validate(object({revision}), body).length) throw new RequestError(422, '记忆版本无效。');
      get(projectId, id);
      checkRevision(store.query('DELETE FROM project_memories WHERE id=? AND project_id=? AND revision=?', 'run', id, projectId, body.revision));
      return {removed: true};
    },
    async verify(projectId, id, signal) {
      const memory = get(projectId, id);
      if (memory.source.kind !== 'file') return {status: 'user-confirmed', revision: memory.revision};
      const source = await checkSource(scopeFor(projectId), memory.source.path, signal);
      return {status: !source.ok ? 'unavailable' : source.sha256 === memory.source.sha256 ? 'current' : 'changed',
        revision: memory.revision, ...(source.ok ? {sha256: source.sha256} : {code: source.code})};
    },
    async select({scope, goal, budget, record}) {
      const query = normalize(goal);
      const candidates = rows(scope.projectId).filter(row => row.enabled).map(display)
        .map(memory => ({memory, score: memory.triggers.filter(trigger => query.includes(trigger)).length}))
        .filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 4);
      const used = [];
      const notices = [];
      for (const {memory} of candidates) {
        let status = 'used';
        if (memory.source.kind === 'file') {
          const readScope = {...scope, mode: 'project_read'};
          try {
            const result = await budget.tool('project-memory', 'check_source', signal => checkSource(readScope, memory.source.path, signal));
            if (!result.ok) status = 'unavailable';
            else if (result.sha256 !== memory.source.sha256) status = 'changed';
          } catch (error) {
            budget.signal.throwIfAborted();
            if (error.code !== 'BUDGET_EXHAUSTED') throw error;
            status = 'budget';
          }
        }
        record('project_memory_used', {id: memory.id, revision: memory.revision, projectId: scope.projectId, title: memory.title, status, source: memory.source});
        if (status === 'used') used.push({id: memory.id, revision: memory.revision, kind: memory.kind, title: memory.title, text: memory.text, source: memory.source});
        else notices.push({id: memory.id, title: memory.title, status});
      }
      return {used, notices};
    },
  };
}
