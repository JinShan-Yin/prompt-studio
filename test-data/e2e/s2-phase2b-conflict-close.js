// Sprint2 Lead E2E Phase 2b：关闭冲突弹窗 + 样式复位 + 既有 modal 不受污染
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 10000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const modal = document.getElementById('global-modal');
  const title = document.getElementById('modal-title');
  const msg = document.getElementById('modal-message');
  const confirmBtn = document.getElementById('modal-confirm-btn');
  const cancelBtn = Array.from(document.querySelectorAll('#global-modal button')).find((b) => /取消|知道了|关闭/.test(b.textContent));
  if (cancelBtn) cancelBtn.click(); else if (window.closeModal) window.closeModal();
  await waitUntil(() => modal.style.display !== 'flex', 5000);
  await sleep(150);
  const closedAfter = modal.style.display !== 'flex';
  const titleColorAfter = getComputedStyle(title).color;
  const btnBgAfter = getComputedStyle(confirmBtn).backgroundColor;
  // 复用既有「开启新项目」modal 验证不被污染
  const createBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启新项目'));
  let otherOpened = false, otherClosed = false;
  if (createBtn) {
    createBtn.click();
    await waitUntil(() => modal.style.display === 'flex', 5000);
    otherOpened = modal.style.display === 'flex';
    if (window.closeModal) window.closeModal();
    await waitUntil(() => modal.style.display !== 'flex', 5000);
    otherClosed = modal.style.display !== 'flex';
  }
  return {
    pass: closedAfter && otherOpened && otherClosed && !/245, 108, 108/.test(titleColorAfter),
    closedAfter, titleColorAfter, btnBgAfter, otherOpened, otherClosed,
    modalTitleAfter: title.innerText
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));