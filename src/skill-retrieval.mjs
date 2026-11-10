import {invokeSkillIntelligence} from './skill-intelligence.mjs';

// Both proactive routing and an explicit tool call pass the same frozen refs.
export async function retrieveSkills({goal, limit, cards, snapshot, provider, budget, signal, emit, local}) {
  let localResult;
  const fallback = {id: 'sih-local', search() {
    localResult = local();
    return {version: '1', data: {snapshotSha256: snapshot.sha256, candidates: localResult.map(card => ({
      skill: {id: card.id, version: String(card.version)}, reason: '本地匹配，需按任务核验', path: [],
    }))}};
  }};
  const allowedRefs = cards.map(card => ({id: card.id, version: String(card.version),
    name: card.name ?? card.label ?? card.id, description: card.description ?? '', domain: card.domain ?? ''}));
  const result = await invokeSkillIntelligence({
    name: 'search', input: {goal: goal.slice(0, 8000), snapshotSha256: snapshot.sha256, limit, mode: provider ? 'hybrid' : 'local'},
    provider: provider ?? fallback, fallback: provider ? fallback : null, allowedRefs,
    relations: snapshot.relations, budget, signal, emit,
  });
  if (!result.ok) return {result, matches: []};
  const matches = result.data.result.candidates.map(item => ({
    ...cards.find(card => card.id === item.skill.id && String(card.version) === item.skill.version),
    engineReason: item.reason,
  }));
  return {result, matches};
}
