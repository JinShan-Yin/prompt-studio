// V3.0 阶段三 Lead E2E：关闭模型弹窗 + 插入变量下拉 + 高亮中文 title
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = window.__v3p3 = { errors: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const modal = document.getElementById('model-config-modal');
  // 关闭模型弹窗（关闭按钮或 Esc）
  const closeBtn = modal ? modal.querySelector('.modal-close, [data-close], .model-close') : null;
  if (closeBtn) closeBtn.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const closed = await waitUntil(() => !modal || modal.offsetHeight === 0 || getComputedStyle(modal).display === 'none', 5000);
  await sleep(300);
  // 阶段三：插入变量
  const ta = document.getElementById('val-L0');
  ta.value = '前缀文本';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  await sleep(200);
  const sel = document.getElementById('insert-var-select');
  const opts = Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent.trim() }));
  const pick = (kw) => opts.find((o) => o.text.includes(kw));
  const inst = [];
  for (const kw of ['行业', '业务场景', '核心目标']) {
    const o = pick(kw);
    if (!o) continue;
    const before = ta.value;
    sel.value = o.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(350);
    inst.push({ kw, optionValue: o.value, optionText: o.text, before, after: ta.value, selectReset: sel.value === '' });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  await sleep(300);
  const stats = { chars: (document.getElementById('stats-chars') || {}).innerText, tokens: (document.getElementById('stats-tokens') || {}).innerText };
  const mirror = document.getElementById('mirror-L0');
  const spans = Array.from(mirror.querySelectorAll('span')).map((s) => ({ text: s.textContent, title: s.getAttribute('title') }));
  const positionOk = ta.value === '前缀文本{{industry}}{{business_scene}}{{core_goal}}' || ta.value.includes('{{industry}}') && ta.value.includes('{{business_scene}}') && ta.value.includes('{{core_goal}}');
  const titles = {};
  spans.forEach((s) => { if (/industry/.test(s.text)) titles.industry = s.title; if (/business_scene/.test(s.text)) titles.business_scene = s.title; if (/core_goal/.test(s.text)) titles.core_goal = s.title; });
  const englishOnly = spans.every((s) => !/[\u4e00-\u9fa5]/.test(s.text));
  const expectedChars = String(ta.value.length + document.getElementById('val-L1').value.length + document.getElementById('val-L3').value.length);
  return {
    pass: !!closed && opts.length >= 7 && inst.length === 3 && inst.every((x) => x.after.includes('{{') && x.selectReset) && positionOk &&
      englishOnly && titles.industry === '行业/公司名' && titles.business_scene === '业务场景' && titles.core_goal === '核心目标' &&
      stats.chars === expectedChars && S.errors.length === 0,
    closed: !!closed,
    options: opts,
    inserts: inst.map((x) => ({ kw: x.kw, optionText: x.optionText, after: x.after, selectReset: x.selectReset })),
    finalValue: ta.value, positionOk,
    spans, titles, englishOnly, stats, expectedChars,
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));