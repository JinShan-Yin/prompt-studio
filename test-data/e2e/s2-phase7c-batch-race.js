// Sprint2 Lead E2E Phase 7c：批量回归运行中切项目（P2-1）真机复验（修正断言：切项目后设计上重置为待选文件态）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 10000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const S = window.__s2r || (window.__s2r = { errors: [] });
  S.errors = S.errors || [];
  const select = async (name) => {
    findTree(name).click();
    await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 8000);
    await sleep(800);
  };
  await select('途牛热线');
  const fileInput = document.getElementById('batch-file');
  const runBtn = document.getElementById('batch-run-btn');
  const cases = [
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>您好，停车首小时8元，全天封顶50元。</speak>' },
    { user_query: '停车场在哪里？', standard_answer: '商场B1层，入口位于东侧。', bot_reply: '**停车场在B1层**\n- 入口位于东侧' },
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>老板您好，停车费首小时10元，全天封顶100元。</speak>' }
  ];
  const upload = () => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(cases)], 'race-batch.json', { type: 'application/json' }));
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
  upload();
  await sleep(500);
  const runEnabledAfterUpload = !runBtn.disabled;
  const errorsBefore = S.errors.length;
  runBtn.click();
  await sleep(300); // 第 1 条 LLM 在途
  const midState = {
    runDisabled: runBtn.disabled,
    selectBtnDisabled: fileInput.disabled || (Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('选择用例')) || {}).disabled,
    progressWidth: (document.getElementById('batch-progress-bar') || {}).style.width,
    progressText: (document.getElementById('batch-progress-text') || {}).innerText
  };
  await select('Trip旅游AI接线员'); // 运行中切项目
  await sleep(7000); // 等旧循环挂起响应回来并中止
  const report = document.getElementById('batch-report');
  const afterSwitch = {
    runDisabledInResetState: runBtn.disabled, // 设计：切项目后重置为"待选文件"，按钮禁用正确
    selectBtnEnabled: !(document.getElementById('batch-select-btn') || {}).disabled,
    fileNameText: (document.getElementById('batch-file-name') || {}).innerText,
    progressHidden: (() => { const p = document.getElementById('batch-progress'); return !!p && getComputedStyle(p).display === 'none'; })(),
    reportHidden: !report || getComputedStyle(report).display === 'none'
  };
  // 恢复验证：重新选择文件后可再次运行
  upload();
  await sleep(500);
  const canRunAgain = !runBtn.disabled;
  const result = {
    runEnabledAfterUpload,
    midState,
    afterSwitch,
    canRunAgain,
    errorsDelta: S.errors.length - errorsBefore,
    errors: S.errors.slice(errorsBefore),
    errorsAll: S.errors.slice(),
    pass: runEnabledAfterUpload && midState.runDisabled && midState.selectBtnDisabled && errorsBefore === S.errors.length &&
      afterSwitch.selectBtnEnabled && afterSwitch.progressHidden && afterSwitch.reportHidden && canRunAgain && S.errors.length === 0
  };
  // 清理：切回 Trip
  await select('Trip旅游AI接线员');
  return result;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));