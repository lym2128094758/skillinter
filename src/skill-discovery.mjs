import {randomUUID} from 'node:crypto';
import {createRunBudget} from './run-budget.mjs';
import {invokeSkillIntelligence} from './skill-intelligence.mjs';
import {parseSkillFile} from './skill-import.mjs';
import {cleanDraft} from './skill-studio.mjs';
import {RequestError} from './store.mjs';

export const publicCapabilityTags = ['identity verification', 'citation verification', 'source verification', 'web research',
  'data analysis', 'document extraction', 'software testing', 'frontend development', 'backend development', 'data visualization', 'CAD design'];
const publicSource = value => typeof value === 'string' &&
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+\/blob\/[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*SKILL\.md$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');

export function createSkillDiscovery({store, studio}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_discoveries (
    id TEXT PRIMARY KEY, context TEXT NOT NULL, run_id TEXT NOT NULL, document TEXT NOT NULL, imported_skill_id TEXT
  )`);
  const scopeKey = context => {
    if (!context) return '';
    return typeof context === 'object' ? store.project(context.projectId).id : store.task(context).project_id ?? '';
  };
  function get(id, context) {
    const row = store.query('SELECT * FROM skill_discoveries WHERE id=? AND context=?', 'get', id, scopeKey(context));
    if (!row) throw new RequestError(404, '公开发现记录不存在或不属于当前项目。');
    return {id, runId: row.run_id, ...JSON.parse(row.document), importedSkillIds: JSON.parse(row.imported_skill_id ?? '{}')};
  }
  return {get,
    async preview({context, run, provider, tags, sources, confirmed, signal}) {
      if (confirmed !== true || !Array.isArray(tags) || !tags.length || tags.length > 4 ||
          tags.some(tag => !publicCapabilityTags.includes(tag)) || !Array.isArray(sources) || !sources.length ||
          sources.length > 2 || sources.some(source => !publicSource(source))) {
        throw new RequestError(422, '请选择公开能力标签，填写最多两个 GitHub SKILL.md 链接，并确认读取这些公开来源。');
      }
      const budget = createRunBudget({store, rootRunId: run, signal, limits: {maxModelCalls: 0, maxSeconds: 60}});
      try {
        const result = await invokeSkillIntelligence({name: 'discover', provider, budget, signal,
          input: {publicTags: tags, allowedSources: sources, limit: 2},
          emit: (type, payload) => store.record(run, type, payload)});
        if (!result.ok) throw new RequestError(502, result.error.message);
        const existing = studio.list(context);
        const candidates = result.data.result.sources.map(source => {
          const draft = cleanDraft(parseSkillFile('SKILL.md', source.body ?? ''));
          const same = existing.find(skill => skill.name.normalize('NFKC').toLowerCase() === draft.name.normalize('NFKC').toLowerCase());
          return {id: randomUUID(), ...source, draft, status: same ?
            same.instructions === draft.instructions ? 'exists' : 'conflict' : 'missing'};
        });
        signal.throwIfAborted();
        const id = randomUUID();
        const document = {candidates, provider: result.data.provider, version: result.data.version};
        store.query('INSERT INTO skill_discoveries VALUES(?,?,?,?,NULL)', 'run', id, scopeKey(context), run, JSON.stringify(document));
        budget.finish();
        store.finish(run, 'completed', {answer: '公开来源预览完成，共 ' + candidates.length + ' 项。等待用户审核导入。'});
        return get(id, context);
      } catch (error) {
        budget.finish();
        store.finish(run, signal.aborted ? 'stopped' : 'failed', {error: error.message});
        throw error;
      }
    },
    import({id, candidateId, context, targetScope, confirmed}) {
      if (confirmed !== true || !['global', 'project'].includes(targetScope)) throw new RequestError(422, '请核对来源、正文及资源范围后确认导入。');
      const preview = get(id, context);
      const candidate = preview.candidates.find(item => item.id === candidateId);
      if (!candidate || candidate.status !== 'missing') throw new RequestError(409, '此候选已存在或有同名冲突，请重新预览。');
      const importKey = candidateId + ':' + targetScope;
      if (preview.importedSkillIds[importKey]) return {skill: studio.get(preview.importedSkillIds[importKey], context), reused: true};
      const skill = studio.publish({taskId: context, targetScope, baseVersion: 0, draft: candidate.draft,
        commit: published => {
          store.query('UPDATE skill_discoveries SET imported_skill_id=? WHERE id=?', 'run',
            JSON.stringify({...preview.importedSkillIds, [importKey]: published.id}), id);
          store.record(preview.runId, 'skill_discovery_imported', {skillId: published.id, version: published.version,
            source: candidate.source, pinnedUrl: candidate.pinnedUrl, commit: candidate.commit,
            contentSha256: candidate.contentSha256, license: candidate.license, licenseSha256: candidate.licenseSha256,
            packageScope: 'SKILL.md-only', reviewed: true});
        }});
      return {skill, reused: false};
    }};
}
