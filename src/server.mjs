import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { RequestError, Store } from './store.mjs';
import { demoModel, executeRun } from './runner.mjs';
import { createSettings } from './settings.mjs';
import { selectSkill, utf8, parseCsv, csvAnalysisMaxBytes, csvAnalysisSizeMessage } from './skills.mjs';
import { validateRequest, auditTools } from './audit-tools.mjs';
import { auditLimits, executeAudit, planSchema, reportSchema } from './workflow.mjs';
import { config as appConfig } from './config.mjs';
import { isProjectScope, projectDirectory } from './file-scope.mjs';
import { CONTRACT_VERSION, fileToolRegistry } from './tools.mjs';
import { cases, fixtureModel, ready } from '../bench/cases.mjs';
import { rulesModel } from './audit-rules.mjs';
import { auditRuntime, skillRegistry } from './audit-skills.mjs';
import { mappingDecisionSchema, optionalDecisionSchema } from './audit-planner.mjs';
import { chatSkillRegistry } from './chat-skills.mjs';
import { imageMime } from './images.mjs';
import { createSkillStudio, cleanDraft } from './skill-studio.mjs';
import {createSkillGraph} from './skill-graph.mjs';
import { executePreflight, preflightInput } from './preflight.mjs';
import { parseSkillFile, readSkillDirectory } from './skill-import.mjs';
import { optimizePrompt } from './prompt-optimizer.mjs';
import { createSkillLibraries } from './skill-libraries.mjs';
import {createSkillRegistry,registryContract,registryErrors} from './skill-registry.mjs';
import {validate} from './schema.mjs';
import {success,failure} from './tool-contract.mjs';
import {createRunBudget, readRunBudget} from './run-budget.mjs';
import {skillIntelligenceContract} from './skill-intelligence.mjs';
import {createSkillnetConnection} from './skillnet-provider.mjs';
import {createSkillDiscovery, publicCapabilityTags} from './skill-discovery.mjs';
import {createProjectMemory} from './project-memory.mjs';
import {readRunWorkers, workerTool} from './readonly-workers.mjs';
import {createGithubAccess} from './github-access.mjs';
import {receiveAttachment,fileHead,sendAttachment,materializeAttachment,removeMaterializedAttachment,pickLocalFolder} from './attachments.mjs';
import {createBrowserFolders,browserFolderId} from './browser-folders.mjs';

const assets = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
  '/browser-folders.js': ['browser-folders.js', 'text/javascript'],
  '/skill-studio.js': ['skill-studio.js', 'text/javascript'],
  '/skill-engine.js': ['skill-engine.js', 'text/javascript'],
  '/skill-runtime.js': ['skill-runtime.js', 'text/javascript'],
  '/skill-execution.js': ['skill-execution.js', 'text/javascript'],
  '/skill-experiences.js': ['skill-experiences.js', 'text/javascript'],
  '/task-plan.js': ['task-plan.js', 'text/javascript'],
  '/run-outcome.js': ['../src/run-outcome.mjs', 'text/javascript'],
  '/prompt-optimizer.js': ['prompt-optimizer.js', 'text/javascript'],
  '/catalog/sphere.js': ['catalog/sphere.js', 'text/javascript'], '/catalog/graph.json': ['catalog/graph.json', 'application/json']};
for (const name of ['app.js','theme.js','sphere.js','view-morph.js','graph-model.js','liquid-controls.js','sih-bridge.js','vendor/d3.min.js']) {
  assets['/skill-library/'+name] = ['skill-library/'+name,'text/javascript'];
}
assets['/skill-library/index.html'] = ['skill-library/index.html','text/html'];
assets['/skill-library/styles.css'] = ['skill-library/styles.css','text/css'];

function json(res, status, data) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}

async function bytesFrom(req, limit, message) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    bytes += chunk.length;
    if (bytes > limit) { req.resume(); throw new RequestError(413, message); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function input(req, limit = 80_000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, '需要 JSON 请求');
  const bytes = await bytesFrom(req, limit, '消息过长');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new RequestError(400, '无效 JSON'); }
}

function taskChanges(body) {
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  if (!keys.length || keys.some(key => !['title', 'pinned', 'archived', 'model_id', 'effort'].includes(key))) {
    throw new RequestError(422, '请选择要修改的任务属性');
  }
  const changes = {};
  for (const key of keys) {
    const value = body[key];
    if (key === 'title') {
      const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
      if (!title || [...title].length > 60) throw new RequestError(422, '任务名称需在 1 到 60 字之间');
      changes.title = title;
    } else if (key === 'model_id') {
      if (value !== null && (typeof value !== 'string' || !value || value.length > 200)) throw new RequestError(422, '模型 ID 无效');
      changes[key] = value;
    } else if (key === 'effort') {
      if (typeof value !== 'string') throw new RequestError(422, '思考选项无效');
      changes[key] = value;
    } else {
      if (typeof value !== 'boolean') throw new RequestError(422, '任务状态必须为布尔值');
      changes[key] = value;
    }
  }
  return changes;
}

function projectId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f\d-]{36}$/.test(value)) throw new RequestError(422, '项目编号无效');
  return value;
}

function stream(res, store, run, after) {
  res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
  res.flushHeaders();
  let cursor = after;
  let heartbeat = Date.now();
  const timer = setInterval(tick, 250);
  res.once('close', () => clearInterval(timer));
  function tick() {
    if (res.writableNeedDrain) return;
    for (const event of store.events(run, cursor)) {
      cursor = event.seq;
      heartbeat = Date.now();
      const ready = res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'finished') { res.end(); return; }
      if (!ready) return;
    }
    if (store.run(run).status !== 'running') res.end();
    else if (Date.now() - heartbeat >= 12_000) { res.write(': ping\n\n'); heartbeat = Date.now(); }
  }
  tick();
}

export async function createApp({state, env = {}, userSkillsPath, skillLibraryHome}) {
  state = resolve(state);
  const workspace = join(state, 'workspaces');
  await mkdir(workspace, {recursive: true});
  const store = new Store(join(state, 'tasks.sqlite'));
  store.recover();
  const skillStudio = createSkillStudio(store, {userSkillsPath: userSkillsPath ?? join(state, 'skills')});
  const skillLibraries = createSkillLibraries({studio: skillStudio, store, state, home: skillLibraryHome});
  function skillContext(taskId, selectedProject) {
    if (taskId != null) store.task(taskId);
    return selectedProject ? {projectId: store.project(projectId(selectedProject)).id} : taskId;
  }
  const registryProjectFor=context=>{
    if (!context) return null;
    return typeof context === 'object' ? store.project(context.projectId).id : store.task(context).project_id;
  };
  const skillRegistry=createSkillRegistry({store,studio:skillStudio,projectFor:registryProjectFor});
  const skillGraph = createSkillGraph({store,studio:skillStudio,projectFor:registryProjectFor,registry:skillRegistry});
  const previousConnection = await readFile(join(state,'previous-model-connection.json'),'utf8')
    .then(JSON.parse).catch(()=>null);
  const settings = await createSettings({store, env, previousConnection});
  const githubAccess=createGithubAccess({env,store});
  const skillnet = createSkillnetConnection({store, state, env,githubFetch:githubAccess.fetch});
  const discoveries = createSkillDiscovery({store, studio: skillStudio});
  const projectMemories = createProjectMemory(store, state);
  const browserFolders = createBrowserFolders();
  let studioController;
  let optimizerController;
  let folderPickerController;
  const active = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      const port = server.address().port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new RequestError(403, '仅支持本机访问');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new RequestError(403, '不允许跨站请求');
      const {pathname, searchParams} = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && Object.hasOwn(assets, pathname)) {
        if (pathname === '/skill-library/index.html') res.setHeader('content-security-policy',
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
        const [name, type] = assets[pathname];
        const body = await readFile(new URL(`../web/${name}`, import.meta.url));
        res.writeHead(200, {'content-type': `${type}; charset=utf-8`});
        res.end(body);
        return;
      }
      if(pathname==='/api/skill-registry/contract'&&req.method==='GET')return json(res,200,registryContract);
      if (pathname === '/api/skill-intelligence/contract' && req.method === 'GET') return json(res, 200, skillIntelligenceContract);
      if (pathname === '/api/skill-intelligence/settings' && req.method === 'GET') return json(res, 200, skillnet.view());
      if(pathname==='/api/skill-intelligence/github') {
        if(req.method==='GET')return json(res,200,await githubAccess.status(AbortSignal.timeout(10000),{refresh:searchParams.get('refresh')==='1'}));
        if(req.method==='POST') {
          const body=await input(req,6000);
          if(body?.action==='login')return json(res,202,{device:githubAccess.startLogin()});
          if(body?.action==='reuse')return json(res,200,await githubAccess.reuseLocal(AbortSignal.timeout(10000)));
          if(body?.action==='token')return json(res,200,await githubAccess.saveToken(body.token,AbortSignal.timeout(10000)));
          if(body?.action==='disconnect')return json(res,200,await githubAccess.disconnect());
          throw new RequestError(422,'GitHub连接操作无效。');
        }
      }
      if (pathname === '/api/skill-intelligence/tags' && req.method === 'GET') return json(res, 200, {tags: publicCapabilityTags});
      if (pathname === '/api/skill-intelligence/discover' && req.method === 'POST') {
        const body = await input(req, 8000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '公开发现请求无效。');
        const context = skillContext(body.taskId ?? null, body.projectId);
        if (typeof body.request !== 'string' || !/^[\w-]{1,80}$/.test(body.request)) throw new RequestError(422, '公开发现提交编号无效。');
        const taskId = body.taskId ?? store.createTask(context && typeof context === 'object' ? context.projectId : null).id;
        const run = store.begin(taskId, body.request, '读取已授权的公开技能来源', {mode: 'skill-discovery', model: 'SkillNet 来源核验'});
        if (!run.started) throw new RequestError(409, '本次发现请求已提交，请查看运行记录。');
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const entry = {controller, interrupt: null, job: null};
        active.set(run.id, entry);
        res.once('close', cancel);
        entry.job = discoveries.preview({context, run: run.id, tags: body.tags, sources: body.sources, confirmed: body.confirmed,
          signal: controller.signal, provider: skillnet.provider(undefined, details => store.record(run.id, 'skill_engine_details', details))});
        try { return json(res, 200, await entry.job); }
        catch (error) {
          if (store.run(run.id).status === 'running') store.finish(run.id, 'failed', {error: error.message});
          throw error;
        } finally { res.off('close', cancel); active.delete(run.id); }
      }
      const discovery = /^\/api\/skill-intelligence\/discoveries\/([a-f\d-]{36})(\/import)?$/.exec(pathname);
      if (discovery && req.method === 'GET' && !discovery[2]) return json(res, 200, discoveries.get(discovery[1],
        skillContext(searchParams.get('task') ?? null, searchParams.get('project'))));
      if (discovery?.[2] && req.method === 'POST') {
        const body = await input(req, 8000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '导入请求无效。');
        return json(res, 201, discoveries.import({id: discovery[1], candidateId: body.candidateId,
          context: skillContext(body.taskId ?? null, body.projectId), targetScope: body.targetScope, confirmed: body.confirmed}));
      }
      if (['/api/skill-intelligence/settings', '/api/skill-intelligence/test'].includes(pathname) && req.method === 'POST') {
        const body = await input(req, 8000);
        if (pathname.endsWith('/settings')) return json(res, 200, skillnet.save(body));
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try { return json(res, 200, await skillnet.test(body, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))); }
        catch { throw new RequestError(502, 'SkillNet 连接检测失败，请检查目录、Python 和依赖。'); }
        finally { res.off('close', cancel); }
      }
      const historicalBudget = /^\/api\/runs\/([a-f\d-]{36})\/budget$/.exec(pathname);
      if (historicalBudget && req.method === 'GET') {
        store.run(historicalBudget[1]);
        return json(res, 200, success(readRunBudget(store, historicalBudget[1])));
      }
      const historicalWorkers = /^\/api\/runs\/([a-f\d-]{36})\/workers$/.exec(pathname);
      if (historicalWorkers && req.method === 'GET') return json(res, 200, {workers: readRunWorkers(store, historicalWorkers[1])});
      const historicalRegistry=/^\/api\/runs\/([a-f\d-]{36})\/skill-registry$/.exec(pathname);
      if(historicalRegistry&&req.method==='GET'){
        try{return json(res,200,success(skillRegistry.forRun(historicalRegistry[1])));}
        catch(error){if(registryErrors[error.code])return json(res,error.status,failure(registryErrors,error.code));throw error;}
      }
      if(pathname==='/api/skill-registry'&&req.method==='GET')return json(res,200,success(skillRegistry.snapshot(skillContext(searchParams.get('task')||null,searchParams.get('project')))));
      const registryAction=/^\/api\/skill-registry\/(relations|bindings|overrides)$/.exec(pathname);
      if(registryAction&&['POST','DELETE'].includes(req.method)){
        const body=await input(req,8000);
        const context=skillContext(searchParams.get('task')||null,searchParams.get('project'));
        const name={relations:'relation',bindings:'binding',overrides:'override'}[registryAction[1]];
        const contract=registryContract.operations.find(item=>item.name===name);
        if(validate(contract.parameters,body).length)return json(res,422,failure(registryErrors,'INVALID_RELATION'));
        try{
          const method={relation:'relation',binding:'bind',override:'override'}[name];
          return json(res,200,success(skillRegistry[method]({context,...body,remove:req.method==='DELETE'})));
        }catch(error){if(registryErrors[error.code])return json(res,error.status,failure(registryErrors,error.code));throw error;}
      }
      if (pathname.startsWith('/api/skill-graph/')) {
        const context = skillContext(searchParams.get('task') || null,searchParams.get('project'));
        if (req.method === 'GET' && pathname === '/api/skill-graph/skills') return json(res,200,skillGraph.snapshot(context));
        if (req.method === 'GET' && pathname === '/api/skill-graph/skill') return json(res,200,skillGraph.detail(searchParams.get('id'),context));
        if (['POST','DELETE'].includes(req.method) && pathname === '/api/skill-graph/relations') {
          const body = await input(req,4000);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422,'关联请求无效。');
          return json(res,200,skillGraph.relation({context,source:body.source,target:body.target,remove:req.method==='DELETE'}));
        }
        throw new RequestError(405,'图谱操作无效。');
      }
      if (pathname === '/api/status' && req.method === 'GET') {
        const {model} = settings.snapshot();
        return json(res, 200, {model: model?.label ?? '未连接模型', connected: Boolean(model)});
      }
      if (pathname === '/api/health' && req.method === 'GET') {
        store.query('SELECT 1', 'get');
        return json(res, 200, {ok: true, toolContractVersion: CONTRACT_VERSION, reportVersion: 2, offlineDemo: true,
          modelConfigured: Boolean(settings.snapshot().model)});
      }
      if (pathname === '/api/prompts/optimize' && req.method === 'POST') {
        const body = await input(req);
        if (typeof body?.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000 ||
          body.taskId != null && (typeof body.taskId !== 'string' || !/^[a-f\d-]{36}$/.test(body.taskId))) {
          throw new RequestError(422, '请先填写需要优化的任务，最多 16000 字符。');
        }
        if (body.model != null && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200)) throw new RequestError(422, '模型无效。');
        if (body.effort != null && !['default', 'on', 'off', 'low', 'medium', 'high'].includes(body.effort)) throw new RequestError(422, '思考选项无效。');
        const task = body.taskId ? store.task(body.taskId) : null;
        const selection = {model: body.model ?? task?.model_id, effort: body.effort ?? task?.effort};
        const {model} = settings.snapshot(selection);
        if (!model) throw new RequestError(409, '请先在设置中连接模型。');
        if (optimizerController) throw new RequestError(409, '已有提示词优化在进行，请稍后重试。');
        const context = task ? {project: task.project_id ? store.project(task.project_id).name : null,
          fileAccess: task.file_access, attachmentCount:task.files.length, attachments: task.files.slice(0,40).map(({name, kind, relativePath}) => ({name, kind, relativePath})),
          recent: store.history(task.id).slice(-2).map(item => ({prompt: item.prompt.slice(0, 1000), answer: item.answer.slice(0, 1000)}))} : {};
        const controller = optimizerController = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try { return json(res, 200, await optimizePrompt({model, prompt: body.prompt, context, signal: controller.signal})); }
        finally { res.off('close', cancel); optimizerController = undefined; }
      }
      if (pathname === '/api/settings') {
        if (req.method === 'GET') return json(res, 200, settings.view());
        if (req.method === 'PUT') return json(res, 200, await settings.save(await input(req)));
        if (req.method === 'PATCH') return json(res, 200, settings.saveBudget(await input(req)));
      }
      if (pathname === '/api/settings/test' && req.method === 'POST') return json(res, 200, await settings.test(await input(req)));
      if (pathname === '/api/settings/switch' && req.method === 'POST') return json(res, 200, await settings.switchConnection(await input(req)));
      if (pathname === '/api/models' && req.method === 'GET') return json(res, 200, await settings.models(searchParams.get('refresh') === '1'));
      if (req.method === 'GET' && pathname === '/api/skill-studio') {
        const taskId = skillContext(searchParams.get('task') || null, searchParams.get('project'));
        return json(res, 200, {skills: skillStudio.list(taskId).map(({instructions, ...skill}) => skill),
          locations: skillStudio.locations(taskId), issues: skillStudio.issues()});
      }
      if (req.method === 'GET' && pathname === '/api/skill-studio/locations') {
        return json(res, 200, skillStudio.locations(skillContext(searchParams.get('task') || null, searchParams.get('project'))));
      }
      if (req.method === 'POST' && pathname === '/api/skill-studio/organize') {
        const body = await input(req);
        if (studioController) throw new RequestError(409,'技能工坊有一项模型任务在运行。');
        const context = skillContext(body?.taskId ?? null,body?.projectId);
        const task = body?.taskId ? store.task(body.taskId) : null;
        const {model} = settings.snapshot({model:task?.model_id,effort:task?.effort});
        const controller = studioController = new AbortController();
        const cancel = () => controller.abort();
        res.once('close',cancel);
        try {
          const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
          return json(res,200,await skillStudio.organize({context,model,signal}));
        } finally {
          res.off('close',cancel);
          studioController = undefined;
        }
      }
      const experienceRoute = /^\/api\/skill-studio\/experiences(?:\/([a-f\d-]{36})(?:\/(propose|state|regression-draft))?)?$/.exec(pathname);
      if (experienceRoute) {
        const [,id,action]=experienceRoute;
        const experiences=skillStudio.experiences;
        if(req.method==='GET'&&!action){
          const context=skillContext(searchParams.get('task')||null,searchParams.get('project'));
          return json(res,200,id?experiences.get(id,context):{experiences:experiences.list(context,{runId:searchParams.get('run')||undefined})});
        }
        if(req.method==='POST'&&id){
          const body=await input(req,12000);if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError(422,'经验请求无效。');
          const context=skillContext(body.taskId??null,body.projectId);
          if(action==='state')return json(res,200,experiences.setState(id,context,body.state));
          if (action === 'regression-draft') return json(res, 200, experiences.regressionDraft({id, context, candidateId: body.candidateId}));
          if(action==='propose'){
            if(studioController)throw new RequestError(409,'技能工坊有一项模型任务在运行，请等待完成。');
            const source=experiences.get(id,context),task=store.task(source.taskId);
            const {model}=settings.snapshot({model:task.model_id,effort:task.effort});
            const controller=studioController=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
            let evolutionRun;
            const entry = {controller, job: null, interrupt: null};
            const job = experiences.propose({id,context,skillId:body.skillId,feedback:body.feedback,
              operator:body.operator,model,signal:controller.signal,skillnet,registry:skillRegistry,onRun(runId) {
                evolutionRun = runId;
                active.set(runId, entry);
              }});
            entry.job = job.catch(() => {});
            try { return json(res,201,await job); }
            finally {
              if (evolutionRun) active.delete(evolutionRun);
              res.off('close',cancel);
              studioController=undefined;
            }
          }
        }
        throw new RequestError(405,'经验操作无效。');
      }
      const candidateRoute = /^\/api\/skill-studio\/candidates(?:\/([a-f\d-]{36})(?:\/(evaluate|promote))?)?$/.exec(pathname);
      const executionCollection=/^\/api\/skill-studio\/candidates\/([a-f\d-]{36})\/execution-plans$/.exec(pathname);
      const executionRoute=/^\/api\/skill-studio\/execution-plans\/([a-f\d-]{36})(?:\/(run|stop)|\/trials\/([a-f\d-]{36})\/files\/([a-f\d-]{36}))?$/.exec(pathname);
      if(executionCollection||executionRoute){
        const engine=skillStudio.candidates.executions;
        if(req.method==='GET'){
          const context=skillContext(searchParams.get('task')||null,searchParams.get('project'));
          if(executionCollection)return json(res,200,{plans:engine.list(executionCollection[1],context)});
          const [,id,action,trialId,fileId]=executionRoute;
          if(fileId){
            const file=engine.file(id,trialId,fileId,context);res.writeHead(200,{'content-type':'application/octet-stream','content-length':file.bytes.length,
              'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(file.path)).replaceAll("'",'%27')}`,'x-content-sha256':file.sha256});res.end(file.bytes);return;
          }
          if(!action)return json(res,200,engine.get(id,context));
        }
        if(req.method==='POST'){
          const body=await input(req,400000);if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError(422,'执行对照请求无效。');
          const context=skillContext(body.taskId??null,body.projectId);
          if(executionCollection)return json(res,201,await engine.freeze({candidateId:executionCollection[1],context,spec:body.spec}));
          const [,id,action]=executionRoute;
          if(action==='stop')return json(res,200,engine.stop(id,context));
          if(action==='run'){
            if(studioController)throw new RequestError(409,'技能工坊正在运行模型任务，请等待完成。');
            const task=body.taskId?store.task(body.taskId):null;const selected=settings.snapshot(task?{model:task.model_id,effort:task.effort}:{});const {model}=selected;
            const controller=studioController=new AbortController();
            try{
              const {trialId,job}=await engine.run({id,context,model,signal:controller.signal,modelOptions:{effort:selected.effort??'default'}});
              void job.finally(()=>{if(studioController===controller)studioController=undefined;});
              return json(res,202,{planId:id,trialId});
            }catch(error){studioController=undefined;throw error;}
          }
        }
        throw new RequestError(405,'执行对照操作无效。');
      }
      if (candidateRoute) {
        const [, id, action] = candidateRoute;
        if (req.method === 'GET' && !action) {
          const context = skillContext(searchParams.get('task') || null, searchParams.get('project'));
          return json(res, 200, id ? {...skillStudio.candidates.get(id, context),experienceProposals:skillStudio.experiences.forCandidate(id,context)} : {candidates: skillStudio.candidates.list(context)});
        }
        if (req.method === 'POST') {
          const body = await input(req, 1_000_000);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '候选请求无效。');
          for (const value of [body.taskId, body.sourceRunId, body.skillId, body.trialId, body.parentCandidateId]) {
            if (value != null && (typeof value !== 'string' || !/^[a-f\d-]{36}$/.test(value))) throw new RequestError(422, '候选或来源编号无效。');
          }
          const context = skillContext(body.taskId ?? null, body.projectId);
          if (!id) return json(res, 201, skillStudio.candidates.save({...body, context}));
          if (action === 'promote') return json(res, 200, await skillStudio.candidates.promote({id, context, confirmed: body.confirmed, trialId: body.trialId}));
          if (action === 'evaluate') {
            if (studioController) throw new RequestError(409, '技能工坊有一项模型任务在运行，请等待完成。');
            const task = body.taskId ? store.task(body.taskId) : null;
            const {model} = settings.snapshot(task ? {model: task.model_id, effort: task.effort} : {});
            const controller = studioController = new AbortController();
            const cancel = () => controller.abort(); res.once('close', cancel);
            try { return json(res, 200, await skillStudio.candidates.evaluate({id, context, model, signal: controller.signal})); }
            finally { res.off('close', cancel); studioController = undefined; }
          }
        }
        throw new RequestError(405, '候选操作无效。');
      }
      if (req.method === 'GET' && pathname === '/api/skill-studio/libraries') {
        return json(res, 200, {sources: await skillLibraries.sources(skillContext(searchParams.get('task') || null, searchParams.get('project')))});
      }
      if (req.method === 'POST' && ['/api/skill-studio/scan-libraries', '/api/skill-studio/import-missing'].includes(pathname)) {
        const body = await input(req, 300_000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '技能库请求无效。');
        const context = skillContext(body.taskId ?? null, body.projectId);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
        res.once('close', cancel);
        try {
          const result = pathname.endsWith('/scan-libraries')
            ? await skillLibraries.scan({context, paths: body.paths, targetScope: body.targetScope, signal})
            : await skillLibraries.importMissing({context, token: body.token, ids: body.ids, signal});
          return json(res, 200, result);
        } finally { res.off('close', cancel); }
      }
      const studioSkill = /^\/api\/skill-studio\/([a-f\d-]{36})$/.exec(pathname);
      const studioRestore = /^\/api\/skill-studio\/([a-f\d-]{36})\/restore$/.exec(pathname);
      if (req.method === 'POST' && studioRestore) {
        const body = await input(req, 12000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '恢复版本请求无效。');
        const context = skillContext(body.taskId ?? null, body.projectId);
        return json(res, 201, {skill: skillStudio.restore({context, skillId: studioRestore[1], version: body.version,
          baseVersion: body.baseVersion, confirmed: body.confirmed})});
      }
      if (req.method === 'GET' && studioSkill) {
        const {history, ...skill} = skillStudio.get(studioSkill[1], skillContext(searchParams.get('task') || null, searchParams.get('project')));
        return json(res, 200, {skill, versions: history});
      }
      const studioAction = /^\/api\/skill-studio\/(draft|compare|publish|import|import-directory)$/.exec(pathname);
      if (req.method === 'POST' && studioAction) {
        const body = await input(req, 1_000_000);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(422, '技能请求无效');
        const {taskId = null, skillId, runId, feedback, draft, test, baseVersion, targetScope, sourceRunId = runId} = body;
        for (const id of [taskId, skillId, runId, sourceRunId]) {
          if (id != null && (typeof id !== 'string' || !/^[a-f\d-]{36}$/.test(id))) throw new RequestError(422, '技能或会话编号无效');
        }
        const context = skillContext(taskId, body.projectId);
        if (['import', 'import-directory'].includes(studioAction[1])) {
          const task = taskId !== null ? store.task(taskId) : null;
          if (targetScope === 'project' && !body.projectId && !task?.project_id) throw new RequestError(422, '请先选择目标项目。');
          if (targetScope !== undefined && !['project', 'global'].includes(targetScope)) throw new RequestError(422, '导入范围无效。');
          if (studioAction[1] === 'import-directory') {
            if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 1000) throw new RequestError(422, '请输入本机目录的绝对路径。');
            return json(res, 200, await readSkillDirectory(body.path.trim(), state, AbortSignal.timeout(15_000)));
          }
          return json(res, 200, {draft: cleanDraft(parseSkillFile(body.name, body.content)), baseVersion: 0});
        }
        if (studioAction[1] === 'publish') {
          return json(res, skillId ? 200 : 201, {skill: skillStudio.publish({taskId: context, skillId, baseVersion, draft, sourceRunId, targetScope})});
        }
        const task = taskId === null ? null : store.task(taskId);
        const {model} = settings.snapshot(task ? {model: task.model_id, effort: task.effort} : {});
        if (!model) throw new RequestError(409, '请先在「设置 → 模型」中连接 API。');
        if (studioController) throw new RequestError(409, '技能工坊有一项模型任务在运行，请等待完成。');
        const controller = studioController = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try {
          const result = studioAction[1] === 'draft'
            ? await skillStudio.draft({taskId: context, runId, skillId, feedback, draft, baseVersion, model, signal: controller.signal})
            : await skillStudio.compare({taskId: context, skillId, draft, test, baseVersion, model, signal: controller.signal});
          return json(res, 200, result);
        } catch (error) {
          if (error instanceof RequestError) throw error;
          const message = error?.cause?.name === 'TimeoutError' || error?.name === 'TimeoutError'
            ? '技能模型请求超时，请重试或切换模型。'
            : error instanceof Error ? error.message.slice(0, 200) : '模型请求失败。';
          throw new RequestError(502, message);
        } finally {
          res.off('close', cancel);
          studioController = undefined;
        }
      }
      if (pathname === '/api/tools/contract' && req.method === 'GET') return json(res, 200, {
        version: CONTRACT_VERSION, tools: fileToolRegistry, skills: chatSkillRegistry, workers: [workerTool],
      });
      if (pathname === '/api/audit/contract' && req.method === 'GET') return json(res, 200, {version: 2, tools: auditTools,
        limits: appConfig.audit, planSchema, reportSchema,
        plannerStages: {mapping: mappingDecisionSchema, steps: optionalDecisionSchema},
        plannerErrors: {OUTPUT_TRUNCATED: '模型输出被截断。请扩大预算重试。'}});
      if (pathname === '/api/audit/skills' && req.method === 'GET') return json(res, 200, {...skillRegistry, runtime: auditRuntime});
      if (pathname === '/api/demo' && req.method === 'POST') {
        const {variant = 'replan'} = (await input(req)) ?? {};
        const variants = {replan: '29-tool-failure-replan', unit: '36-multiple-records', plain: '36-multiple-records', 'missing-unit': '30-evidence-failure-ask'};
        if (!Object.hasOwn(variants, variant)) throw new RequestError(422, '演示类型无效');
        let demo = cases.find(item => item.id === variants[variant]);
        if (variant === 'plain') {
          const request = {fields: demo.request.fields.map(({unit, ...field}) => field)};
          demo = {...demo, request, text: 'sample_id,mass\nC,8\n,12\nE,\n',
            plans: [ready([{target: 'sample_id', source: 'sample_id', sourceUnit: '', evidence: 1, rationale: '原表字段相同'},
              {target: 'mass', source: 'mass', sourceUnit: '', evidence: 1, rationale: '仅核对数值和缺失，不作单位转换'}])]};
        }
        const task = store.createTask();
        const inputTable = variant === 'replan' ? cases.find(item => item.id === '36-multiple-records') : demo;
        const text = variant === 'missing-unit' ? 'sample_id,净重\nA,2\n' : inputTable.text;
        const upload = store.addAttachment(task.id, 'demo.csv', 'csv', Buffer.from(text));
        const model = fixtureModel(demo);
        const title = {replan: '离线预检演示：错误映射 → 重规划 → 完成', unit: '有单位的预检与列统计',
          plain: '只做字段映射与逐行检查', 'missing-unit': '净重无单位：拒绝猜测换算'}[variant];
        const run = store.begin(task.id, 'offline-demo', title,
          {mode: 'audit-demo', model: '离线规划夹具', workflow: demo.request}, upload.id);
        await executeAudit({id: run.id, task: task.id, goal: demo.goal, request: demo.request,
          file: store.file(task.id, upload.id), store, model});
        return json(res, 201, {task: task.id, run: run.id});
      }
      const evidence = /^\/api\/tasks\/([a-f\d-]{36})\/files\/([a-f\d-]{36})\/evidence$/.exec(pathname);
      if (evidence && req.method === 'GET') {
        const file = store.file(evidence[1], evidence[2]);
        if (file.size > csvAnalysisMaxBytes) throw new RequestError(422,csvAnalysisSizeMessage);
        if (file.kind !== 'csv') throw new RequestError(422, '仅 CSV 支持记录定位');
        let table;
        try { table = parseCsv(utf8(file.bytes)); } catch { throw new RequestError(422, 'CSV 格式无效'); }
        const record = Number(searchParams.get('record'));
        if (!Number.isInteger(record) || record < 1 || record > table.rows.length + 1) throw new RequestError(404, '来源记录不存在');
        const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
        const row = record === 1 ? table.header : table.rows[record - 2];
        const column = searchParams.get('column');
        if (column && !table.header.includes(column)) throw new RequestError(404, '来源列不存在');
        const body = `<!doctype html><meta charset="utf-8"><title>来源记录</title><h1>${escape(file.name)}</h1><p>SHA-256: ${file.sha256}</p><p>第 ${record} 条逻辑记录（表头为 1；空行忽略，非物理行号）</p><table border="1"><tr><th>列</th><th>原始值</th></tr>${table.header.map((name, i) => `<tr${column === name ? ' bgcolor="#fff1ba"' : ''}><td>${escape(name)}</td><td><pre>${escape(row[i] ?? '')}</pre></td></tr>`).join('')}</table>`;
        res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'"});
        res.end(body); return;
      }
      const fileRoute = /^\/api\/tasks\/([a-f\d-]{36})\/files(?:\/([a-f\d-]{36})(\/preview)?)?$/.exec(pathname);
      if (fileRoute) {
        const [, task, id, preview] = fileRoute;
        if (!id && req.method === 'POST') {
          const name = searchParams.get('name') ?? '';
          return json(res,201,await receiveAttachment(req,{state,task,name,store,
            relativePath:searchParams.get('path')??name,...(searchParams.has('batch')?{batch:searchParams.get('batch')}:{})}));
        }
        if (id && req.method === 'GET') {
          const file = store.file(task, id);
          if (preview) {
            const mime = file.kind === 'image' ? imageMime(await fileHead(file)) : null;
            if (!mime) throw new RequestError(422, '该附件不支持图片预览');
            res.writeHead(200, {'content-type': mime, 'content-length': file.size,
              'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store'});
            await sendAttachment(res,file);
            return;
          }
          res.writeHead(200, {'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}`,
            'content-length': file.size, 'x-content-sha256': file.sha256});
          await sendAttachment(res,file);
          return;
        }
        if (id && !preview && req.method === 'DELETE') {
          const body = await input(req);
          return json(res, 200, store.removeAttachment(task, id, (file, keepHistory) => {
            removeMaterializedAttachment(join(workspace,task),file);
            if(file.disk_path && !keepHistory)rmSync(file.disk_path,{force:true});
          }, body?.detachUsed === true));
        }
      }
      if (pathname === '/api/projects') {
        if (req.method === 'GET') return json(res, 200, store.projects());
        if (req.method === 'POST') {
          const body = await input(req);
          if (typeof body?.path !== 'string' || body.path.length > 1000) throw new RequestError(422, '请输入项目目录的绝对路径');
          const path = await projectDirectory(body.path.trim(), state).catch(error => {
            if (error.contractCode === 'PROTECTED_PATH') throw new RequestError(403, '不能将 Skillinter 私有数据目录添加为项目');
            throw new RequestError(422, '请选择可访问的真实本机目录，不能使用符号链接或网络路径');
          });
          return json(res, 201, store.addProject(path, basename(path) || path));
        }
      }
      if (pathname === '/api/local-folder-picker' && req.method === 'POST') {
        await input(req);
        if (folderPickerController) throw new RequestError(409,'文件夹选择窗口已打开');
        const controller = folderPickerController = new AbortController();
        const cancel = () => controller.abort();
        res.once('close',cancel);
        try {return json(res,200,{path:await pickLocalFolder(controller.signal)});}
        finally {res.off('close',cancel);folderPickerController=undefined;}
      }
      const folderRoute = /^\/api\/tasks\/([a-f\d-]{36})\/folders(?:\/([a-f\d-]{36}))?$/.exec(pathname);
      const browserFolderRoute = /^\/api\/browser-folders\/([a-f\d-]{36})(?:\/([a-f\d-]{36}))?$/.exec(pathname);
      if (browserFolderRoute) {
        const [,channel,id] = browserFolderRoute;
        if (!browserFolderId.test(channel)) throw new RequestError(404,'无效目录连接');
        if (!id && req.method==='GET') return browserFolders.connect(channel,res);
        if (id && req.method==='POST') {
          await browserFolders.reply(channel,id,req,input);
          res.writeHead(204);res.end();return;
        }
      }
      if (folderRoute) {
        const [,task,id] = folderRoute;
        if (!id && req.method==='POST') {
          const body=await input(req);
          if (body?.browser === true) {
            store.checkAttachmentTarget(task);
            return json(res,201,browserFolders.add(task,body));
          }
          if (typeof body?.path!=='string' || !body.path.trim()) throw new RequestError(422,'请选择本机文件夹');
          const path=await projectDirectory(body.path.trim(),state).catch(()=>{throw new RequestError(422,'请选择可读取的本机目录。符号链接、网络位置和应用私有目录无法挂载');});
          return json(res,201,store.addTaskFolder(task,basename(path)||path,path));
        }
        if (id && req.method==='DELETE') {
          await input(req);
          store.checkAttachmentTarget(task);
          if (store.query("SELECT id FROM runs WHERE task=? AND status='running'",'get',task)) throw new RequestError(409,'请结束当前执行后再移除目录');
          if (browserFolders.remove(task,id)) return json(res,200,{id,deleted:true});
          return json(res,200,store.removeTaskFolder(task,id));
        }
      }
      const memoryRoute = /^\/api\/projects\/([a-f\d-]{36})\/memories(?:\/([a-f\d-]{36})(\/verify)?)?$/.exec(pathname);
      if (memoryRoute) {
        const [, project, id, verify] = memoryRoute;
        if (verify && req.method === 'GET') return json(res, 200, await projectMemories.verify(project, id, AbortSignal.timeout(5000)));
        if (!verify && !id && req.method === 'GET') return json(res, 200, {memories: projectMemories.list(project)});
        if (!verify && ((!id && req.method === 'POST') || (id && req.method === 'PUT'))) {
          return json(res, id ? 200 : 201, await projectMemories.save(project, id, await input(req, 12000), AbortSignal.timeout(5000)));
        }
        if (!verify && id && req.method === 'PATCH') return json(res, 200, projectMemories.toggle(project, id, await input(req, 1000)));
        if (!verify && id && req.method === 'DELETE') return json(res, 200, projectMemories.remove(project, id, await input(req, 1000)));
        throw new RequestError(405, '项目记忆操作无效。');
      }
      const accessRoute = /^\/api\/tasks\/([a-f\d-]{36})\/file-access$/.exec(pathname);
      if (accessRoute && req.method === 'PUT') {
        const body = await input(req);
        if (!['attachments', 'project_read', 'project_write', 'full'].includes(body?.mode)) throw new RequestError(422, '文件权限无效');
        const project = projectId(body.project_id);
        if (isProjectScope(body.mode) && !project) throw new RequestError(422, '请先选择一个项目目录');
        return json(res, 200, store.setFileAccess(accessRoute[1], body.mode, project, body.confirmed === true));
      }
      if (pathname === '/api/tasks') {
        if (req.method === 'GET') return json(res, 200, store.tasks(searchParams.get('archived') === '1'));
        if (req.method === 'POST') return json(res, 201, store.createTask(projectId((await input(req))?.project_id)));
      }
      const taskRoute = /^\/api\/tasks\/([a-f\d-]{36})(\/runs|\/preflight)?$/.exec(pathname);
      if (taskRoute) {
        const [, task, runs] = taskRoute;
        if (!runs && req.method === 'GET') {
          const current=store.task(task);
          current.folders.push(...browserFolders.list(task));
          for(const run of current.runs) if(run.status!=='running'){
            const id=skillStudio.experiences.collect(run.id);
            run.experience=id?{id,signals:skillStudio.experiences.get(id,task).signals}:null;
            run.skillFeedback=skillStudio.learning.feedback(run.id);
          }
          return json(res,200,current);
        }
        if (!runs && req.method === 'PATCH') {
          const changes = taskChanges(await input(req));
          if (Object.hasOwn(changes, 'model_id') || Object.hasOwn(changes, 'effort')) {
            const current = store.task(task);
            await settings.validateSelection(Object.hasOwn(changes, 'model_id') ? changes.model_id : current.model_id,
              changes.effort ?? current.effort);
          }
          return json(res, 200, store.editTask(task, changes));
        }
        if (runs && req.method === 'POST') {
          const body = await input(req);
          const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
          if (typeof body?.prompt !== 'string' || prompt.length > 16_000 || typeof body?.request !== 'string' || !/^[\w-]{1,80}$/.test(body.request)) {
            throw new RequestError(422, '请输入消息并提供有效的提交编号');
          }
          const currentTask = store.task(task);
          if (runs === '/preflight') {
            if (!prompt || body.workflow || body.diagnostic || body.skillId || body.file) throw new RequestError(422, '请单独提交材料预检。');
            const request = preflightInput(body.preflight);
            const project = request.source === 'project';
            if (project && (!currentTask.project_id || currentTask.file_access === 'attachments')) {
              throw new RequestError(409, '请先为本会话选择项目并启用项目读取权限。');
            }
            const attachments = project ? [] : currentTask.files;
            if (!project && !attachments.length) throw new RequestError(422, '请先添加本次要预检的附件。');
            const scope = project ? {mode: currentTask.file_access, projectId: currentTask.project_id,
              projectPath: store.project(currentTask.project_id).path} : null;
            const run = store.begin(task, body.request, prompt, {mode: 'preflight', model: '本地材料检查',
              preflight: request, ...(scope ? {fileScope: scope} : {})});
            if (run.started) {
              store.record(run.id, 'request_context', {attachments: attachments.map(({id}) => ({id}))});
              const controller = new AbortController();
              const budget = createRunBudget({store, rootRunId: run.id, signal: controller.signal, limits: {maxModelCalls: 0, maxSeconds: 30}});
              const entry = {controller, preflight: true, job: null};
              active.set(run.id, entry);
              entry.job = executePreflight({store, task, run: run.id, goal: prompt, request, scope: {...scope, state},
                workspace: join(workspace, task), attachments, signal: budget.signal, budget})
                .catch(error => console.error('预检记录写入失败', error.message))
                .finally(() => active.delete(run.id));
            }
            return json(res, run.started ? 201 : 200, run);
          }
          const fileId = body.file ?? null;
          const diagnostic = body.diagnostic === true;
          if (fileId !== null && (typeof fileId !== 'string' || !/^[a-f\d-]{36}$/.test(fileId))) throw new RequestError(422, '附件编号无效');
          if (diagnostic && fileId) throw new RequestError(422, '工具试跑使用本地工作区，不接收附件');
          const attachment = fileId ? store.file(task, fileId) : null;
          if (!prompt && (attachment?.kind !== 'image' || diagnostic || body.workflow)) throw new RequestError(422, '请输入消息或添加图片');
          if (attachment?.run || attachment?.detached) throw new RequestError(422, '请选择当前任务附件作为输入');
          const workflow = body.workflow ?? null;
          if (body.expandedBudget !== undefined && typeof body.expandedBudget !== 'boolean') throw new RequestError(422, '重试预算选项无效');
          if (body.expandedBudget && !workflow) throw new RequestError(422, '扩大预算仅适用于数据预检');
          const ruleMode = body.auditMode === 'rules';
          if (ruleMode && !workflow) throw new RequestError(422, '规则预检需要目标字段');
          if (workflow !== null) {
            const invalid = validateRequest(workflow);
            if (invalid.length) throw new RequestError(422, `目标字段无效：${invalid.join('; ')}`);
            if (diagnostic || attachment?.kind !== 'csv') throw new RequestError(422, '数据预检需要选择一个 CSV 附件');
          }
          const skillId = body.skillId ?? null;
          if (skillId !== null && (typeof skillId !== 'string' || !/^[a-f\d-]{36}$/.test(skillId) || workflow || diagnostic)) {
            throw new RequestError(422, '已发布技能只能用于普通会话');
          }
          const skillVersion = body.skillVersion;
          if (skillVersion !== undefined && (!skillId || !Number.isSafeInteger(skillVersion) || skillVersion < 1)) {
            throw new RequestError(422, '技能版本无效');
          }
          const skill = workflow || skillId || settings.snapshot().model ? null : selectSkill(prompt, attachment);
          if ((workflow || skill) && attachment?.size > csvAnalysisMaxBytes) throw new RequestError(422,csvAnalysisSizeMessage);
          const taskWorkspace = join(workspace, task);
          if (!workflow) await mkdir(taskWorkspace, {recursive: true});
          const materials = workflow ? [] : currentTask.files.map(file => ({id: file.id, name: file.name, kind:file.kind, relativePath:file.relativePath??file.name, path: file.workspacePath??`${file.id}.${file.kind}`, sha256: file.sha256, size: file.size}));
          for (const material of materials) {
            const file = store.file(task, material.id);
            await materializeAttachment(taskWorkspace,material,file);
          }
          const selection = {model: currentTask.model_id, effort: currentTask.effort};
          if (!diagnostic && !skill && !ruleMode) await settings.validateSelection(selection.model, selection.effort);
          const config = ruleMode ? {mode: 'audit-rules', model: rulesModel()} :
            diagnostic ? {mode: 'diagnostic', model: {label: '本地工具试跑', invoke: demoModel()}, maxSteps: 2} : settings.snapshot(selection);
          if (!skill && !config.model) throw new RequestError(409, '请先在「设置 → 模型」中连接 API。也可以使用本地材料预检。');
          const fileScope = !workflow && !diagnostic && !skill ? {mode: currentTask.file_access, projectId: currentTask.project_id,
            projectPath: currentTask.project_id && currentTask.file_access !== 'attachments' ? store.project(currentTask.project_id).path : null} : null;
          const limits = workflow ? auditLimits(config.model.label, undefined, body.expandedBudget === true) : null;
          const learnedWeights = fileScope ? skillStudio.learning.weights(currentTask.project_id,prompt) : new Map();
          const localSkills = fileScope ? skillStudio.enabled(task).map(skill => ({...skill,learningWeight: learnedWeights.get(skill.id) ?? 0})) : [];
          const customSkill = skillId ? localSkills.find(skill => skill.id === skillId) : null;
          if (skillId && !customSkill) throw new RequestError(404, '技能不存在或不属于当前项目');
          const runConfig = workflow ? {mode: ruleMode ? 'audit-rules' : 'audit', model: config.model.label, effort: config.effort ?? 'default', workflow, limits, expandedBudget: body.expandedBudget === true}
            : skill ? {mode: 'skill', model: '本地技能执行', maxSteps: 0}
              : {mode: config.mode, model: config.model.label, maxSteps: config.maxSteps, effort: config.effort ?? 'default', autoApproveExecution:config.autoApproveExecution === true, ...(fileScope ? {fileScope} : {}),
                ...(customSkill ? {customSkill: {id: customSkill.id, name: customSkill.name, version: customSkill.version}} : {})};
          for (const material of materials) if (store.file(task, material.id).detached) throw new RequestError(409,'附件列表已变化，请重新发送');
          const folders = fileScope ? [...store.taskFolders(task),...browserFolders.scope(task)] : [];
          if (folders.length) runConfig.inputFolders = folders.map(({id,name}) => ({id,name}));
          const run = store.begin(task, body.request, prompt, runConfig, fileId, skillVersion);
          if (run.started) {
            const controller = new AbortController();
            const entry = {controller, interrupt: null, job: null, autoApproveExecution:config.autoApproveExecution === true};
            active.set(run.id, entry);
            entry.job = (workflow ? executeAudit({id: run.id, task, goal: prompt, request: workflow, store,
              file: attachment, model: config.model, limits, signal: controller.signal, entry}) : executeRun({id: run.id, task, prompt, store, workspace: taskWorkspace, ...config, skill, attachment,
              scope: fileScope ? {...fileScope, state, folders} : null,
              skillRegistrySnapshot:skillRegistry.snapshot(task,localSkills),
              skillEngine: null,
              projectMemories,
              skillSources:appConfig.skillSources,
              githubAccess,
              installSkill:({card,entries})=>skillStudio.installDiscovered({context:task,card,entries}),
              context: {title: currentTask.title, goal: prompt, selectedFile: attachment ? {id: attachment.id, name: attachment.name, kind: attachment.kind} : null,
                folders: folders.map(folder=>({name:folder.name,path:`folder:${folder.id}`})),
                materials: materials.map(material => ({...material,
                path: fileScope?.mode && fileScope.mode !== 'attachments' ? 'attachment:' + material.path : material.path})),
                fileAccess: fileScope, stage: '用户未提供', successCriteria: '用户未提供', deadline: '用户未提供'},
              signal: controller.signal, entry, skillAccess: !diagnostic, customSkill, localSkills}))
              .catch(error => { console.error('执行记录写入失败', error.message); })
              .finally(() => {
                active.delete(run.id);
                skillStudio.learning.recordRun(run.id);
                skillStudio.experiences.collect(run.id);
              });
          }
          return json(res, run.started ? 201 : 200, run);
        }
      }
      const runRoute = /^\/api\/runs\/([a-f\d-]{36})\/(events|stop|guide|project-test-decision|skill-feedback|budget-decision)$/.exec(pathname);
      if (runRoute) {
        const [, id, action] = runRoute;
        const run = store.run(id);
        if (action === 'budget-decision' && req.method === 'POST') {
          const body = await input(req);
          const pending = active.get(id)?.inputBudgetApproval;
          if (typeof body?.id !== 'string' || typeof body?.approve !== 'boolean') throw new RequestError(422,'预算确认无效。');
          if (run.status !== 'running' || pending?.id !== body.id || !pending.decide(body.approve)) {
            throw new RequestError(409,'预算确认已处理或任务已停止。');
          }
          return json(res,200,{ok:true});
        }
        if (action === 'skill-feedback' && req.method === 'POST') {
          const body = await input(req,12000);
          if (run.status !== 'completed' || body?.taskId !== run.task) throw new RequestError(409,'只能评价当前会话的已完成任务。');
          const learning = skillStudio.learning;
          const targets = learning.participants(id);
          if (targets.length && studioController) throw new RequestError(409,'技能工坊正在生成候选，请稍后再试。');
          learning.saveFeedback(id,body.rating,body.note ?? '');
          learning.recordRun(id);
          const experienceId = skillStudio.experiences.collect(id);
          const results = [];
          if (targets.length && experienceId) {
            const task = store.task(run.task);
            const {model} = settings.snapshot({model:task.model_id,effort:task.effort});
            const controller = studioController = new AbortController();
            const cancel = () => controller.abort();
            res.once('close',cancel);
            try {
              for (const skill of targets) {
                if (controller.signal.aborted) break;
                try {
                  const proposal = await skillStudio.experiences.propose({id:experienceId,context:run.task,skillId:skill.id,
                    model,signal:controller.signal});
                  results.push({name:skill.name,candidateId:proposal.candidateId});
                } catch (error) {
                  results.push({name:skill.name,error:error instanceof RequestError ? error.message : '候选生成失败。'});
                }
              }
            } finally {
              res.off('close',cancel);
              studioController = undefined;
            }
          }
          return json(res,200,{rating:body.rating,experienceId,results});
        }
        if (action === 'guide' && req.method === 'POST') {
          const body = await input(req);
          const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt || prompt.length > 4000 || typeof body.request !== 'string' || !/^[\w-]{1,80}$/.test(body.request)) {
            throw new RequestError(422, '引导消息需为 1–4000 字，并提供提交编号');
          }
          const entry = active.get(id);
          if (entry?.preflight) throw new RequestError(409, '本轮正在按已提交的范围检查，请在下一轮补充要求。');
          if (!entry && run.status === 'running') throw new RequestError(409, '本轮由其他服务进程管理，请稍后再试');
          const result = store.guide(id, body.request, prompt);
          if (!result.reused) {
            entry?.testApproval?.decide('superseded');
            entry?.interrupt?.abort();
          }
          return json(res, 200, result);
        }
        if (action === 'project-test-decision' && req.method === 'POST') {
          const body = await input(req);
          if (typeof body?.id !== 'string' || !['approve', 'decline'].includes(body.decision)) throw new RequestError(422, '项目测试确认无效');
          const pending = active.get(id)?.testApproval;
          if (run.status !== 'running' || pending?.id !== body.id || !pending.decide(body.decision)) {
            throw new RequestError(409, '该次项目测试已处理或确认已失效');
          }
          return json(res, 200, {ok: true});
        }
        if (action === 'events' && req.method === 'GET') {
          const cursor = Number(req.headers['last-event-id'] ?? 0);
          return stream(res, store, id, Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
        }
        if (action === 'stop' && req.method === 'POST') {
          await input(req);
          const entry = active.get(id);
          if (!entry && run.status === 'running') throw new RequestError(409, '执行由另一个服务进程管理');
          entry?.controller.abort();
          await entry?.job;
          return json(res, 200, store.run(id));
        }
      }
      throw new RequestError(404, '页面或接口不存在');
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      if (res.destroyed) return;
      if (res.headersSent) res.end();
      else json(res, error instanceof RequestError ? error.status : 500, {error: error instanceof RequestError ? error.message : '服务内部错误'});
    }
  });
  server.requestTimeout=0; // Uploads stream to disk; do not impose a total transfer-size/time cutoff.

  return {server, async close() {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    studioController?.abort();
    optimizerController?.abort();
    folderPickerController?.abort();
    browserFolders.close();
    const entries = [...active.values()];
    for (const {controller} of entries) controller.abort();
    await Promise.all(entries.map(({job}) => job));
    await skillStudio.candidates.executions.close();
    await githubAccess.close();
    server.closeAllConnections();
    await closed;
    store.db.close();
  }};
}
