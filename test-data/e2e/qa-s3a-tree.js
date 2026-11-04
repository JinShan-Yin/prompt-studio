// 套件三：KB 在线编辑闭环 + 左侧树搜索过滤
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  // ---- 3.2 树搜索（先做，避免 KB 修改影响） ----
  findTree('Trip旅游AI接线员').click();
  await sleep(1500);
  const initialCount = document.querySelectorAll('.menu-child').length;
  const search = document.getElementById('tree-search');
  search.value = 'Trip';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
  const visibleNodes = Array.from(document.querySelectorAll('.menu-child'));
  const visibleTexts = visibleNodes.map((n) => n.textContent.trim());
  const allVisibleMatch = visibleTexts.every((t) => t.includes('Trip'));
  const hiddenCount = initialCount - visibleNodes.length;
  push('3.2a 搜索 "Trip" 后可见节点文本全部包含 Trip', visibleNodes.length > 0 && allVisibleMatch, { visibleTexts });
  push('3.2b 被过滤隐藏的树节点数量 > 0', hiddenCount > 0, { initialCount, visibleCount: visibleNodes.length, hiddenCount });
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const restored = document.querySelectorAll('.menu-child').length;
  push('3.2c 清空搜索后树恢复', restored === initialCount, { restored, initialCount });

  // ---- 3.1 KB 在线编辑闭环 ----
  findTree('Trip旅游AI接线员').click();
  await wait(() => document.querySelector('#kb-list-container .kb-item'), 15000);
  await sleep(500);
  const listBefore = (await (await fetch('/api/kb/list?project_id=proj-597e1045')).json()).data || [];
  const target = listBefore[0];
  const marker = '【QA回归' + Date.now().toString().slice(-5) + '】';
  const firstItem = document.querySelector('#kb-list-container .kb-item');
  const editBtn = firstItem ? Array.from(firstItem.querySelectorAll('button')).find((b) => b.textContent.includes('编辑')) : null;
  let modalOpened = false, saved = false, persisted = false, domAfterReload = false;
  if (editBtn) {
    editBtn.click();
    const modal = document.getElementById('kb-edit-modal');
    modalOpened = !!(await wait(() => modal && getComputedStyle(modal).display !== 'none', 8000));
    await sleep(300);
    const qEl = document.getElementById('kb-edit-question');
    const aEl = document.getElementById('kb-edit-answer');
    qEl.value = target.question + marker;
    aEl.value = target.answer + marker;
    document.getElementById('kb-edit-save-btn').click();
    saved = !!(await wait(() => !modal || getComputedStyle(modal).display === 'none', 12000));
    await sleep(700);
    const afterApi = (await (await fetch('/api/kb/list?project_id=proj-597e1045')).json()).data || [];
    const row = afterApi.find((x) => x.id === target.id);
    persisted = !!(row && row.question.includes(marker) && row.answer.includes(marker));
    // 刷新页面后从 DOM 验证
    location.reload();
    return { results: results.concat([{ name: '3.1a KB 编辑弹窗打开', ok: modalOpened }, { name: '3.1b 保存成功并关闭弹窗', ok: saved }, { name: '3.1c API 层持久化生效', ok: persisted }]) };
  }
  return { results, pass: false, error: 'edit button not found' };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));