// CQO 维度四：复制为 NewLync Text 的纯净度（无 UI 样式/无代码残留/无冗余首尾空白）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const C = window.__cqo = window.__cqo || { errors: [] };
  C.errors = C.errors || [];
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const tripNode = findTree('Trip旅游AI接线员');
  if (tripNode) tripNode.click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(900);
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  setVal('val-L0', 'CQO_D_L0 行业={{industry}} 目标={{core_goal}}');
  setVal('val-L1', 'CQO_D_L1 <speak>你好</speak>');
  setVal('val-L3', 'CQO_D_L3 尾行 {{industry}}');
  const ind = document.getElementById('ctx-industry');
  ind.value = 'COPY行业X'; ind.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  // 拦截剪贴板写入
  C.copy = null;
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { C.copy = t; } } });
  } catch (e) { C.copyErr = String(e && e.message); }
  const origExec = document.execCommand ? document.execCommand.bind(document) : null;
  document.execCommand = function (cmd, ...args) { if (String(cmd).toLowerCase() === 'copy') { C.copyFallback = document.activeElement ? document.activeElement.value : null; return true; } return origExec ? origExec(cmd, ...args) : false; };
  const btn = document.getElementById('copy-prompt-btn');
  btn.click();
  const copied = await waitUntil(() => typeof C.copy === 'string', 15000);
  await sleep(300);
  const text = C.copy || '';
  const checks = {
    nonEmpty: text.length > 0,
    noLeadingBlank: !/^\s/.test(text),
    noTrailingBlank: !/\s$/.test(text),
    noHtmlTags: !/<(div|span|style|script|button|input|textarea|p|br)\b/i.test(text),
    noCssResidue: !/(class=|style=|onclick=|display:|backgroundColor)/.test(text),
    noUiText: !/点击|按钮|复制成功|toast|modal/i.test(text),
    noMojibake: !/\uFFFD/.test(text),
    threeLayers: (text.match(/###\s/g) || []).length === 3,
    varsReplaced: text.includes('COPY行业X') && !/\{\{\s*(industry|core_goal)\s*\}\}/.test(text),
    structure: /###\s*全局安全\s*\(L0\)/.test(text) && /###\s*语音基座\s*\(L1\)/.test(text) && /###\s*项目话术\s*\(L3\)/.test(text),
    trimmedEquals: text === text.trim()
  };
  return {
    pass: checks.nonEmpty && checks.trimmedEquals && checks.noLeadingBlank && checks.noTrailingBlank && checks.noHtmlTags && checks.noCssResidue && checks.noUiText && checks.noMojibake && checks.threeLayers && checks.varsReplaced && checks.structure,
    checks,
    text,
    textLength: text.length,
    headJson: JSON.stringify(text.slice(0, 40)),
    tailJson: JSON.stringify(text.slice(-40)),
    copyErr: C.copyErr || null,
    errors: C.errors.slice()
  };
});
// 将复制内容写入文件，模拟「粘贴到记事本」的证据
const fs = await import('node:fs');
if (out && typeof out.text === 'string' && out.text.length) fs.writeFileSync('D:/prompt-studio/test-data/e2e/cqo-copied-newlync.txt', out.text);
console.log('@@DSH_RESULT@@' + JSON.stringify(out));