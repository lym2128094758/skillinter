const normalized = name => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function exactMappings(headers, request) {
  return request.fields.flatMap(({name, unit}) => {
    if (unit) return [];
    const hits = headers.filter(header => normalized(name) === normalized(header));
    return hits.length === 1 ? [{target: name, source: hits[0], sourceUnit: '', evidence: 1, rationale: '表头规范化后完全匹配'}] : [];
  });
}

export function rulePlan(headers, target) {
  const mappings = exactMappings(headers, target);
  const unique = new Set(mappings.map(row => row.source)).size === mappings.length;
  if (!unique || mappings.length !== target.fields.length) {
    return {status: 'needs_input', questions: ['规则预检需要目标字段与实际表头一一匹配且不要求换算。请确认字段名与单位，或使用模型预检。'],
      rationale: '未满足精确映射条件', steps: []};
  }
  return {status: 'ready', questions: [], rationale: '规范化精确匹配',
    steps: [{id: 'align', tool: 'align_fields', depends_on: [], arguments: {mappings}, acceptance: '列名存在'},
      {id: 'validate', tool: 'validate_rows', depends_on: ['align'], arguments: {}, acceptance: '检查全部记录'}]};
}

export function rulesModel() {
  return {label: '本地规则预检', kind: 'rules', async invoke({messages}) {
    const {inspection, target} = JSON.parse(messages.at(-1).content);
    return {content: JSON.stringify(rulePlan(inspection.headers, target)), finishReason: 'stop',
      usage: {prompt_tokens: 0, completion_tokens: 0}};
  }};
}
