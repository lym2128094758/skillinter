(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const requestLibrary = window.skillLibraryFetch ?? window.fetch.bind(window);
  const storage = () => window.skillLibraryStorage ?? window.localStorage;
  const model = window.SkillGraphModel;
  const palette = ["#8c9fb5","#a78baf","#bf9279","#7d9fa1","#b4a36f","#8297b3","#a88787","#7d9a81"];
  const themeColor = token => window.SkillLibraryTheme?.color(token) || "#737373";
  const defaults = {maxNodes:200,showOrphans:true,showMentions:true,showTopics:false,showManual:true,focusOnHover:true,
    showLabels:true,scaleNodes:true,colorBySource:false,showArrows:false,depth:1,labelThreshold:1.1,
    nodeSize:1,linkWidth:.8,centerForce:.04,repelForce:150,linkStrength:.35,linkDistance:90};
  let graphDimension="plane", sphere=null;
  let settings, customColors;
  function viewDefaults(){return {...defaults,colorBySource:graphDimension==="sphere"};}
  function loadSettings(){
    settings=viewDefaults();customColors={};
    try {
      const profile=JSON.parse(storage().getItem("skill-graph-profile-v3-"+graphDimension)||"null");
      const saved=profile?.settings || (graphDimension==="plane"?JSON.parse(storage().getItem("skill-graph-settings-v2")||"{}"):{});
      const colors=profile?.colors || (graphDimension==="plane"?JSON.parse(storage().getItem("skill-graph-colors-v2")||"{}"):{});
      for(const key of Object.keys(defaults)){
        if(typeof saved?.[key]===typeof defaults[key]&&(typeof saved[key]!=="number"||Number.isFinite(saved[key])))settings[key]=saved[key];
      }
      for(const [key,value] of Object.entries(colors||{}))if(/^#[0-9a-f]{6}$/i.test(value))customColors[key]=value;
    }catch{}
  }
  loadSettings();
  const state = {nodes:[],edges:[],mode:"global",selectedId:null,hoverId:null,hiddenGroups:new Set(),
    nodeCache:new Map(),listLimit:100,listNodes:[],visibleNodes:[],visibleEdges:[],degree:new Map(),adjacency:new Map(),
    colorMap:new Map(),transform:d3.zoomIdentity,connect:false,first:null,dragging:false,request:0,
    detailController:null,width:0,height:0};
  let executionIds = new Set(), executionStates = new Map(), hostEnabled = true;
  window.SkillLibraryHost = {
    selected: () => state.selectedId,
    focus(id) {
      if (!state.nodes.some(node=>node.id===id)) return;
      $("searchInput").value='';state.hiddenGroups.clear();state.mode='global';rebuild(true);
      selectNode(id);
    },
    execution(ids,states) {
      const known = new Set(state.nodes.map(node=>node.id));
      executionIds = new Set(ids.filter(id=>known.has(id)));
      executionStates = new Map(states.filter(([id])=>known.has(id)));
      if(state.nodes.length)rebuild(false);
      document.documentElement.dataset.executionIds=JSON.stringify([...executionIds]);
    },
    enable(value) {
      hostEnabled=Boolean(value);
      sphere.enable(hostEnabled&&graphDimension==='sphere');
      if (!hostEnabled) simulation.stop();
      else if (graphDimension==='plane') simulation.alpha(.1).restart();
    },
  };
  const sphereCanvas=$("sphereGraph"),sphereTip=$("sphereTooltip");
  sphere=SkillSphere.create(sphereCanvas,{wheel:true,center:(w,h)=>{
    const panel=$("detailPanel"),stage=sphereCanvas.getBoundingClientRect();
    const overlap=panel.hidden?0:Math.max(0,Math.min(stage.right,panel.getBoundingClientRect().right)-Math.max(stage.left,panel.getBoundingClientRect().left));
    return {x:Math.max(0,w-overlap)/2,y:h/2};
  },onHover:(node,point)=>{
    if(!node){sphereTip.hidden=true;return;}
    sphereTip.textContent=node.name+" · "+node.group;sphereTip.hidden=false;
    sphereTip.style.left=Math.max(12,Math.min(sphereCanvas.clientWidth-230,point.x+14))+"px";
    sphereTip.style.top=Math.max(12,Math.min(sphereCanvas.clientHeight-42,point.y+14))+"px";
  },onSelect:node=>{if(!node||node.id===state.selectedId)clearSelection();else selectNode(node.id);},
  onDoubleSelect:node=>{if(node)enterLocal(node.id);}});
  const svg = d3.select("#graph"), layer = d3.select("#zoomLayer");
  let planeGlobalView=null;
  let dimensionMorph=null,sphereMotion=null;
  function finishDimensionMorph(){
    dimensionMorph?.cancel();dimensionMorph=null;
    $("graphStage").classList.remove("dimension-morphing");
    if(sphereMotion!==null){sphere.pause(sphereMotion);sphereMotion=null;}
  }
  function planeGeometry(){
    const transform=state.transform,k=transform.k;
    const positions=new Map(state.visibleNodes.map(n=>[n.id,{x:n.x*k+transform.x,y:n.y*k+transform.y}]));
    const hex=value=>{const rgb=value.match(/[\d.]+/g);return rgb?'#'+rgb.slice(0,3).map(v=>Math.round(Number(v)).toString(16).padStart(2,'0')).join(''):value;};
    const renderedNodes=new Map(),renderedEdges=new Map();
    nodeSelection.each(function(n){renderedNodes.set(n.id,this);});
    linkSelection.each(function(e){renderedEdges.set(e.key,this);});
    return {sphere:0,nodes:state.visibleNodes.map(n=>{
      const point=positions.get(n.id),el=renderedNodes.get(n.id),core=el.querySelector('.node-core'),label=el.querySelector('text');
      const textStyle=getComputedStyle(label),coreStyle=getComputedStyle(core);
      return {...point,id:n.id,name:n.name,radius:Number(core.getAttribute('r'))*k,color:hex(coreStyle.fill),alpha:Number(getComputedStyle(el).opacity),selected:false,
        labelX:point.x,labelY:point.y+Number(label.getAttribute('dy')||0)*k,labelAlign:.5,
        labelSize:parseFloat(textStyle.fontSize)*k,labelFamily:textStyle.fontFamily,
        labelAlpha:textStyle.display==='none'?0:Number(textStyle.opacity)};
    }),
      edges:state.visibleEdges.map(e=>{
        const el=renderedEdges.get(e.key),style=getComputedStyle(el);
        const a={x:Number(el.getAttribute('x1'))*k+transform.x,y:Number(el.getAttribute('y1'))*k+transform.y};
        const b={x:Number(el.getAttribute('x2'))*k+transform.x,y:Number(el.getAttribute('y2'))*k+transform.y};
        return {id:e.key,kind:e.kind,color:hex(style.stroke),width:parseFloat(style.strokeWidth),alpha:Number(style.opacity)*Number(style.strokeOpacity),
          path:Array.from({length:17},(_,i)=>({x:a.x+(b.x-a.x)*i/16,y:a.y+(b.y-a.y)*i/16,alpha:1}))};
      })};
  }
  function rememberPlaneView(){
    if(planeGlobalView)return;
    svg.interrupt();simulation.stop();
    planeGlobalView={transform:state.transform,positions:new Map([...state.nodeCache].map(([id,n])=>[id,{x:n.x,y:n.y,vx:0,vy:0,fx:n.fx,fy:n.fy}]))};
  }
  let nodeSelection = d3.select("#nodesLayer").selectAll("g"), linkSelection = d3.select("#linksLayer").selectAll("line");
  const simulation = d3.forceSimulation().stop().velocityDecay(.4).alphaDecay(.035).on("tick", () => {
    tick();
    if (state.mode === "local" || state.transform.k > settings.labelThreshold - .3) updateLabels();
  });
  const zoom = d3.zoom().scaleExtent([.025,6]).clickDistance(4)
    .filter((event) => !event.button && (event.type === "wheel" || !event.target.closest?.(".graph-node")))
    .on("zoom", (event) => {
      state.transform = event.transform;
      layer.attr("transform", event.transform);
      tick();
      updateAppearance();
    });
  svg.call(zoom).on("dblclick.zoom", null).on("click.clear", (event) => {
    if(event.defaultPrevented||event.target.closest(".graph-node"))return;
    if(state.mode==="local"){setConnect(false);clearSelection();return;}
    state.hoverId=null;$("nodeTooltip").hidden=true;updateAppearance();
  });

  function saveSettings() {
    try {storage().setItem("skill-graph-profile-v3-"+graphDimension,JSON.stringify({settings,colors:customColors}));}catch{}
  }
  function syncControls() {
    $("settingsTitle").textContent=graphDimension==="sphere"?"球体设置":"平面设置";
    document.querySelectorAll("[data-plane-only]").forEach(el=>{el.hidden=graphDimension==="sphere";});
    for (const [key,value] of Object.entries(settings)) {
      const input = $(key==="depth"?"depthInput":key);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value;
      else if(input.tagName === "SELECT") {settings[key]=[0,100,200,500].includes(value)?value:200;input.value=String(settings[key]);}
      else {
        settings[key] = Math.max(Number(input.min), Math.min(Number(input.max), value));
        input.value = settings[key];
        if ($(key+"Output")) $(key+"Output").value = String(settings[key]);
      }
    }
  }
  function color(node) { return settings.colorBySource ? (customColors[node.group] || state.colorMap.get(node.group) || themeColor("--muted")) : themeColor("--muted"); }
  function radius(node) { return settings.nodeSize * (settings.scaleNodes ? Math.min(9,3.5+Math.sqrt(state.degree.get(node.id)||0)*.85) : 4); }
  function visibleRadius(node) { return Math.max(radius(node), 3 * settings.nodeSize / state.transform.k); }
  function options() {
    return {hiddenGroups:state.hiddenGroups,query:$("searchInput").value.trim(),mode:state.mode,selectedId:state.selectedId,
      depth:settings.depth,showOrphans:settings.showOrphans,maxNodes:settings.maxNodes,pinnedIds:[...executionIds],
      kinds:new Set([settings.showMentions&&"mention",settings.showTopics&&"topic",settings.showManual&&"manual"].filter(Boolean))};
  }
  async function loadLibrary() {
    const version = ++state.request;
    $("refreshButton").disabled = true;
    $("scanStatus").textContent = "正在扫描 Skill…";
    try {
      const response = await requestLibrary("/api/skills",{cache:"no-store"});
      if (!response.ok) throw new Error("读取失败 ("+response.status+")");
      const data = await response.json();
      if (version !== state.request) return;
      state.nodes = data.nodes; state.edges = data.edges;
      if (!state.nodes.some((n)=>n.id===state.selectedId)) { state.selectedId=null;state.mode="global";$("detailPanel").hidden=true; }
      [...new Set(state.nodes.map((n)=>n.group))].sort().forEach((group,index)=>state.colorMap.set(group,palette[index%palette.length]));
      $("skillCount").textContent = state.nodes.length;
      const discovery = data.discovery;
      const agentLabel = discovery?.agent_label;
      $("scanStatus").textContent = (agentLabel ? agentLabel+" · " : "")+"已扫描 "+state.nodes.length+" 个 Skill";
      $("scanStatus").title = discovery?.roots?.length ? discovery.roots.join("\n") : "当前宿主尚未发现 Skill 目录";
      if (discovery?.agent === "unknown" && !state.nodes.length) {
        $("scanStatus").textContent = "未识别 agent，请设置 SKILL_LIBRARY_AGENT";
      }
      buildGroups(); buildColors(); rebuild(true);
      window.dispatchEvent(new Event('sih-skill-graph-ready'));
    } catch (error) { $("scanStatus").textContent=error.message; $("graphSummary").textContent="扫描失败，点击刷新重试"; }
    finally { if (version === state.request) $("refreshButton").disabled=false; }
  }
  function buildGroups() {
    const groups = new Map();
    state.nodes.forEach((n)=>groups.set(n.group,(groups.get(n.group)||0)+1));
    $("groupsList").replaceChildren();
    for (const [group,count] of [...groups].sort((a,b)=>a[0].localeCompare(b[0],"zh-CN"))) {
      const label=document.createElement("label");label.className="group-item";
      const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.checked=!state.hiddenGroups.has(group);checkbox.setAttribute("aria-label","显示"+group);
      checkbox.addEventListener("change",()=>{ if(checkbox.checked)state.hiddenGroups.delete(group);else state.hiddenGroups.add(group);rebuild(true); });
      const dot=document.createElement("span");dot.className="group-color";dot.style.background=customColors[group]||state.colorMap.get(group);
      const title=document.createElement("span");title.className="group-label";title.textContent=group;
      const num=document.createElement("span");num.className="group-num";num.textContent=count;
      label.append(checkbox,dot,title,num);$("groupsList").append(label);
    }
  }
  function buildColors() {
    $("colorGroups").replaceChildren();
    for(const group of state.colorMap.keys()){
      const row=document.createElement("label");row.className="setting-row";
      const title=document.createElement("span");title.textContent=group;
      const input=document.createElement("input");input.type="color";input.value=customColors[group]||state.colorMap.get(group);input.setAttribute("aria-label",group+"颜色");
      input.addEventListener("input",()=>{customColors[group]=input.value;settings.colorBySource=true;$("colorBySource").checked=true;updateAppearance();saveSettings();buildGroups();});
      row.append(title,input);$("colorGroups").append(row);
    }
  }
  function buildSkillList() {
    $("skillList").replaceChildren();
    const list=[...state.listNodes].sort((a,b)=>a.name.localeCompare(b.name));
    for(const node of list.slice(0,state.listLimit)){
      const button=document.createElement("button");button.className="skill-list-item";button.textContent=node.name;button.title=node.source+" · "+node.path;
      button.setAttribute("aria-pressed",node.id===state.selectedId);
      button.addEventListener("click",()=>selectNode(node.id));
      $("skillList").append(button);
    }
    if(list.length>state.listLimit){
      const more=document.createElement('button');more.className='skill-list-item list-more';more.textContent='再显示 100 项（还有 '+(list.length-state.listLimit)+' 项）';
      more.onclick=()=>{state.listLimit+=100;buildSkillList();};$('skillList').append(more);
    }
  }
  function syncHeader() {
    const local=state.mode==="local";
    for(const id of ["globalTab","globalViewButton"]) $(id).classList.toggle("active",!local);
    for(const id of ["localTab","localViewButton"]) {$(id).classList.toggle("active",local);$(id).disabled=!state.selectedId;}
    $("globalTab").setAttribute("aria-selected",!local);$("localTab").setAttribute("aria-selected",local);
    $("graphSummary").textContent=state.visibleNodes.length+" / "+state.listNodes.length+" 个节点 · "+state.visibleEdges.length+" 条关系";
    $("activeFilter").textContent=local?"深度 "+settings.depth:settings.showTopics?"包含推测主题关联":"正文提及与自定义关联";
    $("emptyState").hidden=state.visibleNodes.length>0;
    $("emptyState").querySelector("h3").textContent=state.nodes.length?"没有符合条件的 Skill":"还没有找到 Skill";
    $("emptyState").querySelector("p").textContent=local?"当前 Skill 被筛选条件排除。清除筛选或返回全局图。":"调整搜索词或来源筛选。";
    if(graphDimension==="sphere"&&sphere){
      const catalogue=model.filterGraph(state.nodes,state.edges,{...options(),mode:"global",pinnedIds:[...executionIds,...state.visibleNodes.map(node=>node.id)]});
      sphere.setData({nodes:catalogue.nodes.map(n=>({...n,domain:n.group,degree:catalogue.degree.get(n.id)||0,color:colorMapSphere(n)})),
        edges:catalogue.edges.map(e=>({source:e.source,target:e.target,type:e.kind}))});
      const visibleIds=new Set(state.visibleNodes.map(n=>n.id));
      sphere.setFilter(n=>visibleIds.has(n.id));
      sphere.select(state.selectedId);sphere.highlight(state.hoverId?[state.hoverId]:[]);
      sphere.local(local?state.selectedId:null);
      syncSphereAppearance();
    }
  }
  function colorMapSphere(node){return settings.colorBySource?(customColors[node.group]||state.colorMap.get(node.group)||themeColor("--accent")):themeColor("--accent");}
  function syncSphereAppearance(){
    sphere.appearance(settings);
    sphere.labels(settings.showLabels);
    sphere.setColors(state.visibleNodes.map(n=>[n.id,colorMapSphere(n)]));
    sphere.highlight([...executionIds]);
    sphere.states([...executionStates]);
  }
  function setDimension(value){
    if(value===graphDimension)return;
    svg.interrupt();simulation.stop();
    const from=dimensionMorph?dimensionMorph.snapshot():graphDimension==="plane"?planeGeometry():sphere.geometry();
    dimensionMorph?.cancel();dimensionMorph=null;
    if(sphereMotion===null)sphereMotion=sphere.snapshot().paused;
    sphere.pause(true);
    if(value==="plane"&&state.mode==="local")rememberPlaneView();
    saveSettings();
    graphDimension=value;
    loadSettings();syncControls();buildColors();buildGroups();
    const spherical=value==="sphere";
    $("graphStage").classList.toggle("sphere-active",spherical);
    $("graph").toggleAttribute("hidden",spherical);sphereCanvas.hidden=!spherical;
    sphere.enable(hostEnabled&&spherical);sphereTip.hidden=true;$("nodeTooltip").hidden=true;
    $("planeViewButton").classList.toggle("active",!spherical);$("planeViewButton").setAttribute("aria-pressed",String(!spherical));
    $("sphereViewButton").classList.toggle("active",spherical);$("sphereViewButton").setAttribute("aria-pressed",String(spherical));
    $("graphTools").hidden=spherical;$("graphFootnote").hidden=spherical;
    setConnect(false);rebuild(false,false,true);
    if(!spherical&&state.mode==="local")fitGraph(false);
    if(spherical){if(state.selectedId)sphere.focus(state.selectedId);sphereCanvas.focus({preventScroll:true});}
    if(matchMedia("(prefers-reduced-motion: reduce)").matches){finishDimensionMorph();return;}
    const to=spherical?sphere.geometry(true):planeGeometry();
    $("graphStage").classList.add("dimension-morphing");
    dimensionMorph=SkillViewMorph.run($("graphStage"),from,to,finishDimensionMorph,()=>{
      $("graphStage").classList.remove("dimension-morphing");
    });
  }
  function rebuild(fit=false,animate=false,preserveLayout=false) {
    if(dimensionMorph)finishDimensionMorph();
    simulation.stop(); state.hoverId=null; $("nodeTooltip").hidden=true;
    const result=model.filterGraph(state.nodes,state.edges,options());
    state.degree=result.degree;state.listNodes=result.matchedNodes;
    state.width=$("graphStage").clientWidth;state.height=$("graphStage").clientHeight;
    const cx=state.width/2,cy=state.height/2;
    state.visibleNodes=result.nodes.map((node,index)=>{
      let sim=state.nodeCache.get(node.id);
      if(!sim){const angle=index*2.399963;const r=17*Math.sqrt(index);sim={x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r,vx:0,vy:0};state.nodeCache.set(node.id,sim);}
      return Object.assign(sim,node);
    });
    state.visibleEdges=result.edges.map((edge)=>({...edge,sourceId:edge.source,targetId:edge.target}));
    state.adjacency=new Map(state.visibleNodes.map((n)=>[n.id,new Set()]));
    state.visibleEdges.forEach((e)=>{state.adjacency.get(e.source).add(e.target);state.adjacency.get(e.target).add(e.source);});
    linkSelection=d3.select("#linksLayer").selectAll("line").data(state.visibleEdges,(e)=>e.key).join("line").attr("class",(e)=>"graph-link "+e.kind);
    nodeSelection=d3.select("#nodesLayer").selectAll("g.graph-node").data(state.visibleNodes,(n)=>n.id).join((enter)=>{
      const g=enter.append("g").attr("class","graph-node").attr("tabindex",0).attr("role","button");
      g.append("circle").attr("class","node-hit").attr("fill","transparent");
      g.append("circle").attr("class","node-halo");
      g.append("circle").attr("class","node-core");
      g.append("text").attr("text-anchor","middle");
      return g;
    }).attr("aria-label",(n)=>"查看 Skill "+n.name);
    nodeSelection.select("text").text((n)=>n.name);
    nodeSelection.on("pointerenter",(event,n)=>{if(!state.dragging){state.hoverId=n.id;updateAppearance();}})
      .on("pointerleave",()=>{if(!state.dragging){state.hoverId=null;updateAppearance();}})
      .on("focus",(event,n)=>{state.hoverId=n.id;updateAppearance();})
      .on("blur",()=>{state.hoverId=null;updateAppearance();})
      .on("click",(event,n)=>{event.stopPropagation();if(state.connect)connectClick(n);else selectNode(n.id);})
      .on("dblclick",(event,n)=>{event.preventDefault();event.stopPropagation();if(!state.connect)enterLocal(n.id);})
      .on("keydown",(event,n)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectNode(n.id);}});
    nodeSelection.call(d3.drag().clickDistance(4).filter((event)=>!event.button&&!state.connect)
      .on("start",(event,n)=>{
        svg.interrupt();state.dragging=true;state.hoverId=n.id;
        if(!event.active)simulation.alphaTarget(.12).restart();n.fx=n.x;n.fy=n.y;updateAppearance();
      }).on("drag",(event,n)=>{n.fx=event.x;n.fy=event.y;})
      .on("end",(event,n)=>{
        n.fx=null;n.fy=null;state.dragging=false;state.hoverId=null;
        if(!event.active)simulation.alphaTarget(0);updateAppearance();
      }));
    simulation.force("link",null).nodes(state.visibleNodes);
    configureForces(false);
    if(state.visibleNodes.length){
      const keepPositions=preserveLayout||(graphDimension==="plane"&&state.mode==="local"&&planeGlobalView);
      if(graphDimension==="plane"&&fit&&!keepPositions)simulation.alpha(.9).tick(40);
      tick();
      if(fit&&graphDimension==="plane")fitGraph(animate);
      if(graphDimension==="plane"&&!keepPositions)simulation.alpha(fit?.10:.25).restart();
    }
    syncHeader();buildSkillList();updateAppearance();
  }
  function configureForces(restart=true) {
    const cx=state.width/2,cy=state.height/2;
    simulation.force("charge",d3.forceManyBody().strength(-settings.repelForce))
      .force("x",d3.forceX(cx).strength(settings.centerForce))
      .force("y",d3.forceY(cy).strength(settings.centerForce))
      .force("collide",d3.forceCollide((n)=>radius(n)+5).iterations(2))
      .force("link",d3.forceLink(state.visibleEdges).id((n)=>n.id).distance(settings.linkDistance)
        .strength((e)=>settings.linkStrength*(e.kind==="topic"?.35:1)));
    if(restart&&graphDimension==="plane") simulation.alpha(.45).restart();
  }
  function tick() {
    linkSelection.each(function(e){
      const dx=e.target.x-e.source.x,dy=e.target.y-e.source.y,length=Math.hypot(dx,dy)||1;
      const sourceGap=Math.min(length/2,visibleRadius(e.source)+2);
      const targetGap=Math.min(length/2,visibleRadius(e.target)+2);
      d3.select(this).attr("x1",e.source.x+dx/length*sourceGap).attr("y1",e.source.y+dy/length*sourceGap)
        .attr("x2",e.target.x-dx/length*targetGap).attr("y2",e.target.y-dy/length*targetGap);
    });
    nodeSelection.attr("transform",(n)=>"translate("+n.x+","+n.y+")");
  }
  function updateAppearance() {
    if(graphDimension==="sphere")syncSphereAppearance();
    const k=state.transform.k,hover=state.hoverId;
    const neighbors=state.adjacency.get(hover)||new Set();
    nodeSelection.classed("selected",(n)=>n.id===state.selectedId)
      .classed('execution-used',n=>executionIds.has(n.id))
      .attr('data-execution-state',n=>executionStates.get(n.id)??null)
      .classed("connect-first",(n)=>n.id===state.first)
      .classed("dimmed",(n)=>!!hover&&settings.focusOnHover&&n.id!==hover&&!neighbors.has(n.id));
    nodeSelection.select(".node-hit").attr("r",(n)=>Math.max(visibleRadius(n)+3,9/k));
    nodeSelection.select(".node-core").attr("r",visibleRadius).attr("fill",color);
    nodeSelection.select(".node-halo").attr("r",(n)=>visibleRadius(n)+3.5);
    updateLabels();
    linkSelection.classed("dimmed",(e)=>!!hover&&settings.focusOnHover&&e.sourceId!==hover&&e.targetId!==hover)
      .classed("active",(e)=>!!hover&&(e.sourceId===hover||e.targetId===hover))
      .style("stroke-width",settings.linkWidth)
      .attr("marker-end",(e)=>settings.showArrows&&e.forward?"url(#arrowEnd)":null)
      .attr("marker-start",(e)=>settings.showArrows&&e.backward?"url(#arrowStart)":null);
  }
  function updateLabels() {
    const labels = nodeSelection.select("text");
    if (!settings.showLabels) { labels.style("display", "none"); return; }
    const k = state.transform.k;
    const fontSize = 12 * Math.sqrt(k);
    const fade = model.labelOpacity(k, settings.labelThreshold);
    const priority = (node) => node.id === state.hoverId ? 2 : node.id === state.selectedId ? 1 : 0;
    const ordered = state.visibleNodes.filter((node) => fade > 0 || priority(node))
      .sort((a,b) => priority(b) - priority(a) || state.degree.get(b.id) - state.degree.get(a.id));
    const boxes = [];
    const visible = new Set();
    for (const node of ordered) {
      const y = (node.y + visibleRadius(node)) * k;
      const halfWidth = Array.from(node.name).reduce((width, char) => width + (/[^\x00-\x7f]/.test(char) ? .95 : .55), 0) * fontSize / 2 + 3;
      const box = {left: node.x * k - halfWidth, right: node.x * k + halfWidth, top: y + 2, bottom: y + fontSize + 6};
      if (boxes.some((b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)) continue;
      boxes.push(box);
      visible.add(node.id);
    }
    labels.attr("dy",(node) => visibleRadius(node) + 14 / Math.sqrt(k))
      .style("font-size", (fontSize / k) + "px")
      .style("display", null)
      .style("opacity", (node) => !visible.has(node.id) ? 0 : priority(node) ? 1 : fade);
  }
  function fitGraph(animate=true) {
    if(!state.visibleNodes.length)return;
    animate=animate&&!matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stage=$("graphStage").getBoundingClientRect(),panel=$("detailPanel");
    const overlap=panel.hidden?0:Math.max(0,Math.min(stage.right,panel.getBoundingClientRect().right)-Math.max(stage.left,panel.getBoundingClientRect().left));
    const nodes=state.visibleNodes,w=Math.max(140,state.width-overlap),h=state.height;
    const x0=d3.min(nodes,(n)=>n.x),x1=d3.max(nodes,(n)=>n.x),y0=d3.min(nodes,(n)=>n.y),y1=d3.max(nodes,(n)=>n.y);
    const k=Math.max(.025,Math.min(1.7,(w-110)/Math.max(140,x1-x0+50),(h-170)/Math.max(140,y1-y0+50)));
    const transform=d3.zoomIdentity.translate(w/2-k*(x0+x1)/2,(h+25)/2-k*(y0+y1)/2).scale(k);
    svg.interrupt();(animate?svg.transition().duration(550).ease(d3.easeCubicInOut):svg).call(zoom.transform,transform);
  }
  async function selectNode(id) {
    if(!state.nodes.some((n)=>n.id===id))return;
    state.selectedId=id;state.hoverId=null;$("settingsPanel").hidden=true;$("detailPanel").hidden=false;
    if(graphDimension==="sphere"&&state.mode!=="local")sphere.focus(id);
    if(state.mode==="local"||!state.visibleNodes.some(node=>node.id===id))rebuild(true,true);
    syncHeader();updateAppearance();buildSkillList();
    const n=state.nodes.find((n)=>n.id===id);
    $("detailName").textContent=n.name;$("detailGroup").textContent=n.group;
    $("detailDescription").textContent=n.description;$("detailSource").textContent=n.source;$("detailPath").textContent=n.path;
    const ids=new Set(state.nodes.map((n)=>n.id)),edges=model.mergeEdges(state.edges,ids,options().kinds);
    const adjacent=edges.filter((e)=>e.source===id||e.target===id);
    $("detailDegree").textContent=adjacent.length;
    $("detailNeighbors").replaceChildren();
    for(const e of adjacent){
      const other=state.nodes.find((n)=>n.id===(e.source===id?e.target:e.source));
      const button=document.createElement("button");button.textContent=other.name;button.className="neighbor-button";
      button.title=e.kinds.map((kind)=>({mention:"正文提及",manual:"自定义关联",topic:"推测主题"}[kind])).join("、");
      button.addEventListener("click",()=>selectNode(other.id));$("detailNeighbors").append(button);
      if(e.kinds.includes('manual')) {
        const remove=document.createElement('button');remove.className='neighbor-button';remove.textContent='移除与 '+other.name+' 的自定义关联';
        remove.addEventListener('click',async()=>{
          try {
            const response=await requestLibrary('/api/relations',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:id,target:other.id})});
            if(!response.ok)throw Error('移除关联失败');
            await loadLibrary();await selectNode(id);
          }catch(error){$('graphSummary').textContent=error.message;}
        });
        $('detailNeighbors').append(remove);
      }
    }
    state.detailController?.abort();state.detailController=new AbortController();
    $("detailContent").textContent="正在读取 Skill 文件…";
    try {
      const response=await requestLibrary("/api/skill?id="+encodeURIComponent(id),{signal:state.detailController.signal});
      if(!response.ok)throw new Error("无法读取 Skill 文件");
      const data=await response.json();if(state.selectedId===id)$("detailContent").textContent=data.content;
    }catch(error){if(error.name!=="AbortError"&&state.selectedId===id)$("detailContent").textContent=error.message;}
  }
  function animateScope(entering){
    if(graphDimension==="plane")return;
    const stage=$("graphStage"),surface=graphDimension==="sphere"?sphereCanvas:$("graph");
    stage.querySelectorAll(".scope-ghost").forEach(el=>el.remove());
    surface.getAnimations().forEach(a=>a.cancel());
    if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    const ghost=graphDimension==="sphere"?document.createElement("img"):surface.cloneNode(true);
    if(graphDimension==="sphere")ghost.src=sphereCanvas.toDataURL();
    ghost.removeAttribute("id");ghost.querySelectorAll("[id]").forEach(el=>el.removeAttribute("id"));
    ghost.classList.add("scope-ghost");ghost.setAttribute("aria-hidden","true");stage.append(ghost);
    const direction=entering?1:-1,opts={duration:550,easing:"cubic-bezier(.22,.61,.36,1)"};
    const outgoing=ghost.animate([{opacity:1,transform:"translateX(0)"},{opacity:0,transform:`translateX(${-direction*65}px)`}],opts);
    outgoing.onfinish=()=>ghost.remove();
    surface.animate([{opacity:0,transform:`translateX(${direction*65}px)`},{opacity:1,transform:"translateX(0)"}],opts);
  }
  function enterLocal(id){
    if(!state.nodes.some(n=>n.id===id))return;
    if(graphDimension==="plane")rememberPlaneView();
    if(state.mode!=="local"||state.selectedId!==id)animateScope(true);
    state.mode="local";selectNode(id);
    $("detailPanel").hidden=graphDimension!=="plane";
  }
  function clearSelection(){
    const wasLocal=state.mode==="local";
    if(wasLocal)animateScope(false);
    const savedPlane=planeGlobalView;
    if(wasLocal&&savedPlane){
      for(const [id,position] of savedPlane.positions){const node=state.nodeCache.get(id);if(node)Object.assign(node,position);}
    }
    state.detailController?.abort();state.selectedId=null;state.hoverId=null;state.mode="global";
    $("detailPanel").hidden=true;sphereTip.hidden=true;$("nodeTooltip").hidden=true;
    sphere.select(null);sphere.highlight([]);rebuild(wasLocal&&!savedPlane,wasLocal,!!savedPlane);
    if(wasLocal&&savedPlane){
      planeGlobalView=null;
      svg.interrupt();
      const animate=graphDimension==="plane"&&!matchMedia("(prefers-reduced-motion: reduce)").matches;
      (animate?svg.transition().duration(550).ease(d3.easeCubicInOut):svg).call(zoom.transform,savedPlane.transform);
    }
  }
  function setMode(mode) {
    if(mode==="global"){clearSelection();return;}
    if(state.selectedId)enterLocal(state.selectedId);
  }
  function setConnect(active) {
    state.connect=active;state.first=null;$("connectHint").hidden=!active;
    $("connectHint").firstChild.textContent="依次点击两个节点来建立关联 ";
    $("addRelation").classList.toggle("active",active);updateAppearance();
  }
  async function connectClick(n) {
    if(!state.first){state.first=n.id;$("connectHint").firstChild.textContent="已选「"+n.name+"」，再点击另一个 Skill ";updateAppearance();return;}
    if(state.first===n.id){setConnect(false);return;}
    try{
      const response=await requestLibrary("/api/relations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:state.first,target:n.id})});
      if(!response.ok)throw new Error("保存关联失败");
      setConnect(false);await loadLibrary();
    }catch(error){$("graphSummary").textContent=error.message;}
  }
  function zoomBy(factor){svg.interrupt().transition().duration(160).call(zoom.scaleBy,factor);}
  $("refreshButton").addEventListener("click",loadLibrary);
  $("settingsButton").addEventListener("click",()=>{$("settingsPanel").hidden=!$("settingsPanel").hidden;$("detailPanel").hidden=true;});
  $("closeSettings").addEventListener("click",()=>{$("settingsPanel").hidden=true;});
  $("closeDetail").addEventListener("click",()=>{
    $("detailPanel").hidden=true;
    if(graphDimension==="plane"&&state.mode==="local")fitGraph(true);
  });
  $("resetSettings").addEventListener("click",()=>{settings=viewDefaults();customColors={};syncControls();saveSettings();buildColors();buildGroups();rebuild(true);});
  let searchTimer;
  $("searchInput").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.listLimit=100;rebuild(true);},150);});
  $("searchInput").title='支持 name:、path:、source:、"短语" 和 -排除词';
  for(const id of ["globalTab","globalViewButton"])$(id).addEventListener("click",()=>setMode("global"));
  for(const id of ["localTab","localViewButton"])$(id).addEventListener("click",()=>setMode("local"));
  $("planeViewButton").addEventListener("click",()=>setDimension("plane"));
  $("sphereViewButton").addEventListener("click",()=>setDimension("sphere"));
  $("showLocalButton").addEventListener("click",()=>{$("detailPanel").hidden=true;setMode("local");});
  $("clearFilters").addEventListener("click",()=>{state.hiddenGroups.clear();$("searchInput").value="";buildGroups();rebuild(true);});
  $("copyPathButton").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText($("detailPath").textContent);$("copyPathButton").textContent="已复制";}
    catch{$("copyPathButton").textContent="请选中路径复制";}
    setTimeout(()=>$("copyPathButton").textContent="复制路径",1500);
  });
  $("zoomIn").addEventListener("click",()=>zoomBy(1.25));$("zoomOut").addEventListener("click",()=>zoomBy(.8));
  $("fitGraph").addEventListener("click",()=>fitGraph());$("addRelation").addEventListener("click",()=>setConnect(!state.connect));
  $("cancelConnect").addEventListener("click",()=>setConnect(false));
  const filters=new Set(["maxNodes","showOrphans","showMentions","showTopics","showManual","depth"]);
  const forces=new Set(["centerForce","repelForce","linkStrength","linkDistance"]);
  for(const key of Object.keys(defaults)){
    const input=$(key==="depth"?"depthInput":key);if(!input)continue;
    input.addEventListener(input.type==="checkbox"||input.tagName==="SELECT"?"change":"input",()=>{
      settings[key]=input.type==="checkbox"?input.checked:Number(input.value);
      if($(key+"Output"))$(key+"Output").value=String(settings[key]);
      saveSettings();
      if(filters.has(key))rebuild(true);
      else if(forces.has(key))configureForces();
      else {updateAppearance();if(key==="nodeSize"||key==="scaleNodes")configureForces();}
    });
  }
  document.addEventListener("keydown",(event)=>{
    if(event.key==="Escape"){state.detailController?.abort();$("detailPanel").hidden=true;$("settingsPanel").hidden=true;setConnect(false);if(graphDimension==="sphere")clearSelection();return;}
    if(event.target.closest("input,textarea,select,[contenteditable]"))return;
    if(event.key==="/"){event.preventDefault();$("searchInput").focus();}
    if(graphDimension==="sphere")return;
    if(event.key==="+"||event.key==="="){event.preventDefault();zoomBy(1.2);}
    if(event.key==="-"){event.preventDefault();zoomBy(.83);}
    const directions={ArrowLeft:[1,0],ArrowRight:[-1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
    if(directions[event.key]&&!event.target.closest("button")){
      event.preventDefault();const [dx,dy]=directions[event.key],step=(event.shiftKey?90:30)/state.transform.k;svg.call(zoom.translateBy,dx*step,dy*step);
    }
  });
  let resizeTimer;
  new ResizeObserver(()=>{
    clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
      const width=$("graphStage").clientWidth,height=$("graphStage").clientHeight;
      if(!state.visibleNodes.length||!state.width)return;
      if(Math.abs(width-state.width)<2&&Math.abs(height-state.height)<2)return;
      state.width=width;state.height=height;
      if(graphDimension==="plane"){configureForces();fitGraph(false);}
    },120);
  }).observe($("graphStage"));
  window.addEventListener("skill-library-theme", () => {
    updateAppearance();
    if (sphere) syncSphereAppearance();
  });
  syncControls();loadLibrary();
})();
