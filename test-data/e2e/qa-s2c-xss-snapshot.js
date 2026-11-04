// 套件二-2.3：正则替换穿透（$& 与 <script> 原样保留，不弹窗）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(200); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  // 选中 Trip
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await wait(() => getComputedStyle(document.getElementById('main-content')).display !== 'none', 8000);
  await sleep(1200);
  // 注入 XSS/正则探针
  window.__qaAlerted = false;
  window.__qaDialog = null;
  const origAlert = window.alert;
  window.alert = (m) => { window.__qaAlerted = true; window.__qaDialog = String(m); };
  const scriptBefore = document.querySelectorAll('script').length;
  const industry = document.getElementById('ctx-industry');
  industry.value = '$& <script>window.__qaXss=1</script>';
  industry.dispatchEvent(new Event('input', { bubbles: true }));
  const l0 = document.getElementById('val-L0');
  l0.value = '行业={{industry}}；QA 穿透测试完成。';
  l0.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  const rowsBefore = document.querySelectorAll('#snapshot-tbody tr').length;
  document.getElementById('generate-snapshot-btn').click();
  const created = await wait(async () => {
    const rows = document.querySelectorAll('#snapshot-tbody tr').length;
    if (rows > rowsBefore) return true;
    const toast = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
    return /生成|快照/.test(toast) && rows >= rowsBefore;
  }, 30000);
  // 若快照列表未刷新则直接查询接口
  const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const snapId = list[0] && list[0].id;
  let detail = null;
  if (snapId) detail = await (await fetch('/api/snapshots/detail?id=' + snapId)).json();
  const prompt = String((detail && detail.data && (detail.data.final_prompt_content || detail.data.final_prompt)) || '');
  const scriptAfter = document.querySelectorAll('script').length;
  const xssRan = typeof window.__qaXss !== 'undefined';
  push('2.3a 快照成功生成', !!created && !!snapId, { created: !!created, snapId });
  push('2.3b 最终 Prompt 原样保留 "$& <script>"', prompt.includes('$& <script>'), { contains: prompt.includes('$& <script>'), sample: prompt.slice(0, 220) });
  push('2.3c 页面未弹窗/未执行注入脚本', window.__qaAlerted === false && xssRan === false && scriptAfter === scriptBefore, { alerted: window.__qaAlerted, xssRan, scriptBefore, scriptAfter });
  // 还原
  industry.value = '旅游行业';
  industry.dispatchEvent(new Event('input', { bubbles: true }));
  l0.value = '';
  l0.dispatchEvent(new Event('input', { bubbles: true }));
  window.alert = origAlert;
  await sleep(300);
  return { results, pass: results.every((r) => r.ok), promptSample: prompt.slice(0, 300) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));