import {createHash} from 'node:crypto';
import {RequestError} from './store.mjs';

const taxonomy = [
  ['文档', /文档|论文|报告|写作|排版|文献|\b(?:document|docs|paper|writing|docx|pdf|manuscript|citation)\b/giu],
  ['制图', /绘图|画图|图表|流程图|架构图|可视化|\b(?:plot|drawio|diagram|flowchart|figure|chart|visualization)\b/giu],
  ['工程', /工程|代码|部署|编程|调试|运维|\b(?:code|coding|software|debug|deployment|git|api|engineering)\b/giu],
  ['算法', /算法|建模|优化求解|回归|机器学习|\b(?:algorithm|modeling|modelling|solver|regression|optimization|machine learning)\b/giu],
  ['数据', /数据|表格|统计|清洗|\b(?:data|csv|xlsx|excel|spreadsheet|statistics|dataset)\b/giu],
  ['测试与评估', /测试|评测|验证|审查|\b(?:test|benchmark|evaluation|validation|audit|review)\b/giu],
  ['设计与媒体', /设计|界面|视频|音频|\b(?:design|ui|video|audio|animation)\b/giu],
];
export const skillCategories = [...taxonomy.map(([name]) => name), '其他'];
const fingerprintFor = skill => createHash('sha256')
  .update(JSON.stringify([String(taxonomy), skill.version, skill.name, skill.description])).digest('hex');

function categories(name, description = '') {
  return taxonomy.map(([label, pattern]) => ({
    label,
    score: new Set(name.normalize('NFKC').toLowerCase().match(pattern)).size * 3 +
      new Set(description.normalize('NFKC').toLowerCase().match(pattern)).size,
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, 3).map(item => item.label);
}

export function createSkillLearning(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_classifications (
    skill_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, categories TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS skill_run_usage (
    run_id TEXT NOT NULL, scope TEXT NOT NULL, domain TEXT NOT NULL, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY(run_id,skill_id)
  ); CREATE INDEX IF NOT EXISTS skill_usage_domain ON skill_run_usage(scope,domain);
  CREATE TABLE IF NOT EXISTS skill_run_feedback (
    run_id TEXT PRIMARY KEY, rating TEXT NOT NULL, note TEXT NOT NULL
  );`);

  function profile(skill) {
    const saved = store.query('SELECT fingerprint,categories FROM skill_classifications WHERE skill_id=?','get',skill.id);
    return saved?.fingerprint === fingerprintFor(skill) ? JSON.parse(saved.categories) : null;
  }

  function saveCategories(skill, labels, source) {
    store.query(`INSERT INTO skill_classifications VALUES (?,?,?) ON CONFLICT(skill_id)
      DO UPDATE SET fingerprint=excluded.fingerprint,categories=excluded.categories`,'run',skill.id,fingerprintFor(skill),JSON.stringify({labels,source}));
  }

  function classify(skill) {
    const saved = profile(skill);
    if (saved?.labels) return saved.labels;
    const tags = categories(skill.name, skill.description);
    const result = tags.length ? tags : ['其他'];
    saveCategories(skill, result, 'rules');
    return result;
  }

  function participants(runId) {
    const event = store.query("SELECT payload FROM events WHERE run=? AND type='skill_runtime' ORDER BY seq DESC LIMIT 1",'get',runId);
    return (event ? JSON.parse(event.payload).graph?.nodes ?? [] : [])
      .filter(node => node.started && Number.isSafeInteger(node.version))
      .map(({id,name,version,state}) => ({id,name,version,state}));
  }

  function recordRun(runId) {
    const run = store.query(`SELECT r.status,r.prompt,t.project_id AS scope FROM runs r JOIN tasks t ON t.id=r.task WHERE r.id=?`,'get',runId);
    if (run?.status !== 'completed') return;
    const domain = categories(run.prompt)[0] ?? '其他';
    for (const skill of participants(runId).filter(item => item.state === 'applied')) {
      store.query('INSERT OR IGNORE INTO skill_run_usage VALUES (?,?,?,?,?)','run',runId,run.scope ?? '',domain,skill.id,skill.version);
    }
  }

  function weights(projectId, goal) {
    const domain = categories(goal)[0];
    if (!domain) return new Map();
    const rows = store.query(`SELECT u.skill_id, count(*) AS uses,
      sum(CASE f.rating WHEN 'helpful' THEN 1 WHEN 'improve' THEN -1 ELSE 0 END) AS feedback
      FROM skill_run_usage u LEFT JOIN skill_run_feedback f ON f.run_id=u.run_id
      WHERE u.scope=? AND u.domain=? GROUP BY u.skill_id`,'all',projectId ?? '',domain);
    return new Map(rows.map(({skill_id,uses,feedback}) => [skill_id, Math.max(-0.15, Math.min(0.25, 0.06*Math.log2(uses+1)+0.04*feedback))]));
  }

  function feedback(runId) {
    return store.query('SELECT rating,note FROM skill_run_feedback WHERE run_id=?','get',runId) ?? null;
  }

  function saveFeedback(runId, rating, note) {
    if (!['helpful','improve'].includes(rating) || typeof note !== 'string' || note.length > 2000) {
      throw new RequestError(422,'请选择有效评价，备注最多 2000 字。');
    }
    const saved = feedback(runId);
    if (saved) {
      if (saved.rating !== rating || saved.note !== note) throw new RequestError(409,'本轮已保存评价。');
      return;
    }
    store.transaction(() => {
      store.query('INSERT INTO skill_run_feedback VALUES (?,?,?)','run',runId,rating,note);
      store.record(runId,'skill_user_feedback',{rating,note});
    });
  }

  return {classify, profile, saveCategories, participants, recordRun, weights, feedback, saveFeedback};
}
