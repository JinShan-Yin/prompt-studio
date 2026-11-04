// Sprint3 Lead E2E Phase 5：Sprint1/2 功能回归抽查（Token/高亮/语境/搜索/聊天/批量）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = window.__s3 || (window.__s3 = { errors: [] });
  S.errors = S.errors || [];
  const ta = document.getElementById('val-L0');
  const mirror = document.getElementById('mirror-L0');
  ta.value = '回归：{{industry}} 橙色高亮，<speak>您好</speak>';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(350);
  const stats = { chars: (document.getElementById('stats-chars') || {}).innerText, tokens: (document.getElementById('stats-tokens') || {}).innerText };
  const expectedChars = String(ta.value.length + document.getElementById('val-L1').value.length + document.getElementById('val-L3').value.length);
  const span = mirror.querySelector('span');
  const orange = span ? getComputedStyle(span).color === 'rgb(245, 158, 11)' : false;
  const speakText = !mirror.querySelector('speak') && (mirror.textContent || '').includes('<speak>');
  const heights = { ta: ta.clientHeight, mirror: mirror.clientHeight, diff: Math.abs(ta.clientHeight - mirror.clientHeight) };

  // 语境回填
  const ctxIndustry = (document.getElementById('ctx-industry') || {}).value;
  const scenes = document.querySelectorAll('#ctx-scene-tags .tag-chip').length;

  // KB 搜索
  const kbSearch = document.getElementById('kb-search');
  kbSearch.value = '纠纷'; kbSearch.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  const kbCountText = (document.getElementById('kb-count') || {}).innerText;
  const kbFiltered = (document.getElementById('kb-list-container').textContent.match(/Q[:：]/g) || []).length;
  kbSearch.value = ''; kbSearch.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);

  // 聊天/批量入口与快照回滚按钮
  const chatReady = !!(document.getElementById('chat-input') && document.getElementById('chat-send-btn') && document.getElementById('chat-messages'));
  const batchReady = !!(document.getElementById('batch-file') && document.getElementById('batch-run-btn') && document.getElementById('batch-progress-bar'));
  const rollbackReady = !!Array.from(document.querySelectorAll('#snapshot-tbody button')).find((b) => b.textContent.includes('回滚'));
  const gearReady = !!document.getElementById('api-key-btn');
  const copyReady = !!document.getElementById('copy-prompt-btn');
  const zipReady = !!document.getElementById('export-zip-btn');
  // 清空演示文本（三层都清，确保统计回到 0）
  ['val-L0', 'val-L1', 'val-L3'].forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  await sleep(250);
  const cleared = (document.getElementById('stats-chars') || {}).innerText === '0';

  return {
    pass: stats.chars === expectedChars && orange && speakText && heights.diff <= 1 && !!ctxIndustry && scenes >= 0 &&
      kbFiltered > 0 && /匹配/.test(kbCountText) && chatReady && batchReady && rollbackReady && gearReady && copyReady && zipReady &&
      cleared && S.errors.length === 0,
    stats, expectedChars, orange, speakText, heights,
    ctxIndustry, scenes, kbFiltered, kbCountText,
    ready: { chatReady, batchReady, rollbackReady, gearReady, copyReady, zipReady },
    cleared,
    errors: S.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));