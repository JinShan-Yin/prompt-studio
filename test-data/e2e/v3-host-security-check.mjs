// V3.0 P2-B 安全加固验证：Host 校验（DNS rebinding 防护）+ 安全响应头 + SPA fallback 修正
import http from 'node:http';
const PORT = Number(process.env.PORT || 3000);
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
  results.push({ name, ok: !!cond, detail });
};
function rawRequest(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
(async () => {
  console.log('== [1] Host 头校验（DNS rebinding 防护） ==');
  // 正常 Host
  let r = await rawRequest('/api/projects', { Host: '127.0.0.1:' + PORT });
  check('Host=127.0.0.1 正常放行 200', r.status === 200, { status: r.status });
  r = await rawRequest('/api/projects', { Host: 'localhost:' + PORT });
  check('Host=localhost 正常放行 200', r.status === 200, { status: r.status });
  // 伪造 Host（DNS rebinding 场景）
  r = await rawRequest('/api/projects', { Host: 'evil.example.com:' + PORT });
  check('伪造 Host=evil.example.com → 403（防 DNS rebinding）', r.status === 403 && /Host 不被允许/.test(r.body), { status: r.status, body: r.body.slice(0, 200) });
  r = await rawRequest('/api/kb/list?project_id=proj-597e1045', { Host: 'attacker.test:' + PORT });
  check('伪造 Host 读取 KB → 403', r.status === 403, { status: r.status });
  r = await rawRequest('/api/gate/export?snapshot_id=x', { Host: 'attacker.test:' + PORT });
  check('伪造 Host 读导出接口 → 403', r.status === 403, { status: r.status });

  console.log('== [2] 安全响应头 ==');
  r = await rawRequest('/', { Host: '127.0.0.1:' + PORT });
  check('首页 200 且 X-Frame-Options: DENY', r.status === 200 && String(r.headers['x-frame-options'] || '').toUpperCase() === 'DENY', { status: r.status, xfo: r.headers['x-frame-options'] });
  check("CSP 含 frame-ancestors 'none'", /frame-ancestors\s+'none'/i.test(String(r.headers['content-security-policy'] || '')), r.headers['content-security-policy']);
  check('X-Content-Type-Options: nosniff', String(r.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff', r.headers['x-content-type-options']);

  console.log('== [3] SPA fallback 修正（缺失静态资源不再被 HTML 掩盖） ==');
  r = await rawRequest('/missing-asset.js', { Host: '127.0.0.1:' + PORT });
  check('缺失 .js 文件 → 404（非 200 HTML）', r.status === 404 && !/text\/html/.test(String(r.headers['content-type'] || '')), { status: r.status, ct: r.headers['content-type'] });
  r = await rawRequest('/random-spa-path', { Host: '127.0.0.1:' + PORT });
  check('无扩展名 SPA 路径 → 200 HTML 回退', r.status === 200 && /text\/html/.test(String(r.headers['content-type'] || '')), { status: r.status, ct: r.headers['content-type'] });
  r = await rawRequest('/logo.png', { Host: '127.0.0.1:' + PORT });
  check('logo.png 返回真实图片（200 image/png）', r.status === 200 && /image\/png/.test(String(r.headers['content-type'] || '')), { status: r.status, ct: r.headers['content-type'] });

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ Host/安全头/SPA fallback 验证全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
