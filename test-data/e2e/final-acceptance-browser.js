// 终验 F1：浏览器核心业务闭环 + 视觉主题 + 控制台
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
  const cs = (el) => getComputedStyle(el);
  const t0 = performance.now();

  // 1) 项目/知识库/语境
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  push('F1.1 项目树可交互（Trip 项目存在）', !!trip);
  if (trip) trip.click();
  await wait(() => document.querySelector('#kb-list-container .kb-item'), 15000);
  await sleep(1000);
  const kbCount = (document.getElementById('kb-count') || {}).innerText || '';
  push('F1.2 知识库加载正常（97 条）', /97/.test(kbCount), { kbCount });
  push('F1.3 语境回填正常（行业=旅游行业）', document.getElementById('ctx-industry').value === '旅游行业', { industry: document.getElementById('ctx-industry').value });
  const snapshotRows = document.querySelectorAll('#snapshot-tbody tr').length;
  push('F1.4 历史快照列表加载', snapshotRows > 0, { snapshotRows });
  // 2) 模型配置中心开合
  document.getElementById('api-key-btn').click();
  const mOpen = await wait(() => getComputedStyle(document.getElementById('model-config-modal')).display !== 'none', 8000);
  await sleep(500);
  const modelListOk = (document.getElementById('model-list').innerText || '').length > 0;
  push('F1.5 模型配置中心可打开且列表加载', !!mOpen && modelListOk);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const mClosed = await wait(() => getComputedStyle(document.getElementById('model-config-modal')).display === 'none', 5000);
  push('F1.6 Esc 关闭模型弹窗', !!mClosed);
  // 3) Token 进度条三档
  const ta = document.getElementById('val-L0');
  const bar = document.getElementById('token-progress-bar');
  const setL0 = (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const tokenCases = [];
  for (const [label, chars, expect] of [['75%', 5000, 'rgb(77, 107, 254)'], ['88%', 5834, 'rgb(245, 158, 11)'], ['100%', 6666, 'rgb(239, 68, 68)']]) {
    setL0('A'.repeat(chars)); await sleep(320);
    tokenCases.push({ label, bg: cs(bar).backgroundColor, ok: cs(bar).backgroundColor === expect });
  }
  push('F1.7 Token 进度条 75%蓝 / 88%橙 / 100%红', tokenCases.every((c) => c.ok), tokenCases);
  // 4) Tag 超长省略号
  const tagInput = document.getElementById('ctx-scene-input');
  const tagList = document.getElementById('ctx-scene-tags');
  const beforeTags = tagList.querySelectorAll('.tag-chip').length;
  tagInput.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(tagInput, '超长业务场景标签终验一二三四五六七八九十零一二三四五六七八九');
  tagInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  await sleep(400);
  const chips = Array.from(tagList.querySelectorAll('.tag-chip'));
  const chip = chips[chips.length - 1];
  const label = chip ? chip.querySelector('.tag-chip-label') : null;
  const tagOk = !!label && label.scrollWidth > label.clientWidth && cs(chip).maxWidth === '150px' && chip.getBoundingClientRect().width <= 151;
  push('F1.8 超长 Tag 150px 内省略号截断', tagOk, { chipW: chip ? Math.round(chip.getBoundingClientRect().width) : null, maxWidth: chip ? cs(chip).maxWidth : null, truncated: label ? label.scrollWidth > label.clientWidth : null });
  // 清理 tag
  if (chips.length > beforeTags) { const del = chips[chips.length - 1].querySelector('.tag-chip-del'); if (del) del.click(); await sleep(250); }
  // 5) 清理排版
  setL0('测试，，，，\n\n\n\n测试');
  await sleep(250);
  document.getElementById('clean-format-btn').click();
  await sleep(400);
  const cleaned = ta.value;
  push('F1.9 一键清理排版（连续逗号/空行折叠）', cleaned === '测试，\n\n测试', { cleaned: JSON.stringify(cleaned) });
  setL0('');
  await sleep(250);
  // 6) 树搜索
  const search = document.getElementById('tree-search');
  const initialNodes = document.querySelectorAll('.menu-child').length;
  search.value = 'Trip'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const visNodes = Array.from(document.querySelectorAll('.menu-child'));
  push('F1.10 树搜索过滤（可见节点均含 Trip 且隐藏数>0）', visNodes.length > 0 && visNodes.every((n) => n.textContent.includes('Trip')) && initialNodes - visNodes.length > 0, { initialNodes, visible: visNodes.length });
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  // 7) Diff 弹窗
  const firstRow = document.querySelector('#snapshot-tbody tr');
  const diffBtn = firstRow ? Array.from(firstRow.querySelectorAll('button')).find((b) => b.textContent.includes('对比当前')) : null;
  if (diffBtn) diffBtn.click();
  const diffOpen = await wait(() => document.querySelectorAll('#diff-body .diff-cell').length > 2, 20000);
  const diffCells = document.querySelectorAll('#diff-body .diff-cell').length;
  push('F1.11 快照行级 Diff 可渲染', !!diffOpen && diffCells > 2, { diffCells });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  // 8) 视觉主题
  const primaryBg = cs(document.getElementById('generate-snapshot-btn')).backgroundColor;
  const cardStyle = { radius: cs(document.querySelector('.card')).borderTopLeftRadius, shadow: cs(document.querySelector('.card')).boxShadow };
  const headerBlur = cs(document.querySelector('.header')).backdropFilter;
  const active = document.querySelector('.menu-child.active');
  push('F1.12 品牌蓝主按钮', primaryBg === 'rgb(77, 107, 254)', { primaryBg });
  push('F1.13 卡片 16px 圆角 + 柔和阴影', cardStyle.radius === '16px' && cardStyle.shadow !== 'none', cardStyle);
  push('F1.14 Header 玻璃拟态 blur(12px)', /blur\(12px\)/.test(headerBlur || ''), { headerBlur });
  push('F1.15 选中项品牌蓝文字 + 浅蓝底', !!active && cs(active).color === 'rgb(77, 107, 254)' && cs(active).backgroundColor === 'rgb(238, 242, 255)', active ? { color: cs(active).color, bg: cs(active).backgroundColor } : null);
  push('F1.16 无 JS Error（交互全程）', errors.length === 0, { errors: errors.slice(0, 5) });
  return { results, pass: results.every((r) => r.ok), durationMs: Math.round(performance.now() - t0) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));