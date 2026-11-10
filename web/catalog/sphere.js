/* Real catalogue nodes on a deterministic unit sphere. Coordinates are a visual
   index, never a learned capability metric. No synthetic relation edges. */
(function(root){
  'use strict';
  const TAU=Math.PI*2, GOLD=Math.PI*(3-Math.sqrt(5));
  const palette=['#98e6cf','#8bc9ee','#dfc18c','#b7a9e7','#79d1d4','#deab99','#b8d494'];
  const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;};
  const color=d=>palette[hash(d)%palette.length];
  function layout(nodes){
    const sorted=[...nodes].sort((a,b)=>String(a.domain||'').localeCompare(String(b.domain||''))||String(a.id).localeCompare(String(b.id)));
    // Equal area spiral; contiguous domain bands retain a readable visual order.
    return sorted.map((n,i)=>{const y=1-2*(i+.5)/sorted.length,r=Math.sqrt(1-y*y),a=i*GOLD;return {...n,p:{x:Math.cos(a)*r,y,z:Math.sin(a)*r},color:color(n.domain)};});
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
  function hit(points,x,y){
    return [...points].filter(p=>p.z>-.15&&Math.hypot(p.x-x,p.y-y)<Math.max(9,p.radius+4))
      .sort((a,b)=>b.z-a.z||Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0]?.node||null;
  }
  function create(canvas,options={}){
    const ctx=canvas.getContext('2d'),media=matchMedia('(prefers-reduced-motion: reduce)');
    let nodes=[],edges=[],by=new Map(),points=[],w=0,h=0,yaw=.25,pitch=-.2,zoom=1,lastPaint=0;
    let selected=null,hover=null,highlight=new Set(),states=new Map(),filter=()=>true,relations=null,strictHighlight=false;
    let paused=media.matches,enabled=true,inView=true,raf=0,last=0,drag=null,showLabels=true,destroyed=false;
    const cleanups=[],listen=(el,type,fn,opts)=>{el.addEventListener(type,fn,opts);cleanups.push(()=>el.removeEventListener(type,fn,opts));};
    function setPaused(value){paused=!!value;options.onPause?.(paused);return paused;}
    function camera(p){return project(rotate(p,yaw,pitch),w,h,zoom,options.center?.(w,h));}
    function schedule(){if(!destroyed&&!raf&&enabled&&inView&&!document.hidden)raf=requestAnimationFrame(frame);}
    function frame(now){raf=0;if(!paused&&now-lastPaint<30){schedule();return;}const dt=Math.min(.05,(now-last)/1000||0);last=lastPaint=now;if(!paused&&!drag&&!hover)yaw+=dt*.065;draw();if(!paused)schedule();}
    function draw(){
      const dpr=Math.min(2,root.devicePixelRatio||1);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!enabled||!w||!h)return;
      const center=options.center?.(w,h)||{x:w/2,y:h/2},radius=Math.min(w,h)*.36*zoom;
      const glow=ctx.createRadialGradient(center.x,center.y,radius*.55,center.x,center.y,radius*1.5);
      glow.addColorStop(0,'#67cbb507');glow.addColorStop(.65,'#7ed5ce16');glow.addColorStop(1,'#67cbb500');
      ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
      // Three spherical meridians + latitude lines supply depth even in sparse task views.
      ctx.lineWidth=.7;ctx.setLineDash([]);
      for(let ring=0;ring<7;ring++){
        ctx.beginPath();for(let i=0;i<=100;i++){const a=i/100*TAU;let p;if(ring<4){const lat=(ring-1.5)*.43,r=Math.sqrt(1-lat*lat);p={x:r*Math.cos(a),y:lat,z:r*Math.sin(a)};}else{const b=(ring-4)*Math.PI/3;p={x:Math.cos(a)*Math.cos(b),y:Math.sin(a),z:Math.cos(a)*Math.sin(b)};}const q=camera(p);ctx.strokeStyle='#88c9c51c';if(i)ctx.lineTo(q.x,q.y);else ctx.moveTo(q.x,q.y);}ctx.stroke();
      }
      const focus=strictHighlight?null:selected||hover,neighbors=new Set(focus?[focus]:[]);
      if(focus)for(const e of edges){if(relations&&!relations.has(e.type))continue;if(e.source===focus)neighbors.add(e.target);if(e.target===focus)neighbors.add(e.source);}
      const active=n=>highlight.has(n.id)||neighbors.has(n.id),visible=nodes.filter(filter);
      points=visible.map(node=>({...camera(node.p),node,radius:active(node)?4.2:1.65})).sort((a,b)=>a.z-b.z);
      const visibleIds=new Set(visible.map(n=>n.id));
      for(const e of edges){
        if(!visibleIds.has(e.source)||!visibleIds.has(e.target)||(relations&&!relations.has(e.type)))continue;
        const a=by.get(e.source),b=by.get(e.target),hot=neighbors.has(a.id)&&neighbors.has(b.id)||highlight.has(a.id)&&highlight.has(b.id);
        // Honest LOD: suppress distant similarity strokes, keep every node searchable.
        if(!hot&&e.type==='similar_to')continue;
        ctx.lineWidth=hot?1.35:.55;ctx.setLineDash(e.type==='compose_with'?[4,4]:e.type==='similar_to'?[1,5]:[]);
        ctx.beginPath();let previous=null;for(const v of e.path){const p=camera(v);if(p.z<-.25){previous=null;continue;}if(previous)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);previous=p;}
        ctx.strokeStyle=hot?'#b9efcdad':e.type==='depend_on'?'#86d8bb20':'#8bbce51a';ctx.stroke();
      }
      ctx.setLineDash([]);
      for(const p of points){const n=p.node,hot=active(n),dim=(focus||highlight.size)&&!hot;
        ctx.globalAlpha=(.18+.82*(p.z+1)/2)*(dim?.16:1);
        const r=p.radius*p.k,st=states.get(n.id),c=st==='failed'?'#ffab91':st==='done'?'#c8efd2':st==='running'?'#ffe0a0':n.color;
        if(hot){ctx.shadowBlur=15;ctx.shadowColor=c;}
        ctx.fillStyle=c;ctx.beginPath();ctx.arc(p.x,p.y,r,0,TAU);ctx.fill();ctx.shadowBlur=0;
        if((!strictHighlight||hot)&&(n.generation>0||st||n.id===selected)){ctx.lineWidth=n.id===selected?1.5:1;ctx.strokeStyle=st?c:'#ddbc87';ctx.beginPath();ctx.arc(p.x,p.y,r+3,0,TAU);ctx.stroke();}
      }
      ctx.globalAlpha=1;
      if(showLabels){const occupied=[];let count=0;
        const candidates=[...points].filter(p=>p.z>0&&(active(p.node)||(!strictHighlight&&zoom>1.5))).sort((a,b)=>Number(active(b.node))-Number(active(a.node))||b.z-a.z);
        // Domain labels derive from real catalogue membership; no invented capability nodes.
        if(!strictHighlight&&!focus&&!highlight.size&&zoom<1.5){const domains=new Map();for(const p of points)if(p.z>.2&&(!domains.has(p.node.domain)||p.z>domains.get(p.node.domain).z))domains.set(p.node.domain,p);for(const p of domains.values())candidates.push({...p,domainLabel:true});}
        for(const p of candidates){if(count>=14)break;const label=p.domainLabel?p.node.domain:p.node.id.replace(/^gh-/,'').slice(0,38),x=p.x+8,y=p.y-8;ctx.font='11px Microsoft YaHei,sans-serif';const rect={x,y:y-13,w:ctx.measureText(label).width+8,h:19};if(x+rect.w>w-8||x<8||y<20||y>h-28||occupied.some(a=>rect.x<a.x+a.w&&rect.x+rect.w>a.x&&rect.y<a.y+a.h&&rect.y+rect.h>a.y))continue;occupied.push(rect);count++;ctx.fillStyle='#092330df';ctx.fillRect(rect.x-3,rect.y,rect.w,rect.h);ctx.fillStyle=p.domainLabel?'#a4c7c5':'#e0f5e8';ctx.fillText(label,x,y);}
      }
    }
    function resize(){const r=canvas.getBoundingClientRect(),dpr=Math.min(2,root.devicePixelRatio||1);w=r.width;h=r.height;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);schedule();}
    function coords(ev){const r=canvas.getBoundingClientRect();return {x:ev.clientX-r.left,y:ev.clientY-r.top};}
    listen(canvas,'pointerdown',e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:0};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';});
    listen(canvas,'pointermove',e=>{if(drag&&e.pointerId===drag.id){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved+=Math.abs(dx)+Math.abs(dy);yaw+=dx*.006;pitch=Math.max(-1.4,Math.min(1.4,pitch+dy*.006));drag.x=e.clientX;drag.y=e.clientY;schedule();return;}const p=coords(e),node=hit(points,p.x,p.y);hover=node?.id||null;canvas.style.cursor=node?'pointer':'grab';options.onHover?.(node,p);schedule();});
    function release(e){if(!drag||e.pointerId!==drag.id)return;const moved=drag.moved;drag=null;canvas.style.cursor='grab';if(e.type==='pointerup'&&moved<5){const p=coords(e);options.onSelect?.(hit(points,p.x,p.y));}schedule();}
    listen(canvas,'pointerup',release);listen(canvas,'pointercancel',release);listen(canvas,'lostpointercapture',release);
    listen(canvas,'pointerleave',()=>{hover=null;options.onHover?.(null);schedule();});
    listen(canvas,'wheel',e=>{if(options.wheel===false)return;e.preventDefault();zoom=Math.max(.65,Math.min(2.8,zoom*Math.exp(-e.deltaY*.001)));schedule();},{passive:false});
    listen(canvas,'keydown',e=>{if(e.target!==canvas)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home',' '].includes(e.key)){e.preventDefault();if(e.key==='Home'){yaw=.25;pitch=-.2;zoom=1;}else if(e.key===' '){setPaused(!paused);}else if(e.key==='+')zoom=Math.min(2.8,zoom*1.2);else if(e.key==='-')zoom=Math.max(.65,zoom/1.2);else if(e.key==='ArrowLeft')yaw-=.15;else if(e.key==='ArrowRight')yaw+=.15;else if(e.key==='ArrowUp')pitch=Math.max(-1.4,pitch-.15);else pitch=Math.min(1.4,pitch+.15);schedule();}});
    listen(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else{last=0;schedule();}});
    listen(media,'change',()=>{if(media.matches)setPaused(true);schedule();});
    const ro=new ResizeObserver(resize);ro.observe(canvas);
    const io=new IntersectionObserver(es=>{inView=es[0].isIntersecting;if(!inView){cancelAnimationFrame(raf);raf=0;}else{last=0;schedule();}},{threshold:.01});io.observe(canvas);
    resize();
    return {
      setData(data){nodes=layout(data.nodes||[]);by=new Map(nodes.map(n=>[n.id,n]));edges=(data.edges||[]).filter(e=>by.has(e.source)&&by.has(e.target)).map(e=>({...e,path:Array.from({length:17},(_,i)=>arc(by.get(e.source).p,by.get(e.target).p,i/16))}));schedule();},
      setFilter(fn,types){filter=fn||(()=>true);relations=types||null;schedule();},
      highlight(ids,only=false){highlight=new Set(ids||[]);strictHighlight=only;schedule();},
      states(values){states=new Map(values||[]);schedule();},
      position(id){const n=by.get(id);return n?camera(n.p):null;},
      select(id){selected=by.has(id)?id:null;schedule();},
      focus(id){const n=by.get(id);if(!n)return;const p=n.p;yaw=Math.atan2(-p.x,p.z);pitch=Math.atan2(p.y,Math.hypot(p.x,p.z));setPaused(true);selected=id;schedule();},
      zoom(factor){zoom=Math.max(.65,Math.min(2.8,zoom*factor));schedule();},
      pause(value){setPaused(value===undefined?!paused:value);schedule();return paused;},
      labels(value){showLabels=value;schedule();},
      enable(value){enabled=value;if(!value){cancelAnimationFrame(raf);raf=0;}else schedule();},
      reset(){yaw=.25;pitch=-.2;zoom=1;selected=null;hover=null;strictHighlight=false;highlight.clear();states.clear();schedule();},
      destroy(){destroyed=true;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();cleanups.forEach(fn=>fn());},
      snapshot(){return {nodes:nodes.length,edges:edges.length,visible:nodes.filter(filter).length,paused,enabled,highlighted:[...highlight]};}
    };
  }
  const api={create,layout,rotate,project,arc,hit,color};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SkillSphere=api;
})(typeof window==='undefined'?globalThis:window);
