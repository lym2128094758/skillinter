import {createOnlineSkills} from '../src/online-skills.mjs';

// The host supplies the scoped DSH catalog. Public candidates are retrieved
// independently so either source can still answer when the other is offline.
export async function searchSkills({query, limit, list, signal, sources, fetcher}) {
  const online = createOnlineSkills({sources, signal, ...(fetcher ? {fetcher,gitFallback:true} : {})});
  try {
    const [local, remote] = await Promise.allSettled([
      list(), online.execute('discover_skills', {query, limit}),
    ]);
    if (signal.aborted) throw signal.reason;
    const words = query.toLocaleLowerCase().match(/[a-z0-9][a-z0-9-]*|[\u4e00-\u9fff]+/g) ?? [];
    const ranked = local.status === 'fulfilled' ? local.value.filter(skill => skill.invocation?.modelInvocable)
      .map(skill => ({name:skill.name,description:skill.description,provider:skill.provider,source:skill.source,
        score:words.reduce((count,word) => count + (skill.name+' '+skill.description).toLocaleLowerCase().includes(word),0)}))
      .filter(skill => skill.score).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name)).slice(0,limit) : [];
    const result = remote.status === 'fulfilled' && remote.value.ok ? remote.value.data : null;
    return {local:ranked.map(({score,...skill})=>skill), online:result?.candidates ?? [],
      incomplete:local.status === 'rejected' || !result || result.unavailable.length > 0,
      unavailable:result?.unavailable ?? (remote.status === 'rejected' ? ['online'] : result ? [] : ['online'])};
  } finally { await online.close(); }
}
