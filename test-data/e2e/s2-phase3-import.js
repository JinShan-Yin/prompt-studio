// Sprint2 Lead E2E Phase 3：批量导入 TXT（模拟真实 file input 上传 → /api/kb/parse → /api/kb/save）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 180000, interval = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const S = window.__s2;
  const input = document.getElementById('kb-import-files');
  if (!input) return { pass: false, fatal: '未找到 #kb-import-files 文件输入' };
  const txt1 = '停车怎么收费？\n答：首小时8元，全天封顶50元。商场会员可享9折优惠。\n\n停车场在哪里？\n答：停车场位于商场B1层，入口在东侧，共300个车位。\n\n会员卡如何办理？\n答：可在1层服务台办理，需携带身份证，消费可积分。\n';
  const txt2 = '营业时间是几点到几点？\n答：商场每天9:00-21:00营业，节假日正常营业。\n\n可以带宠物进入商场吗？\n答：除导盲犬等辅助犬外，商场内不允许携带宠物。\n';
  const dt = new DataTransfer();
  dt.items.add(new File([txt1], 'import-sample-1.txt', { type: 'text/plain' }));
  dt.items.add(new File([txt2], 'import-sample-2.txt', { type: 'text/plain' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const parseBefore = S.parseCalls; const saveBefore = S.saveCalls;
  // 等待「导入完成」状态或 toast，或列表计数增长
  const done = await waitUntil(() => {
    const st = document.getElementById('kb-import-status');
    const stText = st && getComputedStyle(st).display !== 'none' ? st.innerText : '';
    if (/导入完成|完成/.test(stText) && S.parseCalls >= parseBefore + 2) return true;
    const toast = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
    if (/导入完成|入库/.test(toast) && S.parseCalls >= parseBefore + 2) return true;
    return false;
  }, 180000, 400);
  await sleep(1500); // 等列表刷新
  const statusEl = document.getElementById('kb-import-status');
  const statusText = statusEl ? statusEl.innerText : '';
  const toastText = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  const listRes = await fetch('/api/kb/list?token=' + token + '&project_id=proj-7ec6f484');
  const listJson = await listRes.json();
  const after = Array.isArray(listJson.data) ? listJson.data : [];
  const newIds = after.filter((x) => !S.kbIdsBefore.includes(x.id)).map((x) => x.id);
  S.importedIds = newIds;
  const c = document.getElementById('kb-list-container');
  const visibleItemCount = c ? c.querySelectorAll('.kb-item').length : 0;
  return {
    pass: !!done && S.parseCalls >= parseBefore + 2 && S.saveCalls >= 1 && newIds.length >= 1,
    done: !!done,
    parseDelta: S.parseCalls - parseBefore,
    saveDelta: S.saveCalls - saveBefore,
    statusText,
    toastText,
    listAfter: after.length,
    listBefore: S.listBefore,
    newIds,
    visibleItemCount
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));