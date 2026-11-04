#!/usr/bin/env node
// scripts/restart-server.cjs — 安全重启 3000 端口的纯 Node 服务（开发/验收用）
// 用法: node scripts/restart-server.cjs
const { execSync, spawn } = require('child_process');
const net = require('net');

const PORT = Number(process.env.PORT || 3000);

function listListeningPids(port) {
  const pids = [];
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(new RegExp('[:.]' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'));
      if (m) pids.push(Number(m[1]));
    }
  } catch (e) { /* ignore */ }
  return [...new Set(pids)];
}

function killPids(pids) {
  for (const pid of pids) {
    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true }); }
    catch (e) { /* ignore */ }
  }
}

function waitPortFree(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); if (Date.now() - t0 > timeoutMs) return resolve(false); setTimeout(tick, 200); });
      sock.once('error', () => resolve(true));
    };
    tick();
  });
}

(async () => {
  const old = listListeningPids(PORT);
  if (old.length) {
    console.log(`[restart] 释放端口 ${PORT} 占用进程: ${old.join(',')}`);
    killPids(old);
    await waitPortFree(PORT, 8000);
  }
  // 清理可能的孤儿 server.js 进程（仅当端口未释放时）
  if (listListeningPids(PORT).length) {
    console.error(`[restart] 端口 ${PORT} 仍被占用，请手动检查！`);
    process.exit(1);
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT) }
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 1800));
  const pids = listListeningPids(PORT);
  if (!pids.length) {
    console.error('[restart] 启动失败：端口未监听，请查看 node server.js 输出');
    process.exit(1);
  }
  console.log(`[restart] OK: http://127.0.0.1:${PORT} (pid ${pids.join(',')})`);
})();
