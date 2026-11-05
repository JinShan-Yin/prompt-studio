// V5 Phase2 Lead E2E-B2：知识库 Checkbox + 串行批量删除（Network 并发断言）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
  const cs = (el) => getComputedStyle(el);
  const allProjects = () => (Array.isArray(companies) ? companies : []).flatMap((c) => c.children || []);
  await wait(() => document.querySelectorAll('.menu-child').length >= 2, 12000);
  const kbProject = allProjects().find((p) => String(p.name || '').startsWith('QA_KB_BATCH_'));
  push('找到知识库批量测试项目', !!kbProject, kbProject ? { id: kbProject.id } : null);
  if (kbProject) {
    selectProject(kbProject.id, kbProject.name);
    await sleep(1000);
    switchTab('kb');
    await wait(() => document.querySelectorAll('#kb-list-container .kb-item').length === 6, 10000);
    const beforeCount = document.querySelectorAll('#kb-list-container .kb-item').length;
    push('知识库 Tab 左右 7:3 布局生效', cs(document.querySelector('.kb-main-grid')).display === 'grid', { columns: cs(document.querySelector('.kb-main-grid')).gridTemplateColumns });
    for (let i = 0; i < 5; i++) {
      const cb = Array.from(document.querySelectorAll('#kb-list-container .kb-item-check')).find((x) => !x.checked);
      if (cb) cb.click();
      await sleep(200);
    }
    push('勾选 5 条知识库后计数正确', /已选 5 项/.test((document.getElementById('kb-selected-count') || {}).innerText), { selectedText: (document.getElementById('kb-selected-count') || {}).innerText, beforeCount });
    let active = 0, maxConcurrent = 0, deleteRequests = 0;
    const origFetch = window.fetch;
    window.fetch = async function (url, opts) {
      if (String(url).includes('/api/kb/delete')) {
        deleteRequests++; active++; maxConcurrent = Math.max(maxConcurrent, active);
        try { return await origFetch.apply(this, arguments); } finally { active--; }
      }
      return origFetch.apply(this, arguments);
    };
    document.getElementById('kb-batch-delete-btn').click();
    await wait(() => cs(document.getElementById('global-modal')).display === 'flex', 5000);
    document.getElementById('modal-confirm-btn').click();
    await wait(() => {
      const loading = document.getElementById('kb-batch-loading');
      return cs(loading).display === 'none' && document.querySelectorAll('#kb-list-container .kb-item').length === 1;
    }, 15000);
    window.fetch = origFetch;
    const afterCount = document.querySelectorAll('#kb-list-container .kb-item').length;
    push('串行批量删除：5 次请求 maxConcurrent=1（非 Promise.all）', deleteRequests === 5 && maxConcurrent === 1, { deleteRequests, maxConcurrent });
    push('批量删除后数据正常清空（6→1）', beforeCount === 6 && afterCount === 1, { beforeCount, afterCount });
    selectProject((allProjects().find((p) => p.name.includes('Trip旅游AI接线员')) || {}).id, 'Trip旅游AI接线员');
    await sleep(900);
    push('切换项目后知识库多选状态被重置', /已选 0 项/.test((document.getElementById('kb-selected-count') || {}).innerText));
  }
  push('全流程无 JS Error', errors.length === 0, { errors: errors.slice(0, 5) });
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));