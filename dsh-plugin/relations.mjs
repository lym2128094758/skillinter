import {createHash} from 'node:crypto';

// DSH resolves names by provider precedence. Keep the provider and source in
// the identity so a same-name skill from a different source is never merged.
export function skillIdentity(skill, cwd = '') {
  if (!skill.name || !skill.provider || !skill.source) throw new Error('技能缺少来源身份，不能自动建立关系');
  const project = skill.source.startsWith('project-') ? cwd : '';
  if (skill.source.startsWith('project-') && !project) throw new Error('项目技能缺少项目路径');
  return createHash('sha256').update(JSON.stringify([project, skill.provider, skill.source, skill.name, skill.resourceBase ?? null])).digest('hex');
}

export function planSkills(skills, relations, requested, cwd = '') {
  const records = skills.filter(s => s.invocation?.modelInvocable).map(s => ({id:skillIdentity(s,cwd), name:s.name, provider:s.provider, source:s.source}));
  const byId = new Map(records.map(s => [s.id,s]));
  if (byId.size !== records.length) throw new Error('技能身份重复');
  const byName = new Map();
  for (const skill of records) {
    if (byName.has(skill.name)) throw new Error(`技能名不唯一：${skill.name}`);
    byName.set(skill.name,skill);
  }
  const edges = structuredClone(relations);
  for (const edge of edges) {
    if (!['depend_on','compose_with','similar_to'].includes(edge.type) || !byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) throw new Error('技能关系无效或端点不可用');
  }
  const active = new Set(), visited = new Set(), order = [];
  function visit(id) {
    if (active.has(id)) throw new Error('技能依赖存在循环');
    if (visited.has(id)) return;
    active.add(id);
    for (const edge of edges) if (edge.type === 'depend_on' && edge.source === id) visit(edge.target);
    active.delete(id); visited.add(id); order.push(byId.get(id));
  }
  for (const name of requested) {
    const skill = byName.get(name);
    if (!skill) throw new Error(`技能不可用：${name}`);
    visit(skill.id);
  }
  const snapshot = {skills:records,relations:edges};
  return {order,suggestions:edges.filter(e => e.type !== 'depend_on' && visited.has(e.source)),snapshot,
    sha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}

// A SIH UUID is linked only by an explicit mapping to a DSH identity. Never
// infer this mapping from the display name, especially across project scopes.
export function translateRelations(sihSnapshot, bindings, dshSkills, cwd = '') {
  const ids = new Set(dshSkills.map(skill => skillIdentity(skill,cwd)));
  const sihIds = new Set(sihSnapshot.skills.map(skill => skill.skillId));
  const map = new Map();
  const targets = new Set();
  for (const binding of bindings) {
    if (!sihIds.has(binding.skillId) || !ids.has(binding.dshId) || map.has(binding.skillId) || targets.has(binding.dshId)) throw new Error('身份绑定无效或重复');
    map.set(binding.skillId,binding.dshId); targets.add(binding.dshId);
  }
  const relations = [], unresolved = [];
  for (const edge of sihSnapshot.relations) {
    if (!['depend_on','compose_with','similar_to'].includes(edge.type)) continue;
    const source=map.get(edge.source),target=map.get(edge.target);
    if (!source || !target) unresolved.push({source:edge.source,target:edge.target,type:edge.type});
    else relations.push({source,target,type:edge.type});
  }
  return {relations,unresolved};
}
