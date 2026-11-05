// Lead 集成复核 A：模板库应用/恢复/删除 + 快照复制 + 快捷键 + 备份按钮 + 克隆菜单
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 10000, step = 120) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(step); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
  const cs = (el) => getComputedStyle(el);
  const toastText = () => Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join(' | ');
  const waitToast = (re) => wait(() => { const t = toastText(); return re.test(t) ? t : null; }, 8000);
  const setLayer = (layer, v) => { const el = document.getElementById('val-' + layer); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const getLayer = (layer) => document.getElementById('val-' + layer).value;
  // 选中 Trip
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await sleep(1400);
  // 准备一个测试模板（API）
  const TPL_NAME = 'QA_V4_TMPL_' + Date.now().toString().slice(-5);
  const saved = await (await fetch('/api/templates/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: TPL_NAME, l0_content: 'L0_TEMPLATE_MARK_α {{industry}}', l1_content: 'L1_TEMPLATE_MARK_β', l3_content: 'L3_TEMPLATE_MARK_γ' }) })).json();
  const tplId = saved.id;
  push('V4.1 测试模板创建成功（API）', saved.success === true && !!tplId, { tplId, TPL_NAME });
  // 写入恢复基线
  setLayer('L0', '【恢复标记】原始L0');
  setLayer('L1', '原始L1');
  setLayer('L3', '原始L3');
  await sleep(250);
  // 打开应用模板
  const applyBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('应用模板'));
  applyBtn.click();
  const applyModal = document.getElementById('template-apply-modal');
  const opened = await wait(() => cs(applyModal).display !== 'none', 8000);
  await sleep(600);
  const search = document.getElementById('template-search');
  search.value = TPL_NAME;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const items = Array.from(document.querySelectorAll('#template-list .tpl-item'));
  const found = items.find((el) => el.textContent.includes(TPL_NAME));
  push('V4.2 应用模板弹窗打开 + 搜索命中', !!opened && !!found, { opened: !!opened, itemCount: items.length });
  // 应用
  if (found) {
    const applyOne = Array.from(found.querySelectorAll('button')).find((b) => b.textContent.trim() === '应用');
    applyOne.click();
    const confirmModal = document.getElementById('global-modal');
    const confirmShown = await wait(() => cs(confirmModal).display === 'flex', 6000);
    document.getElementById('modal-confirm-btn').click();
    const toastApplied = await waitToast(/已应用模板/);
    await sleep(500);
    push('V4.3 应用模板写入三层 + 恢复按钮出现', !!confirmShown && !!toastApplied && getLayer('L0').includes('L0_TEMPLATE_MARK') && getLayer('L1').includes('L1_TEMPLATE_MARK') && getLayer('L3').includes('L3_TEMPLATE_MARK') && cs(document.getElementById('restore-template-btn')).display !== 'none', { confirmShown, toastApplied, L0: getLayer('L0'), restoreDisplay: cs(document.getElementById('restore-template-btn')).display });
    // 恢复初始模板
    document.getElementById('restore-template-btn').click();
    await sleep(500);
    push('V4.4 ↩️ 恢复初始模板：三层原文完整回退且按钮隐藏', getLayer('L0') === '【恢复标记】原始L0' && getLayer('L1') === '原始L1' && getLayer('L3') === '原始L3' && cs(document.getElementById('restore-template-btn')).display === 'none', { L0: getLayer('L0'), L1: getLayer('L1'), L3: getLayer('L3') });
  }
  // 删除模板（UI）
  applyBtn.click();
  await wait(() => cs(applyModal).display !== 'none', 6000);
  search.value = TPL_NAME; search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const delItem = Array.from(document.querySelectorAll('#template-list .tpl-item')).find((el) => el.textContent.includes(TPL_NAME));
  if (delItem) {
    const delBtn = Array.from(delItem.querySelectorAll('button')).find((b) => b.textContent.trim() === '删除');
    delBtn.click();
    await wait(() => cs(document.getElementById('global-modal')).display === 'flex', 5000);
    document.getElementById('modal-confirm-btn').click();
    await waitToast(/模板已删除/);
    await sleep(500);
    const remain = Array.from(document.querySelectorAll('#template-list .tpl-item')).filter((el) => el.textContent.includes(TPL_NAME)).length;
    push('V4.5 模板删除成功且列表移除', remain === 0, { remain });
  } else push('V4.5 模板删除成功且列表移除', false, { error: 'del item not found' });
  // 关闭应用模板弹窗
  const closeApply = document.querySelector('#template-apply-modal [onclick*="closeTemplateApplyModal"]');
  if (closeApply) closeApply.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  // 快照复制
  const firstRow = document.querySelector('#snapshot-tbody tr');
  const copyBtn = firstRow ? Array.from(firstRow.querySelectorAll('button')).find((b) => b.textContent.includes('复制')) : null;
  if (copyBtn) {
    copyBtn.click();
    const toastCopy = await waitToast(/已复制/);
    push('V4.6 快照 📋 复制触发成功（剪贴板或降级 toast）', !!toastCopy, { toastCopy });
  } else push('V4.6 快照 📋 复制触发成功（剪贴板或降级 toast）', false, { error: 'copy button not found' });
  // 快捷键面板
  document.getElementById('shortcuts-btn').click();
  const scModal = document.getElementById('shortcuts-modal');
  const scOpen = await wait(() => cs(scModal).display !== 'none', 5000);
  await sleep(300);
  const scText = document.getElementById('shortcut-list').innerText;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const scClosed = await wait(() => cs(scModal).display === 'none', 4000);
  push('V4.7 快捷键面板打开（含多条）且 Esc 可关', !!scOpen && scText.split('\n').length >= 3 && !!scClosed, { scOpen, scClosed, sample: scText.slice(0, 80) });
  // 备份按钮
  const exportBtn = document.getElementById('backup-export-btn');
  const importBtn = document.getElementById('backup-import-btn');
  push('V4.8 备份导出/导入入口存在', !!exportBtn && !!importBtn && (exportBtn.title || '').includes('备份') && (importBtn.title || '').includes('备份'), { exportTitle: exportBtn && exportBtn.title, importTitle: importBtn && importBtn.title });
  // 克隆菜单
  const moreBtn = document.querySelector('.menu-child .more-btn');
  if (moreBtn) moreBtn.click();
  await sleep(350);
  const ddText = document.getElementById('global-dropdown').innerText;
  const cloneFound = /克隆项目/.test(ddText);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  push('V4.9 项目“...”菜单含「📄 克隆项目」', cloneFound, { ddText: ddText.replace(/\s+/g, ' ').slice(0, 80) });
  // 基础回归
  push('V4.10 页面基础状态正常（KB 97/快照行/无异常）', /97/.test((document.getElementById('kb-count') || {}).innerText || '') && document.querySelectorAll('#snapshot-tbody tr').length > 0 && errors.length === 0, { kb: (document.getElementById('kb-count') || {}).innerText, snapRows: document.querySelectorAll('#snapshot-tbody tr').length, errors: errors.slice(0, 5) });
  // 清空编辑器
  setLayer('L0', ''); setLayer('L1', ''); setLayer('L3', '');
  await sleep(200);
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));