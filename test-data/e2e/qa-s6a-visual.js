// 套件六（静态部分）：品牌色 / 选中态 / 卡片圆角阴影 / 玻璃拟态（基线）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const cs = (el) => getComputedStyle(el);
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await sleep(1400);
  // 品牌色
  const primary = document.getElementById('generate-snapshot-btn');
  const pcs = cs(primary);
  push('6.1a 主按钮背景为 DeepSeek 品牌蓝 #4d6bfe', pcs.backgroundColor === 'rgb(77, 107, 254)', { bg: pcs.backgroundColor, expected: 'rgb(77, 107, 254)' });
  const active = document.querySelector('.menu-child.active');
  const acs = cs(active);
  push('6.1b 侧边栏选中项文字为品牌蓝', acs.color === 'rgb(77, 107, 254)', { color: acs.color });
  const activeBgOk = /^rgb\(2\d\d, 2\d\d, 25\d\)$/.test(acs.backgroundColor);
  push('6.1c 侧边栏选中项背景为浅蓝（#eef2ff/#e8f0fe 同类）', activeBgOk, { bg: acs.backgroundColor });
  // 卡片
  const card = document.querySelector('.card');
  const ccs = cs(card);
  push('6.2a 主工作区卡片包含 box-shadow（非生硬边框）', ccs.boxShadow !== 'none' && ccs.boxShadow.length > 0, { boxShadow: ccs.boxShadow });
  const radiusPx = parseFloat(ccs.borderTopLeftRadius);
  push('6.2b 卡片 border-radius 为 16px 或 24px', radiusPx === 16 || radiusPx === 24, { borderRadius: ccs.borderTopLeftRadius });
  // 玻璃拟态
  const header = document.querySelector('.header');
  const modal = document.getElementById('model-config-modal');
  const headerBlur = cs(header).backdropFilter || cs(header).webkitBackdropFilter;
  const modalBlur = cs(modal).backdropFilter || cs(modal).webkitBackdropFilter;
  const glassOk = /blur\(12px\)/.test(headerBlur || '') || /blur\(12px\)/.test(modalBlur || '');
  push('6.2c Header 或弹窗包含 backdrop-filter: blur(12px) 玻璃拟态', glassOk, { headerBlur, modalBlur });
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));