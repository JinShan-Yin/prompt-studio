// 套件二-2.1b 强化：编辑器自动撑高模式下，临时限制高度以验证 scroll 同步逻辑
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push('第' + i + '行 {{industry}} ' + '长文本填充'.repeat(4));
  const longText = '\n' + lines.join('\n');
  ta.value = longText;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);
  const natural = {
    taScrollHeight: ta.scrollHeight, mirrorScrollHeight: mirror.scrollHeight,
    taClientHeight: ta.clientHeight, mirrorClientHeight: mirror.clientHeight,
    delta: Math.abs(ta.scrollHeight - mirror.scrollHeight), spanCount: mirror.querySelectorAll('span').length
  };
  // 临时限制高度（模拟固定高度滚动编辑器），验证 scroll 同步代码路径
  ta.style.height = '300px'; ta.style.overflowY = 'auto';
  mirror.style.height = '300px'; mirror.style.overflowY = 'hidden';
  await sleep(200);
  ta.scrollTop = ta.scrollHeight;
  ta.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(300);
  const scroll = {
    taClientHeight: ta.clientHeight, taScrollHeight: ta.scrollHeight, taScrollTop: ta.scrollTop,
    mirrorScrollTop: mirror.scrollTop, synced: mirror.scrollTop === ta.scrollTop && ta.scrollTop > 0
  };
  // 恢复自动撑高
  ta.style.height = ''; ta.style.overflowY = '';
  mirror.style.height = ''; mirror.style.overflowY = '';
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  return {
    passes: [
      { name: '2.1a scrollHeight 同步（自然高度）', ok: natural.delta <= 2 && natural.spanCount === 50, detail: natural },
      { name: '2.1b 强制滚动到底部后 mirror.scrollTop 同步', ok: scroll.synced, detail: scroll }
    ],
    natural, scroll
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));