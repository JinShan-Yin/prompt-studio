// V3.0 最终复验：镜像中文 tooltip 可见 + Token 80% 边界 + logo + 无回归
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = { errors: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  findTree('Trip旅游AI接线员').click();
  await waitUntil(() => document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(1400);
  // ---- logo ----
  const logo = document.querySelector('.logo-area img');
  const logoOk = !!(logo && logo.complete && logo.naturalWidth > 0 && getComputedStyle(logo).display !== 'none');
  const fallbackHidden = (() => { const f = document.getElementById('fallback'); return !f || getComputedStyle(f).display === 'none'; })();
  // ---- tooltip ----
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  ta.value = '前缀文本 {{industry}} 中间 {{business_scene}} 结尾';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const spans = Array.from(mirror.querySelectorAll('span'));
  const spanOf = (txt) => spans.find((s) => s.textContent.includes(txt));
  function hoverSpan(span) {
    const r = span.getBoundingClientRect();
    const ev = new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    ta.dispatchEvent(ev);
  }
  const tooltip = document.getElementById('var-tooltip');
  const sInd = spanOf('industry');
  hoverSpan(sInd);
  await sleep(150);
  const t1 = { visible: !!tooltip && getComputedStyle(tooltip).display !== 'none', text: tooltip ? tooltip.innerText : '', pos: tooltip ? { left: getComputedStyle(tooltip).left, top: getComputedStyle(tooltip).top, position: getComputedStyle(tooltip).position, pointerEvents: getComputedStyle(tooltip).pointerEvents } : null };
  const sGoal = spanOf('business_scene');
  hoverSpan(sGoal);
  await sleep(150);
  const t2 = { visible: !!tooltip && getComputedStyle(tooltip).display !== 'none', text: tooltip ? tooltip.innerText : '' };
  // 普通文本 → 隐藏
  const rTa = ta.getBoundingClientRect();
  ta.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rTa.left + 8, clientY: rTa.top + 4 }));
  await sleep(150);
  const ordinaryHidden = getComputedStyle(tooltip).display === 'none';
  // 鼠标移出隐藏
  hoverSpan(sInd); await sleep(120);
  ta.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  await sleep(150);
  const leaveHidden = getComputedStyle(tooltip).display === 'none';
  // ---- Token 边界 ----
  const bar = document.getElementById('token-progress-bar');
  const warning = document.getElementById('token-limit-warning');
  setValSafe = (chars) => { ta.value = 'A'.repeat(chars); ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const cases = [];
  for (const [label, chars] of [['3200(80%)', 5333], ['3201', 5334], ['4000(100%)', 6666], ['4001', 6667]]) {
    setValSafe(chars);
    await sleep(300);
    cases.push({ label, expectedTokens: Math.ceil(chars * 0.6), width: bar.style.width, color: getComputedStyle(bar).backgroundColor, warningVisible: getComputedStyle(warning).display !== 'none', warningText: warning.innerText });
  }
  // 恢复空
  ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  const c = cases.map((x) => x.color);
  const tokenOk = cases[0].color === 'rgb(22, 163, 74)' && cases[1].color === 'rgb(234, 179, 8)' && cases[2].color === 'rgb(234, 179, 8)' && cases[3].color === 'rgb(239, 68, 68)' &&
    cases[0].warningVisible === false && cases[1].warningVisible === false && cases[2].warningVisible === false && cases[3].warningVisible === true;
  // ---- 页面核心 ----
  const kb = (document.getElementById('kb-count') || {}).innerText;
  const snapshotRows = document.querySelectorAll('#snapshot-tbody tr').length;
  return {
    pass: logoOk && fallbackHidden && t1.visible && t1.text === '行业/公司名' && t1.pos.position === 'fixed' && t1.pos.pointerEvents === 'none' &&
      t2.visible && t2.text === '业务场景' && ordinaryHidden && leaveHidden && tokenOk && /97/.test(kb) && snapshotRows >= 1 && S.errors.length === 0,
    logo: { logoOk, fallbackHidden, naturalWidth: logo ? logo.naturalWidth : 0 },
    tooltip: { first: t1, second: t2, ordinaryHidden, leaveHidden },
    tokenCases: cases, tokenOk,
    page: { kb, snapshotRows },
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));