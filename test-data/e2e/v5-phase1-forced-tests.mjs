// V5 Phase1 强制自测：注册无Key用户 → 并发5次评测扣减（3成功/2×403）→ 失败回滚 → 数据隔离 → 团管隔离
const BASE = 'http://127.0.0.1:3000';
const results = [];
const push = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };
let passed = 0, failed = 0;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}
async function api(path, opts = {}, cookie = '') {
  const headers = Object.assign({}, opts.headers || {});
  if (cookie) headers.Cookie = cookie;
  if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, headers: res.headers };
}
async function login(username, password) {
  const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: cookieFrom(res) };
}
async function register(username, password) {
  const res = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: cookieFrom(res) };
}
const stamp = String(Date.now()).slice(-6);
const USER_A = '139' + stamp + '01';
const USER_B = '139' + stamp + '02';
const USER_C = '139' + stamp + '03';
const PASSWORD = 'Test123456';
const created = { users: [], team: null, company: null, project: null, badModel: null };

(async () => {
  // 0) 超管登录（先保存原始激活模型，便于回滚测试后恢复）
  const adminLogin = await login('admin', 'newrock123');
  const adminCookie = adminLogin.cookie;
  push('超管 admin 登录成功', adminLogin.status === 200 && adminLogin.data.success === true && /newrock\.sid=/.test(adminCookie), { status: adminLogin.status });
  const adminModels = await api('/api/models', {}, adminCookie);
  const originalActive = (adminModels.data.data || []).find((m) => Number(m.is_active) === 1);
  push('迁移后超管仍有激活公共模型（供试用政策）', !!originalActive, originalActive ? { id: originalActive.id, display: originalActive.display_name, base: originalActive.base_url } : null);

  // 1) 注册普通用户 A（无私有 Key）
  const regA = await register(USER_A, PASSWORD);
  const cookieA = regA.cookie || (await login(USER_A, PASSWORD)).cookie;
  created.users.push(USER_A);
  const meA = await api('/api/auth/me', {}, cookieA);
  push('普通用户 A 注册 + 自动登录成功', regA.status === 200 && meA.status === 200 && meA.data.user.role === 'user', { username: USER_A, role: meA.data && meA.data.user && meA.data.user.role, trial: meA.data && meA.data.user && meA.data.user.trial_count });

  // 2) A 无私有 Key：并发发起 5 次 /api/eval/run
  const payload = {
    user_query: '请问你们支持退换货吗？',
    standard_answer: '支持 7 天无理由退换货，需保持商品完好。',
    bot_reply: '<speak>您好，支持七天无理由退换货，请您保持商品完好。</speak>',
  };
  const responses = await Promise.all(Array.from({ length: 5 }, () => api('/api/eval/run', { method: 'POST', body: payload }, cookieA)));
  const okCount = responses.filter((r) => r.status === 200).length;
  const forbiddenCount = responses.filter((r) => r.status === 403).length;
  const statuses = responses.map((r) => r.status);
  push('防并发扣减：5 并发评测恰好 3 成功 / 2 被 403 拦截', okCount === 3 && forbiddenCount === 2, { statuses, okCount, forbiddenCount, errors: responses.filter((r) => r.status !== 200).map((r) => r.data && r.data.error) });
  const meAfter = await api('/api/auth/me', {}, cookieA);
  push('A 试用次数停在上限 3（未超额）', meAfter.data && meAfter.data.user.trial_count === 3, { trial_count: meAfter.data && meAfter.data.user.trial_count });

  // 3) 数据隔离：A 看不到 admin 的旧项目/客户/快照；不能导出全量备份
  const aProjects = await api('/api/projects', {}, cookieA);
  const aCompanies = await api('/api/companies', {}, cookieA);
  const aModels = await api('/api/models', {}, cookieA);
  const aBackup = await api('/api/backup/export', {}, cookieA);
  const adminProjectId = (await api('/api/projects', {}, adminCookie)).data.data[0].id;
  const aCtx = await api('/api/context/get?project_id=' + encodeURIComponent(adminProjectId), {}, cookieA);
  push('个人用户数据隔离：A 看不到 admin 的 3 个项目', aProjects.status === 200 && Array.isArray(aProjects.data.data) && aProjects.data.data.length === 0, { count: aProjects.data && aProjects.data.data && aProjects.data.data.length });
  push('个人用户数据隔离：A 看不到 admin 的客户/行业与模型', aCompanies.data && aCompanies.data.data.length === 0 && aModels.data && aModels.data.data.length === 0);
  push('越权访问 admin 项目语境 → 403', aCtx.status === 403, { status: aCtx.status, body: aCtx.data });
  push('普通用户导出全量备份 → 403', aBackup.status === 403, { status: aBackup.status });

  // 4) 失败回滚：临时把超管公共模型换成无效 Key（激活），普通用户 B 评测失败后 trial_count 回滚
  if (originalActive) {
    const bad = await api('/api/models/save', { method: 'POST', body: { provider: 'deepseek', display_name: 'QA_PUBLIC_BAD', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: 'sk-invalid-qa-test-key-1234567890', is_active: true } }, adminCookie);
    created.badModel = bad.data && bad.data.id;
    const regB = await register(USER_B, PASSWORD);
    const cookieB = regB.cookie || (await login(USER_B, PASSWORD)).cookie;
    created.users.push(USER_B);
    const badEval = await api('/api/eval/run', { method: 'POST', body: payload }, cookieB);
    const meB = await api('/api/auth/me', {}, cookieB);
    push('公共 Key 故障时评测失败（非 200）', badEval.status >= 400, { status: badEval.status, error: badEval.data && badEval.data.error });
    push('失败后试用次数自动回滚（B trial_count=0）', meB.data && meB.data.user.trial_count === 0, { trial_count: meB.data && meB.data.user.trial_count });
    // 恢复原激活模型
    await api('/api/models/save', { method: 'POST', body: { id: originalActive.id, provider: originalActive.provider, display_name: originalActive.display_name, base_url: originalActive.base_url, model_name: originalActive.model_name, api_key: '', is_active: true } }, adminCookie);
    const restored = await api('/api/models', {}, adminCookie);
    const activeAfter = (restored.data.data || []).find((m) => Number(m.is_active) === 1);
    push('恢复原始超管激活模型', activeAfter && activeAfter.id === originalActive.id, { activeId: activeAfter && activeAfter.id });
  }

  // 5) 团管隔离：建团队 → userB 任团管 → userC 同团队 → C 建项目；B 能看到 C 项目但看不到 admin 项目
  const team = await api('/api/teams/create', { method: 'POST', body: { name: 'QA_TEAM_' + stamp } }, adminCookie);
  created.team = team.data && team.data.id;
  const users = await api('/api/admin/users', {}, adminCookie);
  const userB = (users.data.data || []).find((u) => u.username === USER_B);
  const teamAssignB = await api('/api/admin/users/assign-team', { method: 'POST', body: { user_id: userB.id, team_id: created.team, role: 'teamadmin' } }, adminCookie);
  push('超管创建团队并把 B 设为团管', team.status === 200 && teamAssignB.status === 200, { team: created.team, assign: teamAssignB.status });
  const regC = await register(USER_C, PASSWORD);
  const cookieC = regC.cookie || (await login(USER_C, PASSWORD)).cookie;
  created.users.push(USER_C);
  const users2 = await api('/api/admin/users', {}, adminCookie);
  const userC = (users2.data.data || []).find((u) => u.username === USER_C);
  await api('/api/admin/users/assign-team', { method: 'POST', body: { user_id: userC.id, team_id: created.team } }, adminCookie);
  const cCompany = await api('/api/companies/create', { method: 'POST', body: { name: 'QA_TEAM_CLIENT_' + stamp } }, cookieC);
  created.company = cCompany.data && cCompany.data.id;
  const cProject = await api('/api/projects/create', { method: 'POST', body: { company_id: created.company, name: 'QA_TEAM_PROJECT_' + stamp } }, cookieC);
  created.project = cProject.data && cProject.data.id;
  // B 重新登录刷新 session role/team
  const loginB2 = await login(USER_B, PASSWORD);
  const cookieB2 = loginB2.cookie;
  const bProjects = await api('/api/projects', {}, cookieB2);
  const bSeesTeamProject = !!(bProjects.data && bProjects.data.data && bProjects.data.data.some((p) => p.id === created.project));
  const bSeesAdminProject = !!(bProjects.data && bProjects.data.data && bProjects.data.data.some((p) => p.id === adminProjectId));
  push('团管 B 可见同团队 C 的项目（连表/团队过滤生效）', bSeesTeamProject, { count: bProjects.data && bProjects.data.data && bProjects.data.data.length, ids: bProjects.data && bProjects.data.data && bProjects.data.data.map((p) => p.name) });
  push('团管 B 仍看不到超管 admin 的个人项目', !bSeesAdminProject && bProjects.data && bProjects.data.data.length === 1);

  // 6) 审计日志包含登录/注册/删除类动作
  const logs = await api('/api/admin/audit-logs?limit=200', {}, adminCookie);
  const actions = new Set((logs.data && logs.data.data || []).map((l) => l.action));
  push('黑匣子审计日志包含 login / register / project_create', actions.has('login') && actions.has('register') && actions.has('project_create'), { actions: [...actions].slice(0, 15) });

  const failedList = results.filter((r) => !r.ok);
  failed = failedList.length; passed = results.length - failed;
  const out = { total: results.length, passed, failed, results, created };
  const fs = await import('node:fs');
  fs.writeFileSync('test-data/e2e/v5-phase1-forced-tests-result.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ total: out.total, passed, failed, failedNames: failedList.map((r) => r.name), created }, null, 2));
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
