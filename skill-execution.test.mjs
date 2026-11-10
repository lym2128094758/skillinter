import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile,readFile,link} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from './src/store.mjs';
import {createSkillStudio} from './src/skill-studio.mjs';
import {executionTools} from './src/skill-execution.mjs';
import {createApp} from './src/server.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {routeSkills} from './src/skill-routing.mjs';

const spec=()=>({budget:{maxCalls:4,maxSeconds:15,maxOutputTokens:1024},cases:[2,3].map((value,index)=>({name:'case-'+index,
  prompt:'请处理测试材料'+index+'：读取 input.json，将 mean 写入 report.json，不修改 input.json。',files:[{path:'input.json',content:JSON.stringify({values:[value,value+2]})}],
  acceptance:{version:1,preserve_inputs:['input.json'],artifacts:[{path:'report.json',format:'json',require_change:true,checks:[{kind:'json_equals',pointer:'/mean',expected:String(value+1)}]}]}}))});
const draft={name:'paired-method',description:'实验均值提取',instructions:'OLD method',tests:[{prompt:'自包含正常文本',expected_output:'输出均值',expectations:['包含：均值']},{prompt:'自包含边界文本',expected_output:'缺失',expectations:['包含：缺失']}]};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'sih-execution-test-')),projectPath=join(root,'original');await mkdir(projectPath);await writeFile(join(projectPath,'untouched.txt'),'original');
  const store=new Store(join(root,'state.sqlite')),studio=createSkillStudio(store,{userSkillsPath:join(root,'skills')});
  const project=store.addProject(projectPath,'original'),task=store.createTask(project.id);
  const skill=studio.publish({taskId:task.id,targetScope:'project',baseVersion:0,draft});
  const candidate=studio.candidates.save({context:task.id,taskId:task.id,skillId:skill.id,baseVersion:1,draft:{...draft,instructions:'NEW method'},targetScope:'project'});
  const engine=studio.candidates.executions;
  t.after(async()=>{await engine.close();store.db.close();await rm(root,{recursive:true,force:true});});
  return {root,projectPath,store,studio,project,task,skill,candidate,engine};
}
const call=(id,name,args)=>({tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
function provider(mode='improve',observations=[]){return {label:'fixture',async invoke({messages,tools,maxTokens}){
  assert.equal(maxTokens,1024);assert.ok(tools.every(tool=>executionTools.includes(tool.function.name)));assert.ok(!tools.some(tool=>tool.function.name==='run_project_tests'));
  const modern=messages[0].content.includes('NEW method');
  if(!messages.some(message=>message.role==='tool')){
    observations.push(modern?'candidate':'baseline');
    if(mode==='forbidden')return {...call('escape','run_project_tests',{}),reportedModel:'fixture',finishReason:'tool_calls'};
    return {...call('read','read_file',{path:'input.json'}),reportedModel:'fixture',usage:{prompt_tokens:10,completion_tokens:10},finishReason:'tool_calls'};
  }
  const latest=messages.at(-1);
  if(latest.tool_call_id==='escape'){assert.equal(JSON.parse(latest.content).error.code,'UNKNOWN_TOOL');return {content:'不执行。',reportedModel:'fixture',finishReason:'stop'};}
  if(latest.tool_call_id==='read'){
    const read = JSON.parse(latest.content);
    if (!read.ok && read.error.code === 'NOT_FOUND') {
      if (!modern) return {content:'输入缺失。',reportedModel:'fixture',finishReason:'stop'};
      return {...call('write','create_file',{path:'report.json',content:'{"error":"missing_input"}'}),reportedModel:'fixture',finishReason:'tool_calls'};
    }
    const data=JSON.parse(read.data.file.content),mean=(data.values[0]+data.values[1])/2;
    const correct=mode==='tie'||(mode==='regression'?!modern:modern);
    return {...call('write','create_file',{path:'report.json',content:JSON.stringify({mean:correct?mean:0})}),reportedModel:'fixture',usage:{prompt_tokens:15,completion_tokens:8},finishReason:'tool_calls'};
  }
  return {content:'实际报告已保存。',reportedModel:mode==='identity'?modern?'other':'fixture':'fixture',usage:{prompt_tokens:12,completion_tokens:6},finishReason:'stop'};
}};}

test('frozen actual tasks run in separate directories with common budgets, real artifacts, alternating order and unchanged originals',async t=>{
  const f=await fixture(t),observations=[];
  await writeFile(join(dirname(f.skill.storagePath),'reference.txt'),'supporting evidence');
  const sample = spec();
  const heldOutText = 'HOST_ONLY_CHECK_9b193a';
  for (const item of sample.cases) item.acceptance.artifacts[0].checks.push({kind:'text_excludes',pointer:'',expected:heldOutText});
  const plan = await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:sample});
  sample.cases[0].files[0].content = 'changed';
  assert.equal(plan.resources.length,1);assert.match(plan.executionSha256,/^[a-f0-9]{64}$/);
  const model = provider('improve', observations);
  const invoke = model.invoke;
  let leaked = false;
  model.invoke = request => {
    leaked ||= JSON.stringify(request.messages).includes(heldOutText);
    return invoke(request);
  };
  const running=await f.engine.run({id:plan.id,context:f.task.id,model});await running.job;
  assert.equal(leaked, false);
  const result=f.engine.get(plan.id,f.task.id).trials[0];assert.equal(result.status,'completed');assert.equal(result.verdict,'improved');assert.equal(result.baselinePassed,0);assert.equal(result.candidatePassed,2);
  assert.deepEqual(observations,['baseline','candidate','candidate','baseline']);
  for(const pair of result.pairs){
    assert.equal(pair.baseline.inputSha256,pair.candidate.inputSha256);assert.equal(pair.baseline.acceptanceSha256,pair.candidate.acceptanceSha256);
    assert.equal(pair.candidate.verification.status,'passed');assert.ok(pair.candidate.skillParticipated);
    assert.ok(pair.candidate.verification.checks.some(check => check.message.includes(heldOutText)));
    const artifact=pair.candidate.artifacts[0],file=f.engine.file(plan.id,result.id,artifact.id,f.task.id);assert.equal(file.sha256,artifact.sha256);assert.ok(JSON.parse(Buffer.from(file.bytes).toString()).mean>0);
    assert.ok(pair.candidate.modelRequests.every(request=>request.maxTokens===1024));
  }
  assert.equal(await readFile(join(f.projectPath,'untouched.txt'),'utf8'),'original');assert.equal(f.studio.get(f.skill.id,f.task.id).version,1);assert.equal(f.studio.candidates.get(f.candidate.id,f.task.id).publishedVersion,null);
  assert.throws(()=>f.engine.get(plan.id,null),/当前范围/);
});

test('execution plan rejects traversal, case collisions, duplicate tasks, missing preservation fixtures and linked skill resources',async t=>{
  const f=await fixture(t);
  for(const mutate of [s=>{s.cases[0].files[0].path='../outside';},s=>{s.cases[1].prompt=s.cases[0].prompt;},s=>{s.cases[0].files.push({...s.cases[0].files[0]});},s=>{s.cases[0].acceptance.preserve_inputs=['missing.json'];}]){
    const s=spec();mutate(s);await assert.rejects(f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:s}));
  }
  const target=join(f.root,'linked.txt');await writeFile(target,'private');await link(target,join(dirname(f.skill.storagePath),'linked.txt'));
  await assert.rejects(f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()}),/链接/);
});

test('same-result, regression, unknown identity and invented command calls are kept distinct and do not alter active skill',async t=>{
  for(const [mode,verdict]of [['tie','no_gain'],['regression','failed'],['identity','unknown'],['forbidden','unknown']]){
    const f=await fixture(t),plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()});const running=await f.engine.run({id:plan.id,context:f.task.id,model:provider(mode)});await running.job;
    const result=f.engine.get(plan.id,f.task.id).trials[0];assert.equal(result.verdict,verdict,mode);assert.equal(f.studio.get(f.skill.id,f.task.id).version,1);
    if(mode==='forbidden')assert.ok(result.pairs[0].baseline.events.some(event=>event.type==='tool_result'&&event.payload.output.error?.code==='UNKNOWN_TOOL'));
  }
});

test('stopping a real run preserves partial groups and restart never resumes model calls automatically',async t=>{
  const f=await fixture(t),plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()});let entered;
  const began=new Promise(resolve=>{entered=resolve;});
  const running=await f.engine.run({id:plan.id,context:f.task.id,model:{label:'fixture',async invoke({signal}){entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));}}});
  await began;f.engine.stop(plan.id,f.task.id);await running.job;
  const result=f.engine.get(plan.id,f.task.id).trials[0];assert.equal(result.status,'interrupted');assert.equal(result.verdict,'unknown');assert.equal(result.pairs.length,1);assert.equal(result.pairs[0].baseline.status,'unknown');assert.equal(result.pairs[0].candidate,undefined);
});

test('stale baseline rejects execution before the first model request',async t=>{
  const f=await fixture(t),plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()});
  f.studio.publish({taskId:f.task.id,skillId:f.skill.id,baseVersion:1,draft:{...draft,instructions:'changed'}});
  await assert.rejects(f.engine.run({id:plan.id,context:f.task.id,model:provider()}),/正式技能已变化/);assert.equal(f.engine.get(plan.id,f.task.id).trials.length,0);
});

test('invented absolute file reads and writes cannot reach the original project',async t=>{
  const f=await fixture(t),plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()});
  const model={label:'fixture',async invoke({messages}){
    const results=messages.filter(message=>message.role==='tool');
    if(!results.length)return {...call('outside','read_file',{path:join(f.projectPath,'untouched.txt')}),reportedModel:'fixture'};
    assert.equal(JSON.parse(results.at(-1).content).error.code,'PATH_OUTSIDE_WORKSPACE');
    if(results.length===1)return {...call('outside-write','create_file',{path:join(f.projectPath,'injected.txt'),content:'overwrite'}),reportedModel:'fixture'};
    return {content:'越界已拒绝。',reportedModel:'fixture',finishReason:'stop'};
  }};
  const running=await f.engine.run({id:plan.id,context:f.task.id,model});await running.job;
  assert.equal(await readFile(join(f.projectPath,'untouched.txt'),'utf8'),'original');await assert.rejects(readFile(join(f.projectPath,'injected.txt')),{code:'ENOENT'});
  assert.equal(f.engine.get(plan.id,f.task.id).trials[0].verdict,'unknown');
});

test('abandoned process records become interrupted on read, without restarting any model',async t=>{
  const f=await fixture(t),plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()});
  f.store.query('INSERT INTO skill_execution_trials VALUES (?,?,?,?,?,?,?)','run','abandoned',plan.id,f.candidate.id,'running',2147483647,new Date().toISOString(),JSON.stringify({startedAt:new Date().toISOString(),pairs:[],verdict:'unknown',reason:'running'}));
  const recovered=f.engine.get(plan.id,f.task.id);assert.equal(recovered.trials[0].status,'interrupted');assert.match(recovered.trials[0].reason,/不自动重发/);
});

test('an actual-task tie cannot be bypassed with an improved text-only score',async t=>{
  const f=await fixture(t);
  const text=await f.studio.candidates.evaluate({id:f.candidate.id,context:f.task.id,model:{label:'fixture',async invoke({messages}){return {reportedModel:'fixture',finishReason:'stop',content:messages[0].content.includes('NEW method')?'均值，缺失':'旧回复'};}}});
  assert.equal(text.trials[0].verdict,'improved');
  const plan=await f.engine.freeze({candidateId:f.candidate.id,context:f.task.id,spec:spec()}),running=await f.engine.run({id:plan.id,context:f.task.id,model:provider('tie')});await running.job;
  assert.equal(f.engine.get(plan.id,f.task.id).trials[0].verdict,'no_gain');
  await assert.rejects(f.studio.candidates.promote({id:f.candidate.id,context:f.task.id,confirmed:true,trialId:text.trials[0].id}),/实际任务对照/);
});

test('actual publication rejects changed package resources and superseded proof', async t => {
  const f = await fixture(t);
  const reference = join(dirname(f.skill.storagePath), 'reference.txt');
  await writeFile(reference, 'frozen content');
  const plan = await f.engine.freeze({candidateId: f.candidate.id, context: f.task.id, spec: spec()});
  const first = await f.engine.run({id: plan.id, context: f.task.id, model: provider()});
  await first.job;
  const promote = () => f.studio.candidates.promote({id: f.candidate.id, context: f.task.id, confirmed: true, trialId: first.trialId});
  assert.equal(f.studio.candidates.get(f.candidate.id, f.task.id).publication.proof.trialId, first.trialId);
  await writeFile(reference, 'changed after evaluation');
  await assert.rejects(promote(), /配套资源已变化/);
  await writeFile(reference, 'frozen content');
  const second = await f.engine.run({id: plan.id, context: f.task.id, model: provider('tie')});
  await second.job;
  await assert.rejects(promote(), /实际任务对照未证明增益/);
  assert.equal(f.studio.get(f.skill.id, f.task.id).version, 1);
});

test('HTTP plan, asynchronous execution and artifact download use server-produced results and project scope',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sih-execution-http-')),projectPath=join(root,'original');await mkdir(projectPath);
  const fake=provider();
  const providerServer=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);const reply=await fake.invoke({...request,maxTokens:request.max_tokens});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',usage:reply.usage??{prompt_tokens:10,completion_tokens:5},choices:[{finish_reason:reply.tool_calls?'tool_calls':'stop',message:reply}]}));
  });providerServer.listen(0,'127.0.0.1');await once(providerServer,'listening');
  const app=await createApp({state:join(root,'state'),userSkillsPath:join(root,'skills'),env:{SKILLINTER_MODEL:'fixture',SKILLINTER_MODEL_URL:`http://127.0.0.1:${providerServer.address().port}/v1/chat/completions`}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();await new Promise(resolve=>providerServer.close(resolve));await rm(root,{recursive:true,force:true});});
  const api=async(path,body)=>{const response=await fetch('http://127.0.0.1:'+app.server.address().port+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
  const project=(await api('/api/projects',{path:projectPath})).data;
  const skill=(await api('/api/skill-studio/publish',{projectId:project.id,targetScope:'project',baseVersion:0,draft})).data.skill;
  const candidate=(await api('/api/skill-studio/candidates',{projectId:project.id,skillId:skill.id,baseVersion:1,draft:{...draft,instructions:'NEW method'},targetScope:'project'})).data;
  const plan=(await api('/api/skill-studio/candidates/'+candidate.id+'/execution-plans',{projectId:project.id,spec:spec(),verdict:'improved'})).data;
  assert.equal(plan.trials.length,0);
  const started=await api('/api/skill-studio/execution-plans/'+plan.id+'/run',{projectId:project.id});assert.equal(started.status,202);
  let result;for(let i=0;i<100;i++){result=(await api('/api/skill-studio/execution-plans/'+plan.id+'?project='+project.id)).data;if(result.trials[0]?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(result.trials[0].status,'completed');assert.equal(result.trials[0].verdict,'improved');
  const trial=result.trials[0],artifact=trial.pairs[0].candidate.artifacts[0],url='/api/skill-studio/execution-plans/'+plan.id+'/trials/'+trial.id+'/files/'+artifact.id;
  const download=await fetch('http://127.0.0.1:'+app.server.address().port+url+'?project='+project.id);assert.equal(download.status,200);assert.equal((await download.json()).mean,3);
  assert.equal((await fetch('http://127.0.0.1:'+app.server.address().port+url)).status,404);
  assert.equal((await api('/api/skill-studio/'+skill.id+'?project='+project.id)).data.skill.version,1);
  const candidateUrl = '/api/skill-studio/candidates/' + candidate.id;
  const skillUrl = '/api/skill-studio/' + skill.id;
  const scope = '?project=' + project.id;
  const review = {projectId: project.id, trialId: trial.id};
  const before = (await api(candidateUrl + scope)).data;
  assert.equal(before.trials.length, 0);
  assert.equal(before.publication.proof.scope, 'isolated-file-execution');
  assert.equal((await api(candidateUrl + '/promote', review)).status, 422);
  assert.equal((await api(candidateUrl + '/promote', {...review, confirmed: true, trialId: crypto.randomUUID()})).status, 409);
  const published = await api(candidateUrl + '/promote', {...review, confirmed: true});
  assert.equal(published.status, 200);
  assert.equal(published.data.skill.version, 2);
  assert.equal((await api(skillUrl + scope)).data.versions[0].candidateValidation.trialId, trial.id);

  const restore = {projectId: project.id, version: 1, baseVersion: 2, confirmed: true};
  assert.equal((await api(skillUrl + '/restore', {...restore, projectId: undefined})).status, 404);
  assert.equal((await api(skillUrl + '/restore', {...restore, confirmed: false})).status, 422);
  const restored = await api(skillUrl + '/restore', restore);
  assert.equal(restored.status, 201);
  assert.equal(restored.data.skill.version, 3);
  assert.equal((await api(skillUrl + '/restore', restore)).status, 409);
  const history = (await api(skillUrl + scope)).data;
  assert.deepEqual(history.versions.map(version => version.version), [3, 2, 1]);
  assert.deepEqual(history.versions[0].restoration, {fromVersion: 1, previousVersion: 2});
  assert.equal(history.versions[1].candidateValidation.trialId, trial.id);
  assert.equal(history.skill.instructions, draft.instructions);
  const library = (await api('/api/skill-studio' + scope)).data.skills;
  const route = routeSkills({prompt: '请用 paired-method', localSkills: library, graphData: {nodes: [], edges: []}});
  assert.equal(route.candidates[0].version, 3);

  const direct = await api('/api/skill-studio/publish', {projectId: project.id, skillId: skill.id, baseVersion: 3, draft});
  assert.equal(direct.status, 409);
  const next = (await api('/api/skill-studio/candidates', {projectId: project.id, skillId: skill.id, baseVersion: 3,
    draft: {...draft, instructions: 'NEW method with missing-input handling'}})).data;
  assert.equal(next.regressionCases.length, 2);
  assert.ok(next.regressionCases.every(sample => sample.version === 2 && sample.trialId === trial.id));
  assert.match(next.publication.reason, /历史回归/);

  const missing = {name: 'missing input', prompt: '测试输入文件缺失时的处理，将诊断写到 report.json。', files: [],
    acceptance: {version: 1, preserve_inputs: [], artifacts: [{path: 'report.json', format: 'json', require_change: true,
      checks: [{kind: 'json_equals', pointer: '/error', expected: '"missing_input"'}]}]}};
  const nextPlans = '/api/skill-studio/candidates/' + next.id + '/execution-plans';
  const changed = spec(); changed.cases[0].acceptance.artifacts[0].checks[0].expected = '0';
  assert.equal((await api(nextPlans, {projectId: project.id, spec: changed})).status, 422);
  const frozen = (await api(nextPlans, {projectId: project.id, spec: {budget: spec().budget, cases: [missing]}})).data;
  assert.deepEqual(frozen.spec.cases, [...spec().cases, missing]);
  assert.deepEqual(frozen.regressionIds, next.regressionCases.map(sample => sample.id));
  const nextPlan = '/api/skill-studio/execution-plans/' + frozen.id;
  assert.equal((await api(nextPlan + '/run', {projectId: project.id})).status, 202);
  let rerun;
  for (let i = 0; i < 100; i++) {
    rerun = (await api(nextPlan + scope)).data.trials[0];
    if (rerun.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(rerun.verdict, 'improved');
  assert.equal(rerun.pairs[2].baseline.status, 'failed');
  assert.equal(rerun.pairs[2].candidate.status, 'passed');
});

test('an actual regression blocks publication even when a new task improves', async t => {
  const f = await fixture(t);
  const first = await f.engine.freeze({candidateId: f.candidate.id, context: f.task.id, spec: spec()});
  const proven = await f.engine.run({id: first.id, context: f.task.id, model: provider()});
  await proven.job;
  const released = await f.studio.candidates.promote({id: f.candidate.id, context: f.task.id, confirmed: true, trialId: proven.trialId});
  const next = f.studio.candidates.save({context: f.task.id, skillId: f.skill.id, baseVersion: released.skill.version,
    draft: {...draft, instructions: 'NEW method follow-up'}});
  const sample = spec();
  sample.cases = [{...sample.cases[0], name: 'new task', prompt: '处理一份新材料并写出 report.json。',
    files: [{path: 'input.json', content: '{"values":[9,11]}'}],
    acceptance: {...sample.cases[0].acceptance, artifacts: [{...sample.cases[0].acceptance.artifacts[0],
      checks: [{kind: 'json_equals', pointer: '/mean', expected: '10'}]}]}}];
  const plan = await f.engine.freeze({candidateId: next.id, context: f.task.id, spec: sample});
  const fake = provider('tie');
  const model = {...fake, async invoke(options) {
    const candidate = options.messages[0].content.includes('follow-up');
    const response = await fake.invoke(options);
    if (options.messages.at(-1).tool_call_id !== 'read') return response;
    const args = JSON.parse(response.tool_calls[0].function.arguments);
    const actual = JSON.parse(args.content).mean;
    if ((candidate && actual === 3) || (!candidate && actual === 10)) {
      return {...response, ...call('write','create_file',{...args, content:'{"mean":0}'})};
    }
    return response;
  }};
  const second = await f.engine.run({id: plan.id, context: f.task.id, model});
  await second.job;
  const latest = f.engine.get(plan.id, f.task.id).trials[0];
  assert.equal(latest.improvedCases, 1);
  assert.equal(latest.regressed, true);
  await assert.rejects(f.studio.candidates.promote({id: next.id, context: f.task.id, confirmed: true, trialId: second.trialId}), /历史回归用例尚未全部通过/);
  assert.equal(f.studio.get(f.skill.id, f.task.id).version, 2);
});
