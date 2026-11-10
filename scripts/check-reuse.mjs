import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuditTools } from '../src/audit-tools.mjs';
import { exactMappings } from '../src/audit-rules.mjs';
import { config } from '../src/config.mjs';
import { digest } from '../src/workflow.mjs';

const data = new URL('../bench/public-data/', import.meta.url);
const {tables} = JSON.parse(await readFile(new URL('manifest.json', data), 'utf8'));
const threshold = {minimumPositiveBatches: 3, minimumNegativeBatches: 5, requireAllPositiveBatchesPass: true,
  maximumWrongOrMissingFields: 0, maximumFalseActivations: 0};
const red = tables.find(item => item.id === 'wine-red');
const white = tables.find(item => item.id === 'wine-white');
const request = red.request;
const reference = {residual_sugar: 'residual_sugar', ethanol_content: 'alcohol'};

async function open(spec) {
  const bytes = await readFile(new URL(spec.name, data));
  if (digest(bytes.toString('utf8')) !== spec.sha256) throw new Error('Snapshot hash mismatch: ' + spec.id);
  const file = {id: spec.id, name: spec.name, sha256: spec.sha256, bytes};
  const tools = createAuditTools({file, task: 'shadow-evaluation', request, limits: config.audit});
  const inspection = await tools.execute('inspect_table', {});
  if (!inspection.ok) throw new Error(inspection.error.message);
  return {tools, headers: inspection.data.headers};
}

const discovery = await open(red);
const candidate = {id: 'wine-quality-mapping', version: 1, scope: red.sourceId, headerHash: digest(discovery.headers),
  trainingFingerprint: red.sha256, targetFingerprint: digest(request),
  mappings: Object.entries(red.gold).map(([target, source]) => ({target, source, sourceUnit: '', evidence: 1,
    rationale: '由公开变量说明核对的候选规则'}))};
const guarded = (spec, headers) => spec.sourceId === candidate.scope && digest(headers) === candidate.headerHash &&
  spec.sha256 !== candidate.trainingFingerprint;
const positive = await open(white);
const baseline = exactMappings(positive.headers, request);
const accepted = guarded(white, positive.headers);
const aligned = accepted ? await positive.tools.execute('align_fields', {mappings: candidate.mappings}) : null;
const validation = aligned?.ok ? await positive.tools.execute('validate_rows', {}) : null;
const hits = aligned?.data?.mappings ?? [];
const negative = [];
for (const spec of tables.filter(item => item.sourceId !== red.sourceId)) {
  const {headers} = await open(spec);
  negative.push({batch: spec.id, synthetic: false, activated: guarded(spec, headers)});
}
negative.push({batch: 'unit-header-changed', synthetic: true,
  activated: guarded(white, positive.headers.map(header => header === 'alcohol' ? 'alcohol_g_L' : header))});
negative.push({batch: 'calibration-file-reused', synthetic: true, activated: guarded(red, discovery.headers)});
const correct = hits.filter(item => reference[item.target] === item.source).length;
const measured = {positiveBatches: 1, negativeBatches: negative.length, coverage: accepted ? 1 : 0,
  positiveBatchesPassed: validation?.ok && correct === request.fields.length ? 1 : 0,
  wrongOrMissingFields: request.fields.length - correct, falseActivations: negative.filter(item => item.activated).length,
  mappingAccuracy: correct / request.fields.length,
  falseActivationRate: negative.filter(item => item.activated).length / negative.length};
const qualifies = measured.positiveBatches >= threshold.minimumPositiveBatches && measured.negativeBatches >= threshold.minimumNegativeBatches &&
  measured.positiveBatchesPassed === measured.positiveBatches && measured.wrongOrMissingFields <= threshold.maximumWrongOrMissingFields &&
  measured.falseActivations <= threshold.maximumFalseActivations;
const report = {status: qualifies ? 'eligible_for_human_review' : 'retained_as_candidate', automaticDeployment: false, threshold, candidate,
  measured, negative, evaluation: {calibration: red.id, heldOut: white.id, independentSource: false, heldOutSha256: white.sha256,
    source: white.source, rows: validation?.data?.rows ?? null, findings: validation?.data?.issueCount ?? null,
    rulesOnlyMatched: baseline.length, shadowReuseMatched: hits.length, correctMappings: correct,
    rulesOnlyWouldAsk: baseline.length === request.fields.length ? 0 : 1, shadowWouldAsk: validation?.ok ? 0 : 1}};
const output = resolve('.skillinter/evaluation');
await mkdir(output, {recursive: true});
await writeFile(resolve(output, 'reuse-shadow.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
