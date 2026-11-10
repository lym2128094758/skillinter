import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { imageMime } from './images.mjs';
import { executeTool, preflightSnapshot, fileErrors } from './tools.mjs';
import {config} from './config.mjs';
import { RequestError } from './store.mjs';

const maxFiles = 20;
const goals = {integrity: '文件完整性', structure: '数据结构', reproducibility: '复现准备'};
const steps = {
  inventory: {label: '确定检查范围', nodeId: 'gh-agentic-file-uploads-d4b2ee'},
  integrity: {label: '检查可读性和文件指纹', nodeId: 'data-cleaning'},
  structure: {label: '按格式验证结构', nodeId: 'gh-agentic-json-schema-manual-516983'},
  reproducibility: {label: '检查复现材料', nodeId: 'competition-reproducible-ml-pipeline'},
};
export const materialSkills = {
  integrity: {id: 'material-integrity', label: '材料完整性检查', nodeId: steps.integrity.nodeId, description: '核对可读性、空文件、重复内容和指纹。'},
  structure: {id: 'material-structure', label: '材料格式结构检查', nodeId: steps.structure.nodeId, description: '检查 JSON、JSON Lines、Notebook 语法或受支持的文件头。'},
  reproducibility: {id: 'material-reproduction-readiness', label: '复现材料准备检查', nodeId: steps.reproducibility.nodeId, description: '查找复现说明及依赖和环境声明，标出材料缺口。'},
};

export function explicitAttachmentCheck(prompt, context) {
  if (!Array.isArray(context.materials) ||
      !/^(?:请\s*|帮我\s*)?(?:检查|核对|复核|验证)[^。；\n]{0,24}附件/u.test(prompt) ||
      /(?:然后|接着|随后|再帮|再做|并(?:写|修|改|清洗|删除)|(?:项目|磁盘|目录)(?:文件|材料)|如果[^。；\n]*(?:没有|无)附件)/u.test(prompt)) return null;
  const matched = [
    ['integrity', /完整性|指纹|重复|空内容|空文件/u],
    ['structure', /格式|结构|JSON|Notebook|无效行/iu],
    ['reproducibility', /复现|环境声明|依赖声明/u],
  ].filter(([, pattern]) => pattern.test(prompt));
  if (matched.length !== 1) return null;
  const all = /(?:本|当前)会话附件|(?:全部|所有)附件/u.test(prompt) || context.materials.length === 2 && /[两二](?:个|份)附件/u.test(prompt);
  if (context.materials.length > 1 && !all && !context.selectedFile) return null;
  return {source: 'attachments', goal: matched[0][0], paths: [], ...(all ? {file_ids: []} : {})};
}

export function materialReply(data) {
  if (data.status === 'needs_input') return data.summary;
  const files = data.files.map(file => `- ${file.path} · ${file.scope}${file.sha256 ? ` · SHA-256 ${file.sha256}` : ''}`);
  const findings = data.findings.map(issue => `- ${[issue.path, issue.line && `第 ${issue.line} 行`, issue.message, issue.related].filter(Boolean).join(' · ')}`);
  const evidence = data.evidence.map(item => `- ${item.label} · ${item.paths.join('、') || '未找到'}`);
  return [data.summary, files.join('\n'), findings.join('\n'), evidence.join('\n'),
    data.moreFindings ? '更多发现见完整报告。' : '可下载预检报告核对详情。'].filter(Boolean).join('\n\n');
}

function materialFit(request, files, unavailable = '') {
  const readable = files.filter(file => file.sha256);
  const supported = readable.filter(file => file.structureSupported);
  let reason = '';
  if (request.goal === 'unspecified') reason = '需要明确目标：文件完整性、格式结构或复现准备。';
  else if (request.source === 'unspecified') reason = '需要明确要检查当前会话附件，还是已授权的项目。';
  else if (unavailable) reason = unavailable;
  else if (!readable.length) reason = '没有可读取的材料，请上传附件或指定可读取的项目文件。';
  else if (request.goal === 'structure' && !supported.length) reason = '当前材料没有匹配的结构检查器。可指定 JSON、JSON Lines、Notebook 或支持文件头检查的材料。';
  const selected = reason ? [] : [materialSkills[request.goal].id];
  return {goal: request.goal, source: request.source, status: reason ? 'needs_input' : 'selected', selected,
    summary: reason || `依据「${goals[request.goal]}」目标选择检查方法；已读取 ${readable.length} 份材料。`,
    files: files.map(({path, sha256, format, structureSupported, issues}) => sha256 ? {path, sha256, format, structureSupported} :
      {path, error: issues[0]?.code, message: issues[0]?.message})};
}

export function preflightInput(input) {
  if (!input || !['attachments', 'project'].includes(input.source) || !Object.hasOwn(goals, input.goal)) {
    throw new RequestError(422, '请选择检查来源和检查目标。');
  }
  const paths = input.paths ?? [];
  if (!Array.isArray(paths) || paths.length > maxFiles ||
    paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 500 || /[\x00-\x1f]/.test(path))) {
    throw new RequestError(422, '最多指定 20 个文件，每行填写一个项目相对路径。');
  }
  const normalized = [...new Set(paths.map(path => path.trim().replaceAll('\\', '/')))];
  if (normalized.some(path => path.startsWith('/') || path.includes(':') ||
    path.split('/').some(part => part === '..' || part.startsWith('.') && part !== '.'))) {
    throw new RequestError(422, '请输入项目内的普通相对路径。');
  }
  return {source: input.source, goal: input.goal, paths: input.source === 'project' ? normalized : []};
}

const codeOf = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedImage = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'};
const zipTypes = new Set(['.zip', '.xlsx', '.docx', '.pptx', '.npz']);

export function inspectMaterial(file, bytes) {
  const issues = [];
  const add = (code, message, line) => issues.push({code, message, ...(line === undefined ? {} : {line})});
  const ext = extname(file.path).toLowerCase();
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { /* The material can be binary. */ }
  if (text?.includes('\0')) text = undefined;
  const image = imageMime(bytes);
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
  const zip = ['504b0304', '504b0506', '504b0708'].includes(bytes.subarray(0, 4).toString('hex'));
  const format = ['.json', '.ipynb'].includes(ext) ? 'JSON' : ['.jsonl', '.ndjson'].includes(ext) ? 'JSON Lines' :
    image || (pdf ? 'PDF' : zip ? 'ZIP 容器' : text === undefined ? '未知二进制' : 'UTF-8 文本');
  const structureSupported = ['JSON', 'JSON Lines'].includes(format) || Boolean(image || pdf || zip || expectedImage[ext] || ext === '.pdf' || zipTypes.has(ext));
  return {...file, size: bytes.length, sha256: codeOf(bytes), format, issues, text, structureSupported, verify() {
    if (expectedImage[ext] && image !== expectedImage[ext] || ext === '.pdf' && !pdf || zipTypes.has(ext) && !zip) {
      add('SIGNATURE_MISMATCH', '文件头与扩展名不一致。');
      return '发现问题';
    }
    if (format === 'JSON' || format === 'JSON Lines') {
      if (text === undefined) {
        add('INVALID_ENCODING', '结构化文本无法按 UTF-8 读取。');
        return '发现问题';
      }
      if (format === 'JSON Lines') {
        const lines = text.split(/\r\n|\n|\r/);
        if (lines.at(-1) === '') lines.pop();
        for (const [index, line] of lines.entries()) {
          try { JSON.parse(line); } catch { add('INVALID_JSON_LINE', '此行不是合法 JSON。', index + 1); }
          if (issues.filter(issue => issue.code === 'INVALID_JSON_LINE').length === 10 && index + 1 < lines.length) {
            add('FINDINGS_TRUNCATED', '已记录前 10 个无效记录，其余行待检查。');
            break;
          }
        }
      } else {
        try {
          const document = JSON.parse(text);
          if (ext === '.ipynb' && (!Array.isArray(document?.cells) || !Number.isInteger(document?.nbformat))) {
            add('INVALID_NOTEBOOK', 'Notebook 缺少 cells 数组或 nbformat 版本。');
          }
        } catch { add('INVALID_JSON', '文件内容不是合法 JSON。'); }
      }
      return issues.length ? '发现问题' : ext === '.ipynb' ? '已检查 Notebook 基本结构' : '已验证 JSON 语法';
    }
    if (image || pdf || zip) return '已核对文件头，内部结构待核验';
    if (text === undefined) return '需要适用的格式解析器';
    return '已确认 UTF-8 文本可读，语义待核验';
  }};
}

function ignored(path) {
  return path.split('/').some(part => part.startsWith('.') || /^(node_modules|__pycache__|dist|build|venv)$/i.test(part));
}

export async function executePreflight({store, task, run, goal, request, scope, workspace, attachments, signal, inChat = false, budget}) {
  const emit = (type, payload) => store.record(run, type, payload);
  const operation = (name, call) => budget ? budget.tool('material-preflight', name, call, signal) : call();
  const projectScope = {...scope, mode: 'project_read'};
  const nodes = ['inventory', 'integrity', ...(request.goal === 'integrity' ? [] : ['structure']),
    ...(request.goal === 'reproducibility' ? ['reproducibility'] : [])].map(id => ({
    ...steps[id], id, step: id, version: 1, state: 'planned',
  }));
  const edges = nodes.slice(1).map((node, index) => ({from: nodes[index].id, to: node.id}));
  const complete = id => {
    nodes.find(node => node.id === id).state = 'succeeded';
    emit('preflight_step', {id, label: steps[id].label});
  };
  const plan = () => emit('preflight_plan', {nodes, edges, request});
  const decide = (files, unavailable) => {
    const decision = materialFit(request, files, unavailable);
    emit('capability_fit', decision);
    return decision;
  };
  const needsInput = decision => ({kind: 'material_preflight', status: 'needs_input', summary: decision.summary, selected: [], artifact: null,
    files: [], findings: [], evidence: [], moreFindings: false});
  if (!inChat) plan();
  try {
    signal.throwIfAborted();
    const sourceAvailable = request.source !== 'project' || Boolean(scope?.projectId && scope.projectPath && scope.mode !== 'attachments');
    if (inChat && (request.goal === 'unspecified' || request.source === 'unspecified' || !sourceAvailable)) {
      return needsInput(decide([], sourceAvailable ? '' : '项目检查需要绑定项目并开启项目读取权限。'));
    }
    const issues = [];
    let selected, truncated = false;
    if (request.source === 'attachments') {
      selected = attachments.map(file => ({id: file.id, path: file.relativePath ?? file.name}));
    } else if (request.paths.length) {
      selected = request.paths.map(path => ({path}));
    } else {
      const listing = await operation('list_workspace', () => executeTool({function: {name: 'list_workspace', arguments: JSON.stringify({
        recursive: true, max_depth: 2, limit: 200,
      })}}, workspace, signal, projectScope));
      signal.throwIfAborted();
      if (inChat && !listing.ok) return needsInput(decide([], listing.error.message));
      if (!listing.ok) throw new Error(listing.error.message);
      const candidates = listing.data.entries.filter(entry => ['file', 'symlink'].includes(entry.type) && !ignored(entry.path));
      truncated = listing.data.truncated || candidates.length > maxFiles;
      selected = candidates.slice(0, maxFiles).map(({path}) => ({path}));
    }
    if (!inChat) complete('inventory');
    const files = [];
    const seen = new Map();
    for (const item of selected) {
      signal.throwIfAborted();
      const {bytes, error} = await operation('read_material', () => {
        if (!item.id) return preflightSnapshot(projectScope, item.path, signal);
        const file = store.file(task, item.id);
        return file.size > config.tools.fileBytes ? {error:{code:'FILE_TOO_LARGE',message:fileErrors.FILE_TOO_LARGE}} : file;
      });
      signal.throwIfAborted();
      if (error) { files.push({...item, structure: '未检查', issues: [error]}); continue; }
      const file = inspectMaterial(item, Buffer.from(bytes));
      if (!bytes.length || file.text !== undefined && !file.text.trim()) {
        file.issues.push({code: 'EMPTY_CONTENT', message: '文件没有有效内容。'});
      }
      if (bytes.length && seen.has(file.sha256)) {
        const other = seen.get(file.sha256);
        file.issues.push({code: 'DUPLICATE_CONTENT', message: '与另一份材料内容逐字节相同。', related: other});
      } else if (bytes.length) seen.set(file.sha256, item.path);
      files.push(file);
    }
    const decision = inChat ? decide(files) : null;
    if (inChat) {
      if (decision.status !== 'selected') return needsInput(decision);
      plan();
      complete('inventory');
    }
    complete('integrity');
    for (const file of files) {
      if (!file.verify) continue;
      file.structure = request.goal === 'integrity' ? '未选择结构检查' : file.issues.some(issue => issue.code === 'EMPTY_CONTENT') ? '发现问题' : file.verify();
      delete file.text;
      delete file.verify;
      delete file.structureSupported;
    }
    if (request.goal !== 'integrity') complete('structure');
    const evidence = [];
    if (request.goal === 'reproducibility') {
      const readable = files.filter(file => file.sha256 && !file.issues.some(issue => issue.code === 'EMPTY_CONTENT'));
      const instructions = readable.filter(file => /(?:^|\/)(?:readme(?:\.[^/]+)?|instructions?\.md|reproduction\.md)$/i.test(file.path));
      const manifests = readable.filter(file => /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|environment\.ya?ml|package\.json|cargo\.toml|renv\.lock|dockerfile)$/i.test(file.path));
      evidence.push({label: '复现说明候选', paths: instructions.map(file => file.path)},
        {label: '依赖或环境声明候选', paths: manifests.map(file => file.path)});
      for (const item of evidence.filter(item => !item.paths.length)) {
        issues.push({code: 'EVIDENCE_NOT_FOUND', message: '已检查范围内未找到' + item.label + '。'});
      }
      complete('reproducibility');
    }
    if (!selected.length) issues.push({code: 'NO_INPUT', message: '本次没有找到可检查的材料。'});
    const trace = {graph: {attempt: 1, nodes, edges}};
    const report = {version: 1, goal, request, ...(decision ? {decision} : {}), coverage: {
      selected: selected.length, read: files.filter(file => file.sha256).length, truncated,
      scope: request.source === 'attachments' ? '当前会话附件' : request.paths.length ? '指定路径' : '项目目录两层，至多 20 份材料',
    }, files, issues, evidence, trace};
    const count = issues.length + files.reduce((n, file) => n + file.issues.length, 0);
    const answer = '材料预检完成。读取 ' + report.coverage.read + ' / ' + selected.length + ' 份材料，记录 ' + count + ' 项发现。' +
      (truncated ? ' 目录检查未覆盖全部材料，可指定路径继续。' : '');
    if (inChat) {
      signal.throwIfAborted();
      const file = store.transaction(() => store.savePreflight(task, run, report, trace));
      const findings = [...issues.map(issue => ({path: '', ...issue})), ...files.flatMap(item => item.issues.map(issue => ({path: item.path, ...issue})))];
      return {kind: 'material_preflight', status: 'completed', summary: answer, selected: decision.selected,
        artifact: {name: file.name, sha256: file.sha256, url: `/api/tasks/${task}/files/${file.id}`},
        files: files.map(item => ({path: item.path, sha256: item.sha256 ?? '', scope: item.structure})),
        findings: findings.slice(0, 20).map(({path, code, message, line, related}) => ({path, code, message, line: line ?? null, related: related ?? ''})),
        evidence, moreFindings: findings.length > 20};
    }
    budget?.finish();
    store.finishPreflight(task, run, report, trace, answer);
  } catch (error) {
    if (inChat) throw error;
    budget?.finish();
    if (budget?.deadline.aborted) store.finish(run, 'budget_exhausted', {error: '根任务时间预算已耗尽'});
    else store.finish(run, signal.aborted ? 'stopped' : 'failed', {error: signal.aborted ? null : error.message});
  }
}
