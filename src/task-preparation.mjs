import {createHash} from 'node:crypto';
import {object,validate} from './schema.mjs';
import {resultSchema,success,failure} from './tool-contract.mjs';
import {updatePlan,currentPlan} from './task-plan.mjs';
import {readDocument} from './document-tools.mjs';
import {materialDigest} from './tools.mjs';

const str={type:'string',maxLength:2000};
const strings={type:'array',maxItems:12,items:str};
const step=object({id:{...str,maxLength:40},title:{...str,maxLength:200},depends_on:{type:'array',maxItems:12,items:{...str,maxLength:40}},skill_query:{...str,maxLength:500}});
export const preparationErrors={INVALID_ARGUMENT:'任务整理参数无效。',SOURCE_NOT_READ:'任务说明引用了本轮未读取的材料回执。',
  SOURCE_CHANGED:'材料在读取后变化或当前不可读，请重新读取再整理任务。',
  INVALID_PLAN:'任务步骤存在无效依赖、重名或循环。',TASK_NOT_PREPARED:'请先读取任务材料并调用 prepare_task，再开始写文件或运行计算。',ABORTED:'任务整理已停止。',PREPARATION_FAILED:'任务整理未完成。'};
export const prepareTaskTool={name:'prepare_task',description:'读过题目及材料后，保留原始用户目标，整理清晰目标、约束、交付要求、假设、必要问题与有依赖的子任务。为每步查询已安装技能，返回候选或缺口，并生成可见计划。source_receipts填本轮成功读取材料的回执序号。不能把假设或优化后的措辞当成用户已确认约束。',
  parameters:object({objective:{...str,minLength:1},constraints:strings,deliverables:strings,assumptions:strings,questions:strings,
    source_receipts:{type:'array',maxItems:20,items:{type:'integer',minimum:1}},steps:{type:'array',minItems:1,maxItems:12,items:step}}),
  returns:resultSchema(object({revision:{type:'integer',minimum:1},originalGoal:{type:'string',maxLength:16000},objective:str,constraints:strings,deliverables:strings,assumptions:strings,questions:strings,
    steps:{type:'array',items:object({...step.properties,candidates:{type:'array',items:object({id:str,name:str,version:str})},gap:{type:'boolean'}})},
    sources:{type:'array',items:object({seq:{type:'integer'},path:str,sha256:str})}})),
  errors:preparationErrors,timeoutMs:60000,idempotent:false,volatile:[],ordering:'保持步骤和来源回执顺序；候选沿用技能检索排序。',
  authorization:'只整理当前用户任务和本轮实际读过的材料，不能扩大范围、授予权限或发布技能。',timeoutMode:'继承根预算及停止，全部步骤检索60秒上限。'};

export function needsTaskPreparation(prompt) {
  return /数学建模|建模|论文|文献综述|研究报告|求解|分析.{0,12}数据|数据.{0,12}分析|多步骤/.test(prompt);
}

export async function gatherTaskMaterials({prompt,context,workspace,scope,signal,budget,store,run}) {
  if(!needsTaskPreparation(prompt)||!context.materials?.length)return null;
  const materials=context.materials.filter(item=>item.path&&item.kind!=='image').slice(0,4);
  const extracted=[];let remaining=24000;
  for(const item of materials) {
    if(remaining<=0)break;
    const result=await budget.tool('task-intake','read_document',()=>readDocument({path:item.path,offset:0,limit:160},
      {workspace,scope,signal,materials:context.materials}));
    const seq=store.record(run,'tool_result',{step:0,name:'read_document',output:result,intake:true});
    extracted.push({seq,path:item.path,name:item.name,...(result.ok?{sourceSha256:result.data.sourceSha256,text:result.data.text.slice(0,remaining),
      truncated:result.data.truncated||result.data.text.length>remaining}:{error:result.error})});
    remaining-=result.ok?result.data.text.length:0;
  }
  store.record(run,'task_intake',{files:extracted.map(({text,...item})=>item),truncated:materials.length<(context.materials?.length??0)});
  return extracted;
}

export async function prepareTask(args,{store,task,run,prompt,signal,search,workspace,scope}) {
  if(signal.aborted)return failure(preparationErrors,'ABORTED');
  if(validate(prepareTaskTool.parameters,args).length)return failure(preparationErrors,'INVALID_ARGUMENT');
  const events=store.events(run,0);
  if(new Set(args.source_receipts).size!==args.source_receipts.length)return failure(preparationErrors,'INVALID_ARGUMENT');
  const successfulReads=events.filter(event=>event.type==='tool_result'&&['read_file','read_document'].includes(event.payload.name)&&event.payload.output?.ok);
  if(successfulReads.length&&!args.source_receipts.length)return failure(preparationErrors,'SOURCE_NOT_READ');
  const sources=[];
  for(const seq of args.source_receipts) {
    const event=events.find(event=>event.seq===seq&&event.type==='tool_result'&&['read_file','read_document'].includes(event.payload.name)&&event.payload.output?.ok);
    if(!event)return failure(preparationErrors,'SOURCE_NOT_READ');
    const data=event.payload.output.data;
    const source={seq,path:data.file?.path??data.path,sha256:data.file?.sha256??data.sourceSha256};
    const snapshot=await materialDigest(workspace,scope,source.path,signal);
    if(snapshot.error||snapshot.value!==source.sha256)return failure(preparationErrors,signal.aborted?'ABORTED':'SOURCE_CHANGED');
    sources.push(source);
  }
  const plan=currentPlan(store,task);
  // Validate the entire DAG before making any engine calls or persisting a brief.
  const ids=new Set(args.steps.map(step=>step.id));
  const visiting=new Set(),done=new Set();
  function cycle(id){if(visiting.has(id))return true;if(done.has(id))return false;visiting.add(id);
    for(const dep of args.steps.find(step=>step.id===id).depends_on)if(!ids.has(dep)||cycle(dep))return true;
    visiting.delete(id);done.add(id);return false;}
  if(ids.size!==args.steps.length||new Set(args.steps.map(step=>step.title)).size!==args.steps.length||args.steps.some(step=>cycle(step.id)))return failure(preparationErrors,'INVALID_PLAN');
  const steps=[];
  try {
    const bound=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
    for(const step of args.steps) {
      bound.throwIfAborted();const found=await search(step.skill_query||step.title,bound);
      const candidates=found.filter(item=>item.executable&&item.tool==='load_skill').slice(0,3)
        .map(item=>({id:item.id,name:item.label??item.name,version:String(item.version)}));
      steps.push({...step,candidates,gap:candidates.length===0});
    }
    const updated=updatePlan(store,task,run,{expected_revision:plan?.revision??0,explanation:'基于材料整理任务；原始用户要求保持权威。',
      steps:args.steps.map(({id,title,depends_on})=>{
        const sameRunPlan=events.findLast(event=>event.type==='task_plan')?.payload;
        const prior=sameRunPlan?.steps.find(step=>step.id===id&&step.title===title&&JSON.stringify(step.depends_on)===JSON.stringify(depends_on));
        return {id,title,depends_on,status:prior?.status??'pending'};
      })},bound);
    if(!updated.ok)return failure(preparationErrors,'INVALID_PLAN');
    const data={revision:updated.data.revision,originalGoal:prompt,objective:args.objective,constraints:args.constraints,
      deliverables:args.deliverables,assumptions:args.assumptions,questions:args.questions,steps,sources};
    store.record(run,'task_brief',{...data,sha256:createHash('sha256').update(JSON.stringify(data)).digest('hex')});
    return success(data);
  } catch{return failure(preparationErrors,signal.aborted?'ABORTED':'PREPARATION_FAILED');}
}
