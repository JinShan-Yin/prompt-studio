// CQO 维度二.1+2.2：超长文本双层像素级对齐（含换行/缩进/几十个变量）+ <speak>/<tool> 标签转义保护
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const C = window.__cqo;
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  // 构造超长文本：220 行 + 缩进 + 每行 1 个变量 + 生产标签
  const lines = [];
  for (let i = 1; i <= 220; i++) {
    const indent = i % 3 === 0 ? '    ' : (i % 3 === 1 ? '  ' : '');
    lines.push(indent + '第' + i + '行：缩进与换行对齐测试，含 English words 与空  格，变量 {{var_' + (i % 7) + '}}。');
  }
  const longText = '【头部】<speak>你好</speak> <tool>transfer</tool> 行业={{industry}}\n' + lines.join('\n') + '\n【尾部·末尾空行】\n';
  ta.value = longText;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(450);
  const cs = (el) => getComputedStyle(el);
  const props = ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'letterSpacing', 'fontWeight', 'textIndent', 'whiteSpace', 'overflowWrap', 'wordBreak'];
  const a = cs(ta), b = cs(mirror);
  const styleDiff = props.filter((p) => a[p] !== b[p]).map((p) => p + ':' + a[p] + '/' + b[p]);
  const wDiff = Math.abs(ta.getBoundingClientRect().width - mirror.getBoundingClientRect().width);
  // 文本内容一致性（镜像 textContent 中空格为 NBSP、换行由 <br> 承载）
  const normValue = ta.value.replace(/ /g, '\u00A0').replace(/\n/g, '');
  const mirrorText = mirror.textContent || '';
  const textMatch = mirrorText === normValue;
  // 标签保护
  const hasSpeakEl = !!mirror.querySelector('speak');
  const hasToolEl = !!mirror.querySelector('tool');
  const hasScriptEl = !!mirror.querySelector('script');
  const tagsLiteral = mirrorText.includes('<speak>你好</speak>') && mirrorText.includes('<tool>transfer</tool>');
  const textareaKeepsTags = ta.value.includes('<speak>你好</speak>') && ta.value.includes('<tool>transfer</tool>');
  // 高亮变量数量
  const spans = mirror.querySelectorAll('span');
  const spanCount = spans.length;
  const expectedSpans = (ta.value.match(/\{\{[\s\S]*?\}\}/g) || []).length;
  const orange = spans.length > 0 && cs(spans[0]).color === 'rgb(245, 158, 11)';
  // 高度/滚动高度
  const heights = { ta: ta.clientHeight, mirror: mirror.clientHeight, diff: Math.abs(ta.clientHeight - mirror.clientHeight), taScroll: ta.scrollHeight, mirrorScroll: mirror.scrollHeight };
  const hScrollDiff = Math.abs(heights.taScroll - heights.mirrorScroll);
  // 疯狂滚动：人为约束两层高度后多次滚动
  ta.style.height = '200px'; mirror.style.height = '200px';
  const scrollChecks = [];
  for (const pos of [0, 150, 600, 1200, 400, 2000, 0]) {
    ta.scrollTop = pos;
    ta.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(20);
    scrollChecks.push({ pos, ta: ta.scrollTop, mirror: mirror.scrollTop, diff: Math.abs(ta.scrollTop - mirror.scrollTop) });
  }
  window.refreshAllEditorMirrors();
  await sleep(100);
  const scrollMaxDiff = Math.max(...scrollChecks.map((s) => s.diff));
  const brCount = mirror.querySelectorAll('br').length;
  const newlineCount = (ta.value.match(/\n/g) || []).length;
  return {
    pass: styleDiff.length === 0 && wDiff < 0.5 && textMatch && !hasSpeakEl && !hasToolEl && !hasScriptEl && tagsLiteral && textareaKeepsTags &&
      spanCount === expectedSpans && expectedSpans > 200 && orange && heights.diff <= 1 && hScrollDiff <= 1 && scrollMaxDiff <= 1,
    text: { length: ta.value.length, lines: newlineCount + 1, chars: ta.value.length, newlines: newlineCount, brCount },
    alignment: { styleDiff, wDiff, textMatch, heights, hScrollDiff, scrollMaxDiff },
    tags: { hasSpeakEl, hasToolEl, hasScriptEl, tagsLiteral, textareaKeepsTags },
    highlight: { spanCount, expectedSpans, orange },
    scrollChecks,
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));