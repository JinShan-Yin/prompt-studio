// V5 Phase1 冒烟：重定向 / 登录 / 旧数据归属 / API 鉴权
const BASE = 'http://127.0.0.1:3000';
const out = { checks: [] };
const push = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail }); };

async function main() {
  // 1) 未登录首页 → 302 login.html
  let r = await fetch(BASE + '/', { redirect: 'manual' });
  push('未登录访问 / → 302 重定向', r.status === 302 && String(r.headers.get('location') || '').includes('login.html'), { status: r.status, location: r.headers.get('location') });
  // 2) 未登录 API → 401
  r = await fetch(BASE + '/api/projects', { redirect: 'manual' });
  push('未登录访问 /api/projects → 401 JSON', r.status === 401, { status: r.status, body: await r.text().then((t) => t.slice(0, 120)) });
  // 3) 登录页 200 且含品牌
  r = await fetch(BASE + '/login.html');
  const html = await r.text();
  push('login.html 200 且含 NewRock Prompt Studio', r.status === 200 && html.includes('NewRock Prompt Studio') && html.includes('/api/auth/login'), { status: r.status });
  // 4) 默认超管登录
  r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'newrock123' }) });
  const loginBody = await r.json();
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  push('admin/newrock123 登录成功并下发 Session Cookie', r.status === 200 && loginBody.success === true && /newrock\.sid=/.test(cookie), { status: r.status, user: loginBody.user, cookie: cookie.replace(/=.*/, '=***') });
  push('默认密码 need_change_password=1（登录后需改密提醒）', loginBody.user && Number(loginBody.user.need_change_password) === 1, { need_change_password: loginBody.user && loginBody.user.need_change_password });
  // 5) 已登录访问首页 / auth/me / 旧数据
  r = await fetch(BASE + '/', { headers: { Cookie: cookie }, redirect: 'manual' });
  push('登录后访问 / → 200 index.html', r.status === 200, { status: r.status });
  r = await fetch(BASE + '/api/auth/me', { headers: { Cookie: cookie } });
  const me = await r.json();
  push('/api/auth/me 返回 admin 超管', r.status === 200 && me.success && me.user.username === 'admin' && me.user.role === 'superadmin', me.user);
  r = await fetch(BASE + '/api/projects', { headers: { Cookie: cookie } });
  const projects = await r.json();
  push('旧项目平滑归属 admin（登录后仍可见 3 个）', r.status === 200 && projects.success && projects.data.length === 3, projects.data && projects.data.map((p) => ({ id: p.id, name: p.name, user_id: p.user_id })));
  r = await fetch(BASE + '/api/companies', { headers: { Cookie: cookie } });
  const companies = await r.json();
  push('旧客户/行业数据仍可见', r.status === 200 && companies.success && companies.data.length >= 1, { count: companies.data && companies.data.length });
  // 6) 审计日志已写入登录
  r = await fetch(BASE + '/api/admin/audit-logs?limit=20', { headers: { Cookie: cookie } });
  const logs = await r.json();
  push('登录已写入 audit_logs', r.status === 200 && logs.success && logs.data.some((x) => x.action === 'login'), { count: logs.data && logs.data.length, actions: logs.data && logs.data.slice(0, 3).map((x) => x.action) });
  // 7) 无 Cookie 访问 backup export → 401（非超管会话）
  r = await fetch(BASE + '/api/backup/export', { redirect: 'manual' });
  push('未登录备份导出被拦截（401）', r.status === 401, { status: r.status });
  const fs = await import('node:fs');
  const path = await import('node:path');
  push('独立 sessions.db 已创建', fs.existsSync(path.join(process.cwd(), 'data', 'sessions.db')), { size: fs.existsSync(path.join(process.cwd(), 'data', 'sessions.db')) ? fs.statSync(path.join(process.cwd(), 'data', 'sessions.db')).size : 0 });
  out.pass = out.checks.every((c) => c.ok);
  fs.writeFileSync('test-data/e2e/v5-phase1-smoke-result.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
