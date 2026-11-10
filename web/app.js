const studioModule = await import('./skill-studio.js').catch(() => null);
const planModule = await import('./task-plan.js').catch(() => null);
const skillRuntimeModule = await import('./skill-runtime.js').catch(() => null);
const optimizerModule = await import('./prompt-optimizer.js').catch(() => null);

const $ = id => document.getElementById(id);
const statusText = {running: '执行中', completed: '已完成', stopped: '已停止', failed: '执行失败', interrupted: '已中断', needs_input: '等待补充', budget_exhausted: '预算耗尽'};
let tasks = [], task = null, selection = 0, sending = false, loading = false, subscription, pending;
let menuTask, renameTask;
let preferences, savingPreferences = false;
let archivedTasks = [], settingsLoad = 0;
const modelModes = {unconfigured: '未配置', api: '自定义 API', environment: '环境配置'};
let modelConnected = false;
let pendingGuidance;
let modelDirectory = {models: [], defaultModel: null}, modelChoice = null, effortChoice = 'default', choosingModel = false;
const effortLabels = {default: '默认思考', on: '开启思考', off: '关闭思考', low: '低强度', medium: '中强度', high: '高强度'};
const clockLabels = new Map();
let draftKey = 'new', draftReady = false;
let selectedSkill = null;
let projects = [], projectsAvailable = false, projectBusy = false, savingAccess = false;
const collapsedGroups = new Set();
const accessLabels = {attachments: '仅附件', project_read: '项目只读', project_write: '项目读写', full: '全盘读写'};

const canChooseSkill = () => !sending && !loading && !task?.archived && !task?.runs.some(run => run.status === 'running');
const studio = studioModule?.createSkillStudio({api, getTask: () => task, canSelect: canChooseSkill, onSelect: selectComposerSkill, onOpenTask: selectTask});
const promptOptimizer = optimizerModule?.createPromptOptimizer({
  getContext: () => ({taskId: task?.id ?? null, prompt: $('prompt').value, model: modelChoice, effort: effortChoice}),
  canOptimize: () => modelConnected && canChooseSkill() && !uploading,
  onApply: text => { $('prompt').value = text; saveDraft(); updateControls(); },
});
$('optimize-prompt').hidden = !promptOptimizer;
$('prompt').addEventListener('input', () => promptOptimizer?.update());
$('choose-custom-skill').hidden = !studio;
$('skill-center-nav').hidden = !studio;

// Vertical adaptation of Liquid Glass Switch (MIT). The existing view handlers
// own selection; the lens follows their state and dragging emits native clicks.
const railViews = $('rail-views');
const railLens = $('rail-lens');
const railButtons = [...railViews.querySelectorAll('button')];
const railReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let railDrag = null;
let suppressRailClickUntil = 0;

function placeRailLens(position, stretch = 1) {
  railLens.style.setProperty('--rail-lens-y', position + 'px');
  railLens.style.setProperty('--rail-lens-stretch', String(stretch));
}

function syncRailSelection() {
  const active = $('settings-dialog').open ? 'settings' : $('skill-studio-dialog').open ? 'skill-center-nav' :
    !$('graph-panel').hidden ? 'open-graph' : 'workbench';
  for (const id of ['workbench', 'open-graph', 'skill-center-nav', 'settings']) {
    const button = $(id);
    button.setAttribute('aria-pressed', String(id === active));
    if (id === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const selected = railButtons.find(button => button.id === active && !button.hidden);
  railViews.toggleAttribute('data-active', Boolean(selected));
  if (selected && !railDrag?.moved) {
    railLens.style.setProperty('--rail-lens-height', selected.offsetHeight + 'px');
    placeRailLens(selected.offsetTop);
  }
}
const railStateObserver = new MutationObserver(syncRailSelection);
for (const id of ['graph-panel', 'skill-studio-dialog', 'settings-dialog']) {
  railStateObserver.observe($(id), {attributes: true, attributeFilter: ['open', 'hidden']});
}
new ResizeObserver(syncRailSelection).observe(railViews);
syncRailSelection();

railViews.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || railDrag) return;
  const buttons = railButtons.filter(button => !button.hidden && !button.disabled);
  const selected = buttons.findIndex(button => button.hasAttribute('aria-current'));
  if (selected < 0 || buttons.length < 2) return;
  suppressRailClickUntil = 0;
  railDrag = {pointer: event.pointerId, start: event.clientY, origin: buttons[selected].offsetTop, selected, buttons, moved: false};
});

railViews.addEventListener('pointermove', event => {
  if (railDrag?.pointer !== event.pointerId) return;
  const delta = event.clientY - railDrag.start;
  if (!railDrag.moved && Math.abs(delta) < 4) return;
  if (!railDrag.moved) {
    railViews.setPointerCapture(event.pointerId);
    railViews.classList.add('is-dragging');
    railDrag.moved = true;
  }
  event.preventDefault();
  const {buttons, origin} = railDrag;
  const first = buttons[0].offsetTop;
  const last = buttons.at(-1).offsetTop;
  const target = origin + delta;
  const clamped = Math.max(first, Math.min(last, target));
  const elastic = railReducedMotion.matches ? 0 : 16 * Math.tanh((target - clamped) / 36);
  placeRailLens(clamped + elastic, railReducedMotion.matches ? 1 : 1.04);

  // Rearm from each newly selected stop so a held drag can reverse direction.
  while (true) {
    const current = buttons[railDrag.selected].offsetTop;
    const direction = Math.sign(clamped - current);
    const next = buttons[railDrag.selected + direction];
    if (!direction || !next || Math.abs(clamped - current) < .7 * Math.abs(next.offsetTop - current)) break;
    railDrag.selected += direction;
    next.click();
  }
});

function releaseRailDrag(event) {
  if (railDrag?.pointer !== event.pointerId) return;
  if (railDrag.moved) suppressRailClickUntil = performance.now() + 400;
  railDrag = null;
  railViews.classList.remove('is-dragging');
  syncRailSelection();
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) railViews.addEventListener(event, releaseRailDrag);
railViews.addEventListener('pointerleave', event => {
  if (!railDrag?.moved) releaseRailDrag(event);
});
railViews.addEventListener('click', event => {
  if (!event.isTrusted || !event.detail || performance.now() >= suppressRailClickUntil) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

function selectComposerSkill(skill) {
  selectedSkill = skill ? {id: skill.id, name: skill.name, version: skill.version} : null;
  drawComposerSkill();
  saveDraft();
  if (skill) $('prompt').focus();
}

function drawComposerSkill() {
  $('choose-custom-skill').disabled = $('remove-custom-skill').disabled = !canChooseSkill();
  $('active-custom-skill').hidden = !studio || !selectedSkill;
  $('active-custom-skill-label').textContent = selectedSkill ? `下一轮 · ${selectedSkill.name} · v${selectedSkill.version}` : '';
}

$('remove-custom-skill').onclick = () => { selectComposerSkill(null); $('choose-custom-skill').focus(); };

function saveDraft() {
  if (!draftReady) return;
  try { localStorage.setItem(`sih-draft-${draftKey}`, JSON.stringify({text: $('prompt').value,
    file: $('analysis-file').value, model: modelChoice, effort: effortChoice, skill: selectedSkill})); } catch { /* Draft storage may be disabled by the browser. */ }
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(`sih-draft-${draftKey}`) || 'null'); } catch { /* Ignore invalid browser drafts. */ }
  $('prompt').value = draft?.text ?? '';
  if (!task && draft) { modelChoice = draft.model ?? null; effortChoice = draft.effort ?? 'default'; }
  selectedSkill = studio && draft?.skill?.id && draft.skill.name && Number.isSafeInteger(draft.skill.version) ? draft.skill : null;
  return draft?.file ?? task?.runs.at(-1)?.input_file ?? '';
}

function drawRunStatus(label, run) {
  const seconds = run.config?.started ? Math.max(0, Math.round(((run.ended ?? Date.now()) - run.config.started) / 1000)) : null;
  const skill = run.config?.customSkill;
  label.textContent = [statusText[run.status], run.config?.model, skill ? `${skill.name} · v${skill.version}` : null, run.config?.mode === 'skill' ? null : effortLabels[run.config?.effort ?? 'default'],
    run.config?.fileScope?.mode !== 'attachments' ? accessLabels[run.config?.fileScope?.mode] : null,
    seconds === null ? null : `${seconds} 秒`].filter(Boolean).join(' · ');
}
setInterval(() => {
  for (const [label, run] of clockLabels) if (run.status === 'running') drawRunStatus(label, run);
}, 1000);

function drawModelSelection() {
  const modelName = modelChoice || modelDirectory.defaultModel;
  $('choose-model').textContent = modelName || '连接模型';
  $('choose-model').title = modelName ? (modelChoice ? modelName : '跟随默认模型 · ' + modelName) : '选择或连接模型';
  const selected = modelDirectory.models.find(row => row.id === (modelChoice || modelDirectory.defaultModel));
  const levels = selected?.efforts ?? ['default'];
  $('thinking').replaceChildren(...[...new Set([...levels, effortChoice])].map(level => new Option(effortLabels[level], level)));
  $('thinking').value = effortChoice;
  const locked = sending || loading || uploading || choosingModel || task?.archived || task?.runs.some(run => run.status === 'running');
  $('choose-model').disabled = !!locked;
  $('thinking').disabled = !!locked || levels.length === 1;
  $('thinking').dataset.adjustable = String(levels.length > 1);
  $('thinking').title = levels.length === 1 ? '当前模型未声明可调思考强度，使用服务商默认设置' : '此会话的思考选项';
}

function drawModelChoices() {
  const query = $('model-search').value.trim().toLocaleLowerCase();
  const rows = [{id: null, label: `跟随默认模型${modelDirectory.defaultModel ? ` · ${modelDirectory.defaultModel}` : ''}`},
    ...modelDirectory.models.map(row => ({...row, label: row.id}))].filter(row => !query || row.label.toLocaleLowerCase().includes(query));
  $('model-choices').replaceChildren(...rows.map(row => {
    const button = document.createElement('button');
    button.textContent = row.label;
    button.setAttribute('aria-pressed', String(row.id === modelChoice));
    button.disabled = choosingModel;
    button.onclick = () => void selectModel(row.id, 'default');
    return button;
  }));
}

async function loadModels(refresh = false) {
  $('catalog-status').textContent = '正在读取可用模型…';
  try {
    modelDirectory = await api(`/api/models${refresh ? '?refresh=1' : ''}`);
    modelConnected = !!modelDirectory.defaultModel;
    $('catalog-status').textContent = modelDirectory.warning || (!modelConnected ? '请先在设置中配置模型连接。' : '');
    drawModelSelection();
    drawModelChoices();
    const available = $('available-models');
    available.replaceChildren(...modelDirectory.models.map(model => {
      const tag = document.createElement('span');
      tag.textContent = model.id;
      return tag;
    }));
  } catch (error) { $('catalog-status').textContent = error.message; }
}

async function selectModel(model, effort) {
  if (choosingModel || sending || loading || task?.archived || task?.runs.some(run => run.status === 'running')) return;
  choosingModel = true;
  drawModelSelection();
  $('selection-status').textContent = '正在保存…';
  try {
    if (task) Object.assign(task, await api(`/api/tasks/${task.id}`, {model_id: model, effort}, 'PATCH'));
    modelChoice = model;
    effortChoice = effort;
    saveDraft();
    if ($('model-picker').matches(':popover-open')) $('model-picker').hidePopover();
    $('selection-status').textContent = task ? '已保存到此会话' : '将用于新会话';
  } catch (error) { $('selection-status').textContent = error.message; }
  finally { choosingModel = false; drawModelSelection(); drawModelChoices(); }
}

function exportConversation(item) {
  return api(`/api/tasks/${item.id}`).then(detail => {
    const content = [`# ${detail.title}`, ...detail.runs.flatMap(run => ['\n## 用户\n', run.prompt,
      ...(run.guidance ?? []).map(item => `\n### ${item.applied ? '已应用引导' : '未应用引导'}\n${item.prompt}`), '\n## 助手\n',
      run.answer || run.error || statusText[run.status], ...(run.config ? [`\n模型：${run.config.model} · ${effortLabels[run.config.effort ?? 'default']}`] : []),
      ...(run.artifacts ?? []).map(file => `产物：${file.name} · SHA-256 ${file.sha256}`)])].join('\n');
    const url = URL.createObjectURL(new Blob([content], {type: 'text/markdown;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${detail.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
let uploading = false, graphNodes, graphLoad;
let graphContext = '', graphFocus = null, graphExecution = {ids:[],states:[]};
const graphFrame = $('skill-graph-frame');
function graphMessage(action, data = {}) {
  graphFrame.contentWindow?.postMessage({type:'sih-skill-graph-control',action,...data},location.origin);
}
window.addEventListener('message', async event => {
  if (event.source !== graphFrame.contentWindow || event.origin !== location.origin || event.data?.type !== 'sih-skill-graph') return;
  const {action,id} = event.data;
  if(action==='selected'&&typeof id==='string'){graphFocus=id;return;}
  if (action === 'ready') {
    try {
      const context=task?.id ? '?task='+encodeURIComponent(task.id) : '';
      const graph=await api('/api/skill-graph/skills'+context);
      graphNodes=new Map(graph.nodes.map(node=>[node.id,node]));
      $('graph-status').textContent=`我的 Skill 图谱 · ${graph.nodes.length} 项已安装技能`;
    } catch(error) { $('graph-status').textContent=error.message; }
    graphMessage('execution',graphExecution);
    if (graphFocus) graphMessage('focus',{id:graphFocus});
    graphMessage('enable',{value:!$('graph-panel').hidden});
    return;
  }
  if (action === 'expand') { showTaskPanel(false);return; }
  if (!['use','manage'].includes(action) || typeof id !== 'string') return;
  try {
    const context = task?.id ? '?task='+encodeURIComponent(task.id) : '';
    const {skill} = await api('/api/skill-studio/'+encodeURIComponent(id)+context);
    if (action === 'manage') studio?.openSkill(skill.id);
    else if (canChooseSkill()) {await showGraph(false);selectComposerSkill(skill);}
  } catch (error) { showError(error); }
});

const transcript = $('transcript');
const transcriptContent = $('transcript-content');
const jumpToLatest = $('jump-to-latest');

function updateJumpButton() {
  const remaining = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
  jumpToLatest.hidden = transcript.hidden || remaining <= 24;
}

function scrollToLatest() {
  transcript.scrollTop = transcript.scrollHeight;
  updateJumpButton();
}

transcript.addEventListener('scroll', updateJumpButton, {passive: true});
const transcriptSize = new ResizeObserver(updateJumpButton);
transcriptSize.observe(transcript);
transcriptSize.observe(transcriptContent);
jumpToLatest.onclick = () => {
  if (document.activeElement === jumpToLatest) transcript.focus({preventScroll: true});
  scrollToLatest();
};

async function showGraph(show, skillId) {
  $('graph-panel').hidden = !show;
  $('graph-run-evidence').hidden = true;
  $('transcript').hidden = show;
  updateJumpButton();
  graphMessage('enable',{value:show});
  if (!show) return;
  const context = task?.id ?? '';
  if (graphContext !== context) {graphLoad=undefined;graphContext=context;}
  if (!graphLoad) {
    $('graph-status').textContent='正在载入我的 Skill 图谱…';
    graphLoad = (async () => {
      const suffix = context ? '?task='+encodeURIComponent(context) : '';
      const graph = await api('/api/skill-graph/skills'+suffix);
      graphNodes = new Map(graph.nodes.map(node => [node.id, node]));
      graphFrame.src='/skill-library/index.html'+suffix;
      $('graph-status').textContent = `我的 Skill 图谱 · ${graph.nodes.length} 项已安装技能`;
    })().catch(error => {
      $('graph-status').textContent = `图谱加载失败：${error.message}`;
      graphLoad = undefined;
    });
  }
  await graphLoad;
  if ($('graph-panel').hidden || !graphNodes) return;
  const latest = task?.runs.findLast(run => run.preflight?.trace || run.audit?.skillTrace || run.skillTrace);
  const trace = typeof skillId === 'object' ? skillId : skillId ? null : latest?.preflight?.trace ?? latest?.audit?.skillTrace ?? latest?.skillTrace;
  if (trace) {
    drawRunGraph(trace);
    return;
  }
  $('graph-run-evidence').hidden = true;
  graphFocus = null;
  graphExecution={ids:[],states:[]};graphMessage('execution',graphExecution);
  if (!skillId) return;
  const node = graphNodes.get(skillId) ?? [...graphNodes.values()].find(node=>node.name===skillId);
  if (!node) return;
  graphFocus=node.id;
  graphExecution={ids:[node.id],states:[]};graphMessage('execution',graphExecution);
  showGraphNode(node);
}

function drawRunGraph(trace) {
  const {nodes, edges} = trace.graph;
  const attempt = trace.attempt ?? trace.graph.attempt ?? 1;
  const resolveNode = node => graphNodes.get(node.id) ?? graphNodes.get(node.nodeId) ?? [...graphNodes.values()].find(item=>item.name===node.label||item.name===node.name||item.name===node.nodeId);
  const adopted = nodes.filter(node=>trace.kind!=='skill-session'||node.started);
  const ids = [...new Set(adopted.map(node=>resolveNode(node)?.id).filter(Boolean))];
  const panel = $('graph-run-evidence');
  panel.hidden = false;
  const title = document.createElement('strong');
  title.textContent = trace.kind === 'skill-session' ? '技能执行记录 · ' + nodes.filter(node => node.started).length + ' 项实际开始 · ' + nodes.filter(node => node.state === 'applied').length + ' 项已应用' :
    attempt === null ? '没有采用的技能计划' : '第 ' + attempt + ' 版计划 · ' + nodes.length + ' 个步骤';
  const provenance = document.createElement('p');
  const missingCount=adopted.filter(node=>!resolveNode(node)).length;
  provenance.textContent = `标记来自本轮执行日志${missingCount ? `，其中 ${missingCount} 项在当前已安装库中没有节点` : ''}。实际执行依赖列在下方。`;
  const buttons = document.createElement('div');
  const states = {planned: '未执行', loaded: '已加载，未执行', running: '应用中', applied: '已应用，有回执', blocked: '条件不足', unfinished: '未记录完成', interrupted: '已停止', succeeded: '已完成', failed: '失败'};
  for (const node of nodes) {
    const button = document.createElement('button');
    button.type = 'button';
    const installed = resolveNode(node);
    button.dataset.nodeId = installed?.id ?? '';
    button.textContent = node.label + ' · ' + states[node.state];
    button.title = node.id + '@' + node.version;
    button.disabled = !installed;
    button.onclick = () => {
      showGraphNode(installed);
    };
    buttons.append(button);
  }
  const dependencies = document.createElement('p');
  const labels = new Map(nodes.map(node => [node.step, node.label]));
  dependencies.textContent = edges.map(({from, to}) => labels.get(from) + ' → ' + labels.get(to)).join('  ·  ');
  const missing = document.createElement('p');
  missing.textContent = (trace.selection?.missing ?? []).map(item => item.field + ' 缺少可用于换算至 ' + item.expectedUnit + ' 的来源单位').join('；');
  panel.replaceChildren(title, provenance, buttons, dependencies, missing);
  graphExecution={ids,states:adopted.flatMap(node=>{
    const id=resolveNode(node)?.id;
    return id ? [[id,['succeeded','applied'].includes(node.state)?'done':['failed','blocked','interrupted'].includes(node.state)?'failed':'running']] : [];
  })};
  graphFocus=ids[0]??null;
  graphMessage('execution',graphExecution);
  panel.dataset.highlighted = JSON.stringify(ids);
  if (graphFocus) graphMessage('focus',{id:graphFocus});
}

function showGraphNode(node) {
  if (!node) return;
  graphFocus=node.id;
  graphMessage('focus',{id:node.id});
}

function fileLink(taskId, file, label = file.name) {
  const link = document.createElement('a');
  link.href = `/api/tasks/${taskId}/files/${file.id}`;
  link.download = file.name;
  link.textContent = label;
  link.title = `${file.name} · ${file.size ?? 0} 字节`;
  return link;
}

function imagePreview(taskId, file) {
  const link = document.createElement('a');
  link.className = 'image-attachment';
  link.href = `/api/tasks/${taskId}/files/${file.id}/preview`;
  link.target = '_blank'; link.rel = 'noopener'; link.title = `查看原图 · ${file.name}`;
  const image = document.createElement('img');
  image.src = link.href; image.alt = file.name; image.loading = 'lazy';
  const label = document.createElement('span'); label.textContent = file.name;
  link.append(image, label);
  return link;
}

function drawFiles(selected = $('analysis-file').value) {
  const files = task?.files ?? [];
  const choices = $('analysis-file');
  choices.replaceChildren(new Option('不选本轮附件', ''), ...files.map(file => new Option(file.name, file.id)));
  choices.value = files.some(file => file.id === selected) ? selected : '';
  choices.hidden = true;
  const file = files.find(file => file.id === choices.value);
  $('task-files').hidden = !file;
  $('composer-files').hidden = !file;
  $('task-files').replaceChildren();
  if (file) {
    const card = document.createElement('div'); card.className = 'composer-attachment';
    const preview = file.kind === 'image' ? imagePreview(task.id, file) : fileLink(task.id, file);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove';
    remove.textContent = '×'; remove.title = '删除附件'; remove.setAttribute('aria-label', `删除附件 ${file.name}`);
    remove.onclick = async () => {
      const owner = task;
      remove.disabled = true;
      try {
        await api(`/api/tasks/${owner.id}/files/${file.id}`, {}, 'DELETE');
        owner.files = owner.files.filter(item => item.id !== file.id);
        if (task?.id === owner.id) {
          drawFiles(''); saveDraft();
          if ($('selection-status').textContent.startsWith('附件已保存')) $('selection-status').textContent = '';
          showError(); $('prompt').focus();
        }
      } catch (error) { showError(error); remove.disabled = false; }
    };
    card.append(preview, remove); $('task-files').append(card);
  }
  $('saved-attachments').hidden = !files.length;
  $('saved-attachment-list').replaceChildren(...files.map(file => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = file.name;
    button.title = `附带 ${file.name}`;
    button.onclick = () => { drawFiles(file.id); saveDraft(); $('composer-menu').hidePopover(); $('prompt').focus(); };
    return button;
  }));
}

function drawCapabilityFit(panel, decision) {
  panel.hidden = !decision;
  if (!decision) return;
  const title = document.createElement('summary');
  title.textContent = decision.status === 'selected' ? '内置技能选择依据' : '内置技能 · 本次空选';
  const reason = document.createElement('p');
  reason.textContent = decision.summary;
  const files = decision.files.map(file => {
    const item = document.createElement('p');
    item.textContent = `${file.path} · ${file.message ?? `${file.format} · SHA-256 ${file.sha256}`}`;
    return item;
  });
  panel.replaceChildren(title, reason, ...files);
  panel.open = decision.status === 'needs_input';
}

function drawSkillEvidence(container, taskId, run) {
  if (run.preflight) {
    const {report, artifact, trace} = run.preflight;
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '检查范围与逐项证据';
    detail.append(summary);
    const paragraph = (parent, text) => {
      const p = document.createElement('p');
      p.textContent = text;
      parent.append(p);
    };
    paragraph(detail, report.coverage.scope + ' · 已读取 ' + report.coverage.read + ' / ' + report.coverage.selected +
      (report.coverage.truncated ? ' · 目录结果不完整' : ''));
    for (const issue of report.issues) paragraph(detail, issue.message);
    for (const evidence of report.evidence) paragraph(detail, evidence.label + ' · ' + (evidence.paths.join('、') || '未找到'));
    for (const file of report.files) {
      const row = document.createElement('section');
      row.className = 'preflight-material';
      if (file.id) row.append(fileLink(taskId, {id: file.id, name: file.path}));
      else paragraph(row, file.path);
      paragraph(row, [file.format, file.structure, file.size === undefined ? '' : file.size + ' 字节'].filter(Boolean).join(' · '));
      if (file.sha256) paragraph(row, 'SHA-256 ' + file.sha256);
      for (const issue of file.issues) paragraph(row, (issue.line ? '第 ' + issue.line + ' 行 · ' : '') + issue.message +
        (issue.related ? ' 来源 ' + issue.related : ''));
      detail.append(row);
    }
    const graph = document.createElement('button');
    graph.type = 'button';
    graph.textContent = '查看实际执行路径';
    graph.onclick = () => void showGraph(true, trace);
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.textContent = '引用发现继续对话';
    follow.onclick = () => {
      const findings = [...report.issues.map(issue => issue.message),
        ...report.files.flatMap(file => file.issues.map(issue => file.path + (issue.line ? '#' + issue.line : '') + ' · ' + issue.message))];
      $('prompt').value = ('请根据以下材料预检记录提出下一步检查，并说明哪些发现需要复核。\n\n' +
        [run.answer, ...findings].join('\n') + '\n\n' + $('prompt').value).slice(0, 16000);
      saveDraft();
      $('prompt').focus();
    };
    container.replaceChildren(fileLink(taskId, artifact, '下载预检报告'), graph, follow, detail);
    return;
  }
  if (run.audit) {
    const {report, skillTrace} = run.audit;
    const links = (run.artifacts ?? []).map(file => fileLink(taskId, file));
    const detail = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '查看检查结果与来源'; detail.append(summary);
    const mapping = document.createElement('p');
    mapping.textContent = report.mappings.map(item => `${item.source} → ${item.target}${item.targetUnit ? ` (${item.sourceUnit} → ${item.targetUnit}, ×${item.factor})` : ''}`).join('；') || '尚无可用映射';
    detail.append(mapping);
    for (const issue of report.validation.issues ?? []) {
      const p = document.createElement('p'), a = document.createElement('a');
      a.href = issue.evidence.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = `第 ${issue.evidence.record} 条记录 · ${issue.field} · ${issue.code} · ${issue.value}`;
      p.append(a); detail.append(p);
    }
    if (report.validation.truncated) { const p = document.createElement('p'); p.textContent = `共 ${report.validation.issueCount} 个问题，界面与导出保留前 ${report.validation.issues.length} 个。`; detail.append(p); }
    for (const ref of report.citations.slice(0, 5)) {
      const a = document.createElement('a'); a.href = ref.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = `来源记录 ${ref.record}${ref.column ? ` / ${ref.column}` : ''}`; detail.append(a, ' ');
    }
    const metrics = document.createElement('p');
    const m = report.metrics;
    metrics.textContent = `模型 ${m.modelCalls} 次 · 工具 ${m.toolCalls} 次 · 重规划 ${m.replans} 次 · ${m.elapsedMs} ms · ${m.usageComplete ? `${m.inputTokens + m.outputTokens} tokens` : '服务商用量未完整提供'}${m.cost === null ? '' : ` · 计价 ${m.cost}`}`;
    const traceActions = [];
    if (report.error?.code === 'OUTPUT_TRUNCATED') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '扩大预算重试';
      retry.title = '每次输出与总输出额度扩为默认的两倍，可能增加模型费用';
      retry.onclick = async () => {
        if (task?.id !== taskId || task.runs.some(item => item.status === 'running')) return;
        drawFiles(report.source.id);
        retry.disabled = true;
        try { await submitRun(report.goal, false, run.config?.workflow ?? report.target, null, true); }
        finally { retry.disabled = false; }
      };
      traceActions.push(retry);
    }
    if (skillTrace) {
      const graph = document.createElement('button');
      graph.type = 'button';
      graph.textContent = '查看技能执行图';
      graph.onclick = () => void showGraph(true, skillTrace);
      traceActions.push(graph);
      const selection = document.createElement('p');
      const adopted = skillTrace.graph.nodes.map(node => node.label).join('、');
      const candidates = skillTrace.selection?.candidates.map(item => item.label).join('、') || '空';
      selection.textContent = '确定性候选 ' + candidates + ' · 采用 ' + (adopted || '空') +
        ' · 完成 ' + skillTrace.graph.nodes.filter(node => node.state === 'succeeded').length + ' 步';
      traceActions.push(selection);
    }
    container.replaceChildren(...links, ...traceActions, metrics, detail); return;
  }
  if (!run.skill && run.skillSearch) {
    const matches = run.skillSearch.matches;
    const title = document.createElement('p');
    title.textContent = matches.length ? '技能检索结果' : '未找到匹配技能';
    container.replaceChildren(title, ...matches.map(match => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${match.executable ? '可执行' : '目录'} · ${match.label}`;
      button.title = match.description;
      if (studio && match.tool === 'load_skill' && !match.nodeId) button.onclick = () => studio.openSkill(match.id);
      else if (match.nodeId) button.onclick = () => void showGraph(true, match.nodeId);
      else button.disabled = true;
      return button;
    }));
    return;
  }
  if (!run.skill) return;
  const detail = document.createElement('span');
  detail.textContent = `已采用 ${run.skill.label} · ${run.skill.id}`;
  detail.title = run.skill.reason ?? '';
  const graph = document.createElement('button');
  graph.type = 'button';
  graph.textContent = '在图谱定位';
  graph.onclick = () => void showGraph(true, run.skill.id);
  container.replaceChildren(detail, graph, ...run.artifacts.map(file => fileLink(taskId, file, '下载分析报告')));
}

async function api(path, data, method = 'POST') {
  const response = await fetch(path, data === undefined ? {} : {
    method, headers: {'content-type': 'application/json'}, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function showError(error) {
  $('error').hidden = !error;
  $('error').textContent = error?.message ?? '';
}

function drawTaskRow(item) {
  const row = document.createElement('div');
  row.className = 'task-row';
  const button = document.createElement('button');
  button.className = 'task-open';
  button.textContent = item.title;
  button.title = item.title;
  if (item.status === 'running') { button.textContent = `● ${item.title}`; button.title = `${item.title} · 执行中`; }
  if (item.id === task?.id) button.setAttribute('aria-current', 'true');
  button.onclick = () => void selectTask(item.id);
  const options = document.createElement('button');
  options.className = 'task-options';
  options.textContent = '⋯';
  options.setAttribute('aria-label', `${item.title} 的操作`);
  options.setAttribute('aria-controls', 'task-menu');
  options.setAttribute('aria-expanded', 'false');
  options.onclick = () => openTaskMenu(item, options);
  row.append(button, options);
  return row;
}

function taskGroup(label, key, searching, action, actionLabel, project = false) {
  const group = document.createElement('details');
  group.className = project ? 'project-group' : 'task-group';
  group.open = searching || !collapsedGroups.has(key);
  group.ontoggle = () => {
    if (searching || !group.isConnected) return;
    if (group.open) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
  };
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = label;
  summary.append(title);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'group-action';
    button.textContent = '+';
    button.title = actionLabel;
    button.setAttribute('aria-label', actionLabel);
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); void action(); };
    summary.append(button);
  }
  group.append(summary);
  return group;
}

function emptyGroup(text) {
  const empty = document.createElement('p');
  empty.className = 'no-tasks';
  empty.textContent = text;
  return empty;
}

function drawTasks() {
  const list = $('tasks');
  const term = $('search').value.trim().toLocaleLowerCase();
  const results = tasks.filter(item => item.title.toLocaleLowerCase().includes(term) ||
    projects.some(project => project.id === item.project_id && project.name.toLocaleLowerCase().includes(term)));
  const pinned = taskGroup('置顶', 'pinned', !!term);
  const pinnedTasks = results.filter(item => item.pinned);
  pinned.append(...(pinnedTasks.length ? pinnedTasks.map(drawTaskRow) : [emptyGroup('暂无置顶')]));
  const groups = [pinned];
  if (projectsAvailable) {
    const projectList = taskGroup('项目', 'projects', !!term, openProjectDialog, '添加项目');
    for (const project of projects) {
      const items = results.filter(item => !item.pinned && item.project_id === project.id);
      if (term && !items.length && !project.name.toLocaleLowerCase().includes(term)) continue;
      const group = taskGroup(project.name, project.id, !!term, () => newProjectChat(project),
        '在 ' + project.name + ' 新建读写会话', true);
      group.querySelector('summary').title = project.path;
      group.append(...(items.length ? items.map(drawTaskRow) : [emptyGroup('暂无项目会话')]));
      projectList.append(group);
    }
    if (projectList.children.length === 1) projectList.append(emptyGroup(term ? '没有匹配的项目' : '点击 + 添加本机目录'));
    groups.push(projectList);
  }
  const recent = taskGroup('最近', 'recent', !!term);
  const recentTasks = results.filter(item => !item.pinned && (!projectsAvailable || !item.project_id));
  recent.append(...(recentTasks.length ? recentTasks.map(drawTaskRow) : [emptyGroup(term ? '没有匹配的会话' : '暂无会话')]));
  list.replaceChildren(...groups, recent);
}

function openProjectDialog() {
  $('project-form').reset();
  dialogError($('project-dialog'));
  $('project-dialog').showModal();
  $('project-path').focus();
}

async function newProjectChat(project) {
  if (sending || uploading || choosingModel || loading || projectBusy) return;
  projectBusy = true;
  updateControls();
  try {
    const created = await api('/api/tasks', {project_id: project.id});
    collapsedGroups.delete('projects');
    collapsedGroups.delete(project.id);
    tasks = await api('/api/tasks');
    await selectTask(created.id);
    $('prompt').focus();
  } catch (error) { showError(error); }
  finally { projectBusy = false; updateControls(); }
}

$('cancel-project').onclick = () => $('project-dialog').close();
$('project-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  dialogError($('project-dialog'));
  try {
    const project = await api('/api/projects', {path: $('project-path').value});
    if (!projects.some(item => item.id === project.id)) projects.push(project);
    $('project-dialog').close();
    drawTasks();
    await newProjectChat(project);
  } catch (error) { dialogError($('project-dialog'), error); }
  finally { button.disabled = false; }
};

function drawAccessOptions() {
  const mode = $('access-mode').value;
  const project = projects.find(item => item.id === $('access-project').value);
  const help = {
    attachments: 'Agent 只能读取此会话的附件。',
    project_read: 'Agent 可以列目录和读取项目内的 UTF-8 文本。',
    project_write: 'Agent 可以读取、创建和修改项目内的 UTF-8 文本。',
    full: 'Agent 可以访问本机账号有权限的各盘文本文件。项目外路径请使用绝对路径。',
  };
  $('access-help').textContent = [
    help[mode], project && mode !== 'attachments' ? project.path : '',
    mode !== 'attachments' ? '读取的片段会发送给本会话配置的模型。' : '',
  ].filter(Boolean).join(' ');
  const confirm = mode === 'full' && task?.file_access !== 'full';
  $('confirm-full-row').hidden = !confirm;
  $('confirm-full').required = confirm;
  if (!confirm) $('confirm-full').checked = false;
}

$('open-file-access').onclick = () => {
  $('access-project').replaceChildren(new Option('不绑定项目', ''),
    ...projects.map(project => new Option(project.name + ' · ' + project.path, project.id)));
  $('access-project').value = task?.project_id ?? '';
  $('access-mode').value = task?.file_access ?? 'attachments';
  $('confirm-full').checked = false;
  drawAccessOptions();
  dialogError($('file-access-dialog'));
  $('file-access-dialog').showModal();
  updateControls();
};
$('access-mode').onchange = $('access-project').onchange = drawAccessOptions;
$('cancel-file-access').onclick = () => $('file-access-dialog').close();
$('file-access-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  if (button.disabled) return;
  if (task?.runs.some(run => run.status === 'running')) { updateControls(); return; }
  const dialog = $('file-access-dialog');
  const mode = $('access-mode').value;
  const projectId = $('access-project').value || null;
  dialogError(dialog);
  if (mode.startsWith('project_') && !projectId) { dialogError(dialog, new Error('请先在侧边栏添加并选择项目。')); return; }
  if (!task && mode === 'attachments' && !projectId) { dialog.close(); return; }
  savingAccess = true;
  updateControls();
  try {
    const draft = $('prompt').value, chosenModel = modelChoice, chosenEffort = effortChoice;
    const existing = task?.id;
    const id = existing ?? (await api('/api/tasks', {})).id;
    const updated = await api('/api/tasks/' + id + '/file-access',
      {mode, project_id: projectId, confirmed: $('confirm-full').checked}, 'PUT');
    tasks = await api('/api/tasks');
    dialog.close();
    if (existing) Object.assign(task, updated);
    else {
      await selectTask(id);
      $('prompt').value = draft;
      if (chosenModel || chosenEffort !== 'default') await selectModel(chosenModel, chosenEffort);
      saveDraft();
    }
    drawTasks();
    updateControls();
  } catch (error) { dialogError(dialog, error); }
  finally { savingAccess = false; updateControls(); }
};

function openTaskMenu(item, options) {
  const menu = $('task-menu');
  if (menu.matches(':popover-open')) {
    menu.hidePopover();
    if (menuTask?.options === options) return;
  }
  menuTask?.options.setAttribute('aria-expanded', 'false');
  menuTask = {item, options};
  options.setAttribute('aria-expanded', 'true');
  $('pin-task').textContent = item.pinned ? '取消置顶' : '置顶';
  menu.showPopover({source: options});
  const anchor = options.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(anchor.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${anchor.bottom + menu.offsetHeight < innerHeight ? anchor.bottom : Math.max(4, anchor.top - menu.offsetHeight)}px`;
  $('pin-task').focus();
}

async function updateTask(id, changes) {
  const updated = await api(`/api/tasks/${id}`, changes, 'PATCH');
  if (task?.id === id) {
    if (updated.archived) await selectTask();
    else {
      Object.assign(task, updated);
      $('title').textContent = task.title;
      updateControls();
    }
  }
  tasks = await api('/api/tasks');
  drawTasks();
}

function dialogError(container, error) {
  const message = container.querySelector('.dialog-error');
  message.textContent = error?.message ?? '';
  message.hidden = !error;
}

function settingsMessage(id, text = '', tone = '') {
  const message = $(id);
  message.textContent = text;
  message.hidden = !text;
  message.dataset.tone = tone;
}

function showSettingsPage(page) {
  for (const button of document.querySelectorAll('[data-settings-page]')) {
    const selected = button.dataset.settingsPage === page;
    $(button.getAttribute('aria-controls')).hidden = !selected;
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('settings-load').hidden = page === 'archive' || !$('settings-load').textContent;
  document.querySelector('.settings-content').scrollTop = 0;
  if (page === 'archive') void loadArchive();
}

function drawModelMode() {
  const mode = $('model-mode').value;
  const custom = mode === 'api';
  $('api-fields').hidden = !custom;
  $('api-endpoint').disabled = !custom;
  $('api-key').disabled = !custom || !preferences?.canStoreKey || $('clear-key').checked;
  $('test-model').disabled = !preferences || savingPreferences;
  $('save-model').disabled = !preferences || savingPreferences;
  $('save-run').disabled = !preferences || savingPreferences;
  $('reset-run').disabled = !preferences || savingPreferences;
  $('mode-help').textContent = mode === 'environment' ? `使用环境配置中的 ${preferences?.environmentModel ?? ''}。`
    : '支持兼容 Chat Completions 的地址。填写基地址或完整的请求地址均可。';
}

function fillPreferences(data) {
  preferences = data;
  modelConnected = data.mode !== 'unconfigured';
  $('active-mode').textContent = modelModes[data.mode];
  $('active-model').textContent = data.activeModel;
  $('model').textContent = data.activeModel;
  $('environment-option').hidden = !data.environmentModel;
  $('model-mode').value = data.mode === 'environment' ? 'environment' : 'api';
  $('api-endpoint').value = data.endpoint.replace(/\/chat\/completions\/?$/, '');
  $('max-steps').value = data.maxSteps;
  $('api-key').value = '';
  $('api-key').placeholder = data.hasKey ? '•••••••• 已保存，留空继续使用' : '粘贴 API 密钥';
  $('clear-key').checked = false;
  $('clear-key-row').hidden = !data.hasKey && !data.keyUnreadable;
  $('key-help').textContent = data.keyUnreadable ? '已保存的密钥无法读取，请重新填写或清除。'
    : !data.canStoreKey ? '此系统的密钥请通过 .env 配置。'
    : data.hasKey ? '密钥已保存。留空继续使用；更换服务地址时请重新填写。'
    : '按服务商要求填写。本机无需密钥的服务可留空。';
  drawModelMode();
}

async function applyPreferences(testOnly) {
  if (!preferences || savingPreferences || !$('model-form').reportValidity()) return;
  const mode = $('model-mode').value;
  const payload = {mode, revision: preferences.revision, maxSteps: preferences.maxSteps};
  if (mode === 'api') Object.assign(payload, {endpoint: $('api-endpoint').value,
    key: $('api-key').value, clearKey: $('clear-key').checked});
  savingPreferences = true;
  drawModelMode();
  settingsMessage('model-feedback', testOnly ? '正在测试连接…' : '正在保存…');
  try {
    if (testOnly) {
      const result = await api('/api/settings/test', payload);
      settingsMessage('model-feedback', result.models ? `API 验证成功，读取到 ${result.models.length} 个可用模型。` : '模型已响应。');
    } else {
      const data = await api('/api/settings', payload, 'PUT');
      const budgetDraft = $('max-steps').value;
      fillPreferences(data);
      $('max-steps').value = budgetDraft;
      settingsMessage('model-feedback', '已保存，从下一轮执行起生效。');
      void loadModels(true);
    }
  } catch (error) { settingsMessage('model-feedback', error.message, 'error'); }
  finally { savingPreferences = false; drawModelMode(); }
}

async function loadArchive() {
  const list = $('archived-tasks');
  list.textContent = '正在读取…';
  dialogError($('archive-view'));
  try { archivedTasks = await api('/api/tasks?archived=1'); drawArchive(); }
  catch (error) { archivedTasks = []; list.replaceChildren(); dialogError($('archive-view'), error); }
}

function drawArchive() {
  const list = $('archived-tasks');
  const term = $('archive-search').value.trim().toLocaleLowerCase();
  const archived = archivedTasks.filter(item => item.title.toLocaleLowerCase().includes(term));
  if (!archived.length) {
    const empty = document.createElement('p');
    empty.className = 'settings-empty';
    empty.textContent = term ? '没有匹配的归档任务' : '暂无已归档任务';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...archived.map(item => {
    const row = document.createElement('div');
    row.className = 'archive-row';
    const title = document.createElement('button');
    title.className = 'archive-title';
    title.textContent = item.title;
    title.onclick = () => { $('settings-dialog').close(); void selectTask(item.id); };
    const restore = document.createElement('button');
    restore.textContent = '恢复';
    restore.setAttribute('aria-label', `恢复 ${item.title}`);
    restore.onclick = async () => {
      restore.disabled = true;
      try { await updateTask(item.id, {archived: false}); await loadArchive(); }
      catch (error) { dialogError($('archive-view'), error); restore.disabled = false; }
    };
    row.append(title, restore);
    return row;
  }));
}

function updateControls() {
  promptOptimizer?.update();
  const activeRun = task?.runs.find(run => run.status === 'running');
  const active = !!activeRun;
  $('send').disabled = sending || loading || uploading || choosingModel || projectBusy || !!task?.archived || activeRun?.config?.mode === 'preflight';
  const access = $('open-file-access');
  const mode = task?.file_access ?? 'attachments';
  const project = projects.find(item => item.id === task?.project_id);
  access.hidden = !projectsAvailable;
  access.disabled = $('send').disabled;
  access.dataset.mode = mode;
  access.title = accessLabels[mode] + (project ? ' · ' + project.path : ' · 设置会话文件权限');
  access.setAttribute('aria-label', '文件权限：' + accessLabels[mode]);
  const sendLabel = active ? '发送引导' : '发送';
  $('send').title = sendLabel;
  $('send').setAttribute('aria-label', sendLabel);
  $('try-tool').disabled = $('send').disabled || !!active;
  $('attach').disabled = sending || loading || uploading || projectBusy || !!task?.archived;
  $('composer-add').disabled = $('attach').disabled && $('try-tool').disabled;
  $('analysis-file').disabled = $('attach').disabled;
  $('open-audit').disabled = $('attach').disabled;
  $('attachment-runtime-note').hidden = !active;
  $('access-runtime-note').hidden = !active;
  for (const id of ['access-project', 'access-mode', 'confirm-full']) $(id).disabled = !!active || savingAccess;
  $('file-access-form').querySelector('[type="submit"]').disabled = !!active || savingAccess || !!task?.archived;
  $('audit-runtime-note').hidden = !active;
  $('start-audit').disabled = $('rules-audit').disabled = !!active || $('attach').disabled;
  if ($('preflight-dialog').open) drawPreflightOptions();
  $('try-tool').title = active ? '请等待当前任务结束或停止后试跑工具' : '在本地试跑一次工作区文件工具';
  $('prompt').disabled = !!task?.archived;
  $('archived-note').hidden = !task?.archived;
  $('new').disabled = sending || uploading;
  $('stop').hidden = !active;
  drawModelSelection();
  drawComposerSkill();
}

function toolOutputSummary(output) {
  if (typeof output === 'string') {
    try { return toolOutputSummary(JSON.parse(output)); } catch { return output; }
  }
  if (!output || typeof output !== 'object') return '已返回结果';
  if (output.ok === false) return output.error?.message || '调用失败';
  const data = output.data ?? {};
  if (Array.isArray(data.entries)) return `返回 ${data.entries.length} 项${data.truncated ? ' · 结果不完整' : ''}`;
  if (data.file) return `${data.file.path} · ${data.file.lines_returned} / ${data.file.total_lines} 行${data.truncated ? ' · 结果不完整' : ''}`;
  if (Array.isArray(data.matches)) return `找到 ${data.matches.length} 项技能`;
  if (Array.isArray(data.mappings)) return `已映射 ${data.mappings.length} 个字段`;
  if (Number.isInteger(data.issueCount)) return `检查 ${data.rows} 行 · ${data.issueCount} 个问题`;
  if (Array.isArray(data.columns)) return `已统计 ${data.columns.length} 列`;
  return data.summary || data.path || '已返回结果';
}

function appendEvent(list, {seq, type, payload}) {
  const compact = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 150);
  const lines = {
    started: () => payload.mode === 'skill' ? '开始执行 · 本地技能' : `开始执行 · ${payload.model || '任务'}`,
    model: () => `正在处理 · ${payload.label}`,
    skill_selected: () => `采用技能 · ${payload.label}`,
    custom_skill_loaded: () => `已加载技能 · ${payload.name} · v${payload.version}`,
    skill_auto_loaded: () => `自动加载指南 · ${payload.name}`,
    skill_auto_started: () => `实际文件操作采用默认技能 · ${payload.name}`,
    model_output_retry: () => `输出截断，分步重试 · 第 ${payload.attempt} 次`,
    skill_route: () => `任务匹配技能 · ${payload.candidates.length} 项候选`,
    skill_runtime: () => `技能状态 · ${payload.graph.nodes.filter(node => node.started).length} 项实际开始`,
    skill_resource_read: () => `读取技能资料 · ${payload.path}`,
    skill_application: () => `技能应用报告 · ${payload.name} · ${payload.status}`,
    skill_applicability: () => `检查技能适用性 · ${payload.name} · ${{passed: '声明条件满足', failed: '不满足', unknown: '信息不足', unspecified: '未声明'}[payload.status]}`,
    skill_delivery: () => `产物验收 · ${payload.name} · ${{passed: '声明范围通过', failed: '未通过', unknown: '未确认', unspecified: '未声明'}[payload.status]}`,
    skill_session_completed: () => '已保存技能执行记录',
    project_test_request: () => '项目测试 · 等待确认',
    project_test_decision: () => `项目测试 · ${{approve: '已确认', decline: '已拒绝', expired: '确认过期', superseded: '已撤回', aborted: '已停止'}[payload.decision]}`,
    project_test_started: () => '项目测试 · 已启动',
    project_test_interrupted: () => `项目测试 · ${payload.code === 'TIMEOUT' ? '超时' : '已停止'}前的输出`,
    skill_search: () => `检索技能 · 找到 ${payload.matches.length} 项`,
    execution_incomplete: () => '继续执行 · 等待工具回执',
    skill_completed: () => `技能完成 · ${payload.label}`,
    guidance_received: () => '收到补充引导', guidance_applied: () => '已应用补充引导',
    request_wait: () => `服务商${payload.status === 429 ? '限流' : '繁忙'} · 等待重试 ${payload.attempt}`,
    context_snapshot: () => `上下文已精简 · 省略 ${payload.historyOmitted?.length ?? 0} 轮历史和 ${payload.toolRoundsOmitted ?? 0} 批旧回执 · ${payload.compactedReceipts?.length ?? 0} 份回执使用摘录`,
    budget_denied: () => payload.message,
    budget_finished: () => `本轮用量 · 模型 ${payload.modelCalls} 次（供应商重试 ${payload.retries} 次）· 工具 ${payload.toolCalls} 次${payload.unknownModelUsage ? ` · ${payload.unknownModelUsage} 次用量未知` : ''}`,
    skill_engine_fallback: () => `技能检索回退 · ${payload.reason}`,
    audit_model: () => `正在规划 · ${payload.stage === 'steps' ? '可选步骤' : payload.stage === 'mapping' ? '字段映射' : `第 ${payload.call} 次`}`,
    audit_plan: () => `计划已生成 · ${payload.steps.length} 个步骤`,
    audit_skill_selection: () => payload.candidates.length ? `筛选技能 · ${payload.candidates.length} 个候选` : '等待补充 · 缺少适用技能或来源证据',
    audit_replan: () => `调整计划 · 第 ${payload.attempt} 次`,
    preflight_plan: () => '确定检查流程 · ' + payload.nodes.length + ' 步',
    preflight_step: () => '已完成 · ' + payload.label,
    capability_fit: () => payload.status === 'selected' ? '选用内置技能' : '内置技能 · 空选',
    finished: () => statusText[payload.status],
  };
  const isTool = ['tool', 'tool_result', 'audit_tool'].includes(type);
  if (!isTool && !Object.hasOwn(lines, type)) return;
  if (type === 'context_snapshot' && !payload.historyOmitted?.length && !payload.toolRoundsOmitted && !payload.compactedReceipts?.length) return;
  const name = payload.name ?? payload.tool;
  const output = type === 'tool_result' ? payload.output : payload.result;
  const key = `${payload.step}:${name}`;
  const previous = type === 'tool_result' ? [...list.children].reverse().find(item => item.dataset.toolKey === key && item.dataset.pending === 'true') : null;
  const li = previous ?? document.createElement('li');
  if (seq) li.dataset.eventSeq = String(seq);
  const detail = document.createElement('details');
  detail.className = 'execution-step';
  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'execution-icon'; icon.setAttribute('aria-hidden', 'true');
  const failed = type === 'budget_denied' || output?.ok === false || (output?.data?.kind === 'project_tests' && output.data.status !== 'passed') ||
    (output?.data?.kind === 'material_preflight' && output.data.status === 'needs_input') ||
    (type === 'finished' && ['failed', 'stopped', 'interrupted', 'budget_exhausted'].includes(payload.status));
  const pending = type === 'tool';
  icon.textContent = failed ? '!' : pending || (!isTool && type !== 'finished' && type !== 'skill_completed') ? '·' : '✓';
  detail.dataset.state = failed ? 'failed' : pending ? 'running' : 'done';
  const title = document.createElement('span');
  title.className = 'execution-title';
  title.textContent = compact(isTool ? name === 'run_project_tests' ? '运行项目测试' : name : lines[type]());
  const preview = document.createElement('span');
  preview.className = 'execution-preview';
  preview.textContent = compact(isTool ? pending ? '执行中' : toolOutputSummary(output) :
    payload.rationale || payload.reason?.message || payload.query || '');
  summary.append(icon, title, preview);
  detail.append(summary);
  detail.addEventListener('toggle', () => {
    if (!detail.open || detail.querySelector('.execution-raw')) return;
    const raw = typeof output === 'string' ? output : JSON.stringify(output ?? payload, null, 2);
    const body = document.createElement('div'); body.className = 'execution-body';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制完整记录';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(raw); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败，可选择下方文本'; }
    };
    const pre = document.createElement('pre'); pre.className = 'execution-raw'; pre.tabIndex = 0;
    pre.setAttribute('aria-label', '完整执行记录'); pre.textContent = raw;
    body.append(copy, pre); detail.append(body);
  });
  if (isTool) { li.dataset.toolKey = key; li.dataset.pending = String(pending); }
  li.replaceChildren(detail);
  if (!previous) list.append(li);
  const count = list.parentElement.querySelector('.execution-count');
  if (count) count.textContent = `${list.children.length} 项`;
}

function showTestApproval(panel, run, proposal) {
  panel.dataset.approval = proposal.id;
  const title = document.createElement('strong');
  title.textContent = '运行项目测试？';
  const command = document.createElement('code');
  command.textContent = proposal.command;
  command.title = proposal.executable;
  const directory = document.createElement('p');
  directory.textContent = proposal.cwd;
  const note = document.createElement('p');
  note.textContent = '测试代码会以当前系统账号运行，具有该账号的文件和网络权限。每次确认仅授权这一次。';
  const actions = document.createElement('div'); actions.className = 'actions';
  const buttons = [['approve', '确认运行'], ['decline', '跳过测试']].map(([decision, label]) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (decision === 'approve') button.className = 'primary-action';
    button.onclick = async () => {
      for (const item of buttons) item.disabled = true;
      try { await api(`/api/runs/${run.id}/project-test-decision`, {id: proposal.id, decision}); }
      catch (error) {
        if (panel.dataset.approval !== proposal.id) return;
        note.textContent = error.message;
        for (const item of buttons) item.disabled = Date.now() >= proposal.expires;
      }
    };
    button.disabled = run.status !== 'running' || Date.now() >= proposal.expires;
    return button;
  });
  actions.append(...buttons);
  panel.replaceChildren(title, command, directory, note, actions);
  panel.hidden = false;
}

function drawTranscript() {
  subscription?.close();
  clockLabels.clear();
  $('title').textContent = task?.title ?? '新任务';
  transcriptContent.replaceChildren();
  if (!task?.runs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '发送一条消息开始任务。';
    transcriptContent.append(empty);
  }
  for (const run of task?.runs ?? []) {
    const taskId = task.id;
    const row = document.createElement('article');
    const prompt = document.createElement('p');
    prompt.className = 'prompt';
    prompt.textContent = run.prompt;
    prompt.hidden = !run.prompt;
    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.textContent = [run.answer, run.error].filter(Boolean).join('\n\n') || statusText[run.status];
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    details.className = 'execution-record';
    summary.append('执行记录');
    const count = document.createElement('span'); count.className = 'execution-count'; summary.append(count);
    const list = document.createElement('ol');
    list.className = 'execution-log';
    list.tabIndex = 0;
    list.setAttribute('aria-label', '执行步骤，可展开查看完整记录');
    details.append(summary, list);
    const evidence = document.createElement('div');
    const capabilityFit = document.createElement('details');
    capabilityFit.className = 'task-plan';
    drawCapabilityFit(capabilityFit, run.capabilityFit);
    const planPanel = document.createElement('details');
    planPanel.className = 'task-plan';
    const drawPlan = () => planModule?.renderTaskPlan(planPanel, run, taskId);
    const skillPanel = document.createElement('details');
    skillPanel.className = 'skill-runtime';
    const drawSkillRuntime = () => skillRuntimeModule?.renderSkillRuntime(skillPanel, run, {
      taskId,
      onGraph: trace => void showGraph(true, trace),
      onOpen: id => studio?.openSkill(id),
      onReceipt: seq => {
        const item = list.querySelector('[data-event-seq="' + seq + '"]');
        if (!item) return;
        details.open = true;
        item.querySelector('details').open = true;
        item.scrollIntoView({block: 'center', behavior: 'smooth'});
      },
      onRevise: () => {
        $('prompt').value = [$('prompt').value, '请调整任务计划和技能链：'].filter(Boolean).join('\n\n');
        void showGraph(false); $('prompt').focus(); saveDraft();
      },
      onCapture: () => studio?.openFromRun(run),
    });
    drawSkillRuntime();
    drawPlan();
    if (!planModule) planPanel.hidden = true;
    evidence.className = 'skill-evidence';
    drawSkillEvidence(evidence, taskId, run);
    const runStatus = document.createElement('p');
    runStatus.className = 'run-status';
    drawRunStatus(runStatus, run);
    clockLabels.set(runStatus, run);
    const guidance = document.createElement('div');
    guidance.className = 'run-guidance';
    const testPanel = document.createElement('section');
    testPanel.className = 'project-test-panel';
    testPanel.hidden = true;
    testPanel.setAttribute('aria-live', 'polite');
    const guideRows = new Map();
    function showGuidance(item) {
      let line = guideRows.get(item.request);
      if (!line) { line = document.createElement('p'); guideRows.set(item.request, line); guidance.append(line); }
      line.textContent = `${item.applied ? '已应用引导' : run.status === 'running' ? '等待应用引导' : '未应用引导'} · ${item.prompt}`;
    }
    for (const item of run.guidance ?? []) showGuidance(item);
    const sourceFile = task.files?.find(file => file.id === run.input_file);
    if (sourceFile?.kind === 'image') {
      const images = document.createElement('div'); images.className = 'message-images';
      images.append(imagePreview(taskId, sourceFile));
      row.append(images);
    }
    row.append(prompt, runStatus, guidance, skillPanel, planPanel, capabilityFit, testPanel, answer, evidence, details);
    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制回复';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(run.answer || run.error || ''); copy.textContent = '已复制'; }
      catch { showError(new Error('复制失败，请选择回复文本复制')); }
    };
    copy.disabled = run.status === 'running';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新提交';
    retry.title = '将原问题放回输入框，使用当前会话模型再次发送';
    retry.onclick = () => {
      $('prompt').value = run.prompt;
      drawFiles(run.input_file || '');
      if (run.config?.workflow) { openAudit(run.config.workflow.fields, run.prompt); return; }
      $('prompt').focus();
      saveDraft();
    };
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.textContent = '引用回复';
    quote.disabled = run.status === 'running';
    quote.onclick = () => {
      const text = (run.answer || run.error || '').slice(0, 6000).split('\n').map(line => `> ${line}`).join('\n');
      $('prompt').value = `${text}\n\n${$('prompt').value}`.slice(0, 16000);
      void showGraph(false);
      $('prompt').focus();
      saveDraft();
    };
    const saveSkill = document.createElement('button');
    saveSkill.type = 'button';
    saveSkill.textContent = '保存为技能';
    saveSkill.onclick = () => studio?.openFromRun(run);
    const improveSkill = document.createElement('button');
    improveSkill.type = 'button';
    improveSkill.textContent = '改进这个技能';
    const usedSkill = () => run.config?.customSkill ?? run.skillApplications?.findLast(item => item.status === 'applied') ?? run.loadedSkills?.[0];
    improveSkill.onclick = () => studio?.openFromRun(run, usedSkill());
    const experience=document.createElement('button');experience.type='button';experience.onclick=()=>studio?.openExperiences(run);
    function drawStudioActions() {
      const available = studio && run.status === 'completed' && Boolean(run.answer?.trim());
      saveSkill.hidden = !available;
      improveSkill.hidden = !available || !usedSkill();
      experience.hidden=!studio||!run.experience;
      experience.textContent=run.experience?'发现可提炼经验 · '+run.experience.signals.length+' 条线索':'';
    }
    drawStudioActions();
    actions.append(copy, quote, retry, saveSkill, improveSkill,experience);
    row.append(actions);
    transcriptContent.append(row);

    function watch() {
      if (list.childNodes.length) return;
      const stream = new EventSource(`/api/runs/${run.id}/events`);
      if (run.status === 'running') subscription = stream;
      stream.onmessage = message => {
        const event = JSON.parse(message.data);
        if (event.type === 'progress') {
          answer.textContent = event.payload.text || (event.payload.thinking ? '模型正在思考…' : '正在生成回复…');
          return;
        }
        appendEvent(list, event);
        if (event.type === 'capability_fit') {
          run.capabilityFit = event.payload;
          drawCapabilityFit(capabilityFit, run.capabilityFit);
        }
        if (event.type === 'project_test_request' && run.status === 'running') showTestApproval(testPanel, run, event.payload);
        if (event.type === 'project_test_decision' && testPanel.dataset.approval === event.payload.id) {
          delete testPanel.dataset.approval;
          testPanel.hidden = true;
        }
        if (event.type === 'project_test_started' && run.status === 'running') {
          testPanel.textContent = `正在运行项目测试 · ${event.payload.command}`;
          testPanel.hidden = false;
        }
        if (event.type === 'tool_result' && event.payload.name === 'run_project_tests' && run.status === 'running') {
          const {output} = event.payload;
          testPanel.textContent = output.ok ? `${output.data.summary} 耗时 ${(output.data.volatile.elapsedMs / 1000).toFixed(1)} 秒。` : output.error.message;
          testPanel.hidden = false;
        }
        if (event.type === 'skill_route') { run.skillRoute = event.payload; skillPanel.open = true; drawSkillRuntime(); }
        if (event.type === 'skill_runtime') { run.skillTrace = event.payload; drawSkillRuntime();
          if (graphNodes && !$('graph-panel').hidden) drawRunGraph(event.payload);
        }
        if (event.type === 'skill_application') { run.skillApplications ??= []; run.skillApplications.push(event.payload); drawSkillRuntime(); }
        if (event.type === 'skill_applicability') { run.skillApplicability ??= []; run.skillApplicability.push(event.payload); drawSkillRuntime(); }
        if (event.type === 'skill_delivery') { run.skillDeliveries ??= []; run.skillDeliveries.push(event.payload); drawSkillRuntime(); }
        if (event.type === 'skill_session_completed') {
          run.skillTrace = event.payload.trace;
          run.artifacts ??= [];
          if (!run.artifacts.some(file => file.id === event.payload.artifact.id)) run.artifacts.push(event.payload.artifact);
          drawSkillRuntime();
        }
        if (event.type === 'task_plan') {
          run.plan = event.payload;
          planPanel.open = true;
          drawPlan();
        }
        if (event.type === 'tool_result' && event.payload.planStep) {
          run.planReceipts ??= [];
          if (!run.planReceipts.some(receipt => receipt.seq === event.seq)) run.planReceipts.push({
            seq: event.seq, name: event.payload.name, planStep: event.payload.planStep, planRevision: event.payload.planRevision,
            planStepTitle: event.payload.planStepTitle,
            ok: event.payload.output.ok && (event.payload.output.data?.kind !== 'project_tests' || event.payload.output.data.status === 'passed') &&
              (event.payload.output.data?.kind !== 'material_preflight' || event.payload.output.data.status === 'completed'),
            message: ['project_tests', 'material_preflight'].includes(event.payload.output.data?.kind) ? event.payload.output.data.summary :
              event.payload.output.ok ? '调用成功' : event.payload.output.error.message,
          });
          drawPlan();
        }
        if (event.type === 'request_wait') {
          answer.textContent = `服务商${event.payload.status === 429 ? '限流' : '繁忙'}，约 ${Math.max(1, Math.ceil((event.payload.until - Date.now()) / 1000))} 秒后自动重试。可继续发送引导或停止。`;
        }
        if (event.type === 'guidance_received' || event.type === 'guidance_applied') {
          run.guidance ??= [];
          const previous = run.guidance.find(item => item.request === event.payload.request);
          const item = {...event.payload, applied: event.type === 'guidance_applied' || previous?.applied};
          if (previous) Object.assign(previous, item);
          else run.guidance.push(item);
          showGuidance(item);
          if (event.type === 'guidance_applied') answer.textContent = '正在根据补充要求继续…';
        }
        if (event.type === 'skill_completed') {
          run.skill = event.payload;
          run.artifacts = [event.payload.artifact];
          drawSkillEvidence(evidence, taskId, run);
        }
        if (event.type === 'skill_search') {
          run.skillSearch = event.payload;
          drawSkillEvidence(evidence, taskId, run);
        }
        if (event.type === 'custom_skill_loaded') {
          run.loadedSkills ??= [];
          if (!run.loadedSkills.some(skill => skill.id === event.payload.id)) run.loadedSkills.push(event.payload);
        }
        if (event.type === 'audit_plan') answer.textContent = `正在执行计划：${event.payload.rationale}`;
        if (event.type === 'audit_replan') answer.textContent = '正在根据执行结果调整计划…';
        if (event.type === 'audit_completed') {
          run.audit = event.payload; run.artifacts = event.payload.artifacts;
          drawSkillEvidence(evidence, taskId, run);
        }
        if (event.type === 'preflight_completed') {
          run.preflight = event.payload;
          drawSkillEvidence(evidence, taskId, run);
        }
        if (event.type !== 'finished') return;
        stream.close();
        Object.assign(run, event.payload);
        testPanel.hidden = true;
        drawPlan();
        drawSkillRuntime();
        for (const item of run.guidance ?? []) showGuidance(item);
        answer.textContent = [run.answer, run.error].filter(Boolean).join('\n\n') || statusText[run.status];
        drawRunStatus(runStatus, run);
        copy.disabled = quote.disabled = false;
        drawStudioActions();
        void api('/api/skill-studio/experiences?task='+encodeURIComponent(taskId)+'&run='+encodeURIComponent(run.id)).then(data=>{
          if(data.experiences[0]){run.experience=data.experiences[0];drawStudioActions();}
        }).catch(()=>{});
        void api('/api/tasks').then(data => { tasks = data; drawTasks(); }).catch(() => {});
        updateControls();
      };
      stream.onerror = () => { if (run.status !== 'running') stream.close(); };
    }
    if (run.status === 'running') { details.open = true; watch(); }
    else details.addEventListener('toggle', () => { if (details.open) watch(); }, {once: true});
  }
  scrollToLatest();
  updateControls();
}

async function selectTask(id) {
  if (sending || uploading || choosingModel) return;
  saveDraft();
  const version = ++selection;
  loading = !!id;
  updateControls();
  showError();
  try {
    const next = id ? await api(`/api/tasks/${id}`) : null;
    if (version !== selection) return;
    task = next;
    modelChoice = task?.model_id ?? null;
    effortChoice = task?.effort ?? 'default';
    $('selection-status').textContent = '';
    pending = undefined;
    draftKey = task?.id ?? 'new';
    const draftFile = restoreDraft();
    draftReady = true;
    localStorage.setItem('skillinter-task', task?.id ?? '');
    drawTasks();
    void showGraph(false);
    drawTranscript();
    drawFiles(draftFile);
  } catch (error) { if (version === selection) showError(error); }
  finally { if (version === selection) { loading = false; updateControls(); } }
}

$('new').onclick = async () => { await selectTask(); $('prompt').focus(); };
$('prompt').addEventListener('input', saveDraft);
$('analysis-file').addEventListener('change', saveDraft);
window.addEventListener('beforeunload', saveDraft);
$('open-graph').onclick = () => void showGraph($('graph-panel').hidden || $('skill-studio-dialog').open);
$('attach').onclick = () => {
  $('composer-menu').hidePopover();
  $('task-upload').click();
};
$('task-upload').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';
  void uploadFile(file);
};
async function uploadFile(file) {
  if (!file || uploading || sending || loading || task?.archived) return;
  if (file.size > 2 * 1024 * 1024) {
    showError(new Error('单个附件不能超过 2 MB。'));
    return;
  }
  uploading = true;
  showError();
  updateControls();
  try {
    if (!task) {
      task = {...await api('/api/tasks', {}), runs: [], files: []};
      draftKey = task.id;
      localStorage.setItem('skillinter-task', task.id);
      if (modelChoice || effortChoice !== 'default') Object.assign(task, await api(`/api/tasks/${task.id}`, {model_id: modelChoice, effort: effortChoice}, 'PATCH'));
      tasks = await api('/api/tasks');
      drawTasks();
    }
    const response = await fetch(`/api/tasks/${task.id}/files?${new URLSearchParams({name: file.name})}`, {
      method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: file,
    });
    const uploaded = await response.json();
    if (!response.ok) throw new Error(uploaded.error);
    task.files.push(uploaded);
    drawFiles(uploaded.id);
    if (task?.runs.some(run => run.status === 'running')) {
      $('selection-status').textContent = '附件已保存，将从下一轮使用。本轮引导仅发送文字。';
    }
    saveDraft();
    $('prompt').focus();
    return uploaded;
  } catch (error) { showError(error); }
  finally { uploading = false; updateControls(); }
}
$('composer').addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); $('composer').classList.add('file-drag'); }
});
$('composer').addEventListener('dragleave', event => {
  if (!$('composer').contains(event.relatedTarget)) $('composer').classList.remove('file-drag');
});
$('composer').addEventListener('drop', async event => {
  event.preventDefault();
  $('composer').classList.remove('file-drag');
  for (const file of event.dataTransfer.files) await uploadFile(file);
});
$('prompt').addEventListener('paste', async event => {
  const images = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  for (const item of images) {
    const file = item.getAsFile();
    if (file) await uploadFile(file);
  }
});
function showTaskPanel(show) {
  $('task-panel').hidden = !show;
  $('toggle').setAttribute('aria-expanded', show);
  $('workbench').setAttribute('aria-expanded', show);
}
$('toggle').onclick = () => showTaskPanel($('task-panel').hidden);
$('workbench').onclick = () => { showTaskPanel(true); void showGraph(false); $('new').focus(); };
showTaskPanel(!matchMedia('(max-width: 560px)').matches);
$('search').oninput = drawTasks;
$('task-menu').addEventListener('beforetoggle', event => {
  if (event.newState === 'closed') menuTask?.options.setAttribute('aria-expanded', 'false');
});
$('pin-task').onclick = async () => {
  const {id, pinned} = menuTask.item;
  $('task-menu').hidePopover();
  try { await updateTask(id, {pinned: !pinned}); }
  catch (error) { showError(error); }
};
$('archive-task').onclick = async () => {
  const {id} = menuTask.item;
  $('task-menu').hidePopover();
  try { await updateTask(id, {archived: true}); }
  catch (error) { showError(error); }
};
$('export-task').onclick = () => {
  const item = menuTask.item;
  $('task-menu').hidePopover();
  void exportConversation(item).catch(showError);
};
$('model-picker').addEventListener('beforetoggle', event => {
  if (event.newState === 'open') { drawModelChoices(); void loadModels(); }
});
for (const [menuId, anchorId] of [['composer-menu', 'composer-add'], ['model-picker', 'choose-model']]) {
  const menu = $(menuId);
  const place = () => {
    if (!menu.matches(':popover-open')) return;
    const anchor = $(anchorId).getBoundingClientRect();
    const left = menuId === 'model-picker' ? anchor.right - menu.offsetWidth : anchor.left;
    menu.style.left = Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.bottom = innerHeight - anchor.top + 8 + 'px';
  };
  menu.addEventListener('toggle', place);
  window.addEventListener('resize', place);
}
$('model-search').oninput = drawModelChoices;
$('refresh-models').onclick = () => void loadModels(true);
$('thinking').onchange = () => void selectModel(modelChoice, $('thinking').value);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !$('settings-dialog').open && !$('skill-studio-dialog').open) {
    event.preventDefault(); showTaskPanel(true); $('search').focus();
  }
});
$('rename-task').onclick = () => {
  renameTask = menuTask.item.id;
  $('task-name').value = menuTask.item.title;
  $('task-menu').hidePopover();
  dialogError($('rename-dialog'));
  $('rename-dialog').showModal();
  $('task-name').select();
};
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('rename-form').querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  dialogError($('rename-dialog'));
  try { await updateTask(renameTask, {title: $('task-name').value}); $('rename-dialog').close(); }
  catch (error) { dialogError($('rename-dialog'), error); }
  finally { submit.disabled = false; }
};
$('settings').onclick = async () => {
  const load = ++settingsLoad;
  preferences = undefined;
  $('active-mode').textContent = $('active-model').textContent = '—';
  $('archive-search').value = '';
  settingsMessage('model-feedback');
  settingsMessage('run-feedback');
  settingsMessage('settings-load', '正在读取设置…');
  showSettingsPage('model');
  drawModelMode();
  $('settings-dialog').showModal();
  document.querySelector('[data-settings-page="model"]').focus();
  try {
    const data = await api('/api/settings');
    if (load !== settingsLoad) return;
    fillPreferences(data);
    void loadModels();
    settingsMessage('settings-load');
    if (data.envError) settingsMessage('model-feedback', `环境配置不可用：${data.envError}`, 'error');
  } catch (error) {
    if (load !== settingsLoad) return;
    settingsMessage('settings-load', error.message, 'error');
    $('settings-load').hidden = !$('archive-view').hidden;
  }
};
$('close-settings').onclick = () => $('settings-dialog').close();
$('settings-dialog').addEventListener('close', () => { settingsLoad++; $('api-key').value = ''; });
for (const button of document.querySelectorAll('[data-settings-page]')) {
  button.onclick = () => showSettingsPage(button.dataset.settingsPage);
}
$('model-mode').onchange = drawModelMode;
$('clear-key').onchange = () => { if ($('clear-key').checked) $('api-key').value = ''; drawModelMode(); };
$('test-model').onclick = () => void applyPreferences(true);
$('model-form').onsubmit = event => { event.preventDefault(); void applyPreferences(false); };
$('reset-run').onclick = () => {
  $('max-steps').value = preferences.defaultSteps;
  settingsMessage('run-feedback', '已填入默认值，保存后生效。');
};
$('run-form').onsubmit = async event => {
  event.preventDefault();
  if (!preferences || savingPreferences) return;
  savingPreferences = true;
  drawModelMode();
  settingsMessage('run-feedback', '正在保存…');
  try {
    preferences = await api('/api/settings', {revision: preferences.revision, maxSteps: $('max-steps').valueAsNumber}, 'PATCH');
    $('max-steps').value = preferences.maxSteps;
    settingsMessage('run-feedback', '已保存，从下一轮执行起生效。');
  } catch (error) { settingsMessage('run-feedback', error.message, 'error'); }
  finally { savingPreferences = false; drawModelMode(); }
};
$('archive-search').oninput = drawArchive;
$('prompt').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (event.altKey || event.metaKey || event.shiftKey) return;
  if (event.ctrlKey) {
    const input = event.currentTarget;
    const {selectionStart: start, selectionEnd: end} = input;
    if (input.value.length - (end - start) < input.maxLength) input.setRangeText('\n', start, end, 'end');
  } else if (!event.repeat && !$('send').disabled) {
    $('composer').requestSubmit();
  }
});
async function submitRun(prompt, diagnostic = false, workflow = null, auditMode = null, expandedBudget = false) {
  const imageOnly = !prompt && !diagnostic && !workflow && task?.files.find(file => file.id === $('analysis-file').value)?.kind === 'image';
  if ((!prompt && !imageOnly) || sending || choosingModel || uploading || loading || task?.archived) return;
  const running = task?.runs.find(run => run.status === 'running');
  if (running) {
    if (imageOnly) { $('selection-status').textContent = '图片已保存，将从下一轮使用。'; return; }
    if (!diagnostic) await submitGuidance(running, prompt);
    return;
  }
  const selection = $('analysis-file').value || null;
  const file = diagnostic ? null : selection;
  const skillId = diagnostic || workflow ? null : selectedSkill?.id ?? null;
  const skillVersion = skillId ? selectedSkill.version : null;
  if (skillId && !modelConnected) {
    showError(new Error('请先在「设置 → 模型」连接 API，再使用对话技能。'));
    return;
  }
  if (!diagnostic && !file && !modelConnected) {
    showError(new Error('请先在「设置 → 模型」连接 API。也可以使用本地材料预检。'));
    return;
  }
  sending = true;
  showError();
  updateControls();
  try {
    if (!task) {
      task = {...await api('/api/tasks', {}), runs: []};
      draftKey = task.id;
      localStorage.setItem('skillinter-task', task.id);
    }
    if ((task.model_id ?? null) !== modelChoice || (task.effort ?? 'default') !== effortChoice) {
      Object.assign(task, await api(`/api/tasks/${task.id}`, {model_id: modelChoice, effort: effortChoice}, 'PATCH'));
    }
    if (pending?.prompt !== prompt || pending.file !== file || pending.diagnostic !== diagnostic || (pending.skillId ?? null) !== skillId || (pending.skillVersion ?? null) !== skillVersion ||
        pending.selectedModel !== modelChoice || pending.selectedEffort !== effortChoice || pending.auditMode !== auditMode || Boolean(pending.expandedBudget) !== expandedBudget || JSON.stringify(pending.workflow) !== JSON.stringify(workflow)) {
      pending = {request: crypto.randomUUID(), prompt, file, diagnostic, workflow, auditMode, expandedBudget, selectedModel: modelChoice, selectedEffort: effortChoice, ...(skillId ? {skillId, skillVersion} : {})};
    }
    await api(`/api/tasks/${task.id}/runs`, pending);
    if (skillId) selectedSkill = null;
    if (workflow) $('audit-dialog').close();
    task = await api(`/api/tasks/${task.id}`);
    if ($('selection-status').textContent.startsWith('附件已保存')) $('selection-status').textContent = '';
    if (!diagnostic) {
      $('prompt').value = '';
      try { localStorage.removeItem('sih-draft-new'); } catch { /* Browser storage is optional. */ }
    }
    pending = undefined;
    void showGraph(false);
    drawTranscript();
    drawFiles('');
    saveDraft();
    tasks = await api('/api/tasks');
    drawTasks();
  } catch (error) { showError(error); }
  finally { sending = false; updateControls(); }
}
async function submitGuidance(run, prompt) {
  if (prompt.length > 4000) { showError(new Error('单条引导最多 4000 字')); return; }
  sending = true;
  updateControls();
  showError();
  if (pendingGuidance?.run !== run.id || pendingGuidance.prompt !== prompt) {
    pendingGuidance = {run: run.id, prompt, request: crypto.randomUUID()};
  }
  try {
    await api(`/api/runs/${run.id}/guide`, {request: pendingGuidance.request, prompt});
    $('prompt').value = '';
    pendingGuidance = undefined;
    saveDraft();
    $('selection-status').textContent = '引导已提交，将用于后续生成';
    $('prompt').focus();
  } catch (error) { showError(error); }
  finally { sending = false; updateControls(); }
}
$('composer').onsubmit = event => {
  event.preventDefault();
  void submitRun($('prompt').value.trim());
};
$('try-tool').onclick = () => {
  $('composer-menu').hidePopover();
  void submitRun('列出工作区文件', true);
};
$('stop').onclick = async () => {
  const run = task?.runs.find(item => item.status === 'running');
  if (!run) return;
  $('stop').disabled = true;
  try { await api(`/api/runs/${run.id}/stop`, {}); }
  catch (error) { showError(error); }
  finally { $('stop').disabled = false; }
};

function auditField(field = {name: '', type: 'number', required: true}) {
  const row = document.createElement('tr');
  for (const key of ['name', 'type', 'required', 'unit', 'minimum', 'maximum']) {
    const td = document.createElement('td');
    let input;
    if (key === 'type') { input = document.createElement('select'); input.append(...['string', 'number', 'integer'].map(type => new Option({string: '文本', number: '数值', integer: '整数'}[type], type))); }
    else { input = document.createElement('input'); input.type = key === 'required' ? 'checkbox' : ['minimum', 'maximum'].includes(key) ? 'number' : 'text'; }
    input.dataset.key = key; input.setAttribute('aria-label', key);
    if (input.type === 'checkbox') input.checked = field[key] ?? false;
    else input.value = field[key] ?? '';
    if (key === 'name') { input.required = true; input.maxLength = 100; }
    if (key === 'unit') input.maxLength = 40;
    if (input.type === 'number') input.step = 'any';
    td.append(input); row.append(td);
  }
  const td = document.createElement('td'), remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除字段'); remove.onclick = () => row.remove(); td.append(remove); row.append(td);
  $('audit-fields').append(row);
}
function openAudit(fields, goal) {
  const file = task?.files.find(file => file.id === $('analysis-file').value);
  $('audit-source').textContent = file ? `当前输入：${file.name}` : '请先添加并选择 CSV 附件，也可载入示例。';
  $('audit-goal').value = goal ?? ($('prompt').value.trim() || '统一质量为 mg，检查样本编号缺失、质量类型和非负范围');
  $('audit-fields').replaceChildren();
  for (const field of fields ?? task?.runs.findLast(run => run.config?.workflow)?.config.workflow.fields ?? [
    {name: 'sample_id', type: 'string', required: true}, {name: 'mass', type: 'number', required: true, unit: 'mg', minimum: 0}]) auditField(field);
  $('audit-error').hidden = true;
  $('audit-dialog').showModal();
  updateControls();
}
let preflightPending;
const preflightDialog = $('preflight-dialog');
const canPreflightProject = () => Boolean(task?.project_id && task.file_access !== 'attachments');

function drawPreflightOptions() {
  const project = $('preflight-source').value === 'project';
  const count = task?.files?.length ?? 0;
  $('preflight-paths-row').hidden = !project;
  $('preflight-add').hidden = project;
  $('preflight-add').disabled = uploading;
  $('preflight-access').hidden = !project || canPreflightProject() || !projectsAvailable;
  $('preflight-coverage').textContent = project
    ? canPreflightProject() ? '留空时扫描目录两层，检查最多 20 份材料，每份最多 1 MiB。' : '请先绑定项目并开启读取权限。'
    : count ? '本轮检查会话中的 ' + count + ' 个附件。' : '请先添加本次要检查的材料。';
  $('preflight-start').disabled = sending || uploading || loading || !!task?.archived ||
    !!task?.runs.some(run => run.status === 'running') || (project ? !canPreflightProject() : !count);
}

$('open-audit').onclick = () => {
  $('preflight-source').value = task?.files?.length || !canPreflightProject() ? 'attachments' : 'project';
  $('preflight-paths').value = '';
  dialogError(preflightDialog);
  preflightDialog.showModal();
  drawPreflightOptions();
};
$('close-preflight').onclick = () => preflightDialog.close();
$('preflight-source').onchange = drawPreflightOptions;
$('preflight-access').onclick = () => { preflightDialog.close(); $('open-file-access').click(); };
$('preflight-add').onclick = () => { preflightDialog.close(); $('task-upload').click(); };
$('preflight-form').onsubmit = async event => {
  event.preventDefault();
  if ($('preflight-start').disabled || !task) return;
  const preflight = {source: $('preflight-source').value, goal: $('preflight-goal').value,
    paths: $('preflight-source').value === 'project' ? $('preflight-paths').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean) : []};
  const title = $('preflight-goal').selectedOptions[0].textContent;
  const key = JSON.stringify({task: task.id, preflight});
  if (preflightPending?.key !== key) preflightPending = {key, request: crypto.randomUUID()};
  sending = true;
  dialogError(preflightDialog);
  updateControls();
  try {
    await api('/api/tasks/' + task.id + '/preflight', {request: preflightPending.request, prompt: '材料预检 · ' + title, preflight});
    task = await api('/api/tasks/' + task.id);
    preflightPending = undefined;
    preflightDialog.close();
    void showGraph(false);
    drawTranscript();
    tasks = await api('/api/tasks');
    drawTasks();
  } catch (error) { dialogError(preflightDialog, error); }
  finally { sending = false; updateControls(); }
};
$('close-audit').onclick = () => $('audit-dialog').close();
$('offline-audit').onclick = async () => {
  const button = $('offline-audit');
  button.disabled = true;
  try {
    const demo = await api('/api/demo', {variant: $('offline-audit-variant').value});
    tasks = await api('/api/tasks');
    $('audit-dialog').close();
    await selectTask(demo.task);
  } catch (error) {
    $('audit-error').textContent = error.message;
    $('audit-error').hidden = false;
  } finally { button.disabled = false; }
};
$('add-audit-field').onclick = () => { if ($('audit-fields').children.length < 40) auditField(); };
$('audit-example').onclick = async () => {
  $('audit-example').disabled = true;
  try {
    const file = await uploadFile(new File(['sample_id,mass_g\nS01,0.012\nS02,-0.005\n,abc\nS04,\n'], 'precheck-example.csv', {type: 'text/csv'}));
    if (file?.kind === 'csv') { drawFiles(file.id); $('audit-source').textContent = `当前输入：${file.name}`; }
    else if (!$('error').hidden) { $('audit-error').textContent = $('error').textContent; $('audit-error').hidden = false; }
  } finally { $('audit-example').disabled = false; }
};
$('audit-form').onsubmit = async event => {
  event.preventDefault();
  if (task?.runs.some(run => run.status === 'running')) {
    $('audit-error').textContent = '当前任务正在运行，请等待结束或停止执行后发起预检。';
    $('audit-error').hidden = false;
    return;
  }
  const fields = [...$('audit-fields').children].map(row => {
    const field = {};
    for (const input of row.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      if (key === 'required') field[key] = input.checked;
      else if (input.value.trim()) field[key] = input.type === 'number' ? Number(input.value) : input.value.trim();
    }
    return field;
  });
  const rules = event.submitter?.id === 'rules-audit';
  const error = !fields.length ? '至少添加一个目标字段' : task?.files.find(file => file.id === $('analysis-file').value)?.kind !== 'csv' ? '请先选择 CSV 附件，图片和 TXT 不能用于表格预检' :
    !rules && !modelConnected ? '请先在设置中连接模型 API，或使用规则预检' : '';
  $('audit-error').textContent = error; $('audit-error').hidden = !error;
  if (error) return;
  $('start-audit').disabled = true;
  $('rules-audit').disabled = true;
  try {
    await submitRun($('audit-goal').value.trim(), false, {fields}, rules ? 'rules' : null);
    if ($('audit-dialog').open && !$('error').hidden) { $('audit-error').textContent = $('error').textContent; $('audit-error').hidden = false; }
  } finally { updateControls(); }
};

try {
  loading = true;
  updateControls();
  const [status, history, directory] = await Promise.all([api('/api/status'), api('/api/tasks'), api('/api/projects').catch(() => null)]);
  projectsAvailable = Array.isArray(directory);
  projects = directory ?? [];
  $('model').textContent = status.model;
  modelConnected = status.connected;
  void loadModels();
  tasks = history;
  const saved = localStorage.getItem('skillinter-task');
  await selectTask(tasks.find(item => item.id === saved)?.id);
  if (!task && selection === 1) void showGraph(true);
} catch (error) { showError(error); loading = false; updateControls(); }
