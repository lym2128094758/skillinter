import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {readCitationReceipts} from './citation-verifier.mjs';
import { object, string, validate } from './schema.mjs';
import { resultSchema, success, failure, checkResult } from './tool-contract.mjs';
import { parseSkillFile } from './skill-import.mjs';
import { graphNodeId, relationsForSkills } from './skill-routing.mjs';
import { applicabilityResultSchema, assessApplicability } from './skill-applicability.mjs';
import { deliverySchema, deliveryResultSchema, freezeDelivery, verifyDelivery } from './skill-delivery.mjs';
import { checkedLocalPath, inside } from './file-scope.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const strings = {type: 'array', maxItems: 30, items: string};
const requirementsSchema = object({required_tools: strings, required_files: strings, required_commands: strings});
const resourceItem = object({path: string, size: {type: 'integer', minimum: 0}, text: {type: 'boolean'}});
const readinessSchema = object({status: {enum: ['ready', 'blocked', 'unspecified']}, checks: strings, missing: strings});
export const sessionErrors = {INVALID_ARGUMENT: '技能运行参数无效。', SKILL_NOT_FOUND: '技能不存在或不属于当前会话。',
  RESOURCE_NOT_FOUND: '技能资源不存在。', RESOURCE_OUTSIDE_PACKAGE: '只能读取所选技能包内的相对路径。',
  RESOURCE_CHANGED: '技能或资源已变化，请开始新一轮重新加载。', RESOURCE_UNSAFE: '技能包包含链接或不可访问的资源。',
  NOT_TEXT: '此技能资源不是有效 UTF-8 文本。', FILE_TOO_LARGE: '技能文本资源超过 256 KB，请改用适合该文件的工具。',
  REQUIREMENTS_MISSING: '技能执行条件不满足，请查看检查结果并补齐条件。',
  SKILL_NOT_APPLICABLE: '技能适用条件未通过，请查看依据、补充信息或选择其他方法。',
  DELIVERY_NOT_PASSED: '产物验收未通过，请查看 verify_skill_output 的实际检查结果，修复或说明缺失证据。',
  DEPENDENCY_INCOMPLETE: '前置技能尚未完成，请先完成前置技能或说明原因并调整技能计划。',
  SKILL_ACTIVE: '当前另一个技能尚未结束，请先记录它的结果。',
  NO_EVIDENCE: '缺少属于本轮该技能的真实工具回执，不能标记为已应用。',
  CHAIN_NOT_PLANNED: '技能与任务步骤不匹配，请先整理计划并从该步骤的真实候选中选择。',
  ABORTED: '操作已取消。', TIMEOUT: '技能操作超过 15 秒，请缩小读取范围后重试。', INTERNAL: '技能运行失败。'};
const definitions = [
  {name: 'inspect_skill', description: '检查本轮技能版本、配套资源清单及 SIH.requirements.json 声明的工具、文件和命令要求。未声明条件时标为 unspecified，不代表环境已验证。',
    parameters: object({skill_id: string}), data: object({id: string, name: string, version: {type: 'integer'}, readiness: readinessSchema,
      resources: {type: 'array', maxItems: 500, items: resourceItem}, truncated: {type: 'boolean'}, applicability: applicabilityResultSchema})},
  {name: 'read_skill_resource', description: '读取已安装技能包的 UTF-8 配套资料或脚本正文，仅作为资料，不执行。path 为包内相对路径；可分段读取 SKILL.md。offset 从 0 起，limit 默认 120 行。',
    parameters: {type: 'object', required: ['skill_id', 'path'], additionalProperties: false, properties: {
      skill_id: string, path: string, offset: {type: 'integer', minimum: 0, default: 0}, limit: {type: 'integer', minimum: 1, maximum: 200, default: 120}}},
    data: object({id: string, path: string, sha256: string, offset: {type: 'integer'}, linesReturned: {type: 'integer'}, totalLines: {type: 'integer'}, content: {...string, maxLength: 16000}, truncated: {type: 'boolean'}})},
  {name: 'start_skill', description: '开始应用一个技能。先检查条件及本次已选技能链的依赖；实际文件调用回执将绑定此技能。不会运行脚本或扩大权限。',
    parameters: object({skill_id: string}), data: object({id: string, name: string, status: {enum: ['running']}})},
  {name: 'verify_skill_output', description: '只读重读技能版本事先声明的项目产物，核对冻结的文本或 JSON 条件与原始输入指纹。返回 passed/failed/unknown/unspecified，只覆盖声明范围。条件未在文件操作前冻结则 unknown；不得把模型自行判断当作验收。',
    parameters: object({skill_id: string}), data: deliveryResultSchema},
  {name: 'revise_skill_route', description: '按任务需要换用已安装替代技能或移除不再采用的方法，必须解释依据。本轮冻结的硬依赖不可跳过；保留依赖技能时须保留或先完成其前置。不清除既有回执，不修改权限。',
    parameters: object({skill_ids: {type: 'array', maxItems: 12, items: string}, rationale: {...string, minLength: 1}}),
    data: object({skills: strings, rationale: string})},
  {name:'select_task_skill_chain',description:'从 prepare_task 的各步骤候选中选择技能，按任务依赖顺序加入本轮技能链并实际加载指南。每项提供对应 step_id 和候选 skill_id；相同技能可以服务多个步骤。未通过适用性检查的技能会单独报告，不会冒充已加载或已执行。',
    parameters:object({selections:{type:'array',minItems:1,maxItems:12,items:object({step_id:string,skill_id:string})},rationale:{...string,minLength:1}}),
    data:object({selections:{type:'array',items:object({step_id:string,skill_id:string,name:string,status:{enum:['loaded','blocked']},instructions:{type:'string',maxLength:10000},message:string})}})},
  {name: 'finish_skill', description: '记录技能应用结果。applied 仅表示 Agent 报告已应用且存在本轮真实回执，不代表独立质量验收。evidence 为该技能实际工具回执的序号；blocked/failed 可不带回执，但须说明原因。',
    parameters: object({skill_id: string, status: {enum: ['applied', 'blocked', 'failed']}, summary: {...string, minLength: 1},
      evidence: {type: 'array', maxItems: 20, items: {type: 'integer', minimum: 1}}}),
    data: object({id: string, name: string, status: {enum: ['applied', 'blocked', 'failed']}, summary: string,
      evidence: {type: 'array', items: {type: 'integer'}}})},
];
definitions.find(tool => tool.name === 'inspect_skill').data.properties.delivery = deliverySchema;
export const skillSessionRegistry = definitions.map(({data, ...definition}) => ({...definition,
  returns: resultSchema(data), errors: sessionErrors, timeoutMs: 15000, idempotent: ['inspect_skill', 'read_skill_resource', 'verify_skill_output'].includes(definition.name),
  defaults: definition.name === 'read_skill_resource' ? {offset: 0, limit: 120} : {}, volatile: [],
  ordering: '资源按相对路径 UTF-16 字典序；回执按事件序号。',
  authorization: '服务端固定本轮可用技能及版本。只读技能包资源；任务文件沿用本轮权限，不运行命令，不访问网络。',
  timeoutMode: '受本轮取消信号和 15 秒工具超时约束。'}));

export function createSkillSession({store, task, run, localSkills, route, scope, tools, signal, context = {}}) {
  route=structuredClone(route);
  const registry=route.registrySnapshot;
  const versions = new Map(localSkills.map(skill => [skill.id, skill]));
  const endpoint=id=>registry?id:localSkills.find(skill=>skill.name===id)?.id;
  const nodeId=skill=>registry?skill.id:graphNodeId(skill.name);
  const dependencies=id=>(registry?.relations??route.relations).filter(edge=>edge.type==='depend_on'&&endpoint(edge.source)===id).map(edge=>endpoint(edge.target));
  const registryBlocked=id=>registry?.issues.some(issue=>issue.skillId===id&&['DEPENDENCY_CYCLE','RELATION_ENDPOINT_UNAVAILABLE','EXTERNAL_DEPENDENCY_UNBOUND'].includes(issue.code));
  const packages = new Map(), loaded = new Set(), states = new Map(), evidence = new Map();
  let active = null;
  let finalized = false;
  let operationSignal = signal;
  let currentGoal = context.goal ?? store.run(run).prompt ?? '';
  const assessments = new Map(), deliveries = new Map(), deliveryResults = new Map(), activated = new Set();
  const namedError = code => Object.assign(new Error(sessionErrors[code]), {code});
  const textFile = path => /(?:\.(?:md|txt|json|ya?ml|csv|tsv|js|mjs|cjs|py|sh|ps1|html|css|svg|toml|ini|xml)|(?:^|\/)LICENSE)$/i.test(path);
  function skillFor(id) {
    const skill = versions.get(id);
    if (!skill) throw namedError('SKILL_NOT_FOUND');
    return skill;
  }
  function relativePath(path) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /[:\x00-\x1f]/.test(path) || path.split(/[\\/]/).some(part => part === '..' || part === '' || /^\.env(?:\.|$)/i.test(part))) throw namedError('RESOURCE_OUTSIDE_PACKAGE');
    return path;
  }
  async function checked(packageScope, path) {
    relativePath(path);
    const target = resolve(packageScope.projectPath, path);
    const rel = relative(packageScope.projectPath, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw namedError('RESOURCE_OUTSIDE_PACKAGE');
    // This separate capability reads only a registered skill package, including
    // managed state/skills roots, and never changes task file permissions.
    try {
      const root = await checkedLocalPath(packageScope.projectPath);
      const {physical, stat} = await checkedLocalPath(target);
      if (!inside(root.physical, physical) || stat.isFile() && stat.nlink > 1) throw namedError('RESOURCE_UNSAFE');
      return {target: physical, stat};
    } catch (error) {
      if (error.contractCode === 'SYMLINK_NOT_ALLOWED') throw namedError('RESOURCE_UNSAFE');
      throw error;
    }
  }
  async function read(packageScope, path) {
    operationSignal.throwIfAborted();
    const {target, stat} = await checked(packageScope, relativePath(path));
    if (!stat.isFile()) throw namedError('RESOURCE_NOT_FOUND');
    if (stat.size > 256000) throw namedError('FILE_TOO_LARGE');
    const fd = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.nlink > 1 || before.size > 256000) throw namedError('RESOURCE_UNSAFE');
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        operationSignal.throwIfAborted();
        const result = await fd.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await fd.stat(), current = await checked(packageScope, path);
      if (length !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.stat.ino !== after.ino || current.stat.mtimeMs !== after.mtimeMs) throw namedError('RESOURCE_CHANGED');
      return {bytes: bytes.subarray(0, length), stat: after};
    } finally { await fd.close(); }
  }
  async function inspect(id) {
    const skill = skillFor(id);
    if (!skill.storagePath) return withApplicability(skill, {id, name: skill.name, version: skill.version,
      readiness: {status: 'unspecified', checks: ['此技能没有磁盘资源目录'], missing: []}, resources: [], truncated: false});
    const packageScope = {mode: 'project_read', projectPath: dirname(skill.storagePath), state: scope?.state};
    const definitionPath = relative(packageScope.projectPath, skill.storagePath);
    const definition = await read(packageScope, definitionPath);
    const parsed = parseSkillFile(definitionPath, new TextDecoder('utf-8', {fatal: true}).decode(definition.bytes));
    if (parsed.name !== skill.name || parsed.description !== skill.description || parsed.instructions !== skill.instructions ||
      JSON.stringify(parsed.applicability) !== JSON.stringify(skill.applicability) ||
      JSON.stringify(parsed.delivery) !== JSON.stringify(skill.delivery)) throw namedError('RESOURCE_CHANGED');
    const cached = packages.get(id);
    if (cached) {
      if (cached.definitionHash !== hash(definition.bytes)) throw namedError('RESOURCE_CHANGED');
      if (cached.requirementsHash) {
        if (hash((await read(packageScope, 'SIH.requirements.json')).bytes) !== cached.requirementsHash) throw namedError('RESOURCE_CHANGED');
        for (const path of cached.requiredFiles) {
          if (!cached.metadata.has(path)) continue;
          const {stat} = await checked(packageScope, path), before = cached.metadata.get(path);
          if (stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) throw namedError('RESOURCE_CHANGED');
        }
      }
      return withApplicability(skill, cached.view);
    }
    const resources = [], metadata = new Map(), issues = [];
    let truncated = false, visited = 0;
    async function visit(directory, depth = 0) {
      if (resources.length >= 500 || depth > 6 || ++visited > 1500) { truncated = true; return; }
      operationSignal.throwIfAborted();
      await checked(packageScope, directory);
      const children = (await readdir(join(packageScope.projectPath, directory), {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        if (resources.length >= 500) { truncated = true; break; }
        if (/^(?:\.git|node_modules|\.venv|__pycache__|\.env(?:\..*)?)$/i.test(child.name)) continue;
        const path = directory === '.' ? child.name : directory + '/' + child.name;
        if (child.isSymbolicLink()) { issues.push('已跳过链接：' + path); continue; }
        if (child.isDirectory()) await visit(path, depth + 1);
        else if (child.isFile()) {
          const {stat} = await checked(packageScope, path);
          metadata.set(path, {size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino});
          resources.push({path, size: stat.size, text: textFile(path)});
        }
      }
    }
    await visit('.');
    const projectTests = tools.some(tool => tool.function.name === 'run_project_tests');
    const python = tools.some(tool=>tool.function.name==='run_python');
    const discovery = tools.some(tool=>tool.function.name==='discover_skills');
    const readiness = {status: 'unspecified', checks: ['未声明可机器检查的执行条件；不代表工具或环境已验证',
      '本轮文件权限：' + (scope?.mode ?? 'attachments'), python ? '项目 Python 执行遵循运行设置' : projectTests ? '项目 Node.js 测试遵循运行设置' : '当前不能执行命令',
      discovery?'只能通过工具发现配置范围内的公开技能':'不能直接访问网络资源', ...issues].slice(0, 30), missing: []};
    if (resources.some(item => /\.(py|mjs|js|ps1|sh)$/i.test(item.path))) readiness.checks.push('包内脚本仅可读取；如任务依赖运行脚本，需要执行能力或改用已具备的工具');
    let requirementsHash = '', requiredFiles = [];
    if (metadata.has('SIH.requirements.json')) {
      const manifest = await read(packageScope, 'SIH.requirements.json');
      requirementsHash = hash(manifest.bytes);
      let requirements;
      try { requirements = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(manifest.bytes)); } catch { throw namedError('INVALID_ARGUMENT'); }
      if (validate(requirementsSchema, requirements).length) throw namedError('INVALID_ARGUMENT');
      requiredFiles = requirements.required_files;
      readiness.checks = [...issues];
      for (const name of requirements.required_tools) {
        if (tools.some(tool => tool.function.name === name)) readiness.checks.push('工具可用：' + name);
        else readiness.missing.push('缺少工具或权限：' + name);
      }
      for (const path of requirements.required_files) {
        relativePath(path);
        if (metadata.has(path)) readiness.checks.push('配套文件存在：' + path);
        else readiness.missing.push('缺少配套文件：' + path);
      }
      for (const command of requirements.required_commands) {
        if (command === 'node --test' && projectTests) readiness.checks.push('项目 Node.js 测试可请求，运行需用户确认');
        else if (['python','python -I'].includes(command)&&python) readiness.checks.push('可运行已审阅的Python脚本；环境须inspect_runtime检查，确认方式遵循运行设置');
        else readiness.missing.push('当前 Harness 不支持执行命令：' + command);
      }
      readiness.status = readiness.missing.length ? 'blocked' : 'ready';
    }
    readiness.checks = readiness.checks.slice(0, 30); readiness.missing = readiness.missing.slice(0, 30);
    const view = {id, name: skill.name, version: skill.version, readiness, resources, truncated};
    packages.set(id, {packageScope, definitionPath, definitionHash: hash(definition.bytes), metadata, view, requirementsHash, requiredFiles});
    return withApplicability(skill, view);
  }
  async function withApplicability(skill, view) {
    if (skill.delivery && !deliveries.has(skill.id)) {
      const changed = store.events(run, 0).some(event => event.type === 'tool_result' &&
        ['create_file', 'replace_in_file', 'run_project_tests','run_python'].includes(event.payload.name));
      const frozen = await freezeDelivery({contract: skill.delivery, scope, signal: operationSignal, beforeExecution: !changed});
      deliveries.set(skill.id, frozen);
      store.record(run, 'skill_delivery_prepared', {id: skill.id, name: skill.name, version: skill.version, ...frozen});
    }
    const applicability = await assessApplicability({skill, goal: currentGoal, context, store, task, scope, tools, signal: operationSignal});
    const previous = assessments.get(skill.id);
    if (JSON.stringify(previous) !== JSON.stringify(applicability)) {
      assessments.set(skill.id, applicability);
      store.record(run, 'skill_applicability', {id: skill.id, name: skill.name, version: skill.version, ...applicability});
    }
    return {...view, applicability, ...(skill.delivery ? {delivery: skill.delivery} : {})};
  }
  const applicable = info => ['passed', 'unspecified'].includes(info.applicability.status);
  async function verifyOutput(id) {
    const skill = skillFor(id);
    let result;
    try {result = await verifyDelivery({frozen: deliveries.get(id), scope, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      readReceipts: readCitationReceipts(store.events(run, 0))});}
    catch {result = {status: 'unknown', contractSha256: deliveries.get(id)?.sha256 ?? '', verifierSha256: deliveries.get(id)?.verifierSha256 ?? '', frozenBeforeExecution: Boolean(deliveries.get(id)?.beforeExecution), files: [],
      checks: [{path: '', code: 'CHECK_INCOMPLETE', status: 'unknown', message: '检查中断或无法读取，不能确认产物。'}]};}
    if (JSON.stringify(deliveryResults.get(id)) !== JSON.stringify(result)) {
      deliveryResults.set(id, result);
      store.record(run, 'skill_delivery', {id, name: skill.name, version: skill.version, ...result});
    }
    return result;
  }
  function rejectApplicability(skill, info) {
    states.set(skill.id, {state: 'blocked', summary: info.applicability.checks.filter(check => check.status !== 'passed').map(check => check.message).join('；')});
    emit();
    throw namedError('SKILL_NOT_APPLICABLE');
  }
  function emit() {
    const candidates = [...new Map([...route.candidates.map(item => [item.id, item]), ...[...loaded].map(id => {
      const skill = skillFor(id); return [id, {id, name: skill.name, version: skill.version, nodeId: nodeId(skill), reason: '已加载技能'}];
    })]).values()];
    const graph = {nodes: candidates.map(skill => ({...skill, step: skill.id, label: skill.name,
      state: states.get(skill.id)?.state ?? 'planned', started: states.get(skill.id)?.started ?? false,
      evidence: states.get(skill.id)?.evidence ?? [], summary: states.get(skill.id)?.summary ?? ''})),
    edges: (registry?.relations??route.relations).filter(edge => edge.type === 'depend_on').map(edge => ({from: endpoint(edge.target), to: endpoint(edge.source)}))
      .filter(edge => candidates.some(item=>item.id===edge.from)&&candidates.some(item=>item.id===edge.to))};
    const trace = {kind: 'skill-session', attempt: 1, graph, graphSha256: route.graphSha256};
    store.record(run, 'skill_runtime', trace);
    return trace;
  }
  async function load(id, automatic = false) {
    const skill = skillFor(id);
    const info = await inspect(id);
    if (!applicable(info)) rejectApplicability(skill, info);
    if (info.readiness.status === 'blocked') {
      states.set(id, {state: 'blocked', summary: info.readiness.missing.join('；')}); emit();
      throw namedError('REQUIREMENTS_MISSING');
    }
    if (!loaded.has(id)) {
      loaded.add(id); states.set(id, {state: 'loaded'});
      store.record(run, 'custom_skill_loaded', {id, name: skill.name, version: skill.version});
      if (automatic) store.record(run, 'skill_auto_loaded', {id, name: skill.name, version: skill.version});
      emit();
    }
    return {id, name: skill.name, version: skill.version, instructions: skill.instructions, ...(skill.delivery ? {delivery: skill.delivery} : {})};
  }
  return {
    inspect, load,
    async verifyApplied() {
      const results = [];
      for (const id of activated) {
        const state = states.get(id);
        if (!skillFor(id).delivery) continue;
        const result = await verifyOutput(id);
        results.push({name: skillFor(id).name, ...result});
        if (state.state === 'applied' && result.status !== 'passed') {
          states.set(id, {...state, state: 'failed', summary: '结束前重新核验产物未通过；以实际验收记录为准。'});
          store.record(run, 'skill_application', {id, name: skillFor(id).name, status: 'failed', summary: '结束前重新核验产物未通过。', evidence: state.evidence ?? []});
        }
      }
      return results;
    },
    updateGoal(goal) { currentGoal = goal; },
    async guardActive() {
      if (!active) return null;
      const skill = skillFor(active);
      const info = await inspect(active);
      if (applicable(info)) return null;
      active = null;
      try { rejectApplicability(skill, info); } catch { return failure(sessionErrors, 'SKILL_NOT_APPLICABLE'); }
    },
    async prepare() {
      const cards = [], guides = [];
      let remaining = 24000;
      for (const item of route.candidates) {
        try {
          operationSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          const info = await inspect(item.id);
          cards.push({...item, readiness: info.readiness, applicability: info.applicability, resources: info.resources.slice(0, 12), resourcesTruncated: info.truncated || info.resources.length > 12});
          if (info.readiness.status !== 'blocked' && applicable(info)) {
            const loadedSkill = await load(item.id, true);
            const instructions = loadedSkill.instructions.slice(0, Math.min(remaining, 10000));
            remaining -= instructions.length;
            guides.push({...item, instructions, truncated: instructions.length < loadedSkill.instructions.length,
              ...(skillFor(item.id).delivery ? {delivery: skillFor(item.id).delivery, deliveryFrozen: Boolean(deliveries.get(item.id)?.beforeExecution)} : {})});
          } else { states.set(item.id, {state: 'blocked', summary: [...info.readiness.missing,
            ...info.applicability.checks.filter(check => check.status !== 'passed').map(check => check.message)].join('；')}); }
        } catch (error) { cards.push({...item, readiness: {status: 'blocked', checks: [], missing: [error.message]}}); states.set(item.id, {state: 'blocked', summary: error.message}); }
        finally { operationSignal = signal; }
      }
      store.record(run, 'skill_route', {...route, candidates: cards}); emit();
      return {route: {...route, candidates: cards}, guides};
    },
    active: () => active,
    guardDependencies() {
      if(!registry||active)return null;
      if(route.candidates.some(item=>states.get(item.id)?.state!=='applied'&&(registryBlocked(item.id)||dependencies(item.id).some(id=>states.get(id)?.state!=='applied'))))return failure(sessionErrors,'DEPENDENCY_INCOMPLETE');
      return null;
    },
    async autoStart() {
      if (active) return active;
      for (const item of route.candidates) {
        if (['applied', 'failed'].includes(states.get(item.id)?.state)) continue;
        if (registryBlocked(item.id)||dependencies(item.id).some(id=>states.get(id)?.state!=='applied')) continue;
        const result = await this.execute('start_skill', {skill_id: item.id});
        if (result.ok) { store.record(run, 'skill_auto_started', {id: item.id, name: item.name, reason: '首个任务操作自动绑定默认技能'}); return item.id; }
      }
      return null;
    },
    receipt(seq, name, output) {
      if (!active || ['inspect_skill', 'read_skill_resource', 'verify_skill_output', 'start_skill', 'finish_skill', 'load_skill', 'search_skills', 'update_plan',
        'prepare_task','select_task_skill_chain','search_skill_libraries','inspect_runtime','discover_skills','adopt_discovered_skill','install_discovered_skill','read_discovered_resource'].includes(name)) return;
      evidence.set(seq, {id: active, name, ok: output.ok &&
        (output.data?.kind !== 'project_tests' || output.data.status === 'passed') &&
        (output.data?.kind !== 'python_execution' || output.data.status === 'passed') &&
        (output.data?.kind !== 'material_preflight' || output.data.status === 'completed')});
      return evidence.get(seq);
    },
    finalize(status) {
      if (finalized || !route.candidates.length && !loaded.size) return;
      finalized = true;
      if (active) { states.set(active, {state: status === 'stopped' ? 'interrupted' : 'unfinished', started: true, summary: '技能尚未记录应用结果'}); active = null; }
      const trace = emit();
      const applications = store.events(run, 0).filter(event => event.type === 'skill_application').map(event => event.payload);
      const resources = store.events(run, 0).filter(event => event.type === 'skill_resource_read').map(event => event.payload);
      const file = store.addFile(task, run, 'skill-execution.json', 'report', Buffer.from(JSON.stringify({schemaVersion: 1, status, route, trace, applications, resources,
        applicability: Object.fromEntries(assessments),
        deliveryContracts: Object.fromEntries(deliveries), deliveryResults: Object.fromEntries(deliveryResults),
        receipts: [...evidence].map(([seq, value]) => ({seq, ...value})), note: 'applied 是 Agent 报告且有工具回执，不代表独立正确性验收。'}, null, 2)));
      store.record(run, 'skill_session_completed', {trace, artifact: file});
    },
    async execute(name, args) {
      const definition = skillSessionRegistry.find(item => item.name === name);
      try {
        operationSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        operationSignal.throwIfAborted();
        if (!definition || validate(definition.parameters, args).length) return failure(sessionErrors, 'INVALID_ARGUMENT');
        if (name === 'select_task_skill_chain') {
          const brief = store.events(run,0).findLast(event=>event.type==='task_brief')?.payload;
          if (!brief) return failure(sessionErrors,'CHAIN_NOT_PLANNED');
          const stepById = new Map(brief.steps.map(step=>[step.id,step]));
          if (args.selections.some(item=>!stepById.get(item.step_id)?.candidates.some(candidate=>candidate.id===item.skill_id)) ||
              new Set(args.selections.map(item=>item.step_id+'\0'+item.skill_id)).size!==args.selections.length) return failure(sessionErrors,'CHAIN_NOT_PLANNED');
          const ordered = [], visited = new Set();
          function visit(id) {
            if (visited.has(id)) return;
            visited.add(id);
            for (const dependency of stepById.get(id).depends_on) visit(dependency);
            ordered.push(id);
          }
          for (const step of brief.steps) visit(step.id);
          const selections = [...args.selections].sort((a,b)=>ordered.indexOf(a.step_id)-ordered.indexOf(b.step_id));
          const ids = new Set(selections.map(item=>item.skill_id));
          const blocked = new Map();
          if (registry) {
            for (const id of ids) {
              if (!registry.skills.some(ref=>ref.skillId===id&&ref.selectable) || registryBlocked(id)) {
                ids.delete(id);
                blocked.set(id,'DEPENDENCY_INCOMPLETE');
              }
            }
            for (let changed = true; changed;) {
              changed = false;
              for (const id of ids) if (dependencies(id).some(dep=>!ids.has(dep)&&states.get(dep)?.state!=='applied')) {
                ids.delete(id);
                blocked.set(id,'DEPENDENCY_INCOMPLETE');
                changed = true;
              }
            }
          }
          if (ids.size) {
            const batchSignal = operationSignal;
            const revised = await this.execute('revise_skill_route',{skill_ids:[...ids],rationale:args.rationale});
            operationSignal = batchSignal;
            if (!revised.ok) return revised;
          }
          const loaded = new Map(), result = [];
          for (const item of selections) {
            const skill = skillFor(item.skill_id);
            if (blocked.has(skill.id)) {
              result.push({...item,name:skill.name,status:'blocked',instructions:'',message:sessionErrors[blocked.get(skill.id)]});
              continue;
            }
            if (!loaded.has(skill.id)) {
              try {
                const guide = await load(skill.id);
                loaded.set(skill.id,{status:'loaded',instructions:guide.instructions.slice(0,10000),message:guide.instructions.length>10000?'指南已截断，可继续读取 SKILL.md。':''});
              } catch (error) {
                const code = Object.hasOwn(sessionErrors,error.code) ? error.code : 'INTERNAL';
                loaded.set(skill.id,{status:'blocked',instructions:'',message:sessionErrors[code]});
              }
            }
            result.push({...item,name:skill.name,...loaded.get(skill.id)});
          }
          store.record(run,'task_skill_chain',{revision:brief.revision,selections:result.map(({instructions,...item})=>item),rationale:args.rationale});
          return success({selections:result});
        }
        if (name === 'revise_skill_route') {
          if (new Set(args.skill_ids).size !== args.skill_ids.length || active && !args.skill_ids.includes(active)) return failure(sessionErrors, 'SKILL_ACTIVE');
          const chosen = args.skill_ids.map(skillFor);
          if(registry&&chosen.some(skill=>!registry.skills.some(ref=>ref.skillId===skill.id&&ref.selectable)||registryBlocked(skill.id)||dependencies(skill.id).some(id=>!args.skill_ids.includes(id)&&states.get(id)?.state!=='applied')))throw namedError('DEPENDENCY_INCOMPLETE');
          route.candidates = chosen.map(skill => ({id: skill.id, name: skill.name, version: skill.version, nodeId: nodeId(skill), description: skill.description.slice(0, 500), reason: args.rationale}));
          const names = new Set(chosen.map(skill => skill.name));
          route.relations = registry?registry.relations.filter(edge=>args.skill_ids.includes(edge.source)&&args.skill_ids.includes(edge.target)):relationsForSkills([...names]);
          if(!registry)route.missingDependencies = [];
          route.revision = (route.revision ?? 0) + 1;
          store.record(run, 'skill_route', {...route, rationale: args.rationale}); emit();
          return success({skills: chosen.map(skill => skill.name), rationale: args.rationale});
        }
        const skill = skillFor(args.skill_id);
        const info = await inspect(skill.id);
        let data;
        if (name === 'inspect_skill') data = info;
        if (name === 'verify_skill_output') data = {...await verifyOutput(skill.id),
          operationReceipts: [...evidence].filter(([, item]) => item.id === skill.id && item.ok).map(([seq]) => seq).slice(-20)};
        if (name === 'read_skill_resource') {
          const packageInfo = packages.get(skill.id);
          const path = relativePath(args.path);
          if (!packageInfo?.metadata.has(path)) throw namedError('RESOURCE_NOT_FOUND');
          const {bytes, stat} = await read(packageInfo.packageScope, path);
          const before = packageInfo.metadata.get(path);
          if (stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) throw namedError('RESOURCE_CHANGED');
          let text;
          try { if (bytes.includes(0)) throw new Error(); text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { throw namedError('NOT_TEXT'); }
          const lines = text.split(/\r?\n/), offset = args.offset ?? 0;
          const excerpt = lines.slice(offset, offset + (args.limit ?? 120)).join('\n');
          const content = excerpt.slice(0, 16000);
          data = {id: skill.id, path, sha256: hash(bytes), offset, linesReturned: content ? content.split('\n').length : 0, totalLines: lines.length,
            content, truncated: offset + (args.limit ?? 120) < lines.length || excerpt.length > content.length};
          store.record(run, 'skill_resource_read', {id: skill.id, name: skill.name, path, sha256: data.sha256, offset, linesReturned: data.linesReturned, truncated: data.truncated});
        }
        if (name === 'start_skill') {
          if (info.readiness.status === 'blocked') throw namedError('REQUIREMENTS_MISSING');
          if (!applicable(info)) rejectApplicability(skill, info);
          if (active && active !== skill.id) throw namedError('SKILL_ACTIVE');
          if (registryBlocked(skill.id)||dependencies(skill.id).some(id=>states.get(id)?.state!=='applied'))throw namedError('DEPENDENCY_INCOMPLETE');
          if (route.missingDependencies?.some(item => registry?item.skillId===skill.id:item.skill === skill.name)) throw namedError('DEPENDENCY_INCOMPLETE');
          await load(skill.id);
          active = skill.id; activated.add(skill.id); states.set(skill.id, {state: 'running', started: true}); emit();
          data = {id: skill.id, name: skill.name, status: 'running'};
        }
        if (name === 'finish_skill') {
          if (args.status === 'applied' && !applicable(info)) rejectApplicability(skill, info);
          if (args.evidence.some(seq => !evidence.has(seq) || evidence.get(seq).id !== skill.id) ||
            args.status === 'applied' && (active !== skill.id || !args.evidence.length || args.evidence.some(seq => !evidence.get(seq).ok))) throw namedError('NO_EVIDENCE');
          if (args.status === 'applied' && skill.delivery && (await verifyOutput(skill.id)).status !== 'passed') throw namedError('DELIVERY_NOT_PASSED');
          data = {id: skill.id, name: skill.name, status: args.status, summary: args.summary, evidence: [...new Set(args.evidence)].sort((a, b) => a - b)};
          states.set(skill.id, {state: args.status, started: states.get(skill.id)?.started ?? false, summary: args.summary, evidence: data.evidence});
          if (active === skill.id) active = null;
          store.record(run, 'skill_application', data); emit();
        }
        return checkResult(definition, success(data));
      } catch (error) {
        const code = signal.aborted ? 'ABORTED' : operationSignal.aborted ? 'TIMEOUT' : error.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : error.contractCode ? 'RESOURCE_UNSAFE' : Object.hasOwn(sessionErrors, error.code) ? error.code : 'INTERNAL';
        return failure(sessionErrors, code);
      } finally { operationSignal = signal; }
    },
  };
}
