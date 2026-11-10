import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {RequestError} from './store.mjs';
import {skillMarkdown} from './skill-files.mjs';
import {object,string} from './schema.mjs';
import {resultSchema} from './tool-contract.mjs';

const catalogText = readFileSync(new URL('../web/catalog/graph.json', import.meta.url), 'utf8');
const catalog = JSON.parse(catalogText);
const catalogIds = new Set(catalog.nodes.map(node => node.id));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const catalogSha256=digest(catalogText);
export const relationTypes = ['depend_on', 'compose_with', 'similar_to'];
export const registryErrors = {
  INVALID_RELATION: '关系类型或技能端点无效。', SKILL_NOT_FOUND: '当前范围内没有该技能。',
  DEPENDENCY_CYCLE: '依赖关系存在循环，未保存。', EXTERNAL_ID_UNKNOWN: '原目录中没有这个外部 ID。',
  IDENTITY_CONFLICT: '此外部身份已绑定到其他技能，请先解除原绑定。',
  INVALID_OVERRIDE: '覆盖必须由当前项目技能指向一个用户技能。',
  REGISTRY_CHANGED: '技能关系已变化，请刷新后重试。',
  SNAPSHOT_UNAVAILABLE:'历史运行没有注册表快照，不能用当前关系追认。', SNAPSHOT_CHANGED:'历史注册表快照指纹不一致。',
};
const fail = code => {throw Object.assign(new RequestError(code === 'SNAPSHOT_UNAVAILABLE'?404:['REGISTRY_CHANGED','SNAPSHOT_CHANGED'].includes(code)?409:422, registryErrors[code]),{code});};
const sort = rows => rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
const revisionField={...string,minLength:64,maxLength:64};
const mutationResult=object({ok:{enum:[true]},revision:revisionField});
const list=items=>({type:'array',items});
export const registrySnapshotSchema=object({schemaVersion:{enum:[1]},scope:string,
  skills:list(object({skillId:string,version:{type:'integer',minimum:1},contentSha256:revisionField,
    projectId:{anyOf:[string,{enum:[null]}]},name:string,description:{type:'string'},selectable:{type:'boolean'}})),
  relations:list(object({scope:string,source:string,target:string,type:{enum:relationTypes},provenance:{enum:['user-declaration','explicit-catalog-binding']}})),
  externalRefs:list(object({scope:string,externalId:string,skillId:string,provider:{enum:['skillnet']},revision:revisionField})),overrides:list(object({projectSkillId:string,globalSkillId:string})),
  issues:list(object({code:string,skillId:string,target:string})),catalogSha256:revisionField,revision:revisionField,sha256:revisionField});
export const registryContract={version:1,operations:[
  {name:'relation',parameters:object({source:string,target:string,type:{enum:relationTypes},expectedRevision:revisionField}),
    returns:resultSchema(object({...mutationResult.properties,source:string,target:string,type:{enum:relationTypes},removed:{type:'boolean'}}))},
  {name:'binding',parameters:object({skillId:string,externalId:string,expectedRevision:revisionField}),returns:resultSchema(mutationResult)},
  {name:'override',parameters:object({projectSkillId:string,globalSkillId:string,expectedRevision:revisionField}),returns:resultSchema(mutationResult)},
].map(operation=>({...operation,errors:registryErrors,timeoutMs:5000,idempotent:true,volatile:[],
  authorization:'本机同源用户在选定项目或用户范围显式编辑；不增加任务权限。',
  ordering:'按作用范围与 UUID 固定排序。',timeoutMode:'有界本机同步数据库事务。'})),
  reads:{snapshot:{path:'GET /api/skill-registry?task=<id> 或 project=<id>',parameters:object({}),returns:resultSchema(registrySnapshotSchema)},
    history:{path:'GET /api/runs/<id>/skill-registry',parameters:object({runId:string}),returns:resultSchema(registrySnapshotSchema)},
    errors:registryErrors,timeoutMs:5000,idempotent:true,volatile:[],ordering:'作用范围与 UUID 稳定排序。',authorization:'同源读取本机技能配置及指定运行的固定事件，不授予执行权限。'},
  semantics:{depend_on:'source 依赖 target，target 必须先应用完成',compose_with:'互补建议，无执行顺序',similar_to:'替代建议，不自动加入执行链',
    legacy:'旧 manual/mention/topic 均为浏览关系，外部目录关系需要显式身份绑定'},
};

export function dependencyCycles(relations) {
  const edges = new Map();
  for (const edge of relations.filter(edge => edge.type === 'depend_on')) {
    if (!edges.has(edge.source)) edges.set(edge.source, []);
    edges.get(edge.source).push(edge.target);
  }
  const done = new Set(), active = [], cyclic = new Set();
  function visit(id) {
    const index = active.indexOf(id);
    if (index >= 0) {for (const member of active.slice(index)) cyclic.add(member); return;}
    if (done.has(id)) return;
    active.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    active.pop(); done.add(id);
  }
  for (const id of edges.keys()) visit(id);
  return [...cyclic].sort();
}

/** SIH UUIDs own identity. Catalog names are never automatic identity bindings. */
export function createSkillRegistry({store, studio, projectFor}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_typed_relations (
    scope TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL,
    PRIMARY KEY(scope,source,target,type));
  CREATE TABLE IF NOT EXISTS skill_external_refs (
    scope TEXT NOT NULL, external_id TEXT NOT NULL, skill_id TEXT NOT NULL,
    PRIMARY KEY(scope,external_id));
  CREATE TABLE IF NOT EXISTS skill_overrides (
    scope TEXT NOT NULL, project_skill TEXT NOT NULL, global_skill TEXT NOT NULL,
    PRIMARY KEY(scope,global_skill));`);
  const scopeFor = context => projectFor(context) ?? '';
  function snapshot(context, providedSkills) {
    const scope = scopeFor(context);
    const installed = [...(providedSkills ?? studio.list(context))].sort((a,b)=>a.id.localeCompare(b.id));
    const byId = new Map(installed.map(skill=>[skill.id,skill]));
    const issues = [];
    const overrides = store.query('SELECT project_skill AS projectSkillId,global_skill AS globalSkillId FROM skill_overrides WHERE scope=? ORDER BY global_skill','all',scope);
    const hidden = new Set();
    for (const override of overrides) {
      const from=byId.get(override.projectSkillId), to=byId.get(override.globalSkillId);
      if (from?.projectId === scope && !to?.projectId && to) hidden.add(to.id);
      else issues.push({code:'OVERRIDE_UNAVAILABLE',skillId:override.projectSkillId,target:override.globalSkillId});
    }
    const refs = new Map();
    for (const row of store.query('SELECT scope,external_id AS externalId,skill_id AS skillId FROM skill_external_refs WHERE scope IN (?,?) ORDER BY scope,external_id','all','',scope)) {
      const previous=refs.get(row.externalId);
      if (!previous || row.scope===scope) refs.set(row.externalId,{...row,provider:'skillnet',revision:catalogSha256});
    }
    const relations=store.query('SELECT scope,source,target,type FROM skill_typed_relations WHERE scope IN (?,?) ORDER BY scope,source,target,type','all','',scope)
      .map(edge=>({...edge,provenance:'user-declaration'}));
    const overrideId=id=>overrides.find(item=>hidden.has(id)&&item.globalSkillId===id)?.projectSkillId??id;
    for (const edge of relations) {edge.source=overrideId(edge.source);edge.target=overrideId(edge.target);}
    for (const edge of catalog.edges) {
      if (!relationTypes.includes(edge.type)) continue;
      const source=refs.get(edge.source),target=refs.get(edge.target);
      if (!source || !byId.has(source.skillId) || hidden.has(source.skillId)) continue;
      if (!target || !byId.has(target.skillId) || hidden.has(target.skillId)) {
        if(edge.type==='depend_on')issues.push({code:'EXTERNAL_DEPENDENCY_UNBOUND',skillId:source.skillId,target:edge.target});
        continue;
      }
      relations.push({scope:source.scope,source:source.skillId,target:target.skillId,type:edge.type,provenance:'explicit-catalog-binding'});
    }
    const unique=new Map();
    for(const edge of relations){
      if(!byId.has(edge.source)||!byId.has(edge.target))issues.push({code:'RELATION_ENDPOINT_UNAVAILABLE',skillId:edge.source,target:edge.target});
      unique.set(JSON.stringify([edge.source,edge.target,edge.type]),edge);
    }
    const selectedRelations=sort([...unique.values()]);
    for(const id of dependencyCycles(selectedRelations))issues.push({code:'DEPENDENCY_CYCLE',skillId:id,target:id});
    const body={schemaVersion:1,scope,skills:installed.map(skill=>({skillId:skill.id,version:skill.version,
      contentSha256:digest(skillMarkdown(skill)),projectId:skill.projectId??null,name:skill.name,description:skill.description,
      selectable:!hidden.has(skill.id)})),relations:selectedRelations,
      externalRefs:sort([...refs.values()]),overrides,issues:sort(issues),catalogSha256};
    const sha256=digest(body);
    return {...body,revision:sha256,sha256};
  }
  function checkRevision(current, expectedRevision) {
    if(typeof expectedRevision!=='string'||expectedRevision!==current.revision)fail('REGISTRY_CHANGED');
  }
  function relation({context,source,target,type,remove=false,expectedRevision}) {
    if(!relationTypes.includes(type)||source===target)fail('INVALID_RELATION');
    const installed=studio.list(context);
    return store.transaction(()=>{
      const current=snapshot(context,installed);checkRevision(current,expectedRevision);
      const ids=new Set(current.skills.map(skill=>skill.skillId));
      if(!ids.has(source)||!ids.has(target))fail('SKILL_NOT_FOUND');
      const scope=scopeFor(context);
      if(remove)store.query('DELETE FROM skill_typed_relations WHERE scope=? AND source=? AND target=? AND type=?','run',scope,source,target,type);
      else store.query('INSERT OR IGNORE INTO skill_typed_relations VALUES(?,?,?,?)','run',scope,source,target,type);
      const next=snapshot(context,installed);
      if(!remove&&dependencyCycles(next.relations).length)fail('DEPENDENCY_CYCLE');
      return {ok:true,source,target,type,removed:remove,revision:next.revision};
    });
  }
  function bind({context,skillId,externalId,remove=false,expectedRevision}) {
    const installed=studio.list(context);
    return store.transaction(()=>{
      const current=snapshot(context,installed);checkRevision(current,expectedRevision);
      if(!current.skills.some(skill=>skill.skillId===skillId))fail('SKILL_NOT_FOUND');
      if(!catalogIds.has(externalId))fail('EXTERNAL_ID_UNKNOWN');
      const scope=scopeFor(context);
      const existing=store.query('SELECT skill_id FROM skill_external_refs WHERE scope=? AND external_id=?','get',scope,externalId);
      if(existing&&existing.skill_id!==skillId)fail('IDENTITY_CONFLICT');
      if(remove)store.query('DELETE FROM skill_external_refs WHERE scope=? AND external_id=? AND skill_id=?','run',scope,externalId,skillId);
      else store.query('INSERT OR IGNORE INTO skill_external_refs VALUES(?,?,?)','run',scope,externalId,skillId);
      const next=snapshot(context,installed);
      if(!remove&&dependencyCycles(next.relations).length)fail('DEPENDENCY_CYCLE');
      return {ok:true,revision:next.revision};
    });
  }
  function override({context,projectSkillId,globalSkillId,remove=false,expectedRevision}) {
    const installed=studio.list(context);
    return store.transaction(()=>{
      const current=snapshot(context,installed);checkRevision(current,expectedRevision);
      const source=current.skills.find(skill=>skill.skillId===projectSkillId),target=current.skills.find(skill=>skill.skillId===globalSkillId);
      const scope=scopeFor(context);
      if(!scope||source?.projectId!==scope||!target||target.projectId!==null)fail('INVALID_OVERRIDE');
      if(remove)store.query('DELETE FROM skill_overrides WHERE scope=? AND project_skill=? AND global_skill=?','run',scope,projectSkillId,globalSkillId);
      else store.query('INSERT OR REPLACE INTO skill_overrides VALUES(?,?,?)','run',scope,projectSkillId,globalSkillId);
      const next=snapshot(context,installed);
      if(!remove&&dependencyCycles(next.relations).length)fail('DEPENDENCY_CYCLE');
      return {ok:true,revision:next.revision};
    });
  }
  function forRun(runId) {
    store.run(runId);
    const row=store.events(runId,0).find(event=>event.type==='skill_registry_snapshot');
    if(!row)fail('SNAPSHOT_UNAVAILABLE');
    const copy=structuredClone(row.payload);const {sha256,revision,...body}=copy;
    if(digest(body)!==sha256||revision!==sha256)fail('SNAPSHOT_CHANGED');
    return copy;
  }
  return {snapshot,relation,bind,override,forRun};
}
