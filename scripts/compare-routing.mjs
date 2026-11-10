import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditRuntime } from '../src/audit-skills.mjs';
import { rulesModel } from '../src/audit-rules.mjs';
import { recordedModel } from '../src/replay.mjs';
import { auditWorkflow, digest, reportFingerprint } from '../src/workflow.mjs';
import { config } from '../src/config.mjs';
import { localModel } from './local-model.mjs';

const recordLive = process.argv.includes('--record');
const published = resolve('docs/evidence/v4/routing');
const directory = recordLive ? resolve('.skillinter/evaluation/skill-routing-v4') : published;
if (recordLive) {
  await mkdir(directory, {recursive: true});
  const model = await localModel('minimax-m3');
  for (let index = 0; index < 2; index++) {
    const {replay} = JSON.parse(await readFile(resolve(published, index + '.json'), 'utf8'));
    const result = await auditWorkflow({file: {...replay.source, bytes: Buffer.from(replay.source.text)}, task: replay.task,
      goal: replay.goal, request: replay.request, limits: {...config.audit, maxSeconds: 90}, compact: replay.compact, model});
    await writeFile(resolve(directory, index + '.json'), JSON.stringify({report: result.report, replay: result.replay, skillTrace: result.skillTrace}, null, 2));
  }
}
const rows = [];
const csv = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';

function summarize(name, arm, source, request, result, expected, provenance) {
  const {report, skillTrace} = result;
  const mass = report.mappings.find(mapping => mapping.target === 'mass');
  const converted = Boolean(mass?.targetUnit && mass.sourceUnit && report.status === 'completed');
  const byTarget = Object.fromEntries(report.mappings.map(mapping => [mapping.target, mapping.source]));
  const pass = report.status === expected.status && converted === expected.converted &&
    (!expected.groundTruth || Object.entries(expected.groundTruth).every(([target, value]) => byTarget[target] === value)) &&
    (expected.factor === undefined || mass?.factor === expected.factor) &&
    (expected.issues === undefined || report.validation.issueCount === expected.issues) &&
    (!expected.codes || expected.codes.join(',') === (report.validation.issues ?? []).map(issue => issue.code).join(',')) &&
    (!expected.rejectedByUnitGate || skillTrace.selection.outcome === 'no_eligible_plan');
  rows.push({case: name, arm, sourceHash: source.sha256, targetHash: digest(request), provenance,
    modelCalls: report.metrics.modelCalls, status: report.status, converted, factor: converted ? mass.factor : null,
    observedRows: report.validation.rows ?? null, issues: report.validation.issueCount ?? null, expected: expected.status, pass});
}

const cases = [
  {name: 'public-rice', expected: {status: 'completed', converted: false, issues: 0,
    groundTruth: {perimeter: 'Perimeter', major_axis_length: 'Major_Axis_Length'}}},
  {name: 'synthetic-explicit-unit', expected: {status: 'completed', converted: true, factor: 1000, issues: 2,
    codes: ['OUT_OF_RANGE', 'INVALID_TYPE'], groundTruth: {sample_id: 'sample_id', mass: 'mass_g'}}},
];
for (const [index, item] of cases.entries()) {
  const record = JSON.parse(await readFile(resolve(directory, index + '.json'), 'utf8'));
  const {replay} = record;
  assert.equal(replay.runtime.sha256, auditRuntime.sha256, '运行器必须和实测记录一致');
  assert.equal(digest(replay.source.text), replay.source.sha256);
  assert.ok(record.report.metrics.reportedModels.includes('minimax-m3'));
  const options = {file: {...replay.source, bytes: Buffer.from(replay.source.text)}, task: replay.task,
    goal: replay.goal, request: replay.request, limits: replay.limits, compact: replay.compact};
  const live = await auditWorkflow({...options, model: recordedModel(replay)});
  assert.equal(reportFingerprint(live.report), replay.reportHash);
  assert.equal(digest(live.skillTrace), replay.skillTraceHash);
  const rules = await auditWorkflow({...options, model: rulesModel()});
  summarize(item.name, 'rules-only', replay.source, replay.request, rules, index === 0 ? item.expected :
    {status: 'needs_input', converted: false}, 'current-local-rule');
  summarize(item.name, 'model-in-loop', replay.source, replay.request, live, item.expected, 'recorded-and-verified-minimax-m3');
}
const text = 'sample_id,净重\nA,2\n';
const source = {name: 'missing-unit.csv', id: 'fixture', sha256: digest(text), bytes: Buffer.from(text)};
const request = {fields: [{name: 'mass', type: 'number', unit: 'mg', required: true}]};
const model = {label: 'minimax-m3', async invoke() { throw new Error('缺单位路径不得调用模型'); }};
for (const [arm, planner] of [['rules-only', rulesModel()], ['model-in-loop', model]]) {
  const result = await auditWorkflow({file: source, task: 'routing-comparison', goal: '统一质量为 mg', request, model: planner});
  assert.equal(result.report.metrics.modelCalls, 0);
  summarize('synthetic-missing-unit', arm, source, request, result,
    {status: 'needs_input', converted: false, rejectedByUnitGate: true}, 'current-deterministic-unit-gate');
}
assert.ok(rows.every(row => row.pass));
const output = resolve('.skillinter/evaluation');
await mkdir(output, {recursive: true});
const header = Object.keys(rows[0]);
await writeFile(resolve(output, 'routing-paired.csv'), header.join(',') + '\n' + rows.map(row =>
  header.map(key => csv(row[key])).join(',')).join('\n') + '\n');
console.log(JSON.stringify(rows, null, 2));
