// 套件五：排版边界 + 全局快捷键（基线执行）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const ta = document.getElementById('val-L0');
  const setVal = (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); };
  // 5.1 排版清理
  setVal('测试，，，，\n\n\n\n测试');
  await sleep(300);
  document.getElementById('clean-format-btn').click();
  await sleep(500);
  const actual = ta.value;
  push('5.1 一键清理排版：连续全角逗号变1、连续空行变1', actual === '测试，\n\n测试', { expected: '测试，\n\n测试', actual: JSON.stringify(actual) });
  setVal('');
  await sleep(300);
  // 5.2 Esc 关闭所有 Modal
  document.getElementById('api-key-btn').click();
  await sleep(600);
  const modal = document.getElementById('model-config-modal');
  const opened = getComputedStyle(modal).display !== 'none';
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  const ids = ['global-modal', 'model-config-modal', 'kb-edit-modal', 'diff-modal'];
  const states = ids.map((id) => ({ id, display: getComputedStyle(document.getElementById(id)).display }));
  const allClosed = states.every((s) => s.display === 'none');
  push('5.2a Modal 打开成功', opened);
  push('5.2b Esc 后所有 Modal 遮罩 display=none', allClosed, states);
  // 额外：global-modal 打开后 Esc
  const createBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启新项目'));
  createBtn.click();
  await sleep(400);
  const gOpened = getComputedStyle(document.getElementById('global-modal')).display === 'flex';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  const gClosed = getComputedStyle(document.getElementById('global-modal')).display === 'none';
  push('5.2c 全局 Modal 打开/Esc 关闭', gOpened && gClosed, { gOpened, gClosed });
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));