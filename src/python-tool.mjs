import {createHash} from 'node:crypto';
import {materialSnapshot,fileErrors} from './tools.mjs';
import {scopedPath,writableScope,projectDirectory,samePath} from './file-scope.mjs';
import {requestApproval} from './project-tests.mjs';
import {runProcess} from './process-runtime.mjs';
import {object,validate} from './schema.mjs';
import {resultSchema,success,failure} from './tool-contract.mjs';

const str={type:'string',maxLength:1000};
export const pythonErrors={...fileErrors,INVALID_ARGUMENT:'Python 执行参数无效。',PYTHON_NOT_ALLOWED:'运行 Python 需要绑定项目并开启读写权限。',
  APPROVAL_DECLINED:'用户拒绝了本次 Python 执行。',APPROVAL_EXPIRED:'Python 执行确认已过期。',
  APPROVAL_SUPERSEDED:'收到新引导，已撤回待确认的 Python 执行。',ABORTED:'Python 执行已停止。',
  PYTHON_UNAVAILABLE:'Python 无法启动，请安装并配置到 PATH。',TIMEOUT:'Python 执行超过 60 秒，已停止。'};
export const pythonTool={name:'run_python',description:'运行已经写入并读取确认的项目 Python 脚本，用于计算、求解、绘图或文档处理。必须提供脚本当前 SHA-256，按运行设置自动同意或等待用户确认；使用固定 python -I，冻结脚本字节，无 shell，最长60秒。代码有当前系统账号权限，不是沙箱。退出码0不代表业务结果正确。',
  parameters:object({path:{...str,minLength:1,pattern:'\\.py$'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},purpose:{...str,minLength:1,maxLength:500}}),
  returns:resultSchema(object({kind:{enum:['python_execution']},status:{enum:['passed','failed']},script:str,scriptSha256:str,
    exitCode:{anyOf:[{type:'integer'},{enum:[null]}]},stdout:{type:'string',maxLength:16000},stderr:{type:'string',maxLength:16000},
    truncated:{type:'boolean'},volatile:object({elapsedMs:{type:'integer'}})})),
  errors:pythonErrors,timeoutMs:60000,approvalTimeoutMs:60000,idempotent:false,volatile:['data.stdout','data.stderr','data.volatile.elapsedMs'],
  ordering:'stdout和stderr分别按进程写入顺序，保留前16000字节并注明截断。',authorization:'项目读写，按运行设置自动同意或逐次确认。最小环境不含模型密钥；Python仍有操作系统账号权限。',timeoutMode:'确认和运行各60秒，父停止或超时终止进程树。'};
export async function runPython(args,{scope,workspace,signal,store,run,entry}) {
  if(validate(pythonTool.parameters,args).length)return failure(pythonErrors,'INVALID_ARGUMENT');
  if(!scope?.projectId||!scope.projectPath||!writableScope(scope.mode)||!entry)return failure(pythonErrors,'PYTHON_NOT_ALLOWED');
  try {
    const script=await materialSnapshot(workspace,scope,args.path,signal);
    if(script.error)return {ok:false,data:null,error:script.error};
    const sha=createHash('sha256').update(script.bytes).digest('hex');
    if(sha!==args.sha256)return failure(pythonErrors,'FILE_CHANGED');
    const location=await scopedPath(scope,args.path,{write:true});
    if(!samePath(await projectDirectory(scope.projectPath,scope.state),scope.projectPath))return failure(pythonErrors,'WORKSPACE_NOT_FOUND');
    const decision=await requestApproval({entry,signal,store,run,cwd:scope.projectPath,purpose:'python_execution',
      requestedCommand:'python -I '+args.path+' · '+args.purpose+' · SHA256 '+sha,executable:'python',waitMs:60000});
    if(decision!=='approve')return failure(pythonErrors,{decline:'APPROVAL_DECLINED',expired:'APPROVAL_EXPIRED',superseded:'APPROVAL_SUPERSEDED',aborted:'ABORTED'}[decision]||'ABORTED');
    if(store.hasGuidance(run))return failure(pythonErrors,'APPROVAL_SUPERSEDED');
    const current=await materialSnapshot(workspace,scope,args.path,signal);
    if(current.error||createHash('sha256').update(current.bytes).digest('hex')!==sha)return failure(pythonErrors,'FILE_CHANGED');
    store.record(run,'project_test_started',{command:'python -I '+args.path,cwd:scope.projectPath,purpose:'python_execution',scriptSha256:sha});
    const wrapper="import sys; source=sys.stdin.buffer.read(); script=sys.argv[1]; sys.argv=[script]; exec(compile(source,script,'exec'),{'__name__':'__main__','__file__':script,'__package__':None})";
    const result=await runProcess('python',['-I','-u','-c',wrapper,location.target],{input:script.bytes,cwd:scope.projectPath,signal,timeoutMs:60000,maxBytes:16000,
      env:{PYTHONIOENCODING:'utf-8',MPLBACKEND:'Agg'}});
    if(result.unavailable)return failure(pythonErrors,'PYTHON_UNAVAILABLE');
    if(result.aborted){store.record(run,'python_interrupted',{script:args.path,scriptSha256:sha,stdout:result.stdout,stderr:result.stderr});return failure(pythonErrors,signal.aborted?'ABORTED':'TIMEOUT');}
    return success({kind:'python_execution',status:result.exitCode===0?'passed':'failed',script:args.path,scriptSha256:sha,
      exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,truncated:result.truncated,volatile:{elapsedMs:result.elapsedMs}});
  } catch(error){return failure(pythonErrors,signal.aborted?'ABORTED':Object.hasOwn(pythonErrors,error.contractCode)?error.contractCode:'PYTHON_UNAVAILABLE');}
}
