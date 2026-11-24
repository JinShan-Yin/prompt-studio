#!/usr/bin/env node
/**
 * V1.62 冒烟测试（零依赖）：
 *   node scripts/smoke-v1.62.mjs
 * 使用临时数据目录（NEWROCK_DATA_DIR），全程不触碰生产 data/ 下的数据库。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TMP_ROOT = path.join(ROOT, 'data', 'tmp');
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS ' + name); return true; }
  fail += 1;
  failures.push(name + (extra ? ' :: ' + String(extra).slice(0, 300) : ''));
  console.log('FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 300) : ''));
  return false;
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, function () {
      const port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
  });
}

function startServer(opts) {
  const dataDir = path.join(TMP_ROOT, 'smoke-' + STAMP + '-' + opts.tag);
  fs.mkdirSync(dataDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    PORT: String(opts.port),
    NEWROCK_DATA_DIR: dataDir,
    LAN_ACCESS: opts.lan ? 'true' : 'false',
    ALLOW_SELF_REGISTER: '',
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env, stdio: 'ignore', windowsHide: true });
  return { child: child, dataDir: dataDir, base: 'http://' + HOST + ':' + opts.port };
}

async function waitHealth(base, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return true;
    } catch (e) { /* not ready */ }
    await sleep(250);
  }
  return false;
}

function stopServer(server) {
  return new Promise(function (resolve) {
    if (!server || !server.child || server.child.killed) { resolve(); return; }
    const timer = setTimeout(resolve, 4000);
    server.child.once('exit', function () { clearTimeout(timer); resolve(); });
    try { server.child.kill(); } catch (e) { clearTimeout(timer); resolve(); }
  });
}

function rawGet(port, urlPath, hostHeader, extraHeaders) {
  return new Promise(function (resolve, reject) {
    const headers = Object.assign({ Host: hostHeader }, extraHeaders || {});
    const req = http.request({ host: HOST, port: port, path: urlPath, method: 'GET', headers: headers }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function makeClient(port) {
  const base = 'http://' + HOST + ':' + port;
  async function request(urlPath, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.cookie) headers.Cookie = opts.cookie;
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(base + urlPath, { method: opts.method || 'GET', headers: headers, body: body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const cookie = rawCookies.map(function (c) { return c.split(';')[0]; }).join('; ');
    return { status: res.status, body: json, cookie: cookie };
  }
  return { request: request, base: base, port: port };
}

async function login(client, username, password) {
  const res = await client.request('/api/auth/login', { method: 'POST', body: { username: username, password: password } });
  return { status: res.status, body: res.body, cookie: res.cookie };
}

const servers = [];
async function main() {
  try { fs.mkdirSync(TMP_ROOT, { recursive: true }); } catch (e) { /* ignore */ }

  // ---------- 1) 本机模式 ----------
  const localPort = await freePort();
  const local = startServer({ tag: 'local', port: localPort, lan: false });
  servers.push(local);
  ok('本地模式启动', await waitHealth(local.base));
  const c0 = makeClient(localPort);
  ok('健康检查 200', (await c0.request('/api/health')).status === 200);
  ok('本机模式：私有 Host 被拒', (await rawGet(localPort, '/api/health', '192.168.1.9:' + localPort)).status === 403);
  ok('本机模式：恶意 Host 被拒', (await rawGet(localPort, '/api/health', 'evil.example.com')).status === 403);
  const cfg0 = await c0.request('/api/auth/config');
  ok('本机模式：自助注册开启', cfg0.status === 200 && cfg0.body.data.register_enabled === true && cfg0.body.data.lan_mode === false, JSON.stringify(cfg0.body));

  // ---------- 2) 局域网模式 ----------
  const lanPort = await freePort();
  const lan = startServer({ tag: 'lan', port: lanPort, lan: true });
  servers.push(lan);
  ok('局域网模式启动', await waitHealth(lan.base));
  const c = makeClient(lanPort);
  ok('局域网：私有 Host 放行', (await rawGet(lanPort, '/api/health', '192.168.1.9:' + lanPort)).status === 200);
  ok('局域网：IPv6 ULA 放行', (await rawGet(lanPort, '/api/health', '[fd00::1]:' + lanPort)).status === 200);
  ok('局域网：恶意 Host 仍 403', (await rawGet(lanPort, '/api/health', 'evil.example.com')).status === 403);
  ok('局域网：私有 Origin 放行', (await c.request('/api/health', { headers: { Origin: 'http://192.168.1.9:' + lanPort } })).status === 200);
  ok('局域网：恶意 Origin 403', (await c.request('/api/health', { headers: { Origin: 'http://evil.example.com' } })).status === 403);
  const cfg = await c.request('/api/auth/config');
  ok('局域网：注册关闭', cfg.status === 200 && cfg.body.data.register_enabled === false && cfg.body.data.lan_mode === true, JSON.stringify(cfg.body));
  ok('局域网：注册接口被拒', (await c.request('/api/auth/register', { method: 'POST', body: { username: '13900000000', password: 'abc123' } })).status === 403);

  // 管理员登录
  const adminLogin = await login(c, 'admin', 'newrock123');
  ok('管理员登录', adminLogin.status === 200, JSON.stringify(adminLogin.body));
  const adminCookie = adminLogin.cookie;
  const me = await c.request('/api/auth/me', { cookie: adminCookie });
  ok('me 返回功能集合', me.status === 200 && me.body.user.features && me.body.user.features.kb === true);

  // 用户与权限
  const userRes = await c.request('/api/admin/users/create', { method: 'POST', cookie: adminCookie, body: { username: '13800000002', password: 'abc123', role: 'user' } });
  ok('创建用户', userRes.status === 200 && !!userRes.body.id, JSON.stringify(userRes.body));
  const userId = userRes.body.id;
  const matrixRes = await c.request('/api/admin/features/matrix', { method: 'POST', cookie: adminCookie, body: { matrix: { user: { edit: true, kb: false, eval: true, snapshot: true }, teamadmin: { edit: true, kb: true, eval: true, snapshot: true } } } });
  ok('保存角色矩阵', matrixRes.status === 200, JSON.stringify(matrixRes.body));
  const userLogin = await login(c, '13800000002', 'abc123');
  ok('普通用户登录', userLogin.status === 200, JSON.stringify(userLogin.body));
  const userCookie = userLogin.cookie;
  ok('功能门禁生效', (await c.request('/api/kb/list?project_id=x', { cookie: userCookie })).status === 403);
  const overrideRes = await c.request('/api/admin/users/features', { method: 'POST', cookie: adminCookie, body: { user_id: userId, overrides: { kb: true } } });
  ok('个人覆盖生效', overrideRes.status === 200 && overrideRes.body.features.kb === true, JSON.stringify(overrideRes.body));
  const afterOverride = await c.request('/api/kb/list?project_id=x', { cookie: userCookie });
  ok('覆盖后功能门禁放行（不再是 403）', afterOverride.status !== 403, String(afterOverride.status));
  ok('超管权限不可改', (await c.request('/api/admin/users/features', { method: 'POST', cookie: adminCookie, body: { user_id: me.body.user.id, overrides: { kb: false } } })).status === 403);

  // 项目 / KB / 快照 / 克隆
  const c1 = await c.request('/api/companies/create', { method: 'POST', cookie: adminCookie, body: { name: 'A公司' } });
  const c2 = await c.request('/api/companies/create', { method: 'POST', cookie: adminCookie, body: { name: 'B公司' } });
  const p1 = await c.request('/api/projects/create', { method: 'POST', cookie: adminCookie, body: { name: 'A-1', company_id: c1.body.id } });
  ok('创建项目', p1.status === 200, JSON.stringify(p1.body));
  const projectId = p1.body.id;
  ok('写入知识库', (await c.request('/api/kb/save', { method: 'POST', cookie: adminCookie, body: { project_id: projectId, pairs: [{ question: 'Q1', answer: 'A1', structure_mode: 'raw' }, { question: 'Q2', answer: 'A2' }] } })).status === 200);
  ok('生成快照', (await c.request('/api/snapshots/create', { method: 'POST', cookie: adminCookie, body: { project_id: projectId, layers: [{ layer: 'SYSTEM', name: '系统提示词', content: 'prompt v1' }] } })).status === 200);
  const cloneRes = await c.request('/api/projects/clone', { method: 'POST', cookie: adminCookie, body: { id: projectId, target_company_id: c2.body.id, name: 'A-1 到 B', copy_mode: 'latest' } });
  ok('跨公司克隆', cloneRes.status === 200 && cloneRes.body.company_id === c2.body.id && cloneRes.body.kb_count === 2 && cloneRes.body.snapshot_count === 1, JSON.stringify(cloneRes.body));
  const clonedKb = await c.request('/api/kb/list?project_id=' + cloneRes.body.project_id, { cookie: adminCookie });
  ok('克隆保留 raw 结构', clonedKb.body.data.some(function (x) { return x.structure_mode === 'raw'; }));

  // 只读授权
  ok('保存只读授权', (await c.request('/api/projects/grants/save', { method: 'POST', cookie: adminCookie, body: { project_id: projectId, user_ids: [userId] } })).status === 200);
  const userProjects = await c.request('/api/projects', { cookie: userCookie });
  const grantedRow = userProjects.body.data.find(function (p) { return p.id === projectId; });
  ok('被授权人可见且只读', !!grantedRow && grantedRow.can_write === 0);
  ok('被授权人可读知识库', (await c.request('/api/kb/list?project_id=' + projectId, { cookie: userCookie })).status === 200);
  ok('被授权人写知识库 403', (await c.request('/api/kb/save', { method: 'POST', cookie: userCookie, body: { project_id: projectId, pairs: [{ question: 'x', answer: 'y' }] } })).status === 403);
  ok('被授权人改名 403', (await c.request('/api/projects/update', { method: 'POST', cookie: userCookie, body: { id: projectId, name: 'hack' } })).status === 403);

  // 置顶
  ok('用户置顶', (await c.request('/api/projects/pin', { method: 'POST', cookie: userCookie, body: { project_id: projectId, pinned: true } })).body.pinned === 1);
  const userProjects2 = await c.request('/api/projects', { cookie: userCookie });
  ok('置顶回显', userProjects2.body.data.find(function (p) { return p.id === projectId; }).pinned === 1);
  const adminProjects = await c.request('/api/projects', { cookie: adminCookie });
  ok('置顶按用户隔离', adminProjects.body.data.find(function (p) { return p.id === projectId; }).pinned === 0);

  // 账号治理
  ok('禁用账号', (await c.request('/api/admin/users/status', { method: 'POST', cookie: adminCookie, body: { user_id: userId, status: 'disabled' } })).status === 200);
  ok('禁用后会话失效', (await c.request('/api/auth/me', { cookie: userCookie })).status === 401);
  const disabledLogin = await login(c, '13800000002', 'abc123');
  ok('禁用后无法登录', disabledLogin.status === 403 && disabledLogin.body.code === 'ACCOUNT_DISABLED', JSON.stringify(disabledLogin.body));
  ok('启用账号', (await c.request('/api/admin/users/status', { method: 'POST', cookie: adminCookie, body: { user_id: userId, status: 'active' } })).status === 200);
  const userLogin2 = await login(c, '13800000002', 'abc123');
  ok('启用后登录', userLogin2.status === 200);
  ok('强制下线', (await c.request('/api/admin/users/kick', { method: 'POST', cookie: adminCookie, body: { user_id: userId } })).status === 200);
  ok('踢下线后会话失效', (await c.request('/api/auth/me', { cookie: userLogin2.cookie })).status === 401);
  ok('不能禁用自己', (await c.request('/api/admin/users/status', { method: 'POST', cookie: adminCookie, body: { user_id: me.body.user.id, status: 'disabled' } })).status === 403);

  // 个人 Key
  const userLogin3 = await login(c, '13800000002', 'abc123');
  const modelRes = await c.request('/api/models/save', { method: 'POST', cookie: userLogin3.cookie, body: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: 'sk-test-12345678901234567890' } });
  ok('个人 Key 保存并自动启用', modelRes.status === 200 && modelRes.body.auto_activated === true && modelRes.body.is_active === 1, JSON.stringify(modelRes.body));
  const models = await c.request('/api/models', { cookie: userLogin3.cookie });
  ok('Key 不回显', models.status === 200 && models.body.data.length === 1 && JSON.stringify(models.body).indexOf('sk-test-12345678901234567890') < 0);
  ok('删除个人模型', (await c.request('/api/models/delete', { method: 'POST', cookie: userLogin3.cookie, body: { id: modelRes.body.id } })).status === 200);

  // 备份
  const full = await c.request('/api/backup/export?scope=full', { cookie: adminCookie });
  ok('全量备份含账号', full.status === 200 && full.body.version === 2 && !!full.body.tables.users && !!full.body.tables.teams, Object.keys(full.body.tables || {}).join(','));
  const biz = await c.request('/api/backup/export?scope=business', { cookie: adminCookie });
  ok('业务备份兼容 v1', biz.status === 200 && biz.body.version === 1 && !biz.body.tables.users);
  ok('手动备份', (await c.request('/api/admin/backups/run', { method: 'POST', cookie: adminCookie, body: {} })).status === 200);
  ok('备份列表', (await c.request('/api/admin/backups', { cookie: adminCookie })).body.data.length >= 1);
  const badFull = JSON.parse(JSON.stringify(full.body));
  badFull.tables.users = [];
  ok('无超管全量备份被拒', (await c.request('/api/backup/import', { method: 'POST', cookie: adminCookie, body: badFull })).status === 400);
  const importFull = await c.request('/api/backup/import', { method: 'POST', cookie: adminCookie, body: full.body });
  ok('全量备份可导入', importFull.status === 200 && importFull.body.scope === 'full', JSON.stringify(importFull.body).slice(0, 200));

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach(function (f) { console.log(' - ' + f); });
  }
  return fail === 0;
}

let exitCode = 1;
try {
  const success = await main();
  exitCode = success ? 0 : 1;
} catch (e) {
  console.error('SMOKE ERROR:', e && e.stack ? e.stack : e);
  exitCode = 1;
} finally {
  for (const server of servers) await stopServer(server);
  if (exitCode === 0) {
    for (const server of servers) {
      try { fs.rmSync(server.dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  } else {
    console.log('临时数据目录已保留用于排查：data/tmp/smoke-' + STAMP + '-*');
  }
}
process.exit(exitCode);
