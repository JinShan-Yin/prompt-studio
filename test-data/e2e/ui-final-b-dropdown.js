// 极简风验收 B：最底部 "..." 下拉菜单绝对浮于卡片之上（不被遮挡）
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
  const tree = document.getElementById('tree-container');
  tree.scrollTop = tree.scrollHeight; // 滚到最底部
  await sleep(300);
  const nodes = Array.from(document.querySelectorAll('.menu-child'));
  const lastNode = nodes[nodes.length - 1];
  const moreBtn = lastNode ? lastNode.querySelector('.more-btn') : null;
  moreBtn.click();
  const dd = document.getElementById('global-dropdown');
  const shown = await waitUntil(() => dd && getComputedStyle(dd).display === 'block' && dd.offsetHeight > 0, 8000);
  await sleep(250);
  const r = dd.getBoundingClientRect();
  const cx = Math.min(r.right - 10, Math.max(r.left + 10, (r.left + r.right) / 2));
  const cy = Math.min(r.bottom - 10, Math.max(r.top + 10, (r.top + r.bottom) / 2));
  const topEl = document.elementFromPoint(cx, cy);
  const inDropdown = !!(topEl && topEl.closest && topEl.closest('#global-dropdown'));
  // 与卡片对比：卡片 z-index 应为 auto/0，dropdown 9990
  const card = document.querySelector('.card');
  const cs = (el) => getComputedStyle(el);
  const zCheck = { dropdownZ: cs(dd).zIndex, cardZ: cs(card).zIndex, dropdownAboveCard: Number(cs(dd).zIndex) > Number(cs(card).zIndex || 0) };
  return {
    pass: !!shown && inDropdown && zCheck.dropdownAboveCard && r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && S.errors.length === 0,
    shown: !!shown, rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
    topElTag: topEl ? topEl.tagName : null, topElClass: topEl ? topEl.className : null, inDropdown, zCheck,
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));