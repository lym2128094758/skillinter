(() => {
  'use strict';
  const context = new URLSearchParams(location.search);
  const nativeFetch = window.fetch.bind(window);
  window.skillLibraryFetch = (path,options) => {
    const url = new URL(path,location.origin);
    const routes = {'/api/skills':'/api/skill-graph/skills','/api/skill':'/api/skill-graph/skill','/api/relations':'/api/skill-graph/relations'};
    if (!routes[url.pathname] || url.origin !== location.origin) throw Error('不支持此图谱请求。');
    url.pathname = routes[url.pathname];
    for (const key of ['task','project']) if (context.has(key)) url.searchParams.set(key,context.get(key));
    return nativeFetch(url,options);
  };
  const notify = (action,data={}) => parent.postMessage({type:'sih-skill-graph',action,...data},location.origin);
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  function registryUrl(path){const url=new URL('/api/skill-registry'+path,location.origin);for(const key of ['task','project'])if(context.has(key))url.searchParams.set(key,context.get(key));return url;}
  async function registryRequest(path,body,remove=false){
    const response=await nativeFetch(registryUrl(path),body?{method:remove?'DELETE':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
    const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.message??result.error??'注册表操作失败。');return result.data;
  }
  window.addEventListener('DOMContentLoaded',() => {
    const actions = document.querySelector('.detail-actions');
    const editor=el('section');editor.id='registryEditor';editor.className='registry-editor';
    document.querySelector('.detail-scroll').append(editor);
    let request=0;
    window.addEventListener('sih-skill-selected',async event=>{
      const selected=event.detail.id,version=++request;
      notify('selected',{id:selected});
      editor.replaceChildren(el('p','正在读取技能身份与关系…'));
      try{
        const snapshot=await registryRequest('');if(version!==request)return;
        const current=snapshot.skills.find(item=>item.skillId===selected);if(!current)return;
        editor.replaceChildren(el('h3','身份与执行关系'),el('p',current.name+' · v'+current.version),el('code',current.skillId),
          el('p','保存后下一轮生效；历史运行使用自己的关系快照。'));
        const status=el('p');status.setAttribute('role','status');editor.append(status);
        const option=(value,label)=>{const node=el('option',label);node.value=value;return node;};
        const button=(label,handler)=>{const node=el('button',label);node.type='button';node.className='secondary-button';node.onclick=async()=>{
          node.disabled=true;try{await handler();await window.SkillLibraryHost.reload();}catch(error){status.textContent=error.message;node.disabled=false;}
        };return node;};
        const target=el('select');target.setAttribute('aria-label','关系目标技能');
        for(const skill of snapshot.skills.filter(item=>item.skillId!==selected))target.append(option(skill.skillId,skill.name+' · '+(skill.projectId?'项目':'用户')+' · '+skill.skillId.slice(0,8)));
        const type=el('select');type.setAttribute('aria-label','执行关系类型');
        const labels={depend_on:'当前技能依赖目标（目标先执行）',compose_with:'互补（不指定顺序）',similar_to:'可替代（不自动加入）'};
        for(const [value,label] of Object.entries(labels))type.append(option(value,label));
        const form=el('div');form.append(el('label','声明执行关系'),type,target,button('保存执行关系',()=>registryRequest('/relations',{
          source:selected,target:target.value,type:type.value,expectedRevision:snapshot.revision})));editor.append(form);
        const name=id=>snapshot.skills.find(skill=>skill.skillId===id)?.name??id;
        for(const edge of snapshot.relations.filter(edge=>edge.source===selected||edge.target===selected)){
          const row=el('div');row.append(el('p',name(edge.source)+' → '+name(edge.target)+' · '+labels[edge.type]));
          if(edge.provenance==='user-declaration'&&edge.scope===snapshot.scope)row.append(button('移除此执行关系',()=>registryRequest('/relations',{
            source:edge.source,target:edge.target,type:edge.type,expectedRevision:snapshot.revision},true)));
          else row.append(el('p',edge.provenance==='explicit-catalog-binding'?'来自明确绑定的原目录身份；解除绑定可撤回。':'继承用户范围关系，请在用户范围编辑。'));
          editor.append(row);
        }
        for(const issue of snapshot.issues.filter(issue=>issue.skillId===selected))editor.append(el('p','待处理：'+issue.code+' · '+name(issue.target)));
        const binding=el('details');binding.append(el('summary','原目录身份绑定（可选）'),el('p','同名不会自动合并。确认来源后填写原 SkillNet 目录 ID。'));
        const external=el('input');external.placeholder='例如 literature-review';external.maxLength=200;external.setAttribute('aria-label','原目录技能 ID');
        binding.append(external,button('确认绑定身份',()=>registryRequest('/bindings',{skillId:selected,externalId:external.value.trim(),expectedRevision:snapshot.revision})));
        for(const ref of snapshot.externalRefs.filter(ref=>ref.skillId===selected)){
          binding.append(el('p',ref.externalId+(ref.scope!==snapshot.scope?'（用户范围）':'')));
          if(ref.scope===snapshot.scope)binding.append(button('解除 '+ref.externalId,()=>registryRequest('/bindings',{skillId:selected,externalId:ref.externalId,expectedRevision:snapshot.revision},true)));
        }
        editor.append(binding);
        if(current.projectId){
          const overrides=el('details');overrides.append(el('summary','显式声明项目覆盖'),el('p','选择要覆盖的用户技能；名称相同也保留独立身份。'));
          const global=el('select');global.setAttribute('aria-label','被覆盖的用户技能');
          for(const skill of snapshot.skills.filter(skill=>!skill.projectId))global.append(option(skill.skillId,skill.name+' · '+skill.skillId.slice(0,8)));
          overrides.append(global,button('声明覆盖',()=>registryRequest('/overrides',{projectSkillId:selected,globalSkillId:global.value,expectedRevision:snapshot.revision})));
          for(const item of snapshot.overrides.filter(item=>item.projectSkillId===selected))overrides.append(button('撤回对 '+name(item.globalSkillId)+' 的覆盖',()=>registryRequest('/overrides',{
            projectSkillId:selected,globalSkillId:item.globalSkillId,expectedRevision:snapshot.revision},true)));
          editor.append(overrides);
        }
      }catch(error){if(version===request)editor.replaceChildren(el('p',error.message));}
    });
    for (const [label,action] of [['用于下一轮','use'],['在技能中心管理','manage']]) {
      const button = document.createElement('button');
      button.type='button';button.className='secondary-button';button.textContent=label;
      button.onclick=()=>{const id=window.SkillLibraryHost?.selected();if(id)notify(action,{id});};
      actions.append(button);
    }
    document.querySelector('#expandGraph').hidden=false;
    document.querySelector('#expandGraph').onclick=()=>notify('expand');
    window.addEventListener('message',event=>{
      if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='sih-skill-graph-control')return;
      const host=window.SkillLibraryHost;
      if(!host)return;
      if(event.data.action==='focus')host.focus(event.data.id);
      if(event.data.action==='execution')host.execution(event.data.ids??[],event.data.states??[]);
      if(event.data.action==='enable')host.enable(event.data.value);
    });
    window.addEventListener('sih-skill-graph-ready',()=>notify('ready'));
  });
})();
