import { citationSchema } from './audit-tools.mjs';
import { object, validate } from './schema.mjs';

const string = {type: 'string'};
const version = {enum: [2]};
const integer = {type: 'integer', minimum: 1};
const common = {schema_version: version, source_sha256: string, source_record: integer, source_column: string, evidence: string};
const mapping = object({...common, target: string, source: string, source_unit: string, target_unit: string,
  factor: {type: 'number'}, review: {enum: ['required']}});
const issue = object({...common, code: {enum: ['MISSING_VALUE', 'INVALID_TYPE', 'OUT_OF_RANGE']}, field: string, value: string});
const rowSource = ref => ({source_sha256: ref.sha256, source_record: ref.record, source_column: ref.column, evidence: ref.url});

function escapeCell(value) {
  let text = String(value);
  if (typeof value === 'string' && /^\s*[=+@\-\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function table(name, schema, rows) {
  const columns = Object.keys(schema.properties);
  for (const row of rows) {
    const errors = validate(schema, row);
    if (errors.length) throw new Error(name + ' 不符合契约：' + errors.join(', '));
  }
  const cells = rows.map(row => columns.map(key => row[key]));
  return {name, schema, columns, rows: rows.length, bytes: '\uFEFF' + [columns, ...cells].map(row => row.map(escapeCell).join(',')).join('\r\n') + '\r\n'};
}

export function auditExports(report, reportSchema, task) {
  const mappings = table('mapping.csv', mapping, report.mappings.map(row => ({
    schema_version: 2, ...rowSource(row.evidence), target: row.target, source: row.source, source_unit: row.sourceUnit,
    target_unit: row.targetUnit, factor: row.factor, review: 'required',
  })));
  const issues = table('issues.csv', issue, (report.validation.issues ?? []).map(row => ({
    schema_version: 2, ...rowSource(row.evidence), code: row.code, field: row.field, value: row.value,
  })));
  const references = [...report.mappings, ...(report.validation.issues ?? []), ...(report.profile.columns ?? [])]
    .map(row => row.evidence);
  if (Object.hasOwn(report.validation, 'rows')) references.push(report.citations.find(ref => ref.record === 1 && !ref.column));
  const validRefs = new Set(report.citations.map(ref => JSON.stringify(ref)));
  const cited = references.filter(ref => ref && !validate(citationSchema, ref).length &&
    ref.file === report.source.id && ref.sha256 === report.source.sha256 &&
    ref.url === '/api/tasks/' + task + '/files/' + ref.file + '/evidence?record=' + ref.record +
      (ref.column ? '&column=' + encodeURIComponent(ref.column) : '') && validRefs.has(JSON.stringify(ref))).length;
  if (cited !== references.length) throw new Error('报告存在无效或缺失的证据引用');
  const artifactCheck = {version: 2, checks: {reportSchema: 'passed', mappingRows: mappings.rows, issueRows: issues.rows,
    evidenceAssertions: references.length, citedAssertions: cited},
    files: {'report.json': {schema: reportSchema}, ...Object.fromEntries([mappings, issues].map(({name, schema, columns, rows}) =>
      [name, {encoding: 'UTF-8 BOM', separator: ',', lineEnding: 'CRLF', schema, columns, validatedRows: rows,
        textEscape: 'Spreadsheet formulas and control-character prefixes are quoted as literal text.'}]))}};
  return {artifactCheck, artifacts: [
    ...[mappings, issues].map(({name, bytes}) => ({name, bytes, kind: 'csv'})),
    {name: 'artifact-contract.json', bytes: JSON.stringify(artifactCheck, null, 2), kind: 'json'},
  ]};
}
