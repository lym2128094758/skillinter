import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { projectSkillGraph } from '../src/audit-skills.mjs';

const prefix = join(resolve(tmpdir()), 'skillinter-graph-check-');
const scratch = await mkdtemp(prefix);
const chrome = process.env.SKILLINTER_CHROME || (process.platform === 'win32'
  ? join(process.env.ProgramFiles || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') : 'google-chrome');
const profile = join(scratch, 'browser');
let app, browser, socket, launchError;

async function waitFor(description, check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const result = await check().catch(() => null);
    if (result) return result;
    await sleep(60);
  }
  throw new Error('等待失败：' + description);
}

try {
  app = await createApp({state: join(scratch, 'state'), env: {}});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const get = async path => {
    const response = await fetch(base + path, {signal: AbortSignal.timeout(5_000)});
    assert.ok(response.ok, path);
    return response;
  };
  browser = spawn(chrome, ['--headless', '--no-first-run', '--disable-extensions', '--disable-sync',
    '--window-size=1280,860', '--remote-debugging-port=0', '--user-data-dir=' + profile, base], {stdio: 'ignore', windowsHide: true});
  browser.on('error', error => { launchError = new Error('无法启动 Chrome，可设置 SKILLINTER_CHROME', {cause: error}); });
  const port = await waitFor('Chrome 调试端口', async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim());
  const tab = await waitFor('Skillinter 浏览器页面', async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', {signal: AbortSignal.timeout(2_000)});
    return (await response.json()).find(item => item.url === base + '/');
  });
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await once(socket, 'open', {signal: AbortSignal.timeout(5_000)});
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  async function run(expression) {
    const id = ++sequence;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器指令超时')); }, 3_000);
      pending.set(id, result => { pending.delete(id); clearTimeout(timer); resolve(result); });
      socket.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}));
    });
    if (reply.error || reply.result?.exceptionDetails) throw new Error('页面执行失败：' + expression);
    return reply.result.result.value;
  }

  const installed = new Map();
  async function installGraphNodes(nodes) {
    for(const node of nodes) {
      if(installed.has(node.nodeId))continue;
      const response=await fetch(base+'/api/skill-studio/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseVersion:0,draft:{name:node.nodeId,description:'Isolated graph check fixture',instructions:'Graph check fixture only.',tests:[]}})});
      assert.equal(response.status,201);
      installed.set(node.nodeId,(await response.json()).skill.id);
    }
  }
  async function checkEmbedded(expected) {
    const rendered=await waitFor('嵌入图谱高亮',async()=>{
      const value=await run("JSON.parse(document.querySelector('#skill-graph-frame')?.contentDocument?.documentElement.dataset.executionIds||'null')");
      return JSON.stringify(value)===JSON.stringify(expected)?value:null;
    });
    assert.deepEqual(rendered,expected);
  }
  const results = [];
  for (const variant of ['unit', 'plain', 'missing-unit']) {
    const demo = await fetch(base + '/api/demo', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({variant})});
    assert.equal(demo.status, 201);
    const {task} = await demo.json();
    const {title, runs: [record]} = await (await get('/api/tasks/' + task)).json();
    await waitFor('切换演示会话 ' + variant, () => run("localStorage.setItem('skillinter-task'," + JSON.stringify(task) +
      ");setTimeout(()=>location.reload(),50);true"));
    await waitFor('演示会话 ' + variant, () => run("document.querySelector('#title')?.textContent===" + JSON.stringify(title) +
      "&&!!document.querySelector('.skill-evidence button')"));
    const planFile = record.artifacts.find(file => file.name === 'plan.json');
    const plan = await (await get('/api/tasks/' + task + '/files/' + planFile.id)).json();
    const sse = await (await get('/api/runs/' + record.id + '/events')).text();
    const events = sse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(projectSkillGraph(events), plan.graph);
    await installGraphNodes(plan.graph.nodes);
    await run("document.querySelector('.skill-evidence button').click()");
    const highlighted = await waitFor('球体高亮 ' + variant, () => run(
      "!document.querySelector('#graph-run-evidence').hidden&&JSON.parse(document.querySelector('#graph-run-evidence').dataset.highlighted||'null')"));
    const expected = [...new Set(plan.graph.nodes.map(node => installed.get(node.nodeId)))];
    assert.deepEqual(highlighted, expected, variant);
    await checkEmbedded(expected);
    if (variant === 'missing-unit') {
      assert.deepEqual(highlighted, []);
      assert.equal(record.audit.report.metrics.modelCalls, 0);
      assert.equal(record.status, 'needs_input');
    } else {
      assert.ok(highlighted.length);
      assert.equal(record.status, 'completed');
    }
    results.push({variant, status: record.status, expected, highlighted});
  }
  assert.notDeepEqual(results[0].highlighted, results[1].highlighted);
  await run("document.querySelector('#new').click();true");
  await waitFor('空会话', () => run("document.querySelector('#title').textContent === '新任务'"));
  await run("(()=>{const upload=document.querySelector('#task-upload');const data=new DataTransfer();" +
    "data.items.add(new File(['{\"ok\":true}\\ninvalid'], 'observations.jsonl'));upload.files=data.files;" +
    "upload.dispatchEvent(new Event('change'));return true})()");
  await waitFor('上传材料', () => run("document.querySelector('#task-files').textContent.includes('observations.jsonl')"));
  await run("document.querySelector('#open-audit').click();document.querySelector('#preflight-start').click();true");
  await waitFor('预检报告', () => run("document.querySelector('.skill-evidence')?.textContent.includes('下载预检报告')"));
  const task = await run("localStorage.getItem('skillinter-task')");
  const {runs: [checked]} = await (await get('/api/tasks/' + task)).json();
  assert.equal(checked.preflight.report.files[0].issues[0].line, 2);
  assert.equal(checked.preflight.report.files[0].issues[0].code, 'INVALID_JSON_LINE');
  await run("[...document.querySelectorAll('.skill-evidence button')].find(button=>button.textContent==='引用发现继续对话').click();true");
  assert.match(await run("document.querySelector('#prompt').value"), /observations\.jsonl#2/);
  await installGraphNodes(checked.preflight.trace.graph.nodes);
  await run("[...document.querySelectorAll('.skill-evidence button')].find(button=>button.textContent==='查看实际执行路径').click();true");
  const active = await waitFor('材料预检高亮', () => run(
    "!document.querySelector('#graph-run-evidence').hidden&&JSON.parse(document.querySelector('#graph-run-evidence').dataset.highlighted||'null')"));
  assert.deepEqual(active, checked.preflight.trace.graph.nodes.map(node => installed.get(node.nodeId)));
  await checkEmbedded(active);
  const [relationA,relationB]=[...installed.values()];
  await run("document.querySelector('#skill-graph-frame').contentWindow.SkillLibraryHost.focus("+JSON.stringify(relationA)+");true");
  await waitFor('执行关系编辑器',()=>run("document.querySelector('#skill-graph-frame').contentDocument.querySelector('#registryEditor code')?.textContent==="+JSON.stringify(relationA)));
  const edit=(expression)=>run("(()=>{const d=document.querySelector('#skill-graph-frame').contentDocument;"+expression+";return true})()");
  await edit("d.querySelector('[aria-label=\"关系目标技能\"]').value="+JSON.stringify(relationB)+";[...d.querySelectorAll('#registryEditor button')].find(b=>b.textContent==='保存执行关系').click()");
  await waitFor('页面保存真实依赖',async()=>{
    const data=await(await get('/api/skill-registry?task='+task)).json();
    return data.data.relations.some(edge=>edge.source===relationA&&edge.target===relationB&&edge.type==='depend_on');
  });
  await waitFor('从页面移除关系', () => run(`(() => {
    const editor = document.querySelector('#skill-graph-frame').contentDocument.querySelector('#registryEditor');
    const button = [...(editor?.querySelectorAll('button') ?? [])].find(item => item.textContent === '移除此执行关系');
    if (editor?.querySelector('code')?.textContent !== ${JSON.stringify(relationA)} || !button || button.disabled) return false;
    button.click();
    return true;
  })()`));
  await waitFor('页面移除真实依赖',async()=>{
    const data=await(await get('/api/skill-registry?task='+task)).json();
    return !data.data.relations.some(edge=>edge.source===relationA&&edge.target===relationB&&edge.type==='depend_on');
  });
  const output = resolve('.skillinter/evaluation');
  await mkdir(output, {recursive: true});
  await writeFile(join(output, 'graph-ci.json'), JSON.stringify({passed: true, results,registryEditor:{saved:true,removed:true}}, null, 2) + '\n');
  console.log('图谱验收通过：历史链路和空候选与计划一致，材料预检可提交、引用发现并定位执行路径。');
} finally {
  socket?.close();
  browser?.kill();
  if (app) await app.close();
  if (scratch.startsWith(prefix)) await rm(scratch, {recursive: true, force: true, maxRetries: 4, retryDelay: 150}).catch(() => {});
}
