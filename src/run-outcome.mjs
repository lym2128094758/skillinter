// One projection for HTTP history and live browser events. Execution ending is
// separate from passing the explicitly declared output checks.
export function canDraftFromRun(run) {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(run.status) &&
    Boolean(run.answer?.trim() || run.error?.trim() || run.skillDeliveries?.length || run.planReceipts?.length);
}

export function summarizeRun(run) {
  const latest = rows => [...new Map((rows ?? []).map(row => [row.id, row])).values()];
  const deliveries = latest(run.skillDeliveries);
  const checks = deliveries.filter(item => item.status !== 'unspecified');
  if (run.citationVerification) checks.push(run.citationVerification);
  const counts = {passed: checks.filter(item => item.status === 'passed').length,
    failed: checks.filter(item => item.status === 'failed').length,
    unknown: checks.filter(item => !['passed', 'failed'].includes(item.status)).length,
    unfinishedSteps: (run.plan?.steps ?? []).filter(item => item.status !== 'completed').length,
    unappliedSkills: 0};
  const applied = new Map(latest(run.skillApplications).map(item => [item.id, item.status]));
  const nodes = run.skillTrace?.graph?.nodes ?? run.skillRoute?.candidates ?? [];
  const pending = nodes.filter(item => applied.get(item.id) !== 'applied');
  counts.unappliedSkills = pending.length;
  const blockers = [];
  for (const item of deliveries.filter(item => ['failed', 'unknown'].includes(item.status))) {
    blockers.push({code: item.status === 'failed' ? 'DELIVERY_FAILED' : 'DELIVERY_UNKNOWN', skillId: item.id,
      message: (item.name ?? item.id) + '：' + (item.status === 'failed' ? '产物未通过' : '产物未确认')});
  }
  if (run.citationVerification && run.citationVerification.status !== 'passed') blockers.push({code: 'CITATION_NOT_PASSED', message: '引用原文尚未核验通过。'});
  if (counts.unfinishedSteps) blockers.push({code: 'PLAN_INCOMPLETE', message: counts.unfinishedSteps + ' 个计划步骤未完成。'});
  if (pending.length) blockers.push({code: 'SKILL_INCOMPLETE', message: pending.length + ' 个所选技能未确认应用。'});
  const result = (status, label) => ({status, label, counts, blockers, scope: 'declared-checks'});
  if (run.status === 'running') return result('running', '执行中');
  if (['stopped', 'interrupted'].includes(run.status)) return result(run.status, run.status === 'stopped' ? '已停止' : '已中断');
  if (run.status === 'failed' || counts.failed) return result('failed', run.status === 'failed' ? '执行失败' : '回复结束 · 交付未通过');
  if (run.status !== 'completed') return result('incomplete', '尚未完成');
  if (counts.unknown) return result('unverified', '回复结束 · 交付待核验');
  if (counts.unfinishedSteps || pending.length) return result('incomplete', '回复结束 · 任务未收尾');
  if (checks.length) return result('verified', '声明的交付条件已通过');
  return result('unverified', nodes.length ? '回复完成 · 未声明产物验收' : '回复完成');
}
