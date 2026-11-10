const $ = id => document.getElementById(id);
const studioUrl = '/api/skill-studio';
import {createSkillExecutionView} from './skill-execution.js';
import {drawExperiences,drawExperienceChanges} from './skill-experiences.js';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function action(label, handler, className) {
  const button = node('button', label, className);
  button.type = 'button';
  button.onclick = handler;
  return button;
}

function caseInput(label, value, maxLength) {
  const field = node('label', label);
  const input = node('textarea');
  input.rows = 2;
  input.maxLength = maxLength;
  input.value = value ?? '';
  field.append(input);
  return {field, input};
}

function downloadSkill(skill, markdown = false) {
  const {name, description, instructions, tests, version, applicability, delivery} = skill;
  const content = markdown
    ? '---\nname: ' + JSON.stringify(name) + '\ndescription: ' + JSON.stringify(description) +
      (applicability ? '\nsih_applicability: ' + JSON.stringify(applicability) : '') + (delivery ? '\nsih_delivery: ' + JSON.stringify(delivery) : '') + '\n---\n\n' + instructions + '\n'
    : JSON.stringify({name, description, instructions, tests, version, ...(applicability ? {applicability} : {}), ...(delivery ? {delivery} : {})}, null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([content], {type: markdown ? 'text/markdown' : 'application/json'}));
  const link = node('a');
  link.href = url;
  link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'skill'}-v${version}.json`;
  if (markdown) link.download = 'SKILL.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createSkillStudio({api, getTask, onSelect, canSelect, onOpenTask}) {
  const dialog = $('skill-studio-dialog');
  const title = $('skill-studio-title');
  const status = $('studio-status');
  const error = $('studio-error');
  let taskId = null, source = null, skillId = null, baseVersion = 0, busy = false, view;
  let cases = [], compared = new Map(), operation = 0, library = [];
  let locations = {global: '~/.sih/skills', project: null};
  let selectedProject = null, knownProjects = [];
  let libraryPage = 0;
  let libraryScan = null, scanPage = 0, selectedImports = new Set(), sourceRequest = 0;
  let parentCandidateId = null;
  let executionView=null;

  function clearScan() {
    libraryScan = null;
    selectedImports.clear();
    $('studio-library-review').hidden = true;
    $('studio-import-results').replaceChildren();
  }

  async function loadSources() {
    const request = ++sourceRequest;
    $('studio-library-sources').textContent = '正在查找本机技能库…';
    try {
      const {sources} = await api(withTask(studioUrl + '/libraries'));
      if (request !== sourceRequest) return;
      const rows = sources.map(source => {
        const row = node('label', '', 'studio-source-choice');
        const check = document.createElement('input');
        check.type = 'checkbox'; check.checked = true; check.value = source.path;
        check.onchange = clearScan;
        row.append(check, node('span', source.agent + ' · ' + source.scope), node('small', source.path, 'status studio-file-path'));
        return row;
      });
      $('studio-library-sources').replaceChildren(...(rows.length ? rows : [node('p', '没有找到常见技能库。可选择「扫描其他技能库目录」，填写存放技能的文件夹。', 'status')]));
    } catch (failure) { if (request === sourceRequest) $('studio-library-sources').textContent = failure.message; }
  }

  function updateImportCount() {
    $('studio-library-import').textContent = '导入选中的 ' + selectedImports.size + ' 个技能';
    $('studio-library-import').disabled = !selectedImports.size;
  }

  function drawScan() {
    if (!libraryScan) return;
    const filter = $('studio-library-filter').value;
    const candidates = libraryScan.candidates.filter(item => filter === 'all' || item.status === filter);
    scanPage = Math.min(scanPage, Math.max(0, Math.ceil(candidates.length / 50) - 1));
    const labels = {missing: '待导入', exists: '已有，跳过', conflict: '同名冲突，不覆盖', invalid: '无法读取', imported: '已导入', failed: '导入失败', skipped: '已有，跳过'};
    const rows = candidates.slice(scanPage * 50, (scanPage + 1) * 50).map(candidate => {
      const row = node('section', '', 'studio-card');
      const label = node('label', '', 'studio-import-choice');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedImports.has(candidate.id); checkbox.disabled = candidate.status !== 'missing';
      checkbox.setAttribute('aria-label', '选择 ' + candidate.name);
      checkbox.onchange = () => { checkbox.checked ? selectedImports.add(candidate.id) : selectedImports.delete(candidate.id); updateImportCount(); };
      label.append(checkbox, node('strong', candidate.name));
      const summary = node('div');
      summary.append(label, node('p', labels[candidate.status] + ' · ' + candidate.agent, 'status'),
        node('p', candidate.description, 'status'), node('p', candidate.message || candidate.error || candidate.reason, 'status'),
        node('p', candidate.path, 'status studio-file-path'));
      row.append(summary);
      return row;
    });
    if (!rows.length) rows.push(node('p', '当前筛选下没有技能。', 'status'));
    const paging = node('div', '', 'actions');
    if (scanPage) paging.append(action('上一页', () => { scanPage--; drawScan(); }));
    if ((scanPage + 1) * 50 < candidates.length) paging.append(action('下一页', () => { scanPage++; drawScan(); }));
    if (paging.childNodes.length) rows.push(paging);
    $('studio-import-results').replaceChildren(...rows);
    updateImportCount();
  }

  function importMode() {
    const mode = $('studio-import-source').value;
    const scan = mode === 'libraries' || mode === 'library-path';
    $('studio-library-row').hidden = mode !== 'libraries';
    $('studio-import-file-row').hidden = mode !== 'file';
    $('studio-import-path-row').hidden = mode !== 'directory' && mode !== 'library-path';
    $('studio-import-start').textContent = scan ? '扫描并检查重复' : '读取并预览';
    $('studio-import-help').textContent = scan
      ? '支持含 SKILL.md 的标准技能包；扫描不调用模型、不运行脚本。按技能名及正文去重，导入时保留脚本、参考资料和资源文件，不覆盖已有技能。'
      : '单文件和逐项编辑模式导入技能正文；如需保留配套脚本和资料，请使用技能库扫描。';
    clearScan();
    if (mode === 'libraries') void loadSources();
  }

  const withTask = path => {
    const query = new URLSearchParams();
    if (taskId) query.set('task', taskId);
    if (selectedProject) query.set('project', selectedProject);
    return query.size ? path + '?' + query : path;
  };
  const projectBody = () => selectedProject && selectedProject !== getTask()?.project_id ? {projectId: selectedProject} : {};
  const requestBody = () => ({taskId, baseVersion, ...projectBody(), ...(skillId ? {skillId} : {})});
  const editorFields = ['name', 'description', 'instructions'];

  function drawLocations() {
    for (const id of ['studio-scope', 'studio-import-scope']) {
      const select = $(id);
      select.querySelector('[value="global"]').textContent = '用户技能（' + locations.global + '，所有项目可用）';
      select.querySelector('[value="project"]').textContent = locations.project
        ? '项目技能（' + locations.project + '）' : '项目技能（选择目标项目）';
    }
    $('studio-storage-paths').textContent = '用户技能目录 · ' + locations.global +
      (locations.project ? '\n项目技能目录 · ' + locations.project : '');
  }

  async function loadLocations() {
    const currentTask = taskId;
    const currentProject = selectedProject;
    const result = await api(withTask(studioUrl + '/locations'));
    if (currentTask !== taskId || currentProject !== selectedProject) return;
    locations = result;
    drawLocations();
    drawProjectPicker();
  }

  function drawProjectPicker() {
    const projectScope = view === 'import' ? $('studio-import-scope').value === 'project' :
      view === 'experiences' || view === 'editor' && $('studio-scope').value === 'project';
    $('studio-project-row').hidden = !projectScope;
    $('studio-target-project').replaceChildren(new Option('请选择项目', ''),
      ...knownProjects.map(project => new Option(project.name + ' · ' + project.path, project.id)));
    $('studio-target-project').value = selectedProject ?? '';
    $('studio-target-project').disabled = Boolean(view === 'editor' && (skillId || source));
    $('studio-project-path').textContent = locations.project ?? '请在这里选择目标项目。';
  }

  async function loadProjects() {
    knownProjects = await api('/api/projects');
    drawProjectPicker();
  }

  const canUse = skill => canSelect() && (!skill.projectId || skill.projectId === getTask()?.project_id);

  function message(element, text) {
    element.textContent = text || '';
    element.hidden = !text;
    if (text && element === error && dialog.open) element.scrollIntoView({block: 'nearest'});
  }

  function setBusy(value) {
    busy = value;
    for (const area of ['library', 'detail', 'editor', 'import', 'candidates', 'experiences']) $('studio-' + area).inert = value;
    for (const id of ['studio-tab-library', 'studio-tab-create', 'studio-tab-import', 'studio-tab-candidates', 'studio-tab-experiences']) $(id).disabled = value;
    dialog.setAttribute('aria-busy', String(value));
  }

  async function work(progress, fn) {
    if (busy) return;
    const current = ++operation;
    const isCurrent = () => current === operation;
    message(error);
    message(status, progress);
    setBusy(true);
    try { await fn(isCurrent); }
    catch (failure) { if (isCurrent()) message(error, failure.message); }
    finally {
      if (isCurrent()) { message(status); setBusy(false); }
    }
  }

  function show(section) {
    view = section;
    if (section === 'import') {
      $('studio-import-scope').querySelector('[value="project"]').disabled = false;
      if ($('studio-import-source').value === 'libraries') void loadSources();
    }
    for (const area of ['library', 'detail', 'editor', 'import', 'candidates', 'experiences']) $('studio-' + area).hidden = area !== section;
    const tab = section === 'editor' ? 'create' : ['import', 'candidates', 'experiences'].includes(section) ? section : 'library';
    for (const id of ['library', 'create', 'import', 'candidates', 'experiences']) $('studio-tab-' + id).setAttribute('aria-current', id === tab ? 'page' : 'false');
    drawProjectPicker();
    message(error);
    if (!dialog.open) dialog.show();
    placePage();
    dialog.scrollTop = 0;
  }

  function placePage() {
    dialog.style.setProperty('--studio-left', Math.max(0, document.getElementById('sidebar').getBoundingClientRect().right) + 'px');
  }
  window.addEventListener('resize', placePage);
  document.getElementById('sidebar').addEventListener('click', event => {
    if (dialog.open && !event.target.closest('#skill-center-nav')) dialog.close();
  });

  function useSkill(skill) {
    if (!canUse(skill) || (getTask()?.id ?? null) !== taskId) return;
    dialog.close();
    onSelect(skill);
  }

  function drawLibrary(skills) {
    const query = $('studio-search').value.trim().toLocaleLowerCase();
    const filter = $('studio-filter').value;
    skills = skills.filter(skill => (!query || (skill.name + ' ' + skill.description).toLocaleLowerCase().includes(query)) &&
      (filter === 'all' || Boolean(skill.projectId) === (filter === 'project')));
    const total = skills.length;
    libraryPage = Math.min(libraryPage, Math.max(0, Math.ceil(total / 50) - 1));
    $('studio-count').textContent = total + ' 个技能' + (total ? ' · 当前 ' + (libraryPage * 50 + 1) + '–' + Math.min(total, (libraryPage + 1) * 50) : '');
    const rows = skills.slice(libraryPage * 50, (libraryPage + 1) * 50).map(skill => {
      const row = node('section', '', 'studio-card');
      const summary = node('div');
      summary.append(node('h4', `${skill.name} · v${skill.version}`), node('p', skill.description, 'status'),
        node('span', skill.projectId ? '本项目' : '所有会话', 'studio-scope'));
      summary.append(node('p', skill.tests.length ? skill.tests.length + ' 个测试用例' : '尚未添加对照测试', 'status'));
      if (skill.storagePath) summary.append(node('p', skill.storagePath, 'status studio-file-path'));
      const buttons = node('div', '', 'actions');
      const use = action('用于下一轮', () => useSkill(skill), 'primary-action');
      use.disabled = !canUse(skill);
      if (use.disabled && skill.projectId !== getTask()?.project_id) use.title = '请在这个项目的会话中使用。';
      buttons.append(action('查看版本', () => void openDetail(skill.id)), use);
      row.append(summary, buttons);
      return row;
    });
    $('studio-list').replaceChildren(...(rows.length ? rows : [node('p', library.length ? '没有符合筛选条件的技能。' : '还没有技能。点击「创建」填写做法，或从「导入」载入现有技能。', 'status')]));
    const paging = document.createElement('div');
    paging.className = 'actions';
    if (libraryPage) paging.append(action('上一页', () => { libraryPage--; drawLibrary(library); }));
    if ((libraryPage + 1) * 50 < total) paging.append(action('下一页', () => { libraryPage++; drawLibrary(library); }));
    if (paging.childNodes.length) $('studio-list').append(paging);
  }

  async function openLibrary() {
    title.textContent = '技能中心';
    show('library');
    $('studio-list').replaceChildren();
    await work('正在读取技能库…', async isCurrent => {
      const {skills, locations: paths, issues = []} = await api(withTask(studioUrl));
      if (isCurrent()) {
        if (paths) { locations = paths; drawLocations(); }
        library = skills; drawLibrary(library);
        $('studio-storage-issues').replaceChildren(...issues.map(issue => node('p', (issue.path || issue.name) + ' · ' + issue.message)));
        $('studio-storage-issues').hidden = !issues.length;
      }
    });
  }

  async function openDetail(id) {
    await work('正在读取技能版本…', async isCurrent => {
      const {skill, versions} = await api(withTask(`${studioUrl}/${encodeURIComponent(id)}`));
      if (!isCurrent()) return;
      title.textContent = '技能中心';
      $('studio-detail-title').textContent = `${skill.name} · v${skill.version}`;
      $('studio-detail-description').textContent = skill.description;
      $('studio-detail-path').textContent = skill.storagePath ?? '';
      const use = action('用于下一轮', () => useSkill(skill), 'primary-action');
      use.disabled = !canUse(skill);
      $('studio-detail-actions').replaceChildren(action('改进这个技能', () => void openEditor(null, skill)), use);
      $('studio-versions').replaceChildren(...(versions?.length ? versions : [skill]).map(version => {
        const item = node('details', '', 'studio-case');
        item.open = version.version === skill.version;
        const summary = node('summary', `v${version.version}${item.open ? ' · 当前版本' : ''}`);
        item.append(summary, node('p', version.description || skill.description), node('pre', version.instructions || ''));
        if (version.applicability) {
          const policy = node('details'); policy.append(node('summary', '此版本的适用条件'));
          for (const [key, label] of [['goals', '适用目标片段'], ['exclusions', '禁用目标片段'], ['input_formats', '输入格式'], ['project_files', '所需项目材料'], ['tools', '所需工具']]) {
            if (version.applicability[key].length) policy.append(node('p', label + '：' + version.applicability[key].join('、'), 'status'));
          }
          item.append(policy);
        }
        if (version.createdAt) item.append(node('p', `发布于 ${new Date(version.createdAt).toLocaleString('zh-CN')}`, 'status'));
        if (version.delivery) {
          const contract = node('details'); contract.append(node('summary', '此版本的实际产物验收条件'), node('pre', JSON.stringify(version.delivery, null, 2))); item.append(contract);
        }
        if (version.candidateValidation) {
          const proof = version.candidateValidation;
          const label = proof.scope === 'isolated-file-execution' ? '发布依据 · 实际任务对照' : '发布依据 · 冻结文本对照';
          item.append(node('p', `${label} · ${proof.baselinePassed}/${proof.total} → ${proof.candidatePassed}/${proof.total} 通过`, 'status'),
            action('查看候选验证记录', () => void openCandidate(proof.candidateId)));
        } else if (version.restoration) {
          const {fromVersion, previousVersion} = version.restoration;
          item.append(node('p', `从 v${previousVersion} 恢复到 v${fromVersion} 的技能定义。`, 'status'));
        } else item.append(node('p', '此版本未关联候选验证记录。', 'status'));
        for (const test of version.tests ?? []) item.append(node('p', `用例 · ${test.prompt}`, 'status'));
        if (version.instructions) item.append(action('导出此版本', () => downloadSkill({...skill, ...version})),
          action('导出 SKILL.md', () => downloadSkill({...skill, ...version}, true)));
        if (version.version !== skill.version) {
          const review = node('details', '', 'studio-case');
          review.append(node('summary', '恢复这个版本'), node('p', `用 v${version.version} 的正文、适用条件和验收声明创建 v${skill.version + 1}。配套文件沿用当前目录。`, 'status'),
            action(`确认恢复 v${version.version}`, () => void restoreVersion(skill, version), 'primary-action'));
          item.append(review);
        }
        return item;
      }));
      show('detail');
    });
  }

  async function restoreVersion(skill, version) {
    let restored = false;
    await work('正在恢复历史版本…', async isCurrent => {
      await api(`${studioUrl}/${encodeURIComponent(skill.id)}/restore`, {taskId, ...projectBody(), version: version.version,
        baseVersion: skill.version, confirmed: true});
      restored = isCurrent();
    });
    if (restored) await openDetail(skill.id);
  }

  const candidateLabels = {pending: '待验证', improved: '冻结文本用例有增益', no_gain: '未测出增益', failed: '存在未通过项', unknown: '证据不足'};
  const candidateUrl = id => studioUrl + '/candidates' + (id ? '/' + id : '');
  async function openExperiences(run) {
    show('experiences');
    await work('正在检查真实执行中的经验线索…',async isCurrent=>{
      let path=withTask(studioUrl+'/experiences');if(run?.id)path+=(path.includes('?')?'&':'?')+'run='+encodeURIComponent(run.id);
      const {experiences}=await api(path);if(!isCurrent())return;
      drawExperiences($('studio-experience-list'),experiences,{api,work,url:studioUrl+'/experiences',body:()=>({taskId,...projectBody()}),
        onSource:id=>{dialog.close();void onOpenTask?.(id);},onCandidate:candidate=>{show('candidates');drawCandidate(candidate);},
        onRegression:(candidate,draft)=>{show('candidates');drawCandidate(candidate,draft);}});
    });
  }
  async function openCandidates() {
    title.textContent = '技能中心'; show('candidates');
    $('studio-candidate-detail').hidden = true; $('studio-candidate-list').hidden = false;
    await work('正在读取候选改进…', async isCurrent => {
      const {candidates} = await api(withTask(candidateUrl()));
      if (!isCurrent()) return;
      const rows = candidates.map(candidate => {
        const item = node('section', '', 'studio-card'), description = node('div');
        description.append(node('h4', candidate.name), node('p', candidate.description, 'status'),
          node('p', candidate.publishedVersion ? '已发布 v' + candidate.publishedVersion : candidate.executionEvidence?.reason ??
            (candidate.status === 'running' ? '正在验证' : candidateLabels[candidate.verdict]), 'status'));
        item.append(description, action('查看候选与验证', () => void openCandidate(candidate.id))); return item;
      });
      $('studio-candidate-list').replaceChildren(...(rows.length ? rows : [node('p', '还没有候选。从技能的“改进”或已完成对话生成草案后，选择“保存为待验证候选”。', 'status')]));
    });
  }
  function drawCandidate(candidate, regressionDraft) {
    executionView?.dispose();
    const container = $('studio-candidate-detail');
    const latest = candidate.trials[0];
    const intro = node('section', '', 'studio-case');
    intro.append(node('h3', candidate.draft.name), node('p', candidate.publishedVersion ? '已发布 v' + candidate.publishedVersion : '文本对照：'+candidateLabels[latest?.verdict ?? 'pending']),
      node('p', '文本验证范围：'+candidate.limitation+' 实际任务对照需另行冻结材料和判据。', 'status'), node('p', '候选 SHA-256：' + candidate.sha256, 'status studio-file-path'));
    if (candidate.regressionCases?.length) intro.append(node('p', `历史回归用例 · ${candidate.regressionCases.length} 项`, 'status'));
    if (candidate.sourceEvidence) intro.append(node('p', '来源对话：' + candidate.sourceEvidence.selected.prompt, 'status'));
    if (candidate.sourceEvidence?.skillDeliveries?.length) {
      const checks = node('details'); checks.append(node('summary', '来源任务的实际产物验收（与下方文本对照分开）'));
      for (const result of candidate.sourceEvidence.skillDeliveries) {
        checks.append(node('p', result.name + ' v' + result.version + ' · ' + ({passed: '声明范围通过', failed: '未通过', unknown: '未确认', unspecified: '未声明'}[result.status]), 'status'));
        for (const check of result.checks) checks.append(node('p', check.path + ' · ' + check.message + ' · ' + check.status, 'status'));
      }
      intro.append(checks);
    }
    const guide = node('details'); guide.append(node('summary', '候选方法与适用条件'), node('pre', JSON.stringify(candidate.draft, null, 2))); intro.append(guide);
    const actions = node('div', '', 'actions');
    const actual = node('div'); actual.hidden = true;
    function showExecution(planId, initialDraft) {
      actual.hidden = false;
      executionView?.dispose();
      executionView = createSkillExecutionView({container: actual, candidate, api, initialPlanId: planId, initialDraft,
        withContext: withTask, bodyContext: () => ({taskId, ...projectBody()}), onReview: () => void openCandidate(candidate.id),
        onSource: id => {dialog.close();void onOpenTask?.(id);},
        isVisible: () => dialog.open && view === 'candidates' && !actual.closest('[hidden]')});
      actual.scrollIntoView({block: 'nearest'});
    }
    actions.append(action('实际任务对照', () => showExecution()));
    if (candidate.publishedSkillId) actions.append(action('查看正式技能与历史版本', () => void openDetail(candidate.publishedSkillId)));
    actions.append(action('返回候选列表', () => void openCandidates()));
    const evaluate = action(latest ? '重新验证冻结用例' : '运行冻结用例对照', () => void work('正在顺序运行冻结用例，结果会逐对保存…', async isCurrent => {
      const result = await api(candidateUrl(candidate.id) + '/evaluate', {taskId, ...projectBody()});
      if (isCurrent()) drawCandidate(result);
    }), 'primary-action');
    evaluate.disabled = Boolean(candidate.publishedVersion); actions.append(evaluate);
    if (!candidate.publishedVersion) actions.append(action('另存修订草案', () => {
      const baseline = candidate.skillId ? {...candidate.baseline, id: candidate.skillId, version: candidate.baseVersion, projectId: candidate.projectId} : null;
      openEditor(null, baseline); drawDraft(candidate.draft);
      parentCandidateId = candidate.id;
      source = candidate.sourceRunId && candidate.sourceTaskId === taskId ? {id: candidate.sourceRunId} : null;
      $('studio-scope').value = candidate.projectId ? 'project' : 'global'; drawProjectPicker();
    }));
    actions.append(action('导出候选与验证记录', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(candidate, null, 2)], {type: 'application/json'}));
      const link = node('a'); link.href = url; link.download = candidate.draft.name + '-candidate.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    intro.append(actions);
    const suite = node('details'); suite.append(node('summary', '冻结的测试集 · ' + candidate.suite.length + ' 项（含原版本回归用例）'));
    for (const test of candidate.suite) suite.append(node('pre', test.prompt), node('p', '预期：' + test.expected_output, 'status'), node('p', test.expectations.join('；'), 'status'),
      ...(test.sourceOverlap ? [node('p', '与来源提示相同，仅作回归，不计入新增通过。', 'status')] : []));
    intro.append(suite);
    container.replaceChildren(intro);
    for(const proposal of candidate.experienceProposals??[])drawExperienceChanges(container,proposal);
    container.append(actual);
    for (const result of candidate.trials) {
      const section = node('details', '', 'studio-case'); section.open = result === latest;
      section.append(node('summary', new Date(result.startedAt).toLocaleString('zh-CN') + ' · ' + (result.status === 'running' ? '验证中' : candidateLabels[result.verdict])),
        node('p', result.reason), node('p', '请求模型：' + result.contract.model + ' · 仅文本对照', 'status'));
      if (result.total) section.append(node('p', `用例通过：原版本 ${result.baselinePassed}/${result.total} → 候选 ${result.candidatePassed}/${result.total}；新增通过 ${result.improvedCases} 项。`, 'status'));
      for (const pair of result.pairs) {
        const row = node('details'); row.append(node('summary', '用例 ' + (pair.index + 1) + ' · ' + pair.test.prompt.slice(0, 90)));
        const outputs = node('div', '', 'studio-results'); drawComparison(outputs, pair, candidate.skillId ? '原版本 v' + candidate.baseVersion : '无技能'); row.append(outputs); section.append(row);
      }
      container.append(section);
    }
    const proof = candidate.publication?.proof;
    if (proof) {
      const review = node('section', '', 'studio-case'), label = node('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const labelText = proof.scope === 'isolated-file-execution' ? '实际任务对照' : '冻结文本对照';
      review.append(node('h4', '审核发布'), node('p', `${labelText} · ${proof.baselinePassed}/${proof.total} → ${proof.candidatePassed}/${proof.total} 通过`));
      if (proof.planId) review.append(action('核对冻结计划与产物', () => showExecution(proof.planId)));
      label.append(checkbox, ' 我已核对对照结果和适用范围，确认发布此候选。');
      const publish = action('审核后发布新版本', () => void work('正在核验基线并发布…', async isCurrent => {
        const result = await api(candidateUrl(candidate.id) + '/promote', {taskId, ...projectBody(), confirmed: checkbox.checked, trialId: proof.trialId});
        if (isCurrent()) drawCandidate({...result.candidate, experienceProposals: candidate.experienceProposals});
      }), 'primary-action'); publish.disabled = true; checkbox.onchange = () => { publish.disabled = !checkbox.checked; };
      review.append(label, publish); intro.append(review);
    } else if ((candidate.executionEvidence || candidate.regressionCases?.length) && candidate.publication?.reason) {
      intro.append(node('p', candidate.publication.reason, 'status'));
    }
    $('studio-candidate-list').hidden = true; container.hidden = false;
    if (regressionDraft) showExecution(undefined, regressionDraft);
  }
  async function openCandidate(id) {
    show('candidates');
    await work('正在读取候选与完整验证…', async isCurrent => { const candidate = await api(withTask(candidateUrl(id))); if (isCurrent()) drawCandidate(candidate); });
  }

  function editorDraft() {
    let delivery;
    if ($('studio-delivery').value.trim()) try { delivery = JSON.parse($('studio-delivery').value); } catch { delivery = {invalid: true}; }
    const lines = id => $(id).value.split('\n').map(line => line.trim()).filter(Boolean);
    const applicability = $('studio-applicability-enabled').checked ? {version: 1,
      goals: lines('studio-goals'), exclusions: lines('studio-exclusions'),
      input_formats: [...$('studio-input-formats').selectedOptions].map(option => option.value),
      project_files: lines('studio-project-files'), tools: lines('studio-required-tools')} : null;
    return {...Object.fromEntries(editorFields.map(key => [key, $('studio-' + key).value.trim()])),
      ...(applicability ? {applicability} : {}),
      ...(delivery !== undefined ? {delivery} : {}),
      tests: cases.map(({prompt, expected, expectations}) => ({prompt: prompt.value.trim(), expected_output: expected.value.trim(),
        expectations: expectations.value.split('\n').map(line => line.trim()).filter(Boolean)}))};
  }

  function clearReview() {
    $('studio-review-panel').hidden = true;
    $('studio-confirm').checked = false;
    $('studio-publish').disabled = true;
  }

  function invalidateComparisons() {
    compared.clear();
    for (const row of cases) row.results.replaceChildren();
    clearReview();
  }

  function drawComparison(container, comparison, baselineLabel = skillId ? '当前版本' : '无技能') {
    const verdicts = {passed: '通过', failed: '未通过', review: '待人工核验'};
    const panels = [[baselineLabel, comparison.baseline], ['候选草案', comparison.candidate]];
    container.replaceChildren(...panels.map(([label, result]) => {
      const panel = node('section', '', 'studio-output');
      panel.append(node('h5', result?.version ? `${label} · v${result.version}` : label));
      const {prompt_tokens: inputTokens, completion_tokens: outputTokens} = result?.usage ?? {};
      const usage = Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? `输入 ${inputTokens} · 输出 ${outputTokens} tokens` : '';
      const meta = [result?.model, Number.isFinite(result?.elapsedMs) ? `${(result.elapsedMs / 1000).toFixed(1)} 秒` : '', usage,
        result?.truncated ? '输出已截断' : ''].filter(Boolean);
      if (meta.length) panel.append(node('p', meta.join(' · '), 'status'));
      const output = node('pre', result?.output || '模型未返回文本。');
      output.tabIndex = 0;
      panel.append(output);
      if (result?.checks?.length) {
        const checks = node('ul', '', 'studio-checks');
        for (const check of result.checks) {
          const row = node('li');
          const badge = node('strong', verdicts[check.status]);
          badge.dataset.status = check.status;
          row.append(badge, ` ${check.text}`, node('p', check.evidence, 'status'));
          checks.append(row);
        }
        panel.append(checks);
      }
      return panel;
    }));
  }

  function addCase(test = {}) {
    const item = node('section', '', 'studio-case');
    const prompt = caseInput('同一条测试任务', test.prompt, 4000);
    const expected = caseInput('预期产物', test.expected_output, 1000);
    const expectations = caseInput('验收条件（每行一条）', test.expectations?.join('\n'), 1927);
    expectations.input.placeholder = '例如：包含：来源；也可以写需要人工核验的条件';
    const results = node('div', '', 'studio-results');
    const row = {prompt: prompt.input, expected: expected.input, expectations: expectations.input, results};
    cases.push(row);
    const run = action('运行对照', () => {
      const draft = editorDraft();
      const test = draft.tests[cases.indexOf(row)];
      const issue = validateDraft(draft, test);
      if (issue) { message(error, issue); return; }
      clearReview();
      compared.delete(row);
      results.replaceChildren();
      void work('正在让同一模型执行两次测试…', async isCurrent => {
        const comparison = await api(`${studioUrl}/compare`, {...requestBody(), draft, test});
        if (!isCurrent()) return;
        compared.set(row, comparison);
        drawComparison(results, comparison);
      });
    });
    const remove = action('移除用例', () => {
      cases = cases.filter(entry => entry !== row);
      item.remove();
      invalidateComparisons();
      $('studio-add-test').disabled = false;
    });
    const buttons = node('div', '', 'actions');
    buttons.append(remove, run);
    item.append(prompt.field, expected.field, expectations.field, buttons, results);
    item.addEventListener('input', invalidateComparisons);
    $('studio-tests').append(item);
    $('studio-add-test').disabled = cases.length >= 6;
  }

  function drawDraft(draft) {
    $('studio-delivery').value = draft.delivery ? JSON.stringify(draft.delivery, null, 2) : '';
    for (const key of editorFields) $('studio-' + key).value = draft[key] ?? '';
    $('studio-applicability-enabled').checked = Boolean(draft.applicability);
    const conditions = draft.applicability ?? {};
    for (const [id, field] of [['studio-goals', 'goals'], ['studio-exclusions', 'exclusions'], ['studio-project-files', 'project_files'], ['studio-required-tools', 'tools']]) {
      $(id).value = (conditions[field] ?? []).join('\n');
    }
    for (const option of $('studio-input-formats').options) option.selected = (conditions.input_formats ?? []).includes(option.value);
    cases = [];
    $('studio-tests').replaceChildren();
    $('studio-add-test').disabled = false;
    for (const test of draft.tests ?? []) addCase(test);
    invalidateComparisons();
    $('studio-draft').hidden = false;
    $('studio-generate').textContent = '按反馈修订草案';
  }

  function validateDraft(draft, test) {
    if (draft.delivery !== undefined && (!draft.delivery || draft.delivery.version !== 1 || !Array.isArray(draft.delivery.artifacts) || !Array.isArray(draft.delivery.preserve_inputs))) return '请填写有效的产物契约 JSON，或清空表示未声明。';
    if (editorFields.some(key => !draft[key])) return '请填写技能名称、适用条件与操作步骤。';
    if (draft.applicability && ['goals', 'exclusions', 'input_formats', 'project_files', 'tools'].every(key => !draft.applicability[key].length)) return '启用适用条件后请至少填写一项。';
    if (draft.applicability && ['goals', 'exclusions', 'project_files', 'tools'].some(key => draft.applicability[key].length > 12)) return '每项适用条件最多 12 条。';
    const tests = test ? [test] : draft.tests;
    if (tests.some(row => !row.prompt || !row.expected_output)) return '请为用例填写测试任务与预期产物。';
    if (draft.tests.some(row => row.expectations.length > 8 || row.expectations.some(check => check.length > 240))) return '每个用例最多 8 条验收条件，每条最多 240 字。';
    return '';
  }

  function generate() {
    const feedback = $('studio-feedback').value.trim();
    const draft = $('studio-draft').hidden ? undefined : editorDraft();
    if (!source && !draft && !feedback) { message(error, '请先描述希望这个技能完成什么。'); $('studio-feedback').focus(); return; }
    if (draft && !feedback) { message(error, '请输入修订意见，再生成新版草案。'); $('studio-feedback').focus(); return; }
    void work('正在生成技能草案…', async isCurrent => {
      const result = await api(`${studioUrl}/draft`, {...requestBody(), ...(source ? {runId: source.id} : {}), feedback, ...(draft ? {draft} : {})});
      if (!isCurrent()) return;
      baseVersion = result.baseVersion;
      drawDraft(result.draft);
      if (result.attempts?.length) message($('studio-source'),
        '已生成草案 · ' + result.attempts.length + ' 次模型请求 · 最后输出上限 ' + result.attempts.at(-1).maxTokens + ' tokens。请运行对照并核对后发布。');
      $('studio-feedback').value = '';
    });
  }

  function openEditor(run, skill) {
    parentCandidateId = null;
    source = run;
    skillId = skill?.id ?? null;
    baseVersion = skill?.version ?? 0;
    title.textContent = '技能中心';
    $('studio-editor-title').textContent = skill ? `改进 ${skill.name} · v${skill.version}` : '创建技能';
    message($('studio-source'), run?.prompt ? `来源任务 · ${run.prompt.slice(0, 180)}` : '');
    $('studio-feedback').value = '';
    const comparison = skill ? '当前发布版本与候选草案' : '无技能与候选草案';
    const project = Boolean(selectedProject);
    $('studio-scope').querySelector('[value="project"]').disabled = false;
    $('studio-scope').value = (skill ? skill.projectId : project) ? 'project' : 'global';
    $('studio-scope').disabled = Boolean(skill);
    $('studio-ai-fields').hidden = !run;
    $('studio-baseline').textContent = `${comparison}使用同一模型和提示词进行纯文本对照。请按预期产物和验收条件核对结果。`;
    $('studio-publish-scope').textContent = (skill ? skill.projectId : getTask()?.project_id) ? '发布后可在本项目的会话中使用。' : '发布后可在此工作区的所有会话中使用。';
    $('studio-generate').textContent = '生成草案';
    $('studio-draft').hidden = true;
    cases = [];
    invalidateComparisons();
    show('editor');
    if (!run) drawDraft(skill?.instructions ? skill : {name: '', description: '', instructions: '', tests: []});
  }

  function review() {
    if ($('studio-scope').value === 'project' && !selectedProject) { message(error, '请选择目标项目。'); return; }
    const issue = validateDraft(editorDraft());
    if (issue) { message(error, issue); return; }
    if (cases.some(row => !compared.has(row))) { message(error, '请先完成当前草案的每项对照测试。'); return; }
    message(error);
    $('studio-publish-scope').textContent = $('studio-scope').value === 'project'
      ? '将保存到当前项目。' : '将保存为所有项目可用的用户技能。';
    $('studio-review-panel').hidden = false;
    $('studio-confirm').focus();
  }

  function publish() {
    if ($('studio-review-panel').hidden || !$('studio-confirm').checked) return;
    const draft = editorDraft();
    void work('正在发布新版本…', async isCurrent => {
      const {skill} = await api(`${studioUrl}/publish`, {...requestBody(), draft, targetScope: $('studio-scope').value, ...(source ? {sourceRunId: source.id} : {})});
      if (!isCurrent()) return;
      clearReview();
      $('studio-detail-title').textContent = `${skill.name} · v${skill.version} 已发布`;
      $('studio-detail-description').textContent = skill.description;
      $('studio-detail-path').textContent = skill.storagePath ?? '';
      const use = action('用于下一轮', () => useSkill(skill), 'primary-action');
      use.disabled = !canUse(skill);
      $('studio-detail-actions').replaceChildren(use, action('查看版本', () => void openDetail(skill.id)));
      $('studio-versions').replaceChildren(node('p', `当前版本 · v${skill.version}`, 'status'));
      show('detail');
    });
  }

  function enter(run, skill) {
    const nextTask = getTask()?.id ?? null;
    if (nextTask === taskId && view && (busy || (view === 'editor' && source?.id === run?.id && skillId === (skill?.id ?? null)))) {
      if (!dialog.open) dialog.show();
      placePage();
      return;
    }
    operation++;
    setBusy(false);
    taskId = nextTask;
    selectedProject = getTask()?.project_id ?? null;
    void loadProjects().catch(failure => message(error, failure.message));
    void loadLocations().catch(failure => message(error, failure.message));
    if (run && skill) {
      show('library');
      $('studio-list').replaceChildren();
      void work('正在读取技能的当前版本…', async isCurrent => {
        const result = await api(withTask(`${studioUrl}/${encodeURIComponent(skill.id)}`));
        if (isCurrent()) openEditor(run, result.skill);
      });
    } else if (run || skill) openEditor(run, skill);
    else void openLibrary();
  }

  $('choose-custom-skill').onclick = $('skill-center-nav').onclick = () => enter();
  $('close-skill-studio').onclick = () => dialog.close();
  $('studio-create').onclick = () => openEditor();
  $('studio-tab-library').onclick = () => void openLibrary();
  $('studio-tab-create').onclick = () => openEditor();
  $('studio-tab-import').onclick = () => show('import');
  $('studio-tab-candidates').onclick = $('studio-refresh-candidates').onclick = () => void openCandidates();
  $('studio-tab-experiences').onclick = $('studio-refresh-experiences').onclick = () => void openExperiences();
  $('studio-save-candidate').onclick = () => {
    const draft = editorDraft(), issue = validateDraft(draft);
    if (issue) { message(error, issue); return; }
    void work('正在隔离保存候选，不修改正式技能…', async isCurrent => {
      const candidate = await api(candidateUrl(), {...requestBody(), draft, targetScope: $('studio-scope').value,
        ...(source ? {sourceRunId: source.id} : {}), ...(parentCandidateId ? {parentCandidateId} : {})});
      if (isCurrent()) { show('candidates'); drawCandidate(candidate); }
    });
  };
  $('studio-refresh').onclick = () => void openLibrary();
  $('studio-search').oninput = $('studio-filter').onchange = () => { libraryPage = 0; drawLibrary(library); };
  $('studio-manual').onclick = () => { $('studio-ai-fields').hidden = true; if ($('studio-draft').hidden) drawDraft({name: '', description: '', instructions: '', tests: []}); };
  $('studio-ai').onclick = () => { $('studio-ai-fields').hidden = false; $('studio-feedback').focus(); };
  $('studio-import-start').onclick = () => {
    const targetScope = $('studio-import-scope').value;
    if (targetScope === 'project' && !selectedProject) { message(error, '请选择目标项目。'); return; }
    const mode = $('studio-import-source').value;
    if (mode === 'libraries' || mode === 'library-path') {
      const paths = mode === 'libraries'
        ? [...$('studio-library-sources').querySelectorAll('input:checked')].map(input => input.value)
        : [$('studio-import-path').value.trim()];
      if (!paths.length || paths.some(path => !path)) { message(error, '请选择一个技能库，或填写其他技能库目录。'); return; }
      clearScan();
      void work('正在扫描技能库并检查重复…', async isCurrent => {
        const result = await api(studioUrl + '/scan-libraries', {taskId, ...projectBody(), targetScope, paths});
        if (!isCurrent()) return;
        libraryScan = result; scanPage = 0;
        selectedImports = new Set(result.candidates.filter(item => item.status === 'missing').map(item => item.id));
        const {missing, exists, conflict, invalid} = result.summary;
        $('studio-library-summary').textContent = `发现 ${result.candidates.length} 个技能：待导入 ${missing} · 已有 ${exists} · 同名冲突 ${conflict} · 无法读取 ${invalid}` +
          (result.truncated ? '。扫描结果不完整，请缩小目录后继续。' : '') +
          (result.issues.length ? `。${result.issues.length} 处目录或链接被跳过。` : '');
        $('studio-library-review').hidden = false;
        $('studio-library-filter').value = missing ? 'missing' : 'all';
        drawScan();
      });
      return;
    }
    const preview = (draft, name) => {
      openEditor();
      drawDraft(draft);
      $('studio-scope').value = targetScope;
      drawProjectPicker();
      message($('studio-source'), '已读取 ' + name + '，请核对内容后保存。');
    };
    if ($('studio-import-source').value === 'directory') {
      const path = $('studio-import-path').value.trim();
      if (!path) { message(error, '请输入本机目录的绝对路径。'); return; }
      void work('正在读取目录中的技能…', async isCurrent => {
        const {candidates, truncated} = await api(studioUrl + '/import-directory', {taskId, ...projectBody(), path, targetScope});
        if (!isCurrent()) return;
        const rows = candidates.map(candidate => {
          const row = node('section', '', 'studio-card');
          const label = node('div');
          label.append(node('h4', candidate.draft?.name || candidate.path),
            node('p', candidate.draft?.description || candidate.error, 'status'),
            node('p', candidate.path, 'status'));
          row.append(label);
          if (candidate.draft) row.append(action('预览并编辑', () => preview(candidate.draft, candidate.path)));
          return row;
        });
        if (truncated) rows.unshift(node('p', '目录结果不完整，请指定更小的技能目录继续导入。', 'status'));
        if (!rows.length) rows.push(node('p', '当前目录未找到技能文件。', 'status'));
        $('studio-import-results').replaceChildren(...rows);
      });
      return;
    }
    const file = $('studio-import-file').files[0];
    if (!file) { message(error, '请选择一个技能文件。'); return; }
    if (file.size > 256_000) { message(error, '技能文件不能超过 256 KB。'); return; }
    void work('正在读取技能文件…', async isCurrent => {
      const imported = await api(studioUrl + '/import', {taskId, ...projectBody(), targetScope, name: file.name, content: await file.text()});
      if (!isCurrent()) return;
      preview(imported.draft, file.name);
    });
  };
  $('studio-import-source').onchange = importMode;
  $('studio-import-path').oninput = clearScan;
  $('studio-import-scope').onchange = () => { clearScan(); drawProjectPicker(); };
  $('studio-library-filter').onchange = () => { scanPage = 0; drawScan(); };
  $('studio-library-select').onclick = () => { selectedImports = new Set(libraryScan?.candidates.filter(item => item.status === 'missing').map(item => item.id) ?? []); drawScan(); };
  $('studio-library-clear').onclick = () => { selectedImports.clear(); drawScan(); };
  $('studio-library-import').onclick = () => {
    if (!libraryScan || !selectedImports.size) return;
    void work('正在导入缺少的技能及配套文件…', async isCurrent => {
      const result = await api(studioUrl + '/import-missing', {taskId, ...projectBody(), token: libraryScan.token, ids: [...selectedImports]});
      if (!isCurrent()) return;
      for (const item of result.results) {
        Object.assign(libraryScan.candidates.find(candidate => candidate.id === item.id), item);
        selectedImports.delete(item.id);
      }
      $('studio-library-summary').textContent = `导入完成：新增 ${result.imported} · 已有跳过 ${result.skipped} · 失败 ${result.failed}。可在「技能」页搜索和使用。`;
      $('studio-library-filter').value = 'all';
      scanPage = 0; drawScan();
    });
  };
  $('studio-target-project').onchange = () => {
    selectedProject = $('studio-target-project').value || null;
    if(view==='experiences')void openExperiences();
    clearScan();
    if ($('studio-import-source').value === 'libraries') void loadSources();
    clearReview();
    void loadLocations().catch(failure => message(error, failure.message));
  };
  $('studio-back-editor').onclick = $('studio-back-detail').onclick = () => void openLibrary();
  $('studio-generate').onclick = generate;
  $('studio-add-test').onclick = () => { addCase(); invalidateComparisons(); cases.at(-1).prompt.focus(); };
  $('studio-review').onclick = review;
  $('studio-cancel-review').onclick = clearReview;
  $('studio-confirm').onchange = event => { $('studio-publish').disabled = !event.target.checked; };
  $('studio-publish').onclick = publish;
  for (const key of editorFields) $('studio-' + key).addEventListener('input', invalidateComparisons);
  $('studio-delivery').addEventListener('input', invalidateComparisons);
  $('studio-delivery-example').onclick = () => {
    if ($('studio-delivery').value.trim()) { message(error, '已有契约内容，请直接编辑。'); return; }
    $('studio-delivery').value = JSON.stringify({version: 1, preserve_inputs: [], artifacts: [{path: 'report.json', format: 'json', require_change: true,
      checks: [{kind: 'json_type', pointer: '/records', expected: 'array'}]}]}, null, 2); invalidateComparisons();
  };
  for (const id of ['studio-applicability-enabled', 'studio-goals', 'studio-exclusions', 'studio-input-formats', 'studio-project-files', 'studio-required-tools']) {
    $(id).addEventListener('input', invalidateComparisons);
  }
  $('studio-scope').onchange = () => { clearReview(); drawProjectPicker(); };

  return {openExperiences:run=>{
    if(busy)return;
    taskId=getTask()?.id??null;selectedProject=getTask()?.project_id??null;
    void loadProjects().catch(failure=>message(error,failure.message));
    void loadLocations().catch(failure=>message(error,failure.message));
    void openExperiences(run);
  },openFromRun: (run, skill) => enter(run, skill), openSkill: id => {
    operation++;
    setBusy(false);
    taskId = getTask()?.id ?? null;
    selectedProject = getTask()?.project_id ?? null;
    void loadProjects().catch(failure => message(error, failure.message));
    void loadLocations().catch(failure => message(error, failure.message));
    show('library');
    void openDetail(id);
  }};
}
