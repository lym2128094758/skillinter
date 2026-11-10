const $ = id => document.getElementById(id);
let revision = 0;
async function request(path, body) {
  const response = await fetch('/api/skill-intelligence/' + path, body ? {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '技能引擎请求失败');
  return data;
}
function draft() {
  return {revision, enabled: $('engine-enabled').checked, sourcePath: $('engine-path').value.trim(),
    python: $('engine-python').value.trim(), encoder: $('engine-encoder').value};
}
$('settings').addEventListener('click', async () => {
  try {
    const value = await request('settings');
    revision = value.revision;
    $('engine-enabled').checked = value.enabled;
    $('engine-path').value = value.sourcePath;
    $('engine-python').value = value.python;
    $('engine-encoder').value = value.encoder;
    $('engine-status').textContent = value.enabled ? '已配置，从下一轮起使用' : '本地匹配已启用，可配置 SkillNet 增强检索';
  } catch (error) { $('engine-status').textContent = error.message; }
});
async function apply(test) {
  const buttons = [...$('engine-form').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  $('engine-status').textContent = test ? '正在加载并检测 SkillNet…' : '正在保存…';
  try {
    const value = await request(test ? 'test' : 'settings', draft());
    if (test) $('engine-status').textContent = '已连接 · v' + value.version + ' · ' + value.encoder.kind +
      (value.encoder.degraded ? ' · ' + value.encoder.reason : '');
    else { revision = value.revision; $('engine-status').textContent = '已保存，从下一轮起生效'; }
  } catch (error) { $('engine-status').textContent = error.message; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
$('engine-test').onclick = () => void apply(true);
$('engine-form').onsubmit = event => { event.preventDefault(); void apply(false); };
