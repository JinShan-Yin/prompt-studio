// CQO 维度三.2：左侧重命名项目 → 下载旧快照 TXT，头部元数据项目名称必须同步更新
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const C = window.__cqo = window.__cqo || { errors: [] };
  C.errors = C.errors || [];
  if (!C.patched) {
    C.patched = true;
    window.addEventListener('error', (e) => C.errors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => C.errors.push('unhandled: ' + String(e.reason)));
  }
  const PROJECT = 'proj-597e1045';
  const OLD = 'Trip旅游AI接线员';
  const NEW = 'Trip旅游AI接线员_CQO_RENAMED';
  // 取一个本项目的旧快照
  const list = await fetch('/api/snapshots/list?token=' + token + '&project_id=' + PROJECT).then((r) => r.json());
  const snapId = (list.data || [])[0] && list.data[0].id;
  // 通过 UI 重命名：点击当前选中项目的 more 按钮 → 下拉「重命名」
  const active = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(OLD));
  const moreBtn = active ? active.querySelector('.more-btn') : null;
  let menuOpened = false, renameItemFound = false;
  if (moreBtn) {
    moreBtn.click();
    menuOpened = !!(await waitUntil(() => {
      const dd = document.getElementById('global-dropdown');
      return dd && getComputedStyle(dd).display === 'block';
    }, 5000));
    const renameItem = Array.from(document.querySelectorAll('#global-dropdown .dropdown-item')).find((el) => /重命名/.test(el.textContent));
    renameItemFound = !!renameItem;
    if (renameItem) renameItem.click();
  }
  const modal = document.getElementById('global-modal');
  const modalOpened = !!(await waitUntil(() => modal.style.display === 'flex', 5000));
  await sleep(250);
  const input = document.getElementById('modal-input');
  const inputValueBefore = input ? input.value : '';
  if (input) { input.value = NEW; input.dispatchEvent(new Event('input', { bubbles: true })); }
  document.getElementById('modal-confirm-btn').click();
  const renamed = await waitUntil(() => Array.from(document.querySelectorAll('.menu-child')).some((e) => e.textContent.includes(NEW)), 10000);
  await sleep(400);
  // 重命名后下载旧快照 TXT 检查头部（**不加缓存穿透参数**，验证服务端 no-store 头彻底解决旧元数据缓存）
  const dbName = (await (await fetch('/api/projects?token=' + token)).json()).data.find((p) => p.id === PROJECT).name;
  const res = await fetch('/api/gate/export?token=' + token + '&snapshot_id=' + snapId);
  const txt = await res.text();
  const head = txt.split('\n').slice(0, 10).join('\n');
  const hasProjectNameLine = /#\s*PROJECT_NAME\s*:/.test(head);
  const nameSynced = head.includes(NEW);
  // 恢复原名称（API）
  await fetch('/api/projects/update?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: PROJECT, name: OLD }) });
  await sleep(500);
  return {
    pass: randPass(),
    snapshotId: snapId,
    menuOpened, renameItemFound, modalOpened, inputValueBefore,
    renamed: !!renamed,
    dbName,
    head,
    hasProjectNameLine, nameSynced,
    txtHead: head,
    errors: C.errors.slice()
  };
  function randPass() { return false; }
});
// 重新计算 pass（需在函数内取变量，故以返回的原始字段为准）
out.pass = !!(out.menuOpened && out.renameItemFound && out.modalOpened && out.renamed && out.hasProjectNameLine && out.nameSynced);
console.log('@@DSH_RESULT@@' + JSON.stringify(out));