// Sprint2 Lead E2E Phase 7a：deleteKb 页面删除真机验证（#global-modal 红色确认）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 10000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const listCount = async (pid) => { const r = await fetch('/api/kb/list?token=' + token + '&project_id=' + pid); const j = await r.json(); return Array.isArray(j.data) ? j.data.length : -1; };
  if (!window.__s2r) window.__s2r = { errors: [] };
  const S = window.__s2r;
  S.errors = S.errors || [];
  if (!S.errHooked) {
    S.errHooked = true;
    window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  }
  findTree('途牛热线').click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 8000);
  await sleep(800);
  const kb0 = await listCount('proj-7ec6f484');
  await fetch('/api/kb/save?token=' + token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: 'proj-7ec6f484', pairs: [{ question: 'DELETE_SMOKE_临时删除条目', answer: '用于验证页内删除弹窗' }] })
  });
  const refreshBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('刷新列表'));
  if (refreshBtn) refreshBtn.click();
  await waitUntil(() => (document.getElementById('kb-list-container') || {}).textContent && document.getElementById('kb-list-container').textContent.includes('DELETE_SMOKE'), 10000);
  const search = document.getElementById('kb-search');
  search.value = 'DELETE_SMOKE'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  const delBtn = Array.from(document.querySelectorAll('#kb-list-container button')).find((b) => b.textContent.includes('删除'));
  const modal = document.getElementById('global-modal');
  const r = { found: !!delBtn, modalOpened: false, titleText: '', red: false, closed: false, removedUi: false, removedApi: false, searchKept: false, kb0 };
  if (delBtn) {
    delBtn.click();
    r.modalOpened = !!(await waitUntil(() => modal.style.display === 'flex', 8000));
    await sleep(250);
    const title = document.getElementById('modal-title');
    const confirmBtn = document.getElementById('modal-confirm-btn');
    r.titleText = title ? title.innerText : '';
    r.red = /245, 108, 108/.test(getComputedStyle(confirmBtn).backgroundColor);
    const okBtn = Array.from(document.querySelectorAll('#global-modal button')).find((b) => /确定|确认/.test(b.textContent));
    if (okBtn) okBtn.click();
    await waitUntil(() => modal.style.display !== 'flex', 8000);
    await sleep(1200);
    r.closed = modal.style.display !== 'flex';
    r.removedUi = !(document.getElementById('kb-list-container').textContent || '').includes('DELETE_SMOKE');
    r.removedApi = (await listCount('proj-7ec6f484')) === kb0;
    r.searchKept = (document.getElementById('kb-search').value || '') === 'DELETE_SMOKE';
  }
  // 清理兜底：若 UI 删除失败则 API 删除残留
  const left = await fetch('/api/kb/list?token=' + token + '&project_id=proj-7ec6f484');
  const leftJson = await left.json();
  let leftoverDeleted = false;
  for (const item of (leftJson.data || [])) {
    if (String(item.question || '').includes('DELETE_SMOKE')) {
      const rr = await fetch('/api/kb/delete?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
      leftoverDeleted = (await rr.json()).success === true || leftoverDeleted;
    }
  }
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  r.leftoverDeleted = leftoverDeleted;
  r.kbAfter = await listCount('proj-7ec6f484');
  r.pass = r.found && r.modalOpened && r.red && r.closed && r.removedUi && r.removedApi && r.searchKept && r.kbAfter === kb0 && S.errors.length === 0;
  return r;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));