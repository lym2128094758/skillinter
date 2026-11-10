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
  description:'同时搜索本机可用技能和公开 GitHub 技能库。query 会发送到 GitHub，请使用通用能力词。按任务分别发起直接相关（kind=direct，默认）和辅助相关（kind=supporting）查询，本机和在线每侧至少找3个直接相关、2个辅助相关的候选。limit 是单次每侧的返回量，直接类最低按3请求，辅助类最低按2请求，每次最多取5个。去重后不足时换词继续搜，读取失败会尝试后续候选。',
  parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:500},kind:{enum:['direct','supporting']},limit:{type:'integer',minimum:1,maximum:5}},required:['query','limit'],additionalProperties:false},
  returns:resultSchema(object({kind:{enum:['direct','supporting']},local:{type:'array',items:object({id:{type:'string'},name:{type:'string'},version:{type:'string'},description:{type:'string'}})},
    sources:{type:'array',items:{type:'string'}},online:onlineSkillTools[0].returns.anyOf[0].properties.data,onlineError:{type:'string'}})),
  errors:{INVALID_ARGUMENT:'技能检索参数无效。',ABORTED:'技能检索已停止。',INTERNAL:'技能检索失败。'},
  timeoutMs:25000,idempotent:true,volatile:[],ordering:'本地按相关度和名称排序，在线按匹配得分及仓库路径排序。',
  authorization:'仅搜索本会话技能和配置的公开仓库；采用技能不改变文件权限。',timeoutMode:'受当前任务停止和公开来源时限约束。'};
const installSkillTool = {
  name:'install_discovered_skill',
  description:'安装本轮搜索到并已通过 adopt_discovered_skill 阅读的公开技能。按任务缺口选择适用方法，reason说明对应能力。保存固定提交的完整技能目录和来源到 SIH 用户技能库，重复安装复用，不覆盖同名不同内容。安装成功返回指南供本轮采用，下一轮可作为本机技能检索。配套脚本按普通资源保存，执行仍须使用获准工具。',
  parameters:object({id:{type:'string',minLength:1,maxLength:1000},reason:{type:'string',minLength:1,maxLength:1000}}),
  returns:resultSchema(object({id:{type:'string'},name:{type:'string'},version:{type:'integer'},
    path:{type:'string'},reused:{type:'boolean'},fileCount:{type:'integer'},instructions:{type:'string',maxLength:200000},
    source:object({url:{type:'string'},commit:{type:'string'},sha256:{type:'string'},license:{type:'string'}})})),
  errors:{INVALID_ARGUMENT:'技能安装参数无效。',SKILL_NOT_FOUND:'本轮未找到该外部技能。',SKILL_NOT_READ:'请先用 adopt_discovered_skill 阅读指南，再决定安装。',
    NAME_CONFLICT:'已有同名技能且内容不同，请在技能中心处理。',INSTALL_FAILED:'技能安装失败，未确认安装成功。',ABORTED:'技能安装已停止。'},
  timeoutMs:25000,idempotent:true,volatile:['data.id','data.path'],ordering:'单个固定版本的技能包。',
  authorization:'用户授权 Agent 按任务自行寻找并安装技能。仅写 SIH 用户技能目录，采用外部指南遵守本轮权限。',
  timeoutMode:'包下载20秒上限并继承任务停止，完整读取校验后原子写入。',
};
export const taskCapabilityTools=[readDocumentTool,prepareTaskTool,...onlineSkillTools,installSkillTool,searchAllSkillsTool,runtimeTool,pythonTool];

export function createTaskCapabilities(options) {
  const online=createOnlineSkills({sources:options.skillSources,signal:options.signal,
    ...(options.githubAccess?{fetcher:options.githubAccess.fetch,gitFallback:true}:{}),
    emit:(type,data)=>options.store.record(options.run,type,data)});
  const readSkills=new Set(),installed=new Map();
  return {close:()=>online.close(),async execute(call) {
    const name=call.function.name,definition=taskCapabilityTools.find(tool=>tool.name===name);
    let args;try{args=JSON.parse(call.function.arguments);}catch{return failure(definition.errors,'INVALID_ARGUMENT');}
    if(validate(definition.parameters,args).length)return failure(definition.errors,'INVALID_ARGUMENT');
    let result;
    if(name==='install_discovered_skill') {
      if (!readSkills.has(args.id)) return failure(installSkillTool.errors,'SKILL_NOT_READ');
      if (installed.has(args.id)) return installed.get(args.id);
      if (!options.installSkill) return failure(installSkillTool.errors,'INSTALL_FAILED');
      try {
        const {card,entries}=await online.package(args.id);
        options.signal.throwIfAborted();
        const {skill,reused}=options.installSkill({card,entries});
        result=success({id:skill.id,name:skill.name,version:skill.version,path:skill.storagePath,reused,fileCount:entries.length,
          instructions:skill.instructions,source:{url:card.url,commit:card.commit,sha256:card.sha256,license:card.license}});
        installed.set(args.id,result);
        options.store.record(options.run,'external_skill_installed',{...result.data,instructions:undefined,reason:args.reason,externalId:args.id});
      } catch(error) {
        const code=options.signal.aborted?'ABORTED':error.code==='SKILL_NOT_FOUND'?'SKILL_NOT_FOUND':error.status===409?'NAME_CONFLICT':'INSTALL_FAILED';
        return failure(installSkillTool.errors,code);
      }
    }
    else if(name==='search_skill_libraries') {
      const sources=(options.skillSources??['anthropics/skills','openai/skills']).filter(source=>/^[\w.-]+\/[\w.-]+$/.test(source)).slice(0,4);
      const {query,kind='direct'}=args;
      const minimum=kind==='direct'?3:2;
      const limit=Math.max(args.limit,minimum);
      options.store.record(options.run,'skill_library_search_started',{query,kind,limit,sources});
      const [local,remote]=await Promise.all([
        options.search(query,options.signal,limit),
        online.execute('discover_skills',{query,limit}),
      ]);
      result=success({kind,local:local.slice(0,limit).map(item=>({id:item.id,name:item.label??item.name,version:String(item.version),description:item.description??''})),
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
    } else {
      result=await online.execute(name,args);
      if (name==='adopt_discovered_skill' && result.ok) readSkills.add(args.id);
    }
    return checkResult(definition,result);
  }};
}
