// 汇总套件一网络路由断言（解析 qa-network-tap.log）
import fs from 'node:fs';
const log = fs.existsSync('test-data/e2e/qa-network-tap.log') ? fs.readFileSync('test-data/e2e/qa-network-tap.log', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const cfg = JSON.parse(fs.readFileSync('test-data/e2e/qa-result-kimi-config.json', 'utf8'));
const moonshotReq = log.find((x) => /api\.moonshot\.cn/.test(x.url));
const deepseekFallback = log.find((x) => /api\.deepseek\.com/.test(x.url));
const results = [
  { name: '1.2a Kimi 模型配置保存且 Base URL 为 moonshot', ok: cfg.baseUrl === 'https://api.moonshot.cn/v1' && cfg.saved === true, detail: { baseUrl: cfg.baseUrl, modelName: cfg.modelName, saved: cfg.saved } },
  { name: '1.2b 拦截到出站请求 URL 包含 moonshot.cn', ok: !!moonshotReq && /api\.moonshot\.cn/.test(moonshotReq.url), detail: moonshotReq ? { url: moonshotReq.url, method: moonshotReq.method, authMasked: moonshotReq.authMasked } : null },
  { name: '1.2c 出站请求 Authorization 携带配置的假 Key（尾号 7890）', ok: !!moonshotReq && /7890/.test(moonshotReq.authMasked || '') && moonshotReq.hasAuth === true, detail: moonshotReq ? { hasAuth: moonshotReq.hasAuth, authMasked: moonshotReq.authMasked } : null },
  { name: '1.2d 请求失败后自动回落 .env（DeepSeek）链路仍可用', ok: !!deepseekFallback && /api\.deepseek\.com/.test(deepseekFallback.url), detail: deepseekFallback ? { url: deepseekFallback.url, authMasked: deepseekFallback.authMasked } : null },
];
const pass = results.every((r) => r.ok);
fs.writeFileSync('test-data/e2e/qa-result-s1-route.json', JSON.stringify({ results, pass, requestCount: log.length }, null, 2));
console.log(JSON.stringify({ pass, results }, null, 2));
