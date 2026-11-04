// Sprint2 Lead E2E Phase 1b：知识库实时搜索显式复核（Trip 项目 97 条）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const node = findTree('Trip旅游AI接线员');
  if (node) node.click();
  await sleep(1200);
  const container = () => document.getElementById('kb-list-container');
  const itemCount = () => {
    const c = container();
    if (!c) return 0;
    const byClass = c.querySelectorAll('.kb-item').length;
    return byClass > 0 ? byClass : (c.textContent.match(/Q[:：]/g) || []).length;
  };
  const countText = () => (document.getElementById('kb-count') ? document.getElementById('kb-count').innerText : '');
  const search = document.getElementById('kb-search');
  if (!search) return { pass: false, fatal: 'no #kb-search' };
  const setSearch = (v) => { search.value = v; search.dispatchEvent(new Event('input', { bubbles: true })); };
  const total = itemCount();
  const totalText = countText();
  setSearch('纠纷'); await sleep(200);
  const m1 = itemCount(); const t1 = countText();
  const allVisibleContain = Array.from(container().querySelectorAll('.kb-item')).every((el) => el.textContent.includes('纠纷'));
  setSearch('icc'); await sleep(200);
  const m2 = itemCount();
  setSearch('zzz_no_match_999'); await sleep(200);
  const m3 = itemCount(); const emptyText = container().textContent;
  setSearch(''); await sleep(200);
  const restored = itemCount();
  setSearch('纠纷'); await sleep(200); // 留过滤态供截图
  return {
    pass: total >= 97 && m1 > 0 && m1 < total && /匹配/.test(t1) && allVisibleContain && m2 > 0 && m3 === 0 && /无匹配/.test(emptyText) && restored === total,
    total, totalText, match1: m1, count1: t1, allVisibleContain, matchIcc: m2, matchNone: m3,
    emptyText: (emptyText || '').slice(0, 80), restored, finalCountText: countText()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));