// V3.0 阶段四 Lead E2E (b)：一键清理排版 + Token 红线进度条三色阈值
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.__v3p4 = { errors: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  // 1) 清理排版
  setVal('val-L0', '  你好，测试。  \n\n\n\n  第二行  ，结束  \n\n');
  setVal('val-L1', '  <speak>你好</speak>  \n\n');
  setVal('val-L3', '第一行，第二行');
  await sleep(300);
  document.getElementById('clean-format-btn').click();
  await sleep(600);
  const cleaned = { l0: document.getElementById('val-L0').value, l1: document.getElementById('val-L1').value, l3: document.getElementById('val-L3').value };
  const toastText = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  // 2) Token 进度条三色阈值（token=ceil(chars*0.6)，上限 4000；只放 L0，清空其它层）
  const bar = document.getElementById('token-progress-bar');
  const label = document.getElementById('token-progress-label');
  const cases = [];
  for (const [name, chars] of [['green', 5000], ['yellow', 5834], ['red', 8400]]) {
    setVal('val-L0', 'A'.repeat(chars));
    setVal('val-L1', ''); setVal('val-L3', '');
    await sleep(300);
    cases.push({
      name, chars, tokens: Math.ceil(chars * 0.6),
      width: bar.style.width,
      color: getComputedStyle(bar).backgroundColor,
      label: label.innerText
    });
  }
  const overflowText = label.innerText;
  const warningEl = document.getElementById('token-limit-warning');
  const warningVisible = !!warningEl && getComputedStyle(warningEl).display !== 'none';
  const warningText = warningEl ? warningEl.innerText : '';
  const lastColor = cases[cases.length - 1].color;
  // 清理
  setVal('val-L0', ''); setVal('val-L1', ''); setVal('val-L3', '');
  await sleep(300);
  return {
    pass: cleaned.l0 === '你好,测试。\n\n第二行  ,结束' && cleaned.l1.includes('<speak>你好</speak>') && !/\n\n\n/.test(cleaned.l1) &&
      /减少|字符/.test(toastText) &&
      /75%/.test(cases[0].width) && cases[0].color === 'rgb(22, 163, 74)' &&
      /87\.5/.test(cases[1].width) && cases[1].color === 'rgb(180, 83, 9)' &&
      cases[2].width === '100%' && /rgb\(239, 68, 68\)/.test(cases[2].color) && warningVisible && /超出 4000 Token/.test(warningText) && /5040/.test(warningText) &&
      S.errors.length === 0,
    cleaned, toastText: toastText.slice(0, 200),
    tokenCases: cases, overflowText, warningVisible, warningText, lastColor,
    errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));