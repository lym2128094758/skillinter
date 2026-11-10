import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { apiModel, testModel } from './runner.mjs';
import { RequestError } from './store.mjs';

const defaultSteps = 5;
const isWindows = process.platform === 'win32';

async function dpapi(value, decrypt) {
  if (!isWindows) throw new RequestError(422, '此系统的密钥请通过 .env 配置');
  const operation = decrypt
    ? '[Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)'
    : '[Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String(${operation}))`;
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Include cold PowerShell startup and assembly loading in the deadline.
  const deadline = AbortSignal.timeout(20_000);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, signal: deadline, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => code === 0 && output ? resolve(output) : reject(new Error('DPAPI failed')));
    child.stdin.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'));
  }).catch(() => {
    throw new RequestError(500, deadline.aborted ? 'Windows 处理密钥超时，请重试' : 'Windows 无法处理已保存的密钥，请重新填写');
  });
  return decrypt ? Buffer.from(result, 'base64').toString('utf8') : result;
}

const windowsSecrets = {seal: value => dpapi(value, false), open: value => dpapi(value, true), available: isWindows};

function endpointOf(value, appendPath = true) {
  let url;
  try { url = new URL(value); } catch { throw new RequestError(422, '请输入有效的模型 API 地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new RequestError(422, '请使用 HTTPS 地址。本机模型可用 HTTP，地址不能包含凭据或查询参数');
  }
  if (appendPath) {
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  }
  return url.href;
}

function apiConfig(endpoint, model, appendPath = true) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof model !== 'string' || !model.trim() || model.length > 200) {
    throw new RequestError(422, '请填写 API 地址和模型 ID');
  }
  return {endpoint: endpointOf(endpoint.trim(), appendPath), model: model.trim()};
}

export async function createSettings({store, env}) {
  let environment, envError;
  if (env.SKILLINTER_MODEL_URL || env.SKILLINTER_MODEL || env.SKILLINTER_API_KEY) {
    try {
      environment = {...apiConfig(env.SKILLINTER_MODEL_URL, env.SKILLINTER_MODEL, false), key: env.SKILLINTER_API_KEY};
    } catch (error) { envError = error.message; }
  }
  const initial = store.preferences();
  let revision = initial.revision;
  let value = initial.value;
  let key;
  let catalog = [], catalogAt = 0;
  if (value.secret) {
    try { key = await windowsSecrets.open(value.secret); }
    catch { /* The user can replace or clear an unreadable credential in settings. */ }
  }

  function mode() {
    if (value.mode === 'api') return 'api';
    if (environment && value.mode !== 'demo') return 'environment';
    return 'unconfigured';
  }

  function view() {
    return {revision, mode: mode(), endpoint: value.endpoint ?? '', model: value.model ?? '',
      activeModel: snapshot().model?.label ?? '未连接模型', maxSteps: value.maxSteps ?? defaultSteps, defaultSteps,
      hasKey: Boolean(key), keyUnreadable: Boolean(value.secret && !key),
      canStoreKey: windowsSecrets.available, environmentModel: environment?.model ?? null,
      envError: envError ?? (value.mode === 'environment' && !environment ? '缺少模型地址和模型 ID' : null)};
  }

  function snapshot(selection = {}) {
    const selected = mode();
    const config = selected === 'api' ? {...value, key} : selected === 'environment' ? environment : null;
    const model = config ? apiModel({...config, model: selection.model || config.model, effort: selection.effort || 'default'}) : null;
    return {model, maxSteps: value.maxSteps ?? defaultSteps, mode: selected, effort: selection.effort || 'default'};
  }

  async function models(refresh = false) {
    const config = mode() === 'api' ? {...value, key} : mode() === 'environment' ? environment : null;
    if (!config) return {models: [], defaultModel: null};
    if (refresh || !catalogAt || Date.now() - catalogAt > 60_000) {
      const url = new URL(config.endpoint);
      url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
      try {
        const response = await fetch(url, {headers: config.key ? {authorization: `Bearer ${config.key}`} : {},
          redirect: 'error', signal: AbortSignal.timeout(10_000)});
        if (!response.ok) throw new Error('Model catalog unavailable');
        const body = await response.json();
        if (!Array.isArray(body.data)) throw new Error('Invalid catalog');
        catalog = body.data.filter(row => typeof row?.id === 'string' && row.id.length <= 200).slice(0, 500).map(row => {
          const declared = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : [];
          const efforts = /^intern-s[12](?:-|$)/i.test(row.id) ? ['default', 'on', 'off']
            : ['default', ...declared.filter(level => ['low', 'medium', 'high'].includes(level))];
          return {id: row.id, efforts: [...new Set(efforts)]};
        });
        catalogAt = Date.now();
      } catch {
        return {models: catalog.length ? catalog : [{id: config.model, efforts: ['default']}], defaultModel: config.model,
          warning: '模型目录暂不可用，保留已配置模型，可点击刷新重试。'};
      }
    }
    const models = catalog.some(row => row.id === config.model) ? catalog : [{id: config.model, efforts: ['default']}, ...catalog];
    return {models, defaultModel: config.model};
  }

  async function validateSelection(model, effort) {
    if (model !== null && (typeof model !== 'string' || !model || model.length > 200)) throw new RequestError(422, '模型 ID 无效');
    if (!['default', 'on', 'off', 'low', 'medium', 'high'].includes(effort)) throw new RequestError(422, '思考选项无效');
    if (!model && effort === 'default') return;
    const directory = await models();
    const entry = directory.models.find(row => row.id === (model || directory.defaultModel));
    if (!entry || !entry.efforts.includes(effort)) throw new RequestError(422, '当前模型不支持所选思考选项，请刷新模型列表');
  }

  function validateBudget(maxSteps) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw new RequestError(422, '模型调用次数必须是 1 到 12 的整数');
  }

  function commit(expected, next) {
    store.savePreferences(expected, next);
    value = next;
    revision = expected + 1;
  }

  async function draft(body) {
    if (!['api', 'environment'].includes(body?.mode) || (body.mode === 'environment' && !environment)) {
      throw new RequestError(422, '请选择可用的运行模式');
    }
    const {mode, maxSteps, revision: requestedRevision} = body;
    if (requestedRevision !== revision) throw new RequestError(409, '设置已更新，请重新打开后再试');
    validateBudget(maxSteps);
    const next = {...value, mode, maxSteps};
    if (mode !== 'api') return {next, key, requestedRevision};
    Object.assign(next, apiConfig(body.endpoint, body.model ?? value.model ?? 'auto'));
    const supplied = body.key === undefined ? '' : body.key;
    if (typeof supplied !== 'string' || !/^[!-~]{0,4096}$/.test(supplied) || (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') || (supplied && body.clearKey)) {
      throw new RequestError(422, 'API 密钥格式无效，或同时选择了填写和清除');
    }
    const sameOrigin = value.endpoint && new URL(value.endpoint).origin === new URL(next.endpoint).origin;
    if (body.clearKey || !sameOrigin) delete next.secret;
    const nextKey = supplied || (next.secret ? key : undefined);
    let discovered;
    if (body.model === undefined) {
      const url = new URL(next.endpoint);
      url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
      let response;
      try {
        response = await fetch(url, {headers: nextKey ? {authorization: `Bearer ${nextKey}`} : {},
          redirect: 'error', signal: AbortSignal.timeout(12_000)});
        if (!response.ok) throw new RequestError(502, `读取模型列表失败（HTTP ${response.status}），请检查 API 地址和密钥`);
        const body = await response.json();
        discovered = Array.isArray(body.data) ? [...new Set(body.data.map(row => row?.id)
          .filter(id => typeof id === 'string' && id.trim() && id.length <= 200))].slice(0, 500) : [];
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(502, '无法读取模型列表，请检查服务是否提供 /models 接口');
      }
      if (!discovered.length) throw new RequestError(422, '此 API 没有返回可用模型');
      next.model = sameOrigin && discovered.includes(value.model) ? value.model : discovered[0];
    }
    return {next, key: nextKey, supplied, requestedRevision, discovered};
  }

  return {view, snapshot, models, validateSelection, async save(body) {
    const update = await draft(body);
    if (update.supplied) update.next.secret = await windowsSecrets.seal(update.supplied);
    commit(update.requestedRevision, update.next);
    key = update.key;
    catalog = [];
    catalogAt = 0;
    return view();
  }, saveBudget(body) {
    const {revision: expected, maxSteps} = body ?? {};
    if (expected !== revision) throw new RequestError(409, '设置已更新，请重新打开后再试');
    validateBudget(maxSteps);
    commit(expected, {...value, maxSteps});
    return view();
  }, async test(body) {
    const update = await draft(body);
    if (update.discovered) return {ok: true, models: update.discovered};
    try {
      await testModel(update.next.mode === 'environment' ? environment : {...update.next, key: update.key});
    } catch (error) {
      const safe = /^模型请求失败（HTTP \d{3}）$/.test(error.message) ? error.message : '模型连接失败，请检查地址、模型 ID 和网络';
      throw new RequestError(502, safe);
    }
    return {ok: true};
  }};
}
