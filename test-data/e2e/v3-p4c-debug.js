// Debug: Diff 左栏重建与旧快照文本的差异定位
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const snapId = list[0].id;
  const detail = await (await fetch('/api/snapshots/detail?id=' + snapId)).json();
  const oldText = String(detail.data.final_prompt_content || '');
  const row = document.querySelector('#snapshot-tbody tr');
  const btn = row ? Array.from(row.querySelectorAll('button')).find((b) => b.textContent.includes('对比当前')) : null;
  if (btn) btn.click();
  await waitUntil(() => document.querySelectorAll('#diff-body .diff-row').length > 0, 20000);
  await sleep(200);
  const cells = Array.from(document.querySelectorAll('#diff-body .diff-row')).map((r) => {
    const cs = Array.from(r.querySelectorAll('.diff-cell'));
    return { left: cs[0] ? cs[0].textContent : '', right: cs[1] ? cs[1].textContent : '', cls: cs.map((c) => c.className) };
  });
  const leftLines = cells.filter((r) => r.cls[0] && !r.cls[0].includes('empty')).map((r) => r.left);
  const joined = leftLines.join('\n');
  let idx = -1;
  for (let i = 0; i < Math.max(joined.length, oldText.length); i++) { if (joined[i] !== oldText[i]) { idx = i; break; } }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return {
    snapId,
    oldLen: oldText.length, joinedLen: joined.length,
    oldLines: oldText.split('\n').length, leftLines: leftLines.length,
    mismatchIndex: idx,
    oldCtx: idx >= 0 ? JSON.stringify(oldText.slice(Math.max(0, idx - 40), idx + 60)) : '',
    joinedCtx: idx >= 0 ? JSON.stringify(joined.slice(Math.max(0, idx - 40), idx + 60)) : '',
    oldHead: JSON.stringify(oldText.slice(0, 60)),
    joinedHead: JSON.stringify(joined.slice(0, 60)),
    rowKinds: cells.slice(0, 8).map((c) => ({ cls: c.cls, left: JSON.stringify(c.left).slice(0, 40) }))
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));