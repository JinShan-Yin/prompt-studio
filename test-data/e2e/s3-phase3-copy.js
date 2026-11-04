// Sprint3 Lead E2E Phase 3：复制为 NewLync Text（/api/prompt/assemble → 剪贴板，不生成快照）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const S = window.__s3 || (window.__s3 = { errors: [], createReqs: [], assembleReqs: [], assembleResps: [] });
  S.errors = S.errors || [];
  S.assembleReqs = []; S.assembleResps = [];
  if (!S.copyPatched) {
    S.copyPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      const res = await orig(url, opts);
      if (u.includes('/api/prompt/assemble')) {
        try { S.assembleReqs.push(JSON.parse(opts.body)); S.assembleResps.push((await res.clone().json())); } catch (e) {}
      }
      return res;
    };
    // 剪贴板 stub（真实权限在自动化环境可能被拒，改为记录写入内容）
    window.__copied = null;
    window.__clipFallback = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copied = t; } }
      });
    } catch (e) { window.__clipErr = String(e && e.message); }
    const origExec = document.execCommand ? document.execCommand.bind(document) : null;
    document.execCommand = function (cmd, ...args) {
      if (String(cmd).toLowerCase() === 'copy') { window.__clipFallback = document.activeElement ? document.activeElement.value : null; return true; }
      return origExec ? origExec(cmd, ...args) : false;
    };
  }
  const btn = document.getElementById('copy-prompt-btn');
  if (!btn) return { pass: false, fatal: '未找到 #copy-prompt-btn' };
  const listBefore = await fetch('/api/snapshots/list?token=' + token + '&project_id=proj-597e1045').then((r) => r.json());
  const countBefore = (listBefore.data || []).length;
  const createReqsBefore = S.createReqs.length;
  btn.click();
  const resp = await waitUntil(() => S.assembleResps.length > 0, 20000);
  const copied = await waitUntil(() => !!window.__copied, 8000);
  await sleep(400);
  const req = S.assembleReqs[0] || {};
  const body = S.assembleResps[0] || {};
  const finalPrompt = body.final_prompt || '';
  const listAfter = await fetch('/api/snapshots/list?token=' + token + '&project_id=proj-597e1045').then((r) => r.json());
  const countAfter = (listAfter.data || []).length;
  const toastText = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  const reqLayers = req.layers || [];
  return {
    pass: !!(resp && body.success === true && typeof finalPrompt === 'string' && finalPrompt.length > 0 &&
      window.__copied === finalPrompt && /复制/.test(toastText) &&
      reqLayers.length === 3 && countBefore === countAfter && S.createReqs.length === createReqsBefore &&
      finalPrompt.includes('旅游行业') && !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(finalPrompt) && S.errors.length === 0),
    assembleSuccess: !!(resp && body.success),
    copiedMatches: window.__copied === finalPrompt,
    copiedLength: window.__copied ? window.__copied.length : 0,
    finalPromptLength: finalPrompt.length,
    reqLayers: reqLayers.length,
    replacedIndustry: finalPrompt.includes('旅游行业'),
    noPlaceholder: !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(finalPrompt),
    snapshotCountBefore: countBefore, snapshotCountAfter: countAfter,
    noNewSnapshot: countBefore === countAfter && S.createReqs.length === createReqsBefore,
    toastText: toastText.slice(0, 300),
    clipErr: window.__clipErr || null,
    errors: S.errors.slice()
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));