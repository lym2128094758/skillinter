import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {RequestError} from './store.mjs';
import {createSkillExecutions, executionCaseId, executionSha256, packageSnapshot} from './skill-execution.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const document = ({name, description, instructions, tests, applicability, delivery}) => ({name, description, instructions, tests,
  ...(applicability ? {applicability} : {}), ...(delivery ? {delivery} : {})});
const passed = result => !result.truncated && Boolean(result.output.trim()) && result.checks.length > 0 && result.checks.every(check => check.status === 'passed');
const evaluatorSha256 = digest(['skill-candidates.mjs', 'skill-studio.mjs', 'schema.mjs'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')));

// Candidates are immutable snapshots. Their trial results never update routing weights.
export function createSkillCandidates(store, {studio, cleanDraft, projectFor, evidence, trial}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_candidates (
    id TEXT PRIMARY KEY, project_id TEXT, skill_id TEXT, base_version INTEGER NOT NULL,
    snapshot TEXT NOT NULL, sha256 TEXT NOT NULL, source_task_id TEXT, source_run_id TEXT,
    created_at TEXT NOT NULL, published_skill_id TEXT, published_version INTEGER
  );
  CREATE TABLE IF NOT EXISTS skill_candidate_trials (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    owner INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS candidate_running ON skill_candidate_trials(candidate_id) WHERE status='running';
  CREATE TABLE IF NOT EXISTS skill_candidate_releases (
    candidate_id TEXT PRIMARY KEY, evidence TEXT NOT NULL
  );`);

  function publicationEvidence(candidate, textTrial) {
    const actual = store.query(`SELECT t.id, t.status, t.record, p.id AS plan_id, p.snapshot, p.sha256
      FROM skill_execution_trials t JOIN skill_execution_plans p ON p.id=t.plan_id AND p.candidate_id=t.candidate_id
      WHERE t.candidate_id=? ORDER BY t.rowid DESC LIMIT 1`, 'get', candidate.id);
    if (actual) {
      const record = JSON.parse(actual.record);
      const plan = JSON.parse(actual.snapshot);
      if (actual.status !== 'completed') {
        return {reason: '最新实际任务对照未证明增益，保留原版本。'};
      }
      if (plan.executionSha256 !== executionSha256 || record.executionSha256 !== executionSha256 ||
          record.planSha256 !== actual.sha256 || digest(plan) !== actual.sha256 ||
          plan.candidateSha256 !== candidate.sha256 || plan.baselineSha256 !== candidate.baselineSha256) {
        return {reason: '实际任务证据与当前执行实现或候选快照不一致，请重新冻结并验证。'};
      }
      const cases = new Map(plan.spec.cases.map((sample, index) => [executionCaseId(sample), record.pairs[index]?.candidate?.status]));
      if (candidate.regressionCases.some(sample => cases.get(sample.id) !== 'passed')) {
        return {reason: '历史回归用例尚未全部通过，不能发布。'};
      }
      if (record.verdict !== 'improved') return {reason: '最新实际任务对照未证明增益，保留原版本。'};
      if (textTrial?.status === 'running' || textTrial?.regressed || textTrial?.verdict === 'failed') {
        return {reason: '最新文本验证仍在运行或有未通过项，请先处理后再发布。'};
      }
      return {proof: {scope: 'isolated-file-execution', candidateId: candidate.id, trialId: actual.id, planId: actual.plan_id,
        planSha256: actual.sha256, executionSha256, model: record.requestedModel, verdict: record.verdict,
        baselinePassed: record.baselinePassed, candidatePassed: record.candidatePassed, total: record.total,
        improvedCases: record.improvedCases, regressionCount: candidate.regressionCases.length}, resources: plan.resources};
    }
    if (candidate.regressionCases.length) return {reason: '此技能已有历史回归用例，请先完成实际任务对照。'};
    if (textTrial?.status !== 'completed' || textTrial.verdict !== 'improved') {
      return {reason: '最新验证没有可发布的改进证据，保留原版本。'};
    }
    if (textTrial.contract.evaluatorSha256 !== evaluatorSha256) {
      return {reason: '验证实现已变化，请重新运行冻结用例后再发布。'};
    }
    return {proof: {scope: 'text-only', candidateId: candidate.id, trialId: textTrial.id, verdict: textTrial.verdict,
      baselinePassed: textTrial.baselinePassed, candidatePassed: textTrial.candidatePassed, total: textTrial.total,
      improvedCases: textTrial.improvedCases}};
  }

  function get(id, context) {
    const row = store.query('SELECT * FROM skill_candidates WHERE id=? AND (project_id IS NULL OR project_id=?)', 'get', id, projectFor(context));
    if (!row) throw new RequestError(404, '当前范围内没有该候选。');
    const trials = store.query('SELECT id, status, record FROM skill_candidate_trials WHERE candidate_id=? ORDER BY rowid DESC', 'all', id)
      .map(row => ({id: row.id, status: row.status, ...JSON.parse(row.record)}));
    const actual=store.query('SELECT id,status,record FROM skill_execution_trials WHERE candidate_id=? ORDER BY rowid DESC LIMIT 1','get',id);
    const actualRecord=actual?JSON.parse(actual.record):null;
    const candidate = {id: row.id, projectId: row.project_id, skillId: row.skill_id, baseVersion: row.base_version,
      sha256: row.sha256, createdAt: row.created_at, sourceTaskId: row.source_task_id, sourceRunId: row.source_run_id,
      publishedSkillId: row.published_skill_id, publishedVersion: row.published_version, ...JSON.parse(row.snapshot), trials,
      regressionCases: executions.regressionsFor(row.skill_id).map(({id, sample, version, trialId, source}) => ({id, name: sample.name, version, trialId, source})),
      executionEvidence:actual?{id:actual.id,status:actual.status,verdict:actualRecord.verdict,reason:actualRecord.reason}:null};
    if (!candidate.publishedVersion) {
      const evidence = publicationEvidence(candidate, trials[0]);
      candidate.publication = evidence.proof ? {proof: evidence.proof} : {reason: evidence.reason};
    }
    return candidate;
  }
  function current(candidate, context) {
    if (!candidate.skillId) return null;
    const skill = studio.get(candidate.skillId, context);
    if (skill.version !== candidate.baseVersion || digest(document(skill)) !== candidate.baselineSha256) {
      throw new RequestError(409, '正式技能已变化，请基于当前版本另存候选并重新验证。');
    }
    return skill;
  }
  function save({context, taskId = null, sourceRunId = null, skillId, baseVersion, draft, targetScope, parentCandidateId}) {
    const candidate = cleanDraft(draft);
    const baseline = skillId ? studio.get(skillId, context) : null;
    if (!Number.isSafeInteger(baseVersion) || baseVersion !== (baseline?.version ?? 0)) throw new RequestError(409, '技能版本已更新，请重新读取后保存候选。');
    if (targetScope !== undefined && !['global', 'project'].includes(targetScope)) throw new RequestError(422, '候选保存范围无效。');
    const projectId = baseline ? baseline.projectId : targetScope === 'global' ? null : projectFor(context);
    if (targetScope === 'project' && !projectId) throw new RequestError(422, '请先选择目标项目。');
    const parent = parentCandidateId ? get(parentCandidateId, context) : null;
    const source = sourceRunId ? evidence(taskId, sourceRunId) : parent?.sourceEvidence ?? null;
    const sourceTaskId = sourceRunId ? taskId : parent?.sourceTaskId ?? null;
    sourceRunId ??= parent?.sourceRunId ?? null;
    if (baseline && candidate.name !== baseline.name) throw new RequestError(422, '改进候选须保留原技能名称；新方法请另建技能。');
    const suite = [...new Map([...(baseline?.tests ?? []), ...candidate.tests].map(test => [digest(test), test])).values()];
    if (suite.length < 2) throw new RequestError(422, '请至少提供两个独立用例，覆盖正常情况和适用边界。');
    if (new Set(suite.map(test => key(test.prompt))).size !== suite.length) throw new RequestError(422, '同一提示不能重复计为独立用例。');
    const sources = source ? [source.selected.prompt, ...source.preceding.map(item => item.prompt), ...source.subsequentUserMessages.map(item => item.text)] : [];
    const overlaps = test => sources.some(prompt => key(test.prompt) === key(prompt));
    if (candidate.tests.some(overlaps)) throw new RequestError(422, '来源对话不能直接充当新验证用例，请另写自包含样例。');
    if (suite.some(test => !test.expectations.length)) throw new RequestError(422, '每个用例都需要验收条件。');
    const snapshot = {draft: candidate, baseline: baseline ? document(baseline) : null,
      baselineSha256: baseline ? digest(document(baseline)) : null,
      suite: suite.map(test => ({...test, sourceOverlap: overlaps(test)})), sourceEvidence: source,
      parentCandidateId: parent?.id ?? null,
      scope: 'text-only', limitation: '只比较冻结文本用例；不执行工具，不证明跨任务收益，也不调整正式排序。'};
    const hash = digest({projectId, skillId: skillId ?? null, baseVersion, snapshot});
    const existing = store.query('SELECT id FROM skill_candidates WHERE sha256=?', 'get', hash);
    if (existing) return get(existing.id, context);
    const id = randomUUID();
    store.query('INSERT INTO skill_candidates (id,project_id,skill_id,base_version,snapshot,sha256,source_task_id,source_run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      'run', id, projectId, skillId ?? null, baseVersion, JSON.stringify(snapshot), hash, sourceTaskId, sourceRunId, new Date().toISOString());
    return get(id, context);
  }
  async function evaluate({id, context, model, signal}) {
    const candidate = get(id, context);
    if (candidate.publishedSkillId) throw new RequestError(409, '此候选已发布，请从当前版本创建新的候选。');
    current(candidate, context);
    if (!model?.invoke) throw new RequestError(409, '请先连接可用的模型。');
    const contract = {candidateSha256: candidate.sha256, baselineSha256: candidate.baselineSha256,
      suiteSha256: digest(candidate.suite), evaluatorSha256, baseVersion: candidate.baseVersion, model: model.label, scope: 'text-only', policyVersion: 1,
      maxOutputTokens: [4096, 8192], timeoutMs: 180000, order: 'alternate-baseline-candidate'};
    const trialId = randomUUID(), startedAt = new Date().toISOString();
    const record = {contract, startedAt, pairs: [], verdict: 'unknown', reason: '验证尚未完成。'};
    store.transaction(() => {
      const running = store.query("SELECT id, owner, started_at FROM skill_candidate_trials WHERE candidate_id=? AND status='running'", 'get', id);
      if (running) {
        let alive = true; try { process.kill(running.owner, 0); } catch { alive = false; }
        if (alive && Date.now() - Date.parse(running.started_at) < 240000) throw new RequestError(409, '此候选正在验证，请等待完成。');
        store.query("UPDATE skill_candidate_trials SET status='interrupted',finished_at=? WHERE id=?", 'run', startedAt, running.id);
      }
      store.query('INSERT INTO skill_candidate_trials (id,candidate_id,started_at,owner,status,record) VALUES (?,?,?,?,?,?)',
        'run', trialId, id, startedAt, process.pid, 'running', JSON.stringify(record));
    });
    const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    try {
      for (let index = 0; index < candidate.suite.length; index++) {
        bound.throwIfAborted();
        const pair = {index, test: candidate.suite[index]};
        for (const side of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          pair[side] = await trial(model, side === 'baseline' ? candidate.baseline : candidate.draft, pair.test, bound);
        }
        record.pairs.push(pair);
        store.query('UPDATE skill_candidate_trials SET record=? WHERE id=?', 'run', JSON.stringify(record), trialId);
      }
      current(candidate, context);
      const reportedModels = new Set(record.pairs.flatMap(pair => [pair.baseline.model, pair.candidate.model]));
      const incomplete = reportedModels.size !== 1 || record.pairs.some(pair => [pair.baseline, pair.candidate].some(result => result.truncated || !result.output.trim() || result.checks.some(check => check.status === 'review')));
      const regression = record.pairs.some(pair => pair.baseline.checks.some((check, i) => check.status === 'passed' && pair.candidate.checks[i].status !== 'passed'));
      const improvement = record.pairs.filter(pair => !pair.test.sourceOverlap && !passed(pair.baseline) && passed(pair.candidate)).length;
      const allPassed = record.pairs.every(pair => passed(pair.candidate));
      Object.assign(record, {improvedCases: improvement, regressed: regression,
        baselinePassed: record.pairs.filter(pair => passed(pair.baseline)).length,
        candidatePassed: record.pairs.filter(pair => passed(pair.candidate)).length, total: candidate.suite.length,
        verdict: incomplete ? 'unknown' : regression || !allPassed ? 'failed' : improvement ? 'improved' : 'no_gain',
        reason: incomplete ? '存在未完成或需人工判定的用例，不能确认改进。' : regression || !allPassed ? '候选存在未通过项或回退，保留原版本。' : improvement ? '冻结文本用例有新增通过且没有回退，可提交审核；不代表跨任务能力提升。' : '两组均已通过，未测出增益，保留原版本。'});
      store.query("UPDATE skill_candidate_trials SET status='completed',record=?,finished_at=? WHERE id=? AND status='running'", 'run', JSON.stringify(record), new Date().toISOString(), trialId);
      return get(id, context);
    } catch (error) {
      record.reason = bound.aborted ? '验证中断或超时，已保留完成的配对；未发布。' : error instanceof RequestError ? error.message : '验证未完成，未发布。';
      store.query("UPDATE skill_candidate_trials SET status='interrupted',record=?,finished_at=? WHERE id=?", 'run', JSON.stringify(record), new Date().toISOString(), trialId);
      throw new RequestError(error.status ?? 502, record.reason);
    }
  }
  async function promote({id, context, confirmed, trialId}) {
    const candidate = get(id, context);
    if (candidate.publishedSkillId) return {skill: studio.get(candidate.publishedSkillId, context).history.find(version => version.version === candidate.publishedVersion), candidate};
    if (confirmed !== true) throw new RequestError(422, '请审核冻结用例、实际输出及适用范围后再发布。');
    const {proof, reason, resources} = publicationEvidence(candidate, candidate.trials[0]);
    if (!proof) throw new RequestError(409, reason);
    if (proof.trialId !== trialId) throw new RequestError(409, '请审核最新的可发布验证记录后重试。');
    const baseline = current(candidate, context);
    if (proof.scope === 'isolated-file-execution') {
      if (digest(await packageSnapshot(baseline)) !== digest(resources)) {
        throw new RequestError(409, '技能配套资源已变化，请重新冻结并验证。');
      }
      const latest = get(id, context);
      if (latest.publishedVersion) return promote({id, context, confirmed, trialId});
      if (latest.publication?.proof?.trialId !== trialId) {
        throw new RequestError(409, '验证记录在审核期间变化，请刷新后再发布。');
      }
      current(latest, context);
    }
    const skill = studio.publish({taskId: context, skillId: candidate.skillId, baseVersion: candidate.baseVersion,
      draft: candidate.draft, targetScope: candidate.projectId ? 'project' : 'global', sourceRunId: candidate.sourceRunId, sourceTaskId: candidate.sourceTaskId,
      releaseKind: 'verified',
      commit: published => {
        store.query('INSERT INTO skill_candidate_releases VALUES (?,?)', 'run', id, JSON.stringify(proof));
        store.query('UPDATE skill_candidates SET published_skill_id=?,published_version=? WHERE id=?', 'run', published.id, published.version, id);
      }});
    return {skill, candidate: get(id, context)};
  }
  const executions = createSkillExecutions(store, {getCandidate: get, ensureCurrent: current,
    resolveCaseSource: options => studio.experiences.regressionSource(options).source});
  return {save, get, evaluate, promote, executions, proof(skillId, version) {
    const row = store.query('SELECT id FROM skill_candidates WHERE published_skill_id=? AND published_version=?', 'get', skillId, version);
    if (!row) return null;
    const release = store.query('SELECT evidence FROM skill_candidate_releases WHERE candidate_id=?', 'get', row.id);
    if (release) return JSON.parse(release.evidence);
    const latest = store.query('SELECT id,record FROM skill_candidate_trials WHERE candidate_id=? ORDER BY rowid DESC LIMIT 1', 'get', row.id);
    if (!latest) return null;
    const trial = JSON.parse(latest.record);
    return {candidateId: row.id, trialId: latest.id, scope: 'text-only', verdict: trial.verdict,
      baselinePassed: trial.baselinePassed, candidatePassed: trial.candidatePassed, total: trial.total, improvedCases: trial.improvedCases};
  }, list(context) {
    return store.query('SELECT id FROM skill_candidates WHERE project_id IS NULL OR project_id=? ORDER BY created_at DESC,id LIMIT 100', 'all', projectFor(context))
      .map(row => { const candidate = get(row.id, context), latest = candidate.trials[0]; return {
        id: candidate.id, name: candidate.draft.name, description: candidate.draft.description, projectId: candidate.projectId,
        skillId: candidate.skillId, sourceRunId: candidate.sourceRunId,
        baseVersion: candidate.baseVersion, createdAt: candidate.createdAt, publishedVersion: candidate.publishedVersion,
        verdict: latest?.verdict ?? 'pending', status: latest?.status ?? 'pending', reason: latest?.reason ?? '尚未验证。',
        executionEvidence: candidate.executionEvidence,
      }; });
  }};
}
