import assert from 'node:assert/strict';
import {canDraftFromRun, summarizeRun} from './src/run-outcome.mjs';
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
import {readCitationReceipts, verifyCitations} from './src/citation-verifier.mjs';

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
  assert.equal(run.outcome.status,'failed');assert.match(run.outcome.label,/交付未通过/);
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

test('main chat preserves the original reply and calibrates a uniquely grounded citation before completing', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'evidence.md'), 'Heading\n\nPython 3.11 required\n');
  const original = {findings: [{id: 'python', status: 'verified', claim: '最低 Python 3.11',
    evidence: [{path: 'evidence.md', line: 2, quote: 'Python 3.11 required'}]}]};
  let calls = 0;
  const model = {label: 'fixture', async invoke() {
    return ++calls === 1 ? {tool_calls: [{id: 'read', type: 'function',
      function: {name: 'read_file', arguments: '{"path":"evidence.md"}'}}]} : {content: JSON.stringify(original)};
  }};
  await executeRun({id: f.run, task: f.task, prompt: '核对版本并引用原文', store: f.store, workspace: f.root,
    scope: f.scope, model, signal: f.signal, maxSteps: 3});
  const saved = f.store.task(f.task).runs[0];
  assert.equal(saved.status, 'completed');
  assert.equal(JSON.parse(saved.answer).findings[0].evidence[0].line, 3);
  assert.equal(saved.citationVerification.status, 'passed');
  assert.equal(saved.citationVerification.corrections[0].originalLine, 2);
  const artifact = f.store.file(f.task, saved.citationVerification.artifact.id);
  assert.deepEqual(JSON.parse(JSON.parse(Buffer.from(artifact.bytes).toString()).originalAnswer), original);
});

test('a cited JSON block inside prose cannot bypass main-chat schema verification', async t => {
  const f = await fixture(t);
  const wrong = {findings: [{id: 'x', status: 'verified', claim: 'Unverified claim',
    evidence: [{file: 'input.json', lines: '1-1', quote: '[2,4]'}]}]};
  const model = {label: 'fixture', async invoke() {
    return {content: 'All done.\n' + String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify(wrong) +
      '\n' + String.fromCharCode(96).repeat(3)};
  }};
  await executeRun({id: f.run, task: f.task, prompt: '核对引用', store: f.store, workspace: f.root,
    scope: f.scope, model, signal: f.signal, maxSteps: 2});
  const saved = f.store.task(f.task).runs[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.citationVerification.issues[0].code, 'CITATION_SCHEMA');
});

test('citation verification rejects unread ranges, ambiguous quotes and sources changed since the read', async t => {
  const f = await fixture(t);
  const content = 'Repeated statement\nRepeated statement\nOutside read range\n';
  await writeFile(join(f.root, 'evidence.md'), content);
  const output = await executeTool({function: {name: 'read_file',
    arguments: '{"path":"evidence.md","offset":0,"limit":2}'}}, f.root, f.signal, f.scope);
  const receipts = readCitationReceipts([{seq: 1, type: 'tool_result', payload: {name: 'read_file', output}}]);
  const verify = (path, quote, line = 10) => verifyCitations([{id: 'x', status: 'verified', claim: 'Evidence',
    evidence: [{path, line, quote}]}], {receipts, signal: f.signal,
    loadSource: async path => ({bytes: Buffer.from(path === 'evidence.md' ? content : '')})});
  assert.equal((await verify('other.md', 'Repeated statement')).issues[0].code, 'SOURCE_NOT_READ');
  assert.equal((await verify('evidence.md', 'Repeated statement')).issues[0].code, 'AMBIGUOUS_CITATION');
  assert.equal((await verify('evidence.md', 'Outside read range', 3)).issues[0].code, 'CITATION_NOT_FOUND');
  const changed = await verifyCitations([{id: 'x', status: 'verified', claim: 'Evidence',
    evidence: [{path: 'evidence.md', line: 1, quote: 'Repeated statement'}]}],
    {receipts, loadSource: async () => ({bytes: Buffer.from(content + 'changed')}), signal: f.signal});
  assert.equal(changed.issues[0].code, 'CITATION_SOURCE_CHANGED');
});

test('file delivery requires correct citation bytes and rechecks the source using this run receipts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'source.md'), 'Title\nExact source evidence\n');
  const declaration = {version: 1, preserve_inputs: ['source.md'], artifacts: [{path: 'cited.json',
    format: 'json', require_change: true, checks: [check('json_citations', '/findings', '')]}]};
  assert.ok(validDelivery(declaration));
  const frozen = await freezeDelivery({contract: declaration, scope: f.scope, signal: f.signal});
  const output = await executeTool({function: {name: 'read_file', arguments: '{"path":"source.md"}'}}, f.root, f.signal, f.scope);
  const readReceipts = readCitationReceipts([{seq: 1, type: 'tool_result', payload: {name: 'read_file', output}}]);
  const report = {findings: [{id: 'source', status: 'verified', claim: 'Evidence',
    evidence: [{path: 'source.md', line: 1, quote: 'Exact source evidence'}]}]};
  await writeFile(join(f.root, 'cited.json'), JSON.stringify(report));
  const verify = () => verifyDelivery({frozen, scope: f.scope, signal: f.signal, readReceipts});
  const wrong = await verify();
  assert.equal(wrong.status, 'failed');
  assert.ok(wrong.checks.some(item => item.code === 'CITATION_LINE_MISMATCH'));
  report.findings[0].evidence[0].line = 2;
  await writeFile(join(f.root, 'cited.json'), JSON.stringify(report));
  assert.equal((await verify()).status, 'passed');
  await writeFile(join(f.root, 'source.md'), 'Title\nReplaced source evidence\n');
  assert.equal((await verify()).status, 'failed');
});

test('run outcome uses latest real checks, separates reply completion and declared delivery, and never certifies an unfinished chain', () => {
  const run={status:'completed',skillRoute:{candidates:[{id:'a'}]},skillApplications:[{id:'a',status:'applied'}],
    skillDeliveries:[{id:'a',status:'failed'},{id:'a',status:'passed'}]};
  assert.equal(summarizeRun(run).status,'verified');
  run.skillDeliveries.push({id:'a',status:'failed'});
  assert.equal(summarizeRun(run).status,'failed');
  assert.match(summarizeRun(run).label,/交付未通过/);
  run.skillDeliveries.push({id:'a',status:'unknown'});
  assert.equal(summarizeRun(run).status,'unverified');
  run.skillDeliveries.push({id:'a',status:'passed'});
  run.plan={steps:[{status:'in_progress'}]};
  assert.equal(summarizeRun(run).status,'incomplete');
  run.plan.steps[0].status='completed';run.skillApplications.push({id:'a',status:'failed'});
  assert.equal(summarizeRun(run).counts.unappliedSkills,1);
  run.status='stopped';assert.equal(summarizeRun(run).status,'stopped');
  assert.equal(summarizeRun({status:'completed'}).status,'unverified');
  assert.equal(summarizeRun({status:'completed',citationVerification:{status:'failed'}}).status,'failed');
  assert.equal(canDraftFromRun({status:'failed',error:'原文核验失败'}),true);
  assert.equal(canDraftFromRun({status:'stopped',skillDeliveries:[{status:'failed'}]}),true);
  assert.equal(canDraftFromRun({status:'running',answer:'部分输出'}),false);
  assert.equal(canDraftFromRun({status:'stopped'}),false);
});
