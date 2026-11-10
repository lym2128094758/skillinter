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
export const taskCapabilityTools=[readDocumentTool,prepareTaskTool,...onlineSkillTools,runtimeTool,pythonTool];

export function createTaskCapabilities(options) {
  const online=createOnlineSkills({sources:options.skillSources,signal:options.signal,
    ...(options.githubAccess?{fetcher:options.githubAccess.fetch,gitFallback:true}:{}),
    emit:(type,data)=>options.store.record(options.run,type,data)});
  return {close:()=>online.close(),async execute(call) {
    const name=call.function.name,definition=taskCapabilityTools.find(tool=>tool.name===name);
    let args;try{args=JSON.parse(call.function.arguments);}catch{return failure(definition.errors,'INVALID_ARGUMENT');}
    if(validate(definition.parameters,args).length)return failure(definition.errors,'INVALID_ARGUMENT');
    let result;
    if(name==='read_document')result=await readDocument(args,options);
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
