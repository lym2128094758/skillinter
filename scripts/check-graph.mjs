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
  const projectPath = join(scratch, 'memory-project');
  await mkdir(projectPath);
  const projectResponse = await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: projectPath})});
  assert.equal(projectResponse.status, 201);
  const memoryProject = await projectResponse.json();
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
  async function send(method, params) {
    const id = ++sequence;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器指令超时')); }, 3_000);
      pending.set(id, result => { pending.delete(id); clearTimeout(timer); resolve(result); });
      socket.send(JSON.stringify({id, method, params}));
    });
    if (reply.error) throw new Error(method + ': ' + reply.error.message);
    return reply.result;
  }
  async function run(expression) {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true});
    if (result.exceptionDetails) throw new Error('页面执行失败：' + expression);
    return result.result.value;
  }
  async function checkGlassButton(selector, opened, embedded = false) {
    const scope = embedded
      ? "document.querySelector('#skill-graph-frame').contentDocument"
      : 'document';
    const button = `${scope}.querySelector(${JSON.stringify(selector)})`;
    const {x, y} = await run(`(() => {
      const b = ${button};
      const r = b.getBoundingClientRect();
      const frame = b.ownerDocument.defaultView.frameElement;
      const origin = frame?.getBoundingClientRect();
      return {x: (origin?.left ?? 0) + r.left + r.width / 2, y: (origin?.top ?? 0) + r.top + r.height / 2};
    })()`);
    const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
      type, x, y, buttons, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1
    });
    const dragX = x < 40 ? x + 32 : x - 32;
    const appearance = () => run(`(() => {
      const element = ${button};
      const content = element.querySelector('svg') ?? element.ownerDocument.createRange();
      if (content instanceof element.ownerDocument.defaultView.Range) content.selectNodeContents(element);
      const {x, y, width, height} = content.getBoundingClientRect();
      const glass = getComputedStyle(element, '::before');
      return {content: [x, y, width, height], offset: glass.translate, tint: glass.backgroundColor};
    })()`);
    assert.equal(await run(opened), false);
    const resting = await appearance();
    await mouse('mousePressed', x, y, 1);
    const pressed = await waitFor(selector + ' 玻璃按下变深', async () => {
      const current = await appearance();
      return current.tint !== resting.tint ? current : null;
    });
    assert.deepEqual(pressed.content, resting.content, selector + ' 按下时底层保持原位');
    await mouse('mouseMoved', dragX, y - 16, 1);
    const dragged = await appearance();
    const distance = Math.hypot(...dragged.offset.split(' ').map(parseFloat));
    assert.ok(distance > 5 && distance <= 8, selector + ' 玻璃层跟手且最多偏移 8 像素');
    assert.deepEqual(dragged.content, resting.content, selector + ' 拖动时底层保持原位');
    await mouse('mouseReleased', dragX, y - 16, 0);
    assert.equal(await run(opened), false, selector + ' 拖动不触发点击');
    await waitFor(selector + ' 玻璃松手回弹', async () => {
      const current = await appearance();
      return current.offset === 'none' && current.tint === resting.tint;
    });
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
    await waitFor(selector + ' 点击可用', () => run(opened));
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
  async function checkEmbedded(expected, expectedEdges) {
    const visible = await waitFor('当前会话的图谱高亮', () => run(`(() => {
      const frame = document.querySelector('#skill-graph-frame');
      const doc = frame.contentDocument;
      if (doc?.URL !== frame.src ||
          doc.documentElement.dataset.executionIds !== ${JSON.stringify(JSON.stringify(expected))}) return null;
      const stage = doc.querySelector('#graphStage').getBoundingClientRect();
      const nodes = [...doc.querySelectorAll('#nodesLayer .graph-node')];
      const points = nodes.map(node => node.querySelector('.node-core').getBoundingClientRect());
      const center = (min, max) => (Math.min(...points.map(min)) + Math.max(...points.map(max))) / 2;
      const x = (center(p => p.left, p => p.right) - stage.left) / stage.width;
      const y = (center(p => p.top, p => p.bottom) - stage.top) / stage.height;
      return {
        ids: nodes.filter(node => node.classList.contains('execution-used')).map(node => node.__data__.id),
        total: nodes.length,
        edges: [...doc.querySelectorAll('.graph-link.execution')].map(line => ({
          source: line.__data__.sourceId, target: line.__data__.targetId, arrow: line.getAttribute('marker-end')
        })),
        centered: x > .2 && x < .8 && y > .2 && y < .8,
        empty: !doc.querySelector('#emptyState').hidden,
      };
    })()`));
    assert.deepEqual(visible.ids, expected);
    assert.equal(visible.total, expected.length);
    assert.deepEqual(visible.edges, expectedEdges.map(edge => ({...edge, arrow: 'url(#executionArrow)'})));
    assert.equal(visible.empty, !expected.length);
    if (expected.length) assert.ok(visible.centered, '执行链应位于画布中央');
  }
  function recordedEdges(graph, idsByStep) {
    return graph.edges.map(({from, to}) => ({source: idsByStep.get(from), target: idsByStep.get(to)}))
      .filter(({source, target}) => source && target && source !== target);
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
    await installGraphNodes(variant === 'unit' ? plan.graph.nodes.slice(1) : plan.graph.nodes);
    await run("document.querySelector('.skill-evidence button').click()");
    const highlighted = await waitFor('球体高亮 ' + variant, () => run(
      "!document.querySelector('#graph-run-evidence').hidden&&JSON.parse(document.querySelector('#graph-run-evidence').dataset.highlighted||'null')"));
    const steps = new Map(plan.graph.nodes.filter(node => node.state !== 'planned')
      .map(node => [node.step, installed.get(node.nodeId) ?? 'execution:' + node.id]));
    const expected = [...new Set(steps.values())];
    assert.deepEqual(highlighted, expected, variant);
    const expectedEdges = recordedEdges(plan.graph, steps);
    await checkEmbedded(expected, expectedEdges);
    if (variant === 'unit') {
      assert.ok(expected.some(id => id.startsWith('execution:')), '未安装技能应作为历史节点保留');
      const graphDoc = "document.querySelector('#skill-graph-frame').contentDocument";
      await run(graphDoc + ".querySelector('#globalViewButton').click();true");
      assert.equal(await run(graphDoc + ".querySelector('#executionViewButton').getAttribute('aria-pressed')"), 'false');
      await run(graphDoc + ".querySelector('#executionViewButton').click();true");
      await checkEmbedded(expected, expectedEdges);
    }
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
  await checkEmbedded(active, recordedEdges(checked.preflight.trace.graph,
    new Map(checked.preflight.trace.graph.nodes.map(node => [node.step, installed.get(node.nodeId)]))));
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
  await checkGlassButton('#settingsButton',
    "!document.querySelector('#skill-graph-frame').contentDocument.querySelector('#settingsPanel').hidden", true);
  await checkGlassButton('#settings', "document.querySelector('#settings-dialog').open");
  await waitFor('技能引擎设置加载', () => run("document.querySelector('#engine-status').textContent.includes('本地匹配')"));
  await run("document.querySelector('#engine-enabled').checked=false;document.querySelector('#engine-form').requestSubmit();true");
  await waitFor('保存引擎设置', () => run("document.querySelector('#engine-status').textContent.includes('已保存')"));
  assert.equal((await (await get('/api/skill-intelligence/settings')).json()).revision, 1);
  await run("document.querySelector('#close-settings').click();document.querySelector('#choose-custom-skill').click();true");
  await waitFor('技能中心打开', () => run("document.querySelector('#skill-studio-dialog').open"));
  await run("document.querySelector('#studio-tab-import').click();const select=document.querySelector('#studio-import-source');select.value='public';select.dispatchEvent(new Event('change'));true");
  assert.equal(await run("!document.querySelector('#studio-public-source').hidden&&document.querySelector('#studio-import-start').textContent==='核验公开来源并预览'"), true);
  await run("document.querySelector('#close-skill-studio').click();true");
  await waitFor('打开项目记忆', () => run(`(() => {
    const entry = [...document.querySelectorAll('.project-memory-action')].find(item => item.ariaLabel === ${JSON.stringify(memoryProject.name + ' 的项目记忆')});
    if (!entry) return false;
    entry.click();
    return document.querySelector('#project-memory-dialog').open;
  })()`));
  await waitFor('项目记忆加载完成', () => run("!document.querySelector('#project-memory-form [type=submit]').disabled"));
  assert.equal(await run("document.querySelector('#project-memory-name').value"), '报告与验收');
  assert.deepEqual((await (await get('/api/projects/' + memoryProject.id + '/memories')).json()).memories, []);
  assert.equal(await run(`(() => {
    const button = document.querySelector('.project-memory-action');
    const row = button.parentElement;
    const height = button.getBoundingClientRect().height;
    row.style.width = '88px';
    const remainsSingleLine = button.getBoundingClientRect().height === height;
    row.style.removeProperty('width');
    return remainsSingleLine;
  })()`), true);
  await run(`(() => {
    document.querySelector('#project-memory-name').value = '实验报告样式';
    document.querySelector('#project-memory-text').value = '用表格列出核验项';
    document.querySelector('#project-memory-triggers').value = '实验报告';
    document.querySelector('#project-memory-form').requestSubmit();
    return true;
  })()`);
  await waitFor('页面保存项目记忆', () => run("document.querySelector('#project-memory-list summary')?.textContent.includes('实验报告样式')"));
  const {memories} = await (await get('/api/projects/' + memoryProject.id + '/memories')).json();
  assert.equal(memories[0]?.text, '用表格列出核验项');
  const output = resolve('.skillinter/evaluation');
  await mkdir(output, {recursive: true});
  await writeFile(join(output, 'graph-ci.json'), JSON.stringify({passed: true, results,registryEditor:{saved:true,removed:true},
    skillEngineSettings: {saved: true}, publicDiscoveryForm: {visible: true}, projectMemory: {saved: true}}, null, 2) + '\n');
  console.log('图谱验收通过：历史链路和空候选与计划一致，材料预检可提交、引用发现并定位执行路径。');
} finally {
  socket?.close();
  browser?.kill();
  if (app) await app.close();
  if (scratch.startsWith(prefix)) await rm(scratch, {recursive: true, force: true, maxRetries: 4, retryDelay: 150}).catch(() => {});
}
