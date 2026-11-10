import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditWorkflow, digest } from '../src/workflow.mjs';
import { config } from '../src/config.mjs';
import { cases, fixtureModel } from '../bench/cases.mjs';

const output = resolve('.skillinter/evaluation');
await mkdir(output, {recursive: true});
const results = [];
const evidence = {assertions: 0, cited: 0, reportSchemasPassed: 0};
function key(report) {
  return {status: report.status, mappings: report.mappings, validation: report.validation, profile: report.profile,
    questions: report.questions, citations: report.citations, errorCode: report.error.code};
}
for (const test of cases) {
  const signatures = [], passes = [], reports = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const bytes = Buffer.from(test.text);
    const file = {id: '00000000-0000-0000-0000-000000000001', name: `${test.id}.csv`, bytes, sha256: digest(test.text)};
    try {
      const {report, artifactCheck} = await auditWorkflow({file, task: '00000000-0000-0000-0000-000000000002', goal: test.goal,
        request: test.request, model: fixtureModel(test), limits: {...config.audit, ...test.limits}});
      evidence.assertions += artifactCheck.checks.evidenceAssertions;
      evidence.cited += artifactCheck.checks.citedAssertions;
      evidence.reportSchemasPassed++;
      const expected = test.expected;
      const pass = report.status === expected.status && (expected.issueCount === undefined || report.validation.issueCount === expected.issueCount)
        && (expected.rows === undefined || report.validation.rows === expected.rows)
        && (expected.factor === undefined || report.mappings.find(item => item.target === 'mass')?.factor === expected.factor)
        && (expected.code === undefined || report.error.code === expected.code)
        && (expected.replans === undefined || report.metrics.replans === expected.replans);
      signatures.push(digest(key(report))); passes.push(pass); reports.push(report);
    } catch (error) { signatures.push('crash'); passes.push(false); reports.push({crash: error.message}); }
  }
  const row = {id: test.id, pass: passes.every(Boolean), consistent: new Set(signatures).size === 1,
    crashes: reports.filter(report => report.crash).length, status: reports[0].status, issues: reports[0].validation?.issueCount ?? '',
    replans: reports[0].metrics?.replans ?? '', elapsedMs: reports[0].metrics?.elapsedMs ?? ''};
  results.push(row);
  if (!row.pass) console.error('FAIL', test.id, JSON.stringify(reports[0]));
}
const summary = {mode: 'synthetic-authored-planner-regression', date: new Date().toISOString(), node: process.version,
  cases: cases.length, runs: cases.length * 5, passed: results.filter(row => row.pass).length,
  consistent: results.filter(row => row.consistent).length, crashes: results.reduce((sum, row) => sum + row.crashes, 0),
  evidence, meaning: '使用固定规划夹具验证工具、契约、预算与编排回归。', results};
await writeFile(resolve(output, 'results.json'), JSON.stringify(summary, null, 2));
const columns = ['id', 'pass', 'consistent', 'crashes', 'status', 'issues', 'replans', 'elapsedMs'];
await writeFile(resolve(output, 'results.csv'), [columns.join(','), ...results.map(row => columns.map(key => row[key]).join(','))].join('\n'));
console.log(JSON.stringify({...summary, results: undefined, output}, null, 2));
if (summary.passed !== cases.length || summary.crashes) process.exitCode = 1;
