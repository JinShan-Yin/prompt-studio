// 打开 Diff 弹窗供截图（截图后 Esc 关闭）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  // 制造有增删的编辑器内容（基于最新快照）
  const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const detail = await (await fetch('/api/snapshots/detail?id=' + list[0].id)).json();
  const layers = detail.data.layers || [];
  const byLayer = (L) => (layers.find((x) => x.layer === L) || {}).content || '';
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  setVal('val-L0', byLayer('L0') + '\n【LeadE2E 新增行 1】\n【LeadE2E 新增行 2】');
  setVal('val-L1', byLayer('L1'));
  setVal('val-L3', byLayer('L3'));
  await sleep(500);
  const row = document.querySelector('#snapshot-tbody tr');
  const btn = row ? Array.from(row.querySelectorAll('button')).find((b) => b.textContent.includes('对比当前')) : null;
  if (btn) btn.click();
  await waitUntil(() => document.querySelectorAll('#diff-body .diff-row').length > 0, 20000);
  await sleep(400);
  return {
    opened: getComputedStyle(document.getElementById('diff-modal')).display !== 'none',
    stats: (document.getElementById('diff-stats') || {}).innerText,
    addedCells: document.querySelectorAll('#diff-body .diff-cell.added').length,
    removedCells: document.querySelectorAll('#diff-body .diff-cell.removed').length
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));