#!/usr/bin/env node
/**
 * Prompt Studio V3.0 · 纯 Node.js + Express 独立服务（阶段一 + 阶段二多模型路由 + 阶段四后端）
 * ============================================================
 * 运行方式：node server.js        监听 http://127.0.0.1:3000
 *
 * 说明：
 * - 本文件**不 import / require 任何 plugins/ 目录下的文件**，原 Cordis 插件里的
 *   全部 API 逻辑（DB 初始化、语境引擎、快照组装/导出、知识库、评测/多轮对话、
 *   发布门禁、API Key 设置）已平移/内联到本文件，作为独立应用运行。
 * - 不再需要 token 校验；静态资源直接托管 public/。
 * - 阶段二：多模型路由中枢（GET/POST /api/models*），chatCompletion 按 model_configs 的
 *   is_active=1 模型动态路由；无激活模型或 DB 模型调用失败时自动回落 .env 配置（含重试一次）。
 * - 阶段四后端：知识库在线编辑 /api/kb/update、AI 生成刁钻测试题 /api/eval/generate_questions。
 *
 * 依赖：express@5 / cors / better-sqlite3 / dotenv / p-limit / archiver@8（纯 ESM）
 */

import 'dotenv/config'; // 自动读取项目根 .env 到 process.env
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import pLimit from 'p-limit';
import { ZipArchive } from 'archiver'; // archiver@8 纯 ESM：无 default export

// ============================================================
// 一、常量与运行环境
// ============================================================

const PORT = 3000;
const HOST = '127.0.0.1';
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'prompt-studio.db');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const KEY_NAME = 'DEEPSEEK_API_KEY';
const API_KEY_MIN_LENGTH = 20;

// 快照层顺序（与 V2.0 保持一致）
const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3.5', 'L3'];
// 发送给大模型的知识库文本上限
const KB_TEXT_MAX = 12000;
// 知识库 FAQ 解析分段大小
const KB_CHUNK_SIZE = 500;

// 阶段一固定 LLM 配置（阶段二将改为按 model_configs 动态路由）
const DEFAULT_LLM_CONFIG = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.1 };
const CHAT_LLM_CONFIG = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.7 };

// 多轮对话参数
const CHAT_HISTORY_LIMIT = 12;
const CHAT_CONTENT_MAX = 4000;
const DEFAULT_CHAT_ROLE = '你是一个专业、礼貌、高效的智能语音客服助手。';
const CHAT_OUTPUT_CONSTRAINTS = '\n\n【输出约束】请使用自然口语回答；最终回复必须整体用 <speak>...</speak> 包裹；禁止使用 Markdown、列表符号或标题。';

// ============================================================
// 安全：模型 Base URL 校验与 API Key 注入策略（防 SSRF / .env Key 外泄）
// 1) 非本机地址必须 https；禁止内网/链路本地地址（SSRF）；
// 2) .env 的真实 Key 只允许注入「官方 DeepSeek 端点」；
//    自定义/第三方端点必须显式填写该模型的 API Key，绝不自动回退 .env Key，
//    否则「任意 base_url + 自动回退 env Key」会把真实 Key 发给攻击者域名。
// ============================================================
const ENV_KEY_ALLOWED_HOSTS = new Set(['api.deepseek.com']);
const KNOWN_LLM_HOSTS = new Set([
  'api.deepseek.com', 'api.openai.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn', 'api.moonshot.cn',
]);
function parseModelBaseUrl(raw) {
  try { return new URL(String(raw || '')); } catch { return null; }
}
function validateModelBaseUrl(raw) {
  const u = parseModelBaseUrl(raw);
  if (!u) return { ok: false, error: 'Base URL 不是合法 URL' };
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Base URL 必须为 http(s)' };
  const host = u.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:' && !isLoopback) return { ok: false, error: '非本机 Base URL 必须使用 https' };
  const privateV4 = /^(0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/;
  if (!isLoopback && privateV4.test(host)) return { ok: false, error: 'Base URL 不允许指向内网/链路本地地址' };
  return { ok: true, host, isLoopback, isEnvKeyAllowed: ENV_KEY_ALLOWED_HOSTS.has(host) };
}
function resolveModelApiKey(baseUrl, explicitKey) {
  const provided = typeof explicitKey === 'string' ? explicitKey.trim() : '';
  if (provided) return provided;
  const validation = validateModelBaseUrl(baseUrl);
  if (validation.ok && validation.isEnvKeyAllowed) return process.env[KEY_NAME] || '';
  return '';
}

// LLM 并发限流（与旧 gateway 一致：最多 5 并发）
const llmLimit = pLimit(5);

// ============================================================
// 二、数据库初始化（内联原 plugins/db.js，保持表结构与幂等迁移）
// ============================================================

function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');

  // 建表语句（与原 db.js 完全一致；projects 含 context_json）
  database.exec(`
    CREATE TABLE IF NOT EXISTS model_configs ( id TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, model_name TEXT NOT NULL, temperature REAL DEFAULT 0.1, max_context_length INTEGER NOT NULL DEFAULT 32000, is_active INTEGER DEFAULT 1 );
    CREATE TABLE IF NOT EXISTS companies ( id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL );
    CREATE TABLE IF NOT EXISTS projects ( id TEXT PRIMARY KEY, company_id TEXT, name TEXT NOT NULL, target_agent_id TEXT, context_json TEXT DEFAULT '{}' );
    CREATE TABLE IF NOT EXISTS modules ( id TEXT PRIMARY KEY, layer TEXT, name TEXT, sensitivity TEXT DEFAULT 'P2' );
    CREATE TABLE IF NOT EXISTS module_versions ( id TEXT PRIMARY KEY, module_id TEXT, version TEXT, content TEXT );
    CREATE TABLE IF NOT EXISTS kb_items ( id TEXT PRIMARY KEY, project_id TEXT, question TEXT, answer TEXT );
    CREATE TABLE IF NOT EXISTS kb_item_versions ( id TEXT PRIMARY KEY, item_id TEXT, version_hash TEXT, content TEXT, is_deleted INTEGER DEFAULT 0 );
    CREATE TABLE IF NOT EXISTS snapshots ( id TEXT PRIMARY KEY, project_id TEXT, module_versions_json TEXT, kb_versions_json TEXT, final_prompt_content TEXT, eval_run_id TEXT, p0_validation_log TEXT, created_at TEXT, exported_at TEXT, eval_pass INTEGER DEFAULT 0, eval_score REAL DEFAULT 0 );
    CREATE TABLE IF NOT EXISTS eval_runs ( id TEXT PRIMARY KEY, snapshot_id TEXT, l1_pass_rate REAL, l2_avg_score REAL, status TEXT );
  `);

  // 兼容旧库：snapshots 缺 eval_pass / eval_score 时补列
  try {
    const snapshotColumns = database.prepare('PRAGMA table_info(snapshots)').all();
    if (!snapshotColumns.some((c) => c.name === 'eval_pass')) {
      database.exec('ALTER TABLE snapshots ADD COLUMN eval_pass INTEGER DEFAULT 0;');
      database.exec('ALTER TABLE snapshots ADD COLUMN eval_score REAL DEFAULT 0;');
    }
  } catch (e) {
    console.error('[db] 数据库升级检查失败（snapshots.eval_pass/eval_score）:', e.message);
  }

  // 兼容旧库：V2.0 语境提取需要 projects.context_json 字段
  try {
    const projectColumns = database.prepare('PRAGMA table_info(projects)').all();
    if (!projectColumns.some((c) => c.name === 'context_json')) {
      database.exec("ALTER TABLE projects ADD COLUMN context_json TEXT DEFAULT '{}';");
    }
  } catch (e) {
    console.error('[db] 数据库升级检查失败（projects.context_json）:', e.message);
  }

  // 兼容旧库：V3.0 model_configs 必须有完整列（阶段二动态模型路由使用）
  try {
    const modelColumns = database.prepare('PRAGMA table_info(model_configs)').all().map((c) => c.name);
    const requiredModelColumns = [
      ['id', 'TEXT'],
      ['provider', 'TEXT'],
      ['display_name', 'TEXT'],
      ['base_url', 'TEXT'],
      ['api_key', 'TEXT'],
      ['model_name', 'TEXT'],
      ['temperature', 'REAL DEFAULT 0.1'],
      ['max_context_length', 'INTEGER DEFAULT 32000'],
      ['is_active', 'INTEGER DEFAULT 1'],
    ];
    for (const [column, definition] of requiredModelColumns) {
      if (!modelColumns.includes(column)) {
        database.exec(`ALTER TABLE model_configs ADD COLUMN ${column} ${definition};`);
        console.log(`[db] model_configs 补充列: ${column}`);
      }
    }
  } catch (e) {
    console.error('[db] 数据库升级检查失败（model_configs）:', e.message);
  }

  return database;
}

let db;
try {
  db = initDb();
} catch (e) {
  console.error('[server] 数据库初始化失败，服务无法启动:', e.message);
  console.error('  提示：请检查 data/ 目录权限，或从备份恢复 data/prompt-studio.db');
  process.exit(1);
}

// ============================================================
// 三、可复用纯函数 / 业务函数（从原插件内联平移）
// ============================================================

/** 转义正则元字符 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 3.1 API Key 设置（原 settings-engine） ----------

/** API Key 脱敏：长度>8 取前3 + '****' + 后4，否则 '****'；绝不返回完整 Key */
function maskApiKey(raw) {
  if (typeof raw !== 'string') return '****';
  const key = raw.trim();
  if (!key) return '****';
  if (key.length > 8) return `${key.slice(0, 3)}****${key.slice(-4)}`;
  return '****';
}

/** 校验 API Key：长度 >= 20 且不含空白/换行 */
function validateApiKey(raw) {
  if (typeof raw !== 'string') return false;
  const key = raw.trim();
  if (key.length < API_KEY_MIN_LENGTH) return false;
  return !/\s/.test(key);
}

/** .env 内容中替换/追加 KEY=value（保留其它行与注释，回调替换防 $& 注入） */
function upsertEnvLine(envContent, keyName = KEY_NAME, value = '') {
  const content = typeof envContent === 'string' ? envContent : '';
  const name = typeof keyName === 'string' && keyName.trim() ? keyName.trim() : KEY_NAME;
  const line = `${name}=${String(value ?? '')}`;
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, () => line);
  if (!content) return `${line}\n`;
  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${line}\n`;
}

/** 从 .env 文本解析 KEY 值（支持引号包裹） */
function parseEnvValue(envContent, keyName) {
  if (typeof envContent !== 'string' || !envContent) return '';
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(keyName)}[ \\t]*=(.*)$`, 'm');
  const match = envContent.match(pattern);
  if (!match) return '';
  let value = match[1].trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
  }
  return value.trim();
}

function readEnvContent() {
  try { return fs.readFileSync(ENV_PATH, 'utf-8'); } catch { return ''; }
}

/** 当前生效 Key：优先 process.env，回落 .env 文件 */
function getCurrentApiKey() {
  const fromProcess = typeof process.env[KEY_NAME] === 'string' ? process.env[KEY_NAME].trim() : '';
  if (fromProcess) return fromProcess;
  return parseEnvValue(readEnvContent(), KEY_NAME);
}

/** 原子写 .env：临时文件 + rename */
function atomicWriteEnv(content) {
  const tmpPath = path.join(path.dirname(ENV_PATH), `.env.tmp-${process.pid}-${crypto.randomUUID().split('-')[0]}`);
  let mode = 0o600;
  try { mode = fs.statSync(ENV_PATH).mode; } catch { /* 文件不存在，用默认权限 */ }
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
  try {
    fs.renameSync(tmpPath, ENV_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

// ---------- 3.2 语境归一化 / 变量替换（原 context-engine） ----------

/** 任意值 -> 去重后的非空字符串数组：字符串 -> [字符串]，非数组 -> [] */
function toTagArray(value) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list)) return [];
  const result = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** 语境归一化：null / 坏 JSON / 非对象 / 类型不对，一律收敛为安全结构 */
function normalizeContext(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return {
    industry: typeof data.industry === 'string' ? data.industry.trim() : '',
    business_scene: toTagArray(data.business_scene),
    core_goal: toTagArray(data.core_goal),
  };
}

/** 语境 -> 替换字面量：industry 空 -> '通用'；数组 join('、')，空 -> '通用' */
function contextToReplacements(rawContext) {
  const context = normalizeContext(rawContext);
  const joinTags = (tags) => (tags.length > 0 ? tags.join('、') : '通用');
  return {
    industry: context.industry || '通用',
    business_scene: joinTags(context.business_scene),
    core_goal: joinTags(context.core_goal),
  };
}

/** 在完整长文本上全局替换 {{industry}} / {{business_scene}} / {{core_goal}}（回调替换防 $& 注入） */
function applyContextReplace(text, rawContext) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const values = contextToReplacements(rawContext);
  return source
    .replace(/\{\{\s*industry\s*\}\}/g, () => values.industry)
    .replace(/\{\{\s*business_scene\s*\}\}/g, () => values.business_scene)
    .replace(/\{\{\s*core_goal\s*\}\}/g, () => values.core_goal);
}

/** 容错解析 JSON（防大模型输出带 Markdown） */
function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = String(raw).match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    throw new Error('无法解析为 JSON: ' + String(raw).slice(0, 100));
  }
}

/** 大模型返回内容 -> 安全语境结构（正则提取 + safeParseJson + 结构校验兜底） */
function parseExtractResult(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  let parsed = null;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    try { parsed = safeParseJson(text); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('大模型返回内容无法解析为 JSON 对象');
  }
  return normalizeContext(parsed);
}

/** 安全读取项目语境（旧库无列 / 坏 JSON 时返回默认语境，不抛错） */
function readProjectContext(projectId) {
  try {
    const row = db.prepare('SELECT context_json FROM projects WHERE id = ?').get(projectId);
    return normalizeContext(row?.context_json);
  } catch (e) {
    console.warn('[server] 读取项目语境失败，使用默认语境:', e.message);
    return normalizeContext(null);
  }
}

// ---------- 3.3 快照组装（原 project-snapshot） ----------

/** 组装：按 LAYER_ORDER 排序 + `\n\n### name (layer)\n content` 拼接 */
function assemblePrompt(layers) {
  const list = Array.isArray(layers) ? layers : [];
  const sorted = [...list].sort((a, b) => LAYER_ORDER.indexOf(a?.layer) - LAYER_ORDER.indexOf(b?.layer));
  return sorted.map((l) => `\n\n### ${l?.name ?? ''} (${l?.layer ?? ''})\n${l?.content ?? ''}`).join('');
}

/** 安全解析 snapshots.module_versions_json（layers）：坏 JSON / 非数组 -> [] */
function safeParseLayers(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** body.context_data 必须是「对象且非空」才优先于数据库 */
function isUsableContextData(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

// ---------- 3.4 评测 / 多轮对话（原 eval-runner） ----------

/** L1 确定性断言 */
function checkL1(agentOutput) {
  const output = typeof agentOutput === 'string' ? agentOutput : String(agentOutput ?? '');
  const errors = [];
  const speakIndex = output.indexOf('<speak>');
  const toolIndex = output.indexOf('<tool>');
  if (speakIndex === -1 && toolIndex !== -1) errors.push('违规：检测到工具调用，但缺少播报话术 <speak>');
  else if (speakIndex !== -1 && toolIndex !== -1 && speakIndex > toolIndex) errors.push('违规时序：工具调用 <tool> 出现在了语音播报 <speak> 之前');
  if (/\*\*|^#+\s|^\s*-\s/m.test(output)) errors.push('违规格式：包含 Markdown 标记');
  if (/[一二三四五六七八九十百千万]+/g.test(output)) errors.push('违规播报：检测到中文数字单位，电话号码必须逐位播报');
  return { pass: errors.length === 0, errors };
}

/** L2 语义评测（真实调用 LLM） */
async function evaluateL2(userQuery, standardAnswer, botReply) {
  const systemPrompt = `你是一个极其严格的智能语音客服质量评测专家。你的任务是根据【知识库标准答案】和【机器人语音回复】，对机器人进行打分。
【评测原则】
1. 事实绝对优先：严格核对数字、时间、条件，必须与知识库完全一致。
2. 忽略标点差异，重点评估是否有书面语。
【输出格式要求】
必须且只能输出以下 JSON 格式，不要输出 Markdown 标记：
{"score": <1到5的整数>, "pass": <true或false>, "violations": ["错误点"], "comment": "简短评价"}`;
  const userPrompt = `【用户提问】：${userQuery}\n【知识库标准答案】：${standardAnswer}\n【机器人语音回复】：${botReply}`;
  const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return safeParseJson(rawReply);
}

/** layers 中是否存在有效内容层 */
function hasLayerContent(layers) {
  return Array.isArray(layers) && layers.some((l) => String(l?.content ?? '').trim().length > 0);
}

/** 组装多轮对话 System Prompt：空 layers 回落默认角色；末尾追加输出约束 */
function buildChatSystemPrompt(layers, contextData) {
  if (!hasLayerContent(layers)) return `${DEFAULT_CHAT_ROLE}${CHAT_OUTPUT_CONSTRAINTS}`;
  const assembled = applyContextReplace(assemblePrompt(layers), contextData);
  const base = assembled.trim().length > 0 ? assembled : DEFAULT_CHAT_ROLE;
  return `${base}${CHAT_OUTPUT_CONSTRAINTS}`;
}

/** 清洗多轮对话 messages：只留 user/assistant、字符串化、截断 4000、最近 12 条 */
function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const cleaned = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const rawContent = message.content;
    const content = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : String(rawContent);
    cleaned.push({ role: message.role, content: content.slice(0, CHAT_CONTENT_MAX) });
  }
  return cleaned.slice(-CHAT_HISTORY_LIMIT);
}

/** chat 语境：body.context_data 优先，否则安全读取 DB 项目语境 */
function readProjectContextSafe(projectId) {
  if (!projectId || typeof projectId !== 'string') return normalizeContext(null);
  return readProjectContext(projectId);
}

// ---------- 3.5 LLM 调用（阶段二：多模型路由中枢 + .env 自动回退） ----------

// 单次 LLM HTTP 请求超时（阶段二要求 60s）
const LLM_REQUEST_TIMEOUT_MS = 60000;

/** 去除错误信息中的敏感内容（API Key / Bearer Token），确保日志与响应不泄露 Key */
function redactSecrets(text, extraSecrets = []) {
  let output = String(text ?? '');
  const secrets = [process.env[KEY_NAME], ...extraSecrets]
    .filter((secret) => typeof secret === 'string' && secret.trim().length >= 8);
  for (const secret of secrets) {
    output = output.split(secret).join('***');
  }
  return output.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

/** 查询当前激活模型（单活：is_active=1 取 rowid 最新一条；异常不抛，回落 .env） */
function getActiveModelConfig() {
  try {
    return db.prepare('SELECT * FROM model_configs WHERE is_active = 1 ORDER BY rowid DESC LIMIT 1').get() || null;
  } catch (e) {
    console.warn('[LLM] 查询 model_configs 失败，回落 .env 配置:', e.message);
    return null;
  }
}

/** 阶段一 .env 回退配置（base_url/model 默认 deepseek；Key 来自 DEEPSEEK_API_KEY） */
function buildEnvLlmConfig(temperature) {
  return {
    base_url: DEFAULT_LLM_CONFIG.base_url,
    model_name: DEFAULT_LLM_CONFIG.model_name,
    api_key: process.env[KEY_NAME],
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : DEFAULT_LLM_CONFIG.temperature,
  };
}

/** 发起一次 Chat Completions 请求（含超时；错误由上层统一脱敏） */
async function requestChatCompletion(config, messages, timeoutMs = LLM_REQUEST_TIMEOUT_MS) {
  const baseUrl = String(config.base_url || DEFAULT_LLM_CONFIG.base_url).replace(/\/$/, '');
  const apiKey = config.api_key;
  if (!apiKey) throw new Error('未提供 API Key，且环境变量中未找到 DEEPSEEK_API_KEY');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model_name || DEFAULT_LLM_CONFIG.model_name,
      messages,
      temperature: Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : DEFAULT_LLM_CONFIG.temperature,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM 调用失败 (${response.status}): ${String(errorText).slice(0, 500)}`);
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
  if (typeof content !== 'string') throw new Error('LLM 返回内容为空或格式异常');
  return content;
}

/**
 * 统一 LLM 调用入口（阶段二核心）：
 * 1) 每次调用先查 model_configs 活跃模型（is_active=1，rowid 最新）；
 * 2) 有激活模型 -> 使用其 base_url / model_name / api_key（Key 空则回落 .env）/ temperature；
 * 3) 无激活模型 -> 回落 .env（DEEPSEEK_API_KEY + base_url 默认 deepseek / model deepseek-chat）；
 * 4) DB 模型请求失败 -> 记录 fallback 日志（已脱敏），自动用 .env 配置重试一次，防全盘崩溃。
 * 函数签名保持 chatCompletion(config, messages)，现有 context/extract、kb/parse、eval/run、
 * chat/reply 调用点无需改动（config 中的 temperature 仅用于 .env 回退分支）。
 */
async function chatCompletion(config, messages) {
  const callerConfig = { ...DEFAULT_LLM_CONFIG, ...(config || {}) };
  return llmLimit(async () => {
    const activeModel = getActiveModelConfig();
    if (activeModel) {
      const modelName = activeModel.model_name || DEFAULT_LLM_CONFIG.model_name;
      const activeBaseUrl = activeModel.base_url || DEFAULT_LLM_CONFIG.base_url;
      try {
        const security = validateModelBaseUrl(activeBaseUrl);
        if (!security.ok) throw new Error('激活模型 Base URL 不安全：' + security.error);
        const dbApiKey = resolveModelApiKey(activeBaseUrl, activeModel.api_key);
        if (!dbApiKey) throw new Error('激活模型未配置 API Key（自定义/第三方端点不允许回退 .env Key）');
        const dbConfig = {
          base_url: activeBaseUrl,
          model_name: modelName,
          api_key: dbApiKey,
          temperature: Number.isFinite(Number(activeModel.temperature)) ? Number(activeModel.temperature) : callerConfig.temperature,
        };
        console.log(`[LLM] 路由: DB 激活模型 (${activeModel.display_name || activeModel.id} / ${modelName})`);
        return await requestChatCompletion(dbConfig, messages);
      } catch (dbError) {
        const reason = redactSecrets(dbError && dbError.message ? dbError.message : dbError, [activeModel.api_key]);
        console.warn('[LLM] DB 激活模型调用失败，自动回落 .env 配置重试一次:', reason);
      }
    } else {
      console.log('[LLM] 路由: .env 默认配置（无激活模型）');
    }
    try {
      return await requestChatCompletion(buildEnvLlmConfig(callerConfig.temperature), messages);
    } catch (envError) {
      throw new Error(redactSecrets(envError && envError.message ? envError.message : envError));
    }
  });
}

/** 用给定配置做一次最小连通性测试（/api/models/test 专用；20s 超时；错误信息已脱敏）
 *  安全：Base URL 必须通过 SSRF 校验；.env 真实 Key 只允许发送给官方 DeepSeek 端点。 */
async function testModelConnection({ base_url, model_name, api_key }) {
  const startedAt = Date.now();
  const effectiveModelName = model_name || DEFAULT_LLM_CONFIG.model_name;
  const targetBaseUrl = base_url || DEFAULT_LLM_CONFIG.base_url;
  const security = validateModelBaseUrl(targetBaseUrl);
  if (!security.ok) return { success: false, message: security.error };
  const effectiveApiKey = resolveModelApiKey(targetBaseUrl, api_key);
  if (!effectiveApiKey) {
    return { success: false, message: '该 Base URL 必须显式填写 API Key（自定义/第三方端点禁止回退 .env Key，防 Key 外泄）' };
  }
  try {
    await requestChatCompletion(
      {
        base_url: targetBaseUrl,
        model_name: effectiveModelName,
        api_key: effectiveApiKey,
        temperature: 0,
      },
      [
        { role: 'system', content: '你是一个连接测试助手，只回复"OK"。' },
        { role: 'user', content: 'ping' },
      ],
      20000,
    );
    return { success: true, message: `连接成功（${effectiveModelName}，耗时 ${Date.now() - startedAt}ms）` };
  } catch (error) {
    return { success: false, message: redactSecrets(error && error.message ? error.message : error) };
  }
}

// ---------- 3.6 知识库 FAQ 解析（原 kb-manager） ----------

async function parseTxt(rawText) {
  const paragraphs = String(rawText).split(/\n\s*\n/).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + p).length > KB_CHUNK_SIZE && buf) { chunks.push(buf); buf = ''; }
    buf += p + '\n';
  }
  if (buf.trim()) chunks.push(buf);

  const results = [];
  const promises = chunks.map(async (chunk) => {
    const systemPrompt = `你是一个数据解析专家。请从以下文本中提取问答对（FAQ）。输出格式必须严格为 JSON 数组：[{"question":"...", "answer":"..."}]。不要编造任何事实。只输出 JSON。`;
    try {
      const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunk },
      ]);
      const pairs = safeParseJson(rawReply);
      return Array.isArray(pairs) ? pairs : [];
    } catch {
      return [];
    }
  });
  const resolvedResults = await Promise.all(promises);
  resolvedResults.forEach((pairs) => results.push(...pairs));
  return results;
}

// ============================================================
// 四、Express 应用
// ============================================================

const app = express();
app.disable('x-powered-by');

// CORS 白名单：仅允许本机来源（localhost/127.0.0.1/::1）与无 Origin 的本机工具调用。
// 目的：阻断任意恶意网页跨站调用本机 API（尤其借自定义 base_url 窃取 .env 真实 Key）。
const LOCAL_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function isLocalOrigin(origin) {
  if (!origin) return true; // curl / 同源请求通常无 Origin
  try {
    const u = new URL(origin);
    return LOCAL_ORIGIN_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}
app.use(cors({
  origin(origin, cb) {
    if (isLocalOrigin(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
// 二次防线：带非本机 Origin 的 /api 请求直接 403（浏览器跨站攻击在预检/实际请求层均被拒绝）
app.use('/api', (req, res, next) => {
  if (isLocalOrigin(req.headers.origin)) return next();
  return res.status(403).json({ success: false, error: '跨站请求被拒绝：仅允许本机同源访问' });
});
// JSON body 解析（10MB，覆盖长提示词/批量导入）
app.use(express.json({ limit: '10mb' }));
// 兜底 JSON 解析：兼容未带 application/json 头的 POST（旧插件是手写裸流解析）
app.use(async (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  if (req.body !== undefined && req.body !== null) return next();
  try {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const raw = Buffer.concat(buffers).toString('utf-8');
    req.body = raw.trim() ? JSON.parse(raw) : {};
    next();
  } catch {
    res.status(400).json({ success: false, error: '请求体不是合法 JSON' });
  }
});
// 访问日志（method / path / 状态码 / 耗时）
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    console.log(`[API] ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${elapsed}ms)`);
  });
  next();
});

/** 统一 JSON 响应 */
function sendJson(res, statusCode, data) {
  res.status(statusCode).json(data);
}

// 已注册路由清单（启动时打印数量，便于核对）
const registeredRoutes = [];

/**
 * 注册 API 路由：统一方法校验（非允许方法 -> 405 JSON）+ 异常兜底。
 * @param {string[]} methods 允许的方法，如 ['GET'] / ['POST'] / ['GET','POST']
 */
function route(methods, requestPath, handler) {
  const allowed = new Set(methods.map((m) => m.toUpperCase()));
  registeredRoutes.push(`${[...allowed].join('|')} ${requestPath}`);
  app.all(requestPath, async (req, res, next) => {
    if (!allowed.has(req.method)) {
      return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
    }
    try {
      await handler(req, res, next);
    } catch (e) {
      console.error(`[API 错误] ${req.method} ${requestPath}:`, e.message);
      if (res.headersSent) return res.destroy(e);
      sendJson(res, 500, { success: false, error: e.message });
    }
  });
}

// ------------------------------------------------------------
// 4.1 语境接口
// ------------------------------------------------------------

route(['GET'], '/api/context/get', async (req, res) => {
  const projectId = String(req.query.project_id || (req.body && req.body.project_id) || '');
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  sendJson(res, 200, { success: true, data: readProjectContext(projectId) });
});

route(['POST'], '/api/context/save', async (req, res) => {
  const body = req.body || {};
  const projectId = body.project_id || req.query.project_id || '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  const context = normalizeContext(body.context_data);
  const info = db.prepare('UPDATE projects SET context_json = ? WHERE id = ?').run(JSON.stringify(context), projectId);
  sendJson(res, 200, { success: true, updated: info.changes > 0, data: context });
});

route(['POST'], '/api/context/extract', async (req, res) => {
  const body = req.body || {};
  const projectId = body.project_id || req.query.project_id || '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });

  const rows = db.prepare('SELECT question, answer FROM kb_items WHERE project_id = ?').all(projectId);
  if (rows.length === 0) {
    return sendJson(res, 200, { success: false, message: '知识库为空，请先解析入库知识库' });
  }

  let kbText = rows.map((r, i) => `【${i + 1}】Q: ${r.question ?? ''}\nA: ${r.answer ?? ''}`).join('\n\n');
  let truncated = false;
  if (kbText.length > KB_TEXT_MAX) { kbText = kbText.slice(0, KB_TEXT_MAX); truncated = true; }

  const systemPrompt = `你是一个企业智能语音客服的语境分析专家。下面会给你某个项目的知识库问答内容，请从中归纳该项目的【行业主体】、【业务场景标签】和【核心目标标签】。
【输出格式要求】
必须且只能输出一个 JSON 对象，不要输出 Markdown 标记，不要输出任何解释文字：
{"industry":"一句话行业或主体名称","business_scene":["场景标签1","场景标签2"],"core_goal":["目标标签1","目标标签2"]}
【规则】
1. industry 是单个字符串，尽量使用知识库中出现的主体名称或明确的行业名称；无法判断时输出空字符串。
2. business_scene 与 core_goal 是字符串数组，每个标签简短（不超过 12 个字），各 3-6 个为宜。
3. 所有内容必须来自知识库，不要编造任何事实。`;

  const userPrompt = `以下是该项目 ${rows.length} 条知识库问答${truncated ? '（内容过长已截断）' : ''}：\n\n${kbText}`;
  const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  sendJson(res, 200, { success: true, data: parseExtractResult(rawReply), message: '语境提取成功' });
});

// ------------------------------------------------------------
// 4.2 知识库接口
// ------------------------------------------------------------

route(['POST'], '/api/kb/parse', async (req, res) => {
  const body = req.body || {};
  if (!body.raw_text) return sendJson(res, 400, { error: '文本不能为空' });
  const pairs = await parseTxt(body.raw_text);
  sendJson(res, 200, { success: true, data: pairs });
});

route(['POST'], '/api/kb/save', async (req, res) => {
  const { project_id, pairs } = req.body || {};
  const insertItem = db.prepare('INSERT INTO kb_items (id, project_id, question, answer) VALUES (?, ?, ?, ?)');
  const insertVer = db.prepare('INSERT INTO kb_item_versions (id, item_id, version_hash, content, is_deleted) VALUES (?, ?, ?, ?, 0)');
  db.transaction(() => {
    for (const pair of pairs) {
      const itemId = 'kb-' + crypto.randomUUID().split('-')[0];
      const versionId = 'v-' + crypto.randomUUID().split('-')[0];
      const contentStr = JSON.stringify(pair);
      const hash = crypto.createHash('md5').update(contentStr).digest('hex');
      insertItem.run(itemId, project_id, pair.question, pair.answer);
      insertVer.run(versionId, itemId, hash, contentStr);
    }
  })();
  sendJson(res, 200, { success: true, message: `已成功入库 ${pairs.length} 条` });
});

route(['GET'], '/api/kb/list', async (req, res) => {
  const rows = db.prepare('SELECT id, question, answer FROM kb_items WHERE project_id = ?').all(req.query.project_id || '');
  sendJson(res, 200, { success: true, data: rows });
});

route(['POST'], '/api/kb/delete', async (req, res) => {
  const body = req.body || {};
  if (!body.id) return sendJson(res, 400, { error: '缺少 ID' });
  db.prepare('DELETE FROM kb_items WHERE id = ?').run(body.id);
  db.prepare('UPDATE kb_item_versions SET is_deleted = 1 WHERE item_id = ?').run(body.id);
  sendJson(res, 200, { success: true, message: '删除成功' });
});

// 知识库在线编辑（阶段四）：更新 question / answer，并写入新版本记录
route(['POST'], '/api/kb/update', async (req, res) => {
  const body = req.body || {};
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!question || !answer) return sendJson(res, 400, { success: false, error: 'question 和 answer 必须是非空字符串' });

  const existing = db.prepare('SELECT id FROM kb_items WHERE id = ?').get(id);
  if (!existing) return sendJson(res, 404, { success: false, error: '知识条目不存在' });

  db.transaction(() => {
    db.prepare('UPDATE kb_items SET question = ?, answer = ? WHERE id = ?').run(question, answer, id);
    const contentStr = JSON.stringify({ question, answer });
    const versionHash = crypto.createHash('md5').update(contentStr).digest('hex');
    db.prepare('INSERT INTO kb_item_versions (id, item_id, version_hash, content, is_deleted) VALUES (?, ?, ?, ?, 0)')
      .run('v-' + crypto.randomUUID().split('-')[0], id, versionHash, contentStr);
  })();

  sendJson(res, 200, { success: true, message: '更新成功' });
});

// ------------------------------------------------------------
// 4.3 快照接口
// ------------------------------------------------------------

route(['POST'], '/api/snapshots/create', async (req, res) => {
  const { project_id, layers, context_data } = req.body || {};
  if (!project_id || typeof project_id !== 'string') return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  if (!Array.isArray(layers)) return sendJson(res, 400, { success: false, error: 'layers 必须是数组' });

  // 语境来源：body.context_data（对象且非空）优先；否则安全读取 DB projects.context_json；默认 {}
  const useBodyContext = isUsableContextData(context_data);
  const context = useBodyContext ? normalizeContext(context_data) : readProjectContext(project_id);

  // 关键：在「完整长文本」上做全局变量替换，占位符无论在 L0 还是 L3 都生效
  const prompt = applyContextReplace(assemblePrompt(layers), context);

  // 请求体带语境时同步持久化，供切换项目回填
  if (useBodyContext) {
    try {
      db.prepare('UPDATE projects SET context_json = ? WHERE id = ?').run(JSON.stringify(context), project_id);
    } catch (e) {
      console.warn('[server] 语境持久化失败（快照仍会生成）:', e.message);
    }
  }

  const snapshotId = 'snap-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  db.prepare('INSERT INTO snapshots (id, project_id, module_versions_json, final_prompt_content, created_at, eval_pass, eval_score) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(snapshotId, project_id, JSON.stringify(layers), prompt, now, 1, 5.0);

  sendJson(res, 200, {
    success: true,
    snapshot_id: snapshotId,
    final_prompt: prompt,
    context_applied: contextToReplacements(context),
    message: '快照成功存入',
  });
});

route(['GET'], '/api/snapshots/list', async (req, res) => {
  if (!req.query.project_id) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  const rows = db.prepare('SELECT id, created_at, eval_pass, eval_score FROM snapshots WHERE project_id = ? ORDER BY created_at DESC').all(req.query.project_id);
  sendJson(res, 200, { success: true, data: rows });
});

route(['GET'], '/api/snapshots/detail', async (req, res) => {
  const body = req.body || {};
  const id = req.query.id || body.id;
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  const row = db.prepare('SELECT id, project_id, final_prompt_content, created_at, module_versions_json, eval_pass, eval_score FROM snapshots WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { success: false, error: '快照不存在' });
  sendJson(res, 200, {
    success: true,
    data: {
      id: row.id,
      project_id: row.project_id,
      final_prompt_content: row.final_prompt_content,
      created_at: row.created_at,
      eval_pass: row.eval_pass,
      eval_score: row.eval_score,
      layers: safeParseLayers(row.module_versions_json),
    },
  });
});

route(['POST'], '/api/prompt/assemble', async (req, res) => {
  const { project_id, layers, context_data } = req.body || {};
  if (!Array.isArray(layers)) return sendJson(res, 400, { success: false, error: 'layers 必须是数组' });

  const useBodyContext = isUsableContextData(context_data);
  const context = useBodyContext
    ? normalizeContext(context_data)
    : (project_id && typeof project_id === 'string' ? readProjectContext(project_id) : normalizeContext(null));

  // 只做组装 + 全局变量替换，不写数据库、不生成快照
  sendJson(res, 200, {
    success: true,
    final_prompt: applyContextReplace(assemblePrompt(layers), context),
    context_applied: contextToReplacements(context),
  });
});

route(['GET'], '/api/projects/export_zip', async (req, res) => {
  const projectId = req.query.project_id;
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });

  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
  if (!project) return sendJson(res, 404, { success: false, error: '项目不存在' });

  const snapshots = db.prepare('SELECT id, created_at, eval_pass, eval_score, final_prompt_content FROM snapshots WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
  if (snapshots.length === 0) return sendJson(res, 404, { success: false, error: '该项目暂无历史快照可导出' });

  const manifest = {
    project_id: project.id,
    project_name: project.name,
    exported_at: new Date().toISOString(),
    count: snapshots.length,
    snapshots: snapshots.map((s) => ({
      id: s.id,
      created_at: s.created_at,
      eval_pass: s.eval_pass,
      eval_score: s.eval_score,
      file: `snapshots/${s.id}.txt`,
    })),
  };

  // 原生 res 流式输出 Zip：先写头，再 pipe archive（不能用 JSON 二次写头）
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="project-${project.id}-snapshots.zip"`,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[server] 导出 Zip 失败:', err.message);
    res.destroy(err);
  });
  archive.pipe(res);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const s of snapshots) {
    archive.append(String(s.final_prompt_content ?? ''), { name: `snapshots/${s.id}.txt` });
  }
  await archive.finalize();
});

// ------------------------------------------------------------
// 4.4 公司 / 项目接口
// ------------------------------------------------------------

route(['GET'], '/api/companies', async (req, res) => {
  sendJson(res, 200, { success: true, data: db.prepare('SELECT * FROM companies').all() });
});

route(['POST'], '/api/companies/create', async (req, res) => {
  const body = req.body || {};
  const id = 'comp-' + crypto.randomUUID().split('-')[0];
  db.prepare('INSERT INTO companies (id, name, category) VALUES (?, ?, ?)').run(id, body.name, '默认');
  sendJson(res, 200, { success: true, id, message: '创建成功' });
});

route(['POST'], '/api/companies/update', async (req, res) => {
  const body = req.body || {};
  db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(body.name, body.id);
  sendJson(res, 200, { success: true, message: '修改成功' });
});

route(['POST'], '/api/companies/delete', async (req, res) => {
  const body = req.body || {};
  db.prepare('DELETE FROM companies WHERE id = ?').run(body.id);
  db.prepare('DELETE FROM projects WHERE company_id = ?').run(body.id);
  sendJson(res, 200, { success: true, message: '删除成功' });
});

route(['GET'], '/api/projects', async (req, res) => {
  sendJson(res, 200, { success: true, data: db.prepare('SELECT * FROM projects').all() });
});

route(['POST'], '/api/projects/create', async (req, res) => {
  const body = req.body || {};
  const id = 'proj-' + crypto.randomUUID().split('-')[0];
  db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id) VALUES (?, ?, ?, ?)').run(id, body.company_id, body.name, '');
  sendJson(res, 200, { success: true, id, message: '创建成功' });
});

route(['POST'], '/api/projects/update', async (req, res) => {
  const body = req.body || {};
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(body.name, body.id);
  sendJson(res, 200, { success: true, message: '修改成功' });
});

route(['POST'], '/api/projects/delete', async (req, res) => {
  const body = req.body || {};
  db.prepare('DELETE FROM projects WHERE id = ?').run(body.id);
  sendJson(res, 200, { success: true, message: '删除成功' });
});

// ------------------------------------------------------------
// 4.5 发布门禁导出（CQO 生产级：PROJECT_NAME 实时读 DB + no-store + 去首部换行）
// ------------------------------------------------------------

route(['GET'], '/api/gate/export', async (req, res) => {
  const snapshotId = req.query.snapshot_id;

  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!snap) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Snapshot Not Found');
  }

  // 核心门禁：检查数据库中的评测结果
  if (snap.eval_pass !== 1) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`【发布门禁拦截】\n该快照未通过评测（得分：${snap.eval_score}），禁止导出！\n请在生成快照时提供符合标准的模拟对话。`);
  }

  // 项目名称必须在导出时实时从 DB 读取（重命名后旧快照同步生效），并清洗换行注入
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(snap.project_id);
  const projectName = String((project && project.name) || '(未命名项目)').replace(/[\r\n]+/g, ' ').trim() || '(未命名项目)';
  const promptBody = String(snap.final_prompt_content || '').replace(/^\n+/, '');
  const metaHeader = `# SNAPSHOT: ${snap.id}\n# PROJECT_ID: ${snap.project_id}\n# PROJECT_NAME: ${projectName}\n# EVAL_SCORE: ${snap.eval_score}\n# CREATED_AT: ${snap.created_at}\n\n`;

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${snap.id}.txt"`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(metaHeader + promptBody);
});

// ------------------------------------------------------------
// 4.6 评测 / 多轮对话
// ------------------------------------------------------------

route(['POST'], '/api/eval/run', async (req, res) => {
  const { bot_reply, standard_answer, user_query } = req.body || {};
  const l1 = checkL1(bot_reply);
  const l2 = await evaluateL2(user_query, standard_answer, bot_reply);
  sendJson(res, 200, { success: true, l1, l2 });
});

// 阶段四：AI 生成「刁钻」测试题（服务端正则提取 JSON 数组 + 结构校验兜底）
route(['POST'], '/api/eval/generate_questions', async (req, res) => {
  const body = req.body || {};
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  const requestedCount = Number(body.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 20 ? requestedCount : 5;

  // 读取该项目知识库（截断 12000 字符）；为空则回落到通用商城客服场景
  let kbText = '';
  if (projectId) {
    const rows = db.prepare('SELECT question, answer FROM kb_items WHERE project_id = ? LIMIT 300').all(projectId);
    kbText = rows.map((row, index) => `【${index + 1}】Q: ${row.question ?? ''}\nA: ${row.answer ?? ''}`).join('\n\n');
  }
  let scenarioHint = '';
  if (!kbText.trim()) {
    scenarioHint = '（该项目知识库为空，请围绕通用商城客服场景：退换货、物流查询、优惠活动、停车缴费、转人工等）';
    kbText = '无知识库内容，使用通用商城客服场景。';
  }
  if (kbText.length > KB_TEXT_MAX) kbText = kbText.slice(0, KB_TEXT_MAX);

  const systemPrompt = `你是一个智能语音客服系统的测试用例设计专家。请根据提供的知识库内容，生成 ${count} 条「刁钻」的测试用例，用于检验语音客服提示词的鲁棒性。
【刁钻方向】边界数字/时间条件、多轮上下文指代、口语化与方言表达、模糊或矛盾信息、诱导性提问、要求转人工等。
【输出格式要求】
必须且只能输出一个 JSON 数组，不要输出 Markdown 标记，不要输出任何解释文字：
[{"user_query":"用户问题","standard_answer":"依据知识库的标准答案","bot_reply":"可选的机器人回复，未知时留空字符串"}]
【规则】
1. user_query 必须口语化、像真实用户说的话，尽量简短。
2. standard_answer 必须严格依据知识库事实，不得编造。
3. 所有内容使用中文。`;

  const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `以下是知识库内容${scenarioHint}：\n\n${kbText}` },
  ]);

  // 硬性要求：先用正则 /\[[\s\S]*\]/ 提取 JSON 数组再 JSON.parse，失败再走 safeParseJson 兜底
  const rawText = String(rawReply ?? '');
  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  let parsed = null;
  if (arrayMatch) {
    try { parsed = JSON.parse(arrayMatch[0]); } catch { parsed = null; }
  }
  if (!Array.isArray(parsed)) {
    try {
      const fallback = safeParseJson(rawText);
      if (Array.isArray(fallback)) parsed = fallback;
    } catch { parsed = null; }
  }
  if (!Array.isArray(parsed)) {
    return sendJson(res, 500, { success: false, error: '大模型返回内容无法解析为测试用例数组' });
  }

  const data = parsed
    .slice(0, count)
    .map((item) => ({
      user_query: typeof item?.user_query === 'string' ? item.user_query.trim() : '',
      standard_answer: typeof item?.standard_answer === 'string' ? item.standard_answer.trim() : '',
      bot_reply: typeof item?.bot_reply === 'string' ? item.bot_reply.trim() : '',
    }))
    .filter((item) => item.user_query && item.standard_answer);

  if (data.length === 0) {
    return sendJson(res, 500, { success: false, error: '大模型返回的测试用例缺少必要字段（user_query / standard_answer）' });
  }
  sendJson(res, 200, { success: true, data });
});

route(['POST'], '/api/chat/reply', async (req, res) => {
  const body = req.body || {};
  const { project_id, layers, context_data } = body;

  // 1) messages 校验与清洗（只留 user/assistant、截断 4000、最近 12 条）
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, { success: false, error: 'messages 必须是非空数组' });
  }
  const messages = sanitizeChatMessages(body.messages);
  if (!messages.some((m) => m.role === 'user')) {
    return sendJson(res, 400, { success: false, error: 'messages 中至少需要一条 user 消息' });
  }

  // 2) 语境：body.context_data 优先，否则安全读取 DB；默认 {}
  const context = isUsableContextData(context_data) ? normalizeContext(context_data) : readProjectContextSafe(project_id);

  // 3) System Prompt：组装 + 全局变量替换 + 末尾输出约束
  const systemPrompt = buildChatSystemPrompt(layers, context);

  // 4) 调 DeepSeek 生成符合语音业务格式的回复
  const rawReply = await chatCompletion(CHAT_LLM_CONFIG, [{ role: 'system', content: systemPrompt }, ...messages]);
  const reply = typeof rawReply === 'string' ? rawReply.trim() : String(rawReply ?? '').trim();
  sendJson(res, 200, { success: true, reply, system_prompt: systemPrompt });
});

// ------------------------------------------------------------
// 4.7 API Key 设置（安全：masked、空值保持、非法 400、原子写 .env）
// ------------------------------------------------------------

route(['GET', 'POST'], '/api/settings/api-key', async (req, res) => {
  // GET：只返回脱敏信息
  if (req.method === 'GET') {
    const key = getCurrentApiKey();
    return sendJson(res, 200, { success: true, data: { has_key: Boolean(key), masked: maskApiKey(key), source: 'env' } });
  }

  // POST：校验 -> 原子写 .env -> 更新 process.env（立即生效）
  const body = req.body || {};
  const rawKey = body && typeof body === 'object' ? body.api_key : undefined;
  const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : '';

  if (!trimmedKey) {
    const current = getCurrentApiKey();
    return sendJson(res, 200, { success: true, updated: false, masked: maskApiKey(current), message: '未提供新 Key，保持原值' });
  }
  if (!validateApiKey(trimmedKey)) {
    return sendJson(res, 400, { success: false, error: 'API Key 格式不正确（长度需≥20 且不含空白）' });
  }
  atomicWriteEnv(upsertEnvLine(readEnvContent(), KEY_NAME, trimmedKey));
  process.env[KEY_NAME] = trimmedKey;
  sendJson(res, 200, { success: true, updated: true, masked: maskApiKey(trimmedKey), message: 'API Key 已保存并立即生效' });
});

// ------------------------------------------------------------
// 4.8 多模型路由中枢（阶段二）
// ------------------------------------------------------------

/** DB 行 -> 对外模型对象（绝不返回完整 api_key） */
function toPublicModel(row) {
  const hasKey = typeof row.api_key === 'string' && row.api_key.trim().length > 0;
  return {
    id: row.id,
    provider: row.provider,
    display_name: row.display_name,
    base_url: row.base_url,
    model_name: row.model_name,
    is_active: row.is_active, // 保持 DB 原始 1/0，前端用 Number(is_active) === 1 判断
    temperature: row.temperature,
    has_key: hasKey,
    masked_key: hasKey ? maskApiKey(row.api_key) : '',
  };
}

route(['GET'], '/api/models', async (req, res) => {
  const rows = db.prepare('SELECT * FROM model_configs ORDER BY rowid ASC').all();
  sendJson(res, 200, { success: true, data: rows.map(toPublicModel) });
});

route(['POST'], '/api/models/save', async (req, res) => {
  const body = req.body || {};
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim().replace(/\/+$/, '') : '';
  const modelName = typeof body.model_name === 'string' ? body.model_name.trim() : '';
  if (!provider || !baseUrl || !modelName) {
    return sendJson(res, 400, { success: false, error: 'provider / base_url / model_name 为必填项' });
  }
  const urlSecurity = validateModelBaseUrl(baseUrl);
  if (!urlSecurity.ok) {
    return sendJson(res, 400, { success: false, error: 'base_url 不安全：' + urlSecurity.error });
  }

  const displayName = typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : provider;
  const temperatureNumber = Number(body.temperature);
  const temperature = Number.isFinite(temperatureNumber) ? temperatureNumber : DEFAULT_LLM_CONFIG.temperature;
  const incomingId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
  const apiKeyInput = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const isActiveSpecified = body.is_active !== undefined;
  const wantActive = body.is_active === true || body.is_active === 1 || body.is_active === '1' || body.is_active === 'true';

  const existing = incomingId ? db.prepare('SELECT * FROM model_configs WHERE id = ?').get(incomingId) : null;
  const id = incomingId || 'model-' + crypto.randomUUID().split('-')[0];
  // api_key 为空时保留原值；但**非官方 DeepSeek 端点禁止空 Key**（否则运行时不会回落 .env，配置也不可用）
  const apiKey = apiKeyInput || (existing && typeof existing.api_key === 'string' ? existing.api_key : '');
  if (!apiKey && !urlSecurity.isEnvKeyAllowed) {
    return sendJson(res, 400, { success: false, error: '自定义/第三方 Base URL 必须填写 API Key（不允许使用 .env 回退，防 Key 外泄）' });
  }

  // 单活模型：激活当前模型前先把其它模型置 0
  if (wantActive) db.prepare('UPDATE model_configs SET is_active = 0').run();

  if (existing) {
    const isActive = isActiveSpecified ? (wantActive ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE model_configs SET provider = ?, display_name = ?, base_url = ?, api_key = ?, model_name = ?, temperature = ?, is_active = ? WHERE id = ?')
      .run(provider, displayName, baseUrl, apiKey, modelName, temperature, isActive, id);
    return sendJson(res, 200, { success: true, message: '模型配置已更新', id, is_active: isActive });
  }

  const maxContextLength = Number.isFinite(Number(body.max_context_length)) ? Number(body.max_context_length) : 32000;
  db.prepare('INSERT INTO model_configs (id, provider, display_name, base_url, api_key, model_name, temperature, max_context_length, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, provider, displayName, baseUrl, apiKey, modelName, temperature, maxContextLength, wantActive ? 1 : 0);
  sendJson(res, 200, { success: true, message: '模型配置已保存', id, is_active: wantActive ? 1 : 0 });
});

route(['POST'], '/api/models/test', async (req, res) => {
  const body = req.body || {};
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  const modelName = typeof body.model_name === 'string' ? body.model_name.trim() : '';
  if (!baseUrl || !modelName) {
    return sendJson(res, 400, { success: false, message: 'base_url / model_name 为必填项' });
  }
  const result = await testModelConnection({ base_url: baseUrl, model_name: modelName, api_key: body.api_key });
  if (result.success) console.log(`[models] 连接测试成功: provider=${provider || '-'} model=${modelName}`);
  else console.warn(`[models] 连接测试失败: provider=${provider || '-'} model=${modelName} reason=${result.message}`);
  sendJson(res, 200, result);
});

// ============================================================
// 五、静态资源、404 与错误处理
// ============================================================

// 静态资源（public/）
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// /api/* 未命中 -> JSON 404
app.use('/api', (req, res) => {
  sendJson(res, 404, { success: false, error: '接口不存在', path: req.originalUrl.split('?')[0] });
});

// 非 /api 的 GET 回退到 SPA 首页 public/index.html
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(INDEX_HTML, (err) => {
      if (err) next(err);
    });
  }
  next();
});

// 兜底 404
app.use((req, res) => {
  sendJson(res, 404, { success: false, error: 'Not Found', path: req.originalUrl.split('?')[0] });
});

// 统一错误处理（含 express.json 解析错误）
app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
    return sendJson(res, 400, { success: false, error: '请求体不是合法 JSON' });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return sendJson(res, 413, { success: false, error: '请求体过大（上限 10MB）' });
  }
  console.error('[server] 未捕获异常:', err && err.message ? err.message : err);
  sendJson(res, err && Number.isInteger(err.status) ? err.status : 500, { success: false, error: (err && err.message) || 'Internal Server Error' });
});

// ============================================================
// 六、端口占用自动处理 + 启动 + 优雅退出
// ============================================================

/** 查找监听指定端口的进程 PID（Windows: netstat -ano；POSIX: lsof） */
function findListeningPids(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const output = execSync('netstat -ano -p TCP', { encoding: 'utf-8', windowsHide: true, timeout: 8000 });
      for (const line of output.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5) continue;
        const [proto, localAddress, , state, pidText] = columns;
        if (proto !== 'TCP' || state !== 'LISTENING') continue;
        if (!localAddress || !localAddress.endsWith(`:${port}`)) continue;
        const pid = Number(pidText);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
    } else {
      const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf-8', timeout: 8000 });
      for (const line of output.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
    }
  } catch (e) {
    console.warn('[server] 查询端口占用进程失败:', e.message);
  }
  return [...pids];
}

/** 强制结束进程（Windows: taskkill /F /T；POSIX: kill -9） */
function forceKillPid(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 8000 });
    }
    return true;
  } catch (e) {
    console.warn(`[server] 终止进程 PID=${pid} 失败:`, e.message);
    return false;
  }
}

/** 打印手动释放端口命令并退出 */
function exitWithManualHint(reason) {
  console.error('');
  console.error('========================================');
  console.error(' ❌ 端口启动失败 / Failed to bind port ' + PORT);
  console.error(' 原因:', reason);
  console.error(' 请手动释放端口后重试 / Please free the port and retry:');
  console.error(`   Windows:  netstat -ano | findstr :${PORT}   然后  taskkill /PID <占用PID> /F /T`);
  console.error(`   PowerShell:  Get-NetTCPConnection -LocalPort ${PORT} | Select-Object OwningProcess`);
  console.error('========================================');
  process.exit(1);
}

/** 启动服务：EADDRINUSE 时自动清理占用进程并重试一次 */
function startServer() {
  return new Promise((resolve) => {
    const tryListen = (isRetry) => {
      const server = app.listen(PORT, HOST);
      server.once('listening', () => resolve(server));
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && !isRetry) {
          console.warn('');
          console.warn(`⚠️  端口 ${PORT} 已被占用 / Port ${PORT} is already in use. 正在尝试自动释放...`);
          const pids = findListeningPids(PORT);
          if (pids.length === 0) {
            return exitWithManualHint('EADDRINUSE 但未能定位占用进程');
          }
          for (const pid of pids) {
            console.warn(`   发现占用进程 PID=${pid}，尝试终止...`);
            forceKillPid(pid);
          }
          // 给系统一点时间回收端口，然后重试一次
          setTimeout(() => tryListen(true), 1200);
          return;
        }
        exitWithManualHint(`${error.code || ''} ${error.message || ''}`.trim());
      });
    };
    tryListen(false);
  });
}

// ---- 主启动流程 ----
let httpServer = null;

(async () => {
  console.log('========================================');
  console.log(' Prompt Studio V3.0 独立服务（纯 Node.js + Express）');
  console.log('========================================');
  console.log(`[server] 数据库: ${DB_PATH}`);
  console.log(`[server] 静态目录: ${PUBLIC_DIR}`);
  console.log(`[server] 已注册 API 路由: ${registeredRoutes.length} 条`);
  registeredRoutes.forEach((item) => console.log(`         - ${item}`));
  console.log(`[server] LLM Key 是否已配置: ${process.env[KEY_NAME] ? '是 (已加载)' : '否 (请在设置中填写)'}`);
  try {
    const activeModel = getActiveModelConfig();
    console.log(`[server] 活跃模型: ${activeModel ? `${activeModel.display_name || activeModel.id} (${activeModel.model_name} @ ${activeModel.base_url})` : '无（chatCompletion 将回落 .env 配置）'}`);
  } catch (e) {
    console.log('[server] 活跃模型查询失败:', e.message);
  }
  console.log('');

  httpServer = await startServer();
  console.log(`[server] ✅ 服务已启动: http://${HOST}:${PORT}`);
  console.log(`[server] 🌐 浏览器访问: http://${HOST}:${PORT}`);
  console.log('[server] 按 Ctrl+C 停止服务');
})();

// ---- 优雅退出：关闭 HTTP server 与数据库 ----
function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，正在关闭服务...`);
  const finish = () => {
    try { db.close(); console.log('[server] 数据库连接已关闭'); } catch { /* ignore */ }
    process.exit(0);
  };
  if (!httpServer) return finish();
  httpServer.close(() => finish());
  setTimeout(() => {
    console.warn('[server] 关闭超时，强制退出');
    finish();
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 异常:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  console.error('[server] 未捕获异常:', error && error.message ? error.message : error);
});
