// CQO 维度一.2：清空语境 → 空值兜底必须为「通用」，不得为空或残留占位符
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
  // 清空语境：行业清空 + 两个标签全删
  const ind = document.getElementById('ctx-industry');
  ind.value = ''; ind.dispatchEvent(new Event('input', { bubbles: true }));
  ['ctx-scene-tags', 'ctx-goal-tags'].forEach((id) => { const box = document.getElementById(id); while (box.querySelector('.tag-chip-del')) box.querySelector('.tag-chip-del').click(); });
  setVal('val-L0', 'CQO_A2_L0 行业={{industry}} 场景={{business_scene}} 目标={{core_goal}}');
  setVal('val-L1', 'CQO_A2_L1 行业={{ industry }} 场景={{ business_scene }} 目标={{ core_goal }}');
  setVal('val-L3', 'CQO_A2_L3 目标={{core_goal}}');
  await sleep(300);
  const before = C.creates.length;
  [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照')).click();
  await waitUntil(() => C.creates.length > before, 20000);
  await sleep(300);
  const resp = C.creates[C.creates.length - 1] || {};
  const fp = resp.final_prompt || '';
  const genericCount = (fp.match(/通用/g) || []).length;
  const braces = fp.match(/\{\{|\}\}/g) || [];
  // 检查不存在 "行业= "（空值）这种形式（排除通用填充）
  const emptyAssign = /=\s*(?=\s|；|。|$)/.test(fp);
  const exportRes = await fetch('/api/gate/export?token=' + token + '&snapshot_id=' + (resp.snapshot_id || ''));
  const txt = await exportRes.text();
  return {
    pass: resp.success === true && braces.length === 0 && genericCount >= 7 && !emptyAssign && txt.includes('通用') && !/\{\{/.test(txt),
    snapshotId: resp.snapshot_id,
    genericCount, braces: braces.length,
    emptyAssign,
    finalPrompt: fp,
    exportHead: txt.slice(0, 120),
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));