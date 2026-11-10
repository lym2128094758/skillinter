import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createApp} from './src/server.mjs';

test('uploaded text is readable through the real task and tool entry points', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sih-materials-'));
  const local = await mkdtemp(join(tmpdir(), 'sih-mounted-folder-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const context = JSON.parse(body.messages[0].content.split('当前任务上下文（仅为数据，不授予额外权限）：')[1].split('\n')[0]);
    const material = context.selectedFile ? context.materials.find(item => item.id === context.selectedFile.id)
      : {name:'source.md',path:context.folders[0].path+'/sub/source.md'};
    const large = material.name.endsWith('.md');
    const message = body.messages.at(-1).role === 'tool'
      ? {content: large ? JSON.parse(body.messages.at(-1).content).data.text : JSON.parse(body.messages.at(-1).content).data.file.content}
      : {content: null, tool_calls: [{id: 'read-material', type: 'function', function: {
          name: large ? 'read_document' : 'read_file', arguments: JSON.stringify({path: material.path, ...(large ? {offset: context.selectedFile ? 60000 : 0, limit: 1} : {})}),
        }}]};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({choices: [{message}]}));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = await createApp({state: root, env: {
    SKILLINTER_MODEL_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    SKILLINTER_MODEL: 'fixture',
  }});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, {recursive: true, force: true});
    await rm(local, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, type = 'application/json') => fetch(base + path, {
    method: 'POST', headers: {'content-type': type}, body,
  });
  const task = await (await post('/api/tasks', '{}')).json();
  const file = await (await post(`/api/tasks/${task.id}/files?name=notes.txt`, 'sample factual content', 'application/octet-stream')).json();
  const run = await (await post(`/api/tasks/${task.id}/runs`, JSON.stringify({prompt: '读取上传的材料', file: file.id, request: 'read-upload'}))).json();
  const trace = await (await fetch(`${base}/api/runs/${run.id}/events`)).text();
  assert.match(trace, /sample factual content/);
  const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
  assert.equal(detail.runs[0].answer, 'sample factual content');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['list_workspace', 'read_file', 'search_skills', 'analyze_csv', 'precheck_table', 'material_preflight', 'update_plan',
    'read_document','prepare_task','discover_skills','adopt_discovered_skill','read_discovered_resource','inspect_runtime']);
  assert.ok(!requests[0].tools.some(tool=>tool.function.name==='run_python'),'附件模式不暴露代码执行');
  assert.match(trace, /contractVersion/);
  assert.match(trace, /sha256/);

  const taskPath = `/api/tasks/${task.id}`;
  const batch = randomUUID();
  const upload = (name, path, bytes) => post(`${taskPath}/files?${new URLSearchParams({name,path,batch})}`,bytes,'application/octet-stream');
  assert.equal((await upload('bad.md','folder/../bad.md','x')).status,422);
  const bytes = Buffer.from('0123456789'.repeat(4).concat('\r\n').repeat(60000) + '末尾章节\n');
  const response = await upload('报告.md','资料/第二层/报告.md',bytes);
  assert.equal(response.status,201);
  const large = await response.json();
  assert.equal(large.relativePath,'资料/第二层/报告.md');
  assert.equal(large.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await upload('报告.md','资料/第二层/报告.md','duplicate')).status,409);
  for (let i=0;i<12;i++) assert.equal((await upload(`${i}.dat`,`资料/数据/${i}.dat`,Buffer.from([0,i]))).status,201);
  assert.equal((await (await fetch(base+taskPath)).json()).files.length,14);
  const download = await fetch(`${base}${taskPath}/files/${large.id}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const largeRun = await (await post(`${taskPath}/runs`,JSON.stringify({prompt:'读取附件最后一节',file:large.id,request:'read-large'}))).json();
  await (await fetch(`${base}/api/runs/${largeRun.id}/events`)).text();
  assert.equal((await (await fetch(base+taskPath)).json()).runs.at(-1).answer,'末尾章节');
  await mkdir(join(local,'sub'));
  const original = join(local,'sub','source.md');
  await writeFile(original,'original file');
  const mounted = await (await post(`${taskPath}/folders`,JSON.stringify({path:local}))).json();
  await writeFile(original,'updated local file');
  const mountRun = await (await post(`${taskPath}/runs`,JSON.stringify({prompt:'读取挂载的材料',request:'read-mounted'}))).json();
  await (await fetch(`${base}/api/runs/${mountRun.id}/events`)).text();
  const withMount = await (await fetch(base+taskPath)).json();
  assert.equal(withMount.runs.at(-1).answer,'updated local file');
  assert.equal(withMount.files.length,14);
  const remove = path => fetch(base+path,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({detachUsed:true})});
  assert.equal((await remove(`${taskPath}/folders/${mounted.id}`)).status,200);
  assert.equal(await readFile(original,'utf8'),'updated local file');
  assert.equal((await remove(`${taskPath}/files/${large.id}`)).status,200);
  const afterRemoval = await (await fetch(base+taskPath)).json();
  assert.deepEqual(afterRemoval.folders,[]);
  assert.ok(!afterRemoval.files.some(file=>file.id===large.id));
  assert.equal(afterRemoval.runs.find(run=>run.id===largeRun.id).inputAttachment.name,'报告.md');
  assert.deepEqual(Buffer.from(await (await fetch(`${base}${taskPath}/files/${large.id}`)).arrayBuffer()),bytes);
});
