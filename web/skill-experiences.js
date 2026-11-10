const node=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=fn;return b;};

export function drawExperiences(container,items,{work,api,url,body,onCandidate,onSource,onRegression}){
  container.replaceChildren();
  if(!items.length){container.append(node('p','当前范围还没有经验线索。完成任务后，系统会自动检查验收变化、重复工具错误和用户纠正。','status'));return;}
  for(const item of items){
    const card=node('section','', 'studio-case experience-card');card.dataset.experienceId=item.id;
    card.append(node('h4',item.taskTitle),node('p',item.prompt,'experience-prompt'),
      node('p',item.state==='dismissed'?'已忽略 · 可恢复':'待审核的观察线索 · '+item.runStatus,'status'));
    const signals=node('ul');for(const signal of item.signals)signals.append(node('li',signal.label));card.append(signals);
    if(item.eventsTruncated)card.append(node('p','本轮超过 1000 条事件，线索仅基于前 1000 条，记录不完整。','status'));
    const evidence=node('details');evidence.append(node('summary','查看来源依据 · '+item.references.length+' 处'));
    for(const ref of item.references)evidence.append(node('p',ref.id+' · '+ref.type,'status'),node('pre',ref.excerpt));
    evidence.append(button('打开原始会话',()=>onSource(item.taskId)));card.append(evidence);
    const select=node('select');select.setAttribute('aria-label','要改进的技能');
    const targets=item.skills.filter(s=>Number.isSafeInteger(s.version));
    select.append(new Option(targets.length?'请选择实际参与的技能':'提炼为新技能',''));
    for(const skill of targets)select.append(new Option(skill.name+' · v'+skill.version,skill.id));
    if(targets.length===1)select.value=targets[0].id;
    const feedback=node('textarea');feedback.rows=2;feedback.maxLength=4000;feedback.placeholder='补充改进目标（可选）';feedback.setAttribute('aria-label','补充改进目标');
    const actions=node('div','','actions');
    const generate=button('从线索生成候选',()=>void work('正在根据来源生成隔离候选…',async isCurrent=>{
      const proposal=await api(url+'/'+item.id+'/propose',{...body(),...(select.value?{skillId:select.value}:{}),feedback:feedback.value});
      const candidate=await api(url.replace('/experiences','/candidates')+'/'+proposal.candidateId+'?'+new URLSearchParams(Object.entries(body()).filter(([,v])=>v!=null).map(([k,v])=>[k==='taskId'?'task':k==='projectId'?'project':k,v])));
      if(isCurrent())onCandidate(candidate,proposal);
    }));generate.className='primary-action';generate.disabled=item.state==='dismissed';
    const toggle=button(item.state==='dismissed'?'恢复线索':'忽略',()=>void work('正在保存线索状态…',async isCurrent=>{
      const updated=await api(url+'/'+item.id+'/state',{...body(),state:item.state==='dismissed'?'open':'dismissed'});
      if(isCurrent()){items[items.indexOf(item)]=updated;drawExperiences(container,items,{work,api,url,body,onCandidate,onSource,onRegression});}
    }));actions.append(generate,toggle);
    card.append(select,feedback,actions,node('p','保留原技能名、适用条件和验收条件；生成后进入候选验证，不会自动启用。','status'));
    if (item.state === 'open' && item.signals.some(signal => signal.code !== 'USER_CORRECTION')) {
      const picker = node('div', '', 'actions');
      const candidateBase = url.replace('/experiences', '/candidates');
      const scoped = () => new URLSearchParams(Object.entries(body()).filter(([, value]) => value != null)
        .map(([key, value]) => [key === 'taskId' ? 'task' : key === 'projectId' ? 'project' : key, value]));
      actions.append(button('准备回归草稿', () => void work('正在查找关联候选…', async isCurrent => {
        const {candidates} = await api(candidateBase + '?' + scoped());
        if (!isCurrent()) return;
        const choices = candidates.filter(candidate => !candidate.publishedVersion && candidate.projectId === item.projectId &&
          (item.skills.length ? item.skills.some(skill => skill.id === candidate.skillId) : candidate.sourceRunId === item.runId));
        if (!choices.length) {
          picker.replaceChildren(node('p', '先为这条经验准备一个待发布的改进候选。', 'status'));
          return;
        }
        const selectCandidate = node('select');
        selectCandidate.setAttribute('aria-label', '回归草稿关联的候选');
        for (const candidate of choices) selectCandidate.append(new Option(candidate.name + ' · 基于 v' + candidate.baseVersion, candidate.id));
        picker.replaceChildren(selectCandidate, button('打开回归草稿', () => void work('正在整理失败依据…', async current => {
          const candidateId = selectCandidate.value;
          const draft = await api(url + '/' + item.id + '/regression-draft', {...body(), candidateId});
          const candidate = await api(candidateBase + '/' + candidateId + '?' + scoped());
          if (current()) onRegression(candidate, draft);
        })));
      })));
      card.append(picker);
    }
    for(const proposal of item.proposals){
      const details=node('details');details.append(node('summary','已生成候选 · 改动 '+proposal.changes.length+' 个字段'));
      for(const change of proposal.changes)details.append(node('p','改动：'+change.field+' · 来源 '+change.evidenceRefs.join('、'),'status'));
      details.append(button('查看候选与验证',()=>void work('正在读取候选…',async isCurrent=>{
        const query=new URLSearchParams(Object.entries(body()).filter(([,v])=>v!=null).map(([k,v])=>[k==='taskId'?'task':k==='projectId'?'project':k,v]));
        const candidate=await api(url.replace('/experiences','/candidates')+'/'+proposal.candidateId+'?'+query);if(isCurrent())onCandidate(candidate,proposal);
      })));card.append(details);
    }
    container.append(card);
  }
}

export function drawExperienceChanges(container,proposal){
  const details=node('details');details.open=true;details.append(node('summary','这份候选为什么产生'),node('p',proposal.limitation,'status'));
  for(const change of proposal.changes){
    const section=node('details');section.append(node('summary',change.field+' · 查看修改前后'),
      node('p','原版本','status'),node('pre',typeof change.before==='string'?change.before:JSON.stringify(change.before,null,2)),
      node('p','候选','status'),node('pre',typeof change.after==='string'?change.after:JSON.stringify(change.after,null,2)),
      node('p','待审核依据：'+change.evidenceRefs.join('、'),'status'));details.append(section);
  }
  container.prepend(details);
}
