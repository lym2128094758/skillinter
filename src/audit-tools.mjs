import { parseCsv, utf8 } from './skills.mjs';
import { object, string, validate } from './schema.mjs';
import { config } from './config.mjs';
import { checkResult, failure, resultSchema, success } from './tool-contract.mjs';

export const fieldSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'type', 'required'],
  properties: {name: {...string, minLength: 1, maxLength: 100}, type: {enum: ['string', 'number', 'integer']},
    required: {type: 'boolean'}, unit: {...string, maxLength: 40}, minimum: {type: 'number'}, maximum: {type: 'number'}},
};
export const requestSchema = object({fields: {type: 'array', minItems: 1, maxItems: 40, items: fieldSchema}});
export const mappingSchema = object({target: {...string, minLength: 1}, source: string, sourceUnit: string,
  evidence: {type: 'integer', minimum: 1}, rationale: {...string, minLength: 1}});
const mappings = {type: 'array', minItems: 1, maxItems: 40, items: mappingSchema};
export const citationSchema = object({file: string, sha256: string, record: {type: 'integer', minimum: 1}, column: string, url: string});
export const alignedSchema = object({target: string, source: string, sourceUnit: string, targetUnit: string,
  factor: {type: 'number'}, sourceIndex: {type: 'integer', minimum: 0}, evidence: citationSchema, rationale: string});
export const issueSchema = object({code: {enum: ['MISSING_VALUE', 'INVALID_TYPE', 'OUT_OF_RANGE']}, field: string, value: {type: 'string'}, evidence: citationSchema});
export const validationSchema = object({rows: {type: 'integer', minimum: 0}, issueCount: {type: 'integer', minimum: 0},
  issues: {type: 'array', items: issueSchema}, truncated: {type: 'boolean'}});
export const profileSchema = object({columns: {type: 'array', items: object({name: string,
  empty: {type: 'integer', minimum: 0}, numeric: {type: 'integer', minimum: 0}, other: {type: 'integer', minimum: 0}, evidence: citationSchema})}});
const outputs = {
  inspect_table: object({headers: {type: 'array', items: {type: 'string'}}, rows: {type: 'integer', minimum: 0},
    sample: {type: 'array', maxItems: config.audit.sampleRows, items: {type: 'array', items: {type: 'string'}}}}),
  align_fields: object({mappings: {type: 'array', items: alignedSchema}}),
  validate_rows: validationSchema, profile_table: profileSchema,
};
const definitions = [
  {name: 'inspect_table', description: 'Inspect headers, record count and bounded samples from the immutable uploaded CSV.', parameters: object({})},
  {name: 'align_fields', description: 'Validate model-proposed source/target mappings against actual headers and explicit units. No guessing or fuzzy conversions.', parameters: object({mappings})},
  {name: 'validate_rows', description: 'Check mapped values against required fields, numeric types and numeric ranges, with source record references.', parameters: object({})},
  {name: 'profile_table', description: 'Count empty, numeric and non-numeric cells per source column.', parameters: object({})},
];
const errors = {INVALID_ARGUMENT: '参数格式无效。', INVALID_CSV: 'CSV 格式无效。', MAPPING_INVALID: '字段映射无效。',
  UNIT_UNKNOWN: '单位证据不足。', UNIT_UNSUPPORTED: '未支持的单位换算。', DEPENDENCY_MISSING: '缺少前置步骤。',
  ABORTED: '操作已取消。', TIMEOUT: '工具执行超时。', UNKNOWN_TOOL: '工具不存在。', INTERNAL: '工具执行失败。'};
export const auditTools = definitions.map(tool => ({...tool,
  returns: resultSchema(object({...outputs[tool.name].properties, citations: {type: 'array', items: citationSchema}})),
  errors, timeoutMs: config.tools.timeoutMs, timeoutMode: '同步有界操作，检查执行耗时；运行后不接受超时结果。',
  idempotent: true, authorization: '本机同源会话。仅可访问属于同一任务的不可变 CSV 附件。',
  volatile: [], ordering: '来源列按原表顺序；映射按目标字段顺序；问题按逻辑行和目标字段顺序。',
  ...(tool.name === 'validate_rows' ? {dependsOn: ['align_fields']} : {}),
}));

const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const units = {kg: ['mass', 1000], g: ['mass', 1], mg: ['mass', .001], ug: ['mass', .000001],
  l: ['volume', 1000], ml: ['volume', 1], ul: ['volume', .001], m: ['length', 1000], cm: ['length', 10], mm: ['length', 1]};
export const unitKey = value => value.trim().toLowerCase().replaceAll('μ', 'u').replaceAll('µ', 'u');
export const unitTokens = value => unitKey(String(value)).split(/[^a-z0-9%/]+/).filter(Boolean);
export function compatibleUnits(source, target) {
  return source === target || (Object.hasOwn(units, source) && Object.hasOwn(units, target) && units[source][0] === units[target][0]);
}
function stop(code, message) { throw Object.assign(new Error(message), {code}); }
export function validateRequest(request) {
  const errors = validate(requestSchema, request);
  if (errors.length) return errors;
  if (new Set(request.fields.map(field => field.name)).size !== request.fields.length) errors.push('目标字段名称重复');
  for (const field of request.fields) {
    if (!field.name.trim() || field.name === '__proto__') errors.push('无效字段名称');
    if (field.unit !== undefined && field.unit !== '' && !field.unit.trim()) errors.push('单位不能只包含空白字符');
    if (field.type === 'string' && (field.unit || field.minimum !== undefined || field.maximum !== undefined)) errors.push('文本字段不接受单位或数值范围');
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) errors.push('最小值大于最大值');
  }
  return errors;
}

export function createAuditTools({file, task, request, limits, signal, observe = () => {}}) {
  let table, alignment;
  function citation(row = 1, column = '') {
    return {file: file.id, sha256: file.sha256, record: row, column,
      url: `/api/tasks/${task}/files/${file.id}/evidence?record=${row}${column ? `&column=${encodeURIComponent(column)}` : ''}`};
  }
  function load() {
    if (!table) {
      let parsed;
      try { parsed = parseCsv(utf8(file.bytes)); } catch (error) { stop('INVALID_CSV', error.message); }
      if (parsed.rows.length > limits.maxRows) stop('INVALID_CSV', '超过本次任务的数据行预算');
      if (parsed.header.some(name => name.length > 300)) stop('INVALID_CSV', 'CSV 列名最多支持 300 字');
      for (const [index, row] of parsed.rows.entries()) {
        if (row.length !== parsed.header.length) stop('INVALID_CSV', `第 ${index + 2} 条逻辑记录列数与表头不一致`);
      }
      table = parsed;
    }
    return table;
  }
  const handlers = {
    inspect_table() {
      const {header, rows} = load();
      const sampleChars = limits.sampleChars ?? config.audit.sampleChars;
      return {data: {headers: header, rows: rows.length, sample: rows.slice(0, limits.sampleRows ?? config.audit.sampleRows)
        .map(row => row.map(value => value.length > sampleChars ? value.slice(0, sampleChars) + '…' : value))}, citations: [citation()]};
    },
    align_fields({mappings}) {
      const {header, rows} = load();
      if (mappings.length !== request.fields.length || new Set(mappings.map(mapping => mapping.target)).size !== mappings.length) stop('MAPPING_INVALID', '每个目标字段必须恰有一个映射');
      const selected = [];
      for (const field of request.fields) {
        const mapping = mappings.find(item => item.target === field.name);
        if (!mapping || !header.includes(mapping.source)) stop('MAPPING_INVALID', `字段 ${field.name} 的来源不存在，须重新规划或询问用户`);
        if (mapping.evidence > rows.length + 1) stop('MAPPING_INVALID', '映射依据记录不存在');
        const col = header.indexOf(mapping.source);
        const evidence = mapping.evidence === 1 ? header[col] : rows[mapping.evidence - 2][col];
        let factor = 1;
        if (field.unit) {
          const sourceUnit = unitKey(mapping.sourceUnit);
          const tokens = unitTokens(evidence);
          if (!sourceUnit || !tokens.includes(sourceUnit)) stop('UNIT_UNKNOWN', `字段 ${field.name} 的来源单位没有原文证据，需询问用户`);
          if (unitKey(field.unit) !== unitKey(mapping.sourceUnit)) {
            const source = Object.hasOwn(units, sourceUnit) ? units[sourceUnit] : null;
            const targetKey = unitKey(field.unit), target = Object.hasOwn(units, targetKey) ? units[targetKey] : null;
            if (!source || !target || source[0] !== target[0]) stop('UNIT_UNSUPPORTED', `字段 ${field.name} 的单位换算尚不支持`);
            factor = source[1] / target[1];
          }
        }
        selected.push({target: field.name, source: mapping.source, sourceUnit: mapping.sourceUnit,
          targetUnit: field.unit ?? '', factor, sourceIndex: col, evidence: citation(mapping.evidence, mapping.source),
          rationale: mapping.rationale});
      }
      if (new Set(selected.map(item => item.source)).size !== selected.length) stop('MAPPING_INVALID', '一个来源列映射到多个目标字段，请澄清');
      alignment = selected;
      return {data: {mappings: selected}, citations: selected.map(item => item.evidence)};
    },
    validate_rows() {
      if (!alignment) stop('DEPENDENCY_MISSING', 'validate_rows 之前须成功执行 align_fields');
      const {rows} = load();
      const issues = [];
      let issueCount = 0;
      const checks = alignment.map(mapping => ({mapping, field: request.fields.find(field => field.name === mapping.target)}));
      for (const [index, row] of rows.entries()) {
        signal?.throwIfAborted();
        for (const {mapping, field} of checks) {
          const value = row[mapping.sourceIndex].trim();
          const number = numeric.test(value) ? Number(value) * mapping.factor : NaN;
          let code;
          if (!value && field.required) code = 'MISSING_VALUE';
          else if (value && field.type !== 'string' && (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)))) code = 'INVALID_TYPE';
          else if (value && field.type !== 'string' && (number < (field.minimum ?? -Infinity) || number > (field.maximum ?? Infinity))) code = 'OUT_OF_RANGE';
          if (code) {
            issueCount++;
            if (issues.length < limits.maxIssues) issues.push({code, field: field.name, value,
              evidence: citation(index + 2, mapping.source)});
          }
        }
      }
      return {data: {rows: rows.length, issueCount, issues, truncated: issueCount > issues.length}, citations: [citation()]};
    },
    profile_table() {
      const {header, rows} = load();
      const columns = header.map((name, col) => {
        let empty = 0, numbers = 0;
        for (const row of rows) {
          const value = row[col].trim();
          if (!value) empty++;
          else if (numeric.test(value) && Number.isFinite(Number(value))) numbers++;
        }
        return {name, empty, numeric: numbers, other: rows.length - empty - numbers, evidence: citation(1, name)};
      });
      return {data: {columns}, citations: [citation()]};
    },
  };
  if (auditTools.some(tool => !handlers[tool.name])) throw new Error('Audit tool contract mismatch');
  return {citation, async execute(name, args) {
    const begin = performance.now();
    const definition = auditTools.find(tool => tool.name === name);
    let result, diagnostic;
    try {
      signal?.throwIfAborted();
      if (!definition) stop('UNKNOWN_TOOL', '工具不存在');
      const invalid = validate(definition.parameters, args);
      if (invalid.length) stop('INVALID_ARGUMENT', invalid.join('; '));
      const output = handlers[name](args);
      if (performance.now() - begin > definition.timeoutMs) stop('TIMEOUT', '工具时间预算已耗尽');
      result = success({...output.data, citations: output.citations});
    } catch (error) {
      const code = signal?.aborted ? 'ABORTED' : Object.hasOwn(errors, error.code) ? error.code : 'INTERNAL';
      result = failure(errors, code);
      diagnostic = error.message.slice(0, 300);
    }
    if (definition) checkResult(definition, result);
    observe({tool: name, arguments: args, result, ...(diagnostic ? {diagnostic} : {}),
      volatile: {elapsedMs: Math.round(performance.now() - begin)}});
    return result;
  }};
}
