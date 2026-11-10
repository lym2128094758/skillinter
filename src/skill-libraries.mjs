import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RequestError } from './store.mjs';
import { projectDirectory, scopedPath } from './file-scope.mjs';
import { createSkillFiles, skillDigest, SKILL_MAX_BYTES } from './skill-files.mjs';
import { parseSkillFile } from './skill-import.mjs';
import { cleanDraft } from './skill-studio.mjs';

const layouts = [
  ['Codex', '.codex/skills'], ['Codex 插件', '.codex/plugins/cache'],
  ['Claude', '.claude/skills'], ['Claude 插件', '.claude/plugins/cache'],
  ['DSH', '.dsh/skills'], ['Agent Skills', '.agents/skills'],
  ['Cursor', '.cursor/skills'], ['GitHub Copilot', '.github/skills'],
  ['Gemini', '.gemini/skills'], ['CodeBuddy', '.codebuddy/skills'],
  ['Qwen', '.qwen/skills'], ['Trae', '.trae/skills'],
];
const excluded = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.skillinter']);
const unsafeResource = name => excluded.has(name) || /^\.env(?:\.|$)/i.test(name);
const key = text => text.normalize('NFKC').trim().toLowerCase();
const bodyHash = draft => skillDigest(draft.instructions.replace(/\r\n/g, '\n').trim());
const sorted = entries => entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function createSkillLibraries({studio, store, state, home = homedir()}) {
  const cache = new Map();
  const files = createSkillFiles({userSkillsPath: studio.locations(null).global});
  let importing = false;
  function contextKey(context) { return JSON.stringify(context); }
  function projectPath(context) {
    if (context && typeof context === 'object') return store.project(context.projectId).path;
    const id = context && store.task(context).project_id;
    return id ? store.project(id).path : null;
  }
  async function sources(context) {
    const result = [];
    for (const [scope, root] of [['用户', home], ['项目', projectPath(context)]]) {
      if (!root) continue;
      for (const [agent, path] of layouts) {
        const full = resolve(root, path);
        try {
          if ((await lstat(full)).isDirectory()) {
            await projectDirectory(full, state);
            result.push({agent, scope, path: full});
          }
        } catch { /* Missing or linked source roots are not discovery candidates. */ }
      }
    }
    return result;
  }
  async function scopeFor(path) {
    if (typeof path !== 'string' || !path.trim() || path.length > 1000) throw new RequestError(422, '请输入技能库的本机绝对路径。');
    try { return {mode: 'project_read', projectPath: await projectDirectory(path, state), state}; }
    catch { throw new RequestError(422, '技能库目录不可读取，或目录是链接、私有状态目录。'); }
  }
  async function read(scope, path, maxBytes = SKILL_MAX_BYTES) {
    const {target, stat} = await scopedPath(scope, path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`文件须为不超过 ${maxBytes} 字节的普通文件。`);
    const fd = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.nlink > 1 || before.size > maxBytes) throw new Error('文件类型、链接或大小不符合要求。');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const {bytesRead} = await fd.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await fd.stat();
      const current = await scopedPath(scope, path);
      if (length !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.ino !== current.stat.ino || after.mtimeMs !== current.stat.mtimeMs) throw new Error('文件在读取时发生变化，请重新扫描。');
      return buffer.subarray(0, length);
    } finally { await fd.close(); }
  }
  function classify(entries, existing) {
    const names = new Map(), hashes = new Map();
    for (const skill of existing) {
      names.set(key(skill.name), skill);
      hashes.set(bodyHash(skill), skill);
    }
    return entries.map(entry => {
      if (entry.error) return {...entry, status: 'invalid'};
      const same = names.get(key(entry.draft.name));
      const identical = hashes.get(bodyHash(entry.draft));
      let status = 'missing', reason = 'SIH 尚未收录';
      if (same) {
        status = bodyHash(same) === bodyHash(entry.draft) ? 'exists' : 'conflict';
        reason = status === 'exists' ? '已有同名且正文相同的技能' : '同名技能正文不同，保留现有版本';
      } else if (identical) { status = 'exists'; reason = '正文与已有技能「' + identical.name + '」相同'; }
      if (status === 'missing') {
        names.set(key(entry.draft.name), entry.draft);
        hashes.set(bodyHash(entry.draft), entry.draft);
      }
      return {...entry, status, reason};
    });
  }
  async function scan({context = null, paths, targetScope = 'global', signal}) {
    if (!['global', 'project'].includes(targetScope) || targetScope === 'project' && !projectPath(context)) throw new RequestError(422, '请选择有效的导入目标项目。');
    const discovered = await sources(context);
    if (paths === undefined) paths = discovered.map(item => item.path);
    if (!Array.isArray(paths) || paths.length > 32 || paths.some(path => typeof path !== 'string')) throw new RequestError(422, '一次最多扫描 32 个技能库目录。');
    const entries = [], issues = [], seen = new Set();
    let directories = 0, definitionBytes = 0, truncated = false;
    async function visit(scope, directory, agent, depth = 0) {
      signal?.throwIfAborted();
      if (depth > 10 || ++directories > 20000 || entries.length >= 5000) { truncated = true; return; }
      if (seen.has(directory.toLowerCase())) return;
      seen.add(directory.toLowerCase());
      await scopedPath(scope, directory);
      const children = sorted(await readdir(directory, {withFileTypes: true}));
      const skill = children.find(item => item.name.toLowerCase() === 'skill.md' && item.isFile());
      if (skill) {
        const path = join(directory, skill.name);
        try {
          const bytes = await read(scope, path);
          definitionBytes += bytes.length;
          if (definitionBytes > 64 * 1024 * 1024) { truncated = true; return; }
          const draft = cleanDraft(parseSkillFile(path, new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
          entries.push({id: randomUUID(), path, root: scope.projectPath, agent, draft, digest: skillDigest(bytes)});
        } catch (error) { entries.push({id: randomUUID(), path, agent, error: error.message}); }
        // Some libraries expose a parent entry and separate subskills under skills/.
        // Other resource/example SKILL.md files remain part of the parent package.
        const nested = children.find(item => item.name === 'skills' && item.isDirectory());
        if (nested) await visit(scope, join(directory, nested.name), agent, depth + 1);
        return;
      }
      for (const child of children) {
        if (child.isDirectory() && !unsafeResource(child.name)) {
          try { await visit(scope, join(directory, child.name), agent, depth + 1); }
          catch (error) { issues.push({path: join(directory, child.name), message: error.message}); }
        } else if (child.isSymbolicLink()) issues.push({path: join(directory, child.name), message: '已跳过链接目录或文件。'});
      }
    }
    for (const path of [...new Set(paths)]) {
      const scope = await scopeFor(path);
      const label = discovered.find(item => item.path.toLowerCase() === scope.projectPath.toLowerCase());
      await visit(scope, scope.projectPath, label ? label.agent + ' · ' + label.scope : '自选目录');
    }
    const available = studio.list(context).filter(item => targetScope === 'project' || !item.projectId);
    const candidates = classify(entries, available);
    const token = randomUUID();
    for (const [id, snapshot] of cache) if (snapshot.expires < Date.now()) cache.delete(id);
    while (cache.size >= 5) cache.delete(cache.keys().next().value);
    cache.set(token, {context: contextKey(context), targetScope, candidates, expires: Date.now() + 15 * 60000});
    return {token, targetScope, sources: discovered, truncated, issues, storageIssues: studio.issues(),
      summary: Object.fromEntries(['missing', 'exists', 'conflict', 'invalid'].map(status => [status, candidates.filter(item => item.status === status).length])),
      candidates: candidates.map(({draft, digest, root, ...item}) => ({...item, name: draft?.name ?? basename(dirname(item.path)), description: draft?.description ?? ''}))};
  }
  async function bundle(entry, signal) {
    const scope = await scopeFor(entry.root);
    const result = [];
    let total = 0, visited = 0;
    async function visit(directory, depth = 0) {
      signal?.throwIfAborted();
      if (depth > 12 || ++visited > 2000) throw new Error('技能包目录过多或过深，未导入。');
      await scopedPath(scope, directory);
      for (const item of sorted(await readdir(directory, {withFileTypes: true}))) {
        if (unsafeResource(item.name)) continue;
        const path = join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error('技能包包含链接，请移除链接后重新扫描。');
        if (item.isDirectory()) await visit(path, depth + 1);
        else if (item.isFile()) {
          const bytes = await read(scope, path, 32 * 1024 * 1024);
          total += bytes.length;
          if (result.length >= 2000 || total > 128 * 1024 * 1024) throw new Error('技能包超过 2000 个文件或 128 MB，未导入。');
          let name = relative(dirname(entry.path), path).replaceAll('\\', '/');
          if (path === entry.path) name = 'SKILL.md';
          result.push({path: name, bytes});
        }
      }
    }
    await visit(dirname(entry.path));
    const definition = result.find(item => item.path === 'SKILL.md');
    if (!definition || skillDigest(definition.bytes) !== entry.digest) throw new Error('技能自扫描后已变化，请重新扫描。');
    return result;
  }
  async function importMissing({context = null, token, ids, signal}) {
    const snapshot = cache.get(token);
    if (!snapshot || snapshot.expires < Date.now() || snapshot.context !== contextKey(context)) throw new RequestError(409, '扫描记录已过期或目标已变化，请重新扫描。');
    if (importing) throw new RequestError(409, '正在导入技能，请等待完成。');
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || new Set(ids).size !== ids.length || ids.some(id => !snapshot.candidates.some(item => item.id === id && item.status === 'missing'))) throw new RequestError(422, '只能选择本次扫描中尚未收录的技能。');
    const root = studio.locations(context)[snapshot.targetScope];
    if (!root) throw new RequestError(422, '请选择目标项目。');
    const results = [];
    importing = true;
    try {
      let existing = studio.list(context).filter(item => snapshot.targetScope === 'project' || !item.projectId);
      for (const entry of snapshot.candidates.filter(item => ids.includes(item.id))) {
        signal?.throwIfAborted();
        const current = classify([entry], existing)[0];
        if (current.status !== 'missing') { results.push({id: entry.id, name: entry.draft.name, status: 'skipped', message: current.reason}); continue; }
        try {
          const resources = await bundle(entry, signal);
          // Another request may publish a same-named skill while the package is being read.
          existing = studio.list(context, {refreshFiles: false}).filter(item => snapshot.targetScope === 'project' || !item.projectId);
          const rechecked = classify([entry], existing)[0];
          if (rechecked.status !== 'missing') { results.push({id: entry.id, name: entry.draft.name, status: 'skipped', message: rechecked.reason}); continue; }
          const path = files.importPackage(root, entry.draft.name, resources);
          existing.push(entry.draft);
          results.push({id: entry.id, name: entry.draft.name, status: 'imported', path, resourceFiles: resources.length});
        } catch (error) { results.push({id: entry.id, name: entry.draft.name, status: 'failed', message: error.message}); }
      }
      studio.list(context);
      return {results, imported: results.filter(item => item.status === 'imported').length,
        skipped: results.filter(item => item.status === 'skipped').length, failed: results.filter(item => item.status === 'failed').length};
    } finally { importing = false; }
  }
  return {sources, scan, importMissing};
}
