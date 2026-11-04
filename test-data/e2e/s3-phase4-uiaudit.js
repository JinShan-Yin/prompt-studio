// Sprint3 Lead E2E Phase 4：模块七 UI 规范审查（计算样式 + hover 规则 + 对比度 + 红线扫描）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const rgb = (s) => {
    const m = String(s || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const lum = (c) => {
    const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const contrast = (bg, fg) => {
    const L1 = lum(bg), L2 = lum(fg);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const sidebar = document.querySelector('.sidebar');
  const sidebarBg = rgb(cs(sidebar).backgroundColor);
  const treeItem = document.querySelector('.menu-child.active') || document.querySelector('.menu-child');
  const treeColor = rgb(cs(treeItem).color);
  const rootStyle = getComputedStyle(document.documentElement);
  const primaryVar = rootStyle.getPropertyValue('--primary').trim();
  const primaryBtn = document.querySelector('.btn-primary');
  const primaryBtnBg = rgb(cs(primaryBtn).backgroundColor);
  const card = document.querySelector('.card');
  const cardStyle = cs(card);
  const tableTh = document.querySelector('.table th');
  const tableRow = document.querySelector('.table tbody tr');
  const contentArea = document.querySelector('.content-area');
  const header = document.querySelector('.header');
  // hover 规则统计
  let hoverRules = 0;
  const hoverSamples = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.selectorText && rule.selectorText.includes(':hover')) {
          hoverRules++;
          if (hoverSamples.length < 40) hoverSamples.push(rule.selectorText + ' { ' + rule.style.cssText.slice(0, 120) + ' }');
        }
      }
    }
  } catch (e) {}
  const scriptText = Array.from(document.querySelectorAll('script')).map((s) => s.textContent || '').join('\n');
  const allTexts = document.body.innerText;
  const data = {
    sidebarBg: cs(sidebar).backgroundColor,
    sidebarTextColor: treeItem ? cs(treeItem).color : null,
    sidebarContrast: sidebarBg && treeColor ? Number(contrast(sidebarBg, treeColor).toFixed(2)) : null,
    primaryVar,
    primaryBtnBg: primaryBtn ? cs(primaryBtn).backgroundColor : null,
    bodyBg: cs(document.body).backgroundColor,
    headerBg: cs(header).backgroundColor,
    contentPadding: cs(contentArea).padding,
    card: { radius: cardStyle.borderRadius, shadow: cardStyle.boxShadow, marginBottom: cardStyle.marginBottom, bodyPadding: cs(document.querySelector('.card-body')).padding },
    table: { thBg: tableTh ? cs(tableTh).backgroundColor : null, thWeight: tableTh ? cs(tableTh).fontWeight : null, rowHoverRules: hoverRules, rowBorderBottom: tableRow ? cs(tableRow.querySelector('td')).borderBottom : null },
    button: { radius: primaryBtn ? cs(primaryBtn).borderRadius : null, padding: primaryBtn ? cs(primaryBtn).padding : null, transition: primaryBtn ? cs(primaryBtn).transition : null },
    hoverRuleCount: hoverRules,
    hoverSamples,
    noHorizontalOverflow: document.body.scrollWidth <= window.innerWidth + 1,
    keyIds: {
      gear: !!document.getElementById('api-key-btn'),
      copyBtn: !!document.getElementById('copy-prompt-btn'),
      exportZip: !!document.getElementById('export-zip-btn'),
      rollbackBtn: !!Array.from(document.querySelectorAll('#snapshot-tbody button')).find((b) => b.textContent.includes('回滚')),
      editor: !!document.getElementById('val-L0'), mirror: !!document.getElementById('mirror-L0'),
      kbSearch: !!document.getElementById('kb-search'), chat: !!document.getElementById('chat-send-btn'), batch: !!document.getElementById('batch-run-btn')
    },
    redlines: {
      contenteditable: document.querySelectorAll('[contenteditable]').length,
      externalScripts: Array.from(document.querySelectorAll('script[src]')).length,
      externalLinks: Array.from(document.querySelectorAll('link[href]')).length,
      nativeAlert: /(^|[^.\w])alert\s*\(/.test(scriptText),
      nativeConfirm: /(^|[^.\w])confirm\s*\(/.test(scriptText),
      keyLeakInDom: /sk-[A-Za-z0-9]{24,}/.test(allTexts)
    },
    errors: (window.__s3 && window.__s3.errors) || []
  };
  data.pass = !!(data.sidebarBg && data.sidebarBg.startsWith('rgb(') && data.sidebarContrast >= 4.5 &&
    primaryVar && /#4f46e5|#4338ca|rgb\(79, 70, 229\)/.test(primaryVar + ' ' + (data.primaryBtnBg || '')) &&
    hoverRules >= 8 && parseFloat(data.contentPadding) >= 20 &&
    data.card.radius && data.table.thBg && data.button.radius &&
    data.noHorizontalOverflow && Object.values(data.keyIds).every(Boolean) &&
    data.redlines.contenteditable === 0 && data.redlines.externalScripts === 0 && data.redlines.nativeConfirm === false && data.redlines.nativeAlert === false && data.redlines.keyLeakInDom === false &&
    data.errors.length === 0);
  return data;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));