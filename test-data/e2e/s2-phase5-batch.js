// Sprint2 Lead E2E Phase 5：批处理回归测试（进度条 + 通过率报告 + 缺 bot_reply 自动生成）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 200) {
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
  const fileName = document.getElementById('batch-file-name');
  if (!fileInput || !runBtn || !progressBar || !report) return { pass: false, fatal: '批处理回归测试元素缺失' };

  const uploadJson = (name, arr) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(arr)], name, { type: 'application/json' }));
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const readProgress = () => ({
    w: progressBar.style.width,
    t: (progressText && progressText.innerText) || '',
    reportVisible: !!(report && getComputedStyle(report).display !== 'none' && report.innerText.trim().length > 10),
    disabled: runBtn.disabled
  });

  // -------- 第 1 轮：确定性 3 条（1 通过 / 2 失败） --------
  const deterministic = [
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>您好，停车首小时8元，全天封顶50元。</speak>' },
    { user_query: '停车场在哪里？', standard_answer: '商场B1层，入口位于东侧。', bot_reply: '**停车场在B1层**\n- 入口位于东侧' },
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>老板您好，停车费首小时10元，全天封顶100元。</speak>' }
  ];
  uploadJson('batch-regression-deterministic.json', deterministic);
  await waitUntil(() => fileName && /3/.test(fileName.innerText), 5000);
  const evalBefore = S.evalCalls; const chatBefore = S.chatReqs.length;
  runBtn.click();
  const samples = [];
  let sawDisabled = false; let sawIntermediate = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const p = readProgress();
    samples.push(p);
    if (p.disabled) sawDisabled = true;
    if (p.w && p.w !== '0%' && p.w !== '100%' && /progress|%/.test(p.w) === false && p.w !== '0') { /* noop */ }
    if (p.w && !['', '0%', '100%'].includes(p.w) && /%$/.test(p.w)) sawIntermediate = true;
    if (p.reportVisible) break;
    await sleep(250);
  }
  await sleep(400);
  const p1 = readProgress();
  const reportText = report.innerText;
  const pass1 = {
    evalDelta: S.evalCalls - evalBefore,
    chatDelta: S.chatReqs.length - chatBefore,
    finalWidth: p1.w,
    finalProgressText: p1.t,
    reportVisible: p1.reportVisible,
    reportText: reportText.slice(0, 1200),
    sawDisabled, sawIntermediate,
    sampleCount: samples.length,
    maxWidth: samples.map((s) => s.w).filter(Boolean).slice(-3),
    passRateMatch: /1\s*\/\s*3/.test(reportText),
    percentMatch: /33/.test(reportText),
    failCaseA: /停车场在哪里|Markdown|违规/.test(reportText),
    failCaseB: /10元|100元|首小时8元/.test(reportText)
  };
  pass1.pass = pass1.evalDelta === 3 && pass1.chatDelta === 0 && pass1.finalWidth === '100%' && pass1.reportVisible && pass1.passRateMatch && pass1.percentMatch && pass1.failCaseA && pass1.failCaseB && pass1.sawDisabled;

  // -------- 第 2 轮：缺 bot_reply → 自动调 /api/chat/reply 生成后再评测 --------
  const autoGen = [{ user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。' }];
  uploadJson('batch-auto-gen.json', autoGen);
  await waitUntil(() => fileName && /1|auto/.test(fileName.innerText), 5000);
  await sleep(300);
  const reportHiddenAfterUpload = !(getComputedStyle(report).display !== 'none' && report.innerText.trim().length > 10);
  const evalBefore2 = S.evalCalls; const chatBefore2 = S.chatReqs.length;
  runBtn.click();
  const t1 = Date.now();
  let p2 = null;
  while (Date.now() - t1 < 240000) {
    const p = readProgress();
    if (p.reportVisible) { p2 = p; break; }
    await sleep(250);
  }
  await sleep(500);
  p2 = { ...readProgress(), reportText: report.innerText.slice(0, 900) };
  const pass2 = {
    evalDelta: S.evalCalls - evalBefore2,
    chatDelta: S.chatReqs.length - chatBefore2,
    finalWidth: p2.w,
    finalProgressText: p2.t,
    reportVisible: p2.reportVisible,
    reportText: p2.reportText,
    reportHiddenAfterUpload,
    chatReqHasSystemPrompt: !!(S.chatReqs.slice(chatBefore2)[0] && S.chatReqs.slice(chatBefore2)[0].messages)
  };
  pass2.pass = pass2.evalDelta === 1 && pass2.chatDelta === 1 && pass2.finalWidth === '100%' && pass2.reportVisible;

  return {
    pass: pass1.pass && pass2.pass,
    round1: pass1,
    round2: pass2,
    samplesPreview: samples.slice(0, 12).map((s) => ({ w: s.w, t: s.t, disabled: s.disabled }))
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));