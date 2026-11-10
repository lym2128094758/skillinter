const labels = {pending: '待处理', in_progress: '进行中', completed: '已完成', blocked: '受阻'};
const text = (tag, content) => {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
};

export function renderTaskPlan(container, run, taskId) {
  container.hidden = !run.plan;
  if (!run.plan) return;
  const plan = run.plan;
  const summary = text('summary', '任务计划 · ' + plan.steps.filter(step => step.status === 'completed').length +
    '/' + plan.steps.length + ' · 第 ' + plan.revision + ' 版');
  const body = document.createElement('div');
  body.className = 'task-plan-body';
  body.append(text('p', run.prompt));
  if (plan.explanation) body.append(text('p', plan.explanation));
  const unfinished = plan.steps.some(step => step.status !== 'completed');
  if (unfinished && run.status !== 'running') body.append(text('p', '本轮已结束，计划仍有未完成步骤。'));
  const list = document.createElement('ol');
  for (const step of plan.steps) {
    const row = document.createElement('li');
    row.dataset.status = step.status;
    row.append(text('strong', labels[step.status] + ' · ' + step.title));
    if (step.depends_on.length) row.append(text('p', '前置步骤 · ' + step.depends_on.join('、')));
    const receipts = (run.planReceipts ?? []).filter(receipt => receipt.planStep === step.id && receipt.name !== 'update_plan' &&
      receipt.planStepTitle === step.title);
    const details = document.createElement('details');
    details.append(text('summary', receipts.length ? receipts.length + ' 个工具回执' : '暂无工具回执'));
    for (const receipt of receipts) details.append(text('p', receipt.name + ' · ' + receipt.message + ' · 计划第 ' + receipt.planRevision + ' 版'));
    row.append(details);
    list.append(row);
  }
  body.append(list);
  const note = text('p', '步骤状态由 Agent 更新，回执记录实际调用结果。');
  note.className = 'status';
  body.append(note);
  if (run.artifacts?.length) {
    const artifacts = document.createElement('div');
    artifacts.className = 'actions';
    for (const file of run.artifacts) {
      const link = text('a', file.name);
      link.href = '/api/tasks/' + taskId + '/files/' + file.id;
      link.download = file.name;
      artifacts.append(link);
    }
    body.append(artifacts);
  }
  const existingSummary = container.querySelector(':scope > summary');
  if (existingSummary) existingSummary.replaceWith(summary);
  else container.append(summary);
  const existingBody = container.querySelector(':scope > .task-plan-body');
  if (existingBody) existingBody.replaceWith(body);
  else container.append(body);
}
