// V3.0 阶段二/四后端 HTTP 验收（3000 纯 Node 服务）
// 用法: node test-data/e2e/v3-p2-http.mjs [baseUrl]
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 700) : '')); }
  results.push({ name, ok: !!cond, detail });
};
async function req(path, opts, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { ...(opts || {}), signal: ctrl.signal });
    let body = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await res.json();
    else body = await res.text();
    return { status: res.status, body, headers: res.headers };
  } finally { clearTimeout(t); }
}
const post = (p, payload, timeoutMs) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs);

(async () => {
  console.log('== [1] 模型路由中枢 API ==');
  let r = await req('/api/models');
  check('GET /api/models 成功返回数组', r.status === 200 && r.body?.success === true && Array.isArray(r.body.data), { status: r.status, body: r.body });
  const beforeCount = (r.body?.data || []).length;

  // 保存一条激活模型：api_key 留空 → 运行时回落 .env
  r = await post('/api/models/save', {
    provider: 'deepseek', display_name: 'DeepSeek-夜间验收', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: true, temperature: 0.3
  });
  check('POST /api/models/save 保存激活模型成功', r.status === 200 && r.body?.success === true && typeof r.body?.id === 'string', { status: r.status, body: r.body });
  const modelId = r.body?.id;
  r = await req('/api/models');
  const models = r.body?.data || [];
  const saved = models.find((m) => m.id === modelId);
  check('GET /api/models 包含新模型且 is_active=1', !!saved && Number(saved.is_active) === 1, saved);
  check('模型列表不泄露完整 api_key（masked/has_key 字段）', !!saved && typeof saved.masked_key === 'string' && !JSON.stringify(saved).includes('"api_key":"sk-'), saved && { masked_key: saved.masked_key, has_key: saved.has_key });

  r = await post('/api/models/test', { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '' }, 90000);
  check('POST /api/models/test（Key 留空回落 .env）连通成功', r.status === 200 && r.body?.success === true, { status: r.status, body: r.body });

  // DB 激活模型参与 chatCompletion
  r = await post('/api/chat/reply', { project_id: 'proj-597e1045', layers: [{ layer: 'L0', name: '基座', content: '你是{{industry}}语音客服。' }], context_data: { industry: '旅游行业', business_scene: [], core_goal: [] }, messages: [{ role: 'user', content: '只回复 OK' }] }, 90000);
  check('DB 激活模型下 /api/chat/reply 真实成功', r.status === 200 && r.body?.success === true && typeof r.body.reply === 'string' && r.body.reply.trim().length > 0, { status: r.status, body: r.body });

  // 无激活模型 → .env 回退
  if (modelId) {
    await post('/api/models/save', { id: modelId, provider: 'deepseek', display_name: 'DeepSeek-夜间验收', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: false });
    const lists = (await req('/api/models')).body?.data || [];
    check('可将模型置为非激活（DB 无激活模型）', lists.every((m) => Number(m.is_active) !== 1), lists.map((m) => ({ id: m.id, active: m.is_active })));
    r = await post('/api/chat/reply', { project_id: 'proj-597e1045', layers: [{ layer: 'L0', name: '基座', content: '你好' }], context_data: { industry: '', business_scene: [], core_goal: [] }, messages: [{ role: 'user', content: '只回复 OK' }] }, 90000);
    check('无激活模型时 .env 回退仍可用（防全盘崩溃）', r.status === 200 && r.body?.success === true && r.body.reply.trim().length > 0, { status: r.status, body: r.body });
    // 恢复激活
    await post('/api/models/save', { id: modelId, provider: 'deepseek', display_name: 'DeepSeek-夜间验收', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: true });
  }

  console.log('== [2] 阶段四后端：KB 在线更新 ==');
  r = await req('/api/kb/list?project_id=proj-597e1045');
  const kbList = r.body?.data || [];
  check('知识库列表可用（阶段一回归）', r.status === 200 && kbList.length > 0, { count: kbList.length });
  const target = kbList[0];
  const originQ = target.question, originA = target.answer;
  r = await post('/api/kb/update', { id: target.id, question: originQ + '【V3编辑测试】', answer: originA + '【V3编辑测试】' });
  check('POST /api/kb/update 更新成功', r.status === 200 && r.body?.success === true, { status: r.status, body: r.body });
  const afterList = (await req('/api/kb/list?project_id=proj-597e1045')).body?.data || [];
  const updated = afterList.find((x) => x.id === target.id);
  check('KB 更新已持久化', !!updated && updated.question.includes('【V3编辑测试】') && updated.answer.includes('【V3编辑测试】'), updated);
  r = await post('/api/kb/update', { id: target.id, question: originQ, answer: originA });
  check('KB 编辑已还原', r.status === 200 && r.body?.success === true, r.body);
  r = await post('/api/kb/update', { id: 'not-exist-kb', question: 'q', answer: 'a' });
  check('KB 更新不存在 id → 404', r.status === 404, { status: r.status, body: r.body });
  r = await post('/api/kb/update', { id: target.id, question: '', answer: '' });
  check('KB 更新空字段 → 400', r.status === 400, { status: r.status, body: r.body });

  console.log('== [3] 阶段四后端：AI 生成刁钻测试题 ==');
  r = await post('/api/eval/generate_questions', { project_id: 'proj-597e1045', count: 5 }, 120000);
  const qs = r.body?.data || [];
  check('POST /api/eval/generate_questions 成功', r.status === 200 && r.body?.success === true && Array.isArray(qs), { status: r.status, body: r.body });
  check('生成题目结构合法（≥1 条，含 user_query/standard_answer 字符串）', qs.length >= 1 && qs.every((q) => typeof q.user_query === 'string' && q.user_query.trim() && typeof q.standard_answer === 'string' && q.standard_answer.trim()), qs.slice(0, 3));
  check('生成题目数量合理（1~10）', qs.length >= 1 && qs.length <= 10, qs.length);

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ V3.0 阶段二/四后端 HTTP 验收全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
