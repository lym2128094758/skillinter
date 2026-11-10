import {defineTool} from '@deepseek-ai/dsh-tools';
import {searchSkills} from './search-core.mjs';
import {createGithubAccess} from '../src/github-access.mjs';
import {planSkills} from './relations.mjs';
import {skillTrace} from './trace.mjs';

export const name = 'skillinter-search';
export const inject = ['tools','skills'];

export function apply(ctx, config = {}) {
  return register(ctx,defineTool,config);
}

export function register(ctx, define, config = {}) {
  const github = createGithubAccess({env:process.env});
  ctx.tools.register(define({
    name:'search_skills',
    description:'同时搜索当前会话可调用的本地技能和公开 GitHub 技能。使用英文及中文任务关键词；本地结果用 skill 工具加载，网上结果带固定来源链接，需要进一步读取核验。',
    parameters:{query:{type:'string',required:true},limit:{type:'integer',required:true}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      local:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        name:{type:'string',required:true},description:{type:'string',required:true},provider:{type:'string',required:true},source:{type:'string',required:true}}}},
      online:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        name:{type:'string',required:true},description:{type:'string',required:true},repository:{type:'string',required:true},
        path:{type:'string',required:true},url:{type:'string',required:true},commit:{type:'string',required:true},
        sha256:{type:'string',required:true},license:{type:'string',required:true}}}},
      incomplete:{type:'boolean',required:true},unavailable:{type:'array',required:true,items:{type:'string'}},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args, exec) {
      if (!args.query.trim() || args.query.length > 500 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5) throw new Error('请输入查询词和 1 至 5 个结果。');
      const cwd = exec.agent?.session?.header?.cwd;
      const result = await searchSkills({query:args.query,limit:args.limit,signal:exec.signal,
        fetcher:github.fetch,
        sources:config.sources ?? ['anthropics/skills','openai/skills'],
        list:()=>ctx.skills.list({cwd,signal:exec.signal,scope:exec.agent})});
      return {...result,online:result.online.map(({name,description,repository,path,url,commit,sha256,license})=>
        ({name,description,repository,path,url,commit,sha256,license}))};
    },
    presentCall(args) {return {card:'generic',title:`搜索技能 ${args.query}`,kind:'read',rawInput:args.query};},
  }));
  ctx.tools.register(define({
    name:'plan_skill_chain',
    description:'检查选中技能的依赖并返回先后顺序和关系快照；互补和替代只作为建议。之后按顺序调用原生 skill 工具。当前关系来自插件配置。',
    parameters:{names:{type:'array',required:true,items:{type:'string'}}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      json:{type:'string',required:true}
    }},render:(_args,result)=>[{type:'text',text:result.json}]},
    async execute(args, exec) {
      if (!Array.isArray(args.names) || !args.names.length || args.names.some(n=>typeof n !== 'string')) throw new Error('请选择技能名称');
      const skills = await ctx.skills.list({cwd:exec.agent?.session?.header?.cwd,signal:exec.signal,scope:exec.agent});
      return {json:JSON.stringify(planSkills(skills,config.relations ?? [],args.names,exec.agent?.session?.header?.cwd))};
    },
    presentCall(args) {return {card:'generic',title:'检查技能链',kind:'read',rawInput:args.names.join('、')};},
  }));
  ctx.tools.register(define({
    name:'inspect_skill_trace',
    description:'查看当前 DSH 会话中实际完成的技能加载与工具调用，仅依据宿主事件记录。',
    parameters:{turn:{type:'integer',required:true,description:'要查看的轮次；0 表示全部轮次'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{json:{type:'string',required:true}}},
      render:(_args,result)=>[{type:'text',text:result.json}]},
    async execute(args,exec) {
      if (!Number.isInteger(args.turn) || args.turn < 0) throw new Error('轮次必须为非负整数');
      const events=exec.agent?.session?.events;
      if (!Array.isArray(events)) throw new Error('当前会话没有可读取的事件记录');
      return {json:JSON.stringify(skillTrace(events,args.turn || null))};
    },
    presentCall() {return {card:'generic',title:'查看实际技能调用',kind:'read',rawInput:''};},
  }));
}
