// V3.0 P1 安全修复验证：自定义 base_url 禁止回退 .env Key + CORS 白名单 + SSRF 基础校验
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
  results.push({ name, ok: !!cond, detail });
};
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await res.json();
  else body = await res.text();
  return { status: res.status, body, headers: res.headers };
}
const jsonPost = (p, data) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

(async () => {
  console.log('== [1] CORS 白名单：恶意 Origin 必须被拒绝 ==');
  let r = await fetch(BASE + '/api/models/test', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });
  const evilAcao = r.headers.get('access-control-allow-origin');
  check('恶意 Origin 预检不再放行（403 或 ACAO 不含 * / evil）', r.status === 403 || (!evilAcao || (evilAcao !== '*' && !evilAcao.includes('evil'))), { status: r.status, acao: evilAcao });
  r = await fetch(BASE + '/api/models/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ base_url: 'https://evil.example/v1', model_name: 'x' })
  });
  check('恶意 Origin 实际 POST → 403', r.status === 403, { status: r.status });
  const localPre = await fetch(BASE + '/api/models', { headers: { Origin: 'http://127.0.0.1:3000' } });
  check('本机 Origin 正常放行（200 + ACAO 本机）', localPre.status === 200 && (localPre.headers.get('access-control-allow-origin') || '').includes('127.0.0.1'), { status: localPre.status, acao: localPre.headers.get('access-control-allow-origin') });
  const noOrigin = await fetch(BASE + '/api/models');
  check('无 Origin 的本机工具调用正常（200）', noOrigin.status === 200, { status: noOrigin.status });

  console.log('== [2] /api/models/test：自定义 base_url 禁止 .env Key 回退 ==');
  r = await jsonPost('/api/models/test', { provider: 'custom', base_url: 'https://evil.example/v1', model_name: 'demo' });
  check('自定义 https base_url + 无 Key → 拒绝（不得使用 env Key 外发）', r.status === 200 && r.body?.success === false && /显式填写 API Key|禁止回退/.test(r.body.message || ''), { status: r.status, body: r.body });
  r = await jsonPost('/api/models/test', { provider: 'custom', base_url: 'http://evil.example/v1', model_name: 'demo' });
  check('非本机 http base_url → 拒绝（必须 https）', r.body?.success === false && /https/.test(r.body.message || ''), r.body);
  r = await jsonPost('/api/models/test', { provider: 'custom', base_url: 'http://192.168.1.5:11434/v1', model_name: 'demo' });
  check('内网 IP base_url → 拒绝（SSRF 防护）', r.body?.success === false && /内网|https/.test(r.body.message || ''), r.body);
  r = await jsonPost('/api/models/test', { provider: 'custom', base_url: 'https://192.168.1.5:11434/v1', model_name: 'demo' });
  check('内网 IP + https base_url → 拒绝（SSRF 内网拦截）', r.body?.success === false && /内网/.test(r.body.message || ''), r.body);
  r = await jsonPost('/api/models/test', { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '' });
  check('官方 DeepSeek + Key 留空 → 仍允许 .env 回退并连通成功', r.status === 200 && r.body?.success === true, { status: r.status, body: r.body });

  console.log('== [3] /api/models/save：禁止把自定义端点配置为「无 Key + env 回退」 ==');
  r = await jsonPost('/api/models/save', { provider: 'custom', display_name: '攻击者端点', base_url: 'https://evil.example/v1', model_name: 'demo', api_key: '', is_active: true });
  check('自定义 base_url + 空 Key 保存 → 400 拒绝', r.status === 400 && r.body?.success === false, { status: r.status, body: r.body });
  r = await jsonPost('/api/models/save', { provider: 'custom', base_url: 'http://10.0.0.1/v1', model_name: 'demo', api_key: 'sk-test-12345678901234567890' });
  check('内网 base_url 保存 → 400 拒绝', r.status === 400, { status: r.status, body: r.body });
  r = await jsonPost('/api/models/save', { provider: 'deepseek', display_name: '官方-无Key测试', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: false });
  check('官方 DeepSeek + 空 Key 保存 → 允许（不激活，避免影响路由）', r.status === 200 && r.body?.success === true, { status: r.status, body: r.body });

  console.log('== [4] 既有功能回归：聊天/评测仍可用 ==');
  r = await jsonPost('/api/chat/reply', { project_id: 'proj-597e1045', layers: [{ layer: 'L0', name: '基座', content: '你好' }], context_data: { industry: '', business_scene: [], core_goal: [] }, messages: [{ role: 'user', content: '只回复 OK' }] });
  check('chat/reply 真实 LLM 仍成功（官方/回退链路安全）', r.status === 200 && r.body?.success === true && (r.body.reply || '').trim().length > 0, { status: r.status, body: r.body });
  r = await jsonPost('/api/settings/api-key', {});
  check('settings GET/POST 空值路径仍安全（不覆盖 Key）', r.status === 200 && r.body?.success === true && r.body.updated === false, { status: r.status, body: r.body });

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ P1 安全修复验证全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
