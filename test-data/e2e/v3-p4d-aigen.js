// V3.0 阶段四 Lead E2E (d)：红蓝对抗出题机（真实 LLM → 渲染 → 填入批量回归）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 14000, interval = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = window.__v3p4d = window.__v3p4d || { errors: [], clicked: false };
  if (!S.hooked) {
    S.hooked = true;
    window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  }
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const trip = findTree('Trip旅游AI接线员');
  if (trip) trip.click();
  await waitUntil(() => document.getElementById('main-content').style.display === 'block', 8000);
  await sleep(900);
  const btn = document.getElementById('gen-questions-btn');
  if (!S.clicked) { btn.click(); S.clicked = true; await sleep(300); }
  const result = document.getElementById('gen-questions-result');
  const ready = await waitUntil(() => (result.querySelectorAll('.gen-q-card, .gen-q-item, [data-q-index]').length > 0) || (result.innerText || '').length > 30, 14000);
  await sleep(500);
  const cards = result.querySelectorAll('.gen-q-card, .gen-q-item, [data-q-index]').length;
  const statusText = (document.getElementById('gen-questions-status') || {}).innerText || '';
  const resultText = (result.innerText || '').slice(0, 400);
  let filled = false, runEnabled = false, fileName = '';
  const fillBtn = document.getElementById('gen-fill-batch-btn');
  const fillVisible = fillBtn && getComputedStyle(document.getElementById('gen-questions-actions')).display !== 'none';
  if (cards > 0 && fillBtn) {
    fillBtn.click();
    await sleep(700);
    runEnabled = !document.getElementById('batch-run-btn').disabled;
    fileName = (document.getElementById('batch-file-name') || {}).innerText || '';
    filled = /AI|条/.test(fileName) && runEnabled;
  }
  return {
    ready: !!ready, cards, statusText, resultText, fillVisible: !!fillVisible, filled, runEnabled, fileName,
    pass: !!ready && cards >= 1 && filled && S.errors.length === 0,
    clicked: S.clicked, errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));