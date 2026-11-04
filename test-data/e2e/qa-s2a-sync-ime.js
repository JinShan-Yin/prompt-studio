// 套件二-a：双层高亮同步 + IME 防误触
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(120); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  // 确保选中 Trip
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await wait(() => getComputedStyle(document.getElementById('main-content')).display !== 'none', 8000);
  await sleep(1200);
  // ---- 2.1 双层同步 ----
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push('第' + i + '行 {{industry}} ' + '长文本填充'.repeat(4));
  const longText = '\n' + lines.join('\n');
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  ta.value = longText;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  const shTa = ta.scrollHeight;
  const shMirror = mirror.scrollHeight;
  const delta = Math.abs(shTa - shMirror);
  push('2.1a 1000 字/50 换行/50 变量 scrollHeight 同步（±2px）', delta <= 2, { taScrollHeight: shTa, mirrorScrollHeight: shMirror, delta, textLen: longText.length, spanCount: mirror.querySelectorAll('span').length });
  ta.scrollTop = ta.scrollHeight;
  ta.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(300);
  push('2.1b 滚动到底部 mirror.scrollTop === textarea.scrollTop', mirror.scrollTop === ta.scrollTop, { taScrollTop: ta.scrollTop, mirrorScrollTop: mirror.scrollTop });
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  // ---- 2.2 IME 防误触 ----
  const tagInput = document.getElementById('ctx-scene-input');
  const tagList = document.getElementById('ctx-scene-tags');
  const before = tagList.querySelectorAll('.tag-chip').length;
  tagInput.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(tagInput, '输入法测试标签');
  tagInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const composingEv = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true });
  tagInput.dispatchEvent(composingEv);
  await sleep(250);
  const afterComposing = tagList.querySelectorAll('.tag-chip').length;
  push('2.2a isComposing=true 时 Enter 不新增 Tag', afterComposing === before, { before, afterComposing });
  // keyCode 229 场景
  const ev229 = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(ev229, 'keyCode', { get: () => 229 });
  tagInput.dispatchEvent(ev229);
  await sleep(250);
  const after229 = tagList.querySelectorAll('.tag-chip').length;
  push('2.2b keyCode=229（IME 组合）时 Enter 不新增 Tag', after229 === before, { before, after229 });
  // 正常 Enter 应新增（确认防误触不是完全禁用）
  const normalEv = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
  tagInput.dispatchEvent(normalEv);
  await sleep(350);
  const afterNormal = tagList.querySelectorAll('.tag-chip').length;
  push('2.2c 正常 Enter 可新增 Tag（功能未死）', afterNormal === before + 1, { before, afterNormal });
  // 清理新增 tag
  const chips = Array.from(tagList.querySelectorAll('.tag-chip'));
  if (chips.length > before) { const del = chips[chips.length - 1].querySelector('.tag-chip-del'); if (del) del.click(); await sleep(300); }
  nativeSetter.call(tagInput, '');
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));