import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const PORT = 3081;
const DSH_PORT = 3080;

const server = http.createServer((req, res) => {
  // 1. 拦截 /api 请求，转发给 3080
  if (req.url.startsWith('/api/')) {
    let bodyData = [];
    req.on('data', chunk => bodyData.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(bodyData);
      const options = {
        hostname: '127.0.0.1', port: DSH_PORT, path: req.url,
        method: req.method, headers: req.headers
      };
      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => { res.writeHead(500); res.end(e.message); });
      if (buffer.length > 0) proxyReq.write(buffer);
      proxyReq.end();
    });
    return;
  }

  // 2. 静态文件托管（加入 MIME 类型判断）
  const pathname = req.url.split('?')[0];
  let filePath = pathname === '/' ? '/public/index.html' : pathname;
  filePath = path.join(process.cwd(), filePath);

  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`🚀 UI 代理已启动: http://127.0.0.1:${PORT}`));