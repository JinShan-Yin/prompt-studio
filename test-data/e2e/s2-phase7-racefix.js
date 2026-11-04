// Sprint2 Lead E2E Phase 7：QA P2 竞态修复复验 + deleteKb 真机补测（修复后运行）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 30000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const S = { errors: [], chatReqs: [], evalCalls: 0, parseCalls: 0, saveCalls: 0 };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  {
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      try {
        if (u.includes('/api/chat/reply')) S.chatReqs.push(JSON.parse(opts.body));
        if (u.includes('/api/eval/run')) S.evalCalls++;
        if (u.includes('/api/kb/parse')) S.parseCalls++;
        if (u.includes('/api/kb/save')) S.saveCalls++;
      } catch (e) {}
      return orig(url, opts);
    };
  }
  const listCount = async (pid) => {
    const r = await fetch('/api/kb/list?token=' + token + '&project_id=' + pid);
    const j = await r.json();
    return Array.isArray(j.data) ? j.data.length : -1;
  };
  const select = async (name) => {
    const n = findTree(name);
    if (n) n.click();
    await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
    await sleep(900);
  };
  const bubbles = () => document.querySelectorAll('#chat-messages .chat-bubble').length;

  // ===== 1) deleteKb 真机：注入临时条目 → 页面上点删除 → 红色 modal → 确认删除 =====
  await select('途牛热线');
  let kb0 = await listCount('proj-7ec6f484');
  const seedRes = await fetch('/api/kb/save?token=' + token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: 'proj-7ec6f484', pairs: [{ question: 'DELETE_SMOKE_临时删除条目', answer: '用于验证页内删除弹窗' }] })
  });
  await seedRes.json();
  const refreshBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('刷新列表'));
  if (refreshBtn) refreshBtn.click();
  await waitUntil(() => (document.getElementById('kb-list-container') || {}).textContent && document.getElementById('kb-list-container').textContent.includes('DELETE_SMOKE'), 10000);
  const search = document.getElementById('kb-search');
  search.value = 'DELETE_SMOKE'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  const delBtn = Array.from(document.querySelectorAll('#kb-list-container button')).find((b) => b.textContent.includes('删除'));
  const modal = document.getElementById('global-modal');
  let delResult = { found: !!delBtn, modalOpened: false, titleText: '', red: false, closed: false, removedUi: false, removedApi: false, searchKept: false };
  if (delBtn) {
    delBtn.click();
    delResult.modalOpened = !!(await waitUntil(() => modal.style.display === 'flex', 8000));
    await sleep(250);
    const title = document.getElementById('modal-title');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    delResult.titleText = title ? title.innerText : '';
    delResult.red = /245, 108, 108/.test(getComputedStyle(confirmBtn).backgroundColor);
    const okBtn = Array.from(document.querySelectorAll('#global-modal button')).find((b) => /确定|确认/.test(b.textContent));
    if (okBtn) okBtn.click();
    await waitUntil(() => modal.style.display !== 'flex', 8000);
    await sleep(1200);
    delResult.closed = modal.style.display !== 'flex';
    delResult.removedUi = !(document.getElementById('kb-list-container').textContent || '').includes('DELETE_SMOKE');
    delResult.removedApi = (await listCount('proj-7ec6f484')) === kb0;
    delResult.searchKept = (document.getElementById('kb-search').value || '') === 'DELETE_SMOKE';
  }
  // 清掉搜索词
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));

  // ===== 2) 聊天在途切项目（P2-2）=====
  await select('Trip旅游AI接线员');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send-btn');
  chatInput.value = '你好，请介绍一下停车收费。';
  chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  chatSend.click();
  await sleep(200); // LLM 在途
  await select('途牛热线');
  const bubblesOnTuniuEarly = bubbles();
  const sendBtnAfterSwitchEarly = !!document.getElementById('chat-send-btn') && document.getElementById('chat-send-btn').disabled;
  await sleep(12000); // 等旧请求返回
  const chatRace = {
    bubblesOnTuniu: bubbles(),
    strayBubble: bubbles() > 0,
    sendEnabled: !document.getElementById('chat-send-btn').disabled,
    earlyBubbles: bubblesOnTuniuEarly,
    chatReqs: S.chatReqs.length
  };

  // ===== 3) 批量回归运行中切项目（P2-1）=====
  const fileInput = document.getElementById('batch-file');
  const batchBtn = document.getElementById('batch-run-btn');
  const cases = [
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>您好，停车首小时8元，全天封顶50元。</speak>' },
    { user_query: '停车场在哪里？', standard_answer: '商场B1层，入口位于东侧。', bot_reply: '**停车场在B1层**\n- 入口位于东侧' },
    { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>老板您好，停车费首小时10元，全天封顶100元。</speak>' }
  ];
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify(cases)], 'race-batch.json', { type: 'application/json' }));
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);
  const errorsBeforeBatch = S.errors.length;
  batchBtn.click();
  await sleep(250); // 第 1 条 LLM 在途
  const selectableBtnDisabledDuring = fileInput.disabled || (Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('选择 JSON')) || {}).disabled;
  await select('Trip旅游AI接线员'); // 运行中切项目
  await sleep(10000);
  const batchRace = {
    errorsDelta: S.errors.length - errorsBeforeBatch,
    errors: S.errors.slice(errorsBeforeBatch),
    runBtnDisabled: document.getElementById('batch-run-btn').disabled,
    reportVisible: (() => { const r = document.getElementById('batch-report'); return !!r && getComputedStyle(r).display !== 'none' && r.innerText.trim().length > 10; })(),
    selectableBtnDisabledDuring: !!selectableBtnDisabledDuring,
    evalCalls: S.evalCalls
  };

  // ===== 4) KB 导入在途切项目（P2-3）=====
  await select('途牛热线');
  const kbTuniuBefore = await listCount('proj-7ec6f484');
  const kbTripBefore = await listCount('proj-597e1045');
  const importInput = document.getElementById('kb-import-files');
  const txt = '导入竞态测试问题？\n答：用于验证导入途中切项目不会串写。\n\n第二个导入竞态问题？\n答：第二段答案。\n';
  const dt2 = new DataTransfer();
  dt2.items.add(new File([txt], 'race-import.txt', { type: 'text/plain' }));
  importInput.files = dt2.files;
  importInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250); // 解析在途
  await select('Trip旅游AI接线员'); // 切项目
  await sleep(12000); // 等导入流程结束
  const raceImport = {
    tuniuBefore: kbTuniuBefore, tuniuAfter: await listCount('proj-7ec6f484'),
    tripBefore: kbTripBefore, tripAfter: await listCount('proj-597e1045'),
    parseCalls: S.parseCalls, saveCalls: S.saveCalls
  };
  raceImport.crossWrite = raceImport.tuniuAfter !== raceImport.tuniuBefore || raceImport.tripAfter !== raceImport.tripBefore;

  // ===== 5) 清理：删除竞态测试可能写入的条目 =====
  const cleanup = { deleted: [], remainingTuniu: 0 };
  const listRes = await fetch('/api/kb/list?token=' + token + '&project_id=proj-7ec6f484');
  const json = await listRes.json();
  for (const item of (json.data || [])) {
    const r = await fetch('/api/kb/delete?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
    cleanup.deleted.push((await r.json()).success === true);
  }
  cleanup.remainingTuniu = await listCount('proj-7ec6f484');

  // 收尾：选中 Trip
  await select('Trip旅游AI接线员');
  return {
    deleteKb: delResult,
    chatRace,
    batchRace,
    importRace: raceImport,
    cleanup,
    errors: S.errors.slice(0, 10),
    pass: delResult.found && delResult.modalOpened && delResult.red && delResult.closed && delResult.removedUi && delResult.removedApi && delResult.searchKept &&
      !chatRace.strayBubble && chatRace.sendEnabled &&
      batchRace.errorsDelta === 0 && !batchRace.runBtnDisabled &&
      !raceImport.crossWrite && cleanup.remainingTuniu === 0 && S.errors.length === 0
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));