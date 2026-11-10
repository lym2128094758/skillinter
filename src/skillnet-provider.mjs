import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isAbsolute, join} from 'node:path';
import {RequestError} from './store.mjs';

const bridge = fileURLToPath(new URL('../scripts/skillnet-bridge.py', import.meta.url));
const defaults = {enabled: false, sourcePath: '', python: 'python', encoder: 'auto'};
const fields = new Set(Object.keys(defaults));

export function createSkillnetConnection({store, state, env = {}}) {
  store.db.exec('CREATE TABLE IF NOT EXISTS skill_engine_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
  function view() {
    const row = store.query('SELECT revision,value FROM skill_engine_settings WHERE id=1', 'get');
    return {revision: row?.revision ?? 0, ...defaults, ...(row ? JSON.parse(row.value) : {}),
      ...(env.SIH_SKILLNET_PATH && !row ? {enabled: true, sourcePath: env.SIH_SKILLNET_PATH, python: env.SIH_SKILLNET_PYTHON || 'python'} : {})};
  }
  function draft(body) {
    if (!body || Object.keys(body).some(key => !fields.has(key) && key !== 'revision') ||
        typeof body.enabled !== 'boolean' || typeof body.sourcePath !== 'string' ||
        body.sourcePath.length > 1000 || body.enabled && !isAbsolute(body.sourcePath) ||
        typeof body.python !== 'string' || !body.python.trim() || body.python.length > 1000 ||
        !['auto', 'dense', 'lexical'].includes(body.encoder)) throw new RequestError(422, '请填写有效的 SkillNet 源码目录、Python 和编码器配置。');
    return Object.fromEntries([...fields].map(key => [key, body[key]]));
  }
  function provider(value = view(), onDetails = () => {}, evolution) {
    if (!value.enabled) return null;
    async function call(operation, input, {signal, allowedRefs = [], relations = []} = {}) {
      let reply;
      try {
        reply = await runBridge({value, state, operation, input, signal, githubToken: env.SIH_GITHUB_TOKEN, evolution,
          cards: allowedRefs.map(card => ({id: card.id, version: card.version, name: card.label ?? card.name ?? card.id,
            description: card.description ?? '', domain: card.domain ?? ''})), relations});
      } catch (error) {
        onDetails({operation, state: 'unavailable', reason: error.bridgeError ?? 'process-failed'});
        throw error;
      }
      onDetails({operation, ...reply.details});
      if (operation === 'propose' && reply.details?.state === 'rejected') {
        throw Object.assign(new Error('SkillNet 候选未通过检查。'), {code: 'PROPOSAL_REJECTED'});
      }
      if (operation === 'discover' && ['unavailable', 'disabled'].includes(reply.details?.state)) {
        throw Object.assign(new Error('公开来源暂不可用，失败原因已记录。'), {code: 'ENGINE_UNAVAILABLE'});
      }
      return reply;
    }
    return {id: 'skillnet-local', search: (input, options) => call('search', input, options),
      discover: (input, options) => call('discover', input, options),
      ...(evolution ? {propose: (input, options) => call('propose', input, options)} : {}),
      probe: signal => call('probe', {}, {signal})};
  }
  return {view, provider,
    async test(body, signal) {
      const value = draft(body);
      const engine = provider({...value, enabled: true});
      const result = await engine.probe(signal);
      return {available: true, version: result.version, ...result.details};
    },
    save(body) {
      const value = draft(body);
      return store.transaction(() => {
        const current = view();
        if (body.revision !== current.revision) throw new RequestError(409, '技能引擎设置已变化，请刷新。');
        store.query('INSERT OR REPLACE INTO skill_engine_settings VALUES(1,?,?)', 'run', current.revision + 1, JSON.stringify(value));
        return view();
      });
    }};
}

async function runBridge({value, state, operation, input, cards, relations, signal, githubToken, evolution}) {
  signal.throwIfAborted();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|userprofile|appdata|localappdata)$/i.test(key)));
  environment.PYTHONIOENCODING = 'utf-8';
  return new Promise((resolve, reject) => {
    const child = spawn(value.python, ['-I', bridge, value.sourcePath, join(state, 'skillnet-cache')], {
      env: environment, windowsHide: true, signal, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let pending = '', size = 0, failed = false, result, githubCalls = 0, modelRequested = false;
    const fail = (reason = 'process-failed') => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(Object.assign(new Error('SkillNet 进程未完成，请检查 Python、依赖和源码目录。'), {
        code: 'ENGINE_UNAVAILABLE', bridgeError: typeof reason === 'string' ? reason : 'process-failed',
      }));
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 2_000_000) { fail('response-too-large'); return; }
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let frame;
        try { frame = JSON.parse(line); } catch { fail(); return; }
        if (!frame || typeof frame !== 'object') { fail(); return; }
        if (typeof frame.error === 'string' && /^[A-Za-z]+Error$/.test(frame.error)) { fail(frame.error); return; }
        if (frame.kind === 'result' && !result) result = frame.reply;
        else if (frame.kind === 'github' && operation === 'discover' && ++githubCalls <= 8) {
          void fetchGithub(frame, input.allowedSources, signal, githubToken).then(response => {
            if (!failed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(response) + '\n');
          }).catch(() => { if (!failed && !child.stdin.destroyed) child.stdin.write('{"status":null}\n'); });
        } else if (frame.kind === 'proposal-model' && operation === 'propose' && !modelRequested && !result &&
          typeof frame.prompt === 'string' && frame.prompt.length <= 40000) {
          modelRequested = true;
          void Promise.resolve().then(() => {
            signal.throwIfAborted();
            return evolution.invoke(frame.prompt, signal);
          }).then(content => {
            if (!failed && !signal.aborted && !child.stdin.destroyed) child.stdin.write(JSON.stringify({content}) + '\n');
          }).catch(error => {
            if (failed) return;
            if (['BUDGET_EXHAUSTED', 'PROPOSAL_REJECTED'].includes(error.code)) {
              failed = true;
              child.kill();
              reject(error);
            } else fail('proposal-model-failed');
          });
        } else { fail(); return; }
      }
    });
    child.on('close', code => {
      if (failed) return;
      if (code !== 0 || signal.aborted) { fail(); return; }
      if (!result) { fail(); return; }
      resolve(result);
    });
    const payload = JSON.stringify({operation, input, cards, relations, encoder: value.encoder,
      ...(operation === 'propose' ? {evidence: evolution.evidence, baseline: evolution.baseline} : {})});
    if (Buffer.byteLength(payload) > 4_000_000) { fail(); return; }
    child.stdin.write(payload + '\n');
  });
}

async function fetchGithub(frame, sources, signal, githubToken) {
  const parsed = sources.map(source => new URL(source).pathname.split('/').slice(1));
  const allowed = parsed.some(([owner, repo, , ref, ...parts]) => {
    const base = '/repos/' + owner + '/' + repo;
    if (frame.path === base) return frame.params == null;
    if (frame.path === base + '/commits/' + encodeURIComponent(ref)) return frame.params == null;
    return [base + '/license', base + '/contents/' + parts.join('/')].includes(frame.path) &&
      frame.params && /^[a-f0-9]{40}$/.test(frame.params.ref) && Object.keys(frame.params).length === 1;
  });
  if (!allowed) throw new Error('Unauthorized source request');
  const url = new URL(frame.path, 'https://api.github.com');
  if (url.origin !== 'https://api.github.com') throw new Error('Invalid source origin');
  if (frame.params) url.searchParams.set('ref', frame.params.ref);
  const response = await fetch(url, {signal, redirect: 'error', headers: {
    accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'Skillinter-SkillDiscovery/1',
    ...(githubToken ? {authorization: 'Bearer ' + githubToken} : {}),
  }});
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Source response too large');
    chunks.push(chunk);
  }
  return {status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8'))};
}
