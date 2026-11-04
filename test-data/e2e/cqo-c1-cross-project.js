// CQO 维度三.1：跨项目语境防串号（A 生成快照 → 切 B 清空/改语境 → B 快照不得沾染 A 变量）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const C = window.__cqo;
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setIndustry = (v) => { const el = document.getElementById('ctx-industry'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const clearTags = () => ['ctx-scene-tags', 'ctx-goal-tags'].forEach((id) => { const box = document.getElementById(id); while (box.querySelector('.tag-chip-del')) box.querySelector('.tag-chip-del').click(); });
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const select = async (name) => { findTree(name).click(); await waitUntil(() => document.getElementById('main-content').style.display === 'block', 10000); await sleep(700); };
  const gen = async () => {
    const before = C.creates.length;
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照')).click();
    await waitUntil(() => C.creates.length > before, 20000);
    await sleep(250);
    return C.creates[C.creates.length - 1] || {};
  };
  // ---- 项目 A（Trip）----
  await select('Trip旅游AI接线员');
  setIndustry('PROJ_A_行业_9F3');
  clearTags();
  setVal('val-L0', 'A项目测试 行业={{industry}}');
  setVal('val-L1', 'A项目 L1');
  setVal('val-L3', 'A项目 L3');
  await sleep(250);
  const respA = await gen();
  const fpA = respA.final_prompt || '';
  // ---- 立即切项目 B（途牛热线），并制造 pending autosave 竞态 ----
  setIndustry('PROJ_A_PENDING_XXX'); // 触发 800ms 自动保存，但马上切项目
  await select('途牛热线');
  setIndustry(''); // B 清空行业
  clearTags();
  setVal('val-L0', 'B项目测试 行业={{industry}} 场景={{business_scene}} 目标={{core_goal}}');
  setVal('val-L1', 'B项目 L1');
  setVal('val-L3', 'B项目 L3');
  await sleep(1000); // 等 A 的 pending autosave 若串号则已发生
  const ctxB = await fetch('/api/context/get?token=' + token + '&project_id=proj-7ec6f484').then((r) => r.json());
  const respB = await gen();
  const fpB = respB.final_prompt || '';
  // ---- 回 A 检查其语境未被 B 覆盖、未被 pending 串写 ----
  await select('Trip旅游AI接线员');
  await sleep(900);
  const ctxA = await fetch('/api/context/get?token=' + token + '&project_id=proj-597e1045').then((r) => r.json());
  const uiAIndustry = document.getElementById('ctx-industry').value;
  return {
    pass: respA.success === true && fpA.includes('PROJ_A_行业_9F3') &&
      respB.success === true && !fpB.includes('PROJ_A_行业_9F3') && !fpB.includes('PROJ_A_PENDING') &&
      (fpB.match(/通用/g) || []).length >= 3 && !/\{\{/.test(fpB) &&
      !['PROJ_A_行业_9F3', 'PROJ_A_PENDING_XXX'].includes(ctxB.data.industry || '') &&
      !String(ctxB.data.industry || '').includes('PROJ_A') &&
      ctxA.data.industry === 'PROJ_A_行业_9F3' && uiAIndustry === 'PROJ_A_行业_9F3',
    A: { snapshotId: respA.snapshot_id, fpHead: fpA.slice(0, 200), ctxIndustry: ctxA.data.industry, uiIndustry: uiAIndustry },
    B: { snapshotId: respB.snapshot_id, fp: fpB, ctxIndustry: ctxB.data.industry, genericCount: (fpB.match(/通用/g) || []).length },
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));