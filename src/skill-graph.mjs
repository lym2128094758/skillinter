import {RequestError} from './store.mjs';
import {skillMarkdown} from './skill-files.mjs';

const normalized = text => text.normalize('NFKC').toLowerCase();
const pairKey = (a, b) => [a, b].sort().join(':');
const meaningful = new Set('skill skills user users use using help when with from that this your then file files'.split(' '));
function terms(text) {
  return new Set([...new Intl.Segmenter('zh', {granularity:'word'}).segment(normalized(text))]
    .filter(item => item.isWordLike && item.segment.length >= 2 && !meaningful.has(item.segment)).map(item => item.segment));
}

export function createSkillGraph({store, studio, projectFor}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_graph_relations (
    scope TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (scope, source, target)
  )`);
  const scopeFor = context => projectFor(context) ?? '';
  function skills(context) {
    return studio.list(context).sort((a,b) => a.name.localeCompare(b.name,'en') || a.id.localeCompare(b.id));
  }
  let cachedKey = '', cachedGraph;
  function snapshot(context) {
    const installed = skills(context);
    const key = JSON.stringify([scopeFor(context),installed.map(skill=>[skill.id,skill.version,skill.storagePath,skill.projectId])]);
    const manualEdges = nodes => {
      const ids = new Set(nodes.map(node=>node.id));
      return store.query('SELECT source,target FROM skill_graph_relations WHERE scope=? ORDER BY source,target','all',scopeFor(context))
        .filter(edge=>ids.has(edge.source)&&ids.has(edge.target)).map(edge=>({...edge,kind:'manual'}));
    };
    if (cachedGraph && cachedKey === key) return {...cachedGraph,edges:[...cachedGraph.edges,...manualEdges(cachedGraph.nodes)],issues:studio.issues()};
    const nodes = installed.map(skill => ({id:skill.id, name:skill.name, slug:skill.name,
      description:skill.description, version:skill.version, path:skill.storagePath ?? '',
      source:skill.projectId ? '项目技能' : '用户技能', group:skill.projectId ? '当前项目' : '用户技能'}));
    const aliases = new Map();
    for (const skill of installed) {
      const name = normalized(skill.name);
      if (!aliases.has(name)) aliases.set(name,[]);
      aliases.get(name).push(skill);
    }
    const mentions = new Map();
    const names = [...aliases.keys()].filter(name=>name.length>=4).sort((a,b)=>b.length-a.length||a.localeCompare(b));
    const matcher = names.length ? new RegExp('(?<![a-z0-9_-])(?:'+names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')(?![a-z0-9_-])','gu') : null;
    for (const skill of installed) {
      const body = normalized(skill.instructions);
      for (const name of new Set(matcher ? [...body.matchAll(matcher)].map(match=>match[0]) : [])) {
        const candidates=aliases.get(name);
        if (name === normalized(skill.name) || name.length < 4 || !body.includes(name)) continue;
        const exact = new RegExp('(?<![a-z0-9_-])' + name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?![a-z0-9_-])','u');
        if (!exact.test(body)) continue;
        const others = candidates.filter(item => item.id !== skill.id);
        const sameScope = others.filter(item => item.projectId === skill.projectId);
        const resolved = sameScope.length ? sameScope : others;
        if (resolved.length !== 1) continue;
        const target = resolved[0].id;
        const [left,right] = [skill.id,target].sort();
        const key = pairKey(left,right);
        const edge = mentions.get(key) ?? {source:left,target:right,kind:'mention',forward:false,backward:false};
        edge[skill.id === left ? 'forward' : 'backward'] = true;
        mentions.set(key,edge);
      }
    }
    const tokenSets = installed.map(skill => terms(skill.name + ' ' + skill.description));
    const frequencies = new Map();
    for (const tokens of tokenSets) for (const term of tokens) frequencies.set(term,(frequencies.get(term)??0)+1);
    const postings = new Map();
    tokenSets.forEach((tokens,index)=>{for(const token of tokens){if(!postings.has(token))postings.set(token,[]);postings.get(token).push(index);}});
    const weights = tokenSets.map(tokens=>[...tokens].reduce((sum,token)=>sum+1/(1+frequencies.get(token)),0));
    const neighbors = new Map(installed.map(skill => [skill.id,[]]));
    for(let left=0;left<installed.length;left++) {
      const shared = new Map();
      for(const token of tokenSets[left]) for(const right of postings.get(token)) {
        if(right<=left)continue;
        const value=shared.get(right)??[0,0];value[0]++;value[1]+=1/(1+frequencies.get(token));shared.set(right,value);
      }
      for(const [right,[count,commonWeight]] of shared) {
        if(count<2)continue;
        const score=commonWeight/(weights[left]+weights[right]-commonWeight);
        if(score<.12)continue;
        neighbors.get(installed[left].id).push({score,id:installed[right].id});
        neighbors.get(installed[right].id).push({score,id:installed[left].id});
      }
    }
    const topics = new Map();
    for (const [id,matches] of neighbors) {
      for (const match of matches.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,2)) {
        const key = pairKey(id,match.id);
        if (!mentions.has(key)) {
          const [source,target] = [id,match.id].sort();
          topics.set(key,{source,target,kind:'topic'});
        }
      }
    }
    cachedKey=key;
    cachedGraph={nodes,edges:[...mentions.values(),...topics.values()],discovery:{agent:'sih',agent_label:'Skillinter',
      roots:Object.values(studio.locations(context)).filter(Boolean)},issues:studio.issues()};
    return {...cachedGraph,edges:[...cachedGraph.edges,...manualEdges(nodes)]};
  }

  function detail(id, context) {
    const skill = studio.get(id,context);
    return {id:skill.id,name:skill.name,version:skill.version,path:skill.storagePath,content:skillMarkdown(skill)};
  }
  function relation({context,source,target,remove=false}) {
    if (typeof source !== 'string' || typeof target !== 'string' || source === target) throw new RequestError(422,'请选择两个不同的已安装技能。');
    const ids = new Set(skills(context).map(skill=>skill.id));
    if (!ids.has(source)||!ids.has(target)) throw new RequestError(404,'当前范围没有所选技能。');
    const [left,right] = [source,target].sort();
    const scope = scopeFor(context);
    if (remove) store.query('DELETE FROM skill_graph_relations WHERE scope=? AND source=? AND target=?','run',scope,left,right);
    else store.query('INSERT OR IGNORE INTO skill_graph_relations VALUES (?,?,?,?)','run',scope,left,right,new Date().toISOString());
    return {ok:true,source:left,target:right,kind:'manual',removed:remove};
  }
  return {snapshot,detail,relation};
}
