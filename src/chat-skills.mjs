import { readFileSync } from 'node:fs';
import { analyzeCsv, csvAnalysisMaxBytes, csvAnalysisSizeMessage } from './skills.mjs';
import { config } from './config.mjs';
import { auditLimits, auditWorkflow, digest } from './workflow.mjs';
import { alignedSchema, issueSchema, requestSchema, validateRequest } from './audit-tools.mjs';
import { object, string, validate } from './schema.mjs';
import { checkResult, failure, resultSchema, success } from './tool-contract.mjs';
import { taskPlanTool, updatePlan } from './task-plan.mjs';
import { skillSessionRegistry, sessionErrors } from './skill-session.mjs';
import { projectTestTool } from './project-tests.mjs';
import { executePreflight, materialSkills, preflightInput } from './preflight.mjs';
import { deliverySchema } from './skill-delivery.mjs';
import {retrieveSkills} from './skill-retrieval.mjs';
import {taskCapabilityTools} from './task-capabilities.mjs';

const errors = {...sessionErrors, INVALID_ARGUMENT: '技能工具参数无效。', ATTACHMENT_NOT_FOUND: '附件不属于当前会话或不存在。',
  CSV_REQUIRED: '请选择或上传当前会话的 CSV 附件。', INVALID_CSV: 'CSV 格式无效。', CSV_TOO_LARGE:csvAnalysisSizeMessage,
  PRECHECK_ALREADY_RUN: '本轮已经执行另一项预检，请在下一轮提交新目标。',
  MATERIAL_PREFLIGHT_ALREADY_RUN: '本轮已有材料检查报告，请在下一轮提交另一目标。',
  SKILL_NOT_FOUND: '技能不存在或不属于当前项目。',
  ABORTED: '操作已取消。', TIMEOUT: '技能执行超时。', BUDGET_EXHAUSTED: '本轮共享预算已耗尽。', INTERNAL: '技能执行失败。'};
const artifactSchema = object({name: string, sha256: string, url: string});
const matchSchema = object({id: string, label: string, domain: string, description: {...string, maxLength: 2000},
  nodeId: string, executable: {type: 'boolean'}, tool: string, version: string});
const definitions = [
  {name: 'search_skills', description: '从 SkillNet 目录和当前会话可用的已发布技能中检索。executable=false 只可浏览；tool=load_skill 表示可按 ID 加载操作指南。',
    parameters: {type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: {...string, minLength: 1}, limit: {type: 'integer', minimum: 1, maximum: 20, default: 5},
      executable_only: {type: 'boolean', default: false}}},
    data: object({query: string, matches: {type: 'array', items: matchSchema}, truncated: {type: 'boolean'}, catalogSha256: string}),
    timeoutMs: config.tools.timeoutMs, idempotent: true, volatile: [],
    defaults: {limit: 5, executable_only: false}, ordering: '分词后按匹配分数降序，分数相同按 id 的 UTF-16 字典序。'},
  {name: 'load_skill', description: '加载 search_skills 找到的已发布技能操作指南。只接受当前会话可用的技能 ID，不更改工具或权限。',
    parameters: object({skill_id: {...string, pattern: '^[a-f0-9-]{36}$'}}),
    data: object({id: string, name: string, version: {type: 'integer', minimum: 1}, instructions: {...string, maxLength: 200_000}}),
    timeoutMs: config.tools.timeoutMs, idempotent: true, volatile: [], ordering: '单个版本。'},
  {name: 'analyze_csv', description: '只对当前会话的 CSV 附件做统计概览，生成含原文件指纹的可下载报告。字段映射、单位换算、质量检查应调用 precheck_table。',
    parameters: object({file_id: {...string, minLength: 1}}),
    data: object({kind: {enum: ['csv_overview']}, summary: string, artifact: artifactSchema}),
    timeoutMs: config.tools.timeoutMs, idempotent: true, volatile: ['data.artifact.url'], ordering: '统计按原始列顺序。'},
  {name: 'precheck_table', description: '按用户指定的目标字段和约束运行现有数据预检，含两阶段规划、单位核验、逐行检查和图谱轨迹。字段不明确时先询问用户。每轮只执行一个不同的预检，重复调用复用本轮结果。',
    parameters: object({file_id: {...string, minLength: 1}, goal: {...string, minLength: 1}, request: requestSchema}),
    data: object({kind: {enum: ['table_precheck']}, status: {enum: ['completed', 'needs_input', 'failed', 'budget_exhausted', 'stopped']},
      summary: string, mappings: {type: 'array', items: alignedSchema}, questions: {type: 'array', items: string},
      issues: {type: 'array', items: issueSchema}, error: object({code: string, message: string}),
      artifacts: {type: 'array', items: artifactSchema}}),
    timeoutMs: Math.max(config.audit.maxSeconds, config.audit.internS2MaxSeconds) * 1000,
    determinism: '同一轮相同参数复用已保存的结果。跨轮重新调用模型，不保证响应相同；按录制的模型响应和固定运行器离线重放。',
    idempotent: false, volatile: ['data.artifacts[].url'], ordering: '映射按目标字段顺序，问题按原始记录和目标字段顺序。'},
  {name: 'material_preflight', description: '按用户目标和真实材料选择本机检查方法。integrity 检查文件可读性、空内容、重复和指纹；structure 检查可支持的文件结构；reproducibility 检查复现说明和环境声明。目标或材料范围不明确时，对应字段用 unspecified。paths 只填项目相对路径。检查部分附件时提供 file_ids，留空数组表示全部附件，省略时优先检查用户选中的附件。',
    parameters: {type: 'object', additionalProperties: false, required: ['source', 'goal', 'paths'], properties: {
      source: {enum: ['attachments', 'project', 'unspecified']}, goal: {enum: ['integrity', 'structure', 'reproducibility', 'unspecified']},
      paths: {type: 'array', maxItems: 20, items: {...string, maxLength: 500}},
      file_ids: {type: 'array', maxItems: 12, items: {...string, maxLength: 36}},
    }},
    data: object({kind: {enum: ['material_preflight']}, status: {enum: ['completed', 'needs_input']}, summary: string,
      selected: {type: 'array', maxItems: 1, items: string}, artifact: {anyOf: [artifactSchema, {enum: [null]}]},
      files: {type: 'array', maxItems: 20, items: object({path: string, sha256: string, scope: string})},
      findings: {type: 'array', maxItems: 20, items: object({path: string, code: string, message: string,
        line: {anyOf: [{type: 'integer', minimum: 1}, {enum: [null]}]}, related: string})},
      evidence: {type: 'array', maxItems: 2, items: object({label: string, paths: {type: 'array', maxItems: 20, items: string}})},
      moreFindings: {type: 'boolean'}}),
    timeoutMs: 30_000, idempotent: false, volatile: ['data.artifact.url'], ordering: '候选按所需目标选择，文件按授权材料范围顺序检查。'},
];
definitions.find(tool => tool.name === 'load_skill').data.properties.delivery = deliverySchema;
export const chatSkillRegistry = [...definitions.map(({data, ...tool}) => ({...tool, returns: resultSchema(data), errors,
  authorization: tool.name === 'material_preflight' ? '仅检查本轮会话附件或已绑定并授予读取权限的项目，不改变文件和权限。' : tool.name === 'load_skill' || tool.name === 'search_skills'
    ? '服务端绑定当前会话及其项目，加载本轮开始时冻结的已发布版本，不扩大工具和文件权限。'
    : '服务端绑定当前会话。数据工具仅接受该会话上传的原始 CSV；不能修改源文件或扩大文件访问权限。',
  timeoutMode: tool.name === 'material_preflight' ? '继承本轮停止信号和本地材料检查时限。' : tool.name === 'precheck_table' ? '复用预检总时限、停止信号和本轮共享模型调用额度。' : '本地有界同步操作，执行后检查耗时。',
})), taskPlanTool, ...skillSessionRegistry, projectTestTool, ...taskCapabilityTools];
export const chatSkillModelTools = chatSkillRegistry.map(({name, description, parameters}) => ({type: 'function', function: {name, description, parameters}}));

function orderedData(value) {
  if (Array.isArray(value)) return value.map(orderedData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedData(value[key])]));
  }
  return value;
}

let catalog;
function skillCatalog() {
  if (catalog) return catalog;
  const text = readFileSync(new URL('../web/catalog/graph.json', import.meta.url), 'utf8');
  const graph = JSON.parse(text);
  const local = [
    {id: 'csv-precheck', label: 'CSV 数据质量预检', domain: '数据与分析', nodeId: 'data-cleaning', executable: true,
      tool: 'precheck_table', version: '4', description: '按目标字段做语义映射、单位换算、缺失值、类型和数值范围检查，生成报告、引用和执行图。'},
    {id: 'csv-overview', label: 'CSV 数据概览', domain: '数据与分析', nodeId: 'xlsx', executable: true,
      tool: 'analyze_csv', version: '1', description: '统计表格列的空值、数值数、均值、最小值和最大值，生成可下载报告。'},
    ...Object.values(materialSkills).map(skill => ({...skill, domain: '材料预检', executable: true, tool: 'material_preflight', version: '1'})),
  ];
  catalog = {sha256: digest(text), entries: [...local, ...graph.nodes.map(node => ({id: node.id,
    label: node.label ?? node.name ?? node.id, domain: node.domain ?? '', nodeId: node.id, executable: false,
    tool: '', version: 'catalog-0af2de6a', description: String(node.description ?? '').slice(0, 900)}))]};
  return catalog;
}

function searchableCards(localSkills, snapshot) {
  const source = skillCatalog();
  const byCatalogId = new Map(source.entries.map(item => [item.id, item]));
  const visibleSkills = snapshot ? localSkills.filter(skill => snapshot.skills.some(ref => ref.skillId === skill.id && ref.selectable)) : localSkills;
  const externalBySkill = new Map(snapshot?.externalRefs.map(ref => [ref.skillId, ref.externalId]));
  const installedNames = new Set(snapshot ? snapshot.externalRefs.map(ref => ref.externalId) : visibleSkills.map(skill => skill.name));
  const local = visibleSkills.map(skill => ({id: skill.id, label: skill.name, domain: '已发布技能', description: skill.description,
    nodeId: byCatalogId.get(snapshot ? externalBySkill.get(skill.id) : skill.name)?.nodeId ?? '', executable: true, tool: 'load_skill', version: String(skill.version)}));
  const catalogSha256 = local.length ? digest({base: source.sha256, local}) : source.sha256;
  return {catalogSha256, cards: [...source.entries.filter(item => item.executable || !installedNames.has(item.id)), ...local]};
}

export function searchSkills({query, limit = 5, executable_only = false}, localSkills = [], snapshot) {
  const {catalogSha256, cards} = searchableCards(localSkills, snapshot);
  const terms = [...new Set([...new Intl.Segmenter('zh', {granularity: 'word'}).segment(query.toLowerCase())]
    .filter(part => part.isWordLike).map(part => part.segment))];
  const matches = cards.filter(item => !executable_only || item.executable).map(item => {
    const title = (item.label + ' ' + item.domain).toLowerCase();
    const text = (item.id + ' ' + item.description).toLowerCase();
    return {item, score: terms.reduce((score, term) => score + (title.includes(term) ? 3 : text.includes(term) ? 1 : 0), 0)};
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return {query, matches: matches.slice(0, limit).map(row => row.item), truncated: matches.length > limit, catalogSha256};
}

export function createChatSkills({store, task, run, model, signal, entry, localSkills = [], customSkill, session, scope, workspace, context, budget, registrySnapshot, skillEngine}) {
  const cache = new Map();
  let precheckKey;
  let materialPreflightKey;
  const artifact = file => ({name: file.name, sha256: file.sha256, url: `/api/tasks/${task}/files/${file.id}`});
  function csv(id) {
    let file;
    try { file = store.file(task, id); } catch { throw Object.assign(new Error(), {code: 'ATTACHMENT_NOT_FOUND'}); }
    if (file.run || file.detached || file.kind !== 'csv') throw Object.assign(new Error(), {code: 'CSV_REQUIRED'});
    if (file.size > csvAnalysisMaxBytes) throw Object.assign(new Error(), {code:'CSV_TOO_LARGE'});
    return file;
  }
  return {async execute(call) {
    const name = call.function.name;
    const definition = chatSkillRegistry.find(tool => tool.name === name);
    const started = performance.now();
    try {
      signal.throwIfAborted();
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { return failure(errors, 'INVALID_ARGUMENT'); }
      if (name === 'update_plan') return checkResult(taskPlanTool, updatePlan(store, task, run, args, signal));
      if (skillSessionRegistry.some(tool => tool.name === name)) return session ? await session.execute(name, args) : failure(errors, 'SKILL_NOT_FOUND');
      if (!definition || validate(definition.parameters, args).length ||
          (name === 'search_skills' && !args.query.trim()) ||
          (name === 'load_skill' && !/^[a-f\d-]{36}$/.test(args.skill_id)) ||
          (name === 'precheck_table' && validateRequest(args.request).length)) return failure(errors, 'INVALID_ARGUMENT');
      const key = digest(orderedData({name, args}));
      if (cache.has(key)) return cache.get(key);
      let data;
      if (name === 'search_skills') {
        if (budget) {
          const {cards, catalogSha256} = searchableCards(localSkills, registrySnapshot);
          const snapshot = registrySnapshot ?? {sha256: catalogSha256, relations: []};
          let localResult;
          const {result, matches} = await retrieveSkills({goal: args.query, limit: args.limit ?? 5, budget, signal,
            cards: cards.filter(card => !args.executable_only || card.executable), snapshot, provider: skillEngine,
            emit: (type, payload) => store.record(run, type, payload),
            local: () => { localResult = searchSkills(args, localSkills, registrySnapshot); return localResult.matches; }});
          if (!result.ok) return failure(errors, Object.hasOwn(errors, result.error.code) ? result.error.code : 'INTERNAL');
          data = {query: args.query, matches: matches.map(({engineReason, ...card}) => card),
            truncated: localResult?.truncated ?? false, catalogSha256};
          store.record(run, 'skill_retrieval', {provider: result.data.provider, fallback: result.data.fallback,
            candidates: matches.map(card => ({id: card.id, reason: card.engineReason}))});
        } else data = searchSkills(args, localSkills, registrySnapshot);
        store.record(run, 'skill_search', data);
      } else if (name === 'load_skill') {
        if (session) return checkResult(definition, success(await session.load(args.skill_id)));
        const skill = localSkills.find(skill => skill.id === args.skill_id);
        if (!skill) return failure(errors, 'SKILL_NOT_FOUND');
        const receipt = {id: skill.id, name: skill.name, version: skill.version};
        if (skill.id !== customSkill?.id) store.record(run, 'custom_skill_loaded', receipt);
        data = {...receipt, instructions: skill.instructions};
      } else if (name === 'material_preflight') {
        if (materialPreflightKey && materialPreflightKey !== key) return failure(errors, 'MATERIAL_PREFLIGHT_ALREADY_RUN');
        if ((args.source !== 'project' && args.paths.length) || (args.source !== 'attachments' && args.file_ids?.length)) return failure(errors, 'INVALID_ARGUMENT');
        let request = args;
        if (args.goal !== 'unspecified' && args.source !== 'unspecified') {
          try { request = preflightInput(args); } catch { return failure(errors, 'INVALID_ARGUMENT'); }
        }
        let attachments = args.source === 'attachments' ? context?.materials ?? store.task(task).files : [];
        const ids = args.file_ids ?? (context?.selectedFile ? [context.selectedFile.id] : []);
        if (args.source === 'attachments' && ids.length) {
          if (ids.some(id => !attachments.some(file => file.id === id))) return failure(errors, 'ATTACHMENT_NOT_FOUND');
          attachments = attachments.filter(file => ids.includes(file.id));
        }
        const deadline = AbortSignal.timeout(definition.timeoutMs);
        try {
          data = await executePreflight({store, task, run, goal: context?.goal ?? '', request, scope, workspace,
            attachments, signal: AbortSignal.any([signal, deadline]), inChat: true, budget});
        } catch (error) {
          if (deadline.aborted && !signal.aborted) return failure(errors, 'TIMEOUT');
          throw error;
        }
        if (data.status === 'completed') materialPreflightKey = key;
      } else {
        const file = csv(args.file_id);
        if (name === 'analyze_csv') {
          const result = analyzeCsv(file);
          const saved = store.transaction(() => {
            const saved = store.addFile(task, run, 'csv-analysis.txt', 'report', Buffer.from(result.report));
            store.record(run, 'skill_completed', {id: 'xlsx', label: 'CSV 数据概览', reason: '主会话调用本地 CSV 概览',
              source: file.id, sourceSha256: file.sha256, artifact: saved});
            return saved;
          });
          data = {kind: 'csv_overview', summary: result.summary, artifact: artifact(saved)};
        } else {
          if (precheckKey && precheckKey !== key) return failure(errors, 'PRECHECK_ALREADY_RUN');
          precheckKey = key;
          const result = await auditWorkflow({file, task, goal: args.goal, request: args.request, model,
            signal, entry, budget, limits: auditLimits(model.label), emit: (type, payload) => store.record(run, type, payload),
            takeGuidance: () => store.takeGuidance(run)});
          const files = store.saveAudit(task, run, result);
          const report = result.report;
          data = {kind: 'table_precheck', status: report.status, summary: result.summary.slice(0, 1000),
            mappings: report.mappings, questions: report.questions, issues: (report.validation.issues ?? []).slice(0, 10),
            error: {code: report.error.code ?? 'OK', message: report.error.message ?? ''}, artifacts: files.map(artifact)};
        }
      }
      signal.throwIfAborted();
      if (name !== 'material_preflight' && performance.now() - started > definition.timeoutMs) return failure(errors, 'TIMEOUT');
      const result = checkResult(definition, success(data));
      if (name !== 'material_preflight' || data.status === 'completed') cache.set(key, result);
      return result;
    } catch (error) {
      return failure(errors, signal.aborted ? 'ABORTED' : Object.hasOwn(errors, error.code) ? error.code : name === 'analyze_csv' ? 'INVALID_CSV' : 'INTERNAL');
    }
  }};
}
