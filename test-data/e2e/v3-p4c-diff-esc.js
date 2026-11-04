// V3.0 阶段四 Lead E2E (c)：快照「对比当前」行级 Diff（左红/右绿、+− 统计、Esc 关闭）+ Esc 关闭模型弹窗
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = window.__v3p4c = { errors: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  findTree('Trip旅游AI接线员').click();
  await waitUntil(() => document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(1300);
  // 取最新快照，按快照层内容+改动写回编辑器，制造真实差异
  const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const snapId = list[0] && list[0].id;
  const detail = await (await fetch('/api/snapshots/detail?id=' + snapId)).json();
  const layers = (detail.data && detail.data.layers) || [];
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const byLayer = (L) => (layers.find((x) => x.layer === L) || {}).content || '';
  setVal('val-L0', byLayer('L0') + '\n【LeadE2E 新增行】');
  setVal('val-L1', byLayer('L1'));
  setVal('val-L3', byLayer('L3'));
  await sleep(600);
  // 点击首行「对比当前」
  const firstRow = document.querySelector('#snapshot-tbody tr');
  const diffBtn = firstRow ? Array.from(firstRow.querySelectorAll('button')).find((b) => b.textContent.includes('对比当前')) : null;
  const diffFound = !!diffBtn;
  if (diffBtn) diffBtn.click();
  const modal = document.getElementById('diff-modal');
  const opened = await waitUntil(() => modal && getComputedStyle(modal).display !== 'none' && modal.offsetHeight > 0, 20000);
  const rendered = await waitUntil(() => document.querySelectorAll('#diff-body .diff-cell').length > 2, 20000);
  await sleep(300);
  const statsText = (document.getElementById('diff-stats') || {}).innerText || '';
  const stats = { added: (statsText.match(/\+(\d+)/) || [])[1] || '', removed: (statsText.match(/-(\d+)/) || [])[1] || '', raw: statsText };
  const cells = Array.from(document.querySelectorAll('#diff-body .diff-row')).map((row) => {
    const cs = Array.from(row.querySelectorAll('.diff-cell'));
    const cls = cs.map((c) => c.className);
    return { left: cs[0] ? cs[0].textContent : '', right: cs[1] ? cs[1].textContent : '', cls };
  });
  const removedCount = cells.filter((r) => r.cls[0] && r.cls[0].includes('removed')).length;
  const addedCount = cells.filter((r) => r.cls[1] && r.cls[1].includes('added')).length;
  const sameCount = cells.filter((r) => r.cls[0] && r.cls[0].includes('same')).length;
  // 行级验证：左栏（same+removed 的非空文本单元）拼接应逐字等于旧快照 prompt；右栏同理
  // 注意：空行在 Diff 单元格中以 &nbsp; 占位显示，重建文本时还原为空行
  const cellText = (t) => (t === '\u00A0' || t === ' ' ? '' : t);
  const leftLines = cells.filter((r) => r.cls[0] && !r.cls[0].includes('empty')).map((r) => cellText(r.left));
  const rightLines = cells.filter((r) => r.cls[1] && !r.cls[1].includes('empty')).map((r) => cellText(r.right));
  const oldPrompt = String(detail.data.final_prompt_content || '').replace(/\r/g, '');
  const newPrompt = ((await (await fetch('/api/prompt/assemble', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: 'proj-597e1045', layers: ['L0', 'L1', 'L3'].map((L, i) => ({ layer: L, name: ['全局安全', '语音基座', '项目话术'][i], content: document.getElementById('val-' + L).value })), context_data: (window.getContextDataForSnapshot ? window.getContextDataForSnapshot() : {}) }) })).json()).final_prompt || '').replace(/\r/g, '');
  const leftMatch = leftLines.join('\n') === oldPrompt;
  const rightMatch = rightLines.join('\n') === newPrompt;
  const addedDisplayed = String(addedCount) === stats.added;
  const removedDisplayed = String(removedCount) === stats.removed;
  // Esc 关闭 Diff
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const closed = await waitUntil(() => !modal || getComputedStyle(modal).display === 'none' || modal.offsetHeight === 0, 6000);
  // Esc 关闭模型配置中心
  document.getElementById('api-key-btn').click();
  const mm = document.getElementById('model-config-modal');
  const mOpened = await waitUntil(() => mm && getComputedStyle(mm).display !== 'none' && mm.offsetHeight > 0, 8000);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const mClosed = await waitUntil(() => !mm || getComputedStyle(mm).display === 'none' || mm.offsetHeight === 0, 6000);
  return {
    pass: !!(diffFound && opened && rendered && addedCount >= 1 && removedCount >= 1 && sameCount >= 1 && leftMatch && rightMatch && addedDisplayed && removedDisplayed && closed && mOpened && mClosed && S.errors.length === 0),
    diff: { diffFound, opened: !!opened, rendered: !!rendered, stats, addedCount, removedCount, sameCount, addedDisplayed, removedDisplayed, leftMatch, rightMatch, closed: !!closed },
    escModel: { opened: !!mOpened, closed: !!mClosed },
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));