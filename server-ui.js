// server-ui.js
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3081;
const DSH_PORT = 3080;

const server = http.createServer((req, res) => {
  // 1. 拦截以 /api 开头的请求，做反向代理
  if (req.url.startsWith('/api/')) {
    let bodyData = [];
    req.on('data', chunk => bodyData.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(bodyData);
      
      const options = {
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: req.url, // 把路径和 token 原封不动转发过去
        method: req.method,
        headers: req.headers
      };

      const proxyReq = http.request(options, (proxyRes) => {
        // 直接把 DSH 返回的状态码和 Header 透传给前端
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (e) => {
        res.writeHead(500);
        res.end(`Proxy Error: ${e.message}`);
      });

      if (buffer.length > 0) proxyReq.write(buffer);
      proxyReq.end();
    });
    return;
  }

  // 2. 处理静态文件 (index.html 等)
  const pathname = req.url.split('?')[0];
  let filePath = pathname === '/' ? '/public/index.html' : pathname;
  filePath = path.join(process.cwd(), filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 UI 代理服务已启动！请访问: http://127.0.0.1:${PORT}/?token=您的Token`);
});