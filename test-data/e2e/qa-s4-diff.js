// 套件四：版本快照与 Diff 算法断言（左旧含删除文本、右新含新增文本、红绿类名）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(250); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await sleep(1500);
  const ta = document.getElementById('val-L0');
  const setL0 = (v) => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const DELETE_TEXT = 'QA_DELETE_被删除的句子';
  const ADD_TEXT = 'QA_ADD_新增的句子';
  setL0('QA基线第一句\n' + DELETE_TEXT + '\nQA基线第三句');
  await sleep(400);
  const beforeList = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const beforeId = beforeList[0] && beforeList[0].id;
  document.getElementById('generate-snapshot-btn').click();
  const newId = await wait(async () => {
    const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
    return list[0] && list[0].id && list[0].id !== beforeId ? list[0].id : null;
  }, 30000);
  push('4.0 生成对比基线快照成功', !!newId, { beforeId, newId });
  // 修改：删除一段 + 新增一段
  setL0('QA基线第一句\nQA基线第三句\n' + ADD_TEXT);
  await sleep(500);
  const firstRow = document.querySelector('#snapshot-tbody tr');
  const diffBtn = firstRow ? Array.from(firstRow.querySelectorAll('button')).find((b) => b.textContent.includes('对比当前')) : null;
  push('4.a 历史快照行存在「对比当前」入口', !!diffBtn);
  let opened = false, rendered = false;
  if (diffBtn) {
    diffBtn.click();
    const modal = document.getElementById('diff-modal');
    opened = !!(await wait(() => modal && getComputedStyle(modal).display !== 'none' && modal.offsetHeight > 0, 20000));
    rendered = !!(await wait(() => document.querySelectorAll('#diff-body .diff-cell').length > 2, 20000));
    await sleep(300);
  }
  const leftCells = Array.from(document.querySelectorAll('#diff-body .diff-row .diff-cell.left'));
  const rightCells = Array.from(document.querySelectorAll('#diff-body .diff-row .diff-cell:nth-child(2)'));
  const leftText = leftCells.map((c) => c.textContent).join('\n');
  const rightText = rightCells.map((c) => c.textContent).join('\n');
  const removedCells = Array.from(document.querySelectorAll('#diff-body .diff-cell.removed'));
  const addedCells = Array.from(document.querySelectorAll('#diff-body .diff-cell.added'));
  const cs = (el) => getComputedStyle(el);
  const removedStyle = removedCells[0] ? { bg: cs(removedCells[0]).backgroundColor, color: cs(removedCells[0]).color } : null;
  const addedStyle = addedCells[0] ? { bg: cs(addedCells[0]).backgroundColor, color: cs(addedCells[0]).color } : null;
  push('4.b 左侧旧快照 DOM 包含被删除文本', leftText.includes(DELETE_TEXT), { leftSample: leftText.slice(0, 160) });
  push('4.c 右侧当前编辑器 DOM 包含新增文本', rightText.includes(ADD_TEXT), { rightSample: rightText.slice(0, 160) });
  push('4.d 存在删除（红）CSS 类且颜色为浅红底深红字', removedCells.length > 0 && /rgb\(254, 242, 242\)/.test(removedStyle.bg) && /rgb\(185, 28, 28\)/.test(removedStyle.color), { removedCount: removedCells.length, removedStyle });
  push('4.e 存在新增（绿）CSS 类且颜色为浅绿底深绿字', addedCells.length > 0 && /rgb\(236, 253, 245\)/.test(addedStyle.bg) && /rgb\(21, 128, 61\)/.test(addedStyle.color), { addedCount: addedCells.length, addedStyle });
  // 关闭 Diff
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  const closed = getComputedStyle(document.getElementById('diff-modal')).display === 'none';
  push('4.f Esc 关闭 Diff 弹窗', closed);
  setL0('');
  await sleep(300);
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));