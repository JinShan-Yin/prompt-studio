// test-data/e2e/browser-e2e.js
// 用途：通过 ego_script 在真实浏览器（http://127.0.0.1:3081/?token=...）里执行 Sprint 1 强制自测。
// 执行方式：ego_script({ script: <本文件内容> })。
// 依赖：页面已加载 Prompt Studio，tree 中项目「Trip旅游AI接线员」(proj-597e1045) 与「途牛热线」存在。
const result = await page.evaluate(async () => {
  const out = [];
  const R = (name, pass, detail) => out.push({ name, pass: !!pass, detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 20000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const $ = (id) => document.getElementById(id);
  const findTreeItem = (text) => Array.from(document.querySelectorAll('.menu-child')).find((el) => el.textContent.includes(text));
  const setTextarea = (el, text) => { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const cs = (el) => getComputedStyle(el);
  const captureErrors = [];
  window.addEventListener('error', (e) => captureErrors.push(String(e.message)));

  const LAYERS = ['L0', 'L1', 'L3'];
  const token = new URLSearchParams(location.search).get('token') || '';

  // mock fetch 捕获（在流程早期安装，记录 snapshots/create 与 context/extract 请求）
  const cap = { snapshotReq: null, snapshotResp: null, extractCalls: 0, kbListCalls: 0, extractResp: null };
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url || '');
    const body = opts && opts.body ? opts.body : null;
    if (u.includes('/api/context/extract')) cap.extractCalls++;
    if (u.includes('/api/kb/list')) cap.kbListCalls++;
    if (u.includes('/api/snapshots/create')) {
      try { cap.snapshotReq = JSON.parse(body); } catch (e) {}
    }
    const res = await origFetch(url, opts);
    if (u.includes('/api/snapshots/create')) {
      try { cap.snapshotResp = await res.clone().json(); } catch (e) {}
    }
    if (u.includes('/api/context/extract')) {
      try { cap.extractResp = await res.clone().json(); } catch (e) {}
    }
    return res;
  };
  const norm = (s) => String(s == null ? '' : s).replace(/\u00A0/g, ' ');

  // ---------- 0. 选中项目 ----------
  const projNode = findTreeItem('Trip旅游AI接线员');
  R('左侧树存在目标项目节点', !!projNode);
  if (!projNode) return { pass: false, out, errors: captureErrors };
  projNode.click();
  const shown = await waitUntil(() => $('main-content') && $('main-content').style.display === 'block');
  R('选中项目后主内容区显示', !!shown);
  await waitUntil(() => $('ctx-industry') && $('val-L0') && $('mirror-L0'));
  await sleep(900); // 等语境回填完成

  // ---------- 1. AI 智能提取（真实 LLM，先跑，避免覆盖后续手填值） ----------
  const extractBtn = $('ctx-extract-btn');
  R('AI 提取按钮存在', !!extractBtn);
  const beforeExtract = { calls: cap.extractCalls };
  if (extractBtn) {
    // 先把语境清空，确保后面验证的是“提取真的回填了”，而不是旧值
    const ind0 = $('ctx-industry');
    ind0.value = ''; ind0.dispatchEvent(new Event('input', { bubbles: true }));
    ['#ctx-scene-tags', '#ctx-goal-tags'].forEach((sel) => {
      const box = document.querySelector(sel);
      while (box && box.querySelector('.tag-chip-del')) box.querySelector('.tag-chip-del').click();
    });
    await sleep(300);
    extractBtn.click();
    const got = await waitUntil(() => cap.extractResp, 120000, 200);
    await sleep(500); // 等待回填渲染 + finally 恢复按钮
    const ind = $('ctx-industry') ? $('ctx-industry').value.trim() : '';
    const sceneN = document.querySelectorAll('#ctx-scene-tags .tag-chip').length;
    const goalN = document.querySelectorAll('#ctx-goal-tags .tag-chip').length;
    const apiData = (cap.extractResp && cap.extractResp.data) || null;
    cap.extractRealResult = { ind, sceneN, goalN, apiData };
    R('点击 AI 提取 → 发出 /api/context/extract 请求并收到响应', cap.extractCalls > beforeExtract.calls && !!cap.extractResp, { calls: cap.extractCalls });
    R('AI 提取响应 success 且结构合法', !!(cap.extractResp && cap.extractResp.success === true && apiData && typeof apiData.industry === 'string' && Array.isArray(apiData.business_scene) && Array.isArray(apiData.core_goal)), apiData);
    R('AI 提取结果回填到 UI（行业一致 + 标签数量一致）', !!apiData && ind === String(apiData.industry || '').trim() && sceneN === apiData.business_scene.length && goalN === apiData.core_goal.length, { ind, sceneN, goalN, api: apiData });
    R('AI 提取后按钮已恢复可用', extractBtn.disabled === false);
    await sleep(200);
    // 清理 toast
    document.querySelectorAll('.toast').forEach((t) => t.remove());
  }

  // ---------- 2. Token 实时预估（含 50ms 防抖） ----------
  const ta0 = $('val-L0'), ta1 = $('val-L1'), ta3 = $('val-L3');
  R('三个 textarea 与 mirror 均存在', !!(ta0 && ta1 && ta3 && $('mirror-L0') && $('mirror-L1') && $('mirror-L3')));
  R('编辑区无 contenteditable', document.querySelectorAll('[contenteditable]').length === 0);
  // 防抖证据：先清空三框拿到基线 0，再 input 后同步读取仍为旧值，等待 >50ms 后更新
  setTextarea(ta0, '');
  setTextarea(ta1, '');
  setTextarea(ta3, '');
  await sleep(150);
  const baseChars = $('stats-chars').innerText;
  setTextarea(ta0, 'X');
  const immediate = $('stats-chars').innerText;
  await sleep(120);
  const afterDebounce = $('stats-chars').innerText;
  R('Token 统计为 50ms 防抖（input 后同步不更新，等待后更新）', baseChars === '0' && immediate === '0' && afterDebounce === '1', { baseChars, immediate, afterDebounce });
  // 精确公式校验：总字符 = 三框长度和，Token = ceil(*0.6)
  const l0text = 'A'.repeat(1000);
  setTextarea(ta0, l0text);
  setTextarea(ta1, 'B'.repeat(234));
  setTextarea(ta3, 'C'.repeat(56));
  await sleep(150);
  const totalChars = 1000 + 234 + 56;
  R('字符统计 = L0+L1+L3 总字符数（1290）', $('stats-chars').innerText === String(totalChars), { got: $('stats-chars').innerText });
  R('Token 预估 = Math.ceil(总字符*0.6)（774）', $('stats-tokens').innerText === String(Math.ceil(totalChars * 0.6)), { got: $('stats-tokens').innerText });

  // ---------- 3. 超长文本 + 跨行变量：高亮、对齐、自动撑高 ----------
  const longLines = [];
  for (let i = 1; i <= 220; i++) {
    longLines.push(`第${i}行：超长提示词测试内容，用于验证镜像层与透明 textarea 的像素级对齐（含中文、English words、连续空格  两个）。变量 {{var_${i % 5}}}。`);
  }
  const longText =
    '<speak>业务标签必须保持原文</speak> 第一行包含 {{industry}} 与 <tool> 标签测试\n' +
    longLines.join('\n') +
    '\n跨行变量开始 {{\nnewline test\n}} 结束\n末尾空行测试\n';
  setTextarea(ta0, longText);
  await sleep(250);
  const mirror0 = $('mirror-L0');
  R('mirror 渲染出橙色 span 高亮', mirror0.querySelectorAll('span').length > 200, { spans: mirror0.querySelectorAll('span').length });
  const firstSpan = mirror0.querySelector('span');
  R('高亮颜色 = #f59e0b (rgb(245, 158, 11))', firstSpan && cs(firstSpan).color === 'rgb(245, 158, 11)', { color: firstSpan && cs(firstSpan).color });
  const spans = Array.from(mirror0.querySelectorAll('span'));
  const crossLine = spans.find((s) => norm(s.textContent).includes('newline test') && s.textContent.includes('{{'));
  R('跨行变量 {{\\nnewline test\\n}} 被整体高亮', !!crossLine, { found: !!crossLine, text: crossLine && JSON.stringify(crossLine.textContent) });
  R('<speak> 业务标签保持原文（未转 HTML 元素）', ta0.value.includes('<speak>') && mirror0.textContent.includes('<speak>'));
  R('<speak> 在镜像层被转义为文本而非元素', mirror0.querySelector('speak') === null);

  // 样式完全一致
  const props = ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'letterSpacing', 'fontWeight', 'textIndent'];
  LAYERS.forEach((L) => {
    const ta = $('val-' + L), mi = $('mirror-' + L);
    const a = cs(ta), b = cs(mi);
    const diff = props.filter((p) => a[p] !== b[p]).map((p) => p + ':' + a[p] + '/' + b[p]);
    const wDiff = Math.abs(ta.getBoundingClientRect().width - mi.getBoundingClientRect().width);
    R(L + ' 两层样式完全一致（' + props.length + ' 属性 + 宽度）', diff.length === 0 && wDiff < 0.5, { diff, wDiff });
  });
  // textarea 必须的透明输入属性
  const taCss = cs(ta0);
  R('textarea 透明高亮输入属性正确（resize/background/color/caret/overflow）',
    taCss.resize === 'none' && (taCss.backgroundColor === 'rgba(0, 0, 0, 0)' || taCss.backgroundColor === 'transparent') &&
    (taCss.color === 'rgba(0, 0, 0, 0)' || taCss.color === 'transparent') && taCss.caretColor === 'rgb(51, 51, 51)' && taCss.overflowY === 'hidden',
    { resize: taCss.resize, bg: taCss.backgroundColor, color: taCss.color, caret: taCss.caretColor, overflow: taCss.overflowY });
  R('mirror 在 textarea 下层（z-index 更低）', parseInt(cs(mirror0).zIndex, 10) < parseInt(taCss.zIndex, 10), { mirror: cs(mirror0).zIndex, textarea: taCss.zIndex });
  R('mirror 不接收鼠标事件（pointer-events:none）', cs(mirror0).pointerEvents === 'none');

  // 自动撑高 + 高度同步
  const hDiff = Math.abs(ta0.clientHeight - mirror0.clientHeight);
  R('长文本后 textarea 自动撑高（高度 > 3000px）', ta0.clientHeight > 3000, { textareaH: ta0.clientHeight });
  R('textarea 与 mirror 高度同步（clientHeight 差 ≤1px）', hDiff <= 1, { taH: ta0.clientHeight, mirrorH: mirror0.clientHeight, diff: hDiff });
  R('textarea 无内部滚动（scrollHeight≈clientHeight≤1px）', Math.abs(ta0.scrollHeight - ta0.clientHeight) <= 1, { scrollH: ta0.scrollHeight, clientH: ta0.clientHeight });
  const lineDiff = Math.abs(mirror0.scrollHeight - ta0.scrollHeight);
  R('两层内容总高度一致（末行不塌，差 ≤ 22px 即一行以内）', lineDiff <= 22, { mirrorScrollH: mirror0.scrollHeight, taScrollH: ta0.scrollHeight, diff: lineDiff });

  // 滚动同步（人为把两层都设为可滚后派发 scroll，验证 mirror 跟随；随后恢复自动撑高）
  ta0.style.height = '120px';
  mirror0.style.height = '120px';
  ta0.scrollTop = 200;
  ta0.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(80);
  const sDiff = Math.abs(mirror0.scrollTop - ta0.scrollTop);
  R('scroll 事件后 mirror.scrollTop 与 textarea 同步', sDiff <= 1, { ta: ta0.scrollTop, mirror: mirror0.scrollTop, diff: sDiff });
  window.refreshAllEditorMirrors();
  await sleep(80);

  // ---------- 4. Tag 组件：中文输入法 / 增删 / 去重 / XSS ----------
  const sceneInput = $('ctx-scene-input');
  const sceneTags = $('ctx-scene-tags');
  // 清空场景标签（点击 ×）
  while (sceneTags.querySelector('.tag-chip-del')) sceneTags.querySelector('.tag-chip-del').click();
  await sleep(50);
  R('清空场景标签后为 0', sceneTags.querySelectorAll('.tag-chip').length === 0);
  sceneInput.focus();
  sceneInput.value = 'shouhou tuihuan';
  const dispatchKey = (init, keyCodeOverride) => {
    let e;
    try { e = new KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, init)); }
    catch (err) { e = new Event('keydown', { bubbles: true, cancelable: true }); e.key = init.key || 'Enter'; }
    if (!('isComposing' in e)) Object.defineProperty(e, 'isComposing', { get: () => !!init.isComposing });
    if (keyCodeOverride) Object.defineProperty(e, 'keyCode', { get: () => keyCodeOverride });
    sceneInput.dispatchEvent(e);
  };
  dispatchKey({ isComposing: true });
  await sleep(30);
  R('中文输入法组合态（isComposing:true）回车不生成 Tag', sceneTags.querySelectorAll('.tag-chip').length === 0);
  dispatchKey({}, 229);
  await sleep(30);
  R('keyCode===229 组合态回车不生成 Tag', sceneTags.querySelectorAll('.tag-chip').length === 0);
  dispatchKey({});
  await sleep(50);
  R('组合结束后正常回车生成 Tag', sceneTags.querySelectorAll('.tag-chip').length === 1, { n: sceneTags.querySelectorAll('.tag-chip').length });
  R('添加后输入框已清空', sceneInput.value === '');
  // 重复 / 空白
  sceneInput.value = 'shouhou tuihuan'; dispatchKey({}); await sleep(30);
  sceneInput.value = '   '; dispatchKey({}); await sleep(30);
  sceneInput.value = ''; dispatchKey({}); await sleep(30);
  R('重复值 / 空白 / 空字符串均不重复添加', sceneTags.querySelectorAll('.tag-chip').length === 1, { n: sceneTags.querySelectorAll('.tag-chip').length });
  // 添加第二个并点 × 删除
  sceneInput.value = '停车缴费'; dispatchKey({}); await sleep(50);
  R('可添加第二个标签', sceneTags.querySelectorAll('.tag-chip').length === 2);
  const delBtn = sceneTags.querySelector('.tag-chip-del');
  delBtn.click(); await sleep(50);
  R('点击 × 可删除标签', sceneTags.querySelectorAll('.tag-chip').length === 1, { n: sceneTags.querySelectorAll('.tag-chip').length });
  // XSS 防护
  sceneInput.value = '<img src=x onerror=window.__xss=1>'; dispatchKey({}); await sleep(50);
  R('标签文本按纯文本渲染（无 XSS，无 img 元素）', sceneTags.querySelector('img') === null && !window.__xss, { hasImg: !!sceneTags.querySelector('img'), xss: window.__xss });
  // 清掉 XSS 标签，重建标准场景
  while (sceneTags.querySelectorAll('.tag-chip-del').length > 0) { const all = sceneTags.querySelectorAll('.tag-chip-del'); all[all.length - 1].click(); await sleep(20); }
  sceneInput.value = '售后退换货'; dispatchKey({}); await sleep(40);
  sceneInput.value = '停车缴费'; dispatchKey({}); await sleep(40);
  R('场景标签准备完成（2 个）', sceneTags.querySelectorAll('.tag-chip').length === 2, { n: sceneTags.querySelectorAll('.tag-chip').length });
  // 核心目标标签
  const goalInput = $('ctx-goal-input'), goalTags = $('ctx-goal-tags');
  while (goalTags.querySelectorAll('.tag-chip-del').length > 0) { const all = goalTags.querySelectorAll('.tag-chip-del'); all[all.length - 1].click(); await sleep(20); }
  goalInput.value = '安抚客户情绪'; dispatchKeyOn(goalInput); await sleep(40);
  goalInput.value = '准确提供价格'; dispatchKeyOn(goalInput); await sleep(40);
  function dispatchKeyOn(inputEl) {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    inputEl.dispatchEvent(e);
  }
  R('核心目标标签准备完成（2 个）', goalTags.querySelectorAll('.tag-chip').length === 2, { n: goalTags.querySelectorAll('.tag-chip').length });
  // 行业
  const indEl = $('ctx-industry');
  indEl.value = '旅游行业'; indEl.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  const expectedCtx = { industry: '旅游行业', business_scene: ['售后退换货', '停车缴费'], core_goal: ['安抚客户情绪', '准确提供价格'] };

  // ---------- 5. 组装并生成快照：抓包上下文 + 最终 Prompt 替换 ----------
  // L0/L3 都写占位符（L0 已在 longText 中有 {{industry}}，这里补全 L3）
  const l3text = '项目话术：强调行业={{industry}}；场景={{business_scene}}；目标={{core_goal}}。<speak>您好</speak>';
  setTextarea(ta3, l3text);
  await sleep(100);
  const genBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('组装并生成快照'));
  R('「组装并生成快照」按钮存在', !!genBtn);
  genBtn.click();
  const gotResp = await waitUntil(() => cap.snapshotResp, 30000, 150);
  R('快照生成成功（收到响应）', !!cap.snapshotResp && cap.snapshotResp.success === true, cap.snapshotResp && { success: cap.snapshotResp.success, snapshot_id: cap.snapshotResp.snapshot_id, error: cap.snapshotResp.error });
  R('请求 payload 携带 context_data 且与当前填写一致', !!cap.snapshotReq && JSON.stringify(cap.snapshotReq.context_data) === JSON.stringify(expectedCtx), cap.snapshotReq && cap.snapshotReq.context_data);
  const fp = (cap.snapshotResp && cap.snapshotResp.final_prompt) || '';
  R('响应返回最终 Prompt（final_prompt 存在）', !!fp);
  R('L0 的 {{industry}} 被替换', fp.includes('第一行包含 旅游行业'));
  R('L3 的 {{industry}}/{{business_scene}}/{{core_goal}} 被替换', fp.includes('强调行业=旅游行业；场景=售后退换货、停车缴费；目标=安抚客户情绪、准确提供价格'));
  R('最终 Prompt 无 {{industry}}/{{business_scene}}/{{core_goal}} 残留', !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(fp), fp.match(/\{\{[^}]*\}\}/g));
  R('跨行 {{newline test}} 不在替换范围、原样保留', fp.includes('{{' + '\n' + 'newline test' + '\n' + '}}'));
  R('<speak> 标签在最终 Prompt 中保留', fp.includes('<speak>'));
  const sceneOccurrences = (fp.match(/旅游行业/g) || []).length;
  R('同一变量在 L0 与 L3 均替换（旅游行业出现 ≥2 次）', sceneOccurrences >= 2, { count: sceneOccurrences });
  await sleep(300);
  document.querySelectorAll('.toast').forEach((t) => t.remove());

  // ---------- 6. 切换项目：先清空再回填 ----------
  const otherNode = findTreeItem('途牛热线');
  R('左侧树存在第二个项目节点', !!otherNode);
  otherNode.click();
  await sleep(900);
  const cleared = { ind: $('ctx-industry').value, sceneN: document.querySelectorAll('#ctx-scene-tags .tag-chip').length, goalN: document.querySelectorAll('#ctx-goal-tags .tag-chip').length };
  R('切换项目后语境先被清空（或按该项语境回填，空项目应为空）', cleared.ind === '' && cleared.sceneN === 0 && cleared.goalN === 0, cleared);
  // 空知识库点 AI 提取 → 本地拦截，不发 extract 请求
  const extractCallsBeforeEmpty = cap.extractCalls;
  $('ctx-extract-btn').click();
  await sleep(700);
  const toastText = Array.from(document.querySelectorAll('.toast')).map((t) => t.innerText).join('|');
  R('空知识库点 AI 提取 → toast 提示知识库为空', /知识库为空/.test(toastText), { toastText });
  R('空知识库不调用 /api/context/extract（前端先判空）', cap.extractCalls === extractCallsBeforeEmpty, { before: extractCallsBeforeEmpty, after: cap.extractCalls });
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  // 切回原项目 → 语境从 DB 回填（生成快照时持久化）
  findTreeItem('Trip旅游AI接线员').click();
  await sleep(1200);
  const refilled = { ind: $('ctx-industry').value.trim(), sceneN: document.querySelectorAll('#ctx-scene-tags .tag-chip').length, goalN: document.querySelectorAll('#ctx-goal-tags .tag-chip').length, scenes: Array.from(document.querySelectorAll('#ctx-scene-tags .tag-chip-label')).map((e) => e.textContent) };
  R('切回项目后 context_json 回填正确（行业 + 2 + 2）', refilled.ind === '旅游行业' && refilled.sceneN === 2 && refilled.goalN === 2, refilled);

  // ---------- 7. 页面无 JS 报错 ----------
  R('流程中无未捕获 JS 异常', captureErrors.length === 0, captureErrors);
  const passCount = out.filter((x) => x.pass).length;
  return { pass: passCount === out.length, passCount, total: out.length, out, cap: { snapshotReq: cap.snapshotReq, respKeys: cap.snapshotResp ? Object.keys(cap.snapshotResp) : null, extractCalls: cap.extractCalls, kbListCalls: cap.kbListCalls }, refilled, errors: captureErrors };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(result));
