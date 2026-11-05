// 终验 F2：性能与响应性（页面加载、1000字变量渲染、Token 防抖、滚动同步耗时）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const nav = performance.getEntriesByType('navigation')[0] || {};
  push('F2.1 页面导航加载（DOMContentLoaded < 3000ms）', (nav.domContentLoadedEventEnd || 0) > 0 && nav.domContentLoadedEventEnd < 3000, { domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0) });
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await sleep(1200);
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push('第' + i + '行 {{industry}} ' + '长文本填充'.repeat(4));
  const longText = '\n' + lines.join('\n');
  // 编辑器渲染耗时（input 事件到 scrollHeight 稳定）
  const t0 = performance.now();
  ta.value = longText;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const renderStart = performance.now();
  await sleep(0);
  const sync = Math.abs(ta.scrollHeight - mirror.scrollHeight);
  const renderMs = Math.round(performance.now() - renderStart);
  push('F2.2 1000字/50变量渲染 < 500ms 且镜像同步', renderMs < 500 && sync <= 2, { renderMs, sync, textLen: longText.length });
  // Token 防抖：输入后不应立即更新（50ms debounce），100ms 内完成
  const t1 = performance.now();
  ta.value = 'A'.repeat(5000);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const labelImmediate = (document.getElementById('stats-tokens') || {}).innerText;
  await sleep(200);
  const labelAfter = (document.getElementById('stats-tokens') || {}).innerText;
  push('F2.3 Token 统计防抖后正确（5000字→3000 Token）', labelAfter === '3000', { immediate: labelImmediate, after: labelAfter, elapsed: Math.round(performance.now() - t1) });
  ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  // 高频输入（200 次 input）性能
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) {
    ta.value = '高频输入性能测试 ' + i + ' {{industry}}';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(250);
  const rapidMs = Math.round(performance.now() - t2);
  push('F2.4 200 次高频 input 总耗时 < 1500ms（防抖有效）', rapidMs < 1500, { rapidMs });
  ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  // 截图用：保持干净状态
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));