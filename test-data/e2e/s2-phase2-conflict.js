// Sprint2 Lead E2E Phase 2：冲突检测 → 红色弹窗 + 内联横幅 → 关闭后无副作用
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const conflictBtn = document.getElementById('kb-conflict-btn') ||
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('冲突检测'));
  if (!conflictBtn) return { pass: false, fatal: '未找到冲突检测按钮' };
  conflictBtn.click();
  const modal = document.getElementById('global-modal');
  const shown = await waitUntil(() => modal && modal.style.display === 'flex', 10000);
  await sleep(300);
  const title = document.getElementById('modal-title');
  const msg = document.getElementById('modal-message');
  const confirmBtn = document.getElementById('modal-confirm-btn');
  const titleText = title ? title.innerText : '';
  const msgText = msg ? msg.innerText : '';
  const titleColor = title ? getComputedStyle(title).color : '';
  const btnBg = confirmBtn ? getComputedStyle(confirmBtn).backgroundColor : '';
  const banner = document.getElementById('kb-conflict-banner');
  const bannerVisible = banner && getComputedStyle(banner).display !== 'none' && banner.offsetHeight > 0;
  const bannerText = banner ? banner.innerText : '';
  const result = {
    shown: !!shown,
    titleText,
    msgText: msgText.slice(0, 500),
    titleColor,
    btnBg,
    hasQuestion: /停车怎么收费/.test(msgText),
    hasAnswerA: /首小时8元，全天封顶50元/.test(msgText),
    hasAnswerB: /每小时10元，无封顶/.test(msgText),
    bannerVisible: !!bannerVisible,
    bannerText: (bannerText || '').slice(0, 200),
    redTitle: /245, 108, 108/.test(titleColor) || /245, 108, 108/.test(btnBg),
    isModal: !!shown
  };
  // 关闭弹窗（点取消/知道了按钮）
  const cancelBtn = Array.from(document.querySelectorAll('#global-modal button')).find((b) => /取消|知道了|关闭/.test(b.textContent));
  if (cancelBtn) cancelBtn.click(); else window.closeModal();
  await waitUntil(() => modal.style.display !== 'flex', 5000);
  result.closedAfter = modal.style.display !== 'flex';
  // 无冲突场景：搜索过滤后... 直接对空项目（切到无 KB 项目）验证无冲突提示
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  // 先验证：当前项目仍有冲突；再验证关闭后其他 modal 功能未被破坏（打开创建项目弹窗再关闭）
  const createBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启新项目'));
  if (createBtn) {
    createBtn.click();
    await sleep(300);
    result.otherModalOpened = modal.style.display === 'flex';
    window.closeModal();
    await sleep(150);
    result.otherModalClosed = modal.style.display !== 'flex';
  }
  result.pass = !!(result.shown && result.hasQuestion && result.hasAnswerA && result.hasAnswerB && result.redTitle && result.bannerVisible && result.closedAfter && result.otherModalClosed !== false);
  return result;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));