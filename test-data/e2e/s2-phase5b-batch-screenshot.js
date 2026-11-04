// Sprint2 Lead E2E Phase 5b：重跑确定性批量用例并停留在报告页供截图
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 240000, interval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const S = window.__s2;
  const fileInput = document.getElementById('batch-file');
  const runBtn = document.getElementById('batch-run-btn');
  const progressBar = document.getElementById('batch-progress-bar');
  const progressText = document.getElementById('batch-progress-text');
  const report = document.getElementById('batch-report');
  if (!fileInput || !runBtn) return { pass: false, fatal: 'batch elements missing' };
  const deterministic = [
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>您好，停车首小时8元，全天封顶50元。</speak>' },
    { user_query: '停车场在哪里？', standard_answer: '商场B1层，入口位于东侧。', bot_reply: '**停车场在B1层**\n- 入口位于东侧' },
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>老板您好，停车费首小时10元，全天封顶100元。</speak>' }
  ];
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify(deterministic)], 'batch-regression-deterministic.json', { type: 'application/json' }));
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);
  const evalBefore = S.evalCalls;
  runBtn.click();
  const t0 = Date.now();
  let visible = false;
  while (Date.now() - t0 < 240000) {
    const p = { w: progressBar.style.width, t: progressText.innerText, visible: !!(report && getComputedStyle(report).display !== 'none' && report.innerText.trim().length > 10) };
    if (p.visible) { visible = true; break; }
    await sleep(250);
  }
  await sleep(500);
  return {
    pass: visible && S.evalCalls - evalBefore === 3 && /1\s*\/\s*3/.test(report.innerText) && progressBar.style.width === '100%',
    progress: { w: progressBar.style.width, t: progressText.innerText },
    evalDelta: S.evalCalls - evalBefore,
    reportText: report ? report.innerText.slice(0, 800) : '',
    reportVisible: visible
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));