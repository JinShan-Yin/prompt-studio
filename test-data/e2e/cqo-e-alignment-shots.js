// CQO 维度二.1 证据：超长文本双层对齐 —— 顶部与中部滚动截图 + 关键度量
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  const lines = [];
  for (let i = 1; i <= 220; i++) {
    const indent = i % 3 === 0 ? '    ' : (i % 3 === 1 ? '  ' : '');
    lines.push(indent + '第' + i + '行：换行/缩进/空格对齐 `code` English words，变量 {{var_' + (i % 7) + '}}。');
  }
  ta.value = 'CQO 生产对齐样本 <speak>你好</speak> <tool>transfer</tool> 行业={{industry}}\n' + lines.join('\n') + '\n【末尾空行】\n';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
  document.querySelector('.content-area').scrollTop = 0;
  await sleep(200);
  const cs = (el) => getComputedStyle(el);
  const props = ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'letterSpacing', 'fontWeight', 'textIndent', 'whiteSpace', 'overflowWrap', 'wordBreak'];
  const a = cs(ta), b = cs(mirror);
  const styleDiff = props.filter((p) => a[p] !== b[p]);
  const r1 = ta.getBoundingClientRect(), r2 = mirror.getBoundingClientRect();
  return {
    chars: ta.value.length, lines: ta.value.split('\n').length,
    spans: mirror.querySelectorAll('span').length,
    styleDiff, rectDiff: { top: r1.top - r2.top, left: r1.left - r2.left, width: r1.width - r2.width, height: r1.height - r2.height },
    heights: { ta: ta.clientHeight, mirror: mirror.clientHeight, taScroll: ta.scrollHeight, mirrorScroll: mirror.scrollHeight },
    tagsSafe: !mirror.querySelector('speak') && !mirror.querySelector('tool') && (mirror.textContent || '').includes('<speak>'),
    orange: mirror.querySelector('span') ? cs(mirror.querySelector('span')).color : ''
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));