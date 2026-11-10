import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Store} from './src/store.mjs';
import {createSkillStudio} from './src/skill-studio.mjs';
import {createSkillRegistry,registryContract,registrySnapshotSchema} from './src/skill-registry.mjs';
import {createSkillGraph} from './src/skill-graph.mjs';
import {routeSkills} from './src/skill-routing.mjs';
import {createSkillSession} from './src/skill-session.mjs';
import {executeRun} from './src/runner.mjs';
import {toolsForScope} from './src/tools.mjs';
import {createApp} from './src/server.mjs';
import {validate} from './src/schema.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'sih-registry-'));
  const store=new Store(join(root,'state.sqlite'));
  const studio=createSkillStudio(store,{userSkillsPath:join(root,'skills')});
  const projectFor=context=>context&&typeof context==='object'?store.project(context.projectId).id:context?store.task(context).project_id:null;
  const registry=createSkillRegistry({store,studio,projectFor});
  const graph=createSkillGraph({store,studio,projectFor,registry});
  const path=join(root,'project');await mkdir(path);const project=store.addProject(path,'one');const context={projectId:project.id};
  t.after(async()=>{store.db.close();await rm(root,{recursive:true,force:true});});
  const publish=(name,scope=null)=>studio.publish({taskId:scope,baseVersion:0,targetScope:scope?'project':'global',
    draft:{name,description:'读取项目材料并核对文件内容',instructions:'Read the actual file. Record the real tool receipt.',tests:[]}});
  const relation=(source,target,type='depend_on',scope=null,remove=false)=>registry.relation({context:scope,source:source.id,target:target.id,type,remove,expectedRevision:registry.snapshot(scope).revision});
  return {root,store,studio,registry,graph,context,project,publish,relation,path};
}

test('UUID identities, explicit external binding, same names and project overrides never silently merge',async t=>{
  const f=await fixture(t);
  const global=f.publish('same-name'),local=f.publish('same-name',f.context);
  const otherPath=join(f.root,'other');await mkdir(otherPath);const other=f.store.addProject(otherPath,'two');
  const unrelated=f.publish('same-name',{projectId:other.id});
  const snapshot=f.registry.snapshot(f.context);
  assert.equal(snapshot.skills.length,2);assert(snapshot.skills.every(skill=>skill.selectable));
  assert(!snapshot.skills.some(skill=>skill.skillId===unrelated.id));
  assert.match(snapshot.skills[0].contentSha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot),JSON.stringify(f.registry.snapshot(f.context)));
  assert.deepEqual(validate(registrySnapshotSchema,snapshot),[]);
  const route=routeSkills({prompt:'same-name',localSkills:f.studio.list(f.context),registrySnapshot:snapshot});
  assert.equal(route.candidates.length,0);assert(route.warnings.some(message=>message.includes('同名')));
  assert.deepEqual(f.registry.snapshot(null).externalRefs,[]);
  // Naming a local skill like an original catalog node does not activate old edges.
  const catalogNamed=f.publish('literature-review');
  assert(!f.registry.snapshot(null).externalRefs.some(ref=>ref.skillId===catalogNamed.id));
  assert.equal(f.registry.snapshot(null).relations.length,0);
  f.registry.bind({context:null,skillId:catalogNamed.id,externalId:'literature-review',expectedRevision:f.registry.snapshot(null).revision});
  assert.equal(f.registry.snapshot(null).externalRefs[0].skillId,catalogNamed.id);
  assert.throws(()=>f.registry.bind({context:null,skillId:global.id,externalId:'literature-review',expectedRevision:f.registry.snapshot(null).revision}),/已绑定/);
  assert.throws(()=>f.registry.bind({context:null,skillId:global.id,externalId:'does-not-exist',expectedRevision:f.registry.snapshot(null).revision}),/没有这个外部/);
  f.registry.override({context:f.context,projectSkillId:local.id,globalSkillId:global.id,expectedRevision:f.registry.snapshot(f.context).revision});
  const updated=f.registry.snapshot(f.context);
  assert.equal(updated.skills.find(skill=>skill.skillId===global.id).selectable,false);
  assert.equal(f.registry.snapshot(null).skills.find(skill=>skill.skillId===global.id).selectable,true);
  assert.equal(f.registry.snapshot({projectId:other.id}).skills.find(skill=>skill.skillId===global.id).selectable,true);
  const selected=routeSkills({prompt:'same-name',localSkills:f.studio.list(f.context),registrySnapshot:updated});
  assert.deepEqual(selected.candidates.map(skill=>skill.id),[local.id]);
  assert.throws(()=>f.registry.override({context:f.context,projectSkillId:unrelated.id,globalSkillId:global.id,expectedRevision:updated.revision}),/当前项目/);
});

test('typed relations enforce direction, cycle rollback, stale edits and scoped legacy migration',async t=>{
  const f=await fixture(t),a=f.publish('method-a'),b=f.publish('method-b'),c=f.publish('method-c');
  f.graph.relation({context:null,source:a.id,target:b.id});
  assert.equal(f.registry.snapshot(null).relations.length,0,'old manual edge stays visual');
  assert.equal(f.graph.snapshot(null).edges.filter(edge=>edge.kind==='manual').length,1);
  const old=f.registry.snapshot(null);
  f.relation(a,b);
  const result=f.relation(b,c);
  assert.deepEqual(validate(registryContract.operations[0].returns,{ok:true,data:result,error:{code:'OK',message:''}}),[]);
  const frozen=f.registry.snapshot(null);
  assert.throws(()=>f.relation(c,a),/循环/);
  assert.equal(f.registry.snapshot(null).sha256,frozen.sha256,'cycle rejection is atomic');
  assert.throws(()=>f.registry.relation({context:null,source:a.id,target:c.id,type:'depend_on',expectedRevision:old.revision}),/刷新/);
  const route=routeSkills({prompt:a.name,customSkill:a,localSkills:f.studio.list(null),registrySnapshot:frozen});
  assert.deepEqual(route.candidates.map(skill=>skill.id),[c.id,b.id,a.id]);
  assert.equal(f.graph.snapshot(null).edges.filter(edge=>edge.registryType==='depend_on').length,2);
  f.relation(a,c,'compose_with');f.relation(b,a,'similar_to');
  f.relation(a,b,'depend_on',null,true);f.relation(b,c,'depend_on',null,true);
  const suggestions=routeSkills({prompt:a.name,customSkill:a,localSkills:f.studio.list(null),registrySnapshot:f.registry.snapshot(null)});
  assert.deepEqual(suggestions.candidates.map(skill=>skill.id),[a.id]);
  f.relation(a,b,'depend_on',f.context);
  assert.equal(f.registry.snapshot(null).relations.filter(edge=>edge.type==='depend_on').length,0);
  assert.equal(f.registry.snapshot(f.context).relations.filter(edge=>edge.type==='depend_on').length,1);
});

test('snapshot governs actual session starts and route revisions cannot bypass a dependency',async t=>{
  const f=await fixture(t),a=f.publish('task-a'),b=f.publish('task-b');f.relation(a,b);
  const task=f.store.createTask(f.project.id).id;
  const run=f.store.begin(task,'session','task-a',{}).id;
  const localSkills=f.studio.list(task),snapshot=f.registry.snapshot(task,localSkills);
  const route=routeSkills({prompt:'task-a',customSkill:a,localSkills,registrySnapshot:snapshot});
  const session=createSkillSession({store:f.store,task,run,localSkills,route,scope:{mode:'project_read',projectId:f.project.id,projectPath:f.path},
    tools:toolsForScope({mode:'project_read'}),signal:new AbortController().signal});
  await session.prepare();
  assert.equal((await session.execute('start_skill',{skill_id:a.id})).error.code,'DEPENDENCY_INCOMPLETE');
  assert.equal((await session.execute('revise_skill_route',{skill_ids:[a.id],rationale:'跳过依赖'})).error.code,'DEPENDENCY_INCOMPLETE');
  f.relation(a,b,'depend_on',null,true);
  assert.equal((await session.execute('start_skill',{skill_id:a.id})).error.code,'DEPENDENCY_INCOMPLETE','editing live graph cannot change this session');
  assert.equal((await session.execute('start_skill',{skill_id:b.id})).ok,true);
  session.receipt(17,'read_file',{ok:true,data:{}});
  assert.equal((await session.execute('finish_skill',{skill_id:b.id,status:'applied',summary:'read receipt',evidence:[17]})).ok,true);
  assert.equal((await session.execute('start_skill',{skill_id:a.id})).ok,true);
});

test('real file operations follow edited graph; history survives registry replacement and skill updates',async t=>{
  const f=await fixture(t),a=f.publish('deliver-final'),b=f.publish('inspect-source');
  await writeFile(join(f.path,'evidence.txt'),'actual project evidence');
  f.relation(a,b);
  const task=f.store.createTask(f.project.id).id;
  const tool=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  async function run(request){
    const skills=f.studio.list(task),snapshot=f.registry.snapshot(task,skills),route=routeSkills({prompt:a.name,customSkill:a,localSkills:skills,registrySnapshot:snapshot});
    let index=0;
    const run=f.store.begin(task,request,a.name,{}).id;
    const model={label:'deterministic-execution-fixture',async invoke({messages}){
      const last=messages.at(-1);
      if(last.role==='tool'&&last.tool_call_id?.startsWith('read-')){
        const skill=route.candidates[index++];
        // The real receipt index is host-generated; select the last task-operation receipt.
        const receipt=JSON.parse(messages[0].content.split('服务端工具回执索引：').at(-1)).findLast(item=>item.name==='read_file'||item.tool==='read_file');
        const evidenceSeq=receipt?.seq;assert(Number.isInteger(evidenceSeq));
        return {tool_calls:[tool('finish_skill',{skill_id:skill.id,status:'applied',summary:'已读取真实文件',evidence:[evidenceSeq]},'finish-'+index)]};
      }
      if(index<route.candidates.length){const skill=route.candidates[index];return {tool_calls:[tool('start_skill',{skill_id:skill.id},'start-'+index),tool('read_file',{path:'evidence.txt'},'read-'+index)]};}
      return {content:'已按依赖核对项目材料。'};
    }};
    await executeRun({id:run,task,prompt:a.name,store:f.store,workspace:f.path,scope:{mode:'project_read',projectId:f.project.id,projectPath:f.path},
      model,signal:new AbortController().signal,maxSteps:12,skillAccess:true,customSkill:skills.find(skill=>skill.id===a.id),localSkills:skills,skillRegistrySnapshot:snapshot});
    return {run,events:f.store.events(run,0),snapshot};
  }
  const first=await run('first');
  assert.equal(f.store.run(first.run).status,'completed');
  const starts=first.events.filter(event=>event.type==='skill_runtime').flatMap(event=>event.payload.graph.nodes.filter(node=>node.state==='running').map(node=>node.id));
  assert.equal(starts[0],b.id);assert(starts.includes(a.id));
  const reads=first.events.filter(event=>event.type==='tool_result'&&event.payload.name==='read_file');
  assert.equal(reads.length,2);assert(reads.every(event=>event.payload.output.ok&&event.payload.output.data.file.content==='actual project evidence'));
  assert.deepEqual(first.events.filter(event=>event.type==='skill_application').map(event=>[event.payload.id,event.payload.status]),[[b.id,'applied'],[a.id,'applied']]);
  f.relation(a,b,'depend_on',null,true);
  const second=await run('second');assert.equal(second.snapshot.relations.length,0);
  assert.equal(second.events.filter(event=>event.type==='tool_result'&&event.payload.name==='read_file').length,1);
  f.studio.publish({skillId:a.id,baseVersion:1,draft:{name:a.name,description:a.description,instructions:'Changed method.',tests:[]}});
  const restored=createSkillRegistry({store:f.store,studio:f.studio,projectFor:context=>f.store.task(context).project_id});
  assert.deepEqual(restored.forRun(first.run),first.snapshot);
  assert.equal(restored.forRun(first.run).skills.find(skill=>skill.skillId===a.id).version,1);
  assert.equal(restored.forRun(second.run).relations.length,0);
  const archive=f.store.task(task).runs.find(record=>record.id===first.run).artifacts.find(file=>file.name==='skill-execution.json');assert(archive);
  assert.deepEqual(JSON.parse(Buffer.from(f.store.file(task,archive.id).bytes).toString('utf8')).route.registrySnapshot,first.snapshot);
  const reopened=new Store(join(f.root,'state.sqlite'));
  try{
    const history=createSkillRegistry({store:reopened,studio:{},projectFor:()=>null});
    assert.deepEqual(history.forRun(first.run),first.snapshot);
  }finally{reopened.db.close();}
});

test('same-origin APIs expose contracts, scoped typed edits and reject stale mutations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sih-registry-api-'));
  const app=await createApp({state:root});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port;
  const api=async(path,body,method='POST')=>{const response=await fetch(base+path,body?{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:response.status,body:await response.json()};};
  const publish=async name=>(await api('/api/skill-studio/publish',{baseVersion:0,draft:{name,description:'test task method',instructions:'Read real evidence.',tests:[]}})).body.skill;
  const a=await publish('api-method-a'),b=await publish('api-method-b');
  const before=(await api('/api/skill-registry')).body.data;
  const saved=await api('/api/skill-registry/relations',{source:a.id,target:b.id,type:'depend_on',expectedRevision:before.revision});assert.equal(saved.status,200);
  assert.equal((await api('/api/skill-registry/relations',{source:b.id,target:a.id,type:'depend_on',expectedRevision:before.revision})).status,409);
  const snapshot=(await api('/api/skill-registry')).body.data;
  const cycle=await api('/api/skill-registry/relations',{source:b.id,target:a.id,type:'depend_on',expectedRevision:snapshot.revision});
  assert.equal(cycle.body.error.code,'DEPENDENCY_CYCLE');
  const graph=(await api('/api/skill-graph/skills')).body;assert(graph.edges.some(edge=>edge.registryType==='depend_on'&&edge.source===a.id));
  const contract=(await api('/api/skill-registry/contract')).body;assert.equal(contract.operations.length,3);
  const invalid=await api('/api/skill-registry/relations',{source:a.id,target:b.id,type:'invented',expectedRevision:snapshot.revision});assert.equal(invalid.status,422);
});

test('missing registered prerequisite blocks task file operations instead of silently using base tools',async t=>{
  const f=await fixture(t),a=f.publish('blocked-task'),b=f.publish('required-method');f.relation(a,b);
  await rm(b.storagePath);await writeFile(join(f.path,'evidence.txt'),'must not be read by the blocked skill');
  const task=f.store.createTask(f.project.id).id,localSkills=f.studio.list(task);
  const snapshot=f.registry.snapshot(task,localSkills);
  assert(snapshot.issues.some(issue=>issue.skillId===a.id&&issue.code==='RELATION_ENDPOINT_UNAVAILABLE'));
  const run=f.store.begin(task,'missing','blocked-task',{}).id;
  const model={label:'missing-prerequisite-fixture',async invoke(){return {tool_calls:[{id:'read',function:{name:'read_file',arguments:'{"path":"evidence.txt"}'}}]};}};
  await executeRun({id:run,task,prompt:a.name,store:f.store,workspace:f.path,scope:{mode:'project_read',projectId:f.project.id,projectPath:f.path},
    model,signal:new AbortController().signal,maxSteps:1,skillAccess:true,customSkill:a,localSkills,skillRegistrySnapshot:snapshot});
  const output=f.store.events(run,0).find(event=>event.type==='tool_result'&&event.payload.name==='read_file').payload.output;
  assert.equal(output.ok,false);assert.equal(output.error.code,'DEPENDENCY_INCOMPLETE');assert.equal(output.data,null);
});
