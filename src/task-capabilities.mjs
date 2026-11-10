import {readDocumentTool,readDocument} from './document-tools.mjs';
import {pythonTool,runPython} from './python-tool.mjs';
import {onlineSkillTools,createOnlineSkills} from './online-skills.mjs';
import {prepareTaskTool,prepareTask} from './task-preparation.mjs';
import {object,validate} from './schema.mjs';
import {success,failure,resultSchema,checkResult} from './tool-contract.mjs';
import {runProcess} from './process-runtime.mjs';

const runtimeTool={name:'inspect_runtime',description:'检查本机Python版本与numpy/scipy/pandas/matplotlib/openpyxl/python-docx等包的可用状态，不运行用户代码，不安装依赖。',
  parameters:object({}),returns:resultSchema(object({python:{type:'string'},packages:{type:'array',items:object({name:{type:'string'},available:{type:'boolean'}})}})),
  errors:{INVALID_ARGUMENT:'环境检查参数无效。',PYTHON_UNAVAILABLE:'Python无法启动。',ABORTED:'环境检查已停止。'},
  timeoutMs:10000,idempotent:true,volatile:[],ordering:'包名按固定列表顺序。',authorization:'只执行宿主固定的环境探测代码，无用户代码或网络请求。',timeoutMode:'10秒硬上限及父停止。'};
const searchAllSkillsTool={name:'search_skill_libraries',
  description:'同时搜索当前会话可用的已安装技能，以及配置和按检索词发现的公开 GitHub 技能库。检索词会发送给 GitHub，不要包含项目正文或密钥。模型自主选择直接及辅助能力的查询词，使用 limit=5，分别争取五个本机和五个在线候选，各包含三个直接相关及两个辅助相关技能；不足时换词，仍不足则说明。读取失败时继续尝试后续候选。',
  parameters:object({query:{type:'string',minLength:1,maxLength:500},limit:{type:'integer',minimum:1,maximum:5}}),
  returns:resultSchema(object({local:{type:'array',items:object({id:{type:'string'},name:{type:'string'},version:{type:'string'},description:{type:'string'}})},
    sources:{type:'array',items:{type:'string'}},online:onlineSkillTools[0].returns.anyOf[0].properties.data,onlineError:{type:'string'}})),
  errors:{INVALID_ARGUMENT:'技能检索参数无效。',ABORTED:'技能检索已停止。',INTERNAL:'技能检索失败。'},
  timeoutMs:25000,idempotent:true,volatile:[],ordering:'本地按相关度和名称排序，在线按匹配得分及仓库路径排序。',
  authorization:'仅搜索本会话技能和配置的公开仓库；采用技能不改变文件权限。',timeoutMode:'受当前任务停止和公开来源时限约束。'};
export const taskCapabilityTools=[readDocumentTool,prepareTaskTool,...onlineSkillTools,searchAllSkillsTool,runtimeTool,pythonTool];

export function createTaskCapabilities(options) {
  const online=createOnlineSkills({sources:options.skillSources,signal:options.signal,
    ...(options.githubAccess?{fetcher:options.githubAccess.fetch,gitFallback:true}:{}),
    emit:(type,data)=>options.store.record(options.run,type,data)});
  return {close:()=>online.close(),async execute(call) {
    const name=call.function.name,definition=taskCapabilityTools.find(tool=>tool.name===name);
    let args;try{args=JSON.parse(call.function.arguments);}catch{return failure(definition.errors,'INVALID_ARGUMENT');}
    if(validate(definition.parameters,args).length)return failure(definition.errors,'INVALID_ARGUMENT');
    let result;
    if(name==='search_skill_libraries') {
      const sources=(options.skillSources??['anthropics/skills','openai/skills']).filter(source=>/^[\w.-]+\/[\w.-]+$/.test(source)).slice(0,4);
      options.store.record(options.run,'skill_library_search_started',{query:args.query,sources});
      const [local,remote]=await Promise.all([options.search(args.query,options.signal),online.execute('discover_skills',args)]);
      result=success({local:local.slice(0,args.limit).map(item=>({id:item.id,name:item.label??item.name,version:String(item.version),description:item.description??''})),
        sources:remote.ok?remote.data.sources??sources:sources,online:remote.ok?remote.data:{candidates:[],unavailable:[],truncated:false},onlineError:remote.ok?'':remote.error.message});
      options.store.record(options.run,'skill_library_search',{query:args.query,...result.data});
    }
    else if(name==='read_document')result=await readDocument(args,options);
    else if(name==='prepare_task')result=await prepareTask(args,options);
    else if(name==='run_python')result=await runPython(args,options);
    else if(name==='inspect_runtime') {
      const probe=await runProcess('python',['-I','-c',
        "import importlib.util,json,platform; names=['numpy','scipy','pandas','matplotlib','openpyxl','docx']; print(json.dumps({'python':platform.python_version(),'packages':[{'name':n,'available':importlib.util.find_spec(n) is not None} for n in names]}))"],
        {signal:options.signal,timeoutMs:10000,maxBytes:10000});
      try{result=probe.exitCode===0?success(JSON.parse(probe.stdout)):failure(runtimeTool.errors,options.signal.aborted?'ABORTED':'PYTHON_UNAVAILABLE');}
      catch{result=failure(runtimeTool.errors,'PYTHON_UNAVAILABLE');}
    } else result=await online.execute(name,args);
    return checkResult(definition,result);
  }};
}
