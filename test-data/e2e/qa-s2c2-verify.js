// 套件二-2.3（修正检测）：生成新快照（以 API 最新快照 ID 变化为准）并断言 $& <script> 原样保留、无弹窗
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const trip = Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes('Trip旅游AI接线员'));
  if (trip) trip.click();
  await sleep(1400);
  const before = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
  const beforeId = before[0] && before[0].id;
  window.__qaAlerted = false;
  const origAlert = window.alert;
  window.alert = () => { window.__qaAlerted = true; };
  const scriptBefore = document.querySelectorAll('script').length;
  const industry = document.getElementById('ctx-industry');
  industry.value = '$& <script>window.__qaXss2=1</script>';
  industry.dispatchEvent(new Event('input', { bubbles: true }));
  const l0 = document.getElementById('val-L0');
  l0.value = '行业={{industry}}；QA 穿透测试完成。';
  l0.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);
  document.getElementById('generate-snapshot-btn').click();
  const changed = await wait(async () => {
    const list = (await (await fetch('/api/snapshots/list?project_id=proj-597e1045')).json()).data || [];
    return list[0] && list[0].id && list[0].id !== beforeId ? list[0].id : null;
  }, 30000);
  const newId = changed || null;
  let prompt = '';
  if (newId) {
    const detail = await (await fetch('/api/snapshots/detail?id=' + newId)).json();
    prompt = String((detail.data && (detail.data.final_prompt_content || detail.data.final_prompt)) || '');
  }
  push('2.3a 生成快照成功（最新快照 ID 变化）', !!newId, { beforeId, newId });
  push('2.3b 最终 Prompt 原样保留 "$& <script>"', prompt.includes('$& <script>'), { contains: prompt.includes('$& <script>'), sample: prompt.slice(0, 220) });
  push('2.3c 页面未弹窗/未执行注入脚本', window.__qaAlerted === false && typeof window.__qaXss2 === 'undefined' && document.querySelectorAll('script').length === scriptBefore, { alerted: window.__qaAlerted, xssRan: typeof window.__qaXss2 !== 'undefined', scriptBefore, scriptAfter: document.querySelectorAll('script').length });
  industry.value = '旅游行业';
  industry.dispatchEvent(new Event('input', { bubbles: true }));
  l0.value = '';
  l0.dispatchEvent(new Event('input', { bubbles: true }));
  window.alert = origAlert;
  return { results, pass: results.every((r) => r.ok), promptSample: prompt.slice(0, 200) };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));