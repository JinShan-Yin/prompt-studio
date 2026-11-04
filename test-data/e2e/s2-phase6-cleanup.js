// Sprint2 Lead E2E Phase 6：清理注入数据 + Sprint1 回归抽查 + 最终状态
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const S = window.__s2;

  // -------- 清理：删除所有本测试注入的 KB 条目 --------
  const listNow = async (pid) => {
    const r = await fetch('/api/kb/list?token=' + token + '&project_id=' + pid);
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  };
  const before = await listNow('proj-7ec6f484');
  const injected = before.filter((x) => !S.kbIdsBefore.includes(x.id));
  const deleteResults = [];
  for (const item of injected) {
    try {
      const r = await fetch('/api/kb/delete?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id })
      });
      deleteResults.push((await r.json()).success === true);
    } catch (e) { deleteResults.push(false); }
  }
  const afterDelete = await listNow('proj-7ec6f484');

  // 切到 Trip 恢复演示语境
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const trip = findTree('Trip旅游AI接线员');
  if (trip) trip.click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(800);

  const restoreCtx = { industry: '旅游行业', business_scene: ['售后退换货', '停车缴费'], core_goal: ['安抚客户情绪', '准确提供价格'] };
  let ctxRestored = false;
  try {
    const r = await fetch('/api/context/save?token=' + token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-597e1045', context_data: restoreCtx })
    });
    ctxRestored = (await r.json()).success === true;
  } catch (e) {}
  if (window.loadProjectContext) await window.loadProjectContext('proj-597e1045');
  ['val-L0', 'val-L1', 'val-L3'].forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  await sleep(500);

  // -------- Sprint1 回归抽查 --------
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  const demo = '你好，{{industry}} 领域的助手。\n<speak>您好</speak>';
  ta.value = demo;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  const expectedChars = demo.length;
  const expectedTokens = Math.ceil(expectedChars * 0.6);
  const stats = { chars: document.getElementById('stats-chars').innerText, tokens: document.getElementById('stats-tokens').innerText, expectedChars, expectedTokens };
  const spans = mirror.querySelectorAll('span').length;
  const spanColor = spans ? getComputedStyle(mirror.querySelector('span')).color : '';
  const speakOk = ta.value.includes('<speak>') && !mirror.querySelector('speak');
  const heights = { ta: ta.clientHeight, mirror: mirror.clientHeight, diff: Math.abs(ta.clientHeight - mirror.clientHeight) };
  const ctxInd = document.getElementById('ctx-industry');
  const ctxLoaded = !!ctxInd && ctxInd.value === '旅游行业';
  // 清空演示文本，回到干净状态
  ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  const statsCleared = document.getElementById('stats-chars').innerText === '0';

  return {
    kb: { before: before.length, injected: injected.length, afterDelete: afterDelete.length, kbIdsBefore: S.kbIdsBefore.length, deleteAllOk: deleteResults.every(Boolean) },
    ctx: { restored: ctxRestored, uiLoaded: !!ctxLoaded },
    sprint1: { stats, spans, spanColor, speakOk, heights, statsCleared, orange: spanColor === 'rgb(245, 158, 11)' },
    errors: S.errors.slice(0, 10)
  };
});
out.pass = !!(
  out.kb.afterDelete === out.kb.kbIdsBefore &&
  out.kb.deleteAllOk &&
  out.ctx.restored &&
  out.ctx.uiLoaded &&
  out.sprint1.orange &&
  out.sprint1.spans >= 1 &&
  out.sprint1.speakOk &&
  out.sprint1.heights.diff <= 1 &&
  out.sprint1.stats.chars === String(out.sprint1.stats.expectedChars) &&
  out.sprint1.stats.tokens === String(out.sprint1.stats.expectedTokens) &&
  out.sprint1.statsCleared &&
  out.errors.length === 0
);
console.log('@@DSH_RESULT@@' + JSON.stringify(out));