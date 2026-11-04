// Sprint3 Lead E2E Phase 2：⚙️ API Key 设置弹窗（masked 展示 / 空值保持 / 非法值 400）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 15000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const S = window.__s3 || (window.__s3 = { errors: [], settingsReqs: [], settingsResps: [] });
  S.errors = S.errors || [];
  S.settingsReqs = []; S.settingsResps = [];
  if (!S.settingsPatched) {
    S.settingsPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      const isKey = u.includes('/api/settings/api-key');
      const res = await orig(url, opts);
      if (isKey) {
        try {
          S.settingsReqs.push({ method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
          S.settingsResps.push((await res.clone().json()));
        } catch (e) {}
      }
      return res;
    };
  }
  const modal = document.getElementById('global-modal');
  const btn = document.getElementById('api-key-btn');
  const result = { btnFound: !!btn };
  if (!btn) return result;
  btn.click();
  result.modalOpened = !!(await waitUntil(() => modal.style.display === 'flex', 8000));
  await waitUntil(() => S.settingsResps.length >= 1, 8000);
  await sleep(300);
  const title = document.getElementById('modal-title');
  const msg = document.getElementById('modal-message');
  const input = document.getElementById('modal-input');
  const getData = (S.settingsResps[0] || {}).data || {};
  result.titleText = title ? title.innerText : '';
  result.msgText = msg ? msg.innerText : '';
  result.inputType = input ? input.type : '';
  result.masked = getData.masked;
  result.hasKey = getData.has_key;
  result.maskedShown = !!getData.masked && (msg ? msg.innerText.includes(getData.masked) : false);
  result.noFullKeyLeak = !/sk-[A-Za-z0-9]{20,}/.test(document.body.innerText);
  // 空值保存 → updated:false + 弹窗关闭
  if (input) input.value = '';
  const confirmBtn = document.getElementById('modal-confirm-btn');
  confirmBtn.click();
  const emptyResp = await waitUntil(() => S.settingsResps.some((x) => x && x.updated === false), 8000);
  const closed = await waitUntil(() => modal.style.display !== 'flex', 5000);
  await sleep(300);
  const toastAfterEmpty = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  result.emptySave = { ok: !!emptyResp, closed: !!closed, toast: toastAfterEmpty };
  // 再次打开并输入非法短值 → 400 错误提示，弹窗不关闭
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  btn.click();
  await waitUntil(() => modal.style.display === 'flex', 8000);
  await sleep(300);
  const input2 = document.getElementById('modal-input');
  input2.value = 'abc';
  const postCountBefore = S.settingsResps.length;
  document.getElementById('modal-confirm-btn').click();
  const invalidResp = await waitUntil(() => S.settingsResps.length > postCountBefore, 8000);
  await sleep(500);
  const lastResp = S.settingsResps[S.settingsResps.length - 1] || {};
  const toastInvalid = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  result.invalidSave = {
    got400: !!(invalidResp && lastResp.success === false),
    modalStillOpen: modal.style.display === 'flex',
    toast: toastInvalid
  };
  // 关闭
  const cancel = Array.from(document.querySelectorAll('#global-modal button')).find((b) => /取消|关闭/.test(b.textContent));
  if (cancel) cancel.click();
  await waitUntil(() => modal.style.display !== 'flex', 5000);
  result.closedFinally = modal.style.display !== 'flex';
  // 输入框 type 应恢复为 text（其他 modal 复用）
  const typeAfter = (document.getElementById('modal-input') || {}).type;
  result.inputTypeRestored = typeAfter === 'text';
  result.pass = result.btnFound && result.modalOpened && result.maskedShown && result.inputType === 'password' && result.noFullKeyLeak &&
    result.emptySave.ok && result.emptySave.closed && /保持|未提供/.test(result.emptySave.toast) &&
    result.invalidSave.got400 && result.invalidSave.modalStillOpen && /不正确|失败|格式/.test(result.invalidSave.toast) &&
    result.closedFinally && result.inputTypeRestored && S.errors.length === 0;
  result.errors = S.errors.slice();
  return result;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));