#!/usr/bin/env node
/**
 * v1.65 文案口径检查：用户可见文案不得再出现「快照」
 * 用法：node scripts/qa-wording.mjs
 *
 * 规则（白名单）：
 *  1. 备份域概念保留「启动前快照 / 备份快照」；
 *  2. 代码注释（// * /* <!--）不参与文案检查；
 *  3. 服务端内部日志（console.*）不算用户可见文案。
 * 其余出现「快照」的行一律判违规并以退出码 1 失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['public/index.html', 'server.js'];
const WORD = '快照';
const violations = [];
let hits = 0;

for (const rel of files) {
  const full = path.join(root, rel);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.indexOf(WORD) < 0) return;
    hits += 1;
    const allowed = /启动前|备份快照/.test(line)
      || /^\s*(\/\/|\*|\/\*|<!--)/.test(line)
      || /console\.(log|warn|error|info)\(/.test(line);
    if (!allowed) violations.push({ file: rel, line: index + 1, text: line.trim().slice(0, 160) });
  });
}

for (const v of violations) console.log(`[qa-wording] ${v.file}:${v.line} ${v.text}`);
console.info(`[qa-wording] 含「${WORD}」行 ${hits} 条，白名单外 ${violations.length} 条`);
process.exit(violations.length === 0 ? 0 : 1);
