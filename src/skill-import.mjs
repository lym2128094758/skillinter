import { RequestError } from './store.mjs';
import { projectDirectory } from './file-scope.mjs';
import { executeTool, preflightSnapshot } from './tools.mjs';
import { cleanDraft } from './skill-studio.mjs';
import { SKILL_MAX_BYTES } from './skill-files.mjs';

export async function readSkillDirectory(path, state, signal) {
  let root;
  try { root = await projectDirectory(path, state); }
  catch { throw new RequestError(422, '请选择可读取的本机绝对目录，链接目录和私有状态目录不能导入。'); }
  const scope = {mode: 'project_read', projectPath: root, state};
  const listing = await executeTool({function: {name: 'list_workspace', arguments: JSON.stringify({
    path: '.', recursive: true, max_depth: 2, limit: 200, extensions: ['md'],
  })}}, root, signal, scope);
  if (!listing.ok) throw new RequestError(422, listing.error.message);
  const paths = listing.data.entries.filter(entry => entry.type === 'file' &&
    (/^[^/]+\.md$/i.test(entry.path) || /^[^/]+\/SKILL\.md$/i.test(entry.path))).map(entry => entry.path);
  const candidates = [];
  for (const path of paths.slice(0, 20)) {
    signal.throwIfAborted();
    const {bytes, error} = await preflightSnapshot(scope, path, signal);
    if (error) { candidates.push({path, error: error.message}); continue; }
    try {
      const content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      candidates.push({path, draft: cleanDraft(parseSkillFile(path, content))});
    } catch (error) {
      candidates.push({path, error: error instanceof RequestError ? error.message : '文件不是有效 UTF-8 文本。'});
    }
  }
  return {candidates, truncated: listing.data.truncated || paths.length > 20};
}

export function parseSkillFile(name, content) {
  if (typeof name !== 'string' || typeof content !== 'string' || Buffer.byteLength(content) > SKILL_MAX_BYTES) {
    throw new RequestError(422, '技能文件不能超过 256 KB。');
  }
  if (/\.json$/i.test(name)) {
    let value;
    try { value = JSON.parse(content); }
    catch { throw new RequestError(422, '技能 JSON 格式无效。'); }
    if (!value || typeof value !== 'object') throw new RequestError(422, '技能 JSON 必须为对象。');
    return {name: value.name, description: value.description, instructions: value.instructions, tests: value.tests ?? [],
      ...(value.applicability === undefined ? {} : {applicability: value.applicability}), ...(value.delivery === undefined ? {} : {delivery: value.delivery})};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(content.replace(/^\uFEFF/, ''));
  if (!match) throw new RequestError(422, 'SKILL.md 需要包含 name、description 的 YAML 头部和 Markdown 正文。');
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const pair = /^(name|description|sih_applicability|sih_delivery):[ \t]*(.*)$/.exec(lines[i]);
    if (!pair) continue;
    if (Object.hasOwn(fields, pair[1])) throw new RequestError(422, '技能头部字段重复。');
    let value = pair[2].trim();
    if (['sih_applicability', 'sih_delivery'].includes(pair[1])) {
      try { fields[pair[1]] = JSON.parse(value); }
      catch { throw new RequestError(422, '技能适用条件 JSON 格式无效。'); }
      continue;
    }
    if (/^[|>][-+]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value[0] === '>' ? ' ' : '\n').trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new RequestError(422, '技能头部引号格式无效。'); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    if (typeof value !== 'string' || !value.trim() || /^[&*!{\[]/.test(value)) {
      throw new RequestError(422, 'name 和 description 请使用普通文本。');
    }
    fields[pair[1]] = value;
  }
  if (!fields.name || !fields.description) throw new RequestError(422, '技能缺少 name 或 description。');
  const {sih_applicability, sih_delivery, ...identity} = fields;
  return {...identity, instructions: match[2].trim(), tests: [],
    ...(sih_applicability === undefined ? {} : {applicability: sih_applicability}), ...(sih_delivery === undefined ? {} : {delivery: sih_delivery})};
}
