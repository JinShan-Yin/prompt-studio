// CQO 产物证据：生成一份生产级终态快照（三层均含占位符/业务标签），供真实下载 TXT 验收
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const C = window.__cqo = window.__cqo || { errors: [] };
  C.creates = C.creates || [];
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const ind = document.getElementById('ctx-industry');
  ind.value = '星汇Mall'; ind.dispatchEvent(new Event('input', { bubbles: true }));
  const clearTags = (id) => { const box = document.getElementById(id); while (box.querySelector('.tag-chip-del')) box.querySelector('.tag-chip-del').click(); };
  clearTags('ctx-scene-tags'); clearTags('ctx-goal-tags');
  const addTag = async (inputId, boxes, text) => { const input = document.getElementById(inputId); input.value = text; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(50); };
  await addTag('ctx-scene-input', 'scene', '售后退换货');
  await addTag('ctx-scene-input', 'scene', '停车缴费');
  await addTag('ctx-goal-input', 'goal', '安抚客户情绪');
  await addTag('ctx-goal-input', 'goal', '准确提供价格');
  setVal('val-L0', '你是面向 {{industry}} 领域的智能语音客服助手。\n当前业务场景：{{business_scene}}。\n核心目标：{{core_goal}}。\n严格保持 <speak> 与 <tool> 业务标签，禁止 Markdown。');
  setVal('val-L1', '语音基座：所有回复必须整体使用 <speak>...</speak> 包裹；如需转人工，先播报话术再输出 <tool>transfer</tool>。');
  setVal('val-L3', '项目话术：{{industry}} 客户咨询时，优先围绕 {{business_scene}} 提供服务，确保 {{core_goal}}。');
  await sleep(500);
  const before = C.creates.length;
  [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照')).click();
  await waitUntil(() => C.creates.length > before, 20000);
  await sleep(1200); // 等快照表刷新
  const resp = C.creates[C.creates.length - 1] || {};
  const fp = resp.final_prompt || '';
  const rows = document.querySelectorAll('#snapshot-tbody tr');
  const firstRowBtn = rows[0] ? rows[0].querySelector('button') : null;
  return {
    pass: resp.success === true && !/\{\{|\}\}/.test(fp) && (fp.match(/### /g) || []).length === 3 && fp.includes('星汇Mall') && fp.includes('售后退换货、停车缴费') && fp.includes('安抚客户情绪、准确提供价格'),
    snapshotId: resp.snapshot_id,
    rows: rows.length,
    firstRowBtnText: firstRowBtn ? firstRowBtn.textContent.trim() : '',
    finalPrompt: fp,
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));