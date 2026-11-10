import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { RequestError } from './store.mjs';
import { sameEntry, samePath } from './file-scope.mjs';

export const skillDigest = text => createHash('sha256').update(text).digest('hex');
export const SKILL_MAX_BYTES = 256_000;
export const skillMarkdown = draft => '---\nname: ' + JSON.stringify(draft.name) +
  '\ndescription: ' + JSON.stringify(draft.description) +
  (draft.applicability ? '\nsih_applicability: ' + JSON.stringify(draft.applicability) : '') +
  (draft.delivery ? '\nsih_delivery: ' + JSON.stringify(draft.delivery) : '') + '\n---\n\n' + draft.instructions + '\n';

function noLinks(target) {
  let current = parse(target).root;
  let stat = lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error('链接路径不能作为技能存储位置。');
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('链接路径不能作为技能存储位置。');
  }
  return stat;
}

function checkPath(path) {
  const target = resolve(path);
  const stat = noLinks(target);
  const physical = realpathSync(target);
  if (!samePath(target, physical) && (process.platform !== 'win32' ||
      !sameEntry(stat, noLinks(physical)) || !sameEntry(stat, noLinks(target)))) throw new Error('技能路径发生变化。');
}

export function createSkillFiles({userSkillsPath = join(homedir(), '.sih', 'skills')} = {}) {
  const roots = projectPath => ({global: resolve(userSkillsPath), project: projectPath ? join(projectPath, '.sih', 'skills') : null});
  function prepare(root) {
    const pending = [];
    let parent = root;
    while (!existsSync(parent)) { pending.push(parent); parent = dirname(parent); }
    checkPath(parent);
    for (const directory of pending.reverse()) {
      try { mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      checkPath(directory);
    }
    checkPath(root);
  }
  function read(path) {
    checkPath(path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > SKILL_MAX_BYTES) throw new Error('技能文件必须为不超过 256 KB 的普通文件。');
      const bytes = Buffer.alloc(SKILL_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      checkPath(path);
      const latest = lstatSync(path);
      if (length > SKILL_MAX_BYTES || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || after.ino !== latest.ino || after.mtimeMs !== latest.mtimeMs) throw new Error('技能文件在读取时发生变化。');
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length));
    } finally { closeSync(fd); }
  }
  function write(path, text, expectedHash = null) {
    prepare(dirname(path));
    if (existsSync(path)) {
      if (expectedHash === null || skillDigest(read(path)) !== expectedHash) throw new RequestError(409, '技能文件已被修改，请刷新技能列表后重试。');
    } else if (expectedHash !== null) throw new RequestError(409, '技能文件已被移除，请刷新技能列表。');
    const temp = join(dirname(path), '.sih-' + randomUUID() + '.tmp');
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      checkPath(dirname(path));
      if (existsSync(path) && (expectedHash === null || skillDigest(read(path)) !== expectedHash)) {
        throw new RequestError(409, '技能文件已被修改，请刷新技能列表后重试。');
      }
      renameSync(temp, path);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  function list(root) {
    if (!existsSync(root)) return {files: [], issues: []};
    checkPath(root);
    const entries = readdirSync(root, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const files = [], issues = [];
    for (const entry of entries.slice(0, 5000)) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) { issues.push({path: join(root, entry.name), message: '已跳过链接。'}); continue; }
      const path = entry.isDirectory() ? join(root, entry.name, 'SKILL.md') : /\.md$/i.test(entry.name) ? join(root, entry.name) : null;
      if (path && existsSync(path)) files.push(path);
    }
    if (entries.length > 5000) issues.push({path: root, message: '目录超过 5000 项，结果不完整。'});
    return {files, issues};
  }
  function destination(root, name, id) {
    const slug = name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
    const safe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(slug) ? 'skill-' + slug : slug;
    const first = join(root, safe, 'SKILL.md');
    return existsSync(dirname(first)) ? join(root, safe + '-' + id.slice(0, 8), 'SKILL.md') : first;
  }
  function importPackage(root, name, entries) {
    prepare(root);
    const id = randomUUID();
    const slug = name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 48) || 'skill';
    const target = join(root, 'import-' + slug + '-' + id.slice(0, 8));
    const stage = join(root, '.incoming-' + id);
    mkdirSync(stage);
    try {
      for (const {path, bytes} of entries) {
        if (!path || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[ .]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
          throw new RequestError(422, '技能包包含无效文件路径。');
        }
        const file = join(stage, path);
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(file, bytes, {flag: 'wx', mode: 0o600});
      }
      if (!existsSync(join(stage, 'SKILL.md'))) throw new RequestError(422, '技能包缺少 SKILL.md。');
      checkPath(root);
      if (existsSync(target)) throw new RequestError(409, '导入目标已存在，请重新扫描。');
      renameSync(stage, target);
      return join(target, 'SKILL.md');
    } finally {
      // Only this randomly named staging directory is ever removed.
      if (existsSync(stage)) rmSync(stage, {recursive: true, force: true});
    }
  }
  prepare(resolve(userSkillsPath));
  return {roots, read, write, list, destination, importPackage};
}
