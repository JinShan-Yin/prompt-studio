// Sprint2 Lead E2E Phase 7d：KB 批量导入在途切项目（P2-3）真机复验 + 收尾清理
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 10000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const S = window.__s2r || (window.__s2r = { errors: [] });
  S.errors = S.errors || [];
  const listCount = async (pid) => { const r = await fetch('/api/kb/list?token=' + token + '&project_id=' + pid); const j = await r.json(); return Array.isArray(j.data) ? j.data.length : -1; };
  const select = async (name) => {
    findTree(name).click();
    await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 8000);
    await sleep(800);
  };
  await select('途牛热线');
  const tuniuBefore = await listCount('proj-7ec6f484');
  const tripBefore = await listCount('proj-597e1045');
  const importInput = document.getElementById('kb-import-files');
  const txt = '导入竞态测试问题？\n答：用于验证导入途中切项目不会串写。\n\n第二个导入竞态问题？\n答：第二段答案。\n';
  const dt = new DataTransfer();
  dt.items.add(new File([txt], 'race-import.txt', { type: 'text/plain' }));
  importInput.files = dt.files;
  importInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300); // 解析在途
  await select('Trip旅游AI接线员'); // 切项目
  await sleep(9000); // 等导入流程收尾
  const r = {
    tuniuBefore, tuniuAfter: await listCount('proj-7ec6f484'),
    tripBefore, tripAfter: await listCount('proj-597e1045'),
    toastText: Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|'),
    errors: S.errors.slice()
  };
  r.crossWrite = r.tuniuAfter !== r.tuniuBefore || r.tripAfter !== r.tripBefore;
  // 兜底清理途牛残留 + 页面回到 Trip 干净状态
  const left = await fetch('/api/kb/list?token=' + token + '&project_id=proj-7ec6f484');
  const leftJson = await left.json();
  let cleaned = 0;
  for (const item of (leftJson.data || [])) {
    const rr = await fetch('/api/kb/delete?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
    if ((await rr.json()).success === true) cleaned++;
  }
  r.cleaned = cleaned;
  r.tuniuFinal = await listCount('proj-7ec6f484');
  r.pass = !r.crossWrite && r.tuniuFinal === tuniuBefore && S.errors.length === 0;
  return r;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));