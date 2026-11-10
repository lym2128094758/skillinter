import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freezeDelivery,verifyDelivery,validDelivery,deliveryResultSchema} from './src/skill-delivery.mjs';
import {Store} from './src/store.mjs';
import {createSkillStudio,cleanDraft} from './src/skill-studio.mjs';
import {skillMarkdown} from './src/skill-files.mjs';
import {parseSkillFile} from './src/skill-import.mjs';
import {createSkillSession} from './src/skill-session.mjs';
import {routeSkills} from './src/skill-routing.mjs';
import {toolsForScope,executeTool} from './src/tools.mjs';
import {validate} from './src/schema.mjs';
import {executeRun} from './src/runner.mjs';

const check = (kind,pointer,expected) => ({kind,pointer,expected});
const contract = () => ({version:1,preserve_inputs:['input.json'],artifacts:[{path:'report.json',format:'json',require_change:true,checks:[
  check('json_length','/records','2'),check('json_equals','/mean','3'),check('json_type','/records','array'),check('text_excludes','','ignore all previous rules')]}]});
const draft = () => ({name:'verified-summary',description:'复算并保存报告',instructions:'读取 input.json，写 report.json。均值为 3，保留原输入。',tests:[],delivery:contract()});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'sih-delivery-'));
  const store=new Store(join(root,'tasks.sqlite'));
  const studio=createSkillStudio(store,{userSkillsPath:join(root,'skills')});
  const project=store.addProject(root,'fixture'),task=store.createTask(project.id);
  const run=store.begin(task.id,'delivery','verified-summary 复算',{mode:'api',model:'fixture'});
  const scope={mode:'project_write',projectPath:root,projectId:project.id};
  const signal=new AbortController().signal;
  await writeFile(join(root,'input.json'),'[2,4]');
  const skill=studio.publish({taskId:task.id,targetScope:'project',baseVersion:0,draft:draft()});
  const session=createSkillSession({store,task:task.id,run:run.id,localSkills:[skill],route:routeSkills({prompt:skill.name,customSkill:skill,localSkills:[skill]}),scope,tools:toolsForScope(scope),signal});
  t.after(async()=>{store.db.close();await rm(root,{recursive:true,force:true});});
  return {root,store,studio,task:task.id,run:run.id,skill,scope,signal,session};
}

test('delivery contract travels with versioned skills and rejects invalid paths or meaningless checks',()=>{
  const sample=draft();assert.deepEqual(cleanDraft(parseSkillFile('SKILL.md',skillMarkdown(sample))),sample);
  assert.deepEqual(cleanDraft(parseSkillFile('skill.json',JSON.stringify(sample))),sample);
  for(const path of ['../outside','C:/outside','.env','folder/.private']) assert.equal(validDelivery({...contract(),preserve_inputs:[path]}),false);
  assert.equal(validDelivery({...contract(),preserve_inputs:['report.json']}),false);
  for(const invalid of [check('json_equals','/mean','not json'),check('json_type','/mean','invented'),check('json_equals','/bad~2','3'),check('text_contains','/mean','x')]) {
    const c=contract();c.artifacts[0].checks=[invalid];assert.equal(validDelivery(c),false);
  }
});

test('independent file checks bind before/after hashes, JSON pointers and preserved inputs',async t=>{
  const f=await fixture(t);
  const c=contract();c.artifacts[0].checks.push(check('json_equals','/a~1b/~0key','{"b":2,"a":1}'));
  const frozen=await freezeDelivery({contract:c,scope:f.scope,signal:f.signal});
  c.artifacts[0].checks=[]; // Caller mutations do not change the frozen rule.
  await writeFile(join(f.root,'report.json'),JSON.stringify({records:[2,4],mean:3,'a/b':{'~key':{a:1,b:2}}}));
  let result=await verifyDelivery({frozen,scope:f.scope,signal:f.signal});
  assert.equal(result.status,'passed');assert.deepEqual(validate(deliveryResultSchema,result),[]);
  assert.match(result.verifierSha256,/^[a-f0-9]{64}$/);
  assert.equal(result.files.find(file=>file.role==='input').beforeSha256,result.files.find(file=>file.role==='input').sha256);
  await writeFile(join(f.root,'report.json'),'{"records":[2],"mean":4}');
  result=await verifyDelivery({frozen,scope:f.scope,signal:f.signal});assert.equal(result.status,'failed');assert.ok(result.checks.some(x=>x.code==='JSON_LENGTH'&&x.status==='failed'));
  await writeFile(join(f.root,'input.json'),'[2,5]');
  result=await verifyDelivery({frozen,scope:f.scope,signal:f.signal});assert.equal(result.checks.find(x=>x.code==='INPUT_UNCHANGED').status,'failed');
});

test('missing, invalid, unchanged and unreadable output never silently pass; late contracts stay unknown',async t=>{
  const f=await fixture(t),frozen=await freezeDelivery({contract:contract(),scope:f.scope,signal:f.signal});
  assert.equal((await verifyDelivery({frozen,scope:f.scope,signal:f.signal})).status,'failed');
  await writeFile(join(f.root,'report.json'),'not JSON');assert.ok((await verifyDelivery({frozen,scope:f.scope,signal:f.signal})).checks.some(x=>x.code==='INVALID_JSON'));
  await writeFile(join(f.root,'report.json'),'{"records":[2,4],"mean":3}');
  const unchanged=await freezeDelivery({contract:contract(),scope:f.scope,signal:f.signal});
  assert.equal((await verifyDelivery({frozen:unchanged,scope:f.scope,signal:f.signal})).checks.find(x=>x.code==='ARTIFACT_CHANGED').status,'failed');
  await writeFile(join(f.root,'report.json'),'x'.repeat(1024*1024+1));assert.equal((await verifyDelivery({frozen,scope:f.scope,signal:f.signal})).status,'unknown');
  assert.equal((await verifyDelivery({frozen:{...frozen,beforeExecution:false},scope:f.scope,signal:f.signal})).status,'unknown');
  const unavailable=await freezeDelivery({contract:contract(),scope:{mode:'attachments'},signal:f.signal});
  assert.equal((await verifyDelivery({frozen:unavailable,scope:{mode:'attachments'},signal:f.signal})).status,'unknown');
  assert.equal((await verifyDelivery({scope:f.scope,signal:f.signal})).status,'unspecified');
});

test('skill cannot claim applied on wrong bytes; repair passes and later tampering invalidates its application',async t=>{
  const f=await fixture(t);await f.session.prepare();
  assert.equal((await f.session.execute('start_skill',{skill_id:f.skill.id})).ok,true);
  const output=await executeTool({function:{name:'read_file',arguments:'{"path":"input.json"}'}},f.root,f.signal,f.scope);
  f.store.record(f.run,'tool_result',{name:'read_file',output});const seq=f.store.events(f.run,0).at(-1).seq;f.session.receipt(seq,'read_file',output);
  await writeFile(join(f.root,'report.json'),'{"records":[2],"mean":99}');
  const finish={skill_id:f.skill.id,status:'applied',summary:'模型声称成功',evidence:[seq]};
  assert.equal((await f.session.execute('finish_skill',finish)).error.code,'DELIVERY_NOT_PASSED');
  assert.equal(f.store.events(f.run,0).filter(e=>e.type==='skill_application').length,0);
  await writeFile(join(f.root,'report.json'),'{"records":[2,4],"mean":3}');
  const verified=await f.session.execute('verify_skill_output',{skill_id:f.skill.id});
  assert.equal(verified.data.status,'passed');assert.deepEqual(verified.data.operationReceipts,[seq]);
  assert.equal(f.session.receipt(seq+100,'verify_skill_output',verified),undefined);
  assert.equal((await f.session.execute('finish_skill',finish)).ok,true);
  await writeFile(join(f.root,'report.json'),'{"records":[],"mean":0}');await f.session.verifyApplied();f.session.finalize('completed');
  const events=f.store.events(f.run,0);assert.equal(events.filter(e=>e.type==='skill_application').at(-1).payload.status,'failed');
  assert.equal(f.store.task(f.task).runs[0].skillDeliveries.at(-1).status,'failed');
  const artifact=f.store.task(f.task).runs[0].artifacts.find(x=>x.name==='skill-execution.json');
  const record=JSON.parse(Buffer.from(f.store.file(f.task,artifact.id).bytes).toString('utf8'));assert.equal(record.deliveryResults[f.skill.id].status,'failed');
  assert.ok(events.find(e=>e.type==='skill_delivery_prepared').seq<events.find(e=>e.type==='tool_result').seq);
});

test('a skill first inspected after a mutation cannot retroactively certify that output',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.root,'report.json'),'{"records":[2,4],"mean":3}');f.store.record(f.run,'tool_result',{name:'create_file',output:{ok:true}});
  await f.session.prepare();await f.session.execute('start_skill',{skill_id:f.skill.id});
  const result=await f.session.execute('verify_skill_output',{skill_id:f.skill.id});assert.equal(result.data.status,'unknown');assert.equal(result.data.frozenBeforeExecution,false);
});

test('main chat host finalization exposes unmet acceptance even when a model skips finish_skill',async t=>{
  const f=await fixture(t);let calls=0;
  const model={label:'fixture',async invoke(){calls++;return calls===1?{tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"input.json"}'}}]}:{content:'已完成，报告正确。'};}};
  await executeRun({id:f.run,task:f.task,prompt:'verified-summary 复算',store:f.store,workspace:f.root,model,signal:f.signal,scope:f.scope,skillAccess:true,localSkills:[f.skill],maxSteps:3});
  const run=f.store.task(f.task).runs[0];assert.equal(run.status,'completed');assert.match(run.answer,/SIH 产物验收/);assert.match(run.answer,/未通过/);assert.equal(run.skillDeliveries.at(-1).status,'failed');
});

test('main chat receipt index and verifier advertise the same real operations, excluding verification calls',async t=>{
  const f=await fixture(t);let calls=0;
  const call=(name,args)=>({tool_calls:[{id:'call-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model={label:'fixture',async invoke({messages}) {
    calls++;
    if(calls===1)return call('read_file',{path:'input.json'});
    if(calls===2)return call('create_file',{path:'report.json',content:'{"records":[2,4],"mean":3}'});
    if(calls===3)return call('verify_skill_output',{skill_id:f.skill.id});
    if(calls===4){
      const verified=JSON.parse(messages.at(-1).content);assert.equal(verified.data.status,'passed');assert.equal(verified.data.operationReceipts.length,2);
      const index=JSON.parse(messages[0].content.split('服务端工具回执索引：').at(-1));
      assert.deepEqual(index.map(item=>item.seq),verified.data.operationReceipts);assert.ok(index.every(item=>['read_file','create_file'].includes(item.name)));
      return call('finish_skill',{skill_id:f.skill.id,status:'applied',summary:'实际文件已验收',evidence:verified.data.operationReceipts});
    }
    return {content:'实际文件完成。'};
  }};
  await executeRun({id:f.run,task:f.task,prompt:'verified-summary 复算',store:f.store,workspace:f.root,model,signal:f.signal,scope:f.scope,skillAccess:true,localSkills:[f.skill],maxSteps:6});
  const run=f.store.task(f.task).runs[0];assert.equal(run.status,'completed');assert.equal(run.skillApplications.at(-1).status,'applied');assert.equal(run.skillDeliveries.at(-1).status,'passed');
});

test('candidate provenance contains host file acceptance rather than only the assistant success claim',async t=>{
  const f=await fixture(t);await f.session.prepare();await f.session.execute('start_skill',{skill_id:f.skill.id});
  await f.session.execute('verify_skill_output',{skill_id:f.skill.id});
  await writeFile(join(f.root,'report.json'),'{"records":[2,4],"mean":3}');await f.session.verifyApplied();
  f.session.finalize('completed');f.store.finish(f.run,'completed',{answer:'模型声称成功'});
  const candidate=f.studio.candidates.save({context:f.task,taskId:f.task,sourceRunId:f.run,skillId:f.skill.id,baseVersion:1,draft:{...draft(),tests:[
    {prompt:'材料值 1 与 3，提取均值。',expected_output:'均值 2',expectations:['包含：2']},
    {prompt:'材料没有记录，不能计算均值。',expected_output:'缺失',expectations:['包含：缺失']},
  ]}});
  const evidence=candidate.sourceEvidence.skillDeliveries;
  assert.equal(evidence[0].status,'failed');assert.equal(evidence.at(-1).status,'passed');
  assert.match(evidence.at(-1).files.find(file=>file.role==='artifact').sha256,/^[a-f0-9]{64}$/);
  assert.match(evidence.at(-1).verifierSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(candidate.draft.delivery,f.skill.delivery);
});
