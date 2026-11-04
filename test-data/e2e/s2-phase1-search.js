// Sprint2 Lead E2E Phase 1：项目选择 + 注入确定性 KB 数据 + 实时搜索验证
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  await waitUntil(() => document.querySelectorAll('.menu-child').length >= 2, 20000);
  const node = findTree('途牛热线');
  if (!node) return { pass: false, fatal: '左侧树未找到「途牛热线」节点' };
  node.click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 15000);
  await sleep(900);

  window.__s2 = window.__s2 || { kbIdsBefore: [], chatReqs: [], evalCalls: 0, parseCalls: 0, saveCalls: 0, errors: [] };
  const S = window.__s2;
  if (!S.fetchPatched) {
    S.fetchPatched = true;
    window.addEventListener('error', (e) => S.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandledrejection: ' + String(e.reason)));
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      const b = opts && opts.body;
      try {
        if (u.includes('/api/chat/reply')) S.chatReqs.push(JSON.parse(b));
        if (u.includes('/api/eval/run')) S.evalCalls++;
        if (u.includes('/api/kb/parse')) S.parseCalls++;
        if (u.includes('/api/kb/save')) S.saveCalls++;
      } catch (e) {}
      return orig(url, opts);
    };
  }

  const listNow = async () => {
    const r = await fetch('/api/kb/list?token=' + token + '&project_id=proj-7ec6f484');
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  };
  const before = await listNow();
  S.kbIdsBefore = before.map((x) => x.id);
  S.listBefore = before.length;

  const seed = [
    { question: '停车怎么收费？', answer: '首小时8元，全天封顶50元。' },
    { question: '停车怎么收费？', answer: '每小时10元，无封顶。' },
    { question: '停车怎么收费', answer: '首小时8元，全天封顶50元。' },
    { question: '营业时间是几点？', answer: '每天9:00-21:00。' },
    { question: 'SMOKE_SEARCH_UNIQUE 如何办理会员？', answer: '可在1层服务台办理，消费可积分。' },
    { question: 'XSS测试 <img src=x onerror=window.__kbxss=1>', answer: '<b>加粗答案</b>' }
  ];
  const saveRes = await fetch('/api/kb/save?token=' + token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: 'proj-7ec6f484', pairs: seed })
  });
  const saveJson = await saveRes.json();

  // 点击页面「刷新列表」按钮走真实 UI 刷新
  const refreshBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('刷新列表'));
  if (refreshBtn) refreshBtn.click();
  const container = () => document.getElementById('kb-list-container');
  const itemCount = () => {
    const c = container();
    if (!c) return 0;
    const byClass = c.querySelectorAll('.kb-item').length;
    return byClass > 0 ? byClass : (c.textContent.match(/Q[:：]/g) || []).length;
  };
  await waitUntil(() => itemCount() >= 6, 12000);
  const countText = () => (document.getElementById('kb-count') ? document.getElementById('kb-count').innerText : '');
  const baseCountText = countText();
  const baseCount = itemCount();

  const search = document.getElementById('kb-search');
  if (!search) return { pass: false, fatal: '未找到 #kb-search 搜索框', seeded: saveJson };
  const setSearch = (v) => { search.value = v; search.dispatchEvent(new Event('input', { bubbles: true })); };

  setSearch('停车怎么收费'); await sleep(150);
  const matchConflict = itemCount(); const t1 = countText();
  setSearch('SMOKE_SEARCH_UNIQUE'); await sleep(150);
  const matchUnique = itemCount();
  setSearch('zzz_no_match_999'); await sleep(150);
  const matchNone = itemCount(); const emptyText = container() ? container().textContent : '';
  setSearch(''); await sleep(150);
  const matchAll = itemCount();
  const hasImg = !!document.querySelector('#kb-list-container img');
  const hasBold = !!document.querySelector('#kb-list-container b');
  // 搜索"答案"里的关键字（测试 answer 也参与匹配）
  setSearch('服务台'); await sleep(150);
  const matchAnswer = itemCount();
  setSearch('停车'); await sleep(200); // 留一个过滤态供截图

  return {
    pass: saveJson.success === true && baseCount === 6 && matchConflict === 3 && matchUnique === 1 && matchNone === 0 && matchAll === 6 && matchAnswer === 1 && !hasImg && !hasBold && !window.__kbxss,
    seedResult: saveJson,
    baseCount, baseCountText, matchConflict, t1, matchUnique, matchNone, matchAll, matchAnswer,
    countTexts: { t1, now: countText() },
    emptyText: (emptyText || '').slice(0, 80),
    xss: { hasImg, hasBold, flag: window.__kbxss },
    projectId: 'proj-7ec6f484'
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));