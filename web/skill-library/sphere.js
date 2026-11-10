/* Real catalogue nodes on a deterministic unit sphere. Coordinates are a visual
   index, never a learned capability metric. No synthetic relation edges. */
(function(root){
  'use strict';
  const TAU=Math.PI*2, GOLD=Math.PI*(3-Math.sqrt(5));
  const palette=['#8bc9ee','#b7a9e7','#dfc18c','#79d1d4','#deab99','#b8d494'];
  const themeColor=(token,fallback)=>root.SkillLibraryTheme?.color(token)||fallback;
  const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;};
  const color=d=>palette[hash(d)%palette.length];
  function layout(nodes){
    const sorted=[...nodes].sort((a,b)=>String(a.domain||'').localeCompare(String(b.domain||''))||String(a.id).localeCompare(String(b.id)));
    // Equal area spiral; contiguous domain bands retain a readable visual order.
    return sorted.map((n,i)=>{const y=1-2*(i+.5)/sorted.length,r=Math.sqrt(1-y*y),a=i*GOLD;return {...n,p:{x:Math.cos(a)*r,y,z:Math.sin(a)*r},color:n.color||color(n.domain)};});
  }
  function rotate(p,yaw,pitch){
    const x=p.x*Math.cos(yaw)+p.z*Math.sin(yaw),z=-p.x*Math.sin(yaw)+p.z*Math.cos(yaw);
    return {x,y:p.y*Math.cos(pitch)-z*Math.sin(pitch),z:p.y*Math.sin(pitch)+z*Math.cos(pitch)};
  }
  function project(p,w,h,zoom=1,center){
    const r=Math.min(w,h)*.36*zoom,k=3.4/(3.4-p.z);
    return {x:(center?.x??w/2)+p.x*r*k,y:(center?.y??h/2)+p.y*r*k,z:p.z,k};
  }
  function arc(a,b,t){
    const dot=Math.max(-1,Math.min(1,a.x*b.x+a.y*b.y+a.z*b.z)),theta=Math.acos(dot),sin=Math.sin(theta);
    if(Math.abs(sin)<1e-5){const p={x:a.x*(1-t)+b.x*t,y:a.y*(1-t)+b.y*t,z:a.z*(1-t)+b.z*t},n=Math.hypot(p.x,p.y,p.z);return n<1e-6?a:{x:p.x/n,y:p.y/n,z:p.z/n};}
    const l=Math.sin((1-t)*theta)/sin,r=Math.sin(t*theta)/sin;
    return {x:l*a.x+r*b.x,y:l*a.y+r*b.y,z:l*a.z+r*b.z};
  }
  function hit(points,x,y,minZ=-.15){
    return [...points].filter(p=>p.z>minZ&&Math.hypot(p.x-x,p.y-y)<Math.max(9,p.radius+4))
      .sort((a,b)=>b.z-a.z||Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0]?.node||null;
  }
  function create(canvas,options={}){
    const ctx=canvas.getContext('2d'),media=matchMedia('(prefers-reduced-motion: reduce)');
    let nodes=[],edges=[],by=new Map(),points=[],w=0,h=0,yaw=.25,pitch=-.2,zoom=1,lastPaint=0;
    let selected=null,hover=null,highlight=new Set(),states=new Map(),filter=()=>true,relations=null;
    let paused=media.matches,enabled=true,inView=true,raf=0,last=0,drag=null,showLabels=true,destroyed=false;
    let style={nodeSize:1,linkWidth:.8,scaleNodes:true,focusOnHover:true,labelThreshold:1.1};
    let pendingClick=null,clickTimer=0;
    let localId=null,pinId=null,anchor={x:0,y:0,z:0},anchorMix=0,cameraTween=null,globalCamera=null;
    function cancelClick(){clearTimeout(clickTimer);clickTimer=0;pendingClick=null;}
    const cleanups=[],listen=(el,type,fn,opts)=>{el.addEventListener(type,fn,opts);cleanups.push(()=>el.removeEventListener(type,fn,opts));};
    function setPaused(value){paused=!!value;options.onPause?.(paused);return paused;}
    function camera(p){
      const relative={x:p.x-anchor.x*anchorMix,y:p.y-anchor.y*anchorMix,z:p.z-anchor.z*anchorMix};
      return project(rotate(relative,yaw,pitch),w,h,zoom,options.center?.(w,h));
    }
    function moveCamera(target){
      cameraTween={start:performance.now(),from:{yaw,pitch,zoom,anchorMix},to:target};schedule();
    }
    function interruptCamera(){cameraTween=null;anchorMix=pinId?1:0;}
    function local(id){
      if(id===localId)return;
      if(id&&!by.has(id))return;
      if(id){
        if(!globalCamera)globalCamera={yaw,pitch,zoom};
        anchor={...by.get(id).p};localId=id;pinId=id;selected=id;
        const targetYaw=Math.atan2(-anchor.x,anchor.z),targetPitch=Math.atan2(anchor.y,Math.hypot(anchor.x,anchor.z));
        const nearest=yaw+Math.atan2(Math.sin(targetYaw-yaw),Math.cos(targetYaw-yaw));
        moveCamera({yaw:nearest,pitch:targetPitch,zoom:Math.max(1.8,zoom),anchorMix:1});
      }else{
        localId=null;pinId=null;moveCamera({... (globalCamera||{yaw,pitch,zoom:1}),anchorMix:0});globalCamera=null;
      }
    }
    function schedule(){if(!destroyed&&!raf&&enabled&&inView&&!document.hidden)raf=requestAnimationFrame(frame);}
    function frame(now){
      raf=0;if(!paused&&now-lastPaint<30){schedule();return;}
      const dt=Math.min(.05,(now-last)/1000||0);last=lastPaint=now;
      if(cameraTween){
        const t=media.matches?1:Math.min(1,(now-cameraTween.start)/600),e=t*t*(3-2*t),{from,to}=cameraTween;
        yaw=from.yaw+(to.yaw-from.yaw)*e;pitch=from.pitch+(to.pitch-from.pitch)*e;
        zoom=from.zoom+(to.zoom-from.zoom)*e;anchorMix=from.anchorMix+(to.anchorMix-from.anchorMix)*e;
        if(t===1)cameraTween=null;
      }else if(!paused&&!drag&&!hover)yaw+=dt*.065;
      draw();if(!paused||cameraTween)schedule();
    }
    function draw(){
      const dpr=Math.min(2,root.devicePixelRatio||1);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!enabled||!w||!h)return;
      const center=options.center?.(w,h)||{x:w/2,y:h/2},radius=Math.min(w,h)*.36*zoom;
      const glow=ctx.createRadialGradient(center.x,center.y,radius*.55,center.x,center.y,radius*1.5);
      const accent=themeColor('--accent','#a1a1aa'),muted=themeColor('--muted','#a1a1aa');
      glow.addColorStop(0,accent+'07');glow.addColorStop(.65,accent+'16');glow.addColorStop(1,accent+'00');
      ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
      // Three spherical meridians + latitude lines supply depth even in sparse task views.
      ctx.lineWidth=.7;ctx.setLineDash([]);
      for(let ring=0;ring<7;ring++){
        ctx.beginPath();for(let i=0;i<=100;i++){const a=i/100*TAU;let p;if(ring<4){const lat=(ring-1.5)*.43,r=Math.sqrt(1-lat*lat);p={x:r*Math.cos(a),y:lat,z:r*Math.sin(a)};}else{const b=(ring-4)*Math.PI/3;p={x:Math.cos(a)*Math.cos(b),y:Math.sin(a),z:Math.cos(a)*Math.sin(b)};}const q=camera(p);ctx.strokeStyle=muted+'30';if(i)ctx.lineTo(q.x,q.y);else ctx.moveTo(q.x,q.y);}ctx.stroke();
      }
      const focus=selected||(style.focusOnHover?hover:null),neighbors=new Set(focus?[focus]:[]);
      if(focus)for(const e of edges){if(relations&&!relations.has(e.type))continue;if(e.source===focus)neighbors.add(e.target);if(e.target===focus)neighbors.add(e.source);}
      const active=n=>highlight.has(n.id)||neighbors.has(n.id),visible=nodes.filter(filter);
      points=visible.map(node=>({...camera(node.p),node,radius:(active(node)?4.2:1.65)*style.nodeSize*(style.scaleNodes?Math.min(2,1+Math.sqrt(node.degree||0)*.08):1)})).sort((a,b)=>a.z-b.z);
      const visibleIds=new Set(visible.map(n=>n.id));
      for(const e of edges){
        if(!visibleIds.has(e.source)||!visibleIds.has(e.target)||(relations&&!relations.has(e.type)))continue;
        const a=by.get(e.source),b=by.get(e.target),hot=neighbors.has(a.id)&&neighbors.has(b.id)||highlight.has(a.id)&&highlight.has(b.id);
        // Honest LOD: suppress distant similarity strokes, keep every node searchable.
        if(!hot&&e.type==='topic')continue;
        ctx.lineWidth=(hot?1.35:.55)*style.linkWidth/.8;ctx.setLineDash(e.type==='mention'?[4,4]:e.type==='topic'?[1,5]:[]);
        ctx.beginPath();let previous=null;for(const v of e.path){const p=camera(v);if(p.z<(pinId?-2.1:-.25)){previous=null;continue;}if(previous)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);previous=p;}
        ctx.strokeStyle=hot?accent+'ad':e.type==='manual'?accent+'40':muted+'30';ctx.stroke();
      }
      ctx.setLineDash([]);
      for(const p of points){const n=p.node,hot=active(n),dim=(focus||highlight.size)&&!hot;
        ctx.globalAlpha=(Math.max(.18,Math.min(1,.18+.82*(p.z+1)/2)))*(dim?.16:1);
        const r=p.radius*p.k,st=states.get(n.id),c=st==='failed'?'#ffab91':st==='done'?'#c8efd2':st==='running'?'#ffe0a0':n.color;
        if(hot){ctx.shadowBlur=15;ctx.shadowColor=c;}
        ctx.fillStyle=c;ctx.beginPath();ctx.arc(p.x,p.y,r,0,TAU);ctx.fill();ctx.shadowBlur=0;
        if(n.generation>0||st||n.id===selected){ctx.lineWidth=n.id===selected?1.5:1;ctx.strokeStyle=st?c:accent;ctx.beginPath();ctx.arc(p.x,p.y,r+3,0,TAU);ctx.stroke();}
      }
      ctx.globalAlpha=1;
      if(showLabels){const occupied=[];let count=0;
        const candidates=[...points].filter(p=>p.z>(pinId?-2.1:0)&&(active(p.node)||zoom>style.labelThreshold+.4)).sort((a,b)=>Number(active(b.node))-Number(active(a.node))||b.z-a.z);
        // Domain labels derive from real catalogue membership; no invented capability nodes.
        if(!focus&&!highlight.size&&zoom<=style.labelThreshold+.4){const domains=new Map();for(const p of points)if(p.z>.2&&(!domains.has(p.node.domain)||p.z>domains.get(p.node.domain).z))domains.set(p.node.domain,p);for(const p of domains.values())candidates.push({...p,domainLabel:true});}
        for(const p of candidates){if(count>=14)break;const label=p.domainLabel?p.node.domain:(p.node.name||p.node.id).slice(0,38),x=p.x+8,y=p.y-8;ctx.font='11px Microsoft YaHei,sans-serif';const rect={x,y:y-13,w:ctx.measureText(label).width+8,h:19};if(x+rect.w>w-8||x<8||y<20||y>h-28||occupied.some(a=>rect.x<a.x+a.w&&rect.x+rect.w>a.x&&rect.y<a.y+a.h&&rect.y+rect.h>a.y))continue;occupied.push(rect);count++;ctx.fillStyle=p.domainLabel?muted:themeColor('--ink','#e4e4e7');ctx.fillText(label,x,y);}
      }
    }
    function resize(){const r=canvas.getBoundingClientRect(),dpr=Math.min(2,root.devicePixelRatio||1);w=r.width;h=r.height;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);schedule();}
    function coords(ev){const r=canvas.getBoundingClientRect();return {x:ev.clientX-r.left,y:ev.clientY-r.top};}
    listen(canvas,'pointerdown',e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:0};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';});
    listen(canvas,'pointermove',e=>{if(drag&&e.pointerId===drag.id){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved+=Math.abs(dx)+Math.abs(dy);if(drag.moved>5)interruptCamera();yaw+=dx*.006;pitch=Math.max(-1.4,Math.min(1.4,pitch+dy*.006));drag.x=e.clientX;drag.y=e.clientY;schedule();return;}const p=coords(e),node=hit(points,p.x,p.y,pinId?-2.1:-.15);hover=node?.id||null;canvas.style.cursor=node?'pointer':'grab';options.onHover?.(node,p);schedule();});
    function release(e){
      if(!drag||e.pointerId!==drag.id)return;
      const moved=drag.moved;drag=null;canvas.style.cursor='grab';
      if(e.type==='pointerup'&&moved<5){
        const p=coords(e),node=hit(points,p.x,p.y,pinId?-2.1:-.15);
        if(!node){cancelClick();options.onSelect?.(null);}
        else if(pendingClick&&pendingClick.id===node.id&&Math.hypot(p.x-pendingClick.x,p.y-pendingClick.y)<12){
          cancelClick();options.onDoubleSelect?.(node);
        }else{
          cancelClick();pendingClick={id:node.id,x:p.x,y:p.y};
          // Wait briefly so a double-click does not first move the node or toggle it off.
          clickTimer=setTimeout(()=>{cancelClick();options.onSelect?.(node);},350);
        }
      }else cancelClick();
      schedule();
    }
    listen(canvas,'pointerup',release);listen(canvas,'pointercancel',release);listen(canvas,'lostpointercapture',release);
    listen(canvas,'pointerleave',()=>{hover=null;options.onHover?.(null);schedule();});
    listen(canvas,'wheel',e=>{if(options.wheel===false)return;e.preventDefault();interruptCamera();zoom=Math.max(.65,Math.min(2.8,zoom*Math.exp(-e.deltaY*.001)));schedule();},{passive:false});
    listen(canvas,'keydown',e=>{if(e.target!==canvas)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home',' '].includes(e.key)){e.preventDefault();interruptCamera();if(e.key==='Home'){yaw=.25;pitch=-.2;zoom=1;}else if(e.key===' '){setPaused(!paused);}else if(e.key==='+')zoom=Math.min(2.8,zoom*1.2);else if(e.key==='-')zoom=Math.max(.65,zoom/1.2);else if(e.key==='ArrowLeft')yaw-=.15;else if(e.key==='ArrowRight')yaw+=.15;else if(e.key==='ArrowUp')pitch=Math.max(-1.4,pitch-.15);else pitch=Math.min(1.4,pitch+.15);schedule();}});
    listen(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else{last=0;schedule();}});
    listen(media,'change',()=>{if(media.matches)setPaused(true);schedule();});
    const ro=new ResizeObserver(resize);ro.observe(canvas);
    const io=new IntersectionObserver(es=>{inView=es[0].isIntersecting;if(!inView){cancelAnimationFrame(raf);raf=0;}else{last=0;schedule();}},{threshold:.01});io.observe(canvas);
    resize();
    return {
      setData(data){nodes=layout(data.nodes||[]);by=new Map(nodes.map(n=>[n.id,n]));edges=(data.edges||[]).filter(e=>by.has(e.source)&&by.has(e.target)).map(e=>({...e,path:Array.from({length:17},(_,i)=>arc(by.get(e.source).p,by.get(e.target).p,i/16))}));schedule();},
      appearance(value){style={...style,...value};schedule();},
      setColors(values){for(const [id,c] of values){const n=by.get(id);if(n)n.color=c;}schedule();},
      setFilter(fn,types){filter=fn||(()=>true);relations=types||null;schedule();},
      highlight(ids){highlight=new Set(ids||[]);schedule();},
      states(values){states=new Map(values||[]);schedule();},
      position(id){const n=by.get(id);return n?camera(n.p):null;},
      geometry(settle=false){
        resize();
        if(settle&&cameraTween){({yaw,pitch,zoom,anchorMix}=cameraTween.to);cameraTween=null;}
        const focus=selected||(style.focusOnHover?hover:null),neighbors=new Set(focus?[focus]:[]);
        if(focus)for(const e of edges){if(e.source===focus)neighbors.add(e.target);if(e.target===focus)neighbors.add(e.source);}
        const visible=nodes.filter(filter),ids=new Set(visible.map(n=>n.id));
        return {sphere:1,nodes:visible.map(n=>{
          const p=camera(n.p),hot=neighbors.has(n.id)||highlight.has(n.id);
          return {id:n.id,name:n.name,x:p.x,y:p.y,radius:(hot?4.2:1.65)*style.nodeSize*(style.scaleNodes?Math.min(2,1+Math.sqrt(n.degree||0)*.08):1)*p.k,
            color:n.color,alpha:Math.max(.18,Math.min(1,.18+.82*(p.z+1)/2))*((focus||highlight.size)&&!hot?.16:1),selected:n.id===selected,
            labelX:p.x+8,labelY:p.y-8,labelAlign:0,labelSize:11,labelFamily:'Microsoft YaHei,sans-serif',
            labelAlpha:showLabels&&(hot||zoom>style.labelThreshold+.4)?1:0};
        }),edges:edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(e=>{
          const hot=neighbors.has(e.source)&&neighbors.has(e.target)||highlight.has(e.source)&&highlight.has(e.target);
          return {id:[e.source,e.target].sort().join(':'),kind:e.type,color:themeColor(hot||e.type==='manual'?'--accent':'--muted','#a1a1aa'),
            width:(hot?1.35:.55)*style.linkWidth/.8,alpha:e.type==='topic'&&!hot?0:hot?.68:e.type==='manual'?.125:.102,
            path:e.path.map(v=>{const p=camera(v);return {x:p.x,y:p.y,alpha:p.z<(pinId?-2.1:-.25)?0:1};})};
        })};
      },
      local,
      select(id){selected=by.has(id)?id:null;if(!selected){hover=null;highlight.clear();options.onHover?.(null);if(pinId&&!localId){pinId=null;moveCamera({... (globalCamera||{yaw,pitch,zoom:1}),anchorMix:0});globalCamera=null;}}schedule();},
      focus(id){const n=by.get(id);if(!n||localId)return;const p=n.p;if(!globalCamera)globalCamera={yaw,pitch,zoom};anchor={...p};pinId=id;selected=id;moveCamera({yaw:yaw+Math.atan2(Math.sin(Math.atan2(-p.x,p.z)-yaw),Math.cos(Math.atan2(-p.x,p.z)-yaw)),pitch:Math.atan2(p.y,Math.hypot(p.x,p.z)),zoom,anchorMix:1});},
      zoom(factor){zoom=Math.max(.65,Math.min(2.8,zoom*factor));schedule();},
      pause(value){setPaused(value===undefined?!paused:value);schedule();return paused;},
      labels(value){showLabels=value;schedule();},
      enable(value){enabled=value;if(!value){cancelClick();cancelAnimationFrame(raf);raf=0;}else schedule();},
      reset(){localId=null;pinId=null;anchorMix=0;cameraTween=null;globalCamera=null;yaw=.25;pitch=-.2;zoom=1;selected=null;hover=null;highlight.clear();states.clear();schedule();},
      destroy(){destroyed=true;cancelClick();cancelAnimationFrame(raf);ro.disconnect();io.disconnect();cleanups.forEach(fn=>fn());},
      snapshot(){return {nodes:nodes.length,edges:edges.length,visible:nodes.filter(filter).length,paused,enabled};}
    };
  }
  const api={create,layout,rotate,project,arc,hit,color};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SkillSphere=api;
})(typeof window==='undefined'?globalThis:window);
