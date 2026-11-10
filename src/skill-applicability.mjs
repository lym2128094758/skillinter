import { createHash } from 'node:crypto';
import { inspectMaterial } from './preflight.mjs';
import { preflightSnapshot, fileErrors } from './tools.mjs';
import {config} from './config.mjs';
import { object, string } from './schema.mjs';

const phrases = {type: 'array', maxItems: 12, items: {...string, minLength: 1, maxLength: 200}};
export const applicabilitySchema = object({
  version: {enum: [1]}, goals: phrases, exclusions: phrases,
  input_formats: {type: 'array', maxItems: 8, items: {enum: ['text', 'json', 'jsonl', 'notebook', 'image', 'pdf', 'archive']}},
  project_files: {type: 'array', maxItems: 12, items: {...string, minLength: 1, maxLength: 300}},
  tools: {type: 'array', maxItems: 12, items: {...string, minLength: 1, maxLength: 100}},
});
export const applicabilityResultSchema = object({
  status: {enum: ['passed', 'failed', 'unknown', 'unspecified']},
  checks: {type: 'array', maxItems: 40, items: object({status: {enum: ['passed', 'failed', 'unknown']}, code: string, message: string})},
  inputs: {type: 'array', maxItems: 24, items: object({path: string, sha256: string, format: string, valid: {type: 'boolean'}})},
  policySha256: string, goalSha256: string,
});
const hash = value => createHash('sha256').update(value).digest('hex');
const normal = value => value.normalize('NFKC').toLowerCase();

export function goalApplicability(policy, goal) {
  const checks = [];
  if (!policy) return checks;
  const included = policy.goals.filter(phrase => normal(goal).includes(normal(phrase)));
  const excluded = policy.exclusions.filter(phrase => normal(goal).includes(normal(phrase)));
  if (policy.goals.length) checks.push({status: included.length ? 'passed' : 'unknown', code: 'GOAL_PHRASE', message: included.length
    ? '目标包含声明的适用片段：' + included.join('、') : '目标未匹配声明的适用片段，请明确是否需要：' + policy.goals.join('、')});
  if (policy.exclusions.length) checks.push({status: excluded.length ? 'failed' : 'passed', code: 'EXCLUDED_GOAL', message: excluded.length
    ? '目标包含声明的禁用片段：' + excluded.join('、') : '未匹配声明的禁用片段。'});
  return checks.map(check => ({...check, message: check.message.slice(0, 1000)}));
}

export function validApplicabilityPaths(policy) {
  return !policy || policy.project_files.every(path => !/^[\\/]|[:\x00-\x1f]/.test(path) &&
    path.split(/[\\/]/).every(part => part && part !== '..' && part !== '.' && !part.startsWith('.')));
}

export function materialObservation(path, bytes) {
  const file = inspectMaterial({path}, Buffer.from(bytes));
  file.verify();
  let format = 'binary';
  if (file.format === 'JSON') format = /\.ipynb$/i.test(path) ? 'notebook' : 'json';
  else if (file.format === 'JSON Lines') format = 'jsonl';
  else if (file.format.startsWith('image/')) format = 'image';
  else if (file.format === 'PDF') format = 'pdf';
  else if (file.format === 'ZIP 容器') format = 'archive';
  else if (file.text !== undefined) format = 'text';
  return {path, sha256: file.sha256, format, valid: bytes.length > 0 && (file.text === undefined || Boolean(file.text.trim())) && !file.issues.length};
}

export async function assessApplicability({skill, goal, context = {}, store, task, scope, tools, signal}) {
  const policy = skill.applicability;
  const result = {status: 'unspecified', checks: [], inputs: [], policySha256: policy ? hash(JSON.stringify(policy)) : '', goalSha256: hash(goal)};
  if (!policy) return result;
  const add = (status, code, message) => result.checks.push({status, code, message: message.slice(0, 1000)});
  result.checks.push(...goalApplicability(policy, goal));
  for (const name of policy.tools) add(tools.some(tool => tool.function.name === name) ? 'passed' : 'failed', 'REQUIRED_TOOL', '所需工具：' + name);
  const materials = context.selectedFile ? (context.materials ?? []).filter(file => file.id === context.selectedFile.id) : context.materials ?? [];
  if (policy.input_formats.length) {
    for (const material of materials.slice(0, 12)) {
      signal.throwIfAborted();
      const file = store.file(task, material.id);
      if (file.run) continue;
      const path = file.relative_path ?? file.name;
      if (file.size > config.tools.fileBytes) add('unknown','FILE_TOO_LARGE',`${path} · ${fileErrors.FILE_TOO_LARGE}`);
      else result.inputs.push(materialObservation(path, file.bytes));
    }
  }
  if (policy.project_files.length) {
    if (!scope?.projectId || !scope.projectPath || scope.mode === 'attachments') add('unknown', 'PROJECT_REQUIRED', '需要绑定项目并授予读取权限。');
    else for (const path of policy.project_files) {
      signal.throwIfAborted();
      const snapshot = await preflightSnapshot({...scope, mode: 'project_read'}, path, signal);
      if (snapshot.error) {
        add(['NOT_FOUND', 'NOT_FILE'].includes(snapshot.error.code) ? 'failed' : 'unknown', snapshot.error.code, path + ' · ' + snapshot.error.message);
      } else {
        const input = materialObservation(path, snapshot.bytes);
        result.inputs.push(input);
        add(input.valid ? 'passed' : 'failed', 'PROJECT_INPUT', path + (input.valid ? ' · 文件可读且通过已支持的格式检查。' : ' · 文件为空或格式检查失败。'));
      }
    }
  }
  if (policy.input_formats.length) {
    const matches = result.inputs.filter(input => input.valid && policy.input_formats.includes(input.format));
    add(matches.length ? 'passed' : result.inputs.length ? 'failed' : 'unknown', 'INPUT_FORMAT', matches.length
      ? '实际材料符合声明格式：' + matches.map(input => input.path).join('、') : '缺少有效的输入格式：' + policy.input_formats.join('、'));
  }
  if (!result.checks.length) add('unknown', 'EMPTY_POLICY', '尚未填写可检查的适用条件。');
  result.status = result.checks.some(check => check.status === 'failed') ? 'failed' : result.checks.some(check => check.status === 'unknown') ? 'unknown' : 'passed';
  return result;
}
