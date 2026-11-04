// Sprint3 Lead E2E Phase 1：Ctrl+S 生成快照 + 快照回滚写回编辑器
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const S = window.__s3 = window.__s3 || { errors: [], createReqs: [], createResps: [], detailResps: [], fetchPatched: false };
  if (!S.fetchPatched) {
    S.fetchPatched = true;
    window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      const res = await orig(url, opts);
      try {
        if (u.includes('/api/snapshots/create') && opts && opts.method === 'POST') {
          S.createReqs.push(JSON.parse(opts.body));
          S.createResps.push((await res.clone().json()));
        }
        if (u.includes('/api/snapshots/detail')) S.detailResps.push((await res.clone().json()));
      } catch (e) {}
      return res;
    };
  }
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  findTree('Trip旅游AI接线员').click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(900);

  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return el; };
  const marker = 'S3_ROLLBACK_TEST_' + Date.now();
  const l0 = marker + '_L0_PREFIX 行业={{industry}} <speak>您好</speak>';
  const l1 = marker + '_L1 语音基座要求';
  const l3 = marker + '_L3 项目话术 {{core_goal}}';
  setVal('val-L0', l0); setVal('val-L1', l1); setVal('val-L3', l3);
  await sleep(300);
  const rowsBefore = document.querySelectorAll('#snapshot-tbody tr').length;

  // Ctrl+S：派发可取消 keydown 并检查 defaultPrevented + 抓包
  const ev = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(ev);
  const prevented = ev.defaultPrevented;
  const created = await waitUntil(() => S.createResps.length > 0 && S.createResps[S.createResps.length - 1].success, 20000, 150);
  await sleep(1200); // 等 loadSnapshots 刷新表格
  const rowsAfter = document.querySelectorAll('#snapshot-tbody tr').length;
  const lastReq = S.createReqs[S.createReqs.length - 1] || {};
  const lastResp = S.createResps[S.createResps.length - 1] || {};
  const createLayers = lastReq.layers || [];
  const gotL0 = (createLayers.find((x) => x.layer === 'L0') || {}).content || '';

  // 回滚：先破坏编辑器内容，再点最新快照行「回滚」
  setVal('val-L0', 'BROKEN_L0'); setVal('val-L1', 'BROKEN_L1'); setVal('val-L3', 'BROKEN_L3');
  await sleep(200);
  const firstRow = document.querySelector('#snapshot-tbody tr');
  const rollbackBtn = firstRow ? Array.from(firstRow.querySelectorAll('button')).find((b) => b.textContent.includes('回滚')) : null;
  const rollbackFound = !!rollbackBtn;
  if (rollbackBtn) rollbackBtn.click();
  const detailOk = await waitUntil(() => S.detailResps.length > 0 && S.detailResps[S.detailResps.length - 1].success, 15000, 150);
  await sleep(500);
  const restored = {
    l0: document.getElementById('val-L0').value,
    l1: document.getElementById('val-L1').value,
    l3: document.getElementById('val-L3').value
  };
  const mirrorOk = (document.getElementById('mirror-L0').textContent || '').includes(marker);
  const statsChars = (document.getElementById('stats-chars') || {}).innerText;
  const expectedChars = String(restored.l0.length + restored.l1.length + restored.l3.length);
  const toastText = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  return {
    pass: !!created && prevented === true && createLayers.length === 3 && gotL0 === l0 &&
      rollbackFound && !!detailOk && restored.l0 === l0 && restored.l1 === l1 && restored.l3 === l3 &&
      mirrorOk && statsChars === expectedChars && /回滚/.test(toastText) && S.errors.length === 0,
    prevented,
    created: !!created,
    snapshotId: lastResp.snapshot_id || '',
    rowsBefore, rowsAfter,
    createLayersCount: createLayers.length,
    rollbackFound,
    detailOk: !!detailOk,
    restoredMatches: { l0: restored.l0 === l0, l1: restored.l1 === l1, l3: restored.l3 === l3 },
    restoredPreview: restored.l0.slice(0, 80),
    mirrorOk,
    statsChars, expectedChars,
    toastText: toastText.slice(0, 300),
    errors: S.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));