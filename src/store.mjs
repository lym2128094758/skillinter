import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {summarizeRun} from './run-outcome.mjs';

// Shared by model history and active plans. Queries bind r to runs and t to tasks.
export const visibleRunContext = `NOT EXISTS (SELECT 1 FROM events origin WHERE origin.run=r.id AND origin.type='started'
  AND json_type(origin.payload,'$.fileScope')='object'
  AND (json_extract(origin.payload,'$.fileScope.projectId') IS NOT t.project_id
    OR (json_extract(origin.payload,'$.fileScope.mode')='full' AND t.file_access<>'full')
    OR (t.file_access='attachments' AND json_extract(origin.payload,'$.fileScope.projectPath') IS NOT NULL)))`;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), request TEXT NOT NULL,
        prompt TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, error TEXT, owner INTEGER NOT NULL,
        UNIQUE(task, request)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(task) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run, seq);
      CREATE TABLE IF NOT EXISTS run_guidance (
        run TEXT NOT NULL REFERENCES runs(id), request TEXT NOT NULL, prompt TEXT NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run, request)
      );
      CREATE TABLE IF NOT EXISTS task_files (
        id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), run TEXT REFERENCES runs(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_files_by_task ON task_files(task);
      CREATE TABLE IF NOT EXISTS task_folders (
        id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id),
        name TEXT NOT NULL, path TEXT NOT NULL, UNIQUE(task,path)
      );
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO preferences VALUES (1, 0, '{}');
    `);
    this.transaction(() => {
      const fileColumns = new Set(this.query('PRAGMA table_info(task_files)', 'all').map(column => column.name));
      for (const [name, type] of [['disk_path','TEXT'],['stored_size','INTEGER'],['relative_path','TEXT'],['workspace_path','TEXT'],['detached','INTEGER NOT NULL DEFAULT 0']]) {
        if (!fileColumns.has(name)) this.db.exec(`ALTER TABLE task_files ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS task_files_workspace ON task_files(task, workspace_path) WHERE workspace_path IS NOT NULL');
      const columns = new Set(this.query('PRAGMA table_info(tasks)', 'all').map(column => column.name));
      for (const name of ['pinned', 'archived']) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
      if (!columns.has('model_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN model_id TEXT');
      if (!columns.has('effort')) this.db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'default'");
      if (!columns.has('project_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)');
      if (!columns.has('file_access')) this.db.exec("ALTER TABLE tasks ADD COLUMN file_access TEXT NOT NULL DEFAULT 'attachments'");
      if (!this.query('PRAGMA table_info(runs)', 'all').some(column => column.name === 'input_file')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN input_file TEXT');
      }
    });
  }

  query(sql, method, ...params) {
    return this.db.prepare(sql)[method](...params);
  }

  preferences() {
    const {revision, value} = this.query('SELECT revision, value FROM preferences WHERE id = 1', 'get');
    return {revision, value: JSON.parse(value)};
  }

  savePreferences(revision, value) {
    const result = this.query('UPDATE preferences SET revision = revision + 1, value = ? WHERE id = 1 AND revision = ?', 'run', JSON.stringify(value), revision);
    if (!result.changes) throw new RequestError(409, '设置已在其他页面更新，请重新打开后再保存');
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  projects() {
    return this.query('SELECT id, name, path FROM projects ORDER BY rowid', 'all');
  }

  project(id) {
    const project = this.query('SELECT id, name, path FROM projects WHERE id = ?', 'get', id);
    if (!project) throw new RequestError(404, '项目不存在');
    return project;
  }

  addProject(path, name) {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    this.query('INSERT OR IGNORE INTO projects (id, name, path, path_key) VALUES (?, ?, ?, ?)', 'run', randomUUID(), name, path, key);
    return this.query('SELECT id, name, path FROM projects WHERE path_key = ?', 'get', key);
  }

  createTask(projectId = null) {
    if (projectId) this.project(projectId);
    const task = {id: randomUUID(), title: '新任务', updated: new Date().toISOString(), pinned: 0, archived: 0,
      project_id: projectId, file_access: projectId ? 'project_write' : 'attachments'};
    this.query('INSERT INTO tasks (id, title, updated, project_id, file_access) VALUES (?, ?, ?, ?, ?)', 'run',
      task.id, task.title, task.updated, task.project_id, task.file_access);
    return task;
  }

  setFileAccess(id, mode, projectId, confirmed) {
    return this.transaction(() => {
      const task = this.query('SELECT * FROM tasks WHERE id = ?', 'get', id);
      if (!task) throw new RequestError(404, '任务不存在');
      if (task.archived || this.query("SELECT id FROM runs WHERE task = ? AND status = 'running'", 'get', id)) {
        throw new RequestError(409, '请先停止执行或恢复会话，再更改文件权限');
      }
      if (projectId) this.project(projectId);
      if (mode === 'full' && task.file_access !== 'full' && !confirmed) throw new RequestError(422, '请先确认全盘文件权限');
      this.query('UPDATE tasks SET project_id = ?, file_access = ? WHERE id = ?', 'run', projectId, mode, id);
      return {...task, project_id: projectId, file_access: mode};
    });
  }

  tasks(archived = false) {
    return this.query(`SELECT t.*, (SELECT status FROM runs WHERE task = t.id ORDER BY rowid DESC LIMIT 1) AS status
      FROM tasks t WHERE archived = ? ORDER BY updated DESC, t.rowid DESC`, 'all', Number(archived));
  }

  editTask(id, changes) {
    return this.transaction(() => {
      const task = this.query('SELECT * FROM tasks WHERE id = ?', 'get', id);
      if (!task) throw new RequestError(404, '任务不存在');
      if (changes.archived && this.query("SELECT id FROM runs WHERE task = ? AND status = 'running'", 'get', id)) {
        throw new RequestError(409, '请等待执行结束，或停止后再归档');
      }
      const {title = task.title, pinned = task.pinned, archived = task.archived, model_id = task.model_id, effort = task.effort} = changes;
      if ((Object.hasOwn(changes, 'model_id') || Object.hasOwn(changes, 'effort')) &&
          (task.archived || this.query("SELECT id FROM runs WHERE task = ? AND status = 'running'", 'get', id))) {
        throw new RequestError(409, '请等待执行完成并恢复任务后再切换模型');
      }
      this.query('UPDATE tasks SET title = ?, pinned = ?, archived = ?, model_id = ?, effort = ? WHERE id = ?', 'run', title, Number(pinned), Number(archived), model_id, effort, id);
      return {...task, title, pinned: Number(pinned), archived: Number(archived), model_id, effort};
    });
  }

  task(id) {
    const task = this.query('SELECT * FROM tasks WHERE id = ?', 'get', id);
    if (!task) throw new RequestError(404, '任务不存在');
    const runs = this.query('SELECT id, prompt, status, answer, error, input_file FROM runs WHERE task = ? ORDER BY rowid', 'all', id);
    const files = this.query('SELECT id, run, name, kind, sha256, coalesce(stored_size,length(bytes)) AS size, relative_path AS relativePath, workspace_path AS workspacePath, detached FROM task_files WHERE task = ? ORDER BY rowid', 'all', id);
    const detachedFiles = new Map(files.filter(file => file.detached).map(file => [file.id, file]));
    const skills = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'skill_completed'", 'all', id);
    const adopted = new Map(skills.map(event => [event.run, JSON.parse(event.payload)]));
    const audits = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'audit_completed'", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const preflights = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'preflight_completed'", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const citations = new Map(this.query("SELECT e.run,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='citation_verification' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const briefs = new Map(this.query("SELECT e.run,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='task_brief' ORDER BY e.seq", 'all', id)
      .map(event=>[event.run,JSON.parse(event.payload)]));
    const chains = new Map(this.query("SELECT e.run,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='task_skill_chain' ORDER BY e.seq",'all',id)
      .map(event=>[event.run,JSON.parse(event.payload)]));
    const librarySearches = this.query("SELECT e.run,e.seq,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_library_search' ORDER BY e.seq",'all',id)
      .map(event=>({run:event.run,seq:event.seq,...JSON.parse(event.payload)}));
    const external = this.query("SELECT e.run,e.type,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type IN ('external_skill_discovery','external_skill_adopted') ORDER BY e.seq", 'all', id)
      .map(event=>({...event,payload:JSON.parse(event.payload)}));
    const installations = this.query("SELECT e.run,e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='external_skill_installed' ORDER BY e.seq",'all',id)
      .map(event=>({run:event.run,...JSON.parse(event.payload)}));
    const capabilityFits = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'capability_fit' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const searches = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'skill_search' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const loaded = new Map();
    for (const event of this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'custom_skill_loaded' ORDER BY e.seq", 'all', id)) {
      if (!loaded.has(event.run)) loaded.set(event.run, []);
      loaded.get(event.run).push(JSON.parse(event.payload));
    }
    const routes = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_route' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const skillTraces = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_runtime' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const applications = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_application' ORDER BY e.seq", 'all', id)
      .map(event => ({run: event.run, ...JSON.parse(event.payload)}));
    const applicability = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_applicability' ORDER BY e.seq", 'all', id)
      .map(event => ({run: event.run, ...JSON.parse(event.payload)}));
    const deliveries = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='skill_delivery' ORDER BY e.seq", 'all', id)
      .map(event => ({run: event.run, ...JSON.parse(event.payload)}));
    const configs = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'started'", 'all', id);
    const configByRun = new Map(configs.map(event => [event.run, JSON.parse(event.payload)]));
    const previousFolderContexts = new Map(this.query(`SELECT e.run, json_extract(e.payload,'$.context.folders') AS folders
      FROM events e JOIN runs r ON r.id=e.run WHERE r.task=? AND e.type='request_context'
      AND json_type(e.payload,'$.context.folders')='array' ORDER BY e.seq`, 'all',id).map(({run,folders}) => [run,JSON.parse(folders)]));
    const seenFolders = new Set();
    const inputFolders = new Map();
    for (const run of runs) {
      const folders = configByRun.get(run.id)?.inputFolders ?? (previousFolderContexts.get(run.id) ?? [])
        .map(folder => ({id: /^folder:([a-f\d-]{36})$/.exec(folder.path)?.[1], name:folder.name}));
      const added = [];
      for (const folder of folders) {
        if (!folder.id || seenFolders.has(folder.id)) continue;
        seenFolders.add(folder.id);
        added.push(folder);
      }
      if (added.length) inputFolders.set(run.id,added);
    }
    const endings = this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'finished'", 'all', id);
    const endByRun = new Map(endings.map(event => [event.run, JSON.parse(event.payload)]));
    const guidance = this.query('SELECT g.* FROM run_guidance g JOIN runs r ON r.id = g.run WHERE r.task = ? ORDER BY g.rowid', 'all', id);
    const plans = new Map(this.query("SELECT e.run, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'task_plan' ORDER BY e.seq", 'all', id)
      .map(event => [event.run, JSON.parse(event.payload)]));
    const receipts = this.query("SELECT e.run, e.seq, e.payload FROM events e JOIN runs r ON r.id = e.run WHERE r.task = ? AND e.type = 'tool_result' AND json_extract(e.payload, '$.planStep') IS NOT NULL ORDER BY e.seq", 'all', id)
      .map(event => ({run: event.run, seq: event.seq, ...JSON.parse(event.payload)}));
    return {...task, folders:this.taskFolders(id), files: files.filter(file => !file.run && !file.detached), runs: runs.map(run => ({...run, config: configByRun.get(run.id),
      inputAttachment: detachedFiles.get(run.input_file),
      inputFolders: inputFolders.get(run.id),
      guidance: guidance.filter(item => item.run === run.id), ended: endByRun.get(run.id)?.ended,
      plan: plans.get(run.id), planReceipts: receipts.filter(item => item.run === run.id).map(({seq, name, planStep, planRevision, planStepTitle, output, planOutcome}) =>
        ({seq, name, planStep, planRevision, planStepTitle,
          ...(planOutcome ?? {ok: output.ok && (!['project_tests','python_execution'].includes(output.data?.kind) || output.data.status === 'passed') &&
            (output.data?.kind !== 'material_preflight' || output.data.status === 'completed'),
            message: output.ok ? ['project_tests', 'material_preflight'].includes(output.data?.kind) ? output.data.summary : '调用成功' : output.error.message})})),
      skill: adopted.get(run.id), skillSearch: searches.get(run.id), loadedSkills: loaded.get(run.id) ?? [],
      skillRoute: routes.get(run.id), skillTrace: skillTraces.get(run.id), skillApplications: applications.filter(item => item.run === run.id),
      skillApplicability: applicability.filter(item => item.run === run.id),
      skillDeliveries: deliveries.filter(item => item.run === run.id),
      taskBrief:briefs.get(run.id),taskSkillChain:chains.get(run.id),skillLibrarySearches:librarySearches.filter(item=>item.run===run.id),installedSkills:installations.filter(item=>item.run===run.id),externalSkills:[...new Map(external.filter(e=>e.run===run.id).flatMap(e=>e.type==='external_skill_discovery'?e.payload.candidates:[e.payload]).map(item=>[item.id,item])).values()],
      audit: audits.get(run.id), preflight: preflights.get(run.id), citationVerification: citations.get(run.id),
      capabilityFit: capabilityFits.get(run.id), artifacts: files.filter(file => file.run === run.id)}))
      .map(run => ({...run, outcome: summarizeRun(run)}))};
  }

  guide(run, request, prompt) {
    return this.transaction(() => {
      const existing = this.query('SELECT prompt, applied FROM run_guidance WHERE run = ? AND request = ?', 'get', run, request);
      if (existing) {
        if (existing.prompt !== prompt) throw new RequestError(409, '引导编号已用于另一条消息');
        return {reused: true, applied: Boolean(existing.applied)};
      }
      if (this.run(run).status !== 'running') throw new RequestError(409, '本轮已经结束，请作为下一条消息发送');
      if (this.query('SELECT count(*) AS total FROM run_guidance WHERE run = ?', 'get', run).total >= 12) {
        throw new RequestError(409, '本轮引导已达 12 条，请等待结束后继续');
      }
      this.query('INSERT INTO run_guidance (run, request, prompt) VALUES (?, ?, ?)', 'run', run, request, prompt);
      this.record(run, 'guidance_received', {request, prompt});
      return {reused: false, applied: false};
    });
  }

  takeGuidance(run) {
    return this.transaction(() => {
      const pending = this.query('SELECT request, prompt FROM run_guidance WHERE run = ? AND applied = 0 ORDER BY rowid', 'all', run);
      for (const message of pending) {
        this.query('UPDATE run_guidance SET applied = 1 WHERE run = ? AND request = ?', 'run', run, message.request);
        this.record(run, 'guidance_applied', message);
      }
      return pending;
    });
  }

  hasGuidance(run) {
    return Boolean(this.query('SELECT request FROM run_guidance WHERE run = ? AND applied = 0 LIMIT 1', 'get', run));
  }

  addAttachment(task, name, kind, bytes) {
    return this.transaction(() => {
      this.checkAttachmentTarget(task);
      return this.addFile(task, null, name, kind, bytes);
    });
  }

  checkAttachmentTarget(task) {
    const current = this.query('SELECT archived FROM tasks WHERE id = ?', 'get', task);
    if (!current) throw new RequestError(404, '任务不存在');
    if (current.archived) throw new RequestError(409, '请先恢复已归档任务');
  }

  taskFolders(task) {
    return this.query('SELECT id,name,path FROM task_folders WHERE task=? ORDER BY rowid','all',task);
  }

  addTaskFolder(task, name, path) {
    this.checkAttachmentTarget(task);
    const existing = this.query('SELECT id,name,path FROM task_folders WHERE task=? AND path=?','get',task,path);
    if (existing) return existing;
    const id = randomUUID();
    this.query('INSERT INTO task_folders (id,task,name,path) VALUES (?,?,?,?)','run',id,task,name,path);
    return {id,name,path};
  }

  removeTaskFolder(task, id) {
    this.checkAttachmentTarget(task);
    if (this.query("SELECT id FROM runs WHERE task=? AND status='running'",'get',task)) throw new RequestError(409,'请结束当前执行后再移除目录');
    const result = this.query('DELETE FROM task_folders WHERE task=? AND id=?','run',task,id);
    if (!result.changes) throw new RequestError(404,'该会话中没有挂载此目录');
    return {id,deleted:true};
  }

  addFile(task, run, name, kind, bytes) {
    const id = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.query('INSERT INTO task_files (id,task,run,name,kind,sha256,bytes) VALUES (?, ?, ?, ?, ?, ?, ?)', 'run', id, task, run, name, kind, sha256, bytes);
    return {id, run, name, kind, sha256, size: bytes.length};
  }

  addDiskAttachment(task, {id, name, kind, sha256, size, diskPath, relativePath, workspacePath}) {
    return this.transaction(() => {
      this.checkAttachmentTarget(task);
      if (this.query('SELECT id FROM task_files WHERE task=? AND workspace_path=?','get',task,workspacePath)) throw new RequestError(409,'本批文件中存在重复路径');
      this.query('INSERT INTO task_files (id,task,run,name,kind,sha256,bytes,disk_path,stored_size,relative_path,workspace_path) VALUES (?,?,NULL,?,?,?, ?,?,?,?,?)',
        'run',id,task,name,kind,sha256,Buffer.alloc(0),diskPath,size,relativePath,workspacePath);
      return {id,run:null,name,kind,sha256,size,relativePath,workspacePath};
    });
  }

  file(task, id) {
    const file = this.query('SELECT * FROM task_files WHERE task = ? AND id = ?', 'get', task, id);
    if (!file) throw new RequestError(404, '该任务中没有这个文件');
    file.size = file.stored_size ?? file.bytes.length;
    if (file.disk_path) Object.defineProperty(file,'bytes',{enumerable:false,get:()=>readFileSync(file.disk_path)});
    return file;
  }

  removeAttachment(task, id, cleanup = () => {}, detachUsed = false) {
    return this.transaction(() => {
      const current = this.query('SELECT archived FROM tasks WHERE id = ?', 'get', task);
      if (!current) throw new RequestError(404, '任务不存在');
      if (current.archived) throw new RequestError(409, '请先恢复会话再删除附件');
      const file = this.file(task, id);
      if (file.run) throw new RequestError(409, '这是执行产物，不能作为待发送附件删除');
      if (this.query("SELECT id FROM runs WHERE task = ? AND status = 'running'", 'get', task)) {
        throw new RequestError(409,'请结束当前执行后再移除附件');
      }
      const used = this.query('SELECT id FROM runs WHERE task = ? AND input_file = ? LIMIT 1', 'get', task, id) ||
        this.query(`SELECT e.run FROM events e JOIN runs r ON r.id = e.run, json_tree(e.payload) j
          WHERE r.task = ? AND e.type = 'request_context' AND j.key = 'id' AND j.value = ? LIMIT 1`, 'get', task, id);
      if (used && !detachUsed) throw new RequestError(409, '该附件已用于执行记录，不能作为待发送附件删除');
      cleanup(file, Boolean(used));
      if (used) {
        this.query('UPDATE task_files SET detached=1 WHERE task=? AND id=?', 'run',task,id);
        return {deleted:true, id, detached:true, file:{id,name:file.name,kind:file.kind,relativePath:file.relative_path}};
      }
      this.query('DELETE FROM task_files WHERE task = ? AND id = ?', 'run', task, id);
      return {deleted: true, id};
    });
  }

  run(id) {
    const run = this.query('SELECT id, task, prompt, status FROM runs WHERE id = ?', 'get', id);
    if (!run) throw new RequestError(404, '执行记录不存在');
    return run;
  }

  begin(task, request, prompt, config, inputFile = null, skillVersion) {
    return this.transaction(() => {
      if (inputFile) this.file(task, inputFile);
      const current = this.query('SELECT archived, project_id, file_access FROM tasks WHERE id = ?', 'get', task);
      if (!current) throw new RequestError(404, '任务不存在');
      const existing = this.query(`SELECT r.id, r.prompt, r.input_file, json_extract(e.payload, '$.mode') AS mode
        FROM runs r LEFT JOIN events e ON e.run = r.id AND e.type = 'started' WHERE r.task = ? AND r.request = ?`, 'get', task, request);
      if (existing) {
        const original = JSON.parse(this.query("SELECT payload FROM events WHERE run = ? AND type = 'started'", 'get', existing.id).payload);
        if (existing.prompt !== prompt || existing.input_file !== inputFile || (existing.mode === 'diagnostic') !== (config.mode === 'diagnostic') ||
            (existing.mode === 'audit-rules') !== (config.mode === 'audit-rules') ||
            original.customSkill?.id !== config.customSkill?.id ||
            (skillVersion !== undefined && original.customSkill?.version !== skillVersion) ||
            Boolean(original.expandedBudget) !== Boolean(config.expandedBudget) ||
            JSON.stringify(original.preflight ?? null) !== JSON.stringify(config.preflight ?? null) ||
            JSON.stringify(original.workflow ?? null) !== JSON.stringify(config.workflow ?? null)) {
          throw new RequestError(409, '提交编号已被另一条消息使用');
        }
        return {id: existing.id, started: false};
      }
      if (skillVersion !== undefined && config.customSkill?.version !== skillVersion) {
        throw new RequestError(409, '技能已更新，请从技能工坊重新选择后发送');
      }
      if (current.archived) throw new RequestError(409, '请先恢复已归档任务');
      if (config.fileScope && (current.file_access !== config.fileScope.mode || current.project_id !== config.fileScope.projectId)) {
        throw new RequestError(409, '文件权限已更改，请重新提交任务');
      }
      if (this.query("SELECT id FROM runs WHERE task = ? AND status = 'running'", 'get', task)) {
        throw new RequestError(409, '请等待当前执行结束，或先停止执行');
      }
      const first = !this.query('SELECT id FROM runs WHERE task = ? LIMIT 1', 'get', task);
      const id = randomUUID();
      this.query("INSERT INTO runs (id, task, request, prompt, status, owner, input_file) VALUES (?, ?, ?, ?, 'running', ?, ?)", 'run', id, task, request, prompt, process.pid, inputFile);
      if (first) this.query("UPDATE tasks SET title = ? WHERE id = ? AND title = '新任务'", 'run',
        [...(prompt || (inputFile ? this.file(task, inputFile).name : '新任务')).replace(/\s+/g, ' ')].slice(0, 42).join(''), task);
      this.query('UPDATE tasks SET updated = ? WHERE id = ?', 'run', new Date().toISOString(), task);
      this.record(id, 'started', {...config, started: Date.now()});
      return {id, started: true};
    });
  }

  finishSkill(task, id, skill, source, {summary, report}) {
    this.transaction(() => {
      const result = this.query("UPDATE runs SET status = 'completed', answer = ? WHERE id = ? AND status = 'running'", 'run', summary, id);
      if (!result.changes) return;
      const artifact = this.addFile(task, id, 'csv-analysis.txt', 'report', Buffer.from(report, 'utf8'));
      const {id: skillId, label} = skill;
      this.record(id, 'skill_completed', {id: skillId, label, reason: skill.reason, source: source.id, sourceSha256: source.sha256, artifact});
      this.record(id, 'finished', {status: 'completed', answer: summary, error: null, ended: Date.now()});
    });
  }

  saveAudit(task, id, {report, summary, artifacts, skillTrace}, complete = false) {
    return this.transaction(() => {
      if (this.run(id).status !== 'running') return [];
      if (complete) this.query("UPDATE runs SET status = ?, answer = ?, error = ? WHERE id = ? AND status = 'running'", 'run',
        report.status, summary, report.error.message ?? null, id);
      const files = artifacts.map(file => this.addFile(task, id, file.name, file.kind, Buffer.from(file.bytes, 'utf8')));
      this.record(id, 'audit_completed', {report, artifacts: files, skillTrace});
      if (complete) this.record(id, 'finished', {status: report.status, answer: summary, error: report.error.message ?? null, ended: Date.now()});
      return files;
    });
  }

  finishAudit(task, id, result) {
    return this.saveAudit(task, id, result, true);
  }

  finishPreflight(task, id, report, trace, answer) {
    this.transaction(() => {
      const changed = this.query("UPDATE runs SET status = 'completed', answer = ? WHERE id = ? AND status = 'running'", 'run', answer, id);
      if (!changed.changes) return;
      this.savePreflight(task, id, report, trace);
      this.record(id, 'finished', {status: 'completed', answer, error: null, ended: Date.now()});
    });
  }

  savePreflight(task, id, report, trace) {
    const artifact = this.addFile(task, id, 'preflight-report.json', 'report', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    this.record(id, 'preflight_completed', {report, artifact, trace});
    return artifact;
  }

  history(task) {
    const rows = this.query(`SELECT r.id, r.prompt, r.answer, r.status, r.input_file FROM runs r JOIN tasks t ON t.id=r.task WHERE r.task = ?
      AND (r.status = 'completed' OR (r.status IN ('failed', 'stopped', 'interrupted') AND r.answer IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run = r.id AND e.type = 'started'
      AND json_extract(e.payload, '$.mode') IN ('demo', 'diagnostic', 'audit-demo'))
      AND ${visibleRunContext}
      ORDER BY r.rowid DESC LIMIT 8`, 'all', task).reverse();
    return rows.map(row => ({...row, answer: row.status === 'completed' ? row.answer : `${row.answer}\n[该轮未完成，以上是已收到的部分回复]`, prompt: [row.prompt,
      ...this.query('SELECT prompt FROM run_guidance WHERE run = ? AND applied = 1 ORDER BY rowid', 'all', row.id)
        .map(message => `补充要求：${message.prompt}`)].join('\n\n')}));
  }

  record(run, type, payload) {
    return Number(this.query('INSERT INTO events (run, type, payload) VALUES (?, ?, ?)', 'run', run, type, JSON.stringify(payload)).lastInsertRowid);
  }

  events(run, after) {
    return this.query('SELECT seq, type, payload FROM events WHERE run = ? AND seq > ? ORDER BY seq', 'all', run, after)
      .map(event => ({...event, payload: JSON.parse(event.payload)}));
  }

  finish(run, status, {answer = null, error = null} = {}) {
    this.transaction(() => {
      if (answer === null) {
        const partial = this.query("SELECT payload FROM events WHERE run = ? AND type = 'progress' ORDER BY seq DESC LIMIT 1", 'get', run);
        answer = partial ? JSON.parse(partial.payload).text || null : null;
      }
      const changed = this.query("UPDATE runs SET status = ?, answer = ?, error = ? WHERE id = ? AND status = 'running'", 'run', status, answer, error, run);
      if (changed.changes) this.record(run, 'finished', {status, answer, error, ended: Date.now()});
    });
  }

  recover() {
    const rows = this.query("SELECT id, owner FROM runs WHERE status = 'running'", 'all');
    for (const {id, owner} of rows) {
      try { process.kill(owner, 0); }
      catch (error) {
        if (error.code === 'ESRCH') this.finish(id, 'interrupted', {error: '上次执行因服务退出而中断'});
      }
    }
  }
}
