import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {object, string, validate} from './schema.mjs';
import {preflightSnapshot} from './tools.mjs';

const pathSchema = {...string, minLength: 1, maxLength: 300};
const checkSchema = object({kind: {enum: ['text_contains', 'text_excludes', 'json_equals', 'json_type', 'json_length']},
  pointer: {...string, maxLength: 300}, expected: {...string, maxLength: 4000}});
export const deliverySchema = object({version: {enum: [1]},
  preserve_inputs: {type: 'array', maxItems: 4, items: pathSchema},
  artifacts: {type: 'array', minItems: 1, maxItems: 4, items: object({path: pathSchema, format: {enum: ['text', 'json']},
    require_change: {type: 'boolean'}, checks: {type: 'array', minItems: 1, maxItems: 12, items: checkSchema}})},
});
export const deliveryResultSchema = object({status: {enum: ['passed', 'failed', 'unknown', 'unspecified']},
  contractSha256: string, verifierSha256: string, frozenBeforeExecution: {type: 'boolean'},
  files: {type: 'array', maxItems: 8, items: object({path: string, role: {enum: ['input', 'artifact']}, sha256: string, beforeSha256: string})},
  checks: {type: 'array', maxItems: 64, items: object({path: string, code: string,
    status: {enum: ['passed', 'failed', 'unknown']}, message: string})},
});
const hash = value => createHash('sha256').update(value).digest('hex');
const verifierSha256 = hash(['skill-delivery.mjs', 'tools.mjs', 'file-scope.mjs', 'schema.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\0'));
deliveryResultSchema.properties.operationReceipts = {type: 'array', maxItems: 20, items: {type: 'integer', minimum: 1}};
const parseJson = text => JSON.parse(text, (_, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Non-finite JSON number'); return value; });
const safePath = path => !/^[\\/]|[:\x00-\x1f]/.test(path) && path.split(/[\\/]/).every(part => part && !part.startsWith('.'));
const pointerParts = pointer => pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
export function validDelivery(contract) {
  if (!contract) return true;
  if (validate(deliverySchema, contract).length) return false;
  if (JSON.stringify(contract).length > 24000) return false;
  const outputs = contract.artifacts.map(item => item.path.replaceAll('\\', '/').toLowerCase());
  const inputs = contract.preserve_inputs.map(path => path.replaceAll('\\', '/').toLowerCase());
  if ([...contract.preserve_inputs, ...contract.artifacts.map(item => item.path)].some(path => !safePath(path)) ||
    new Set(outputs).size !== outputs.length || new Set(inputs).size !== inputs.length || outputs.some(path => inputs.includes(path))) return false;
  return contract.artifacts.every(artifact => artifact.checks.every(check => {
    if (check.kind.startsWith('text_')) return check.pointer === '' && Boolean(check.expected);
    if (artifact.format !== 'json' || !/^(?:\/(?:[^~]|~[01])*)*$/.test(check.pointer)) return false;
    if (check.kind === 'json_type') return ['object', 'array', 'string', 'number', 'boolean', 'null'].includes(check.expected);
    if (check.kind === 'json_length') return /^\d{1,9}$/.test(check.expected);
    try { parseJson(check.expected); return true; } catch { return false; }
  }));
}
const result = frozen => ({status: frozen?.contract ? 'unknown' : 'unspecified', contractSha256: frozen?.sha256 ?? '',
  verifierSha256: frozen?.verifierSha256 ?? verifierSha256, frozenBeforeExecution: Boolean(frozen?.beforeExecution), files: [], checks: []});
export async function freezeDelivery({contract, scope, signal, beforeExecution = true}) {
  if (!contract) return {contract: null};
  if (!validDelivery(contract)) throw new Error('产物验收条件格式无效。');
  const frozen = {contract: structuredClone(contract), sha256: hash(JSON.stringify(contract)), verifierSha256, beforeExecution, before: {}};
  if (!scope?.projectId || !scope.projectPath || scope.mode === 'attachments') {frozen.unavailable = '需要绑定项目并授予读取权限。'; return frozen;}
  for (const path of [...contract.preserve_inputs, ...contract.artifacts.map(item => item.path)]) {
    const snapshot = await preflightSnapshot({...scope, mode: 'project_read'}, path, signal);
    frozen.before[path] = snapshot.error ? {error: snapshot.error} : {sha256: hash(snapshot.bytes)};
  }
  return frozen;
}
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
function lookup(value, pointer) {
  for (const part of pointerParts(pointer)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return {found: false};
    value = value[part];
  }
  return {found: true, value};
}
export async function verifyDelivery({frozen, scope, signal}) {
  const output = result(frozen);
  if (!frozen?.contract) return output;
  const add = (path, code, status, message) => output.checks.push({path, code, status, message: message.slice(0, 1000)});
  if (!frozen.beforeExecution || frozen.unavailable) {
    add('', 'CONTRACT_NOT_FROZEN', 'unknown', frozen.unavailable ?? '条件未在本轮任务操作前冻结，不能进行事后验收。'); return output;
  }
  for (const path of frozen.contract.preserve_inputs) {
    const before = frozen.before[path];
    const snapshot = await preflightSnapshot({...scope, mode: 'project_read'}, path, signal);
    if (before?.error || snapshot.error) {add(path, 'INPUT_UNVERIFIABLE', 'unknown', before?.error?.message ?? snapshot.error.message); continue;}
    const sha256 = hash(snapshot.bytes); output.files.push({path, role: 'input', sha256, beforeSha256: before.sha256});
    add(path, 'INPUT_UNCHANGED', sha256 === before.sha256 ? 'passed' : 'failed', sha256 === before.sha256 ? '原始输入字节保持一致。' : '原始输入已变化。');
  }
  for (const artifact of frozen.contract.artifacts) {
    const before = frozen.before[artifact.path];
    if (!before || before.error && before.error.code !== 'NOT_FOUND') {add(artifact.path, 'BEFORE_UNVERIFIABLE', 'unknown', before?.error?.message ?? '缺少执行前文件状态。'); continue;}
    const snapshot = await preflightSnapshot({...scope, mode: 'project_read'}, artifact.path, signal);
    if (snapshot.error) {add(artifact.path, snapshot.error.code, snapshot.error.code === 'NOT_FOUND' ? 'failed' : 'unknown', snapshot.error.message); continue;}
    const sha256 = hash(snapshot.bytes); output.files.push({path: artifact.path, role: 'artifact', sha256, beforeSha256: before.sha256 ?? ''});
    if (artifact.require_change) add(artifact.path, 'ARTIFACT_CHANGED', before.sha256 !== sha256 ? 'passed' : 'failed', before.sha256 !== sha256 ? '本轮产物字节与执行前不同。' : '产物与执行前相同，不能确认本轮交付。');
    let text, json;
    try {if (snapshot.bytes.includes(0)) throw Error(); text = new TextDecoder('utf-8', {fatal: true}).decode(snapshot.bytes);} catch {add(artifact.path, 'NOT_TEXT', 'failed', '产物不是有效 UTF-8 文本。'); continue;}
    if (artifact.format === 'json') try {json = parseJson(text.replace(/^\uFEFF/, ''));} catch {add(artifact.path, 'INVALID_JSON', 'failed', '产物不是有效 JSON 或包含超出有限数值范围的数字。'); continue;}
    add(artifact.path, 'FORMAT', 'passed', '产物通过声明的格式检查。');
    for (const check of artifact.checks) {
      if (check.kind.startsWith('text_')) {
        const found = text.includes(check.expected), ok = check.kind === 'text_contains' ? found : !found;
        add(artifact.path, check.kind.toUpperCase(), ok ? 'passed' : 'failed', (check.kind === 'text_contains' ? '应包含：' : '不应包含：') + check.expected); continue;
      }
      const entry = lookup(json, check.pointer);
      if (!entry.found) {add(artifact.path, 'JSON_POINTER', 'failed', '字段不存在：' + check.pointer); continue;}
      const type = entry.value === null ? 'null' : Array.isArray(entry.value) ? 'array' : typeof entry.value;
      const ok = check.kind === 'json_equals' ? canonical(entry.value) === canonical(parseJson(check.expected)) : check.kind === 'json_type' ? type === check.expected :
        ['string', 'array'].includes(type) && entry.value.length === Number(check.expected);
      add(artifact.path, check.kind.toUpperCase(), ok ? 'passed' : 'failed', (check.pointer || '/') + ' · ' + check.kind + ' · 预期 ' + check.expected);
    }
  }
  output.status = output.checks.some(check => check.status === 'failed') ? 'failed' : output.checks.some(check => check.status === 'unknown') ? 'unknown' : 'passed';
  return output;
}
