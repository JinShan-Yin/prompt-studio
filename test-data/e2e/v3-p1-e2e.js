// V3.0 阶段一 E2E：3000 端口纯 Node 应用 —— 页面加载/项目 CRUD/快照/无 token 校验
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = { errors: [], nonOk: [], fetchUrls: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url || '');
    S.fetchUrls.push(u);
    const res = await origFetch(url, opts);
    if (!res.ok) S.nonOk.push({ url: u, status: res.status });
    return res;
  };
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const treeCompanies = () => document.querySelectorAll('.menu-parent').length;
  // 1) 页面加载 + 树数据
  await waitUntil(() => document.querySelectorAll('.menu-parent').length >= 1 && document.querySelectorAll('.menu-child').length >= 1, 20000);
  const loaded = { companies: treeCompanies(), projects: document.querySelectorAll('.menu-child').length, title: document.title };
  // 2) 选中项目 → KB/语境加载
  findTree('Trip旅游AI接线员').click();
  const shown = await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(1600);
  const kbText = (document.getElementById('kb-list-container') || {}).innerText || '';
  const kbCount = (document.getElementById('kb-count') || {}).innerText || '';
  const ctx = (document.getElementById('ctx-industry') || {}).value || '';
  // 3) 生成快照（按钮）
  const rowsBefore = document.querySelectorAll('#snapshot-tbody tr').length;
  const genBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照'));
  if (genBtn) genBtn.click();
  const snapOk = await waitUntil(() => document.querySelectorAll('#snapshot-tbody tr').length > rowsBefore, 20000);
  const rowsAfter = document.querySelectorAll('#snapshot-tbody tr').length;
  // 4) CRUD：新建项目（UI）
  const createBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('开启新项目'));
  createBtn.click();
  const modal = document.getElementById('global-modal');
  await waitUntil(() => modal.style.display === 'flex', 8000);
  await sleep(300);
  const nameInput = document.getElementById('modal-input');
  const TEST_NAME = 'V3临时项目_' + Date.now();
  nameInput.value = TEST_NAME;
  const companySelect = document.getElementById('modal-company-select');
  if (companySelect && companySelect.options.length > 0) companySelect.selectedIndex = 0;
  document.getElementById('modal-confirm-btn').click();
  const created = await waitUntil(() => findTree(TEST_NAME), 15000);
  await sleep(600);
  // 5) 重命名（UI）
  const newNode = findTree(TEST_NAME);
  let renameOk = false, renamedName = TEST_NAME + '_改名';
  if (newNode) {
    const more = newNode.querySelector('.more-btn');
    more.click();
    const menu = await waitUntil(() => {
      const dd = document.getElementById('global-dropdown');
      return dd && getComputedStyle(dd).display === 'block' ? dd : null;
    }, 5000);
    const ren = menu ? [...menu.querySelectorAll('.dropdown-item')].find((el) => /重命名/.test(el.textContent)) : null;
    if (ren) ren.click();
    await waitUntil(() => modal.style.display === 'flex', 5000);
    await sleep(250);
    document.getElementById('modal-input').value = renamedName;
    document.getElementById('modal-confirm-btn').click();
    renameOk = !!(await waitUntil(() => findTree(renamedName), 15000));
    await sleep(600);
  }
  // 6) 删除（UI，需二次确认）
  let deleteOk = false;
  const renamedNode = findTree(renamedName);
  if (renamedNode) {
    renamedNode.querySelector('.more-btn').click();
    const menu2 = await waitUntil(() => {
      const dd = document.getElementById('global-dropdown');
      return dd && getComputedStyle(dd).display === 'block' ? dd : null;
    }, 5000);
    const del = menu2 ? [...menu2.querySelectorAll('.dropdown-item')].find((el) => /删除/.test(el.textContent)) : null;
    if (del) del.click();
    await waitUntil(() => modal.style.display === 'flex', 5000);
    await sleep(250);
    const confirm = document.getElementById('modal-confirm-btn');
    if (confirm) confirm.click();
    deleteOk = !!(await waitUntil(() => !findTree(renamedName), 15000));
    await sleep(800);
    // 关闭可能残留的 modal
    if (modal.style.display === 'flex' && window.closeModal) window.closeModal();
  }
  // 7) 无 token 校验：所有 /api fetch URL 不含 token
  const apiUrls = S.fetchUrls.filter((u) => u.includes('/api/'));
  const tokenLeaks = apiUrls.filter((u) => /[?&]token=/.test(u));
  const pageUrl = location.href;
  return {
    pass: loaded.companies >= 1 && loaded.projects >= 1 && !!shown && kbText.includes('Q:') && /共 97 条/.test(kbCount) && !!ctx &&
      !!snapOk && rowsAfter > rowsBefore && !!created && renameOk && deleteOk &&
      tokenLeaks.length === 0 && S.nonOk.length === 0 && S.errors.length === 0 && /^http:\/\/127\.0\.0\.1:3000\//.test(pageUrl),
    loaded, shown: !!shown, kb: { hasQ: kbText.includes('Q:'), count: kbCount }, ctxIndustry: ctx,
    snapshots: { rowsBefore, rowsAfter }, crud: { created: !!created, renameOk, deleteOk, renamedName },
    apiCallCount: apiUrls.length, tokenLeaks, nonOk: S.nonOk.slice(0, 10), pageUrl,
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));