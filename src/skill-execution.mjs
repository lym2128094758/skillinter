import {randomUUID, createHash} from 'node:crypto';
import {constants, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, writeFile, readdir, open, rm} from 'node:fs/promises';
import {join, dirname, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {RequestError, Store} from './store.mjs';
import {validate, object, string} from './schema.mjs';
import {deliverySchema, validDelivery, freezeDelivery, verifyDelivery} from './skill-delivery.mjs';
import {preflightSnapshot} from './tools.mjs';
import {skillMarkdown} from './skill-files.mjs';
import {parseSkillFile} from './skill-import.mjs';
import {checkedLocalPath, inside} from './file-scope.mjs';
import {readCitationReceipts} from './citation-verifier.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const named = maxLength => ({type:'string',minLength:1,maxLength});
const pathOK = path => typeof path === 'string' && !/^[\\/]|[:\x00-\x1f]/.test(path) && path.split(/[\\/]/).every(part=>part&&!part.startsWith('.')&&!/[<>"|?*]|[ .]$/.test(part)&&!/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part));
const key = text => text.normalize('NFKC').replace(/\s+/g,' ').trim();
const caseInput = item => digest([key(item.prompt), item.files]);
export const executionCaseId = item => digest([caseInput(item), item.acceptance]);
const executionCaseSchema = object({name:named(100),prompt:named(8000),
  files:{type:'array',maxItems:12,items:object({path:named(300),content:{type:'string',maxLength:64000}})},acceptance:deliverySchema});
executionCaseSchema.properties.sourceExperienceId = {type: 'string', minLength: 36, maxLength: 36};
executionCaseSchema.properties.sourceConfirmed = {type: 'boolean'};
export const executionPlanSchema = object({
  cases:{type:'array',maxItems:4,items:executionCaseSchema},
  budget:object({maxCalls:{type:'integer',minimum:2,maximum:12},maxSeconds:{type:'integer',minimum:15,maximum:180},maxOutputTokens:{type:'integer',minimum:256,maximum:8192}}),
});
export const executionTools = ['list_workspace','read_file','create_file','replace_in_file','load_skill','inspect_skill',
  'read_skill_resource','start_skill','finish_skill','verify_skill_output','update_plan'];
export const executionSha256 = digest(['skill-execution.mjs','runner.mjs','skill-session.mjs','skill-delivery.mjs','citation-verifier.mjs','task-capabilities.mjs','task-preparation.mjs','document-tools.mjs','online-skills.mjs','git-skill-source.mjs','github-access.mjs','settings.mjs','python-tool.mjs','process-runtime.mjs','../scripts/extract-document.py','tools.mjs','file-scope.mjs','schema.mjs',
  'chat-skills.mjs','task-plan.mjs','preflight.mjs','skill-files.mjs','skill-routing.mjs','skill-registry.mjs',
  'run-budget.mjs','context-manager.mjs','skill-retrieval.mjs','skill-intelligence.mjs','../config.yaml']
  .map(path=>readFileSync(new URL(path,import.meta.url),'utf8')));
const canonical = skill => ({name:skill.name,description:skill.description,instructions:skill.instructions,tests:skill.tests,
  ...(skill.applicability?{applicability:skill.applicability}:{}),...(skill.delivery?{delivery:skill.delivery}:{})});

// Freeze only the registered skill package. Never copy a user's project tree.
export async function packageSnapshot(skill) {
  if(!skill?.storagePath)return [];
  async function checked(path, root) {
    try {
      const {physical, stat} = await checkedLocalPath(path);
      if (root && !inside(root, physical) || stat.isFile() && stat.nlink > 1) {
        throw new RequestError(422, '技能包含链接，不能冻结为执行对照。');
      }
      return {physical, stat};
    } catch (error) {
      if (error.contractCode === 'SYMLINK_NOT_ALLOWED') throw new RequestError(422, '技能包含链接，不能冻结为执行对照。');
      throw error;
    }
  }
  const {physical: root} = await checked(dirname(skill.storagePath));
  const files = [];
  let total = 0, visited = 0;
  async function walk(directory,depth=0) {
    if(depth>6||++visited>150)throw new RequestError(422,'技能包超出冻结范围，请使用较小的自包含方法。');
    await checked(directory, root);
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if(entry.name.startsWith('.')||['node_modules','__pycache__'].includes(entry.name))continue;
      const path=join(directory,entry.name);
      const {physical} = await checked(path, root);
      if(entry.isDirectory()){await walk(path,depth+1);continue;}
      if(!entry.isFile())throw new RequestError(422,'技能包含非普通文件，不能用于执行对照。');
      const relativePath=relative(root,path).replaceAll('\\','/');
      if(!pathOK(relativePath))throw new RequestError(422,'技能资源路径无效。');
      const handle=await open(physical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try {
        const before=await handle.stat();if(!before.isFile()||before.size>256000||before.nlink>1)throw new RequestError(422,'单个技能资源超过 256 KB、不是普通文件或为链接。');
        const buffer=Buffer.alloc(before.size+1);let length=0;
        while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
        const after=await handle.stat();const {stat: current}=await checked(path, root);
        if(length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||current.ino!==after.ino||current.mtimeMs!==after.mtimeMs)throw new RequestError(409,'技能资源在冻结期间变化，请重试。');
        const bytes=buffer.subarray(0,length);total+=length;
        if(total>1024*1024||files.length>=64)throw new RequestError(422,'技能资源总量超过 1 MiB 或 64 项，请缩小技能包。');
        if(relativePath==='SKILL.md'){
          const parsed=parseSkillFile('SKILL.md',new TextDecoder('utf-8',{fatal:true}).decode(bytes));
          for(const field of ['name','description','instructions','applicability','delivery'])if(JSON.stringify(parsed[field])!==JSON.stringify(skill[field]))throw new RequestError(409,'技能内容已变化，请重新读取。');
        } else files.push({path:relativePath,base64:bytes.toString('base64'),sha256:hash(bytes)});
      }finally{await handle.close();}
    }
  }
  await walk(root);return files;
}

export function createSkillExecutions(store,{getCandidate,ensureCurrent,resolveCaseSource}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS skill_execution_plans (id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,snapshot TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_execution_trials (id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,candidate_id TEXT NOT NULL,status TEXT NOT NULL,owner INTEGER NOT NULL,started_at TEXT NOT NULL,record TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_candidate_running ON skill_execution_trials(candidate_id) WHERE status='running';
    CREATE TABLE IF NOT EXISTS skill_execution_files (id TEXT PRIMARY KEY,trial_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL);`);
  const jobs=new Map();
  const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
  function regressionsFor(skillId) {
    if (!skillId) return [];
    const rows = store.query(`SELECT c.published_version AS version, r.evidence, p.snapshot, p.sha256
      FROM skill_candidates c JOIN skill_candidate_releases r ON r.candidate_id=c.id
      LEFT JOIN skill_execution_plans p ON p.id=json_extract(r.evidence,'$.planId') AND p.candidate_id=c.id
      WHERE c.published_skill_id=? AND json_extract(r.evidence,'$.scope')='isolated-file-execution'
      ORDER BY c.published_version`, 'all', skillId);
    const cases = new Map();
    for (const row of rows) {
      const proof = JSON.parse(row.evidence);
      const plan = JSON.parse(row.snapshot);
      if (!plan || row.sha256 !== proof.planSha256 || digest(plan) !== row.sha256) {
        throw new RequestError(409, '已发布版本的回归计划无法核对，请检查版本证据。');
      }
      for (const [index, sample] of plan.spec.cases.entries()) {
        const id = executionCaseId(sample);
        if (!cases.has(id)) cases.set(id, {id, sample, version: row.version, trialId: proof.trialId, source: plan.caseSources?.[index] ?? null});
      }
    }
    return [...cases.values()];
  }
  function get(id,context) {
    const row=store.query('SELECT * FROM skill_execution_plans WHERE id=?','get',id);
    if(!row)throw new RequestError(404,'执行对照计划不存在。');
    getCandidate(row.candidate_id,context);
    for(const trial of store.query("SELECT id,owner,record FROM skill_execution_trials WHERE plan_id=? AND status='running'",'all',id)){
      if(!jobs.has(trial.id)&&!processAlive(trial.owner)){
        const record={...JSON.parse(trial.record),verdict:'unknown',reason:'原执行服务已退出，保留部分组，不自动重发模型请求。',finishedAt:new Date().toISOString()};
        store.query("UPDATE skill_execution_trials SET status='interrupted',record=? WHERE id=? AND status='running'",'run',JSON.stringify(record),trial.id);
      }
    }
    const trials=store.query('SELECT id,status,record FROM skill_execution_trials WHERE plan_id=? ORDER BY rowid DESC','all',id).map(row=>({id:row.id,status:row.status,...JSON.parse(row.record)}));
    return {id:row.id,candidateId:row.candidate_id,sha256:row.sha256,createdAt:row.created_at,...JSON.parse(row.snapshot),trials};
  }
  async function freeze({candidateId,context,spec}) {
    if(validate(executionPlanSchema,spec).length)throw new RequestError(422,'请填写最多 4 个新任务、验收条件及有效预算。');
    const candidate=getCandidate(candidateId,context);if(candidate.publishedVersion)throw new RequestError(409,'候选已发布，请另建改进候选。');
    const current=ensureCurrent(candidate,context);
    if(JSON.stringify(spec).length>300000)throw new RequestError(422,'测试材料过大，请将总内容控制在 300 KB 内。');
    const source=candidate.sourceEvidence;
    const training=[source?.selected.prompt,...(source?.preceding??[]).map(item=>item.prompt),...(source?.subsequentUserMessages??[]).map(item=>item.text)].filter(Boolean).map(key);
    const prompts=spec.cases.map(item=>key(item.prompt));
    if(new Set(prompts).size!==prompts.length||prompts.some(prompt=>training.includes(prompt)))throw new RequestError(422,'测试任务不能重复，也不能直接使用候选来源对话。');
    for(const item of spec.cases){
      if(!validDelivery(item.acceptance)||item.files.some(file=>!pathOK(file.path)))throw new RequestError(422,'测试文件路径或产物验收条件无效。');
      const paths=item.files.map(file=>file.path.replaceAll('\\','/').toLowerCase());
      if(new Set(paths).size!==paths.length||paths.some(path=>paths.some(other=>other!==path&&other.startsWith(path+'/'))))throw new RequestError(422,'测试文件路径重复或存在目录冲突。');
      if(item.acceptance.preserve_inputs.some(path=>!paths.includes(path.replaceAll('\\','/').toLowerCase())))throw new RequestError(422,'须保留的原始输入必须包含在冻结材料中。');
      if(candidate.sourceEvidence?.skillDeliveries?.some(result=>result.files?.some(file=>file.role==='input'&&item.files.some(input=>hash(input.content)===file.sha256))))throw new RequestError(422,'测试材料与已记录来源输入相同，请使用独立样例。');
    }
    const regressions = regressionsFor(candidate.skillId);
    const historicalInputs = new Map(regressions.map(item => [caseInput(item.sample), item.id]));
    const additions = [];
    for (const {sourceExperienceId, sourceConfirmed, ...sample} of spec.cases) {
      if (sourceExperienceId && (!/^[a-f\d-]{36}$/.test(sourceExperienceId) || sourceConfirmed !== true)) {
        throw new RequestError(422, '请核对经验用例的测试指令、材料和预期结果后再冻结。');
      }
      const source = sourceExperienceId ? resolveCaseSource({id: sourceExperienceId, context, candidate, sample}) : null;
      const historical = historicalInputs.get(caseInput(sample));
      if (historical && historical !== executionCaseId(sample)) {
        throw new RequestError(422, '历史回归用例的验收条件已固定。请用新的测试材料或任务扩展覆盖。');
      }
      if (!historical) additions.push({sample, source});
    }
    const entries = [...regressions, ...additions];
    const frozenSpec = {...spec, cases: entries.map(item => item.sample)};
    if (frozenSpec.cases.length < 2) throw new RequestError(422, '计划至少需要 2 个独立任务，可包含历史回归用例。');
    if (frozenSpec.cases.length > 20 || JSON.stringify(frozenSpec).length > 2_000_000) {
      throw new RequestError(422, '合并后的回归计划最多 20 个任务和 2 MB 材料。请减少新任务。');
    }
    const resources=await packageSnapshot(current);
    const snapshot={spec:structuredClone(frozenSpec),regressionIds:regressions.map(item => item.id),caseSources:entries.map(item => item.source),
      candidateSha256:candidate.sha256,baselineSha256:candidate.baselineSha256,
      baseline:candidate.baseline,draft:candidate.draft,baseVersion:candidate.baseVersion,resources,
      executionSha256,scope:'isolated-file-execution',tools:executionTools,
      note:'两组使用相同的冻结材料与预算。测试判据由宿主在执行后检查，模型只使用该组原有的技能定义。'};
    snapshot.inputSha256=frozenSpec.cases.map(item=>digest(item.files));snapshot.acceptanceSha256=frozenSpec.cases.map(item=>digest(item.acceptance));
    const sha256=digest(snapshot),id=randomUUID();store.query('INSERT INTO skill_execution_plans VALUES (?,?,?,?,?)','run',id,candidateId,JSON.stringify(snapshot),sha256,new Date().toISOString());
    return get(id,context);
  }
  async function leg({plan,test,index,side,trialId,model,signal,saveLeg}) {
    const temporary=await mkdtemp(join(tmpdir(),'sih-paired-')),workspace=join(temporary,'workspace');let local;
    const result={status:'running',verification:null,modelRequests:[],artifacts:[],inputSha256:plan.inputSha256[index],acceptanceSha256:plan.acceptanceSha256[index]};
    const started=performance.now();
    try {
      await mkdir(workspace);for(const file of test.files){const target=join(workspace,file.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,file.content,'utf8');}
      for(const artifact of test.acceptance.artifacts)await mkdir(dirname(join(workspace,artifact.path)),{recursive:true});
      local=new Store(join(temporary,'runtime.sqlite'));const project=local.addProject(workspace,'isolated-evaluation'),task=local.createTask(project.id);
      const run=local.begin(task.id,'paired',test.prompt,{mode:'api',model:model.label});const scope={mode:'project_write',projectId:project.id,projectPath:workspace};
      const bound=AbortSignal.any([signal,AbortSignal.timeout(plan.spec.budget.maxSeconds*1000)]);
      const frozen=await freezeDelivery({contract:test.acceptance,scope,signal:bound});
      const selected=side==='baseline'?plan.baseline:plan.draft;let skill;
      if(selected){
        const packagePath=join(temporary,'skill');await mkdir(packagePath);
        for(const resource of plan.resources){const path=join(packagePath,resource.path);await mkdir(dirname(path),{recursive:true});const bytes=Buffer.from(resource.base64,'base64');if(hash(bytes)!==resource.sha256)throw Error('Resource fingerprint mismatch');await writeFile(path,bytes);}
        const storagePath = join(packagePath, 'SKILL.md');
        await writeFile(storagePath, skillMarkdown(selected), 'utf8');
        skill = {...selected, id: randomUUID(), version: side === 'baseline' ? plan.baseVersion : plan.baseVersion + 1, storagePath};
      }
      const {executeRun}=await import('./runner.mjs');
      await executeRun({id:run.id,task:task.id,prompt:test.prompt,store:local,workspace,scope,model,signal:bound,
        maxSteps:plan.spec.budget.maxCalls,maxOutputPerCall:plan.spec.budget.maxOutputTokens,
        skillAccess:true,customSkill:skill,localSkills:skill?[skill]:[],toolAllowlist:executionTools,
        context:{evaluation:{isolated:true,scope:'Only supplied test files; no original project access.'}}});
      const detail=local.task(task.id).runs[0];result.runStatus=detail.status;result.answer=detail.answer;result.error=detail.error;
      result.events=local.events(run.id,0).filter(event=>event.type!=='progress');
      const settlements = new Map(result.events.filter(event => event.type === 'budget_settled').map(({payload}) => [payload.id, payload]));
      result.modelRequests = result.events.filter(event => event.type === 'budget_reserved' && event.payload.kind === 'model').map(({payload}) => {
        const settled = settlements.get(payload.id);
        return {requestedModel: payload.model, maxTokens: payload.outputReserved, reportedModel: settled?.reportedModel ?? null,
          finishReason: settled?.finishReason ?? null, usage: settled?.inputTokens == null || settled?.outputTokens == null ? null :
            {prompt_tokens: settled.inputTokens, completion_tokens: settled.outputTokens}};
      });
      // A fresh signal allows bounded read-only final checks after an execution timeout.
      result.verification=await verifyDelivery({frozen,scope,signal:AbortSignal.timeout(15000),
        readReceipts: readCitationReceipts(local.events(run.id, 0))});
      const startedSkill = skill && detail.skillTrace?.graph.nodes.some(item => item.id === skill.id && item.started);
      const operations = startedSkill ? result.events.filter(event => event.type === 'tool_result' && event.payload.skillId === skill.id) : [];
      const adopted = !skill || operations.some(({payload}) => payload.output.ok && ['read_file','create_file','replace_in_file'].includes(payload.name));
      // An empty fixture can prove a missing-input failure through the bound read receipt.
      // It still takes a successful operation to credit a passing skill execution.
      const diagnosedMissingInput = test.files.length === 0 && detail.status === 'completed' && result.verification.status === 'failed' &&
        operations.some(({payload}) => payload.name === 'read_file' && payload.output.error?.code === 'NOT_FOUND');
      result.skillParticipated=Boolean(adopted);result.skillApplied=!skill||detail.skillApplications.some(item=>item.id===skill.id&&item.status==='applied');
      result.status=bound.aborted?'unknown':detail.status==='failed'&&!/调用次数上限|调用预算已耗尽/.test(detail.error??'')?'unknown':result.verification.status==='unknown'||!adopted&&!diagnosedMissingInput?'unknown':
        detail.status==='completed'&&result.verification.status==='passed'?'passed':'failed';
      for(const artifact of test.acceptance.artifacts){
        const snapshot=await preflightSnapshot({...scope,mode:'project_read'},artifact.path,AbortSignal.timeout(15000));if(snapshot.error)continue;
        const id=randomUUID(),sha256=hash(snapshot.bytes);store.query('INSERT INTO skill_execution_files VALUES (?,?,?,?,?)','run',id,trialId,artifact.path,sha256,snapshot.bytes);
        result.artifacts.push({id,path:artifact.path,sha256,bytes:snapshot.bytes.length});
      }
    } catch(error){result.status='unknown';result.error=error instanceof RequestError?error.message:'本组执行未完成，保留已有记录。';}
    finally{
      result.elapsedMs=Math.round(performance.now()-started);local?.db.close();
      // This target is returned directly by mkdtemp, never derived from user paths.
      if(resolve(temporary).startsWith(resolve(join(tmpdir(),'sih-paired-'))))await rm(temporary,{recursive:true,force:true}).catch(()=>{});
      saveLeg(result);
    }
    return result;
  }
  async function run({id,context,model,signal,modelOptions={effort:'default'}}) {
    const plan=get(id,context),candidate=getCandidate(plan.candidateId,context);ensureCurrent(candidate,context);
    if(candidate.publishedVersion)throw new RequestError(409,'候选已发布，请从当前版本另建改进候选。');
    if(plan.executionSha256!==executionSha256)throw new RequestError(409,'执行实现已变化，请重新冻结测试计划。');
    if(!model?.invoke)throw new RequestError(409,'请先连接可用的模型。');
    const trialId=randomUUID(),controller=new AbortController(),bound=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const record={startedAt:new Date().toISOString(),planSha256:plan.sha256,requestedModel:model.label,modelOptions,executionSha256,pairs:[],verdict:'unknown',reason:'执行对照尚未完成。'};
    store.transaction(()=>{
      const previous=store.query("SELECT id,owner FROM skill_execution_trials WHERE candidate_id=? AND status='running'",'get',plan.candidateId);
      if(previous){if(processAlive(previous.owner))throw new RequestError(409,'此候选已有执行对照，请等待或停止。');store.query("UPDATE skill_execution_trials SET status='interrupted' WHERE id=?",'run',previous.id);}
      store.query('INSERT INTO skill_execution_trials VALUES (?,?,?,?,?,?,?)','run',trialId,id,plan.candidateId,'running',process.pid,record.startedAt,JSON.stringify(record));
    });
    const persist=()=>store.query('UPDATE skill_execution_trials SET record=? WHERE id=?','run',JSON.stringify(record),trialId);
    const job=Promise.resolve().then(async()=>{
      try{
        for(let index=0;index<plan.spec.cases.length;index++){
          bound.throwIfAborted();const pair={index,name:plan.spec.cases[index].name};record.pairs.push(pair);persist();
          for(const side of index%2?['candidate','baseline']:['baseline','candidate']){
            bound.throwIfAborted();await leg({plan,test:plan.spec.cases[index],index,side,trialId,model,signal:bound,saveLeg:result=>{pair[side]=result;persist();}});
          }
        }
        ensureCurrent(candidate,context);
        const legs=record.pairs.flatMap(pair=>[pair.baseline,pair.candidate]);
        const models=new Set(legs.flatMap(item=>item.modelRequests.map(request=>request.reportedModel)));
        const unknown=legs.some(item=>item.status==='unknown')||models.size!==1||models.has(null);
        const regressed=record.pairs.some(pair=>pair.baseline.status==='passed'&&pair.candidate.status!=='passed');
        const improved=record.pairs.filter(pair=>pair.baseline.status==='failed'&&pair.candidate.status==='passed').length;
        Object.assign(record,{total:record.pairs.length,baselinePassed:record.pairs.filter(pair=>pair.baseline.status==='passed').length,
          candidatePassed:record.pairs.filter(pair=>pair.candidate.status==='passed').length,improvedCases:improved,regressed,
          verdict:unknown?'unknown':regressed||record.pairs.some(pair=>pair.candidate.status!=='passed')?'failed':improved?'improved':'no_gain',
          reason:unknown?'存在未完成、未实际采用技能或模型身份未确认的组，不能确认增益。':regressed?'候选存在回退，保留原版本。':record.pairs.some(pair=>pair.candidate.status!=='passed')?'候选仍有任务未通过，保留原版本。':improved?'冻结的实际任务产物有新增通过且无回退；只证明本测试集范围。':'没有测出实际产物增益，保留原版本。',finishedAt:new Date().toISOString()});
        persist();store.query("UPDATE skill_execution_trials SET status='completed' WHERE id=?",'run',trialId);
      }catch(error){record.reason=bound.aborted?'执行对照已停止，部分组记录保留。':error instanceof RequestError?error.message:'执行对照未完成，已保留部分组。';record.finishedAt=new Date().toISOString();persist();store.query("UPDATE skill_execution_trials SET status='interrupted' WHERE id=?",'run',trialId);}
      finally{jobs.delete(trialId);}
    });
    jobs.set(trialId,{controller,job,planId:id});return {trialId,job};
  }
  return {freeze,get,run,regressionsFor,stop(id,context){const plan=get(id,context);for(const trial of plan.trials){if(jobs.has(trial.id))jobs.get(trial.id).controller.abort();else if(trial.status==='running')throw new RequestError(409,'此运行由另一个服务进程管理，请回到启动它的服务停止。');}return get(id,context);},
    list(candidateId,context){getCandidate(candidateId,context);return store.query('SELECT id FROM skill_execution_plans WHERE candidate_id=? ORDER BY rowid DESC','all',candidateId).map(row=>get(row.id,context));},
    file(planId,trialId,fileId,context){const plan=get(planId,context);if(!plan.trials.some(trial=>trial.id===trialId))throw new RequestError(404,'执行组不存在。');const file=store.query('SELECT * FROM skill_execution_files WHERE id=? AND trial_id=?','get',fileId,trialId);if(!file)throw new RequestError(404,'产物不存在。');return file;},
    async close(){for(const {controller}of jobs.values())controller.abort();await Promise.all([...jobs.values()].map(item=>item.job));},
  };
}
