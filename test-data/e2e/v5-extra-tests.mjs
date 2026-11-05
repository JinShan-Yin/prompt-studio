// V5 Phase1 补充验收：改密提醒 / 管理员重置123456 / 改密 / 模型Key掩码不被星号覆盖 / 语境迁移
const BASE = 'http://127.0.0.1:3000';
const results = [];
const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const stamp = String(Date.now()).slice(-6);
const USER = '137' + stamp + '88';
const PWD = 'Init123456';
let adminCookie = '';
async function req(path, { method = 'GET', body, cookie = '' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}
(async () => {
  const login = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'newrock123' } });
  adminCookie = login.setCookie.split(';')[0];
  push('admin 登录（默认密码）', login.status === 200 && login.data.user.need_change_password === 1);
  // 注册测试用户
  const reg = await req('/api/auth/register', { method: 'POST', body: { username: USER, password: PWD } });
  const userCookie = reg.setCookie.split(';')[0];
  push('新用户注册成功', reg.status === 200 && reg.data.user.role === 'user');
  // 管理员重置为 123456
  const users = await req('/api/admin/users', { cookie: adminCookie });
  const target = (users.data.data || []).find((u) => u.username === USER);
  const reset = await req('/api/admin/users/reset-password', { method: 'POST', cookie: adminCookie, body: { user_id: target.id } });
  push('管理员一键重置为 123456', reset.status === 200 && /123456/.test(reset.data.message || ''));
  // 重置后登录：123456 成功且 need_change_password=1
  const login2 = await req('/api/auth/login', { method: 'POST', body: { username: USER, password: '123456' } });
  const userCookie2 = login2.setCookie.split(';')[0];
  push('重置后首次登录提醒改密（need_change_password=1）', login2.status === 200 && Number(login2.data.user.need_change_password) === 1);
  // 用户自助改密
  const change = await req('/api/auth/change-password', { method: 'POST', cookie: userCookie2, body: { old_password: '123456', new_password: 'NewPass123' } });
  const login3 = await req('/api/auth/login', { method: 'POST', body: { username: USER, password: 'NewPass123' } });
  push('用户自助修改密码后新密码可登录', change.status === 200 && login3.status === 200);
  const me = await req('/api/auth/me', { cookie: login3.setCookie.split(';')[0] });
  push('改密后 need_change_password 已清零', me.status === 200 && Number(me.data.user.need_change_password) === 0);
  // 模型 Key 掩码 & 防星号覆盖（admin 的某个有 Key 模型）
  const models = await req('/api/models', { cookie: adminCookie });
  const withKey = (models.data.data || []).find((m) => m.has_key && m.masked_key);
  push('模型列表只回显掩码 Key（无完整 Key）', !!withKey && withKey.masked_key.includes('****') && !withKey.masked_key.startsWith('sk-') === false, withKey ? { masked_key: withKey.masked_key } : null);
  if (withKey) {
    const saveWithMask = await req('/api/models/save', { method: 'POST', cookie: adminCookie, body: { id: withKey.id, provider: withKey.provider, display_name: withKey.display_name, base_url: withKey.base_url, model_name: withKey.model_name, api_key: withKey.masked_key, is_active: false } });
    const models2 = await req('/api/models', { cookie: adminCookie });
    const after = (models2.data.data || []).find((m) => m.id === withKey.id);
    push('保存时传入含 * 的掩码 Key → 不覆盖真实 Key', saveWithMask.status === 200 && after && after.masked_key === withKey.masked_key, { before: withKey.masked_key, after: after && after.masked_key });
  }
  // 迁移后语境仍正确
  const projects = await req('/api/projects', { cookie: adminCookie });
  const trip = (projects.data.data || []).find((p) => p.name.includes('Trip旅游AI接线员'));
  const ctx = await req('/api/context/get?project_id=' + encodeURIComponent(trip.id), { cookie: adminCookie });
  push('迁移后 Trip 语境数据完好（旅游行业）', ctx.status === 200 && ctx.data.data && ctx.data.data.industry === '旅游行业', ctx.data && ctx.data.data);
  const failed = results.filter((r) => !r.ok);
  const fs = await import('node:fs');
  fs.writeFileSync('test-data/e2e/v5-phase1-extra-tests.json', JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results, testUser: USER }, null, 2));
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, failedNames: failed.map((f) => f.name), testUser: USER }, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
