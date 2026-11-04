// QA 网络探针（preload）：记录后端出站 fetch URL 与 Authorization 掩码，用于多模型路由断言
// 不记录完整 Key，真实 .env Key 永不落盘。
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'qa-network-tap.log');
const origFetch = global.fetch;
function maskAuth(value) {
  if (!value) return '';
  const m = /^Bearer\s+(.+)$/i.exec(String(value));
  const token = m ? m[1] : String(value);
  if (token.length <= 10) return '**masked**';
  return 'Bearer ' + token.slice(0, 6) + '****' + token.slice(-4);
}
global.fetch = function qaTapFetch(url, options) {
  try {
    const headers = options && options.headers ? options.headers : {};
    let auth = '';
    let headerKeys = [];
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
      headerKeys = [];
      headers.forEach((v, k) => { headerKeys.push(k); if (String(k).toLowerCase() === 'authorization') auth = maskAuth(v); });
    } else if (Array.isArray(headers)) {
      headers.forEach(([k, v]) => { headerKeys.push(k); if (String(k).toLowerCase() === 'authorization') auth = maskAuth(v); });
    } else if (headers && typeof headers === 'object') {
      headerKeys = Object.keys(headers);
      const ak = headerKeys.find((k) => String(k).toLowerCase() === 'authorization');
      if (ak) auth = maskAuth(headers[ak]);
    }
    fs.appendFileSync(LOG, JSON.stringify({
      ts: Date.now(),
      url: String(url || ''),
      method: (options && options.method) || 'GET',
      hasAuth: !!auth,
      authMasked: auth,
      headerKeys,
    }) + '\n');
  } catch (e) { /* 探针不得影响业务 */ }
  return origFetch.apply(this, arguments);
};
