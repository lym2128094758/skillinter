import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { graphHighlightIds } from '../web/skill-runtime.js';

const {values} = parseArgs({options: {task: {type: 'string'}, output: {type: 'string'}, base: {type: 'string', default: 'http://127.0.0.1:3092'}}});
if (!values.task || !values.output) throw new Error('Usage: node scripts/check-skill-session.mjs --task UUID --output DIRECTORY');
const base = new URL(values.base);
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('Only a local SIH service is supported.');
const response = await fetch(new URL('/api/tasks/' + encodeURIComponent(values.task), base));
assert.equal(response.status, 200);
const task = await response.json();
const run = task.runs.findLast(run => run.status === 'completed' && run.skillApplications?.some(application => application.status === 'applied'));
assert.ok(run, 'No completed skill application in this task');
const recorded = await (await fetch(new URL('/api/runs/' + run.id + '/events', base))).text();
const events = recorded.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const applied = run.skillApplications.filter(application => application.status === 'applied');
for (const application of applied) {
  assert.ok(application.evidence.length);
  for (const seq of application.evidence) {
    const event = events.find(event => event.seq === seq);
    assert.ok(event && event.type === 'tool_result' && event.payload.output.ok);
    assert.equal(event.payload.skillId, application.id, 'Receipt owner must match the applied skill');
    assert.ok(!['load_skill', 'read_skill_resource', 'inspect_skill', 'search_skills'].includes(event.payload.name));
  }
}
assert.ok(run.plan?.steps.every(step => step.status === 'completed'), 'The actual task plan remains unfinished');
const graph = JSON.parse(await readFile(new URL('../web/catalog/graph.json', import.meta.url)));
const graphIds = graphHighlightIds(run.skillTrace, new Set(graph.nodes.map(node => node.id)));
const archive = run.artifacts.find(file => file.name === 'skill-execution.json');
assert.ok(archive);
const execution = await (await fetch(new URL('/api/tasks/' + task.id + '/files/' + archive.id, base))).json();
assert.deepEqual(execution.trace.graph, run.skillTrace.graph);
const modelResponses = events.filter(event => event.type === 'model_response').map(event => event.payload);
const successfulWrites = events.filter(event => event.type === 'tool_result' && event.payload.output.ok && ['create_file', 'replace_in_file'].includes(event.payload.name));
assert.ok(successfulWrites.length, 'No real file writes');
const verification = {schemaVersion: 1, task: task.id, run: run.id, model: run.config.model, status: run.status,
  applied: applied.map(({id, name, evidence}) => ({id, name, evidence})), expectedGraphHighlights: graphIds,
  allReceiptsOwnedAndSuccessful: true, planRevision: run.plan.revision, planCompleted: true,
  successfulWrites: successfulWrites.map(({seq, payload}) => ({seq, name: payload.name, data: payload.output.data})),
  modelRequests: modelResponses.length, outputLimits: modelResponses.map(item => item.outputLimit),
  outputRetries: events.filter(event => event.type === 'model_output_retry').length,
  routeRevisions: events.filter(event => event.type === 'skill_route').length,
  reportedModels: [...new Set(modelResponses.map(item => item.reportedModel))],
  executionArchiveSha256: createHash('sha256').update(JSON.stringify(execution)).digest('hex'),
  note: 'This verifies execution receipts and plan completion. Output correctness and browser highlights require separate checks.'};
const output = resolve(values.output);
await mkdir(output, {recursive: true});
await writeFile(join(output, 'verification.json'), JSON.stringify(verification, null, 2));
await writeFile(join(output, 'events.json'), JSON.stringify(events, null, 2));
await writeFile(join(output, 'skill-execution.json'), JSON.stringify(execution, null, 2));
console.log(JSON.stringify(verification, null, 2));
