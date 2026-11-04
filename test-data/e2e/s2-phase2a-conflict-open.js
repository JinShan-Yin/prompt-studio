// Sprint2 Lead E2E Phase 2a：冲突检测 → 红色弹窗 + 内联横幅（弹窗保持打开供截图）
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
  await sleep(350);
  const title = document.getElementById('modal-title');
  const msg = document.getElementById('modal-message');
  const confirmBtn = document.getElementById('modal-confirm-btn');
  const titleText = title ? title.innerText : '';
  const msgText = msg ? msg.innerText : '';
  const titleColor = title ? getComputedStyle(title).color : '';
  const btnBg = confirmBtn ? getComputedStyle(confirmBtn).backgroundColor : '';
  const banner = document.getElementById('kb-banner') || document.getElementById('kb-conflict-banner');
  const bannerVisible = !!(banner && getComputedStyle(banner).display !== 'none' && banner.offsetHeight > 0);
  const bannerText = banner ? banner.innerText : '';
  return {
    pass: !!(shown && /停车怎么收费/.test(msgText) && /首小时8元，全天封顶50元/.test(msgText) && /每小时10元，无封顶/.test(msgText) && (/245, 108, 108/.test(titleColor) || /245, 108, 108/.test(btnBg)) && bannerVisible),
    shown: !!shown, titleText, msgText: msgText.slice(0, 600), titleColor, btnBg,
    hasQuestion: /停车怎么收费/.test(msgText), hasAnswerA: /首小时8元，全天封顶50元/.test(msgText), hasAnswerB: /每小时10元，无封顶/.test(msgText),
    bannerVisible, bannerText: (bannerText || '').slice(0, 200),
    red: /245, 108, 108/.test(titleColor) || /245, 108, 108/.test(btnBg)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));