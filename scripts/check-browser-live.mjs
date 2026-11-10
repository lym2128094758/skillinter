import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { config } from '../src/config.mjs';
import { digest } from '../src/workflow.mjs';
import { sourceFingerprint, projectRoot } from './source-fingerprint.mjs';

const {values} = parseArgs({options: {model: {type: 'string', default: 'minimax-m3'}, seconds: {type: 'string', default: '180'}}});
const seconds = Number(values.seconds);
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300) throw new Error('seconds must be between 30 and 300');
const startedAt = new Date().toISOString();
const source = await sourceFingerprint();
const prefix = join(resolve(tmpdir()), 'skillinter-real-browser-');
const scratch = await mkdtemp(prefix);
const state = join(scratch, 'state');
await mkdir(state);
const savedPath = join(projectRoot, config.statePath, 'tasks.sqlite');
const seed = new Store(join(state, 'tasks.sqlite'));
if (existsSync(savedPath)) {
  const original = new DatabaseSync(savedPath, {readOnly: true});
  try {
    const saved = JSON.parse(original.prepare('SELECT value FROM preferences WHERE id=1').get().value);
    seed.savePreferences(0, {...saved, model: values.model, maxSteps: 5});
  } finally { original.close(); }
}
seed.db.close();
const output = resolve(projectRoot, '.skillinter/evaluation/browser-live');
await mkdir(output, {recursive: true});
const stamp = startedAt.replace(/[:.]/g, '-');
const requests = [], readers = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  let payload;
  try { payload = typeof options?.body === 'string' ? JSON.parse(options.body) : null; } catch { /* Non-JSON app requests are not model calls. */ }
  if (!payload?.model || !Array.isArray(payload.messages)) return nativeFetch(url, options);
  const entry = {startedAt: new Date().toISOString(), requestedModel: payload.model, stream: payload.stream,
    maxTokens: payload.max_tokens, tools: (payload.tools ?? []).map(tool => tool.function.name), reportedModels: [], finishReasons: []};
  requests.push(entry);
  try {
    const response = await nativeFetch(url, options);
    entry.httpStatus = response.status;
    readers.push(response.clone().text().then(text => {
      const frames = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
          .map(line => line.slice(5).trim()).filter(Boolean).map(line => JSON.parse(line))
        : [JSON.parse(text)];
      for (const frame of frames) {
        if (frame.model && !entry.reportedModels.includes(frame.model)) entry.reportedModels.push(frame.model);
        if (frame.usage) entry.usage = frame.usage;
        for (const choice of frame.choices ?? []) if (choice.finish_reason) entry.finishReasons.push(choice.finish_reason);
      }
      entry.finishedAt = new Date().toISOString();
    }).catch(error => { entry.observationError = error.name; }));
    return response;
  } catch (error) { entry.error = error.name; entry.finishedAt = new Date().toISOString(); throw error; }
};

const chrome = process.env.SKILLINTER_CHROME || (process.platform === 'win32'
  ? join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') : 'google-chrome');
let app, browser, socket, launchError, task, runRecord, ui = {}, failure;
let sequence = 0;
const pending = new Map();
async function waitFor(description, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const result = await check();
    if (result) return result;
    await sleep(150);
  }
  throw new Error('等待超时：' + description);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Chrome 指令超时')); }, 5_000);
    pending.set(id, result => { pending.delete(id); clearTimeout(timer); resolve(result); });
    socket.send(JSON.stringify({id, method, params}));
  });
  if (reply.error || reply.result?.exceptionDetails) throw new Error('Chrome 页面执行失败');
  return reply.result;
}
async function evaluate(expression) {
  return (await command('Runtime.evaluate', {expression, returnByValue: true})).result.value;
}
const text = 'sample_id,mass_g\nA,0.02\nB,-0.01\n,abc';
const prompt = '先查找可执行的 CSV 数据预检技能，然后执行。目标字段 sample_id 是必填文本；mass 是必填数值，单位 mg，最小值 0。请按这些目标做字段映射、单位换算、缺失值、类型和范围检查，并统计原始列。使用当前附件，不修改源文件。';
let base;
try {
  app = await createApp({state, env: {...process.env, SKILLINTER_MODEL: values.model}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  base = 'http://127.0.0.1:' + app.server.address().port;
  const profile = join(scratch, 'browser');
  browser = spawn(chrome, ['--headless', '--no-first-run', '--disable-extensions', '--disable-sync',
    '--window-size=1280,960', '--remote-debugging-port=0', '--user-data-dir=' + profile, base], {windowsHide: true, stdio: 'ignore'});
  browser.on('error', error => { launchError = error; });
  const port = await waitFor('Chrome 调试端口', async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { return null; }
  });
  const tab = await waitFor('Skillinter 页面', async () => {
    const tabs = await (await nativeFetch('http://127.0.0.1:' + port + '/json/list')).json();
    return tabs.find(tab => tab.url === base + '/');
  });
  socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, 'open');
  socket.onmessage = ({data}) => { const message = JSON.parse(data); pending.get(message.id)?.(message); };
  ui.browser = await command('Browser.getVersion');
  await waitFor('主输入框就绪', async () => {
    try { return await evaluate("!document.querySelector('#send').disabled"); } catch { return false; }
  });
  await evaluate(`(() => {const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(text)}], 'sample.csv', {type:'text/csv'}));
    const input = document.querySelector('#task-upload'); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));})()`);
  const fileId = await waitFor('附件上传', () => evaluate("!document.querySelector('#send').disabled&&document.querySelector('#analysis-file').value"));
  task = await evaluate("localStorage.getItem('skillinter-task')");
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(prompt)};document.querySelector('#composer').requestSubmit()`);
  ui.entry = 'main composer and attachment input in Chrome';
  ui.workflowFormOpened = await evaluate("document.querySelector('#audit-dialog').open");
  runRecord = await waitFor('真实模型完成', async () => {
    const detail = await (await nativeFetch(base + '/api/tasks/' + task)).json();
    return detail.runs[0] && detail.runs[0].status !== 'running' && detail.runs[0];
  }, seconds * 1000);
  await waitFor('回复和报告显示', () => evaluate("document.querySelector('.skill-evidence a')&&document.querySelector('#transcript').textContent.includes('预检完成')"));
  ui.transcript = await evaluate("document.querySelector('#transcript').textContent");
  ui.sourceUnchanged = digest(await (await nativeFetch(base + '/api/tasks/' + task + '/files/' + fileId)).text()) === digest(text);
  ui.artifactLinks = await evaluate("[...document.querySelectorAll('.skill-evidence a')].map(a=>({label:a.textContent,href:a.getAttribute('href')}))");
  const image = await command('Page.captureScreenshot', {format: 'png'});
  await writeFile(join(output, stamp + '-chat.png'), Buffer.from(image.data, 'base64'));
  await evaluate("[...document.querySelectorAll('.skill-evidence button')].find(b=>b.textContent==='查看技能执行图').click()");
  const highlighted = await waitFor('图谱实际高亮', () => evaluate("!document.querySelector('#graph-run-evidence').hidden&&document.querySelector('#graph-run-evidence').dataset.highlighted"));
  ui.highlighted = JSON.parse(highlighted);
  const graphImage = await command('Page.captureScreenshot', {format: 'png'});
  await writeFile(join(output, stamp + '-graph.png'), Buffer.from(graphImage.data, 'base64'));
  const expected = [...new Set(runRecord.audit.skillTrace.graph.nodes.map(node => node.nodeId))];
  assert.deepEqual(ui.highlighted, expected);
  assert.equal(ui.workflowFormOpened, false);
  assert.equal(runRecord.config.workflow, undefined);
  assert.equal(runRecord.config.model, values.model);
  assert.equal(runRecord.audit.report.status, 'completed');
  assert.equal(runRecord.audit.report.validation.issueCount, 3);
  assert.equal(runRecord.audit.report.mappings.find(row => row.target === 'mass').factor, 1000);
  assert.equal(runRecord.audit.report.profile.columns.length, 2);
  assert.equal(ui.sourceUnchanged, true);
  assert.ok(runRecord.artifacts.some(file => file.name === 'report.json'));
} catch (error) { failure = {name: error.name, message: error.message.slice(0, 500)}; }
finally {
  if (app) await app.close();
  await Promise.allSettled(readers);
  const record = {startedAt, finishedAt: new Date().toISOString(), mode: 'real-browser-and-real-model',
    passed: !failure, node: process.version, platform: process.platform, model: values.model, sharedBudget: 5,
    fixtureProvider: false, requests, source, sourceCsv: {sha256: digest(text), text, origin: '合成接口联调样例'},
    prompt, ui, run: runRecord ? {id: runRecord.id, config: runRecord.config, status: runRecord.status, answer: runRecord.answer,
      error: runRecord.error, audit: runRecord.audit, artifacts: runRecord.artifacts} : null, failure};
  await writeFile(join(output, stamp + '.json'), JSON.stringify(record, null, 2) + '\n');
  if (!failure) {
    await writeFile(new URL('../docs/evidence/harness-browser-live.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
    await mkdir('D:/gpt/outputs/skillinter-harness-verification', {recursive: true});
    for (const view of ['chat', 'graph']) await writeFile('D:/gpt/outputs/skillinter-harness-verification/browser-' + view + '.png', await readFile(join(output, stamp + '-' + view + '.png')));
  }
  console.log(JSON.stringify({passed: !failure, model: values.model, modelRequests: requests.length, sourceSha256: source.sha256, failure}));
  socket?.close(); browser?.kill();
  globalThis.fetch = nativeFetch;
  if (resolve(scratch).startsWith(prefix)) await rm(scratch, {recursive: true, force: true, maxRetries: 4, retryDelay: 150}).catch(() => {});
}
if (failure) process.exitCode = 1;
