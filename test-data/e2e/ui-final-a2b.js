// 极简风验收 A2（修正）：省略号 / 引导线 / 配色 / pre / 焦点光晕
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = { errors: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  await waitUntil(() => document.querySelectorAll('.menu-child').length >= 2, 20000);
  const cs = (el) => getComputedStyle(el);
  const longNode = Array.from(document.querySelectorAll('.menu-child')).find((e) => (e.textContent || '').includes('LEAD_UI_长名'));
  const nameSpan = longNode ? longNode.querySelector('span') : null;
  const sidebar = document.querySelector('.sidebar');
  const sidebarRect = sidebar.getBoundingClientRect();
  const overflow = longNode && nameSpan ? {
    found: true,
    textContentLen: nameSpan.textContent.length,
    clientWidth: nameSpan.clientWidth,
    scrollWidth: nameSpan.scrollWidth,
    truncated: nameSpan.scrollWidth > nameSpan.clientWidth,
    textOverflow: cs(nameSpan).textOverflow,
    whiteSpace: cs(nameSpan).whiteSpace,
    overflowHidden: cs(nameSpan).overflow,
    nodeRight: Math.round(longNode.getBoundingClientRect().right),
    sidebarRight: Math.round(sidebarRect.right),
    sidebarWidth: Math.round(sidebarRect.width),
    fitsSidebar: longNode.getBoundingClientRect().right <= sidebarRect.right + 1
  } : { found: false };
  const guide = longNode ? {
    borderLeftWidth: cs(longNode).borderLeftWidth,
    borderLeftColor: cs(longNode).borderLeftColor,
    borderLeftStyle: cs(longNode).borderLeftStyle,
    marginLeft: cs(longNode).marginLeft
  } : null;
  // 临时 pre 验证浅灰样式
  const tempPre = document.createElement('pre'); tempPre.textContent = 'pre test'; document.body.appendChild(tempPre);
  const tmp = cs(tempPre);
  const preStyle = { bg: tmp.backgroundColor, color: tmp.color, borderTopWidth: tmp.borderTopWidth, borderTopColor: tmp.borderTopColor };
  tempPre.remove();
  const bodyBg = cs(document.body).backgroundColor;
  const sidebarBg = cs(sidebar).backgroundColor;
  const cardBg = cs(document.querySelector('.card')).backgroundColor;
  const z = {
    dropdown: cs(document.getElementById('global-dropdown')).zIndex,
    modal: cs(document.getElementById('global-modal')).zIndex,
    modelModal: cs(document.getElementById('model-config-modal')).zIndex
  };
  // CSS 规则检查
  let cssText = '';
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try { for (const rule of Array.from(sheet.cssRules || [])) cssText += ' ' + (rule.selectorText || '') + '{' + (rule.style ? rule.style.cssText : '') + '}'; } catch (e) {}
    }
  } catch (e) {}
  const cssChecks = {
    scrollbarWidth: /::-webkit-scrollbar\{[^}]*width:\s*6px/.test(cssText) || /::-webkit-scrollbar[^{]*\{[^}]*width:\s*6px/.test(cssText),
    thumbColors: /rgb\(203,\s*213,\s*225\)|#cbd5e1/.test(cssText) && /rgb\(148,\s*163,\s*184\)|#94a3b8/.test(cssText),
    toastZ: /z-index:\s*10000/.test(cssText),
    transitionAll: cssText.includes('0.2s ease-in-out')
  };
  // 选中项目 → 聚焦行业输入框（页面已由 runner bringToFront，具备 :focus）
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => (e.textContent || '').includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await waitUntil(() => getComputedStyle(document.getElementById('main-content')).display !== 'none', 10000);
  await sleep(1400);
  const input = document.getElementById('ctx-industry');
  input.focus();
  await sleep(250);
  const ics = cs(input);
  const focusStyle = {
    hasFocus: document.hasFocus(),
    active: document.activeElement === input,
    matches: input.matches(':focus'),
    outlineStyle: ics.outlineStyle,
    borderColor: ics.borderTopColor,
    boxShadow: ics.boxShadow,
    hasBlueBorder: ics.borderTopColor === 'rgb(77, 107, 254)',
    hasSoftGlow: /rgba\(77, 107, 254, 0\.15\)/.test(ics.boxShadow)
  };
  // 滚动到语境卡片让截图可见
  const ca = document.querySelector('.content-area');
  const ctxCard = document.getElementById('ctx-industry').closest('.card');
  if (ca && ctxCard) ca.scrollTop = Math.max(0, ctxCard.offsetTop - 30);
  return {
    pass: overflow.found && overflow.truncated && overflow.textOverflow === 'ellipsis' && overflow.whiteSpace === 'nowrap' && overflow.fitsSidebar && overflow.sidebarWidth === 260 &&
      guide && guide.borderLeftWidth === '1px' && guide.borderLeftColor === 'rgb(229, 231, 235)' && guide.borderLeftStyle === 'solid' && parseFloat(guide.marginLeft) > 0 &&
      sidebarBg === 'rgb(249, 250, 251)' && bodyBg === 'rgb(252, 252, 252)' && cardBg === 'rgb(255, 255, 255)' &&
      preStyle.bg === 'rgb(248, 250, 252)' && preStyle.color === 'rgb(51, 65, 85)' && preStyle.borderTopWidth === '1px' &&
      z.dropdown === '9990' && z.modal === '9999' && z.modelModal === '9999' &&
      cssChecks.scrollbarWidth && cssChecks.thumbColors &&
      focusStyle.hasFocus && focusStyle.matches && focusStyle.outlineStyle === 'none' && focusStyle.hasBlueBorder && focusStyle.hasSoftGlow &&
      S.errors.length === 0,
    overflow, guide, colors: { sidebarBg, bodyBg, cardBg, preStyle }, z, cssChecks, focusStyle,
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));