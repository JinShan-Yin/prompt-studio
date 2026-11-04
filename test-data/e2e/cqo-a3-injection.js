// CQO 维度一.3：行业输入 $&$& <script>alert(1)</script> \n → 必须完整保留、结构不破坏、后端不炸
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
  const INJECT = '$&$& <script>alert(1)</script> \\n';
  const ind = document.getElementById('ctx-industry');
  ind.value = INJECT; ind.dispatchEvent(new Event('input', { bubbles: true }));
  setVal('val-L0', 'CQO_A3_L0 行业[{{industry}}] 结束标记L0');
  setVal('val-L1', 'CQO_A3_L1 原样{{industry}}');
  setVal('val-L3', 'CQO_A3_L3 尾{{industry}}');
  await sleep(300);
  const before = C.creates.length;
  [...document.querySelectorAll('button')].find((b) => b.textContent.includes('组装并生成快照')).click();
  await waitUntil(() => C.creates.length > before, 20000);
  await sleep(300);
  const resp = C.creates[C.creates.length - 1] || {};
  const fp = resp.final_prompt || '';
  const keepsSpecial = fp.includes('$&$&') && !fp.includes('$&$& '.repeat(2)); // 不应被二次替换
  const keepsScript = fp.includes('<script>alert(1)</script>');
  const keepsSlashN = fp.includes('\\n');
  const industryCount = (fp.match(/\$&\$&/g) || []).length;
  const headers = (fp.match(/### /g) || []).length;
  const braces = (fp.match(/\{\{|\}\}/g) || []).length;
  const exportRes = await fetch('/api/gate/export?token=' + token + '&snapshot_id=' + (resp.snapshot_id || ''));
  const txt = await exportRes.text();
  return {
    pass: resp.success === true && industryCount === 3 && keepsScript && keepsSlashN && headers === 3 && braces === 0 && txt.includes('$&$&') && exportRes.status === 200,
    snapshotId: resp.snapshot_id,
    inject: INJECT,
    industryCount, keepsScript, keepsSlashN, headers, braces,
    finalPromptHead: fp.slice(0, 400),
    exportStatus: exportRes.status,
    errors: C.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));