// V3.0 阶段四 Lead E2E (a)：左侧树搜索 + KB 在线编辑 + Esc 关闭全局弹窗
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
  const input = document.getElementById('tree-search');
  const visibleProjects = () => Array.from(document.querySelectorAll('.menu-child')).map((e) => e.textContent.trim());
  // 1) 树搜索
  input.value = '途牛'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(350);
  const search1 = { projects: visibleProjects(), companies: Array.from(document.querySelectorAll('.menu-parent')).map((e) => e.textContent.trim()) };
  input.value = '不存在xyz'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(350);
  const treeContainerText = (document.getElementById('tree-container') || {}).innerText || '';
  const noMatch = /无匹配项目/.test(treeContainerText);
  input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(350);
  const restored = visibleProjects().length;
  // 2) KB 在线编辑（修改→保存→回读→还原）
  const trip = findTree('Trip旅游AI接线员');
  if (trip) trip.click();
  await waitUntil(() => document.getElementById('main-content').style.display === 'block', 8000);
  await sleep(1400);
  const listRes = await fetch('/api/kb/list?project_id=proj-597e1045');
  const kbList = (await listRes.json()).data || [];
  const target = kbList[0];
  const originQ = target.question, originA = target.answer;
  const editBtn = Array.from(document.querySelectorAll('#kb-list-container button')).find((b) => b.textContent.trim() === '编辑');
  let modalOpened = false, prefillOk = false, savedOk = false, persisted = false, revertedOk = false, closed = false;
  if (editBtn) {
    editBtn.click();
    const modal = document.getElementById('kb-edit-modal');
    modalOpened = !!(await waitUntil(() => modal && getComputedStyle(modal).display !== 'none' && modal.offsetHeight > 0, 8000));
    await sleep(300);
    const qEl = document.getElementById('kb-edit-question');
    const aEl = document.getElementById('kb-edit-answer');
    prefillOk = qEl.value === originQ && aEl.value === originA;
    const marker = '【LeadE2E编辑】';
    qEl.value = originQ + marker;
    aEl.value = originA + marker;
    document.getElementById('kb-edit-save-btn').click();
    savedOk = !!(await waitUntil(() => !modal || getComputedStyle(modal).display === 'none', 12000));
    await sleep(800);
    const after = (await (await fetch('/api/kb/list?project_id=proj-597e1045')).json()).data || [];
    const row = after.find((x) => x.id === target.id);
    persisted = !!(row && row.question.includes(marker) && row.answer.includes(marker));
    // 还原
    const rev = await fetch('/api/kb/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: target.id, question: originQ, answer: originA }) });
    revertedOk = (await rev.json()).success === true;
    // 刷新列表
    const refresh = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('刷新列表'));
    if (refresh) refresh.click();
  }
  // 3) Esc 关闭全局 modal：打开「开启新项目」再 Esc
  const createBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启新项目'));
  const gModal = document.getElementById('global-modal');
  createBtn.click();
  const gOpened = await waitUntil(() => gModal.style.display === 'flex', 5000);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const gClosed = await waitUntil(() => gModal.style.display !== 'flex', 5000);
  return {
    pass: !!S && search1.projects.length === 1 && search1.projects[0].includes('途牛热线') && search1.companies.length === 1 && noMatch && restored >= 2 &&
      modalOpened && prefillOk && savedOk && persisted && revertedOk && !!gOpened && !!gClosed && S.errors.length === 0,
    treeSearch: { search1, noMatch, restored },
    kbEdit: { modalOpened, prefillOk, savedOk, persisted, revertedOk },
    escGlobal: { opened: !!gOpened, closed: !!gClosed },
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));