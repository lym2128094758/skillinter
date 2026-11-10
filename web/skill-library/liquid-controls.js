(() => {
  'use strict';
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const maxOverflow=20; // Maximum distance the lens edge can extend past the capsule, in pixels.
  for(const group of document.querySelectorAll('.view-switch')){
    const buttons=[...group.querySelectorAll('.view-button')];
    const lens=document.createElement('span');lens.className='view-lens';lens.setAttribute('aria-hidden','true');group.prepend(lens);
    let motion=null,drag=null,x=0,ready=false,suppressUntil=0;
    const transform=(position,sx=1,sy=1)=>{
      sx=Math.max(.96,Math.min(1.06,sx));sy=Math.max(.96,Math.min(1.08,sy));
      const width=parseFloat(lens.style.width)||buttons[0].offsetWidth,extra=width*(sx-1)/2;
      const left=-group.clientLeft-maxOverflow;
      const right=group.offsetWidth-group.clientLeft+maxOverflow;
      const bounded=Math.max(left+extra,Math.min(right-width-extra,position));
      return `translate3d(${bounded}px,0,0) scale(${sx},${sy})`;
    };
    function currentX(){
      const value=getComputedStyle(lens).transform;
      return value==='none'?x:new DOMMatrixReadOnly(value).m41;
    }
    function place(button,animate=true){
      const start=ready?currentX():button.offsetLeft,target=button.offsetLeft,direction=Math.sign(target-start);
      motion?.cancel();lens.style.width=button.offsetWidth+'px';lens.style.transform=transform(target);x=target;
      if(ready&&animate&&!reduced.matches&&Math.abs(target-start)>.5){
        motion=lens.animate([
          {transform:transform(start,1.06,1.04)},
          {transform:transform(target+direction*3,1.12,1.08),offset:.55},
          {transform:transform(target-direction, .98,.99),offset:.8},
          {transform:transform(target)}
        ],{duration:520,easing:'cubic-bezier(.2,.7,.2,1)'});
      }
      ready=true;
    }
    function sync(animate=true){if(!drag)place(buttons.find(b=>b.classList.contains('active'))||buttons[0],animate);}
    group.addEventListener('pointerdown',e=>{
      if(e.button!==0||e.target.closest('button')?.disabled)return;
      const position=currentX();motion?.cancel();lens.style.transform=transform(position);
      suppressUntil=0;
      drag={id:e.pointerId,start:e.clientX,last:e.clientX,origin:position,moved:false,from:buttons.find(b=>b.classList.contains('active'))||buttons[0]};
    });
    group.addEventListener('pointermove',e=>{
      if(!drag||e.pointerId!==drag.id)return;
      const delta=e.clientX-drag.start;
      if(!drag.moved&&Math.abs(delta)<4)return;
      if(!drag.moved){
        drag.moved=true;group.setPointerCapture(e.pointerId);group.classList.add('is-dragging');
      }
      e.preventDefault();
      const min=buttons[0].offsetLeft,max=buttons.at(-1).offsetLeft;
      const target=drag.origin+delta,clamped=Math.max(min,Math.min(max,target));
      const elasticTravel=buttons[0].offsetLeft+group.clientLeft+maxOverflow;
      x=clamped+elasticTravel*Math.tanh((target-clamped)/36);
      const stretch=reduced.matches?1:1.01+Math.min(.03,Math.abs(e.clientX-drag.last)*.004);
      lens.style.transform=transform(x,stretch,reduced.matches?1:1.06);drag.last=e.clientX;
      const destination=buttons.find(b=>b!==drag.from);
      const progress=Math.abs((clamped-drag.from.offsetLeft)/(destination.offsetLeft-drag.from.offsetLeft));
      if(!destination.disabled&&progress>=.7){
        // Rearm from the newly reached side: crossing back to 30% triggers the reverse switch.
        drag.from=destination;destination.click();
      }
    });
    function release(e){
      if(!drag||e.pointerId!==drag.id)return;
      const {moved}=drag;drag=null;group.classList.remove('is-dragging');
      if(group.hasPointerCapture(e.pointerId))group.releasePointerCapture(e.pointerId);
      if(moved){
        suppressUntil=performance.now()+400;
        sync();
      }else sync(false);
    }
    group.addEventListener('pointerup',release);group.addEventListener('pointercancel',release);
    group.addEventListener('lostpointercapture',e=>{if(drag)release(e);});
    group.addEventListener('pointerleave',()=>{if(drag&&!drag.moved){drag=null;sync(false);}});
    group.addEventListener('click',e=>{if(e.isTrusted&&performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
    new MutationObserver(()=>sync()).observe(group,{subtree:true,attributes:true,attributeFilter:['class','disabled']});
    new ResizeObserver(()=>sync(false)).observe(group);
    sync(false);
  }
})();
