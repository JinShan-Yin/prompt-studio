// test-data/e2e/http-smoke-sprint2.mjs — Sprint 2 后端接口冒烟（Lead 验收用）
// 用法: node test-data/e2e/http-smoke-sprint2.mjs <baseUrl> <token>
const BASE = process.argv[2] || 'http://127.0.0.1:3081';
const TOKEN = process.argv[3] || '';
const q = (p) => BASE + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
  results.push({ name, ok: !!cond, detail });
}
async function req(path, opts, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(q(path), { ...(opts || {}), signal: ctrl.signal });
    let body = null;
    try { body = await res.clone().json(); } catch (e) { body = { __parseError: String(e) }; }
    return { status: res.status, body, headers: res.headers };
  } finally { clearTimeout(t); }
}
const post = (path, payload) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const LAYERS = [
  { layer: 'L0', name: '全局安全基座', content: '你是面向{{industry}}领域的智能语音客服。业务场景：{{business_scene}}。核心目标：{{core_goal}}。' },
  { layer: 'L1', name: '语音基座', content: '回复必须使用 <speak> 标签包裹。' },
  { layer: 'L3', name: '项目话术', content: '严禁使用 Markdown。' }
];
const CTX = { industry: '商场客服', business_scene: ['停车缴费', '会员咨询'], core_goal: ['准确提供信息', '安抚客户情绪'] };

(async () => {
  console.log('== [1] /api/chat/reply 基础能力 ==');
  let r = await req('/api/chat/reply', { method: 'OPTIONS' });
  check('OPTIONS /api/chat/reply → 204 + CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === '*', { status: r.status });

  r = await post('/api/chat/reply', { project_id: 'proj-597e1045', layers: LAYERS, context_data: CTX, messages: [{ role: 'user', content: '你好，请问停车场怎么收费？' }] });
  const chat = r.body || {};
  check('POST chat/reply 成功', r.status === 200 && chat.success === true && typeof chat.reply === 'string' && chat.reply.trim().length > 0, { status: r.status, body: chat });
  check('system_prompt 存在且已完成 {{变量}} 全局替换', typeof chat.system_prompt === 'string' && chat.system_prompt.includes('商场客服') && chat.system_prompt.includes('停车缴费、会员咨询') && chat.system_prompt.includes('准确提供信息、安抚客户情绪') && !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(chat.system_prompt), (chat.system_prompt || '').slice(0, 400));
  check('system_prompt 末尾含【输出约束】且要求 <speak>', typeof chat.system_prompt === 'string' && chat.system_prompt.includes('【输出约束】') && chat.system_prompt.includes('<speak>'));
  check('DeepSeek 回复符合语音格式（包含 <speak>）', typeof chat.reply === 'string' && /<speak>[\s\S]*<\/speak>/.test(chat.reply), chat.reply);
  check('回复不含 Markdown 标记', typeof chat.reply === 'string' && !/\*\*|^#+\s|^\s*-\s/m.test(chat.reply), chat.reply);

  console.log('== [2] 多轮上下文 ==');
  r = await post('/api/chat/reply', {
    project_id: 'proj-597e1045', layers: LAYERS, context_data: CTX,
    messages: [
      { role: 'user', content: '你好，请问停车场怎么收费？' },
      { role: 'assistant', content: chat.reply || '<speak>您好，请问有什么可以帮您？</speak>' },
      { role: 'user', content: '那会员有什么优惠？' }
    ]
  });
  check('多轮对话（含 assistant 历史）请求成功', r.status === 200 && r.body?.success === true && typeof r.body.reply === 'string' && r.body.reply.trim().length > 0, { status: r.status, reply: r.body?.reply });

  r = await post('/api/chat/reply', { project_id: 'proj-597e1045', messages: [{ role: 'user', content: '只用当前项目 DB 语境（不传 context_data）' }] });
  check('不传 layers/context_data 时 DB 兜底仍可用', r.status === 200 && r.body?.success === true && typeof r.body.reply === 'string', { status: r.status, body: r.body });

  console.log('== [3] 参数校验 ==');
  r = await post('/api/chat/reply', {});
  check('缺 messages → 400', r.status === 400 && r.body?.success === false, { status: r.status, body: r.body });
  r = await post('/api/chat/reply', { messages: 'abc' });
  check('messages 非数组 → 400', r.status === 400, { status: r.status });
  r = await post('/api/chat/reply', { messages: [] });
  check('messages 空数组 → 400', r.status === 400, { status: r.status });
  r = await post('/api/chat/reply', { messages: [{ role: 'system', content: 'x' }] });
  check('无 user 消息（仅 system）→ 400', r.status === 400, { status: r.status });
  r = await req('/api/chat/reply');
  check('GET /api/chat/reply → 405', r.status === 405, { status: r.status });

  console.log('== [4] 既有接口回归 ==');
  r = await post('/api/eval/run', { user_query: '停车怎么收费？', standard_answer: '首小时8元，全天封顶50元。', bot_reply: '<speak>您好，停车首小时8元，全天封顶50元。</speak>' });
  check('POST /api/eval/run 保持可用（L1+L2）', r.status === 200 && r.body?.success === true && r.body.l1 && r.body.l2, { status: r.status, body: r.body });
  r = await req('/api/kb/list?project_id=proj-597e1045');
  check('GET /api/kb/list 保持可用', r.status === 200 && r.body?.success === true && Array.isArray(r.body.data), { status: r.status, count: r.body?.data?.length });
  r = await req('/api/context/get?project_id=proj-597e1045');
  check('GET /api/context/get 保持可用', r.status === 200 && r.body?.success === true, { status: r.status });
  r = await post('/api/snapshots/create', { project_id: 'proj-597e1045', layers: [{ layer: 'L0', name: '测试', content: '行业={{industry}}' }], context_data: CTX });
  check('POST /api/snapshots/create 保持可用且替换生效', r.status === 200 && r.body?.success === true && r.body.final_prompt.includes('商场客服') && !r.body.final_prompt.includes('{{industry}}'), { status: r.status });

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ Sprint2 HTTP 冒烟全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
