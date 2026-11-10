import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const start = performance.now();
const prefix = join(resolve(tmpdir()), 'skillinter-clean-state-');
const state = await mkdtemp(prefix);
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, '127.0.0.1', '离线演示尝试调用外部服务');
  return fetchLocal(input, options);
};
let app;
try {
  const {createApp} = await import('../src/server.mjs');
  app = await createApp({state, env: {}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const health = await (await fetch(base + '/api/health')).json();
  assert.deepEqual(health, {ok: true, toolContractVersion: 4, reportVersion: 2, offlineDemo: true, modelConfigured: false});
  assert.ok((await (await fetch(base)).text()).includes('offline-audit'));
  const response = await fetch(base + '/api/demo', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(response.status, 201);
  const demo = await response.json();
  const detail = await (await fetch(base + '/api/tasks/' + demo.task)).json();
  const {audit, status, artifacts} = detail.runs[0];
  const resultMs = Math.round(performance.now() - start);
  assert.equal(status, 'completed');
  assert.equal(audit.report.metrics.modelCalls, 0);
  assert.equal(audit.report.metrics.replans, 1);
  assert.equal(audit.report.validation.rows, 3);
  assert.equal(audit.report.validation.issueCount, 3);
  assert.ok(artifacts.some(item => item.name === 'artifact-contract.json'));
  for (const ref of audit.report.citations) assert.equal((await fetch(base + ref.url)).status, 200);
  const output = resolve('.skillinter/evaluation');
  await mkdir(output, {recursive: true});
  const evidence = {health, portCount: 1, serverPort: port, node: process.version, os: process.platform, architecture: process.arch,
    coldStartToFirstReportMs: resultMs, processRssBytes: process.memoryUsage.rss(), externalFetchesAllowed: false,
    modelCalls: 0, replans: 1, rows: audit.report.validation.rows, issues: audit.report.validation.issueCount, artifacts: artifacts.length};
  await writeFile(join(output, 'offline-demo-check.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (app) await app.close();
  globalThis.fetch = fetchLocal;
  if (state.startsWith(prefix)) await rm(state, {recursive: true, force: true});
}
