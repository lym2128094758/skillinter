import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { goalApplicability } from './skill-applicability.mjs';

const graphText = readFileSync(new URL('../web/catalog/graph.json', import.meta.url), 'utf8');
const graph = JSON.parse(graphText);
const graphIds = new Set(graph.nodes.map(node => node.id));
export const skillGraphHash = createHash('sha256').update(graphText).digest('hex');
const normal = text => String(text).normalize('NFKC').toLowerCase();
const stop = new Set('请 帮 我 我们 你 一个 一份 这个 那个 进行 使用 然后 需要 可以 按照 当前 项目 文件 内容 任务 完成 输出 说明 结果 步骤 the a an and to for of in with please help'.split(' '));
function words(text) {
  return [...new Set([...new Intl.Segmenter('zh', {granularity: 'word'}).segment(normal(text))]
    .filter(item => item.isWordLike && item.segment.length > 1 && !stop.has(item.segment)).map(item => item.segment))];
}

/** Small, deterministic candidate set. Graph relationships never grant execution rights. */
export function routeSkills({prompt, materials = [], localSkills, customSkill, maxSkills = 6, graphData = graph, registrySnapshot,preserveIdentities=false, engineCandidates}) {
  if(registrySnapshot)return routeRegisteredSkills({prompt,materials,localSkills,customSkill,maxSkills,registrySnapshot,engineCandidates});
  const preferred = new Map();
  for (const skill of localSkills) {
    const previous = preferred.get(skill.name);
    if (!previous || !previous.projectId && skill.projectId) preferred.set(skill.name, skill);
  }
  if(!preserveIdentities)localSkills = [...preferred.values()];
  const query = normal(prompt);
  const terms = words(prompt);
  const documents = localSkills.map(skill => ({skill, name: normal(skill.name), text: normal(skill.name + ' ' + skill.description + ' ' + (skill.applicability?.goals ?? []).join(' '))}));
  const frequencies = new Map(terms.map(term => [term, documents.filter(doc => doc.text.includes(term)).length]));
  const inputTerms = words(materials.map(item => item.name).join(' '));
  const codeTask = /代码|函数|编程|报错|调试|\bbug\b|\bdebug\b/i.test(prompt);
  const matches = documents.map(({skill, name, text}) => {
    const matched = terms.filter(term => text.includes(term));
    const exact = name.length > 2 && query.includes(name);
    const declaredGoal = skill.applicability?.goals.some(phrase => query.includes(normal(phrase))) ?? false;
    const intent = codeTask && /代码|编程|调试|debug|code.help/i.test(text) && matched.some(term => /^(?:python|代码|函数|编程|报错|调试|bug|debug)$/i.test(term));
    const score = (matched.reduce((sum, term) => sum + Math.log(1 + localSkills.length / (1 + frequencies.get(term))) * (name.includes(term) ? 2 : 1), 0) +
      (exact ? 40 : 0) + (declaredGoal ? 10 : 0) + (intent ? 8 : 0) + inputTerms.filter(term => text.includes(term)).length * 0.15) *
      (exact ? 1 : Math.max(0.35, Math.sqrt(120 / (120 + skill.description.length))));
    return {skill, score, matched, exact, intent, declaredGoal};
  }).filter(item => item.exact || item.declaredGoal || item.intent && item.matched.length >= 1 || item.matched.length >= 2 && item.score >= 5 && item.matched.length / Math.max(terms.length, 1) >= 0.18)
    .map(item => ({...item, score: item.score * (1 + (item.skill.learningWeight ?? 0))}))
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name, 'en') || a.skill.id.localeCompare(b.skill.id));
  const rejected = matches.map(item => ({item, checks: goalApplicability(item.skill.applicability, prompt)}))
    .filter(({checks}) => checks.some(check => check.status !== 'passed'));
  const excludedIds = new Set(rejected.map(({item}) => item.skill.id));
  const ranked = matches.filter(item => !excludedIds.has(item.skill.id));
  const primary = customSkill ? [{skill: customSkill, reason: '用户明确选择'}] : ranked.slice(0, 2)
    .filter((item, index) => item.score >= ranked[0].score * 0.85 && (!index || item.exact || item.matched.length >= 2)).map(item => ({skill: item.skill, reason: '任务匹配：' + item.matched.slice(0, 5).join('、')}));
  const byName = new Map(localSkills.map(skill => [skill.name, skill]));
  const ids = new Set(graphData.nodes.map(node => typeof node === 'string' ? node : node.id));
  const selected = new Map(), warnings = [];
  const missing = [], visiting = new Set();
  function add(skill, reason, depth = 0) {
    if (selected.has(skill.name)) return;
    if (visiting.has(skill.name)) { warnings.push('技能关系存在环：' + skill.name + '，请调整计划。'); return; }
    if (selected.size >= maxSkills || depth > 3 || depth > 0 && selected.size >= maxSkills - primary.length) { warnings.push('技能链已达到自动扩展上限，请按需补充计划。'); return; }
    visiting.add(skill.name);
    for (const edge of graphData.edges.filter(edge => edge.source === skill.name && edge.type === 'depend_on')) {
      const dependency = byName.get(edge.target);
      if (dependency) add(dependency, skill.name + ' 的前置技能（原 SkillNet 关系）', depth + 1);
      else missing.push({skill: skill.name, dependency: edge.target});
    }
    visiting.delete(skill.name);
    if (selected.size < maxSkills) selected.set(skill.name, {id: skill.id, name: skill.name, version: skill.version,
      nodeId: ids.has(skill.name) ? skill.name : '', reason, description: skill.description.slice(0, 500)});
  }
  for (const item of primary) add(item.skill, item.reason);
  const candidates = [...selected.values()];
  const names = new Set(selected.keys());
  const relations = graphData.edges.filter(edge => names.has(edge.source) && names.has(edge.target) && ['depend_on', 'compose_with'].includes(edge.type));
  const alternatives = graphData.edges.filter(edge => edge.type === 'similar_to' && (names.has(edge.source) || names.has(edge.target)))
    .map(edge => names.has(edge.source) ? edge.target : edge.source).filter(name => byName.has(name) && !names.has(name));
  return {mode: 'deterministic-task-and-relations', graphSha256: skillGraphHash, candidates, relations,
    rejected: rejected.slice(0, 20).map(({item, checks}) => ({id: item.skill.id, name: item.skill.name, version: item.skill.version,
      status: checks.some(check => check.status === 'failed') ? 'failed' : 'unknown', reasons: checks.filter(check => check.status !== 'passed').map(check => check.message)})),
    ranking: ranked.slice(0, 6).map(item => ({id: item.skill.id, name: item.skill.name, score: Math.round(item.score * 100) / 100, matched: item.matched})),
    alternatives: [...new Set(alternatives)].slice(0, 6), missingDependencies: missing, warnings: [...new Set(warnings)],
    planRecommended: candidates.length > 1 || /(?:先[\s\S]{2,60}(?:再|然后)|计划|步骤|报告|方案|对比|交付|修复|测试文件|修改[\s\S]{0,30}(?:代码|文件))/.test(prompt),
    emptyReason: candidates.length ? '' : '没有足够匹配的已安装技能；继续使用基础工具，或补充任务目标。'};
}

export function graphNodeId(name) { return graphIds.has(name) ? name : ''; }
export function relationsForSkills(names) {
  const selected = new Set(names);
  return graph.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target) && ['depend_on', 'compose_with'].includes(edge.type));
}

function routeRegisteredSkills({prompt,materials,localSkills,customSkill,maxSkills,registrySnapshot,engineCandidates}) {
  const snapshot=structuredClone(registrySnapshot);
  const allowed=new Set(snapshot.skills.filter(skill=>skill.selectable).map(skill=>skill.skillId));
  // Ranking is still deterministic; UUID identity replaces legacy name projection.
  const ranked=routeSkills({prompt,materials,customSkill,localSkills:localSkills.filter(skill=>allowed.has(skill.id)),
    maxSkills,graphData:{nodes:[],edges:[]},preserveIdentities:true});
  const versions=new Map(localSkills.map(skill=>[skill.id,skill]));
  const selected=new Map(),visiting=new Set(),missing=[],warnings=[...ranked.warnings];
  function add(id,reason,depth=0){
    if(selected.has(id))return;
    if(visiting.has(id)){warnings.push('技能依赖存在循环，已阻止开始。');return;}
    const skill=versions.get(id);
    if(!skill)return;
    if(depth>8||selected.size>=maxSkills){warnings.push('技能链达到上限，缺少的依赖不能被跳过。');return;}
    visiting.add(id);
    for(const edge of snapshot.relations.filter(edge=>edge.source===id&&edge.type==='depend_on')){
      if(versions.has(edge.target))add(edge.target,skill.name+' 的前置技能',depth+1);
      else missing.push({skillId:id,skill:skill.name,dependency:edge.target});
    }
    visiting.delete(id);
    if(selected.size<maxSkills)selected.set(id,{id,name:skill.name,version:skill.version,nodeId:id,reason,description:skill.description.slice(0,500)});
  }
  const primary=customSkill?[{id:customSkill.id,reason:'用户明确选择'}]:engineCandidates !== undefined ? engineCandidates.slice(0,2)
    .filter(item => allowed.has(item.id) && versions.has(item.id) &&
      goalApplicability(versions.get(item.id).applicability, prompt).every(check => check.status === 'passed'))
    .map(item => ({id: item.id, reason: item.engineReason})) : ranked.ranking.slice(0,2)
    .filter(item=>item.score>=ranked.ranking[0].score*.85).map(item=>({...item,reason:'任务匹配：'+item.matched.slice(0,5).join('、')}));
  for(const item of primary){
    const skill=versions.get(item.id);
    if(!customSkill&&localSkills.filter(other=>allowed.has(other.id)&&normal(other.name)===normal(skill.name)).length>1){warnings.push('同名技能身份不唯一：'+skill.name+'，请按作用范围明确选择或声明项目覆盖。');continue;}
    add(item.id,item.reason);
  }
  for(const issue of snapshot.issues)if(selected.has(issue.skillId)){
    missing.push({skillId:issue.skillId,skill:versions.get(issue.skillId)?.name??issue.skillId,dependency:issue.target,code:issue.code});
  }
  const ids=new Set(selected.keys());
  const relations=snapshot.relations.filter(edge=>ids.has(edge.source)&&ids.has(edge.target));
  const alternatives=snapshot.relations.filter(edge=>edge.type==='similar_to'&&(ids.has(edge.source)||ids.has(edge.target)))
    .map(edge=>ids.has(edge.source)?edge.target:edge.source).filter(id=>versions.has(id)&&!ids.has(id));
  return {...ranked,mode:'registry-task-and-relations',graphSha256:snapshot.sha256,registrySnapshot:snapshot,
    candidates:[...selected.values()],relations,missingDependencies:missing,warnings:[...new Set(warnings)],
    alternatives:[...new Set(alternatives)],planRecommended:selected.size>1||ranked.planRecommended,
    emptyReason:selected.size?'':warnings.join('；')||ranked.emptyReason||'没有适用的已安装技能。'};
}
