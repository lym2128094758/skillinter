(function(root){
  'use strict';
  const mix=(a,b,t)=>a+(b-a)*t;
  function color(a,b,t){
    const rgb=c=>/^#[0-9a-f]{6}$/i.test(c)?[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)):[128,170,160];
    const x=rgb(a),y=rgb(b);return '#'+x.map((v,i)=>Math.round(mix(v,y[i],t)).toString(16).padStart(2,'0')).join('');
  }
  function interpolate(from,to,t){
    const blend=(key,fn)=>{
      const a=new Map(from[key].map(n=>[n.id,n])),b=new Map(to[key].map(n=>[n.id,n]));
      return [...new Set([...a.keys(),...b.keys()])].map(id=>{
        const start=a.get(id),end=b.get(id),x=start||{...end,alpha:0},y=end||{...start,alpha:0};
        return {...fn(x,y),id,alpha:mix(x.alpha,y.alpha,t)};
      });
    };
    return {sphere:mix(from.sphere,to.sphere,t),
      nodes:blend('nodes',(a,b)=>({...b,x:mix(a.x,b.x,t),y:mix(a.y,b.y,t),radius:mix(a.radius,b.radius,t),color:color(a.color,b.color,t),labelAlpha:mix(a.labelAlpha||0,b.labelAlpha||0,t),
        labelX:mix(a.labelX??a.x+8,b.labelX??b.x+8,t),labelY:mix(a.labelY??a.y-8,b.labelY??b.y-8,t),
        labelSize:mix(a.labelSize||11,b.labelSize||11,t),labelAlign:mix(a.labelAlign||0,b.labelAlign||0,t)})),
      edges:blend('edges',(a,b)=>({...b,color:color(a.color,b.color,t),width:mix(a.width,b.width,t),path:a.path.map((p,i)=>({x:mix(p.x,b.path[i].x,t),y:mix(p.y,b.path[i].y,t),alpha:mix(p.alpha,b.path[i].alpha,t)}))}))};
  }
  function run(stage,from,to,onFinish,onReveal=()=>{},manual=false){
    const canvas=document.createElement('canvas');canvas.className='dimension-morph';canvas.setAttribute('aria-hidden','true');stage.append(canvas);
    const w=stage.clientWidth,h=stage.clientHeight,dpr=Math.min(2,root.devicePixelRatio||1),ctx=canvas.getContext('2d');
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    let raf=0,current=from,stopped=false,revealed=false,progress=0,startProgress=0,duration=Math.max(180,900*Math.abs(to.sphere-from.sphere)),start=performance.now();
    function draw(frame){
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const bg=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.max(w,h)*.7);
      const theme=root.SkillLibraryTheme, surface=theme?.color('--surface')||'#ffffff';
      bg.addColorStop(0,color(surface,theme?.color('--sphere-center')||'#f4f4f5',frame.sphere));bg.addColorStop(1,color(surface,theme?.color('--sphere-edge')||'#fafafa',frame.sphere));
      ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
      for(const e of frame.edges){
        ctx.lineWidth=e.width;ctx.strokeStyle=e.color;
        ctx.setLineDash(e.kind==='topic'?[2,4]:[]);
        for(let i=1;i<e.path.length;i++){
          const a=e.path[i-1],b=e.path[i];ctx.globalAlpha=e.alpha*Math.min(a.alpha,b.alpha);
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      for(const n of frame.nodes){
        ctx.globalAlpha=n.alpha;ctx.fillStyle=n.color;ctx.beginPath();ctx.arc(n.x,n.y,Math.max(.1,n.radius),0,Math.PI*2);ctx.fill();
        if(n.selected){ctx.strokeStyle=n.color;ctx.lineWidth=1;ctx.beginPath();ctx.arc(n.x,n.y,n.radius+3,0,Math.PI*2);ctx.stroke();}
        if(n.labelAlpha){ctx.globalAlpha=n.alpha*n.labelAlpha;ctx.font=`${n.labelSize||11}px ${n.labelFamily||'Microsoft YaHei,sans-serif'}`;ctx.fillStyle=root.SkillLibraryTheme?.color('--ink')||'#737373';ctx.fillText(n.name,(n.labelX??n.x+8)-ctx.measureText(n.name).width*(n.labelAlign||0),n.labelY??n.y-8);}
      }
      ctx.globalAlpha=1;
    }
    function frame(now){
      if(stopped)return;
      const t=Math.min(1,(now-start)/duration),e=t*t*(3-2*t);progress=startProgress+(1-startProgress)*e;current=interpolate(from,to,progress);draw(current);
      // Blend the final Canvas frame into the native SVG instead of swapping renderers abruptly.
      if(to.sphere===0&&t>=.85){
        if(!revealed){revealed=true;onReveal();}
        canvas.style.opacity=String(Math.max(0,(1-t)/.15));
      }
      if(t<1)raf=requestAnimationFrame(frame);else {stopped=true;canvas.remove();onFinish();}
    }
    draw(from);if(!manual)raf=requestAnimationFrame(frame);
    return {snapshot:()=>current,
      seek(value){if(stopped)return;cancelAnimationFrame(raf);progress=Math.max(0,Math.min(1,value));current=interpolate(from,to,progress);draw(current);},
      play(){if(stopped)return;startProgress=progress;start=performance.now();duration=Math.max(120,450*(1-progress));cancelAnimationFrame(raf);raf=requestAnimationFrame(frame);},
      cancel(){stopped=true;cancelAnimationFrame(raf);canvas.remove();}};
  }
  const api={interpolate,run};if(typeof module==='object'&&module.exports)module.exports=api;else root.SkillViewMorph=api;
})(typeof window==='undefined'?globalThis:window);
