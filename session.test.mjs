import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createApp} from './src/server.mjs';

test('session choices survive restart and reach the provider as real request parameters',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sih-models-'));const requests=[];
 const provider=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'intern-s2'},{id:'reasoning-fixture',reasoning_efforts:['low','high']}]}));return;}
  let body='';for await(const c of req)body+=c;requests.push(JSON.parse(body));res.end(JSON.stringify({choices:[{message:{content:'fixture answer'}}]}));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 let app;const env={SKILLINTER_MODEL_URL:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,SKILLINTER_MODEL:'intern-s2'};
 async function boot(){app=await createApp({state:dir,env});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;return(path,body,method=body?'POST':'GET')=>fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});}
 t.after(async()=>{if(app)await app.close();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});});
 let req=await boot();const catalog=await(await req('/api/models')).json();assert.deepEqual(catalog.models[0].efforts,['default','on','off']);
 const task=await(await req('/api/tasks',{})).json();
 assert.equal((await req(`/api/tasks/${task.id}`,{model_id:'intern-s2',effort:'high'},'PATCH')).status,422);
 assert.equal((await req(`/api/tasks/${task.id}`,{model_id:'intern-s2',effort:'off'},'PATCH')).status,200);
 let run=await(await req(`/api/tasks/${task.id}/runs`,{prompt:'test',request:'one'})).json();await(await req(`/api/runs/${run.id}/events`)).text();assert.equal(requests[0].model,'intern-s2');assert.equal(requests[0].thinking_mode,false);assert.equal(requests[0].reasoning_effort,undefined);
 await app.close();app=null;req=await boot();const saved=await(await req(`/api/tasks/${task.id}`)).json();assert.equal(saved.effort,'off');assert.equal(saved.model_id,'intern-s2');assert.equal(saved.runs[0].config.effort,'off');assert.equal(typeof saved.runs[0].ended,'number');
 assert.equal((await req(`/api/tasks/${task.id}`,{model_id:'reasoning-fixture',effort:'high'},'PATCH')).status,200);
 run=await(await req(`/api/tasks/${task.id}/runs`,{prompt:'second',request:'two'})).json();await(await req(`/api/runs/${run.id}/events`)).text();assert.equal(requests[1].model,'reasoning-fixture');assert.equal(requests[1].reasoning_effort,'high');assert.equal(requests[1].thinking_mode,undefined);
 const preferences=await(await req('/api/settings')).json();
 const connection={mode:'api',endpoint:`http://127.0.0.1:${provider.address().port}/v1`,revision:preferences.revision,maxSteps:preferences.maxSteps};
 const check=await(await req('/api/settings/test',connection)).json();assert.deepEqual(check.models,['intern-s2','reasoning-fixture']);
 const savedConnection=await(await req('/api/settings',connection,'PUT')).json();assert.equal(savedConnection.activeModel,'intern-s2');assert.equal((await(await req('/api/models')).json()).models.length,2);
});

test('streamed tool calls, incremental replies and stop retain partial output',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sih-stream-'));let calls=0;
 const provider=createServer(async(req,res)=>{
  req.resume();res.setHeader('content-type','text/event-stream');
  const frame=choice=>res.write(`data: ${JSON.stringify({choices:[choice]})}\n\n`);
  calls++;
  if(calls===1){frame({delta:{tool_calls:[{index:0,id:'tool-1',function:{name:'list_',arguments:'{'}}]}});frame({delta:{tool_calls:[{index:0,function:{name:'workspace',arguments:'}'}}]},finish_reason:'tool_calls'});res.end('data: [DONE]\n\n');}
  else if(calls===2){frame({delta:{content:'工作区'}});frame({delta:{content:'为空'},finish_reason:'stop'});res.end('data: [DONE]\n\n');}
  else {frame({delta:{content:'已经收到的部分'}});}
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const app=await createApp({state:dir,env:{SKILLINTER_MODEL_URL:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,SKILLINTER_MODEL:'stream-fixture'}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;const post=async(path,body)=>(await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
 const task=await post('/api/tasks',{});const run=await post(`/api/tasks/${task.id}/runs`,{prompt:'列目录',request:'stream'});const trace=await(await fetch(base+`/api/runs/${run.id}/events`)).text();assert.match(trace,/"type":"tool"/);assert.match(trace,/"type":"progress"/);assert.match(trace,/工作区为空/);
 const next=await post(`/api/tasks/${task.id}/runs`,{prompt:'停止测试',request:'stop'});const response=await fetch(base+`/api/runs/${next.id}/events`);const reader=response.body.getReader();let seen='';while(!seen.includes('已经收到的部分')){const {value,done}=await reader.read();if(done)break;seen+=new TextDecoder().decode(value);}
 assert.match(seen,/已经收到的部分/);await post(`/api/runs/${next.id}/stop`,{});await reader.cancel();const detail=await(await fetch(base+`/api/tasks/${task.id}`)).json();assert.equal(detail.runs.at(-1).status,'stopped');assert.equal(detail.runs.at(-1).answer,'已经收到的部分');
});

test('guidance interrupts an in-flight request once and survives history reload',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sih-guide-'));let announce;const started=new Promise(r=>announce=r);const requests=[];
 const provider=createServer(async(req,res)=>{let bytes='';for await(const chunk of req)bytes+=chunk;const body=JSON.parse(bytes);requests.push(body);res.setHeader('content-type','text/event-stream');
 if(requests.length===1){res.flushHeaders();announce();return;}
 const guidance=body.messages.filter(m=>m.role==='user').at(-1).content;res.end(`data: ${JSON.stringify({choices:[{delta:{content:guidance},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const app=await createApp({state:dir,env:{SKILLINTER_MODEL_URL:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,SKILLINTER_MODEL:'guide-fixture'}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const task=await(await post('/api/tasks',{})).json();
 const run=await(await post(`/api/tasks/${task.id}/runs`,{prompt:'原问题',request:'initial'})).json();await started;
 const guide={prompt:'请按我自己的项目来分析',request:'guide-once'};assert.equal((await post(`/api/runs/${run.id}/guide`,guide)).status,200);
 const trace=await(await fetch(base+`/api/runs/${run.id}/events`)).text();assert.match(trace,/guidance_received/);assert.match(trace,/guidance_applied/);assert.match(trace,/"status":"completed"/);assert.equal(requests.length,2);assert.equal(requests[1].messages.at(-1).content,guide.prompt);
 assert.equal((await(await post(`/api/runs/${run.id}/guide`,guide)).json()).reused,true);assert.equal((await post(`/api/runs/${run.id}/guide`,{...guide,prompt:'不同内容'})).status,409);assert.equal((await post(`/api/runs/${run.id}/guide`,{prompt:'已完成后不可继续引导',request:'late'})).status,409);
 const detail=await(await fetch(base+`/api/tasks/${task.id}`)).json();assert.equal(detail.runs[0].guidance.length,1);assert.equal(detail.runs[0].guidance[0].applied,1);assert.equal(detail.runs[0].answer,guide.prompt);
 const next=await(await post(`/api/tasks/${task.id}/runs`,{prompt:'下一轮',request:'next'})).json();await(await fetch(base+`/api/runs/${next.id}/events`)).text();assert.ok(requests[2].messages.some(m=>m.role==='user'&&m.content.includes('补充要求：'+guide.prompt)));
});
