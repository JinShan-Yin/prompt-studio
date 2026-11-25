#!/usr/bin/env node
/**
 * 生成页面按钮/事件处理清单（V1.63 全量回归用）
 * 用法：node scripts/qa-button-inventory.mjs
 * 输出：每个内联事件处理函数名与出现次数，供 QA 清单逐项打勾。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const re = /on(?:click|change|input|keydown)="([^"]+)"/g;
const noise = new Set(['click', 'if', 'getAttribute', 'getElementById', 'escapeHtml', 'stopPropagation', 'String', 'Number']);
const handlers = new Map();
let match;
while ((match = re.exec(html))) {
  for (const found of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = found[1];
    if (noise.has(name)) continue;
    handlers.set(name, (handlers.get(name) || 0) + 1);
  }
}
const list = [...handlers.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, count] of list) console.log(name + '\t' + count);
console.info('[qa] 共 ' + list.length + ' 个页面事件处理函数');
