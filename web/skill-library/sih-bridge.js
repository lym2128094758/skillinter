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
  window.addEventListener('DOMContentLoaded',() => {
    const actions = document.querySelector('.detail-actions');
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
