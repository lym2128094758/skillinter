import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditTools, unitKey, compatibleUnits, unitTokens } from './audit-tools.mjs';

// A skill binds a tool to eligibility, dependencies and a named typed artifact.
const skill = (id, label, tool, nodeId, applies, consumes, produces) => {
  const contract = auditTools.find(item => item.name === tool);
  return {id, version: '1.0.0', label, tool, nodeId, applies, consumes, produces, outputSchema: contract.returns};
};

export const auditSkills = [
  skill('csv-inspect', '表头与样本检查', 'inspect_table', 'xlsx',
    '输入必须是当前任务的 CSV 附件。', [], 'inspected_csv'),
  skill('field-align', '字段映射', 'align_fields', 'gh-claude-database-schema-designer-aff360',
    '已读取 CSV 表头，且目标字段未指定单位。', ['inspected_csv'], 'field_mapping'),
  skill('unit-align', '带单位的字段映射', 'align_fields', 'gh-scientific-uncertainty-and-units-ccb540',
    '已读取 CSV 表头。每个要求单位的字段须有至少一个单位兼容的原始列，映射时复核具体列。', ['inspected_csv'], 'field_mapping'),
  skill('row-validate', '逐行质量检查', 'validate_rows', 'gh-claude-data-quality-auditor-9d8e63',
    '已生成字段映射及换算系数。', ['field_mapping'], 'row_findings'),
  skill('column-profile', '原始列统计', 'profile_table', 'eda-profiling',
    '已读取 CSV 表头。统计原始列，可按任务需求选用。', ['inspected_csv'], 'column_statistics'),
];
const byId = new Map(auditSkills.map(item => [item.id, item]));
const checksum = value => createHash('sha256').update(value).digest('hex');
export const skillRegistry = {version: 1, sha256: checksum(JSON.stringify(auditSkills)), skills: auditSkills};
export const auditRuntime = {
  version: 4,
  sha256: checksum(JSON.stringify(['workflow', 'audit-planner', 'audit-skills', 'audit-tools', 'audit-rules', 'artifact-contract', 'skills', 'schema', 'tool-contract']
    .map(name => [name, checksum(readFileSync(new URL('./' + name + '.mjs', import.meta.url)))]))),
};
const ref = item => ({id: item.id, version: item.version, tool: item.tool, label: item.label, nodeId: item.nodeId});

export function selectAuditSkills(inspection, request, evidence) {
  const requiredUnits = request.fields.filter(field => field.unit?.trim());
  const mapping = byId.get(requiredUnits.length ? 'unit-align' : 'field-align');
  const missing = requiredUnits.flatMap(field => {
    const candidateColumns = inspection.headers.filter(header =>
      unitTokens(header).some(unit => compatibleUnits(unit, unitKey(field.unit))));
    return candidateColumns.length ? [] : [{code: 'SOURCE_UNIT_MISSING', field: field.name, expectedUnit: field.unit, evidence}];
  });
  const eligible = missing.length ? [] : [mapping, byId.get('row-validate'), byId.get('column-profile')];
  return {
    method: 'deterministic-eligibility',
    outcome: missing.length ? 'no_eligible_plan' : 'candidates_available',
    candidates: eligible.map(ref),
    missing,
  };
}

export function skillPlan(plan, selection, attempt) {
  const inspect = byId.get('csv-inspect');
  const steps = [{step: '$input', ...ref(inspect), dependsOn: [], consumes: inspect.consumes, produces: inspect.produces}];
  const align = plan.steps.find(step => step.tool === 'align_fields');
  for (const step of plan.steps) {
    const candidate = selection.candidates.find(item => item.tool === step.tool);
    const entry = byId.get(candidate.id);
    const dependencies = new Set(step.depends_on);
    if (entry.consumes.includes('inspected_csv')) dependencies.add('$input');
    if (entry.consumes.includes('field_mapping')) dependencies.add(align.id);
    steps.push({step: step.id, ...ref(entry), dependsOn: [...dependencies], consumes: entry.consumes,
      produces: entry.produces, acceptance: step.acceptance});
  }
  return {attempt, steps};
}

export function projectSkillGraph(events) {
  const plan = events.findLast(event => event.type === 'audit_skill_plan')?.payload;
  if (!plan) return {attempt: null, nodes: [], edges: []};
  const receipts = new Map(events.filter(event => event.type === 'audit_skill_step' &&
    (event.payload.attempt === plan.attempt || event.payload.step === '$input')).map(event => [event.payload.step, event.payload]));
  return {attempt: plan.attempt, nodes: plan.steps.map(step => ({step: step.step, id: step.id, version: step.version,
    label: step.label, nodeId: step.nodeId, state: receipts.get(step.step)?.state ?? 'planned'})),
    edges: plan.steps.flatMap(step => step.dependsOn.map(from => ({from, to: step.step})))};
}
