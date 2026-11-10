import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditLimits, auditWorkflow, digest, validatePlan } from '../src/workflow.mjs';
import { createAuditTools } from '../src/audit-tools.mjs';
import { config } from '../src/config.mjs';
import { localModel } from './local-model.mjs';
import { assemblePlan } from '../src/audit-planner.mjs';
import { parseCsv } from '../src/skills.mjs';
import { headerVariants, dictionaryMappings } from '../bench/header-variants.mjs';
import { auditRuntime } from '../src/audit-skills.mjs';
import { exactMappings, rulePlan } from '../src/audit-rules.mjs';

const {values} = parseArgs({options: {model: {type: 'string'}, effort: {type: 'string', default: 'default'},
  count: {type: 'string', default: '10'}, repeats: {type: 'string', default: '1'},
  seconds: {type: 'string'}, 'full-context': {type: 'boolean'}, concurrency: {type: 'string', default: '2'}, tag: {type: 'string'},
  headers: {type: 'string', default: 'original'}, baseline: {type: 'string', default: 'exact'}}});
if (!['original', 'variants'].includes(values.headers) || !['exact', 'dictionary'].includes(values.baseline)) throw Error('Invalid benchmark arm');
if (values.tag && !/^[a-z0-9-]{1,30}$/i.test(values.tag)) throw Error('Invalid benchmark tag');
const positive = (value, max) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error('Invalid benchmark limit: ' + value);
  return n;
};
const count = positive(values.count, 10), repeatCount = positive(values.repeats, 5), concurrency = positive(values.concurrency, 4);
const data = new URL('../bench/public-data/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', data), 'utf8'));
const tables = manifest.tables.slice(0, count);
const vocabularyHash = digest({headerVariants, synonymGroups: (await import('../bench/header-variants.mjs')).synonymGroups});
const model = values.model ? await localModel(values.model, values.effort) : null;
const label = model ? model.label.replace(/[^a-zA-Z0-9.-]/g, '_') : values.baseline === 'dictionary' ? 'rules-dictionary' : 'rules';
const output = resolve('.skillinter/evaluation/public');
await mkdir(output, {recursive: true});
const runName = label + (values.headers === 'variants' ? '-headers' : '') + (values.tag ? '-' + values.tag : '') + (values['full-context'] ? '-full-context' : '') +
  (repeatCount > 1 ? '-n' + count + '-r' + repeatCount : count !== 10 && !values['full-context'] ? '-n' + count : '');
const task = '00000000-0000-0000-0000-000000000002';
const id = '00000000-0000-0000-0000-000000000001';

async function rules({file, spec}) {
  const started = performance.now();
  const tools = createAuditTools({file, task, request: spec.request, limits: config.audit});
  const inspection = await tools.execute('inspect_table', {});
  if (!inspection.ok) return {status: 'failed', mappings: [], error: inspection.error, metrics: {toolCalls: 1, modelCalls: 0, elapsedMs: performance.now() - started}};
  const proposed = values.baseline === 'dictionary' ? dictionaryMappings(inspection.data.headers, spec.request) : exactMappings(inspection.data.headers, spec.request);
  const plan = values.baseline === 'dictionary' && proposed.length === spec.request.fields.length
    ? assemblePlan({status: 'ready', questions: [], rationale: '开发集词典唯一匹配', mappings: proposed.map(({target, source, sourceUnit}) => ({target, source, sourceUnit}))}, {profile: false})
    : rulePlan(inspection.data.headers, spec.request);
  if (plan.status === 'needs_input') return {status: 'needs_input', mappings: proposed, error: {},
    metrics: {toolCalls: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: performance.now() - started, cost: 0}};
  if (validatePlan(plan).length) throw Error('Invalid rules plan');
  const align = await tools.execute('align_fields', plan.steps[0].arguments);
  const result = align.ok ? await tools.execute('validate_rows', {}) : align;
  return {status: result.ok ? 'completed' : 'failed', mappings: align.data?.mappings ?? [],
    validation: result.data ?? {}, error: result.ok ? {} : result.error,
    metrics: {toolCalls: align.ok ? 3 : 2, modelCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: performance.now() - started, cost: 0}};
}

async function evaluate(original, repeat) {
  let spec = original;
  let bytes = await readFile(new URL(spec.name, data));
  if (digest(bytes.toString('utf8')) !== spec.sha256) throw Error('Public snapshot hash mismatch: ' + spec.id);
  const originalText = bytes.toString('utf8');
  const dataStart = originalText.indexOf('\n');
  const dataRowsHash = digest(originalText.slice(dataStart));
  if (values.headers === 'variants') {
    const {header} = parseCsv(originalText);
    if (header.some(name => !Object.hasOwn(headerVariants, name))) throw Error('Missing frozen header variant: ' + spec.id);
    const renamed = header.map(name => headerVariants[name]);
    if (new Set(renamed).size !== renamed.length) throw Error('Duplicate transformed header');
    const text = renamed.join(',') + originalText.slice(dataStart);
    bytes = Buffer.from(text);
    if (digest(text.slice(text.indexOf('\n'))) !== dataRowsHash) throw Error('Variant changed row data');
    spec = {...spec, name: 'table-' + String(tables.indexOf(original) + 1).padStart(2, '0') + '.csv', sha256: digest(text),
      gold: Object.fromEntries(Object.entries(spec.gold).map(([target, source]) => [target, headerVariants[source]]))};
  }
  const file = {id, name: spec.name, bytes, sha256: spec.sha256};
  let report;
  if (model) {
    const limits = {...auditLimits(model.label)};
    if (values.seconds) limits.maxSeconds = positive(values.seconds, 300);
    const result = await auditWorkflow({file, task, goal: spec.goal, request: spec.request, model, limits, compact: !values['full-context']});
    report = result.report;
    await writeFile(resolve(output, runName + '-' + spec.id + '-' + repeat + '-replay.json'), JSON.stringify(result.replay, null, 2));
    await writeFile(resolve(output, runName + '-' + spec.id + '-' + repeat + '-report.json'), JSON.stringify(report, null, 2));
  } else report = await rules({file, spec});
  const predictions = Object.fromEntries(report.mappings.map(row => [row.target, row.source]));
  const expected = Object.entries(spec.gold);
  const fields = expected.map(([target, gold]) => ({target, gold, predicted: predictions[target] ?? null,
    outcome: predictions[target] === gold ? 'correct' : predictions[target] ? 'wrong' : 'missing'}));
  const issueCount = report.validation?.issueCount ?? null;
  const taskCorrect = fields.every(field => field.outcome === 'correct') && report.status === 'completed' && report.validation.rows === spec.rows && issueCount === 0;
  const {inputTokens, outputTokens, cost, elapsedMs, usageComplete = !model, modelCalls, toolCalls, reportedModels = [], fingerprints = []} = report.metrics;
  const row = {table: spec.id, source: spec.source, retrievedAt: spec.retrievedAt, sha256: spec.sha256, originalSha256: original.sha256, dataRowsHash, headers: values.headers, sourceRows: spec.rows,
    repeat, status: report.status, taskCorrect, issueCount, errorCode: report.error.code ?? null,
    fields, modelCalls, toolCalls, inputTokens: usageComplete ? inputTokens : null,
    outputTokens: usageComplete ? outputTokens : null, cost, elapsedMs: Math.round(elapsedMs),
    reportedModels, fingerprints, peakGpuBytes: null};
  console.log(JSON.stringify({...row, fields: fields.map(({outcome}) => outcome)}));
  return row;
}
const jobs = tables.flatMap(spec => Array.from({length: repeatCount}, (_, i) => ({spec, repeat: i + 1})));
const results = [];
for (let i = 0; i < jobs.length; i += concurrency) {
  const settled = await Promise.allSettled(jobs.slice(i, i + concurrency).map(({spec, repeat}) => evaluate(spec, repeat)));
  for (const item of settled) {
    if (item.status === 'rejected') throw item.reason;
    results.push(item.value);
  }
  await writeFile(resolve(output, runName + '-partial.json'), JSON.stringify(results, null, 2));
}
const fields = results.flatMap(row => row.fields);
const confusion = Object.fromEntries(['correct', 'wrong', 'missing'].map(outcome => [outcome, fields.filter(field => field.outcome === outcome).length]));
const durations = results.map(row => row.elapsedMs).sort((a, b) => a - b);
const percentile = p => durations[Math.ceil(p * durations.length) - 1];
const used = results.filter(row => row.inputTokens !== null && row.outputTokens !== null);
const average = (rows, key) => rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null;
const repeatedSignatures = tables.map(spec => results.filter(row => row.table === spec.id)
  .map(row => JSON.stringify({status: row.status, predictions: row.fields.map(field => field.predicted), issues: row.issueCount})));
const summary = {mode: model ? 'live-model-in-loop' : 'rules-only-' + values.baseline, runtime: auditRuntime, headers: values.headers, vocabularyHash, requestedModel: model?.label ?? null,
  compact: !values['full-context'], tables: tables.length, runs: results.length, repeats: repeatCount, confusion,
  taskSuccess: results.filter(row => row.taskCorrect).length, fieldAccuracy: confusion.correct / fields.length,
  p50Ms: percentile(.50), p95Ms: percentile(.95), meanInputTokens: average(used, 'inputTokens'),
  meanOutputTokens: average(used, 'outputTokens'), usageRows: used.length, meanCost: average(results.filter(row => row.cost !== null), 'cost'),
  consistentTables: repeatCount > 1 ? repeatedSignatures.filter(group => new Set(group).size === 1).length : null,
  peakGpuBytes: null, results};
const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const header = ['table','repeat','target','gold','predicted','outcome','status','taskCorrect','inputTokens','outputTokens','elapsedMs','cost','source','retrievedAt'];
const rows = results.flatMap(row => row.fields.map(field => header.map(key => csvCell(field[key] ?? row[key])).join(',')));
await writeFile(resolve(output, runName + '.csv'), [header.join(','), ...rows].join('\n') + '\n');
await writeFile(resolve(output, runName + '.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({...summary, results: undefined}, null, 2));
