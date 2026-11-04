// CQO 维度二.3：中文输入法组合态不得误生成 Tag + Token 50ms 防抖流畅性
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const C = window.__cqo;
  const tagsBox = document.getElementById('ctx-scene-tags');
  const input = document.getElementById('ctx-scene-input');
  // 清空场景标签
  while (tagsBox.querySelector('.tag-chip-del')) tagsBox.querySelector('.tag-chip-del').click();
  const countTags = () => tagsBox.querySelectorAll('.tag-chip').length;
  const before = countTags();
  // 模拟中文输入法：compositionstart → 输入拼音 → 空格选字（isComposing/keyCode 229）→ compositionend
  input.focus();
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  input.value = 'zhongguo';
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'zhongguo', isComposing: true }));
  const spaceEv = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true, isComposing: true });
  Object.defineProperty(spaceEv, 'keyCode', { get: () => 229 });
  input.dispatchEvent(spaceEv);
  await sleep(80);
  const afterSpace = countTags();
  // 选字上屏
  input.value = '中国';
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中国' }));
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中国' }));
  await sleep(80);
  const afterComposition = countTags();
  // 组合结束后正常回车 → 应生成 Tag
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(100);
  const afterEnter = countTags();
  // 清理刚生成的 Tag
  while (tagsBox.querySelector('.tag-chip-del')) tagsBox.querySelector('.tag-chip-del').click();
  // Token 防抖：L0 放 100 行文本，然后快速连续 input
  const ta = document.getElementById('val-L0');
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push('第' + i + '行 token 防抖测试 {{var_' + (i % 5) + '}}');
  ta.value = lines.join('\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const baseChars = Number(document.getElementById('stats-chars').innerText);
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) {
    ta.value = lines.join('\n') + '\n追加第' + k + '次输入 {{industry}}';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const dispatchMs = performance.now() - t0;
  const immediateChars = Number(document.getElementById('stats-chars').innerText);
  await sleep(120);
  const settledChars = Number(document.getElementById('stats-chars').innerText);
  const settledTokens = Number(document.getElementById('stats-tokens').innerText);
  const expectedChars = ta.value.length + document.getElementById('val-L1').value.length + document.getElementById('val-L3').value.length;
  const debounceWorked = immediateChars !== expectedChars && settledChars === expectedChars && settledTokens === Math.ceil(expectedChars * 0.6);
  const smooth = dispatchMs < 2500;
  return {
    pass: before === 0 && afterSpace === 0 && afterComposition === 0 && afterEnter === 1 && debounceWorked && smooth,
    ime: { before, afterSpace, afterComposition, afterEnter },
    debounce: { baseChars, immediateChars, settledChars, settledTokens, expectedChars, dispatchMs: Math.round(dispatchMs) },
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));