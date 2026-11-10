import { object, string, validate } from './schema.mjs';
import { resultSchema, success, failure } from './tool-contract.mjs';
import { visibleRunContext } from './store.mjs';

const item = object({id: {...string, minLength: 1, maxLength: 40}, title: {...string, minLength: 1, maxLength: 200},
  status: {enum: ['pending', 'in_progress', 'completed', 'blocked']},
  depends_on: {type: 'array', maxItems: 20, items: {...string, maxLength: 40}}});
const snapshot = object({revision: {type: 'integer', minimum: 1}, explanation: {...string, maxLength: 1000},
  steps: {type: 'array', minItems: 1, maxItems: 20, items: item}});
export const planErrors = {INVALID_ARGUMENT: '计划格式无效，步骤编号和标题必须唯一，依赖必须无环。',
  PLAN_CONFLICT: '计划已更新，请按最新版本重试。',
  DEPENDENCY_INCOMPLETE: '前置步骤尚未完成，不能开始或完成当前步骤。',
  ABORTED: '操作已取消。'};
export const taskPlanTool = {name: 'update_plan',
  description: '为复杂多步任务创建或更新可见计划。简单问答无需调用。expected_revision 首次为 0，之后使用返回版本。每次提交整份列表，最多一个 in_progress。依赖步骤完成后才能开始下一步。按实际进展更新，阻塞时记录原因，解释计划变更。',
  parameters: object({expected_revision: {type: 'integer', minimum: 0}, explanation: {...string, maxLength: 1000},
    steps: snapshot.properties.steps}),
  returns: resultSchema(snapshot), errors: planErrors, timeoutMs: 1000, idempotent: false,
  volatile: [], ordering: '保持提交的步骤顺序。', authorization: '仅更新服务端绑定的当前会话计划，不授予文件或工具权限。',
  timeoutMode: '本地有界同步校验和事务提交。'};

export function currentPlan(store, task) {
  const row = store.query(`SELECT e.payload FROM events e JOIN runs r ON r.id=e.run JOIN tasks t ON t.id=r.task
    WHERE r.task=? AND e.type='task_plan' AND ${visibleRunContext} ORDER BY e.seq DESC LIMIT 1`, 'get', task);
  return row ? JSON.parse(row.payload) : null;
}

export function updatePlan(store, task, run, args, signal) {
  if (signal.aborted) return failure(planErrors, 'ABORTED');
  if (validate(taskPlanTool.parameters, args).length) return failure(planErrors, 'INVALID_ARGUMENT');
  const steps = args.steps.map(step => ({...step, id: step.id.trim(), title: step.title.trim()}));
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length || new Set(steps.map(step => step.title)).size !== steps.length ||
    steps.some(step => !step.id || !step.title || new Set(step.depends_on).size !== step.depends_on.length) ||
    steps.filter(step => step.status === 'in_progress').length > 1) return failure(planErrors, 'INVALID_ARGUMENT');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id) || !byId.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    if (!byId.get(id).depends_on.every(visit)) return false;
    visiting.delete(id); visited.add(id);
    return true;
  }
  if (!steps.every(step => visit(step.id))) return failure(planErrors, 'INVALID_ARGUMENT');
  if (steps.some(step => ['in_progress', 'completed'].includes(step.status) &&
    step.depends_on.some(id => byId.get(id).status !== 'completed'))) return failure(planErrors, 'DEPENDENCY_INCOMPLETE');
  return store.transaction(() => {
    const latest = currentPlan(store, task);
    if (args.expected_revision !== (latest?.revision ?? 0)) return failure(planErrors, 'PLAN_CONFLICT');
    const plan = {revision: args.expected_revision + 1, explanation: args.explanation.trim(), steps};
    store.record(run, 'task_plan', plan);
    return success(plan);
  });
}
