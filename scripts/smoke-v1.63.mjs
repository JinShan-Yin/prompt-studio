#!/usr/bin/env node
/**
 * V1.63 冒烟测试（零依赖）
 *   node scripts/smoke-v1.63.mjs
 * 使用临时数据目录（NEWROCK_DATA_DIR），全程不触碰生产 data/ 下的数据库。
 * 覆盖：鉴权/局域网基线、评测落库、客户级/团队级授权、回收站、KB 分页与 413、
 *      用量统计（本地 mock LLM）、角色变更、强制删除、所有权移交、备份可选表。
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
  const dataDir = path.join(TMP_ROOT, 'smoke163-' + STAMP + '-' + opts.tag);
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

/** 本地 mock LLM：固定返回 <speak> 与 usage，供用量统计/对话链路测试 */
function startMockLlm() {
  return new Promise(function (resolve) {
    const srv = http.createServer(function (req, res) {
      let data = '';
      req.on('data', function (c) { data += c; });
      req.on('end', function () {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-' + Date.now(),
          choices: [{ index: 0, message: { role: 'assistant', content: '<speak>您好，这是测试回复。</speak>' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
    });
    srv.listen(0, HOST, function () { resolve({ server: srv, port: srv.address().port }); });
  });
}

const servers = [];
async function main() {
  try { fs.mkdirSync(TMP_ROOT, { recursive: true }); } catch (e) { /* ignore */ }

  // ---------- 1) 本机模式基线 ----------
  const localPort = await freePort();
  const local = startServer({ tag: 'local', port: localPort, lan: false });
  servers.push(local);
  ok('本地模式启动', await waitHealth(local.base));
  const c0 = makeClient(localPort);
  const health0 = await c0.request('/api/health');
  ok('健康检查 200 / 版本 1.63.0', health0.status === 200 && health0.body.version === '1.63.0', JSON.stringify(health0.body));
  ok('本机模式：私有 Host 被拒', (await rawGet(localPort, '/api/health', '192.168.1.9:' + localPort)).status === 403);
  ok('本机模式：恶意 Host 被拒', (await rawGet(localPort, '/api/health', 'evil.example.com')).status === 403);
  const cfg0 = await c0.request('/api/auth/config');
  ok('auth/config 返回 KB 上限', cfg0.status === 200 && cfg0.body.data.kb_max_file_mb === 20, JSON.stringify(cfg0.body));

  // ---------- 2) 局域网模式基线 ----------
  const lanPort = await freePort();
  const lan = startServer({ tag: 'lan', port: lanPort, lan: true });
  servers.push(lan);
  ok('局域网模式启动', await waitHealth(lan.base));
  const c = makeClient(lanPort);
  ok('局域网：私有 Host 放行', (await rawGet(lanPort, '/api/health', '192.168.1.9:' + lanPort)).status === 200);
  ok('局域网：恶意 Host 仍 403', (await rawGet(lanPort, '/api/health', 'evil.example.com')).status === 403);
  ok('局域网：注册关闭', (await c.request('/api/auth/config')).body.data.register_enabled === false);

  // ---------- 3) 登录与基础数据 ----------
  const adminLogin = await login(c, 'admin', 'newrock123');
  ok('管理员登录', adminLogin.status === 200, JSON.stringify(adminLogin.body));
  const adminCookie = adminLogin.cookie;
  const me = await c.request('/api/auth/me', { cookie: adminCookie });
  ok('me 返回超管权限', me.status === 200 && me.body.user.role === 'superadmin');

  const teamA = await c.request('/api/teams/create', { method: 'POST', cookie: adminCookie, body: { name: '团队A' } });
  const teamB = await c.request('/api/teams/create', { method: 'POST', cookie: adminCookie, body: { name: '团队B' } });
  ok('创建团队', teamA.status === 200 && teamB.status === 200, JSON.stringify({ a: teamA.body, b: teamB.body }));
  const teamAId = teamA.body.id;
  const teamBId = teamB.body.id;

  async function createUser(username, role, teamId) {
    return c.request('/api/admin/users/create', { method: 'POST', cookie: adminCookie, body: { username: username, password: 'abc123', role: role, team_id: teamId } });
  }
  const u1 = await createUser('13800000011', 'user', teamAId);
  const u2 = await createUser('13800000012', 'user', teamAId);
  const u3 = await createUser('13800000013', 'user', teamBId);
  const u4 = await createUser('13800000014', 'user', '');
  const u5 = await createUser('13800000015', 'user', teamBId);
  ok('创建 5 个测试账号', [u1, u2, u3, u4, u5].every(function (x) { return x.status === 200 && x.body.id; }), JSON.stringify([u1.body, u2.body, u3.body, u4.body, u5.body]));
  const u1Id = u1.body.id;
  const u2Id = u2.body.id;
  const u3Id = u3.body.id;
  const u4Id = u4.body.id;
  const u5Id = u5.body.id;

  const comp = await c.request('/api/companies/create', { method: 'POST', cookie: adminCookie, body: { name: '客户X' } });
  const compId = comp.body.id;
  const p1 = await c.request('/api/projects/create', { method: 'POST', cookie: adminCookie, body: { name: '客户X-P1', company_id: compId } });
  const p2 = await c.request('/api/projects/create', { method: 'POST', cookie: adminCookie, body: { name: '客户X-P2', company_id: compId } });
  ok('创建客户与两个项目', comp.status === 200 && p1.status === 200 && p2.status === 200, JSON.stringify([comp.body, p1.body, p2.body]));
  const p1Id = p1.body.id;
  const p2Id = p2.body.id;

  // ---------- 4) 评测落库与 L1 ----------
  const layersV1 = [{ layer: 'SYSTEM', name: '系统提示词', content: 'prompt v1' }];
  const goodCases = [
    { user_query: 'q1', standard_answer: 'a1', bot_reply: '<speak>您好，我们在一起办理业务。</speak>', l2: { score: 5, pass: true, violations: [], comment: 'ok' } },
    { user_query: 'q2', standard_answer: 'a2', bot_reply: '<speak>十分感谢您的耐心等待。</speak>', l2: { score: 4, pass: true, violations: [], comment: 'ok' } },
    { user_query: 'q3', standard_answer: 'a3', bot_reply: '<speak>下午三点为您安排。</speak>', l2: { score: 4, pass: true, violations: [], comment: 'ok' } },
    { user_query: 'q4', standard_answer: 'a4', bot_reply: '<speak>千万不要着急。</speak>', l2: { score: 5, pass: true, violations: [], comment: 'ok' } },
    { user_query: 'q5', standard_answer: 'a5', bot_reply: '<speak>请稍候。</speak>', l2: { score: 5, pass: true, violations: [], comment: 'ok' } },
  ];
  const evalRun = await c.request('/api/eval/runs', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, layers: layersV1, cases: goodCases } });
  ok('评测结果落库（通过）', evalRun.status === 200 && evalRun.body.data.status === 'passed' && evalRun.body.data.case_total === 5 && evalRun.body.data.case_passed === 5, JSON.stringify(evalRun.body));
  ok('评测 L1 不误杀常用词', evalRun.status === 200 && evalRun.body.data.p0_failures === 0);
  const badRun = await c.request('/api/eval/runs', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, layers: layersV1, cases: [{ user_query: 'q', standard_answer: 'a', bot_reply: '<speak>电话号码幺三八</speak>', l2: { score: 3, pass: true } }, { user_query: 'q2', standard_answer: 'a2', bot_reply: '<tool>{"a":1}</tool>无播报标签', l2: { score: 3, pass: true } }] } });
  ok('评测 L1 拦截中文数字/缺 speak', badRun.status === 200 && badRun.body.data.p0_failures === 2 && badRun.body.data.status === 'failed', JSON.stringify(badRun.body));
  const history = await c.request('/api/eval/runs?project_id=' + p1Id + '&limit=10', { cookie: adminCookie });
  ok('评测历史可查询', history.status === 200 && history.body.data.length >= 2);

  const snap1 = await c.request('/api/snapshots/create', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, layers: layersV1, remark: 'v1' } });
  ok('提交仍写死 eval_pass=1 / eval_score=5.0', snap1.status === 200 && snap1.body.success === true, JSON.stringify(snap1.body));
  ok('提交关联同版评测 eval_run_id', snap1.status === 200 && !!snap1.body.eval_run_id, JSON.stringify(snap1.body));
  const layersV2 = [{ layer: 'SYSTEM', name: '系统提示词', content: 'prompt v2 changed' }];
  const snap2 = await c.request('/api/snapshots/create', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, layers: layersV2, remark: 'v2' } });
  ok('改过提示词后不关联旧评测', snap2.status === 200 && !snap2.body.eval_run_id, JSON.stringify(snap2.body));
  const snapList = await c.request('/api/snapshots/list?project_id=' + p1Id, { cookie: adminCookie });
  ok('提交记录评测状态仍为通过', snapList.status === 200 && snapList.body.data.length === 2 && snapList.body.data.every(function (s) { return s.eval_pass === 1 && s.eval_score === 5; }), JSON.stringify(snapList.body));
  const gateExport = await c.request('/api/gate/export?snapshot_id=' + snap1.body.snapshot_id + '&format=txt', { cookie: adminCookie });
  ok('导出仍放行（未加门禁拦截）', gateExport.status === 200);

  // ---------- 5) 授权升级：客户级 / 项目级 × 团队 / 所有团队 ----------
  const companyGrant = await c.request('/api/projects/grants/save', { method: 'POST', cookie: adminCookie, body: { scope_type: 'company', company_id: compId, targets: [{ type: 'team', id: teamAId }] } });
  ok('客户级授权给团队', companyGrant.status === 200, JSON.stringify(companyGrant.body));
  const u1Login = await login(c, '13800000011', 'abc123');
  const u1Cookie = u1Login.cookie;
  const u1Projects = await c.request('/api/projects', { cookie: u1Cookie });
  const u1Sees = (u1Projects.body.data || []).map(function (x) { return x.id; });
  ok('团队授权覆盖客户下所有项目', u1Sees.indexOf(p1Id) >= 0 && u1Sees.indexOf(p2Id) >= 0, JSON.stringify(u1Sees));
  const u1Write = await c.request('/api/kb/save', { method: 'POST', cookie: u1Cookie, body: { project_id: p1Id, pairs: [{ question: 'x', answer: 'y' }] } });
  ok('客户级授权仍为只读', u1Write.status === 403);
  const u4Login = await login(c, '13800000014', 'abc123');
  const u4ProjectsBefore = await c.request('/api/projects', { cookie: u4Login.cookie });
  ok('无团队用户不受团队授权影响', (u4ProjectsBefore.body.data || []).every(function (x) { return x.id !== p1Id; }));

  const projectOnly = await c.request('/api/projects/grants/save', { method: 'POST', cookie: adminCookie, body: { scope_type: 'project', company_id: compId, project_ids: [p1Id], targets: [{ type: 'user', id: u2Id }] } });
  ok('项目级授权给单用户', projectOnly.status === 200, JSON.stringify(projectOnly.body));
  const u2Login = await login(c, '13800000012', 'abc123');
  const u2Projects = await c.request('/api/projects', { cookie: u2Login.cookie });
  const u2Sees = (u2Projects.body.data || []).map(function (x) { return x.id; });
  ok('项目级授权只覆盖指定项目', u2Sees.indexOf(p1Id) >= 0, JSON.stringify(u2Sees));

  const allTeamsGrant = await c.request('/api/projects/grants/save', { method: 'POST', cookie: adminCookie, body: { scope_type: 'project', company_id: compId, project_ids: [p2Id], targets: [{ type: 'all', id: '' }] } });
  ok('授权给所有团队', allTeamsGrant.status === 200);
  const u4ProjectsAfter = await c.request('/api/projects', { cookie: u4Login.cookie });
  ok('所有团队授权覆盖无团队用户', (u4ProjectsAfter.body.data || []).some(function (x) { return x.id === p2Id; }));

  // 团管跨团队授权应 403
  const u3OldLogin = await login(c, '13800000013', 'abc123');
  const u3Promote = await c.request('/api/admin/users/role', { method: 'POST', cookie: adminCookie, body: { user_id: u3Id, role: 'teamadmin', team_id: teamBId } });
  ok('超管可把普通用户提升为团队管理员', u3Promote.status === 200, JSON.stringify(u3Promote.body));
  ok('角色变更后旧会话立即失效', (await c.request('/api/auth/me', { cookie: u3OldLogin.cookie })).status === 401);
  const u3Login2 = await login(c, '13800000013', 'abc123');
  const u3Cookie = u3Login2.cookie;
  const crossGrant = await c.request('/api/projects/grants/save', { method: 'POST', cookie: u3Cookie, body: { scope_type: 'company', company_id: compId, targets: [{ type: 'team', id: teamAId }] } });
  ok('团管不能跨团队/跨公司授权', crossGrant.status === 403 || crossGrant.status === 404, JSON.stringify({ status: crossGrant.status, body: crossGrant.body }));
  const u3RoleBack = await c.request('/api/admin/users/role', { method: 'POST', cookie: adminCookie, body: { user_id: u3Id, role: 'user', team_id: teamBId } });
  ok('超管可降回普通用户', u3RoleBack.status === 200);
  const u3NormalLogin = await login(c, '13800000013', 'abc123');
  const u3NormalCookie = u3NormalLogin.cookie;
  ok('团队管理员必须选团队', (await c.request('/api/admin/users/role', { method: 'POST', cookie: adminCookie, body: { user_id: u2Id, role: 'teamadmin', team_id: '' } })).status === 400);

  // ---------- 6) 回收站 ----------
  const delP2 = await c.request('/api/projects/delete', { method: 'POST', cookie: adminCookie, body: { id: p2Id } });
  ok('删除项目进入回收站', delP2.status === 200 && delP2.body.batch, JSON.stringify(delP2.body));
  const adminProjectsAfterDel = await c.request('/api/projects', { cookie: adminCookie });
  ok('回收站项目不出现在项目树', !(adminProjectsAfterDel.body.data || []).some(function (x) { return x.id === p2Id; }));
  ok('回收站项目的知识库接口 404', (await c.request('/api/kb/list?project_id=' + p2Id, { cookie: adminCookie })).status === 404);
  const recycle1 = await c.request('/api/recycle/list', { cookie: adminCookie });
  ok('回收站列表可见', recycle1.status === 200 && (recycle1.body.data || []).some(function (x) { return x.type === 'project' && x.id === p2Id; }), JSON.stringify(recycle1.body).slice(0, 300));
  ok('回收站默认保留 30 天', recycle1.status === 200 && recycle1.body.retention_days === 30);
  const restoreP2 = await c.request('/api/recycle/restore', { method: 'POST', cookie: adminCookie, body: { type: 'project', id: p2Id } });
  ok('恢复项目', restoreP2.status === 200, JSON.stringify(restoreP2.body));
  ok('恢复后项目回到项目树', (await c.request('/api/projects', { cookie: adminCookie })).body.data.some(function (x) { return x.id === p2Id; }));

  const delComp = await c.request('/api/companies/delete', { method: 'POST', cookie: adminCookie, body: { id: compId } });
  ok('删除公司级联进回收站', delComp.status === 200 && delComp.body.projects >= 2, JSON.stringify(delComp.body));
  ok('公司删除后项目树无该项目', !(await c.request('/api/projects', { cookie: adminCookie })).body.data.some(function (x) { return x.id === p1Id; }));
  const restoreComp = await c.request('/api/recycle/restore', { method: 'POST', cookie: adminCookie, body: { type: 'company', id: compId } });
  ok('恢复公司级联恢复项目', restoreComp.status === 200);
  ok('恢复后项目重新可见', (await c.request('/api/projects', { cookie: adminCookie })).body.data.some(function (x) { return x.id === p1Id; }));

  // KB 单项软删/恢复
  await c.request('/api/kb/save', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, pairs: [{ question: '回收站测试Q', answer: 'A' }] } });
  const kbAll = await c.request('/api/kb/list?project_id=' + p1Id + '&page=1&page_size=200', { cookie: adminCookie });
  const kbItem = kbAll.body.data.find(function (x) { return x.question === '回收站测试Q'; });
  ok('知识条目创建成功', !!kbItem);
  await c.request('/api/kb/delete', { method: 'POST', cookie: adminCookie, body: { id: kbItem.id } });
  const kbAfterDel = await c.request('/api/kb/list?project_id=' + p1Id + '&page=1&page_size=200', { cookie: adminCookie });
  ok('知识条目删除后不可见', !kbAfterDel.body.data.some(function (x) { return x.id === kbItem.id; }));
  const restoreKb = await c.request('/api/recycle/restore', { method: 'POST', cookie: adminCookie, body: { type: 'kb', id: kbItem.id } });
  ok('知识条目可从回收站恢复', restoreKb.status === 200 && (await c.request('/api/kb/list?project_id=' + p1Id + '&page=1&page_size=200', { cookie: adminCookie })).body.data.some(function (x) { return x.id === kbItem.id; }));

  // 提交记录软删/恢复 + 彻底删除
  const snap3 = await c.request('/api/snapshots/create', { method: 'POST', cookie: adminCookie, body: { project_id: p2Id, layers: layersV1, remark: 'to-delete' } });
  await c.request('/api/snapshots/delete', { method: 'POST', cookie: adminCookie, body: { id: snap3.body.snapshot_id } });
  ok('提交记录删除后列表不可见', !(await c.request('/api/snapshots/list?project_id=' + p2Id, { cookie: adminCookie })).body.data.some(function (x) { return x.id === snap3.body.snapshot_id; }));
  ok('提交记录可从回收站恢复', (await c.request('/api/recycle/restore', { method: 'POST', cookie: adminCookie, body: { type: 'snapshot', id: snap3.body.snapshot_id } })).status === 200);
  await c.request('/api/snapshots/delete', { method: 'POST', cookie: adminCookie, body: { id: snap3.body.snapshot_id } });
  const purgeSnap = await c.request('/api/recycle/purge', { method: 'POST', cookie: adminCookie, body: { type: 'snapshot', id: snap3.body.snapshot_id } });
  ok('彻底删除回收站记录', purgeSnap.status === 200);
  ok('彻底删除后恢复接口 404', (await c.request('/api/recycle/restore', { method: 'POST', cookie: adminCookie, body: { type: 'snapshot', id: snap3.body.snapshot_id } })).status === 404);
  ok('非回收站记录不能彻底删除', (await c.request('/api/recycle/purge', { method: 'POST', cookie: adminCookie, body: { type: 'project', id: p1Id } })).status === 409);
  ok('普通用户不能访问回收站', (await c.request('/api/recycle/list', { cookie: u1Cookie })).status === 403);

  // ---------- 7) 知识库分页 / 搜索 / 文件上限 ----------
  const bulk = [];
  for (let i = 1; i <= 60; i++) bulk.push({ question: '批量Q' + i, answer: '批量A' + i });
  await c.request('/api/kb/save', { method: 'POST', cookie: adminCookie, body: { project_id: p2Id, pairs: bulk } });
  const page1 = await c.request('/api/kb/list?project_id=' + p2Id + '&page=1&page_size=25', { cookie: adminCookie });
  const page3 = await c.request('/api/kb/list?project_id=' + p2Id + '&page=3&page_size=25', { cookie: adminCookie });
  ok('知识库分页返回 total', page1.status === 200 && page1.body.total === 60 && page1.body.data.length === 25, JSON.stringify({ total: page1.body.total, len: page1.body.data.length }));
  ok('知识库第 3 页数量正确', page3.status === 200 && page3.body.data.length === 10, JSON.stringify({ len: page3.body.data.length }));
  const searchRes = await c.request('/api/kb/list?project_id=' + p2Id + '&q=' + encodeURIComponent('批量Q5') + '&page=1&page_size=50', { cookie: adminCookie });
  ok('知识库服务端搜索', searchRes.status === 200 && searchRes.body.total >= 1 && searchRes.body.data.every(function (x) { return String(x.question).indexOf('批量Q5') >= 0; }), JSON.stringify({ total: searchRes.body.total }));
  const bigBase64 = Buffer.alloc(21 * 1024 * 1024, 97).toString('base64');
  const tooBig = await c.request('/api/kb/extract-text', { method: 'POST', cookie: adminCookie, body: { file_name: 'big.txt', file_base64: bigBase64 } });
  ok('超大文件返回 413 JSON', tooBig.status === 413 && tooBig.body && tooBig.body.code === 'FILE_TOO_LARGE', JSON.stringify(tooBig.body));

  // ---------- 8) 用量统计（mock LLM） ----------
  const mock = await startMockLlm();
  try {
    const mockBase = 'http://' + HOST + ':' + mock.port + '/v1';
    const saveModel = await c.request('/api/models/save', { method: 'POST', cookie: adminCookie, body: { provider: 'custom', display_name: 'Mock', base_url: mockBase, model_name: 'mock-model', api_key: 'sk-mock-12345678901234567890', temperature: 0, is_active: true, price_input_per_m: 1, price_output_per_m: 2 } });
    ok('保存 mock 模型并启用', saveModel.status === 200 && saveModel.body.is_active === 1, JSON.stringify(saveModel.body));
    const modelList = await c.request('/api/models', { cookie: adminCookie });
    const mockModel = modelList.body.data.find(function (m) { return m.id === saveModel.body.id; });
    ok('模型单价可读写', mockModel && mockModel.price_input_per_m === 1 && mockModel.price_output_per_m === 2, JSON.stringify(mockModel));
    const chat = await c.request('/api/chat/reply', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, layers: layersV1, messages: [{ role: 'user', content: '你好' }] } });
    ok('mock LLM 对话成功', chat.status === 200 && String(chat.body.reply).indexOf('<speak>') >= 0, JSON.stringify(chat.body));
    await sleep(200);
    const usage = await c.request('/api/admin/usage/summary?days=7', { cookie: adminCookie });
    ok('用量汇总记录到调用', usage.status === 200 && usage.body.data.totals.requests >= 1 && usage.body.data.totals.prompt_tokens >= 10, JSON.stringify(usage.body.data && usage.body.data.totals));
    ok('用量汇总按模型/按用户/按天', usage.status === 200 && Array.isArray(usage.body.data.by_model) && usage.body.data.by_model.length >= 1 && Array.isArray(usage.body.data.by_user) && Array.isArray(usage.body.data.by_day));
    ok('估算成本大于 0', usage.status === 200 && usage.body.data.totals.est_cost > 0, JSON.stringify(usage.body.data && usage.body.data.totals));
    ok('普通用户不能看用量', (await c.request('/api/admin/usage/summary', { cookie: u1Cookie })).status === 403);
  } finally {
    mock.server.close();
  }

  // ---------- 9) 所有权移交 ----------
  const transferCand = await c.request('/api/projects/transfer/candidates?project_id=' + p1Id, { cookie: adminCookie });
  ok('移交候选人列表', transferCand.status === 200 && transferCand.body.data.length >= 1, JSON.stringify(transferCand.body).slice(0, 200));
  const transfer = await c.request('/api/projects/transfer', { method: 'POST', cookie: adminCookie, body: { project_id: p1Id, target_user_id: u2Id } });
  ok('项目移交成功', transfer.status === 200, JSON.stringify(transfer.body));
  const u2ProjectsAfter = await c.request('/api/projects', { cookie: u2Login.cookie });
  const transferred = (u2ProjectsAfter.body.data || []).find(function (x) { return x.id === p1Id; });
  ok('新所有者可见且可写', !!transferred && transferred.can_write === 1, JSON.stringify(transferred));
  ok('新所有者可创建提交', (await c.request('/api/snapshots/create', { method: 'POST', cookie: u2Login.cookie, body: { project_id: p1Id, layers: layersV1 } })).status === 200);
  ok('普通用户不能移交项目', (await c.request('/api/projects/transfer', { method: 'POST', cookie: u3NormalCookie, body: { project_id: p1Id, target_user_id: u1Id } })).status === 403);
  const u3TeamadminAgain = await c.request('/api/admin/users/role', { method: 'POST', cookie: adminCookie, body: { user_id: u3Id, role: 'teamadmin', team_id: teamBId } });
  const u3TeamadminLogin = await login(c, '13800000013', 'abc123');
  const crossTransfer = await c.request('/api/projects/transfer', { method: 'POST', cookie: u3TeamadminLogin.cookie, body: { project_id: p1Id, target_user_id: u1Id } });
  ok('团管不能移交外团队项目', u3TeamadminAgain.status === 200 && (crossTransfer.status === 403 || crossTransfer.status === 404), JSON.stringify(crossTransfer.body));

  // ---------- 10) 强制删除 ----------
  const up = await c.request('/api/projects/create', { method: 'POST', cookie: adminCookie, body: { name: '待强制删除项目', company_id: compId } });
  await c.request('/api/snapshots/create', { method: 'POST', cookie: adminCookie, body: { project_id: up.body.id, layers: layersV1 } });
  // 把项目移交到 u5 名下
  await c.request('/api/projects/transfer', { method: 'POST', cookie: adminCookie, body: { project_id: up.body.id, target_user_id: u5Id } });
  const delBusy = await c.request('/api/admin/users/delete', { method: 'POST', cookie: adminCookie, body: { user_id: u5Id } });
  ok('有数据的账号普通删除被拒', delBusy.status === 409 && delBusy.body.code === 'USER_HAS_DATA' && delBusy.body.counts, JSON.stringify(delBusy.body));
  const forceTransfer = await c.request('/api/admin/users/delete', { method: 'POST', cookie: adminCookie, body: { user_id: u5Id, force: true, data_mode: 'transfer' } });
  ok('强制删除（数据移交）成功', forceTransfer.status === 200 && forceTransfer.body.mode === 'transfer', JSON.stringify(forceTransfer.body));
  ok('移交后项目归超管可见', (await c.request('/api/projects', { cookie: adminCookie })).body.data.some(function (x) { return x.id === up.body.id; }));

  const u6 = await createUser('13800000016', 'user', teamBId);
  const up2 = await c.request('/api/projects/create', { method: 'POST', cookie: adminCookie, body: { name: '待删除项目2', company_id: compId } });
  await c.request('/api/projects/transfer', { method: 'POST', cookie: adminCookie, body: { project_id: up2.body.id, target_user_id: u6.body.id } });
  const forceDelete = await c.request('/api/admin/users/delete', { method: 'POST', cookie: adminCookie, body: { user_id: u6.body.id, force: true, data_mode: 'delete' } });
  ok('强制删除（连同数据进回收站）成功', forceDelete.status === 200 && forceDelete.body.mode === 'delete', JSON.stringify(forceDelete.body));
  const recycle2 = await c.request('/api/recycle/list?type=project&page=1&page_size=50', { cookie: adminCookie });
  ok('强制删除的项目进入回收站', recycle2.status === 200 && recycle2.body.data.some(function (x) { return x.id === up2.body.id; }), JSON.stringify(recycle2.body).slice(0, 300));

  // ---------- 11) 备份可选表兼容 ----------
  const fullBackup = await c.request('/api/backup/export?scope=full', { cookie: adminCookie });
  ok('全量备份含新表', fullBackup.status === 200 && !!fullBackup.body.tables.read_grants && !!fullBackup.body.tables.llm_usage, Object.keys(fullBackup.body.tables || {}).join(','));
  const legacyFull = JSON.parse(JSON.stringify(fullBackup.body));
  delete legacyFull.tables.read_grants;
  delete legacyFull.tables.llm_usage;
  const importLegacy = await c.request('/api/backup/import', { method: 'POST', cookie: adminCookie, body: legacyFull });
  ok('旧全量备份（缺可选表）仍可导入', importLegacy.status === 200, JSON.stringify(importLegacy.body).slice(0, 300));

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
    console.log('临时数据目录已保留用于排查：data/tmp/smoke163-' + STAMP + '-*');
  }
}
process.exit(exitCode);
