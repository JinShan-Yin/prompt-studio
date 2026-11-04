// V3.0 阶段二 Lead E2E：模型配置中心（列表/厂商联动/测试连通性/保存激活）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 30000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = { errors: [], urls: [] };
  window.addEventListener('error', (e) => S.errors.push('error: ' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + String(e.reason)));
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) { S.urls.push(String(url || '')); return origFetch(url, opts); };
  await waitUntil(() => Array.from(document.querySelectorAll('.menu-child')).length >= 1, 20000);
  const modal = document.getElementById('model-config-modal');
  const gear = document.getElementById('api-key-btn');
  gear.click();
  const opened = await waitUntil(() => modal && (getComputedStyle(modal).display !== 'none') && modal.offsetHeight > 0, 8000);
  await sleep(600);
  // 等待模型列表加载
  await waitUntil(() => (document.getElementById('model-list') || {}).innerText, 10000);
  await sleep(300);
  const listText = document.getElementById('model-list').innerText;
  const form = {
    provider: !!document.getElementById('model-provider'),
    baseUrl: !!document.getElementById('model-base-url'),
    modelName: !!document.getElementById('model-name'),
    apiKey: !!document.getElementById('model-api-key'),
    active: !!document.getElementById('model-is-active'),
    testBtn: !!document.getElementById('model-test-btn'),
    saveBtn: !!document.getElementById('model-save-btn')
  };
  const keyType = (document.getElementById('model-api-key') || {}).type;
  // 厂商联动：OpenAI → base_url 自动带出
  const provSel = document.getElementById('model-provider');
  const opt = (text) => Array.from(provSel.options).find((o) => o.textContent.includes(text));
  const openaiOpt = opt('OpenAI');
  if (openaiOpt) { provSel.value = openaiOpt.value; provSel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300); }
  const openaiUrl = document.getElementById('model-base-url').value;
  const deepseekOpt = opt('DeepSeek');
  if (deepseekOpt) { provSel.value = deepseekOpt.value; provSel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300); }
  const deepseekUrl = document.getElementById('model-base-url').value;
  const autoModel = document.getElementById('model-name').value;
  // 留空 Key 测试连通性（回落 .env）
  document.getElementById('model-api-key').value = '';
  document.getElementById('model-test-btn').click();
  const testDone = await waitUntil(() => {
    const el = document.getElementById('model-test-result');
    return el && /连接成功|失败|错误|fetch failed/i.test(el.innerText) ? el.innerText : '';
  }, 60000);
  const testOk = /连接成功/.test(testDone || '');
  // 保存激活模型
  document.getElementById('model-display-name').value = 'V3阶段二-Lead验收';
  document.getElementById('model-is-active').checked = true;
  document.getElementById('model-save-btn').click();
  const saved = await waitUntil(() => (document.getElementById('model-list') || {}).innerText.includes('V3阶段二-Lead验收'), 15000);
  await sleep(500);
  const models = (await (await fetch('/api/models')).json()).data || [];
  const activeModel = models.find((m) => Number(m.is_active) === 1);
  const listTextAfter = document.getElementById('model-list').innerText;
  const domLeak = /sk-[A-Za-z0-9]{24,}/.test(document.body.innerText);
  const activeCount = models.filter((m) => Number(m.is_active) === 1).length;
  const tokenLeaks = S.urls.filter((u) => /[?&]token=/.test(u));
  return {
    pass: !!(opened && form.provider && form.baseUrl && form.modelName && form.apiKey && form.testBtn && form.saveBtn && keyType === 'password' &&
      /openai\.com/.test(openaiUrl) && /deepseek\.com/.test(deepseekUrl) && !!autoModel &&
      testOk && !!saved && !!activeModel && activeModel.display_name === 'V3阶段二-Lead验收' &&
      activeCount === 1 && !domLeak && tokenLeaks.length === 0 && S.errors.length === 0),
    opened: !!opened, form, keyType, listText: listText.slice(0, 300),
    providerSwitch: { openaiUrl, deepseekUrl, autoModel },
    testResult: testDone, testOk,
    saved: !!saved, activeModel: activeModel && { id: activeModel.id, provider: activeModel.provider, model_name: activeModel.model_name, display_name: activeModel.display_name, masked_key: activeModel.masked_key, has_key: activeModel.has_key },
    activeCount, domLeak, tokenLeaks, errors: S.errors.slice(0, 10)
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));