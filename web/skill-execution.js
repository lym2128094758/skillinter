const node=(tag,value,cls)=>{const el=document.createElement(tag);if(value!==undefined)el.textContent=value;if(cls)el.className=cls;return el;};
const action=(label,handler)=>{const el=node('button',label);el.type='button';el.onclick=handler;return el;};
const field=(label,value='',tag='input')=>{const row=node('label',label),input=document.createElement(tag);input.value=value;if(tag==='textarea')input.rows=4;row.append(input);return {row,input};};
const verdicts={passed:'通过',failed:'未通过',unknown:'未确认',improved:'实际任务有新增通过',no_gain:'未测出实际增益'};
export function createSkillExecutionView({container,candidate,api,withContext,bodyContext,isVisible,initialPlanId,initialDraft,onReview,onSource}){
  let timer,current=null,disposed=false,busy=false;
  const regressions = candidate.regressionCases ?? [];
  const base='/api/skill-studio',collection=base+'/candidates/'+candidate.id+'/execution-plans';
  const status=node('p','','status'),list=node('div','','studio-list'),detail=node('div'),editor=node('div');
  const header=node('div','','studio-heading');header.append(node('h3','实际任务对照'),action('刷新',()=>void load()));
  if (!candidate.publishedVersion) header.append(action('新建测试计划',()=>drawEditor()));
  container.replaceChildren(header,node('p','在临时目录中分别执行原技能和候选，使用同一份冻结材料、验收条件、模型和预算。结果不自动发布技能，也不更新排序。','status'),status,list,editor,detail);
  const report=error=>{status.textContent=error.message??'执行对照请求失败。';};
  async function work(fn){if(busy)return;busy=true;try{await fn();}catch(error){report(error);}finally{busy=false;}}
  function planRow(plan){const row=node('section','','studio-card'),label=node('div'),latest=plan.trials[0];
      row.dataset.executionPlan=plan.id;
      label.append(node('strong',new Date(plan.createdAt).toLocaleString('zh-CN')+' · '+plan.spec.cases.length+' 个任务'),
        node('p',latest?.status==='running'?'执行中':latest?verdicts[latest.verdict]:'已冻结，未执行','status'));
      row.append(label,action('查看计划与真实产物',()=>void open(plan.id)));return row;}
  async function load(){await work(async()=>{
    const {plans}=await api(withContext(collection));
    list.replaceChildren(...plans.map(planRow));
    if(!plans.length)list.append(node('p', regressions.length ? '新建计划时会带上历史回归用例。' : '还没有实际任务对照。新建至少两个自包含任务，覆盖常规输入和边界。','status'));
  });}
  function drawEditor(draft){
    clearTimeout(timer);current=null;detail.replaceChildren();editor.replaceChildren();
    const form=node('section','','studio-case'),cases=[],caseList=node('div','','studio-list');
    form.append(node('h4','冻结任务、材料与独立验收条件'),node('p','只使用这里提供的测试副本，不读取原项目树。预期结果需你独立核对；材料和判据在调用模型前冻结，修改须另建计划。','status'));
    if (regressions.length) {
      const history = node('details');
      history.append(node('summary', `随计划运行的历史回归用例 · ${regressions.length} 项`));
      for (const sample of regressions) history.append(node('p', `${sample.name} · 源自 v${sample.version}`));
      form.append(history);
    }
    const calls=field('每组最多模型调用','6'),seconds=field('每组执行预算（秒）','90'),tokens=field('每次最大输出 tokens','4096');
    for(const [entry,min,max]of[[calls,2,12],[seconds,15,180],[tokens,256,8192]]){entry.input.type='number';entry.input.min=min;entry.input.max=max;}
    const budget=node('div','','studio-execution-budget');budget.append(calls.row,seconds.row,tokens.row);form.append(budget,caseList);
    const addCase=(seed)=>{
      if(cases.length>=4)return;
      const item=node('section','','studio-case'),name=field('任务名称',seed?.name ?? (cases.length?'边界任务':'常规任务')),prompt=field('任务目标与交付要求','','textarea');prompt.input.maxLength=8000;
      const files=[],filesList=node('div','','studio-list');
      let reviewed;
      function addFile(path='',content=''){
        if(files.length>=12)return;const row=node('div','','studio-case'),filePath=field('测试文件路径（相对测试目录）',path),text=field('文件内容',content,'textarea');text.input.maxLength=64000;
        if (reviewed) reviewed.checked = false;
        const entry={path:filePath.input,content:text.input};files.push(entry);row.append(filePath.row,text.row,action('移除此材料',()=>{files.splice(files.indexOf(entry),1);row.remove();if(reviewed)reviewed.checked=false;}));filesList.append(row);
      }
      const upload=document.createElement('input');upload.type='file';upload.multiple=true;upload.setAttribute('aria-label','加入此任务的文本测试文件');
      upload.onchange=()=>void work(async()=>{for(const file of upload.files){if(file.size>64000)throw Error('每个文本测试文件最多 64 KB。');const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());addFile(file.name,text);}upload.value='';});
      const acceptance=field('产物验收条件 JSON',JSON.stringify(seed?.acceptance ?? {version:1,preserve_inputs:['input.json'],artifacts:[{path:'report.json',format:'json',require_change:true,
        checks:[{kind:'json_equals',pointer:'/result',expected:'2'}]}]},null,2),'textarea');acceptance.input.rows=9;acceptance.input.maxLength=24000;
      const entry={name:name.input,prompt:prompt.input,files,acceptance:acceptance.input};cases.push(entry);
      if (seed?.source) {
        const evidence = node('details'); evidence.open = true;
        evidence.append(node('summary','来自真实失败的回归草稿'), node('p','请另写测试指令，提供脱敏或合成材料，并独立填写预期值。','status'));
        for (const event of seed.evidence) evidence.append(node('p', [event.ref,event.type,event.status,...event.codes,event.errorCode].filter(Boolean).join(' · '),'status'));
        const approval = node('label'), confirmed = node('input'); confirmed.type = 'checkbox';
        reviewed = confirmed;
        item.addEventListener('input', event => { if (event.target !== confirmed) confirmed.checked = false; });
        approval.append(confirmed, ' 我已核对测试指令、材料和预期结果。');
        entry.source = seed.source; entry.confirmed = confirmed;
        item.append(evidence, approval);
      }
      item.append(name.row,prompt.row,node('p','可选择文本文件加入副本，或手动填写。文件内容会发送给当前模型。','status'),upload,filesList,action('手动加入材料',()=>addFile()),acceptance.row,
        action('移除此任务',()=>{cases.splice(cases.indexOf(entry),1);item.remove();}));caseList.append(item);
    };
    const save=action('冻结此测试计划（暂不调用模型）',()=>void work(async()=>{
      let spec;try{spec={budget:{maxCalls:Number(calls.input.value),maxSeconds:Number(seconds.input.value),maxOutputTokens:Number(tokens.input.value)},
        cases:cases.map(item=>({name:item.name.value.trim(),prompt:item.prompt.value.trim(),files:item.files.map(file=>({path:file.path.value.trim(),content:file.content.value})),acceptance:JSON.parse(item.acceptance.value),
          ...(item.source ? {sourceExperienceId:item.source.experienceId,sourceConfirmed:item.confirmed.checked} : {})}))};}
      catch{throw Error('验收条件不是有效 JSON，请检查后再冻结。');}
      const plan=await api(collection,{...bodyContext(),spec});editor.replaceChildren();show(plan);status.textContent='已冻结；核对后点击“开始隔离执行”。';
    }));
    form.append(action('＋ 增加新任务（最多 4 个）',()=>addCase()),save);editor.append(form);
    if (draft) addCase(draft);
    for (let index = regressions.length + cases.length; index < 2; index++) addCase();
  }
  const planUrl=id=>base+'/execution-plans/'+id;
  async function open(id){await work(async()=>{editor.replaceChildren();show(await api(withContext(planUrl(id))));});}
  function show(plan){
    current=plan.id;clearTimeout(timer);detail.replaceChildren();
    const latest=plan.trials[0],intro=node('section','','studio-case'),actions=node('div','','actions');
    if(!list.querySelector('[data-execution-plan="'+plan.id+'"]'))list.prepend(planRow(plan));
    const listStatus=list.querySelector('[data-execution-plan="'+plan.id+'"] .status');
    if(listStatus)listStatus.textContent=latest?.status==='running'?'执行中':latest?verdicts[latest.verdict]:'已冻结，未执行';
    intro.append(node('h4','冻结计划 · '+plan.spec.cases.length+' 个任务'),node('p',plan.note,'status'),
      node('p','每组上限：'+plan.spec.budget.maxCalls+' 次模型调用 · '+plan.spec.budget.maxSeconds+' 秒 · 每次 '+plan.spec.budget.maxOutputTokens+' 输出 tokens','status'),
      node('p','计划 SHA-256：'+plan.sha256,'status studio-file-path'));
    if (plan.regressionIds?.length) intro.append(node('p', `包含 ${plan.regressionIds.length} 项历史回归用例。全部通过后才可发布。`, 'status'));
    const start=action('开始隔离执行',()=>void work(async()=>{await api(planUrl(plan.id)+'/run',bodyContext());show(await api(withContext(planUrl(plan.id))));}));start.disabled=Boolean(candidate.publishedVersion)||latest?.status==='running';
    actions.append(start,action('停止本计划',()=>void work(async()=>show(await api(planUrl(plan.id)+'/stop',bodyContext())))),action('刷新结果',()=>void open(plan.id)),
      action('导出完整对照记录',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(plan,null,2)],{type:'application/json'}));const link=node('a');link.href=url;link.download='skill-execution-'+plan.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));intro.append(actions);
    if (!candidate.publishedVersion && latest?.status === 'completed' && latest.verdict === 'improved') {
      actions.append(action('查看审核发布资格', onReview));
    }
    const frozen=node('details');frozen.append(node('summary','冻结的材料、判据与资源指纹'),node('pre',JSON.stringify({spec:plan.spec,resources:plan.resources.map(({path,sha256})=>({path,sha256})),executionSha256:plan.executionSha256},null,2)));intro.append(frozen);detail.append(intro);
    for (const [index, source] of (plan.caseSources ?? []).entries()) {
      if (!source) continue;
      frozen.append(node('p', `${plan.spec.cases[index].name} · ${source.evidenceRefs.join('、')}`, 'status'), action('查看原始会话', () => onSource?.(source.taskId)));
    }
    for(const trial of plan.trials){
      const section=node('section','','studio-case');section.append(node('h4',new Date(trial.startedAt).toLocaleString('zh-CN')+' · '+(trial.status==='running'?'执行中':trial.status==='interrupted'?'未完成':verdicts[trial.verdict])),
        node('p',trial.reason),node('p','请求模型：'+trial.requestedModel,'status'));
      if(trial.total)section.append(node('p',`实际任务通过：原技能 ${trial.baselinePassed}/${trial.total} → 候选 ${trial.candidatePassed}/${trial.total}；新增通过 ${trial.improvedCases} 项。`,'status'));
      for(const pair of trial.pairs){
        const item=node('details');item.open=trial.status==='running';item.append(node('summary',(pair.index < (plan.regressionIds?.length ?? 0) ? '历史回归' : '任务')+' '+(pair.index+1)+' · '+pair.name));const columns=node('div','','studio-results');
        for(const side of ['baseline','candidate']){
          const leg=pair[side],panel=node('section','','studio-output');panel.append(node('h5',side==='baseline'?(plan.baseline?'原技能 v'+plan.baseVersion:'基础工具'):'候选技能'));
          if(!leg){panel.append(node('p','尚未完成本组。','status'));columns.append(panel);continue;}
          panel.append(node('p',verdicts[leg.status]+' · '+leg.modelRequests.length+' 次请求 · '+(leg.elapsedMs/1000).toFixed(1)+' 秒','status'));
          const used=leg.modelRequests.map(item=>item.usage).filter(Boolean);if(used.length===leg.modelRequests.length)panel.append(node('p','输入 '+used.reduce((sum,u)=>sum+(u.prompt_tokens??0),0)+' / 输出 '+used.reduce((sum,u)=>sum+(u.completion_tokens??0),0)+' tokens','status'));
          if(leg.error)panel.append(node('p',leg.error,'dialog-error'));
          for(const check of leg.verification?.checks??[])panel.append(node('p',(verdicts[check.status]??check.status)+' · '+check.path+' · '+check.message,'status'));
          for(const artifact of leg.artifacts){const link=node('a','下载 '+artifact.path);link.href=withContext(planUrl(plan.id)+'/trials/'+trial.id+'/files/'+artifact.id);link.download=artifact.path.split('/').at(-1);panel.append(link,node('p','SHA-256 '+artifact.sha256,'status studio-file-path'));}
          const trace=node('details');trace.append(node('summary','模型答复与真实轨迹'),node('pre',JSON.stringify({answer:leg.answer,modelRequests:leg.modelRequests,events:leg.events},null,2)));panel.append(trace);columns.append(panel);
        }item.append(columns);section.append(item);
      }detail.append(section);
    }
    if(latest?.status==='running')timer=setTimeout(async()=>{if(disposed||!isVisible()||current!==plan.id)return;try{show(await api(withContext(planUrl(plan.id))));}catch(error){report(error);}},3000);
  }
  if (initialDraft) drawEditor(initialDraft);
  void (initialPlanId ? open(initialPlanId) : load());
  return {dispose(){disposed=true;clearTimeout(timer);}};
}
