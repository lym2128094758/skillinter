const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value ?? '';
  if (className) element.className = className;
  return element;
};
const button = (label, handler) => {
  const element = text('button', label); element.type = 'button'; element.onclick = handler; return element;
};
const labels = {planned: '候选，未执行', loaded: '指南已加载，未执行', running: '正在应用', applied: '已应用，有回执', blocked: '条件不足', failed: '应用失败', interrupted: '已停止', unfinished: '未记录完成'};
export function graphHighlightIds(trace, knownIds) {
  return [...new Set(trace.graph.nodes.filter(node => trace.kind !== 'skill-session' || node.started)
    .map(node => node.nodeId).filter(id => knownIds.has(id)))];
}
export function renderSkillRuntime(container, run, {taskId, onGraph, onOpen, onRevise, onCapture, onReceipt}) {
  const route = run.skillRoute, trace = run.skillTrace;
  const nodes = trace?.graph.nodes ?? [];
  container.hidden = !route && !nodes.length;
  if (container.hidden) return;
  const body = text('div', '', 'skill-runtime-body');
  const applied = nodes.filter(node => node.state === 'applied').length;
  const summary = text('summary', '技能链 · ' + nodes.length + ' 项 · ' + applied + ' 项已应用');
  body.append(text('p', '按任务检索本机及公开技能，由模型选择；依赖影响先后，互补仅作建议。', 'status'));
  if (!nodes.length) body.append(text('p', route?.emptyReason || '本次没有采用已安装技能。', 'status'));
  if (route?.rejected?.length) {
    const excluded = text('details'); excluded.append(text('summary', '未采用的相关技能 · ' + route.rejected.length));
    for (const item of route.rejected) excluded.append(text('p', item.name + ' · ' + item.reasons.join('；'), 'status'));
    body.append(excluded);
  }
  for (const node of nodes) {
    const card = text('section', '', 'skill-runtime-card');
    card.dataset.skillId = node.id; card.dataset.state = node.state;
    const selected = route?.candidates.find(item => item.id === node.id);
    card.append(text('strong', node.label + ' · v' + node.version), text('p', labels[node.state] ?? node.state, 'status'),
      text('p', selected?.reason || node.reason, 'status'));
    if (node.summary) card.append(text('p', node.summary, 'status'));
    const fit = run.skillApplicability?.findLast(item => item.id === node.id) ?? selected?.applicability;
    if (fit) {
      const names = {passed: '声明的适用条件已满足', failed: '适用条件不满足', unknown: '适用性信息不足', unspecified: '未声明机器检查条件'};
      const conditions = text('details');
      conditions.open = ['failed', 'unknown'].includes(fit.status);
      conditions.append(text('summary', names[fit.status]));
      for (const check of fit.checks) conditions.append(text('p', ({passed: '通过', failed: '不满足', unknown: '待补充'}[check.status]) + ' · ' + check.message, 'status'));
      for (const input of fit.inputs) conditions.append(text('p', input.path + ' · ' + input.format + ' · SHA-256 ' + input.sha256, 'status'));
      conditions.append(text('p', '此检查覆盖当前声明和输入，不是技能收益评测。', 'status'));
      card.append(conditions);
    }
    const readiness = selected?.readiness;
    const delivery = run.skillDeliveries?.findLast(item => item.id === node.id);
    if (delivery) {
      const names = {passed: '产物验收通过（声明范围）', failed: '产物验收未通过', unknown: '产物验收证据不足', unspecified: '未声明产物验收条件'};
      const checks = text('details'); checks.open = ['failed', 'unknown'].includes(delivery.status);
      checks.append(text('summary', names[delivery.status]));
      for (const check of delivery.checks) checks.append(text('p', ({passed: '通过', failed: '未通过', unknown: '未确认'}[check.status]) + ' · ' + check.path + ' · ' + check.message, 'status'));
      for (const file of delivery.files) checks.append(text('p', file.path + ' · SHA-256 ' + file.sha256, 'status studio-file-path'));
      checks.append(text('p', '由宿主重新读取文件核验；只覆盖该版本执行前声明的条件，不代表整体目标或技能收益已确认。', 'status'));
      card.append(checks);
    }
    if (readiness) {
      card.append(text('p', readiness.status === 'ready' ? '已声明的条件检查通过' : readiness.status === 'blocked' ? '执行条件不足' : '尚未声明环境条件，须按实际任务核验', 'status'));
      for (const missing of readiness.missing) card.append(text('p', missing, 'status'));
      const checks = text('details'); checks.append(text('summary', '执行条件与资源检查'));
      for (const check of readiness.checks) checks.append(text('p', check, 'status'));
      for (const resource of selected?.resources ?? []) checks.append(text('p', resource.path + ' · ' + resource.size + ' 字节', 'status'));
      if (selected?.resourcesTruncated) checks.append(text('p', '此处仅展示部分资源，可通过 inspect_skill 继续查看。', 'status'));
      card.append(checks);
    }
    if (node.evidence?.length) {
      const receipts = text('div', '', 'actions');
      for (const seq of node.evidence) receipts.append(button('查看回执 ' + seq, () => onReceipt(seq)));
      card.append(receipts);
    }
    card.append(button('查看指南', () => onOpen(node.id)));
    body.append(card);
  }
  const relationLabels = {depend_on: '依赖', compose_with: '互补',similar_to:'可替代'};
  const relationName=id=>route?.registrySnapshot?.skills.find(skill=>skill.skillId===id)?.name??id;
  if (route?.relations.length) body.append(text('p', route.relations.map(edge => relationName(edge.source) + ' ' + relationLabels[edge.type] + ' ' + relationName(edge.target)).join('；'), 'status'));
  for (const warning of route?.warnings ?? []) body.append(text('p', warning, 'status'));
  for (const missing of route?.missingDependencies ?? []) body.append(text('p', missing.skill + ' 的目录前置技能尚未安装：' + missing.dependency, 'status'));
  if (route?.alternatives.length) body.append(text('p', '可替代候选：' + route.alternatives.join('、'), 'status'));
  const actions = text('div', '', 'actions');
  if(route?.registrySnapshot){
    const snapshot=route.registrySnapshot, frozen=text('details');
    frozen.append(text('summary','本轮冻结的技能关系 · '+snapshot.revision.slice(0,12)),
      text('p','固定 '+snapshot.skills.length+' 个技能身份与 '+snapshot.relations.length+' 条关系；后续图谱编辑不改变此记录。','status'));
    const download=text('a','查看完整关系快照');download.href='/api/runs/'+run.id+'/skill-registry';download.target='_blank';download.rel='noopener';frozen.append(download);body.append(frozen);
  }
  if (trace) actions.append(button('查看实际技能路径', () => onGraph(trace)));
  actions.append(button('调整计划', onRevise));
  if (run.status === 'completed' && applied) actions.append(button('沉淀此次方法', onCapture));
  const artifact = run.artifacts?.find(file => file.name === 'skill-execution.json');
  if (artifact) {
    const link = text('a', '下载技能执行记录');
    link.href = '/api/tasks/' + taskId + '/files/' + artifact.id; link.download = artifact.name; actions.append(link);
  }
  body.append(actions, text('p', '“已应用”记录 Agent 报告和实际工具回执；结果是否正确仍须按任务验收。', 'status'));
  const oldSummary = container.querySelector(':scope > summary');
  if (oldSummary) oldSummary.replaceWith(summary); else container.append(summary);
  const oldBody = container.querySelector(':scope > .skill-runtime-body');
  if (oldBody) oldBody.replaceWith(body); else container.append(body);
}
