export function createPromptOptimizer({getContext, canOptimize, onApply}) {
  const $ = id => document.getElementById(id);
  const dialog = $('prompt-optimizer-dialog');
  let original, controller, resultContext;
  function error(text = '') {
    $('prompt-optimizer-error').textContent = text;
    $('prompt-optimizer-error').hidden = !text;
  }
  async function optimize() {
    controller?.abort();
    const current = controller = new AbortController();
    $('prompt-optimizer-status').textContent = '正在整理目标和交付要求…';
    $('prompt-optimizer-result').hidden = true;
    $('apply-prompt-optimizer').disabled = true;
    $('retry-prompt-optimizer').disabled = true;
    error();
    try {
      const response = await fetch('/api/prompts/optimize', {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify(resultContext), signal: current.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (current !== controller || !dialog.open) return;
      $('prompt-optimized').value = result.prompt;
      $('prompt-improvements').replaceChildren(...result.improvements.map(item => {
        const row = document.createElement('li'); row.textContent = item; return row;
      }));
      $('prompt-question-list').replaceChildren(...result.questions.map(item => {
        const row = document.createElement('li'); row.textContent = item; return row;
      }));
      $('prompt-questions').hidden = !result.questions.length;
      $('prompt-plan-hint').textContent = result.use_plan ? '建议使用任务计划，执行时按实际进展更新。' : '当前任务可直接回复。';
      $('prompt-optimizer-status').textContent = '已生成 · ' + result.model;
      $('prompt-optimizer-result').hidden = false;
      $('apply-prompt-optimizer').disabled = false;
    } catch (failure) {
      if (!current.signal.aborted) { error(failure.message); $('prompt-optimizer-status').textContent = ''; }
    } finally { if (current === controller) $('retry-prompt-optimizer').disabled = false; }
  }
  $('optimize-prompt').onclick = () => {
    if (!canOptimize()) return;
    const context = getContext();
    if (!context.prompt.trim()) { $('prompt').focus(); return; }
    resultContext = context;
    original = context.prompt;
    $('prompt-original').value = original;
    dialog.showModal();
    void optimize();
  };
  $('retry-prompt-optimizer').onclick = () => void optimize();
  $('close-prompt-optimizer').onclick = $('cancel-prompt-optimizer').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { controller?.abort(); controller = null; });
  $('apply-prompt-optimizer').onclick = () => {
    if ($('apply-prompt-optimizer').disabled) return;
    const now = getContext();
    if (now.taskId !== resultContext.taskId || now.prompt !== original) {
      error('输入框或会话已变化，原稿已保留。请关闭后重新优化当前草稿。');
      return;
    }
    const prompt = $('prompt-optimized').value.trim();
    if (!prompt) { error('优化文本不能为空。'); return; }
    onApply(prompt);
    dialog.close();
    $('prompt').focus();
  };
  return {update() { $('optimize-prompt').disabled = !canOptimize() || !$('prompt').value.trim(); }};
}
