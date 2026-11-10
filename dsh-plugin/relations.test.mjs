import test from 'node:test';
import assert from 'node:assert/strict';
import {planSkills, skillIdentity, translateRelations} from './relations.mjs';

const make = (name, source='user-dsh') => ({name, provider:'filesystem',source,invocation:{modelInvocable:true}});
test('依赖优先，互补和替代不自动执行，快照不会随原关系变化', () => {
  const a=make('paper'),b=make('math'),c=make('plot'),d=make('other');
  const edges=[{type:'depend_on',source:skillIdentity(a),target:skillIdentity(b)},
    {type:'compose_with',source:skillIdentity(a),target:skillIdentity(c)},
    {type:'similar_to',source:skillIdentity(a),target:skillIdentity(d)}];
  const result=planSkills([a,b,c,d],edges,['paper']);
  assert.deepEqual(result.order.map(s=>s.name),['math','paper']);
  assert.equal(result.suggestions.length,2);
  edges.length=0;
  assert.equal(result.snapshot.relations.length,3);
});
test('循环、缺失端点和不可用技能不能生成计划', () => {
  const a=make('a'),b=make('b');
  const ab={type:'depend_on',source:skillIdentity(a),target:skillIdentity(b)};
  assert.throws(()=>planSkills([a,b],[ab,{...ab,source:ab.target,target:ab.source}],['a']),/循环/);
  assert.throws(()=>planSkills([a],[ab],['a']),/端点/);
  assert.throws(()=>planSkills([a],[],['missing']),/不可用/);
});
test('相同名称不同来源或项目不合并', () => {
  const a=make('paper','project-dsh');
  assert.notEqual(skillIdentity(a,'one'),skillIdentity(a,'two'));
  assert.notEqual(skillIdentity(make('paper')),skillIdentity(make('paper','user-agents')));
  assert.throws(()=>planSkills([make('paper'),make('paper','user-agents')],[],['paper']),/不唯一/);
});
test('迁移只接受明确身份绑定，未绑定关系保留为待处理',()=>{
  const a=make('a'),b=make('b');
  const snapshot={skills:[{skillId:'uuid-a'},{skillId:'uuid-b'}],relations:[{source:'uuid-a',target:'uuid-b',type:'depend_on'}]};
  const partial=translateRelations(snapshot,[{skillId:'uuid-a',dshId:skillIdentity(a)}],[a,b]);
  assert.equal(partial.relations.length,0); assert.equal(partial.unresolved.length,1);
  const complete=translateRelations(snapshot,[{skillId:'uuid-a',dshId:skillIdentity(a)},{skillId:'uuid-b',dshId:skillIdentity(b)}],[a,b]);
  assert.equal(complete.relations[0].target,skillIdentity(b));
  assert.throws(()=>translateRelations(snapshot,[{skillId:'uuid-a',dshId:skillIdentity(a)},{skillId:'uuid-b',dshId:skillIdentity(a)}],[a,b]),/重复/);
});
