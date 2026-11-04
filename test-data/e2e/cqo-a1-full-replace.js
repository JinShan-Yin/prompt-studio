// CQO 维度一.1：L0/L1/L3 全量穿透替换 + 生成快照 + 导出 TXT 检查
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  window.__cqo = window.__cqo || { creates: [], exports: [], errors: [], clipboard: null };
  const C = window.__cqo;
  C.creates = []; C.exports = [];
  if (!C.patched) {
    C.patched = true;
    window.addEventListener('error', (e) => C.errors.push('error: ' + String(e.message)));
    window.addEventListener('unhandledrejection', (e) => C.errors.push('unhandled: ' + String(e.reason)));
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      const res = await orig(url, opts);
      try {
        if (u.includes('/api/snapshots/create') && opts && opts.method === 'POST') C.creates.push(await res.clone().json());
        if (u.includes('/api/gate/export')) C.exports.push({ url: u, text: await res.clone().text() });
      } catch (e) {}
      return res;
    };
  }
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  findTree('Trip旅游AI接线员').click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(900);
  const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  // 三层全部写入两个占位符
  setVal('val-L0', 'CQO_A1_L0 行业={{industry}} 目标={{core_goal}} 结尾L0');
  setVal('val-L1', 'CQO_A1_L1 行业={{industry}} 目标={{core_goal}} 结尾L1');
  setVal('val-L3', 'CQO_A1_L3 行业={{industry}} 目标={{core_goal}} 结尾L3');
  // 填写语境
  const ind = document.getElementById('ctx-industry');
  ind.value = 'CQO行业A'; ind.dispatchEvent(new Event('input', { bubbles: true }));
  const addTag = async (inputId, tagsId, text) => {
    const input = document.getElementById(inputId);
    input.focus();
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(60);
  };
  const clearTags = (tagsId) => { const box = document.getElementById(tagsId); while (box.querySelector('.tag-chip-del')) box.querySelector('.tag-chip-del').click(); };
  clearTags('ctx-scene-tags'); clearTags('ctx-goal-tags');
  await addTag('ctx-scene-input', 'ctx-scene-tags', 'CQO场景A');
  await addTag('ctx-goal-input', 'ctx-goal-tags', 'CQO目标A');
  await sleep(200);
  const beforeCreate = C.creates.length;
  const genBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照'));
  genBtn.click();
  await waitUntil(() => C.creates.length > beforeCreate, 20000);
  await sleep(300);
  const resp = C.creates[C.creates.length - 1] || {};
  const fp = resp.final_prompt || '';
  const snapshotId = resp.snapshot_id || '';
  // 页面内直接调用导出接口检查 TXT
  const exportRes = await fetch('/api/gate/export?token=' + token + '&snapshot_id=' + snapshotId);
  const txt = await exportRes.text();
  const braces = (txt.match(/\{\{|\}\}/g) || []);
  const layersHeaders = (fp.match(/### /g) || []).length;
  return {
    pass: resp.success === true && fp.includes('CQO行业A') && fp.includes('CQO目标A') &&
      !/\{\{\s*(industry|core_goal|business_scene)\s*\}\}/.test(fp) &&
      (fp.match(/CQO行业A/g) || []).length === 3 && (fp.match(/CQO目标A/g) || []).length === 3 &&
      braces.length === 0 && layersHeaders === 3 && exportRes.status === 200 && txt.includes('CQO行业A') &&
      /#\s*PROJECT_NAME\s*:\s*\S+/.test(txt),
    snapshotId, finalPrompt: fp.slice(0, 500),
    counts: { industry: (fp.match(/CQO行业A/g) || []).length, goal: (fp.match(/CQO目标A/g) || []).length, scene: (fp.match(/CQO场景A/g) || []).length, headers: layersHeaders, braces: braces.length },
    exportTextHead: txt.slice(0, 400), exportTextTail: txt.slice(-300), exportLen: txt.length,
    exportHasProjectName: /#\s*PROJECT_NAME\s*:/.test(txt),
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));