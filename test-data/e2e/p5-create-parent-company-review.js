// 复核 test：新建父级公司 / 父级+子级一次创建 / 已有父级 / 校验 / 防重 / 复位 / 清理
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 8000, step = 120) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(step); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
  const cs = (el) => getComputedStyle(el);
  const modal = document.getElementById('global-modal');
  const toastText = () => Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join(' | ');
  const waitToast = (re) => wait(() => { const t = toastText(); return re.test(t) ? t : null; }, 6000);
  const api = async (path, body) => (await (await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)).json());
  const companies = async () => ((await api('/api/companies')).data || []);
  const projects = async () => ((await api('/api/projects')).data || []);
  const treeCount = () => ({ parents: document.querySelectorAll('.menu-parent').length, children: document.querySelectorAll('.menu-child').length });
  const activeText = () => { const a = document.querySelector('.menu-child.active'); return a ? a.textContent.trim() : ''; };
  const openCreate = async () => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启新项目'));
    btn.click();
    await wait(() => cs(modal).display === 'flex', 5000);
    await sleep(200);
  };
  const selectNewParentMode = async () => {
    const sel = document.getElementById('modal-company-select');
    sel.value = '__new_company__';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    return { containerShown: cs(document.getElementById('modal-new-company-container')).display !== 'none', placeholder: document.getElementById('modal-input').placeholder };
  };
  const confirm = async () => { document.getElementById('modal-confirm-btn').click(); await sleep(600); };
  // 预清理历史 QA_P5_ 测试数据
  for (const c of (await companies()).filter((x) => x.name && x.name.startsWith('QA_P5_'))) { await api('/api/companies/delete', { id: c.id }); }
  for (const p of (await projects()).filter((x) => x.name && x.name.startsWith('QA_P5_'))) { await api('/api/projects/delete', { id: p.id }); }
  const initialCompanies = await companies();
  const initialProjects = await projects();
  const initialTree = treeCount();
  const samId = (initialCompanies[0] && initialCompanies[0].id) || '';
  const QA = 'QA_P5_' + Date.now().toString().slice(-5);

  // A) 新建父级 + 子级
  await openCreate();
  const sel = document.getElementById('modal-company-select');
  const hasNewOption = Array.from(sel.options).some((o) => o.value === '__new_company__');
  const modeA = await selectNewParentMode();
  push('P5.1 父级下拉包含「新建父级公司」且选中后显示输入框/提示', hasNewOption && modeA.containerShown && modeA.placeholder.includes('留空'), { hasNewOption, modeA });
  document.getElementById('modal-new-company-input').value = QA + '_父A';
  document.getElementById('modal-input').value = QA + '_子A';
  await confirm();
  const toastA = await waitToast(/父级公司 \+ 项目创建成功/);
  await sleep(700);
  const companiesA = await companies();
  const projectsA = await projects();
  const parentA = companiesA.find((c) => c.name === QA + '_父A');
  const childA = projectsA.find((p) => p.name === QA + '_子A');
  push('P5.2 父级+子级一次创建成功（toast/API/树/自动选中）', !!toastA && !!parentA && !!childA && childA.company_id === parentA.id && treeCount().children > initialTree.children && activeText().includes(QA + '_子A'), { toastA, parentId: parentA && parentA.id, childId: childA && childA.id, active: activeText() });

  // B) 仅创建父级（子级留空）
  await openCreate();
  await selectNewParentMode();
  document.getElementById('modal-new-company-input').value = QA + '_父B';
  document.getElementById('modal-input').value = '';
  await confirm();
  const toastB = await waitToast(/父级公司创建成功/);
  await sleep(600);
  const parentB = (await companies()).find((c) => c.name === QA + '_父B');
  const projectsB = await projects();
  push('P5.3 子级留空 → 仅创建父级公司', !!toastB && !!parentB && !projectsB.some((p) => p.company_id === parentB.id), { toastB, parentId: parentB && parentB.id });

  // C) 已有父级 + 子级（保持原逻辑）
  await openCreate();
  const selC = document.getElementById('modal-company-select');
  selC.value = samId;
  selC.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  const existingMode = { containerHidden: cs(document.getElementById('modal-new-company-container')).display === 'none', placeholder: document.getElementById('modal-input').placeholder };
  document.getElementById('modal-input').value = QA + '_子C';
  await confirm();
  const toastC = await waitToast(/创建成功/);
  await sleep(700);
  const childC = (await projects()).find((p) => p.name === QA + '_子C');
  push('P5.4 已有父级下建子项目（原逻辑保持 + 自动选中）', !!toastC && !!childC && childC.company_id === samId && activeText().includes(QA + '_子C'), { toastC, childId: childC && childC.id, active: activeText() });

  // D) 校验：新父级名称空 / 已有父级项目名空
  await openCreate();
  await selectNewParentMode();
  document.getElementById('modal-new-company-input').value = '';
  document.getElementById('modal-input').value = QA + '_孤儿';
  await confirm();
  const toastD = await waitToast(/请输入新父级公司名称/);
  const stillOpenD = cs(modal).display === 'flex';
  document.getElementById('modal-title') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  await openCreate();
  const selE = document.getElementById('modal-company-select');
  selE.value = samId; selE.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('modal-input').value = '';
  await confirm();
  const toastE = await waitToast(/请输入项目名称/);
  push('P5.5 校验规则（新父级必填 / 已有父级项目名必填）', !!toastD && stillOpenD && !!toastE, { toastD, stillOpenD, toastE });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);

  // E) Esc 关闭后重开：状态复位
  await openCreate();
  const reopened = {
    newContainerHidden: cs(document.getElementById('modal-new-company-container')).display === 'none',
    newInputEmpty: document.getElementById('modal-new-company-input').value === '',
    placeholder: document.getElementById('modal-input').placeholder,
    defaultNotNew: document.getElementById('modal-company-select').value !== '__new_company__'
  };
  push('P5.6 关闭后重开：下拉/新父级输入/placeholder 全部复位', reopened.newContainerHidden && reopened.newInputEmpty && reopened.defaultNotNew && reopened.placeholder.includes('项目名称'), reopened);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);

  // F) 公司菜单「新项目」预选已有父级
  const parentNode = document.querySelector('.menu-parent');
  const moreBtn = parentNode ? parentNode.querySelector('.more-btn') : null;
  if (moreBtn) moreBtn.click();
  await sleep(300);
  const newProjectItem = Array.from(document.querySelectorAll('#global-dropdown .dropdown-item')).find((el) => el.textContent.includes('新项目'));
  if (newProjectItem) newProjectItem.click();
  await sleep(500);
  const preselect = { open: cs(modal).display === 'flex', value: document.getElementById('modal-company-select').value, samId, containerHidden: cs(document.getElementById('modal-new-company-container')).display === 'none' };
  push('P5.7 公司菜单「新项目」预选该公司且非新建父级模式', preselect.open && preselect.value === samId && preselect.containerHidden, preselect);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);

  // G) 双击防重（父+子只建一次）
  await openCreate();
  await selectNewParentMode();
  document.getElementById('modal-new-company-input').value = QA + '_父D';
  document.getElementById('modal-input').value = QA + '_子D';
  const confirmBtn = document.getElementById('modal-confirm-btn');
  confirmBtn.click(); confirmBtn.click(); // 同步双点击
  await waitToast(/父级公司 \+ 项目创建成功/);
  await sleep(800);
  const dupCompanies = (await companies()).filter((c) => c.name === QA + '_父D');
  const dupProjects = (await projects()).filter((p) => p.name === QA + '_子D');
  push('P5.8 防双击/重复提交（同名只创建 1 次）', dupCompanies.length === 1 && dupProjects.length === 1, { companies: dupCompanies.length, projects: dupProjects.length });

  // H) 清理测试数据 + 树恢复 + 无异常
  const allCompanies = await companies();
  const testParents = allCompanies.filter((c) => c.name.startsWith('QA_P5_'));
  for (const c of testParents) await api('/api/companies/delete', { id: c.id }); // 后端级联删除其项目
  const leftoverProjects = (await projects()).filter((p) => p.name.startsWith('QA_P5_'));
  for (const p of leftoverProjects) await api('/api/projects/delete', { id: p.id });
  await fetchData();
  await sleep(1200);
  const finalTree = treeCount();
  push('P5.9 测试数据清理干净且树恢复原状', (await companies()).every((c) => !c.name.startsWith('QA_P5_')) && (await projects()).every((p) => !p.name.startsWith('QA_P5_')) && finalTree.parents === initialTree.parents && finalTree.children === initialTree.children, { before: initialTree, after: finalTree });
  push('P5.10 全流程无 JS 异常', errors.length === 0, { errors: errors.slice(0, 5) });
  return { results, pass: results.every((r) => r.ok) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));