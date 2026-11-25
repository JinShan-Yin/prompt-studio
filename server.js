#!/usr/bin/env node
/**
 * NewRock AI Workbench v1.62 · 纯 Node.js + Express 独立服务
 * ============================================================
 * 运行方式：node server.js        默认监听 http://127.0.0.1:3100
 *          LAN_ACCESS=true 时监听 0.0.0.0，供局域网内其他设备访问（端口可由 .env 的 PORT 覆盖）
 *
 * 说明：
 * - 本文件**不 import / require 任何 plugins/ 目录下的文件**，原 Cordis 插件里的
 *   全部 API 逻辑（DB 初始化、语境引擎、快照组装/导出、知识库、评测/多轮对话、
 *   发布门禁、API Key 设置）已平移/内联到本文件，作为独立应用运行。
 * - 不再需要 token 校验；静态资源直接托管 public/。
 * - v1.60：提示词扁平化（L0/L1/L3 → 单一 system_prompt）、多格式文档解析与导出、
 *   AI 生成用例升级、历史快照多格式批量导出、品牌全面切换为 NewRock AI Workbench。
 *
 * 依赖：express@5 / cors / better-sqlite3 / dotenv / p-limit / archiver@8（纯 ESM）
 *       mammoth / xlsx / pdf-parse（知识库多格式解析）
 */

import 'dotenv/config'; // 自动读取项目根 .env 到 process.env
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execSync } from 'child_process';
import pLimit from 'p-limit';
import { ZipArchive } from 'archiver'; // archiver@8 纯 ESM：无 default export
import mammoth from 'mammoth'; // v1.60：.doc/.docx 解析
import XLSX from 'xlsx'; // v1.60：.xls/.xlsx 解析
import { PDFParse } from 'pdf-parse'; // v1.60：.pdf 解析
import { parseMarkdownChunks } from './lib/markdownChunker.js'; // v1.61：本地 Markdown 切片（不调大模型）

// ============================================================
// 一、常量与运行环境
// ============================================================

const APP_VERSION = '1.63.0';
const PORT = Number(process.env.PORT) || 3100;
/** V1.63：知识库单文件上传上限（MB），前端通过 /api/auth/config 读取 */
const KB_MAX_FILE_MB = Math.max(1, Math.min(200, Number(process.env.KB_MAX_FILE_MB) || 20));
/** V1.62：局域网开关。默认关闭，保持与 V1.61 完全一致的本机监听口径 */
const LAN_ACCESS = /^(1|true|yes|on)$/i.test(String(process.env.LAN_ACCESS || '').trim());
const HOST = String(process.env.BIND_HOST || '').trim() || (LAN_ACCESS ? '0.0.0.0' : '127.0.0.1');
/** V1.62：局域网模式下默认关闭自助注册；本机模式保留注册，可用 ALLOW_SELF_REGISTER=true 强制开启 */
const SELF_REGISTER_ENABLED = !LAN_ACCESS || /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_SELF_REGISTER || '').trim());
const ROOT_DIR = process.cwd();
/** V1.62：测试隔离钩子——仅供自动化冒烟指向临时数据目录，默认行为不变 */
const DATA_DIR = process.env.NEWROCK_DATA_DIR ? path.resolve(process.env.NEWROCK_DATA_DIR) : path.join(ROOT_DIR, 'data');
/**
 * 解析业务数据库路径（v1.60 品牌化）：
 * - 新数据库文件名为 newrock.db；
 * - 若新库不存在但检测到旧版 prompt-studio.db（含 WAL/SHM），先整体改名平滑迁移，
 *   保证旧数据零丢失、代码中不再残留旧文件名。
 */
function resolveDbPath() {
  const newPath = path.join(DATA_DIR, 'newrock.db');
  const oldPath = path.join(DATA_DIR, 'prompt-studio.db');
  try {
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
      for (const suffix of ['-wal', '-shm']) {
        const oldSide = oldPath + suffix;
        if (fs.existsSync(oldSide)) fs.renameSync(oldSide, newPath + suffix);
      }
      console.log('[v1.60] 已将旧数据库文件平滑改名为 newrock.db');
    }
  } catch (e) {
    console.error('[v1.60] 数据库文件名迁移失败，回退使用旧路径:', e.message);
    return oldPath;
  }
  return newPath;
}
const DB_PATH = resolveDbPath();
const ENV_PATH = path.join(ROOT_DIR, '.env');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

const KEY_NAME = 'DEEPSEEK_API_KEY';
const API_KEY_MIN_LENGTH = 20;

// ============================================================
// V5.0 多租户 / 认证 / 加密常量与基础工具
// ============================================================
const VAULT_KEY_PATH = path.join(DATA_DIR, '.vault-key');
const ADMIN_DEFAULT_PASSWORD = 'newrock123';
const TRIAL_LIMIT = 3;
const requestContext = new AsyncLocalStorage();
/** V1.63：把当前请求关联的项目写入请求上下文（供 LLM 用量统计使用） */
function setRequestProjectId(projectId) {
  const store = requestContext.getStore();
  if (store && projectId) store.projectId = String(projectId);
}

let vaultKeyCache = null;
function getVaultKey() {
  if (vaultKeyCache) return vaultKeyCache;
  try {
    if (fs.existsSync(VAULT_KEY_PATH)) {
      const hex = fs.readFileSync(VAULT_KEY_PATH, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) vaultKeyCache = Buffer.from(hex, 'hex');
    }
    if (!vaultKeyCache) throw new Error('missing');
  } catch {
    vaultKeyCache = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAULT_KEY_PATH, vaultKeyCache.toString('hex'), { mode: 0o600 });
  }
  return vaultKeyCache;
}
/** AES-256-GCM 加密；存储前缀 enc:v1:iv:tag:data */
function encryptSecret(plain) {
  const key = getVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}
/** 解密；兼容历史明文（无 enc:v1: 前缀直接返回原文） */
function decryptSecret(stored) {
  const s = String(stored ?? '');
  if (!s.startsWith('enc:v1:')) return s;
  try {
    const parts = s.split(':');
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const data = Buffer.from(parts[4], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[vault] 解密失败（Key 可能已损坏或被替换）:', e.message);
    return '';
  }
}
/** 解密后仅保留前 3 + 后 4（绝不向前端返回完整 Key） */
function maskKeyForDisplay(storedKey) {
  const key = String(decryptSecret(storedKey) ?? '').trim();
  if (!key) return '****';
  return key.length > 8 ? `${key.slice(0, 3)}****${key.slice(-4)}` : '****';
}
function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  if (code) e.code = code;
  return e;
}
/** 黑匣子审计日志（登录/删除/修改/代管/备份等关键操作；分级 Info/Warn/Danger + IP） */
function inferAuditLevel(userId, action, targetType, targetId, explicitLevel) {
  if (explicitLevel && ['Info', 'Warn', 'Danger'].includes(explicitLevel)) return explicitLevel;
  const act = String(action || '');
  // 高危删除类优先 Danger
  if (/delete|remove|reset_password|backup_import|danger/i.test(act)) return 'Danger';
  try {
    const actor = userId ? db.prepare('SELECT role FROM users WHERE id = ?').get(userId) : null;
    const isManager = !!(actor && ['superadmin', 'teamadmin'].includes(actor.role));
    if (!isManager) return 'Info';
    let ownerId = '';
    if (targetType === 'project') {
      const p = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(String(targetId));
      ownerId = p ? p.user_id : '';
    } else if (targetType === 'kb') {
      const k = db.prepare('SELECT project_id FROM kb_items WHERE id = ?').get(String(targetId));
      if (k) { const p = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(k.project_id); ownerId = p ? p.user_id : ''; }
    } else if (targetType === 'snapshot') {
      const s = db.prepare('SELECT user_id, project_id FROM snapshots WHERE id = ?').get(String(targetId));
      if (s) {
        ownerId = s.user_id || '';
        if (!ownerId && s.project_id) { const p = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(s.project_id); ownerId = p ? p.user_id : ''; }
      }
    }
    // 超管/团管修改他人数据 = 代管修改 → Warn
    if (ownerId && ownerId !== userId) return 'Warn';
  } catch (e) { /* 推断失败按 Info */ }
  return 'Info';
}
function logAction(userId, action, targetType = '', targetId = '', detail = '', explicitLevel = '') {
  try {
    const store = requestContext.getStore() || {};
    const level = inferAuditLevel(userId, action, targetType, targetId, explicitLevel);
    const ip = String(store.ip || '').slice(0, 120);
    db.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, detail, level, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('log-' + crypto.randomUUID().split('-')[0], userId || '', String(action || ''), String(targetType || ''), String(targetId || ''), String(detail || '').slice(0, 2000), level, ip, new Date().toISOString());
  } catch (e) {
    console.error('[audit] 写日志失败:', e.message);
  }
}


// ============================================================
// V1.62：功能级权限 / 账号治理 / 备份运维 基础工具
// ============================================================

/** 会话密钥：优先 SESSION_SECRET，其次复用 data/.session-secret，最后生成并持久化 */
function resolveSessionSecret() {
  const envSecret = String(process.env.SESSION_SECRET || '').trim();
  if (envSecret.length >= 16) return envSecret;
  const secretPath = path.join(DATA_DIR, '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch (e) {
    console.warn('[session] 读取 .session-secret 失败:', e.message);
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  } catch (e) {
    console.warn('[session] 写入 .session-secret 失败，使用临时密钥:', e.message);
  }
  return generated;
}

/** 功能组定义（与前端 4 个 Tab 一一对应） */
const FEATURE_DEFS = [
  { key: 'edit', label: '提示词编辑' },
  { key: 'kb', label: '知识库管理' },
  { key: 'eval', label: '智能体评测' },
  { key: 'snapshot', label: '提交记录' },
];
const FEATURE_KEYS = FEATURE_DEFS.map((item) => item.key);
/** 默认矩阵：全开，升级后行为与 V1.61 完全一致 */
const DEFAULT_FEATURE_MATRIX = {
  user: { edit: true, kb: true, eval: true, snapshot: true },
  teamadmin: { edit: true, kb: true, eval: true, snapshot: true },
};
/** 功能门禁只覆盖对应接口；项目树/模型/备份/系统管理属于始终可用的基线功能 */
const FEATURE_ROUTE_RULES = [
  ['edit', /^\/api\/(context\/|prompt\/assemble|templates\/|ai\/polish)/],
  ['kb', /^\/api\/kb\//],
  ['eval', /^\/api\/(eval\/|chat\/)/],
  ['snapshot', /^\/api\/(snapshots\/|gate\/export)/],
];

/** 解析个人功能覆盖 JSON（只认 4 个 key 的布尔值，坏数据静默忽略） */
function parseFeatureOverrides(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of FEATURE_KEYS) {
      if (typeof parsed[key] === 'boolean') out[key] = parsed[key];
    }
    return out;
  } catch (e) {
    return {};
  }
}

let featureMatrixCache = null;
/** 角色默认矩阵（读 app_settings，缺失/损坏回落全开） */
function getFeatureMatrix() {
  if (featureMatrixCache) return featureMatrixCache;
  const matrix = JSON.parse(JSON.stringify(DEFAULT_FEATURE_MATRIX));
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'feature_matrix'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      for (const role of ['user', 'teamadmin']) {
        for (const key of FEATURE_KEYS) {
          if (parsed && parsed[role] && typeof parsed[role][key] === 'boolean') matrix[role][key] = parsed[role][key];
        }
      }
    }
  } catch (e) {
    console.warn('[features] 读取功能矩阵失败，使用默认值:', e.message);
  }
  featureMatrixCache = matrix;
  return featureMatrixCache;
}
function invalidateFeatureMatrixCache() {
  featureMatrixCache = null;
}

/** 解析某用户最终生效的功能集合：超管全开 → 角色默认 → 个人覆盖 */
function resolveUserFeatures(user) {
  const all = {};
  for (const key of FEATURE_KEYS) all[key] = true;
  if (!user) return all;
  if (user.role === 'superadmin') return all;
  const matrix = getFeatureMatrix();
  const base = matrix[user.role] || matrix.user || {};
  const overrides = parseFeatureOverrides(user.feature_overrides);
  const features = {};
  for (const key of FEATURE_KEYS) {
    features[key] = typeof overrides[key] === 'boolean' ? overrides[key] : !!base[key];
  }
  return features;
}

/** 账号是否可用（V1.62 账号治理） */
function isUserActive(user) {
  return !!user && String(user.status || 'active') === 'active';
}

/** 功能门禁中间件：挂在 authGate 之后，超管直通，关闭则 403 */
function featureGate(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const rule = FEATURE_ROUTE_RULES.find(([, pattern]) => pattern.test(req.path));
  if (!rule) return next();
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  if (user.role === 'superadmin') return next();
  const features = resolveUserFeatures(user);
  if (features[rule[0]]) return next();
  return sendJson(res, 403, {
    success: false,
    code: 'FEATURE_DISABLED',
    feature: rule[0],
    error: '该功能已被管理员关闭，如需开通请联系管理员',
  });
}

// ---------- 备份目录与启动前快照 ----------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_STARTUP_DIR = path.join(BACKUP_DIR, 'startup');
const BACKUP_AUTO_DIR = path.join(BACKUP_DIR, 'auto');

function initBackupDirs() {
  for (const dir of [BACKUP_DIR, BACKUP_STARTUP_DIR, BACKUP_AUTO_DIR]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.warn('[backup] 创建备份目录失败:', dir, e.message);
    }
  }
}

/** 文件名时间戳：20261124_222036 */
function fileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 只保留最近 keep 个 .db 备份 */
function pruneBackupDir(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const full = path.join(dir, name);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of files.slice(keep)) {
      try { fs.unlinkSync(item.full); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[backup] 清理旧备份失败:', dir, e.message);
  }
}

/** 在线备份（better-sqlite3 db.backup，不阻塞读；用于每日自动备份/手动备份） */
async function createDatabaseBackup(kind = 'auto') {
  initBackupDirs();
  const dir = kind === 'startup' ? BACKUP_STARTUP_DIR : BACKUP_AUTO_DIR;
  const dest = path.join(dir, `${kind === 'startup' ? 'startup' : 'auto'}-${fileStamp()}.db`);
  await db.backup(dest);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  pruneBackupDir(dir, kind === 'startup' ? 5 : 14);
  return dest;
}

/** 列出备份文件（startup / auto），按时间倒序，最多 limit 条 */
function listBackupFiles(limit = 50) {
  const rows = [];
  for (const [kind, dir] of [['startup', BACKUP_STARTUP_DIR], ['auto', BACKUP_AUTO_DIR]]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.db')) continue;
        const full = path.join(dir, name);
        try {
          const stat = fs.statSync(full);
          rows.push({ kind, name, size: stat.size, mtime: stat.mtime.toISOString() });
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }
  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return rows.slice(0, limit);
}

/** 启动前文件级快照：在打开数据库、执行任何迁移之前执行 */
function snapshotBeforeStartup() {
  try {
    if (!fs.existsSync(DB_PATH)) return '';
    initBackupDirs();
    const dest = path.join(BACKUP_STARTUP_DIR, `startup-${fileStamp()}.db`);
    fs.copyFileSync(DB_PATH, dest);
    for (const suffix of ['-wal', '-shm']) {
      const side = DB_PATH + suffix;
      if (fs.existsSync(side)) {
        try { fs.copyFileSync(side, dest + suffix); } catch (e) { /* 忽略单文件失败 */ }
      }
    }
    pruneBackupDir(BACKUP_STARTUP_DIR, 5);
    console.log('[backup] 启动前数据库快照:', dest);
    return dest;
  } catch (e) {
    console.warn('[backup] 启动前快照失败（继续启动）:', e.message);
    return '';
  }
}

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
  // V1.62：先 checkpoint 把 WAL 合回主库，再在「执行任何迁移之前」做文件级快照，
  // 保证备份是一个完整可单独恢复的 .db（sidecar 仍一并复制，防 checkpoint 异常）
  try { database.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.warn('[backup] 启动 checkpoint 失败:', e.message); }
  snapshotBeforeStartup();

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
    CREATE TABLE IF NOT EXISTS prompt_templates ( id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT DEFAULT '', created_at TEXT DEFAULT '', is_public INTEGER DEFAULT 0, public_scope TEXT DEFAULT 'private', user_id TEXT );
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

  // v1.60 重构：snapshots 缺 remark（版本备注）时安全补列。先 PRAGMA 确认无该列再 ALTER，整段 try/catch 防重复执行崩溃
  try {
    const snapshotColsForRemark = database.prepare('PRAGMA table_info(snapshots)').all();
    if (!snapshotColsForRemark.some((c) => c.name === 'remark')) {
      database.exec("ALTER TABLE snapshots ADD COLUMN remark TEXT DEFAULT '';");
    }
  } catch (e) {
    console.error('[db] 数据库升级检查失败（snapshots.remark）:', e.message);
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

  // ============================================================
  // V5.0 阶段一：多租户底层平滑升级（幂等；绝不删除/重建旧业务表）
  // ============================================================
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS teams ( id TEXT PRIMARY KEY, name TEXT, created_at TEXT );
      CREATE TABLE IF NOT EXISTS users ( id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, team_id TEXT, need_change_password INTEGER, trial_count INTEGER DEFAULT 0, created_at TEXT );
      CREATE TABLE IF NOT EXISTS audit_logs ( id TEXT PRIMARY KEY, user_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT );
      CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY, value TEXT );
      CREATE TABLE IF NOT EXISTS project_grants ( id TEXT PRIMARY KEY, project_id TEXT NOT NULL, grantee_user_id TEXT NOT NULL, granted_by TEXT, created_at TEXT, UNIQUE(project_id, grantee_user_id) );
      CREATE TABLE IF NOT EXISTS project_pins ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT, UNIQUE(user_id, project_id) );
    `);
    const userCount = database.prepare('SELECT COUNT(*) c FROM users').get().c;
    if (userCount === 0) {
      database.prepare('INSERT INTO users (id, username, password_hash, role, team_id, need_change_password, trial_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('user-admin', 'admin', bcrypt.hashSync(ADMIN_DEFAULT_PASSWORD, 10), 'superadmin', '', 1, 0, new Date().toISOString());
      console.log('[v5] 已创建默认超管 admin / newrock123（首次登录需修改密码）');
    }

    const addColumnIfMissing = (table, column, definition) => {
      try {
        const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (columns.length === 0) return; // 表不存在则跳过
        if (!columns.includes(column)) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
          console.log(`[v5] ${table} 补充列: ${column}`);
        }
      } catch (e) {
        console.error(`[v5] 加列失败(已跳过，不影响启动): ${table}.${column}`, e.message);
      }
    };
    // 可见性字段
    addColumnIfMissing('projects', 'is_public', 'INTEGER DEFAULT 0');
    addColumnIfMissing('projects', 'public_scope', "TEXT DEFAULT 'private'");
    addColumnIfMissing('prompt_templates', 'is_public', 'INTEGER DEFAULT 0');
    addColumnIfMissing('prompt_templates', 'public_scope', "TEXT DEFAULT 'private'");
    // 所有业务表加 user_id（旧数据统一归属 admin）
    const V5_BUSINESS_TABLES = ['companies', 'projects', 'kb_items', 'kb_item_versions', 'snapshots', 'eval_runs', 'model_configs', 'modules', 'module_versions', 'prompt_templates'];
    for (const table of V5_BUSINESS_TABLES) addColumnIfMissing(table, 'user_id', 'TEXT');
    // V5.0 终极 QA 修复：审计日志分级 + IP（幂等）
    addColumnIfMissing('audit_logs', 'level', "TEXT DEFAULT 'Info'");
    addColumnIfMissing('audit_logs', 'ip', "TEXT DEFAULT ''");
    // V1.62：账号治理 + 个人功能权限
    addColumnIfMissing('users', 'feature_overrides', "TEXT DEFAULT ''");
    addColumnIfMissing('users', 'status', "TEXT DEFAULT 'active'");
    addColumnIfMissing('users', 'session_version', 'INTEGER DEFAULT 1');
    addColumnIfMissing('users', 'last_login_at', "TEXT DEFAULT ''");
    // 知识库结构标记：raw=保留原结构（智能分块，标题即 question）；qa=大模型提取的问答对（默认，旧数据兼容）
    addColumnIfMissing('kb_items', 'structure_mode', "TEXT DEFAULT 'qa'");
    try {
      database.prepare("UPDATE audit_logs SET level = 'Info' WHERE level IS NULL OR level = ''").run();
    } catch (e) {
      console.error('[v5] 审计日志 level 回填失败（已跳过）:', e.message);
    }

    // V1.62：初始化角色默认功能矩阵（不存在时写入全开默认值）
    try {
      const matrixRow = database.prepare("SELECT value FROM app_settings WHERE key = 'feature_matrix'").get();
      if (!matrixRow) {
        database.prepare("INSERT INTO app_settings (key, value) VALUES ('feature_matrix', ?)").run(JSON.stringify(DEFAULT_FEATURE_MATRIX));
        console.log('[v1.62] 已初始化默认功能矩阵（全部开放）');
      }
    } catch (e) {
      console.warn('[v1.62] 初始化功能矩阵失败（使用默认值）:', e.message);
    }

    const adminRow = database.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY rowid ASC LIMIT 1").get()
      || database.prepare('SELECT id FROM users ORDER BY rowid ASC LIMIT 1').get();
    const adminId = adminRow ? adminRow.id : '';
    if (adminId) {
      for (const table of V5_BUSINESS_TABLES) {
        try {
          database.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL OR user_id = ''`).run(adminId);
        } catch (e) { /* 表可能为空/不存在，跳过 */ }
      }
    }
    // 历史明文 API Key 平滑加密迁移（幂等）
    try {
      const modelRows = database.prepare('SELECT id, api_key FROM model_configs').all();
      const updateKey = database.prepare('UPDATE model_configs SET api_key = ? WHERE id = ?');
      let encrypted = 0;
      for (const row of modelRows) {
        if (typeof row.api_key === 'string' && row.api_key.trim() && !row.api_key.startsWith('enc:v1:')) {
          updateKey.run(encryptSecret(row.api_key), row.id);
          encrypted++;
        }
      }
      if (encrypted > 0) console.log(`[v5] 已加密迁移 ${encrypted} 条历史模型 Key`);
    } catch (e) {
      console.error('[v5] 模型 Key 加密迁移失败:', e.message);
    }
    console.log('[v5] 数据库升级完成（多租户/认证/审计表 + user_id 迁移）');
  } catch (e) {
    console.error('[v5] 数据库升级失败（旧数据保持不变，服务继续以兼容模式运行）:', e.message);
  }

  // ============================================================
  // v1.60：提示词扁平化迁移（L0/L1/L3 → 单一 system_prompt；重建表方案）
  // ============================================================
  try {
    migratePromptTemplatesV160(database);
  } catch (e) {
    console.error('[v1.60] prompt_templates 扁平化迁移失败（旧表保留，服务继续运行）:', e.message);
  }


  // ============================================================
  // V1.63：评测历史 / 软删除回收站 / 客户级授权 / 用量统计
  // 全部为幂等加列/加表，不重建、不删除任何既有数据
  // ============================================================
  try {
    const ensureColumn = (table, column, definition) => {
      const cols = database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.length === 0) return;
      if (!cols.includes(column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
        console.log(`[v1.63] ${table} 补充列: ${column}`);
      }
    };
    // 1) 评测历史
    ensureColumn('eval_runs', 'project_id', 'TEXT');
    ensureColumn('eval_runs', 'prompt_hash', "TEXT DEFAULT ''");
    ensureColumn('eval_runs', 'case_total', 'INTEGER DEFAULT 0');
    ensureColumn('eval_runs', 'case_passed', 'INTEGER DEFAULT 0');
    ensureColumn('eval_runs', 'p0_failures', 'INTEGER DEFAULT 0');
    ensureColumn('eval_runs', 'details_json', "TEXT DEFAULT ''");
    ensureColumn('eval_runs', 'created_at', "TEXT DEFAULT ''");
    // 2) 软删除（回收站）
    for (const table of ['companies', 'projects', 'kb_items', 'snapshots']) {
      ensureColumn(table, 'deleted_at', "TEXT DEFAULT ''");
      ensureColumn(table, 'deleted_by', "TEXT DEFAULT ''");
      ensureColumn(table, 'deleted_batch', "TEXT DEFAULT ''");
    }
    // 3) 模型单价（元 / 百万 token）
    ensureColumn('model_configs', 'price_input_per_m', 'REAL DEFAULT 0');
    ensureColumn('model_configs', 'price_output_per_m', 'REAL DEFAULT 0');
    // 4) 新表与索引
    database.exec(`
      CREATE TABLE IF NOT EXISTS read_grants (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        grantee_type TEXT NOT NULL,
        grantee_id TEXT DEFAULT '',
        granted_by TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        UNIQUE(scope_type, scope_id, grantee_type, grantee_id)
      );
      CREATE TABLE IF NOT EXISTS company_pins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        created_at TEXT,
        UNIQUE(user_id, company_id)
      );
      CREATE TABLE IF NOT EXISTS llm_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT DEFAULT '',
        project_id TEXT DEFAULT '',
        provider TEXT DEFAULT '',
        model_name TEXT DEFAULT '',
        route_kind TEXT DEFAULT '',
        purpose TEXT DEFAULT '',
        status TEXT DEFAULT '',
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        created_at TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_kb_items_project ON kb_items(project_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_project ON eval_runs(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_read_grants_scope ON read_grants(scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS idx_company_pins_user ON company_pins(user_id);
      CREATE INDEX IF NOT EXISTS idx_companies_deleted ON companies(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_kb_items_deleted ON kb_items(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_deleted ON snapshots(deleted_at);
    `);
    // 5) 旧「单项目 → 单用户」授权幂等迁入 read_grants（旧表保留，便于回滚）
    try {
      const legacyGrants = database.prepare('SELECT project_id, grantee_user_id, granted_by, created_at FROM project_grants').all();
      const insertGrant = database.prepare('INSERT OR IGNORE INTO read_grants (id, scope_type, scope_id, grantee_type, grantee_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const grant of legacyGrants) {
        if (!grant.project_id || !grant.grantee_user_id) continue;
        insertGrant.run('rg-' + crypto.randomUUID().split('-')[0], 'project', grant.project_id, 'user', grant.grantee_user_id, grant.granted_by || '', grant.created_at || '');
      }
    } catch (e) {
      console.warn('[v1.63] 旧授权迁移失败（不影响启动）:', e.message);
    }
    // 6) 回收站保留期默认 30 天
    try {
      const retentionRow = database.prepare("SELECT value FROM app_settings WHERE key = 'recycle_retention_days'").get();
      if (!retentionRow) database.prepare("INSERT INTO app_settings (key, value) VALUES ('recycle_retention_days', '30')").run();
    } catch (e) { /* ignore */ }
    console.log('[v1.63] 数据库升级完成（评测历史/回收站/授权/用量）');
  } catch (e) {
    console.error('[v1.63] 数据库升级失败（旧数据保持不变，服务继续运行）:', e.message);
  }

  return database;
}

/**
 * v1.60 prompt_templates 扁平化迁移（幂等）
 * 1. 仅当旧表仍存在 l0_content/l1_content/l3_content 任一列时才执行；
 * 2. 先做文件级备份（迁移前最后一道保险）；
 * 3. 事务内：先把旧三层非空内容合并写入临时 system_prompt 列，再用「重建表」方案
 *    生成全新结构表（保留 id/name/created_at/is_public/public_scope/user_id 全部字段；
 *    原库无物理外键，新表保持相同结构以避免行为变化），迁移全部数据后删除旧表并改名；
 * 4. 任一步骤失败事务自动回滚，旧数据完好无损。
 */
function migratePromptTemplatesV160(database) {
  const columns = database.prepare('PRAGMA table_info(prompt_templates)').all().map((c) => c.name);
  if (columns.length === 0) return; // 表不存在（全新库由建表语句直接创建新结构）
  const legacyColumns = ['l0_content', 'l1_content', 'l3_content'];
  if (!legacyColumns.some((c) => columns.includes(c))) {
    if (!columns.includes('system_prompt')) {
      // 异常兜底：既无旧列也无新列时补新列
      database.exec("ALTER TABLE prompt_templates ADD COLUMN system_prompt TEXT DEFAULT '';");
    }
    return; // 已是新结构，幂等跳过
  }

  // 1) 迁移前文件级备份（带时间戳，与主备份目录区分）
  try {
    const backupDir = path.join(DATA_DIR, 'backup-v1.60');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    database.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_PATH, path.join(backupDir, `prompt-studio-pre-v160-${stamp}.db`));
    console.log('[v1.60] 迁移前文件级备份已完成:', backupDir);
  } catch (e) {
    console.warn('[v1.60] 迁移前备份失败（继续执行，事务仍可回滚）:', e.message);
  }

  // 2) 若尚无 system_prompt 列则先添加（ALTER 不能在事务内依赖旧列名，先加列）
  if (!columns.includes('system_prompt')) {
    database.exec("ALTER TABLE prompt_templates ADD COLUMN system_prompt TEXT DEFAULT '';");
  }

  // 3) 事务内合并旧三层（过滤 NULL 与空串，保留层级语义标题，用空行分隔）
  //    真实旧数据本身可能已带「【Lx …】」标题，若内容已以该标题开头则不重复添加，避免标题重复
  const LAYER_TITLES = {
    l0: '【L0 全局安全基座】',
    l1: '【L1 语音基座】',
    l3: '【L3 项目专属话术】',
  };
  const buildLayerBlock = (raw, title) => {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    if (text.startsWith(title)) return text;
    return `${title}\n${text}`;
  };

  // 4) 重建表（SQLite 不支持 DROP COLUMN 的可靠替代方案）
  const runMigration = database.transaction(() => {
    // 3.1 逐行在 JS 中合并，写入 system_prompt
    const rows = database.prepare('SELECT id, l0_content, l1_content, l3_content FROM prompt_templates').all();
    const updateStmt = database.prepare('UPDATE prompt_templates SET system_prompt = ? WHERE id = ?');
    for (const r of rows) {
      const blocks = [
        buildLayerBlock(r.l0_content, LAYER_TITLES.l0),
        buildLayerBlock(r.l1_content, LAYER_TITLES.l1),
        buildLayerBlock(r.l3_content, LAYER_TITLES.l3),
      ].filter(Boolean);
      updateStmt.run(blocks.join('\n\n'), r.id);
    }

    database.exec('PRAGMA foreign_keys = OFF;');
    database.exec(`
      CREATE TABLE prompt_templates_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        system_prompt TEXT DEFAULT '',
        created_at TEXT DEFAULT '',
        is_public INTEGER DEFAULT 0,
        public_scope TEXT DEFAULT 'private',
        user_id TEXT
      );
    `);
    // 动态适配：V5 多租户升级通常已补 is_public/public_scope/user_id；
    // 若个别列缺失则用固定默认值，避免 "no such column"
    const sel = [
      'id',
      'name',
      'system_prompt',
      'created_at',
      columns.includes('is_public') ? 'is_public' : '0',
      columns.includes('public_scope') ? 'public_scope' : `'private'`,
      columns.includes('user_id') ? 'user_id' : 'NULL',
    ].join(', ');
    database.exec(`
      INSERT INTO prompt_templates_new (id, name, system_prompt, created_at, is_public, public_scope, user_id)
      SELECT ${sel}
      FROM prompt_templates;
    `);
    database.exec('DROP TABLE prompt_templates;');
    database.exec('ALTER TABLE prompt_templates_new RENAME TO prompt_templates;');
    database.exec('PRAGMA foreign_keys = ON;');
  });
  runMigration();

  const migrated = database.prepare('SELECT COUNT(*) c FROM prompt_templates').get().c;
  console.log(`[v1.60] prompt_templates 扁平化迁移完成，共迁移 ${migrated} 条真实数据（旧三层已合并为 system_prompt）`);
}

let db;
try {
  db = initDb();
} catch (e) {
  console.error('[server] 数据库初始化失败，服务无法启动:', e.message);
  console.error('  提示：请检查 data/ 目录权限，或从备份恢复 data/newrock.db');
  process.exit(1);
}
// V5.0：默认超管 ID（旧数据归属 & 公共 Key 提供者；后续所有隔离逻辑依赖）
let ADMIN_USER_ID = '';
try {
  const adminRow = db.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY rowid ASC LIMIT 1").get();
  ADMIN_USER_ID = adminRow ? adminRow.id : '';
} catch (e) {
  console.error('[v5] 查询超管账号失败:', e.message);
}
/** V1.62：全量备份导入后账号可能会变，必须重新解析超管 ID（公共模型/旧数据归属都依赖它） */
function refreshAdminUserId() {
  try {
    const adminRow = db.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY rowid ASC LIMIT 1").get()
      || db.prepare('SELECT id FROM users ORDER BY rowid ASC LIMIT 1').get();
    ADMIN_USER_ID = adminRow ? adminRow.id : '';
  } catch (e) {
    console.error('[v1.62] 刷新超管 ID 失败:', e.message);
  }
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

/** V1.63 修复：去除大模型返回的 Markdown 代码围栏（此前 /api/ai/polish 因缺少该函数直接 500） */
function stripCodeFence(text) {
  let output = String(text ?? '').trim();
  const fence = output.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) output = fence[1].trim();
  return output;
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

/** 组装：v1.60 单层（系统提示词）直接输出正文；多层时按 LAYER_ORDER 排序 + 标题拼接 */
function assemblePrompt(layers) {
  const list = Array.isArray(layers) ? layers : [];
  const valid = list.filter((l) => l && typeof l === 'object');
  if (valid.length === 1) {
    return String(valid[0].content ?? '');
  }
  const sorted = [...valid].sort((a, b) => LAYER_ORDER.indexOf(a?.layer) - LAYER_ORDER.indexOf(b?.layer));
  return sorted.map((l) => `\n\n### ${l?.name ?? ''} (${l?.layer ?? ''})\n${l?.content ?? ''}`).join('');
}

/** 安全解析 snapshots.module_versions_json（layers）：坏 JSON / 非数组 -> [] */
function safeParseLayers(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** V1.63：提示词内容哈希（评测与提交关联用，便于判断是否为同一版提示词） */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** body.context_data 必须是「对象且非空」才优先于数据库 */
function isUsableContextData(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

// ---------- 3.4 评测 / 多轮对话（原 eval-runner） ----------

/**
 * V1.63：中文数字播报检测（收紧规则，修掉「一起/十分/三点/千万」等常用词误判）
 * 只拦三类明确违规：≥3 位连续中文数字、中文数字 + 元、数字与中文数字混排
 */
const CN_NUMERAL_CHARS = '零〇一二三四五六七八九十百千万亿幺';
function detectSpokenNumbers(text) {
  const source = String(text ?? '');
  const patterns = [
    new RegExp('[' + CN_NUMERAL_CHARS + ']{3,}'),
    new RegExp('[' + CN_NUMERAL_CHARS + ']{2,}元'),
    new RegExp('\\d[' + CN_NUMERAL_CHARS + ']|[' + CN_NUMERAL_CHARS + ']\\d'),
  ];
  return patterns.some((re) => re.test(source));
}
/** L1 确定性断言 */
function checkL1(agentOutput) {
  const output = typeof agentOutput === 'string' ? agentOutput : String(agentOutput ?? '');
  const errors = [];
  const speakIndex = output.indexOf('<speak>');
  const toolIndex = output.indexOf('<tool>');
  if (speakIndex === -1 && toolIndex !== -1) errors.push('违规：检测到工具调用，但缺少播报话术 <speak>');
  else if (speakIndex !== -1 && toolIndex !== -1 && speakIndex > toolIndex) errors.push('违规时序：工具调用 <tool> 出现在了语音播报 <speak> 之前');
  if (/\*\*|^#+\s|^\s*-\s/m.test(output)) errors.push('违规格式：包含 Markdown 标记');
  if (detectSpokenNumbers(output)) errors.push('违规播报：检测到中文数字单位，电话号码必须逐位播报');
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
  ], 'eval_l2');
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

/** V5.0：按用户查询其私有激活模型 */
function getActiveModelConfigForUser(userId) {
  try {
    return db.prepare('SELECT * FROM model_configs WHERE user_id = ? AND is_active = 1 ORDER BY rowid DESC LIMIT 1').get(userId) || null;
  } catch (e) {
    console.warn('[LLM] 查询用户私有模型失败:', e.message);
    return null;
  }
}
/** V5.0：超管公共激活模型（无私有 Key 的用户走此模型 + 试用扣减） */
function getActiveAdminModel() {
  if (!ADMIN_USER_ID) return null;
  return getActiveModelConfigForUser(ADMIN_USER_ID);
}
/** V5.0：原子占用一次免费试用额度（并发安全：UPDATE ... WHERE trial_count < 3） */
function consumeTrialOrThrow(userId) {
  const info = db.prepare('UPDATE users SET trial_count = trial_count + 1 WHERE id = ? AND trial_count < ?').run(userId, TRIAL_LIMIT);
  if (!info || info.changes === 0) {
    throw httpError(403, `免费试用额度已用完（${TRIAL_LIMIT}/${TRIAL_LIMIT}），请配置自己的 API Key`, 'TRIAL_EXHAUSTED');
  }
}
/** V5.0：请求失败补偿——回滚已占用的试用次数 */
function rollbackTrial(userId) {
  try {
    db.prepare('UPDATE users SET trial_count = trial_count - 1 WHERE id = ? AND trial_count > 0').run(userId);
  } catch (e) {
    console.error('[v5] 试用次数回滚失败:', e.message);
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

/** V1.63：记录一次 LLM 调用的 token / 耗时（失败绝不阻断主流程） */
function recordLlmUsage(meta, usage, status, latencyMs, errorText) {
  try {
    const store = requestContext.getStore() || {};
    const safeUsage = usage && typeof usage === 'object' ? usage : {};
    const promptTokens = Math.max(0, Number(safeUsage.prompt_tokens) || 0);
    const completionTokens = Math.max(0, Number(safeUsage.completion_tokens) || 0);
    const totalTokens = Math.max(0, Number(safeUsage.total_tokens) || (promptTokens + completionTokens));
    db.prepare('INSERT INTO llm_usage (id, user_id, project_id, provider, model_name, route_kind, purpose, status, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'use-' + crypto.randomUUID().split('-')[0],
        String(store.userId || ''),
        String(store.projectId || ''),
        String((meta && meta.provider) || ''),
        String((meta && meta.modelName) || ''),
        String((meta && meta.routeKind) || ''),
        String((meta && meta.purpose) || 'chat'),
        String(status || 'ok'),
        promptTokens,
        completionTokens,
        totalTokens,
        Math.max(0, Number(latencyMs) || 0),
        new Date().toISOString(),
      );
  } catch (e) {
    // 用量统计不得影响业务调用
  }
}

/** 发起一次 Chat Completions 请求（含超时；错误由上层统一脱敏；V1.63 记录 usage） */
async function requestChatCompletion(config, messages, timeoutOrOptions = LLM_REQUEST_TIMEOUT_MS) {
  const options = timeoutOrOptions && typeof timeoutOrOptions === 'object' ? timeoutOrOptions : { timeoutMs: timeoutOrOptions };
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : LLM_REQUEST_TIMEOUT_MS;
  const meta = {
    provider: String(options.provider || 'env'),
    modelName: String(config.model_name || DEFAULT_LLM_CONFIG.model_name),
    routeKind: String(options.routeKind || ''),
    purpose: String(options.purpose || 'chat'),
  };
  const startedAt = Date.now();
  const baseUrl = String(config.base_url || DEFAULT_LLM_CONFIG.base_url).replace(/\/$/, '');
  const apiKey = config.api_key;
  if (!apiKey) throw new Error('未提供 API Key，且环境变量中未找到 DEEPSEEK_API_KEY');
  try {
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
    recordLlmUsage(meta, data && data.usage, 'ok', Date.now() - startedAt, '');
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    if (typeof content !== 'string') throw new Error('LLM 返回内容为空或格式异常');
    return content;
  } catch (error) {
    recordLlmUsage(meta, null, 'error', Date.now() - startedAt, error && error.message);
    throw error;
  }
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
async function chatCompletion(config, messages, purpose = 'chat') {
  const callerConfig = { ...DEFAULT_LLM_CONFIG, ...(config || {}) };
  return llmLimit(async () => {
    const contextUserId = (requestContext.getStore() && requestContext.getStore().userId) || '';
    const contextUser = contextUserId ? db.prepare('SELECT * FROM users WHERE id = ?').get(contextUserId) : null;

    // 无登录上下文（仅内部/兼容调用；API 层已被 auth gate 拦截）→ 沿用 V4 全局路由
    if (!contextUser) {
      const activeModel = getActiveModelConfig();
      if (activeModel) {
        try {
          const security = validateModelBaseUrl(activeModel.base_url || DEFAULT_LLM_CONFIG.base_url);
          if (!security.ok) throw new Error('激活模型 Base URL 不安全：' + security.error);
          const key = decryptSecret(activeModel.api_key);
          if (key) {
            return await requestChatCompletion({
              base_url: activeModel.base_url || DEFAULT_LLM_CONFIG.base_url,
              model_name: activeModel.model_name || DEFAULT_LLM_CONFIG.model_name,
              api_key: key,
              temperature: Number.isFinite(Number(activeModel.temperature)) ? Number(activeModel.temperature) : callerConfig.temperature,
            }, messages, { purpose, provider: activeModel.provider || '', routeKind: 'global' });
          }
        } catch (dbError) {
          console.warn('[LLM] DB 激活模型调用失败，自动回落 .env:', redactSecrets(dbError && dbError.message ? dbError.message : dbError));
        }
      }
      return requestChatCompletion(buildEnvLlmConfig(callerConfig.temperature), messages, { purpose, provider: 'env', routeKind: 'global-env' });
    }

    const isSuperadmin = contextUser.role === 'superadmin';
    let route = null; // { kind: 'private'|'public'|'public-env'|'admin-env', row, key }

    // 1) 私有 Key：本人激活模型
    const ownModel = getActiveModelConfigForUser(contextUser.id);
    if (ownModel) {
      const ownKey = decryptSecret(ownModel.api_key);
      if (ownKey) {
        route = { kind: 'private', row: ownModel, key: ownKey };
      } else if (isSuperadmin) {
        const envKey = resolveModelApiKey(ownModel.base_url || DEFAULT_LLM_CONFIG.base_url, '');
        if (envKey) route = { kind: 'admin-env', row: ownModel, key: envKey };
      }
    }

    // 2) 无私有 Key：普通用户使用超管公共 Key（或系统 .env），并消耗一次试用额度
    if (!route && !isSuperadmin) {
      const publicModel = getActiveAdminModel();
      if (publicModel) {
        const publicKey = decryptSecret(publicModel.api_key) || resolveModelApiKey(publicModel.base_url || DEFAULT_LLM_CONFIG.base_url, '');
        if (publicKey) route = { kind: 'public', row: publicModel, key: publicKey };
      }
      if (!route) {
        const envKey = resolveModelApiKey(DEFAULT_LLM_CONFIG.base_url, '');
        if (envKey) route = { kind: 'public-env', row: null, key: envKey };
      }
      if (!route) throw new Error('当前没有可用的公共 API Key，请联系管理员配置');
    }
    // 3) 超管无激活模型：直接使用 .env 系统 Key（不消耗试用）
    if (!route && isSuperadmin) {
      const envConfig = buildEnvLlmConfig(callerConfig.temperature);
      if (!envConfig.api_key) throw new Error('未配置系统 API Key（管理员可在右上角设置页配置 .env Key）');
      route = { kind: 'admin-env', row: null, key: envConfig.api_key };
    }
    if (!route) throw new Error('没有可用的模型路由');

    let dbConfig;
    if (route.row) {
      const baseUrl = route.row.base_url || DEFAULT_LLM_CONFIG.base_url;
      const security = validateModelBaseUrl(baseUrl);
      if (!security.ok) throw new Error('激活模型 Base URL 不安全：' + security.error);
      dbConfig = {
        base_url: baseUrl,
        model_name: route.row.model_name || DEFAULT_LLM_CONFIG.model_name,
        api_key: route.key,
        temperature: Number.isFinite(Number(route.row.temperature)) ? Number(route.row.temperature) : callerConfig.temperature,
      };
    } else {
      dbConfig = buildEnvLlmConfig(callerConfig.temperature);
      dbConfig.api_key = route.key || dbConfig.api_key;
    }

    const usingTrial = route.kind === 'public' || route.kind === 'public-env';
    // 防并发白嫖：原子占用额度（trial_count < 3 才成功，并发竞争失败者直接 403）
    if (usingTrial) consumeTrialOrThrow(contextUser.id);
    console.log(`[LLM] 路由: ${route.kind} (${route.row ? (route.row.display_name || route.row.id) : '.env'}) user=${contextUser.username}${usingTrial ? ' / trial+1' : ''}`);
    try {
      return await requestChatCompletion(dbConfig, messages, { purpose, provider: route.row ? (route.row.provider || '') : 'env', routeKind: route.kind });
    } catch (error) {
      // 大模型报错/超时 → 回滚本次试用扣减
      if (usingTrial) rollbackTrial(contextUser.id);
      if (isSuperadmin && route.kind === 'private') {
        // 管理员私有模型失败 → 仍回落 .env（保持既有韧性；不涉及试用）
        try {
          console.warn('[LLM] 管理员私有模型失败，自动回落 .env:', redactSecrets(error && error.message ? error.message : error, [route.key]));
          return await requestChatCompletion(buildEnvLlmConfig(callerConfig.temperature), messages, { purpose, provider: 'env', routeKind: 'fallback-env' });
        } catch (envError) {
          throw new Error(redactSecrets(envError && envError.message ? envError.message : envError));
        }
      }
      throw new Error(redactSecrets(error && error.message ? error.message : error, [route.key]));
    }
  });
}


/** 用给定配置做一次最小连通性测试（/api/models/test 专用；20s 超时；错误信息已脱敏）
 *  安全：Base URL 必须通过 SSRF 校验；.env 真实 Key 只允许发送给官方 DeepSeek 端点。
 *  V5.0：allowEnvFallback 仅超管可为 true（普通用户不得借用系统 .env Key）。 */
async function testModelConnection({ base_url, model_name, api_key }, options = {}) {
  const startedAt = Date.now();
  const effectiveModelName = model_name || DEFAULT_LLM_CONFIG.model_name;
  const targetBaseUrl = base_url || DEFAULT_LLM_CONFIG.base_url;
  const security = validateModelBaseUrl(targetBaseUrl);
  if (!security.ok) return { success: false, message: security.error };
  const explicitKey = typeof api_key === 'string' ? api_key.trim() : '';
  const effectiveApiKey = explicitKey || (options.allowEnvFallback ? resolveModelApiKey(targetBaseUrl, '') : '');
  if (!effectiveApiKey) {
    return { success: false, message: '该 Base URL 必须显式填写 API Key（普通用户禁止回退系统 .env Key，防 Key 外泄）' };
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
      ], 'kb_parse');
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

/**
 * v1.60：多格式文档 → 纯文本（知识库导入前置解析）
 * 支持 .txt / .doc / .docx / .xls / .xlsx / .pdf
 * @param {string} fileName 原始文件名（用于识别扩展名）
 * @param {Buffer} buffer 文件二进制内容
 * @returns {Promise<string>} 提取出的纯文本
 */
async function extractTextFromDocument(fileName, buffer) {
  const ext = String(fileName || '').toLowerCase().split('.').pop() || '';
  if (ext === 'txt') {
    return buffer.toString('utf8');
  }
  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (ext === 'doc') {
    // 旧版 .doc 为二进制 OLE 格式，mammoth 仅支持 .docx；尝试按文本容错提取，失败给出明确错误
    const fallback = buffer.toString('utf8').replace(/[^\S\r\n\x20-\x7e\u4e00-\u9fa5，。；：、！？“”‘’（）《》【】0-9A-Za-z]/g, ' ');
    if (fallback.trim().length >= 20) return fallback;
    throw new Error('旧版 .doc 二进制格式支持有限，请先用 Word 另存为 .docx 后再导入');
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      return `# ${name}\n${csv}`;
    });
    return sheets.join('\n\n');
  }
  if (ext === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(`不支持的文件类型：.${ext}（支持 .txt/.doc/.docx/.xls/.xlsx/.pdf）`);
}

/**
 * v1.60：通用多格式导出（带 UTF-8 BOM，保证 Windows 记事本/Excel 打开不乱码）
 * @param {string} text 导出正文
 * @param {string} format txt | md
 * @param {string} baseName 不含扩展名的文件名
 */
function buildExportResponse(res, text, format, baseName) {
  const safeFormat = format === 'md' ? 'md' : 'txt';
  const contentType = safeFormat === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  const BOM = '﻿';
  const fileName = `${baseName}.${safeFormat}`;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(BOM + text);
}

// ============================================================
// 四、Express 应用
// ============================================================

const app = express();
app.disable('x-powered-by');

// 基础安全响应头（防点击劫持/ MIME 嗅探）
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// V1.62 来源白名单：
// - LAN_ACCESS=false（默认）：只允许回环地址，行为与 V1.61 完全一致；
// - LAN_ACCESS=true：额外放行 RFC1918 私有网段与 IPv6 ULA / 链路本地；
// - 任何情况下只认「字面 IP + localhost」，继续拒绝任意域名（保留防 DNS rebinding 能力）。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function normalizeHostname(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}
function isLoopbackHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
function isPrivateIpv4Hostname(host) {
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host);
}
function isPrivateIpv6Hostname(host) {
  if (!host.includes(':')) return false;
  if (host === '::1') return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return !!(mapped && isPrivateIpv4Hostname(mapped[1]));
}
function isAllowedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (isLoopbackHostname(host)) return true;
  if (!LAN_ACCESS) return false;
  return isPrivateIpv4Hostname(host) || isPrivateIpv6Hostname(host);
}
function isLocalOrigin(origin) {
  if (!origin) return true; // curl / 同源请求通常无 Origin
  try { return isAllowedNetworkHost(new URL(origin).hostname); } catch { return false; }
}
// Host 头校验（防 DNS rebinding：攻击者用同端口恶意域名解析到本机后无 Origin 访问 API）
function isLocalHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) return false;
  try { return isAllowedNetworkHost(new URL('http://' + raw).hostname); } catch { return false; }
}
app.use(cors({
  origin(origin, cb) {
    if (isLocalOrigin(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
// 双重防线：非白名单 Origin 或伪造 Host 的 /api 请求一律 403
app.use('/api', (req, res, next) => {
  if (!isLocalOrigin(req.headers.origin)) {
    return res.status(403).json({ success: false, error: '跨站请求被拒绝：仅允许本机或局域网私有网段访问' });
  }
  if (!isLocalHostHeader(req.headers.host)) {
    return res.status(403).json({ success: false, error: 'Host 不被允许：仅限本机或局域网私有网段访问（防 DNS rebinding）' });
  }
  return next();
});
// JSON body 解析（10MB，覆盖长提示词/批量导入）
app.use(express.json({ limit: '32mb' })); // V1.63：知识库 20MB 文件 base64 后约 27MB
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

// ============================================================
// v1.61：认证会话改用 express-session 默认内存存储（MemoryStore，不持久化、不依赖原生 sqlite3）
// 内网单机系统，重启后重新登录即可；不引入任何第三方会话存储包
// V1.62：会话密钥持久化（不再硬编码），cookie 名与 logout 清理保持一致
const SESSION_SECRET = resolveSessionSecret();
app.use(session({
  name: 'newrock.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));
// 为每个请求建立用户上下文（供 chatCompletion 试用扣减/模型路由使用；并记录审计 IP）
app.use((req, res, next) => {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
  requestContext.run({ userId: req.session && req.session.userId ? req.session.userId : null, ip }, next);
});

// 白名单：登录页 / 登录注册接口 / 启动配置 / 健康检查；其余未登录访问一律拦截
const AUTH_WHITELIST_PATHS = new Set(['/login.html', '/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/config', '/api/health']);
const AUTH_PUBLIC_STATIC_RE = /^\/(logo\.png|favicon\.ico)$/i;
function destroySessionQuietly(req) {
  try { if (req.session) req.session.destroy(() => {}); } catch (e) { /* ignore */ }
}
/** V1.62：解析并校验会话用户（账号状态 + 会话版本），失效立即销毁会话 */
function resolveSessionUser(req) {
  if (req._sessionUser !== undefined) return req._sessionUser;
  const userId = req.session && req.session.userId ? String(req.session.userId) : '';
  if (!userId) { req._sessionUser = null; return null; }
  let user = null;
  try { user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null; } catch (e) { user = null; }
  if (!user || String(user.status || 'active') !== 'active') {
    destroySessionQuietly(req);
    req._sessionUser = null;
    return null;
  }
  const expected = Number(user.session_version) || 1;
  const actual = Number(req.session && req.session.sv) || 0;
  if (expected !== actual) {
    destroySessionQuietly(req);
    req._sessionUser = null;
    return null;
  }
  req._sessionUser = user;
  return user;
}
function authGate(req, res, next) {
  const requestPath = req.path;
  if (AUTH_WHITELIST_PATHS.has(requestPath) || AUTH_PUBLIC_STATIC_RE.test(requestPath)) return next();
  if (resolveSessionUser(req)) return next();
  if (requestPath.startsWith('/api/')) {
    return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期，请重新登录' });
  }
  return res.redirect(302, '/login.html');
}
app.use(authGate);
app.use(featureGate);

function getSessionUser(req) {
  return resolveSessionUser(req);
}
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    team_id: user.team_id || '',
    need_change_password: Number(user.need_change_password) || 0,
    trial_count: Number(user.trial_count) || 0,
    trial_limit: TRIAL_LIMIT,
    status: user.status || 'active',
    features: resolveUserFeatures(user),
  };
}
function requireLogin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  req.user = user;
  return next();
}
function requireSuperAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  if (user.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '需要超级管理员权限' });
  req.user = user;
  return next();
}
function requireManager(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  if (!['superadmin', 'teamadmin'].includes(user.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  req.user = user;
  return next();
}
function isValidUsername(username) {
  return /^(1[3-9]\d{9}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(String(username || '').trim());
}

// ============================================================
// V5.0 多租户数据隔离辅助（个人 / 团管 / 超管）
// ============================================================
/** 当前请求用户（auth gate 保证 /api 已登录；无会话时返回 null，内部调用需自行处理） */
function currentSessionUser(req) {
  return (req && req.user) || getSessionUser(req);
}
/** 可见数据的所有者 userId 列表；超管返回 null 表示“无限制” */
function visibleOwnerIds(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return null;
  if (user.role === 'teamadmin') {
    // V1.63 修复：团队管理员未分配团队时只能看自己的数据，不能把「所有无团队用户」当成同团队
    const teamId = String(user.team_id || '').trim();
    if (!teamId) return [user.id];
    const rows = db.prepare('SELECT id FROM users WHERE team_id = ?').all(teamId);
    return rows.map((r) => r.id);
  }
  return [user.id];
}
/** 某条数据的所有者是否对当前用户可见（个人=本人；团管=同团队；超管=全部） */
function canAccessOwner(ownerUserId, user) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (!ownerUserId) return false;
  if (ownerUserId === user.id) return true;
  if (user.role === 'teamadmin') {
    try {
      const owner = db.prepare('SELECT team_id FROM users WHERE id = ?').get(ownerUserId);
      return !!(owner && owner.team_id && owner.team_id === (user.team_id || ''));
    } catch (e) { return false; }
  }
  return false;
}
/** 校验项目访问权（越权返回 403，不存在返回 404） */
/** 公共参考项目是否可被当前用户只读访问（global：全员；team：同团队） */
function canReadPublicProject(project, user) {
  if (!project || Number(project.is_public) !== 1) return false;
  const scope = project.public_scope || 'global';
  if (scope === 'global') return true;
  if (scope === 'team' && user && user.team_id) {
    try {
      const owner = db.prepare('SELECT team_id FROM users WHERE id = ?').get(project.user_id);
      return !!(owner && owner.team_id && owner.team_id === user.team_id);
    } catch (e) { return false; }
  }
  return false;
}
/**
 * V1.63：统一只读授权判定（read_grants）
 * 命中条件：项目级或所属客户级授权 ∩（指定用户 / 指定团队 / 所有团队）
 * 客户级授权对该客户下后续新建项目自动生效。
 */
function hasReadGrant(project, user) {
  if (!project || !user) return false;
  const projectId = String(project.id || '');
  const companyId = String(project.company_id || '');
  if (!projectId && !companyId) return false;
  try {
    const teamId = String(user.team_id || '').trim() || '__no_team__';
    return !!db.prepare(
      "SELECT 1 FROM read_grants WHERE ((scope_type = 'project' AND scope_id = ?) OR (scope_type = 'company' AND scope_id = ?)) AND ((grantee_type = 'user' AND grantee_id = ?) OR (grantee_type = 'team' AND grantee_id = ?) OR grantee_type = 'all') LIMIT 1"
    ).get(projectId, companyId, String(user.id || ''), teamId);
  } catch (e) {
    return false;
  }
}
/** V1.63：当前用户是否只能通过「只读授权」访问该项目（所有者/同团队团管不算） */
function isReadOnlyGrantee(project, user) {
  if (!project || !user) return false;
  if (canAccessOwner(project.user_id, user)) return false;
  return hasReadGrant(project, user);
}
/** V1.62：统一读权限判定（所有者 / 公共参考 / 只读授权） */
function canReadProject(project, user) {
  if (!project) return false;
  return canAccessOwner(project.user_id, user)
    || canReadPublicProject(project, user)
    || hasReadGrant(project, user);
}
/** V1.63：行是否在回收站（'' 与 NULL 都视为未删除） */
function isRowDeleted(row) {
  return !!(row && String(row.deleted_at || '').trim() !== '');
}
/** V1.63：公司级可见性（所有者 / 公共 / 只读授权任一项目均可） */
function canReadCompany(company, user) {
  if (!company) return false;
  if (canAccessOwner(company.user_id, user)) return true;
  try {
    const rows = db.prepare("SELECT * FROM projects WHERE company_id = ? AND COALESCE(deleted_at, '') = ''").all(company.id);
    return rows.some((project) => canReadProject(project, user));
  } catch (e) {
    return false;
  }
}
function requireProjectAccess(projectId, user, options = {}) {
  const project = projectId ? db.prepare('SELECT * FROM projects WHERE id = ?').get(String(projectId)) : null;
  if (!project) throw httpError(404, '项目不存在或无权访问');
  if (!options.allowDeleted && isRowDeleted(project)) throw httpError(404, '项目已在回收站');
  if (!canReadProject(project, user)) throw httpError(403, '无权访问该项目');
  return project;
}
/** 写操作校验：共享只读授权、公共参考项目均禁止修改（超管管理场景除外） */
function requireProjectWritable(projectId, user) {
  const project = requireProjectAccess(projectId, user);
  if (isReadOnlyGrantee(project, user)) throw httpError(403, '该项目为共享只读权限，无权修改');
  if (Number(project.is_public) === 1 && (!user || user.role !== 'superadmin')) {
    throw httpError(403, '无权修改公共项目');
  }
  return project;
}
/** 已有项目行时的写保护（KB 等通过 project 行校验的场景） */
function assertProjectWritableByRow(project, user) {
  if (project && isReadOnlyGrantee(project, user)) throw httpError(403, '该项目为共享只读权限，无权修改');
  if (project && Number(project.is_public) === 1 && (!user || user.role !== 'superadmin')) {
    throw httpError(403, '无权修改公共项目');
  }
  return project;
}
/** 校验公司访问权 */
function requireCompanyAccess(companyId, user, options = {}) {
  const company = companyId ? db.prepare('SELECT * FROM companies WHERE id = ?').get(String(companyId)) : null;
  if (!company) throw httpError(404, '客户/行业不存在或无权访问');
  if (!options.allowDeleted && isRowDeleted(company)) throw httpError(404, '客户/行业已在回收站');
  if (!canAccessOwner(company.user_id, user)) throw httpError(403, '无权访问该客户/行业');
  return company;
}
/** 校验快照访问权（优先 user_id，缺失则回落到项目归属） */
function requireSnapshotAccess(snapshotId, user, options = {}) {
  const snapshot = snapshotId ? db.prepare('SELECT * FROM snapshots WHERE id = ?').get(String(snapshotId)) : null;
  if (!snapshot) throw httpError(404, '快照不存在或无权访问');
  if (!options.allowDeleted && isRowDeleted(snapshot)) throw httpError(404, '提交记录已在回收站');
  let ownerId = snapshot.user_id;
  let projectRow = null;
  if (snapshot.project_id) {
    projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(snapshot.project_id) || null;
    if (!ownerId && projectRow) ownerId = projectRow.user_id;
  }
  if (!options.allowDeleted && projectRow && isRowDeleted(projectRow)) throw httpError(404, '所属项目已在回收站');
  if (!canAccessOwner(ownerId, user) && !(projectRow && canReadProject(projectRow, user))) throw httpError(403, '无权访问该快照');
  return snapshot;
}
/** 校验知识库条目访问权（回落到所属项目） */
function requireKbAccess(kbId, user, options = {}) {
  const item = kbId ? db.prepare('SELECT * FROM kb_items WHERE id = ?').get(String(kbId)) : null;
  if (!item) throw httpError(404, '知识条目不存在或无权访问');
  if (!options.allowDeleted && isRowDeleted(item)) throw httpError(404, '知识条目已在回收站');
  const project = item.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(item.project_id) : null;
  if (!project) throw httpError(404, '所属项目不存在');
  if (!options.allowDeleted && isRowDeleted(project)) throw httpError(404, '所属项目已在回收站');
  if (!canReadProject(project, user)) throw httpError(403, '无权访问该知识条目');
  return { item, project };
}


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
      const status = Number(e && (e.status || e.statusCode)) || 500;
      const payload = { success: false, error: e.message };
      if (e && e.code) payload.code = e.code;
      return sendJson(res, status, payload);
    }
  });
}

// ------------------------------------------------------------
// 4.0 V5.0 认证接口（登录 / 注册 / 登出 / 当前用户 / 修改密码）
// ------------------------------------------------------------
/** V1.62：登录失败限流（内存；同一 IP+账号 10 分钟窗口最多 10 次） */
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 10;
const loginFailures = new Map();
function loginAttemptKey(req, username) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
  return `${ip}|${String(username || '').toLowerCase()}`;
}
function getLoginFailureState(key) {
  const item = loginFailures.get(key);
  if (!item || item.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return { count: 0, resetAt: 0 };
  }
  return item;
}
function recordLoginFailure(key) {
  const now = Date.now();
  // V1.63：失败记录上限保护，防止长期运行内存无限增长
  if (loginFailures.size > 10000) {
    for (const [k, v] of loginFailures) {
      if (!v || v.resetAt <= now) loginFailures.delete(k);
    }
    if (loginFailures.size > 10000) loginFailures.clear();
  }
  const item = getLoginFailureState(key);
  const next = item.count > 0 ? item : { count: 0, resetAt: now + LOGIN_FAIL_WINDOW_MS };
  next.count += 1;
  loginFailures.set(key, next);
  return next;
}

/** V1.62：启动配置（登录页据此决定是否显示注册入口；公开接口） */
route(['GET'], '/api/auth/config', async (req, res) => {
  return sendJson(res, 200, {
    success: true,
    data: { register_enabled: SELF_REGISTER_ENABLED, lan_mode: LAN_ACCESS, version: APP_VERSION, kb_max_file_mb: KB_MAX_FILE_MB },
  });
});

route(['POST'], '/api/auth/register', async (req, res) => {
  if (!SELF_REGISTER_ENABLED) {
    return sendJson(res, 403, { success: false, code: 'REGISTER_DISABLED', error: '当前已关闭自助注册，请联系管理员创建账号' });
  }
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isValidUsername(username)) {
    return sendJson(res, 400, { success: false, error: '请输入正确的手机号或邮箱作为账号' });
  }
  if (password.length < 6) {
    return sendJson(res, 400, { success: false, error: '密码至少 6 位' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return sendJson(res, 409, { success: false, error: '该账号已注册' });
  const id = 'user-' + crypto.randomUUID().split('-')[0];
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, role, team_id, need_change_password, trial_count, created_at, status, session_version, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, bcrypt.hashSync(password, 10), 'user', '', 0, 0, new Date().toISOString(), 'active', 1, new Date().toISOString());
  } catch (e) {
    return sendJson(res, 409, { success: false, error: '注册失败：账号已存在' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  req.session.regenerate((regenErr) => {
    if (regenErr) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.sv = Number(user.session_version) || 1;
    req.session.save((err) => {
      if (err) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
      logAction(user.id, 'register', 'user', user.id, `username=${user.username}`);
      return sendJson(res, 200, { success: true, user: publicUser(user) });
    });
  });
});

route(['POST'], '/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return sendJson(res, 400, { success: false, error: '请输入账号和密码' });
  const failKey = loginAttemptKey(req, username);
  const failState = getLoginFailureState(failKey);
  if (failState.count >= LOGIN_FAIL_LIMIT) {
    const retrySeconds = Math.max(1, Math.ceil((failState.resetAt - Date.now()) / 1000));
    return sendJson(res, 429, { success: false, code: 'LOGIN_LOCKED', error: `登录失败次数过多，请 ${retrySeconds} 秒后重试` });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(failKey);
    return sendJson(res, 401, { success: false, error: '账号或密码错误' });
  }
  if (String(user.status || 'active') !== 'active') {
    return sendJson(res, 403, { success: false, code: 'ACCOUNT_DISABLED', error: '该账号已被禁用，请联系管理员' });
  }
  loginFailures.delete(failKey);
  try {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  } catch (e) { /* 最后登录时间失败不影响登录 */ }
  req.session.regenerate((regenErr) => {
    if (regenErr) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.sv = Number(user.session_version) || 1;
    req.session.save((err) => {
      if (err) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
      logAction(user.id, 'login', 'user', user.id, `role=${user.role}`);
      return sendJson(res, 200, { success: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    });
  });
});

route(['POST'], '/api/auth/logout', async (req, res) => {
  const user = getSessionUser(req);
  if (user) logAction(user.id, 'logout', 'user', user.id, '');
  req.session.destroy(() => {
    res.clearCookie('newrock.sid');
    return sendJson(res, 200, { success: true, message: '已退出登录' });
  });
});

route(['GET'], '/api/auth/me', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  return sendJson(res, 200, { success: true, user: publicUser(user) });
});

/** V1.62：健康检查（公开接口，供自启/监控探活；只做最小 DB 检查） */
route(['GET'], '/api/health', async (req, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch (e) { dbOk = false; }
  return sendJson(res, dbOk ? 200 : 503, {
    success: dbOk,
    status: dbOk ? 'ok' : 'degraded',
    version: APP_VERSION,
    uptime_s: Math.round(process.uptime()),
    db_ok: dbOk,
    mode: LAN_ACCESS ? 'lan' : 'local',
    port: PORT,
  });
});

route(['POST'], '/api/auth/change-password', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期' });
  const body = req.body || {};
  const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
    return sendJson(res, 400, { success: false, error: '原密码不正确' });
  }
  if (newPassword.length < 6) return sendJson(res, 400, { success: false, error: '新密码至少 6 位' });
  db.prepare('UPDATE users SET password_hash = ?, need_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  logAction(user.id, 'change_password', 'user', user.id, '');
  return sendJson(res, 200, { success: true, message: '密码已修改' });
});

// ------------------------------------------------------------
// 4.0.1 V5.0 团队 / 用户管理 / 审计（阶段一基础能力）
// ------------------------------------------------------------
route(['GET'], '/api/teams', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录' });
  if (user.role === 'superadmin') return sendJson(res, 200, { success: true, data: db.prepare('SELECT * FROM teams ORDER BY created_at ASC').all() });
  const team = user.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(user.team_id) : null;
  return sendJson(res, 200, { success: true, data: team ? [team] : [] });
});

route(['POST'], '/api/teams/create', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user || user.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可创建团队' });
  const name = typeof (req.body || {}).name === 'string' ? req.body.name.trim() : '';
  if (!name) return sendJson(res, 400, { success: false, error: '团队名称不能为空' });
  const id = 'team-' + crypto.randomUUID().split('-')[0];
  db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(id, name, new Date().toISOString());
  logAction(user.id, 'team_create', 'team', id, name);
  sendJson(res, 200, { success: true, id, message: '团队创建成功' });
});

/** V1.62：管理端可见的用户行（含团队名、状态、最后登录、生效功能） */
function toAdminUserRow(row, teamNames) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    team_id: row.team_id || '',
    team_name: teamNames.get(row.team_id || '') || '',
    need_change_password: Number(row.need_change_password) || 0,
    trial_count: Number(row.trial_count) || 0,
    created_at: row.created_at || '',
    last_login_at: row.last_login_at || '',
    status: row.status || 'active',
    features: resolveUserFeatures(row),
    overrides: parseFeatureOverrides(row.feature_overrides),
  };
}

route(['GET'], '/api/admin/users', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user || !['superadmin', 'teamadmin'].includes(user.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const columns = 'id, username, role, team_id, need_change_password, trial_count, created_at, status, last_login_at, feature_overrides';
  let rows;
  if (user.role === 'superadmin') {
    rows = db.prepare(`SELECT ${columns} FROM users ORDER BY created_at ASC`).all();
  } else {
    rows = db.prepare(`SELECT ${columns} FROM users WHERE team_id = ? ORDER BY created_at ASC`).all(user.team_id || '');
  }
  const teamNames = new Map();
  try {
    for (const team of db.prepare('SELECT id, name FROM teams').all()) teamNames.set(team.id, team.name || '');
  } catch (e) { /* ignore */ }
  sendJson(res, 200, { success: true, data: rows.map((row) => toAdminUserRow(row, teamNames)) });
});

/** V1.62：管理员创建账号（局域网模式关闭自助注册后的唯一建号入口） */
route(['POST'], '/api/admin/users/create', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role === 'teamadmin' ? 'teamadmin' : 'user';
  const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
  if (!isValidUsername(username)) return sendJson(res, 400, { success: false, error: '请输入正确的手机号或邮箱作为账号' });
  if (password.length < 6) return sendJson(res, 400, { success: false, error: '密码至少 6 位' });
  if (admin.role === 'teamadmin') {
    if (role !== 'user') return sendJson(res, 403, { success: false, error: '团管只能创建普通用户' });
    if (teamId !== (admin.team_id || '')) return sendJson(res, 403, { success: false, error: '团管只能在本团队创建账号' });
  }
  if (teamId && !db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) {
    return sendJson(res, 404, { success: false, error: '团队不存在' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return sendJson(res, 409, { success: false, error: '该账号已存在' });
  }
  const id = 'user-' + crypto.randomUUID().split('-')[0];
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, role, team_id, need_change_password, trial_count, created_at, status, session_version, last_login_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 1, \'\')')
      .run(id, username, bcrypt.hashSync(password, 10), role, teamId, new Date().toISOString(), 'active');
  } catch (e) {
    return sendJson(res, 409, { success: false, error: '创建失败：账号已存在' });
  }
  logAction(admin.id, 'admin_create_user', 'user', id, `username=${username} role=${role} team=${teamId}`);
  return sendJson(res, 200, { success: true, id, message: '账号已创建，首次登录需修改密码' });
});

/** V1.62：个人功能权限（三态：true/false 覆盖，缺省=跟随角色） */
route(['POST'], '/api/admin/users/features', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.role === 'superadmin') {
    return sendJson(res, 403, { success: false, code: 'SUPERADMIN_LOCKED', error: '超级管理员功能权限永久全开，不可修改' });
  }
  if (admin.role === 'teamadmin' && (target.role !== 'user' || (target.team_id || '') !== (admin.team_id || ''))) {
    return sendJson(res, 403, { success: false, error: '团管只能调整本团队普通用户' });
  }
  const next = {};
  const raw = body.overrides;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of FEATURE_KEYS) {
      if (typeof raw[key] === 'boolean') next[key] = raw[key];
    }
  }
  const stored = Object.keys(next).length ? JSON.stringify(next) : '';
  db.prepare('UPDATE users SET feature_overrides = ? WHERE id = ?').run(stored, target.id);
  logAction(admin.id, 'admin_user_features', 'user', target.id, stored || 'follow-role');
  const fresh = { ...target, feature_overrides: stored };
  return sendJson(res, 200, { success: true, overrides: next, features: resolveUserFeatures(fresh), message: '功能权限已更新' });
});

/** V1.62：启用/禁用账号（禁用即踢下线） */
route(['POST'], '/api/admin/users/status', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const status = body.status === 'disabled' ? 'disabled' : (body.status === 'active' ? 'active' : '');
  if (!status) return sendJson(res, 400, { success: false, error: 'status 必须为 active 或 disabled' });
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.id === admin.id) return sendJson(res, 403, { success: false, error: '不能修改自己的账号状态' });
  if (target.role === 'superadmin') return sendJson(res, 403, { success: false, error: '不能禁用超级管理员账号' });
  if (admin.role === 'teamadmin' && (target.role !== 'user' || (target.team_id || '') !== (admin.team_id || ''))) {
    return sendJson(res, 403, { success: false, error: '团管只能管理本团队普通用户' });
  }
  db.prepare('UPDATE users SET status = ?, session_version = COALESCE(session_version, 1) + 1 WHERE id = ?').run(status, target.id);
  logAction(admin.id, status === 'disabled' ? 'admin_disable_user' : 'admin_enable_user', 'user', target.id, status, status === 'disabled' ? 'Danger' : 'Warn');
  return sendJson(res, 200, { success: true, message: status === 'disabled' ? '账号已禁用，在线会话已失效' : '账号已启用' });
});

/** V1.62：强制下线（仅提升会话版本，不影响密码） */
route(['POST'], '/api/admin/users/kick', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.role === 'superadmin' && target.id !== admin.id) return sendJson(res, 403, { success: false, error: '不能强制下线超级管理员' });
  if (admin.role === 'teamadmin' && (target.role !== 'user' || (target.team_id || '') !== (admin.team_id || ''))) {
    return sendJson(res, 403, { success: false, error: '团管只能管理本团队普通用户' });
  }
  db.prepare('UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = ?').run(target.id);
  logAction(admin.id, 'admin_kick_user', 'user', target.id, '');
  return sendJson(res, 200, { success: true, message: '已强制下线，该账号下次请求需重新登录' });
});

/** V1.63：删除账号（超管；有数据时须显式 force + data_mode） */
route(['POST'], '/api/admin/users/delete', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可删除账号' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.id === admin.id) return sendJson(res, 403, { success: false, error: '不能删除自己的账号' });
  if (target.role === 'superadmin') return sendJson(res, 403, { success: false, error: '不能删除超级管理员账号' });
  const force = body.force === true || body.force === 1 || body.force === '1';
  const dataMode = body.data_mode === 'delete' ? 'delete' : 'transfer';
  const tables = [
    ['companies', '客户/行业'], ['projects', '项目'], ['kb_items', '知识条目'], ['snapshots', '提交记录'],
    ['model_configs', '模型配置'], ['prompt_templates', '提示词模板'],
  ];
  const counts = {};
  let total = 0;
  for (const [table, label] of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE user_id = ?`).get(target.id);
      counts[label] = row ? Number(row.c) || 0 : 0;
      total += counts[label];
    } catch (e) { counts[label] = 0; }
  }
  if (total > 0 && !force) {
    return sendJson(res, 409, {
      success: false,
      code: 'USER_HAS_DATA',
      counts,
      force_allowed: true,
      error: '该账号仍拥有业务数据；可改用「禁用」，或选择强制删除（数据移交给当前超管 / 连同数据进回收站）',
    });
  }
  try {
    if (total === 0) {
      db.transaction(() => {
        db.prepare('DELETE FROM read_grants WHERE (grantee_type = ? AND grantee_id = ?) OR granted_by = ?').run('user', target.id, target.id);
        db.prepare('DELETE FROM project_grants WHERE grantee_user_id = ? OR granted_by = ?').run(target.id, target.id);
        db.prepare('DELETE FROM project_pins WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM company_pins WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM model_configs WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      })();
      logAction(admin.id, 'admin_delete_user', 'user', target.id, `username=${target.username} mode=empty`, 'Danger');
      return sendJson(res, 200, { success: true, message: '账号已删除' });
    }
    if (dataMode === 'transfer') {
      db.transaction(() => {
        for (const table of ['companies', 'projects', 'kb_items', 'snapshots', 'prompt_templates', 'model_configs']) {
          db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(admin.id, target.id);
        }
        db.prepare('UPDATE read_grants SET granted_by = ? WHERE granted_by = ?').run(admin.id, target.id);
        db.prepare('UPDATE project_grants SET granted_by = ? WHERE granted_by = ?').run(admin.id, target.id);
        db.prepare('DELETE FROM read_grants WHERE grantee_type = ? AND grantee_id = ?').run('user', target.id);
        db.prepare('DELETE FROM project_grants WHERE grantee_user_id = ?').run(target.id);
        db.prepare('DELETE FROM project_pins WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM company_pins WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      })();
      logAction(admin.id, 'admin_force_delete_user', 'user', target.id, `username=${target.username} mode=transfer counts=${JSON.stringify(counts)}`, 'Danger');
      return sendJson(res, 200, { success: true, mode: 'transfer', message: `账号已删除，${total} 条业务数据已移交给当前超管` });
    }
    // 连同数据删除：公司与项目按批次进回收站，其余零散 KB/提交记录逐条进回收站
    const companyIds = db.prepare("SELECT id FROM companies WHERE user_id = ? AND COALESCE(deleted_at, '') = ''").all(target.id).map((r) => r.id);
    for (const companyId of companyIds) softDeleteCompany(companyId, admin);
    const projectIds = db.prepare("SELECT id FROM projects WHERE user_id = ? AND COALESCE(deleted_at, '') = ''").all(target.id).map((r) => r.id);
    for (const projectId of projectIds) softDeleteProject(projectId, admin);
    const kbIds = db.prepare("SELECT id FROM kb_items WHERE user_id = ? AND COALESCE(deleted_at, '') = ''").all(target.id).map((r) => r.id);
    for (const kbId of kbIds) softDeleteKbItem(kbId, admin);
    const snapshotIds = db.prepare("SELECT id FROM snapshots WHERE user_id = ? AND COALESCE(deleted_at, '') = ''").all(target.id).map((r) => r.id);
    for (const snapshotId of snapshotIds) softDeleteSnapshot(snapshotId, admin);
    db.transaction(() => {
      db.prepare('DELETE FROM model_configs WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM prompt_templates WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM read_grants WHERE (grantee_type = ? AND grantee_id = ?) OR granted_by = ?').run('user', target.id, target.id);
      db.prepare('DELETE FROM project_grants WHERE grantee_user_id = ? OR granted_by = ?').run(target.id, target.id);
      db.prepare('DELETE FROM project_pins WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM company_pins WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    })();
    logAction(admin.id, 'admin_force_delete_user', 'user', target.id, `username=${target.username} mode=delete counts=${JSON.stringify(counts)}`, 'Danger');
    return sendJson(res, 200, { success: true, mode: 'delete', message: `账号已删除，${total} 条业务数据已移入回收站（30 天内可恢复）` });
  } catch (e) {
    return sendJson(res, 500, { success: false, error: '删除失败：' + e.message });
  }
});

/** V1.63：修改用户角色 / 团队（仅超管；不能改动超管自己） */
route(['POST'], '/api/admin/users/role', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可修改角色' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const role = body.role === 'teamadmin' ? 'teamadmin' : body.role === 'user' ? 'user' : '';
  const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
  if (!role) return sendJson(res, 400, { success: false, error: 'role 必须为 user 或 teamadmin' });
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.id === admin.id) return sendJson(res, 403, { success: false, error: '不能修改自己的角色' });
  if (target.role === 'superadmin') return sendJson(res, 403, { success: false, error: '不能修改超级管理员角色' });
  if (role === 'teamadmin' && !teamId) return sendJson(res, 400, { success: false, error: '团队管理员必须选择所属团队' });
  if (teamId && !db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) return sendJson(res, 404, { success: false, error: '团队不存在' });
  db.prepare('UPDATE users SET role = ?, team_id = ?, session_version = COALESCE(session_version, 1) + 1 WHERE id = ?').run(role, teamId, target.id);
  logAction(admin.id, 'admin_user_role', 'user', target.id, `role=${role} team=${teamId}`, 'Warn');
  return sendJson(res, 200, { success: true, message: `已更新为${role === 'teamadmin' ? '团队管理员' : '普通用户'}，该账号需重新登录` });
});

route(['POST'], '/api/admin/users/reset-password', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const targetId = typeof (req.body || {}).user_id === 'string' ? req.body.user_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (admin.role === 'teamadmin' && (target.role !== 'user' || target.team_id !== (admin.team_id || ''))) {
    return sendJson(res, 403, { success: false, error: '团管只能重置本团队成员密码' });
  }
  if (admin.role === 'superadmin' && target.role === 'superadmin' && target.id !== admin.id) {
    return sendJson(res, 403, { success: false, error: '不能重置其他超管密码' });
  }
  db.prepare('UPDATE users SET password_hash = ?, need_change_password = 1, session_version = COALESCE(session_version, 1) + 1 WHERE id = ?')
    .run(bcrypt.hashSync('123456', 10), target.id);
  logAction(admin.id, 'admin_reset_password', 'user', target.id, 'reset to 123456');
  sendJson(res, 200, { success: true, message: '密码已重置为 123456，该账号在线会话已失效，下次登录需修改密码' });
});

route(['POST'], '/api/admin/users/assign-team', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可分配团队' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (target.role === 'superadmin') return sendJson(res, 403, { success: false, error: '不能修改超级管理员' });
  if (teamId && !db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) return sendJson(res, 404, { success: false, error: '团队不存在' });
  // V1.63：显式角色优先，不再隐式把团队管理员降级为普通用户
  const explicitRole = body.role === 'teamadmin' ? 'teamadmin' : body.role === 'user' ? 'user' : '';
  const nextRole = explicitRole || target.role;
  if (nextRole === 'teamadmin' && !teamId) return sendJson(res, 400, { success: false, error: '团队管理员必须分配团队' });
  db.prepare('UPDATE users SET team_id = ?, role = ?, session_version = COALESCE(session_version, 1) + 1 WHERE id = ?').run(teamId, nextRole, target.id);
  logAction(admin.id, 'assign_team', 'user', target.id, `team=${teamId} role=${nextRole}`, 'Warn');
  sendJson(res, 200, { success: true, message: '团队分配成功' });
});

/** V1.62：读取功能定义与角色默认矩阵（管理端） */
route(['GET'], '/api/admin/features', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  return sendJson(res, 200, { success: true, data: { features: FEATURE_DEFS, matrix: getFeatureMatrix() } });
});

/** V1.62：更新角色默认功能矩阵（仅超管；超管自身永远全开） */
route(['POST'], '/api/admin/features/matrix', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可调整功能矩阵' });
  const raw = (req.body || {}).matrix;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sendJson(res, 400, { success: false, error: 'matrix 必须是对象' });
  const next = JSON.parse(JSON.stringify(DEFAULT_FEATURE_MATRIX));
  for (const role of ['user', 'teamadmin']) {
    for (const key of FEATURE_KEYS) {
      if (raw[role] && typeof raw[role][key] === 'boolean') next[role][key] = raw[role][key];
    }
  }
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('feature_matrix', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  invalidateFeatureMatrixCache();
  logAction(admin.id, 'admin_feature_matrix', 'settings', 'feature_matrix', JSON.stringify(next));
  return sendJson(res, 200, { success: true, matrix: next, message: '角色默认功能权限已保存' });
});

/** V1.62：备份列表 / 立即备份（仅超管） */
route(['GET'], '/api/admin/backups', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可查看备份' });
  return sendJson(res, 200, { success: true, data: listBackupFiles(50) });
});

route(['POST'], '/api/admin/backups/run', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可手动备份' });
  try {
    const file = await createDatabaseBackup('auto');
    logAction(admin.id, 'admin_backup_run', 'backup', file, 'manual');
    return sendJson(res, 200, { success: true, file: path.basename(file), message: '备份已完成' });
  } catch (e) {
    console.error('[backup] 手动备份失败:', e.message);
    return sendJson(res, 500, { success: false, error: '备份失败：' + e.message });
  }
});

route(['GET'], '/api/admin/audit-logs', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可查看审计日志' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const level = String(req.query.level || '').trim();
  const action = String(req.query.action || '').trim();
  const usernames = new Map();
  try {
    for (const u of db.prepare('SELECT id, username, role FROM users').all()) usernames.set(u.id, u);
  } catch (e) { /* ignore */ }
  let where = [];
  let params = [];
  if (['Info', 'Warn', 'Danger'].includes(level)) { where.push('level = ?'); params.push(level); }
  if (action) { where.push('action = ?'); params.push(action); }
  const sql = 'SELECT * FROM audit_logs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY rowid DESC LIMIT ?';
  const rows = db.prepare(sql).all(...params, limit).map((r) => ({
    ...r,
    level: r.level || 'Info',
    ip: r.ip || '',
    username: (usernames.get(r.user_id) && usernames.get(r.user_id).username) || r.user_id || '',
  }));
  sendJson(res, 200, { success: true, data: rows });
});

// ------------------------------------------------------------
// 4.1 语境接口
// ------------------------------------------------------------

// ---------- V1.63：LLM 用量 / 成本汇总（管理员；团管按团队） ----------
route(['GET'], '/api/admin/usage/summary', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const ids = visibleOwnerIds(admin);
  const selectSql = 'SELECT user_id, project_id, provider, model_name, purpose, status, prompt_tokens, completion_tokens, total_tokens, created_at FROM llm_usage WHERE created_at >= ?';
  let rows = [];
  if (ids === null) {
    rows = db.prepare(selectSql + ' ORDER BY rowid DESC LIMIT 100000').all(from);
  } else if (ids.length > 0) {
    rows = db.prepare(selectSql + ` AND user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid DESC LIMIT 100000`).all(from, ...ids);
  }
  // 模型单价（同名列取较高单价，避免不同用户配置差异导致失真）
  const priceMap = new Map();
  try {
    for (const row of db.prepare('SELECT model_name, price_input_per_m, price_output_per_m FROM model_configs').all()) {
      const key = String(row.model_name || '');
      const next = { input: Number(row.price_input_per_m) || 0, output: Number(row.price_output_per_m) || 0 };
      const prev = priceMap.get(key);
      if (!prev || next.input + next.output >= prev.input + prev.output) priceMap.set(key, next);
    }
  } catch (e) { /* ignore */ }
  const usernames = new Map();
  try {
    for (const u of db.prepare('SELECT id, username FROM users').all()) usernames.set(u.id, u.username || '');
  } catch (e) { /* ignore */ }
  const emptyAgg = () => ({ requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, est_cost: 0 });
  const totals = emptyAgg();
  const byModel = new Map();
  const byUser = new Map();
  const byDay = new Map();
  const byPurpose = new Map();
  let errorRequests = 0;
  const addTo = (target, prompt, completion, total, cost, isError) => {
    target.requests += 1;
    target.prompt_tokens += prompt;
    target.completion_tokens += completion;
    target.total_tokens += total;
    target.est_cost += cost;
    if (isError) target.errors = (target.errors || 0) + 1;
  };
  for (const row of rows) {
    const prompt = Math.max(0, Number(row.prompt_tokens) || 0);
    const completion = Math.max(0, Number(row.completion_tokens) || 0);
    const total = Math.max(0, Number(row.total_tokens) || (prompt + completion));
    const price = priceMap.get(String(row.model_name || '')) || { input: 0, output: 0 };
    const cost = (prompt * price.input + completion * price.output) / 1000000;
    const isError = String(row.status || '') === 'error';
    if (isError) errorRequests += 1;
    addTo(totals, prompt, completion, total, cost, isError);
    const modelKey = String(row.model_name || '(未记录)') + '|' + String(row.provider || '');
    if (!byModel.has(modelKey)) byModel.set(modelKey, { model_name: row.model_name || '', provider: row.provider || '', ...emptyAgg() });
    addTo(byModel.get(modelKey), prompt, completion, total, cost, isError);
    const userKey = String(row.user_id || '');
    if (!byUser.has(userKey)) byUser.set(userKey, { user_id: userKey, username: usernames.get(userKey) || (userKey ? userKey : '(未知)'), ...emptyAgg() });
    addTo(byUser.get(userKey), prompt, completion, total, cost, isError);
    const dayKey = String(row.created_at || '').slice(0, 10) || '(未知)';
    if (!byDay.has(dayKey)) byDay.set(dayKey, { date: dayKey, ...emptyAgg() });
    addTo(byDay.get(dayKey), prompt, completion, total, cost, isError);
    const purposeKey = String(row.purpose || 'chat');
    if (!byPurpose.has(purposeKey)) byPurpose.set(purposeKey, { purpose: purposeKey, ...emptyAgg() });
    addTo(byPurpose.get(purposeKey), prompt, completion, total, cost, isError);
  }
  const roundCost = (value) => Math.round(value * 1000000) / 1000000;
  const finalize = (item) => ({ ...item, est_cost: roundCost(item.est_cost) });
  sendJson(res, 200, {
    success: true,
    data: {
      range: { days, from },
      totals: { ...finalize(totals), error_requests: errorRequests },
      by_model: [...byModel.values()].map(finalize).sort((a, b) => b.total_tokens - a.total_tokens),
      by_user: [...byUser.values()].map(finalize).sort((a, b) => b.total_tokens - a.total_tokens),
      by_day: [...byDay.values()].map(finalize).sort((a, b) => String(a.date).localeCompare(String(b.date))),
      by_purpose: [...byPurpose.values()].map(finalize).sort((a, b) => b.total_tokens - a.total_tokens),
    },
  });
});

route(['GET'], '/api/context/get', async (req, res) => {
  const projectId = String(req.query.project_id || (req.body && req.body.project_id) || '');
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, currentSessionUser(req));
  sendJson(res, 200, { success: true, data: readProjectContext(projectId) });
});

route(['POST'], '/api/context/save', async (req, res) => {
  const body = req.body || {};
  const projectId = body.project_id || req.query.project_id || '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  const user = currentSessionUser(req);
  requireProjectWritable(projectId, user);
  const context = normalizeContext(body.context_data);
  const info = db.prepare('UPDATE projects SET context_json = ? WHERE id = ?').run(JSON.stringify(context), projectId);
  logAction(user.id, 'context_save', 'project', projectId, '');
  sendJson(res, 200, { success: true, updated: info.changes > 0, data: context });
});

route(['POST'], '/api/context/extract', async (req, res) => {
  const body = req.body || {};
  const projectId = body.project_id || req.query.project_id || '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, currentSessionUser(req));

  const rows = db.prepare("SELECT question, answer FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").all(projectId);
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
  ], 'context_extract');
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

/**
 * v1.61：Markdown 本地切片（纯 Node.js 算法，不调用大模型）
 * 入参：{ raw_text }；出参：{ success, data: [{ question, answer }] }
 * 与旧 /api/kb/parse（LLM 提取）并存，供前端按文件类型/场景选择。
 */
route(['POST'], '/api/kb/parse-markdown', (req, res) => {
  const body = req.body || {};
  if (typeof body.raw_text !== 'string' || !body.raw_text.trim()) {
    return sendJson(res, 400, { success: false, error: '文本不能为空' });
  }
  try {
    const pairs = parseMarkdownChunks(body.raw_text);
    sendJson(res, 200, { success: true, data: pairs, count: pairs.length });
  } catch (e) {
    sendJson(res, 500, { success: false, error: `Markdown 切片失败：${e.message}` });
  }
});

/**
 * v1.60：多格式文档纯文本提取（不依赖 LLM，仅做格式解析）
 * 入参：{ file_name, file_base64 }；出参：{ success, raw_text }
 */
route(['POST'], '/api/kb/extract-text', async (req, res) => {
  const body = req.body || {};
  const fileName = typeof body.file_name === 'string' ? body.file_name : '';
  const base64 = typeof body.file_base64 === 'string' ? body.file_base64 : '';
  if (!base64) return sendJson(res, 400, { success: false, error: '缺少文件内容（file_base64）' });
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (e) {
    return sendJson(res, 400, { success: false, error: '文件 Base64 解码失败' });
  }
  if (buffer.length > KB_MAX_FILE_MB * 1024 * 1024) {
    return sendJson(res, 413, { success: false, code: 'FILE_TOO_LARGE', error: `文件超过 ${KB_MAX_FILE_MB}MB 上限，请拆分后再导入` });
  }
  try {
    const rawText = await extractTextFromDocument(fileName, buffer);
    sendJson(res, 200, { success: true, raw_text: rawText });
  } catch (e) {
    sendJson(res, 400, { success: false, error: e.message });
  }
});

/**
 * v1.60：知识库导出（.txt / .md，带 BOM）
 * GET /api/kb/export?project_id=&format=txt|md
 */
route(['GET'], '/api/kb/export', async (req, res) => {
  const projectId = req.query.project_id || '';
  const format = String(req.query.format || 'txt');
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, currentSessionUser(req));
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
  const rows = db.prepare("SELECT id, question, answer FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all(projectId);
  let text;
  if (format === 'md') {
    const lines = [`# 知识库导出 - ${project ? project.name : projectId}`, `> 共 ${rows.length} 条，导出时间 ${new Date().toLocaleString('zh-CN')}`, ''];
    rows.forEach((r, i) => {
      lines.push(`## Q${i + 1}：${r.question || ''}`, '', r.answer || '', '');
    });
    text = lines.join('\n');
  } else {
    const lines = [`知识库导出 - ${project ? project.name : projectId}`, `共 ${rows.length} 条 | 导出时间 ${new Date().toLocaleString('zh-CN')}`, ''];
    rows.forEach((r, i) => {
      lines.push(`Q${i + 1}：${r.question || ''}`, `A：${r.answer || ''}`, '');
    });
    text = lines.join('\n');
  }
  buildExportResponse(res, text, format, `知识库-${project ? project.name : projectId}`);
});

route(['POST'], '/api/kb/save', async (req, res) => {
  const { project_id, pairs } = req.body || {};
  if (!project_id) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  if (!Array.isArray(pairs)) return sendJson(res, 400, { success: false, error: 'pairs 必须是数组' });
  const user = currentSessionUser(req);
  const project = requireProjectWritable(project_id, user);
  const ownerId = project.user_id || user.id;
  const insertItem = db.prepare('INSERT INTO kb_items (id, project_id, question, answer, user_id, structure_mode) VALUES (?, ?, ?, ?, ?, ?)');
  const insertVer = db.prepare('INSERT INTO kb_item_versions (id, item_id, version_hash, content, is_deleted, user_id) VALUES (?, ?, ?, ?, 0, ?)');
  db.transaction(() => {
    for (const pair of pairs) {
      const itemId = 'kb-' + crypto.randomUUID().split('-')[0];
      const versionId = 'v-' + crypto.randomUUID().split('-')[0];
      const contentStr = JSON.stringify(pair);
      const hash = crypto.createHash('md5').update(contentStr).digest('hex');
      const mode = pair.structure_mode === 'raw' ? 'raw' : 'qa';
      insertItem.run(itemId, project_id, pair.question, pair.answer, ownerId, mode);
      insertVer.run(versionId, itemId, hash, contentStr, ownerId);
    }
  })();
  logAction(user.id, 'kb_save', 'project', project_id, `count=${pairs.length}`);
  sendJson(res, 200, { success: true, message: `已成功入库 ${pairs.length} 条` });
});

route(['GET'], '/api/kb/list', async (req, res) => {
  const projectId = req.query.project_id || '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, currentSessionUser(req));
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));
  const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where = ["project_id = ?", "COALESCE(deleted_at, '') = ''"];
  const params = [String(projectId)];
  if (keyword) {
    const escaped = keyword.replace(/[\\%_]/g, (ch) => '\\' + ch);
    where.push("(question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')");
    params.push('%' + escaped + '%', '%' + escaped + '%');
  }
  const whereSql = where.join(' AND ');
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM kb_items WHERE ${whereSql}`).get(...params);
  const total = totalRow ? Number(totalRow.c) || 0 : 0;
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`SELECT id, question, answer, structure_mode FROM kb_items WHERE ${whereSql} ORDER BY rowid ASC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  sendJson(res, 200, { success: true, data: rows, total, page, page_size: pageSize });
});

route(['POST'], '/api/kb/delete', async (req, res) => {
  const body = req.body || {};
  if (!body.id) return sendJson(res, 400, { error: '缺少 ID' });
  const user = currentSessionUser(req);
  const kbAccess = requireKbAccess(body.id, user);
  assertProjectWritableByRow(kbAccess.project, user);
  const result = softDeleteKbItem(body.id, user);
  logAction(user.id, 'kb_delete', 'kb', body.id, `batch=${result.batch} soft=1`);
  sendJson(res, 200, { success: true, message: '已移入回收站（30 天内可恢复）', batch: result.batch });
});

// 知识库在线编辑（阶段四）：更新 question / answer，并写入新版本记录
route(['POST'], '/api/kb/update', async (req, res) => {
  const body = req.body || {};
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!question || !answer) return sendJson(res, 400, { success: false, error: 'question 和 answer 必须是非空字符串' });

  const kbUser = currentSessionUser(req);
  const kbAccess = requireKbAccess(id, kbUser);
  assertProjectWritableByRow(kbAccess.project, kbUser);
  const existing = db.prepare('SELECT id FROM kb_items WHERE id = ?').get(id);
  if (!existing) return sendJson(res, 404, { success: false, error: '知识条目不存在' });

  db.transaction(() => {
    db.prepare('UPDATE kb_items SET question = ?, answer = ? WHERE id = ?').run(question, answer, id);
    const contentStr = JSON.stringify({ question, answer });
    const versionHash = crypto.createHash('md5').update(contentStr).digest('hex');
    db.prepare('INSERT INTO kb_item_versions (id, item_id, version_hash, content, is_deleted) VALUES (?, ?, ?, ?, 0)')
      .run('v-' + crypto.randomUUID().split('-')[0], id, versionHash, contentStr);
  })();
  logAction(kbUser.id, 'kb_update', 'kb', id, question.slice(0, 120));

  sendJson(res, 200, { success: true, message: '更新成功' });
});

// ------------------------------------------------------------
// 4.3 快照接口
// ------------------------------------------------------------

route(['POST'], '/api/snapshots/create', async (req, res) => {
  const { project_id, layers, context_data, remark } = req.body || {};
  if (!project_id || typeof project_id !== 'string') return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  // 权限校验优先于 body 校验：越权请求必须优先 403（QA F2 修复）
  const snapshotUser = currentSessionUser(req);
  requireProjectWritable(project_id, snapshotUser);
  if (!Array.isArray(layers)) return sendJson(res, 400, { success: false, error: 'layers 必须是数组' });

  // v1.60：版本备注，统一转字符串并 trim，超长截断，防止异常输入
  const snapshotRemark = typeof remark === 'string' ? remark.trim().slice(0,200) : '';

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
  // V1.63：eval_pass / eval_score 口径保持不变（1 / 5.0），仅额外关联同版提示词的最近评测记录
  db.prepare('INSERT INTO snapshots (id, project_id, module_versions_json, final_prompt_content, created_at, eval_pass, eval_score, user_id, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(snapshotId, project_id, JSON.stringify(layers), prompt, now, 1, 5.0, snapshotUser.id, snapshotRemark);
  let linkedEvalRunId = '';
  try {
    const promptHash = sha256Hex(prompt);
    const matchedRun = db.prepare('SELECT id FROM eval_runs WHERE project_id = ? AND prompt_hash = ? ORDER BY rowid DESC LIMIT 1').get(project_id, promptHash);
    if (matchedRun) {
      linkedEvalRunId = matchedRun.id;
      db.prepare('UPDATE snapshots SET eval_run_id = ? WHERE id = ?').run(linkedEvalRunId, snapshotId);
    }
  } catch (e) {
    console.warn('[v1.63] 评测记录关联失败（不影响提交）:', e.message);
  }

  sendJson(res, 200, {
    success: true,
    snapshot_id: snapshotId,
    final_prompt: prompt,
    context_applied: contextToReplacements(context),
    eval_run_id: linkedEvalRunId,
    message: '快照成功存入',
  });
});

route(['GET'], '/api/snapshots/list', async (req, res) => {
  if (!req.query.project_id) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(req.query.project_id, currentSessionUser(req));
  const rows = db.prepare("SELECT id, created_at, eval_pass, eval_score, remark FROM snapshots WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY created_at DESC").all(req.query.project_id);
  sendJson(res, 200, { success: true, data: rows });
});

route(['GET'], '/api/snapshots/detail', async (req, res) => {
  const body = req.body || {};
  const id = req.query.id || body.id;
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  requireSnapshotAccess(id, currentSessionUser(req));
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

route(['POST'], '/api/snapshots/delete', async (req, res) => {
  const { id } = req.body || {};
  if (!id || typeof id !== 'string') return sendJson(res, 400, { success: false, error: '缺少 id' });
  const delUser = currentSessionUser(req);
  // 先确认快照存在且当前用户有访问权（requireSnapshotAccess 返回快照行）
  const snapshot = requireSnapshotAccess(id, delUser);
  // 再确认其所属项目可写（公共只读项目禁止删除）
  if (snapshot.project_id) requireProjectWritable(snapshot.project_id, delUser);
  const result = softDeleteSnapshot(id, delUser);
  logAction(delUser.id, 'snapshot_delete', 'snapshot', id, `batch=${result.batch} soft=1`);
  sendJson(res, 200, { success: true, deleted: 1, id, batch: result.batch, message: '已移入回收站（30 天内可恢复）' });
});

route(['POST'], '/api/prompt/assemble', async (req, res) => {
  const { project_id, layers, context_data } = req.body || {};
  if (!Array.isArray(layers)) return sendJson(res, 400, { success: false, error: 'layers 必须是数组' });
  if (project_id) requireProjectAccess(project_id, currentSessionUser(req));

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
  requireProjectAccess(projectId, currentSessionUser(req));

  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
  if (!project) return sendJson(res, 404, { success: false, error: '项目不存在' });

  const snapshots = db.prepare("SELECT id, created_at, eval_pass, eval_score, final_prompt_content FROM snapshots WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY created_at ASC").all(projectId);
  if (snapshots.length === 0) return sendJson(res, 404, { success: false, error: '该项目暂无提交记录可导出' });

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

// ============================================================
// V1.63：回收站（软删除）辅助
// ============================================================
function recycleRetentionDays() {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'recycle_retention_days'").get();
    const days = Number(row && row.value);
    if (Number.isFinite(days) && days >= 1 && days <= 365) return Math.floor(days);
  } catch (e) { /* ignore */ }
  return 30;
}
function recycleExpireAt(deletedAt) {
  const days = recycleRetentionDays();
  const time = Date.parse(String(deletedAt || ''));
  if (!Number.isFinite(time)) return '';
  return new Date(time + days * 86400000).toISOString();
}
function softDeleteCompany(companyId, user) {
  const batch = 'del-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  let projectCount = 0;
  db.transaction(() => {
    const projectIds = db.prepare("SELECT id FROM projects WHERE company_id = ? AND COALESCE(deleted_at, '') = ''").all(companyId).map((r) => r.id);
    projectCount = projectIds.length;
    for (const pid of projectIds) {
      db.prepare("UPDATE projects SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE id = ?").run(now, user.id, batch, pid);
      db.prepare("UPDATE kb_items SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").run(now, user.id, batch, pid);
      db.prepare("UPDATE snapshots SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").run(now, user.id, batch, pid);
      db.prepare('DELETE FROM project_pins WHERE project_id = ?').run(pid);
    }
    db.prepare("UPDATE companies SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE id = ?").run(now, user.id, batch, companyId);
  })();
  return { batch, projects: projectCount };
}
function softDeleteProject(projectId, user) {
  const batch = 'del-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  let kbCount = 0;
  let snapshotCount = 0;
  db.transaction(() => {
    kbCount = db.prepare("UPDATE kb_items SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").run(now, user.id, batch, projectId).changes;
    snapshotCount = db.prepare("UPDATE snapshots SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").run(now, user.id, batch, projectId).changes;
    db.prepare("UPDATE projects SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE id = ?").run(now, user.id, batch, projectId);
    db.prepare('DELETE FROM project_pins WHERE project_id = ?').run(projectId);
  })();
  return { batch, kb: kbCount, snapshots: snapshotCount };
}
function softDeleteKbItem(itemId, user) {
  const batch = 'del-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE kb_items SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE id = ?").run(now, user.id, batch, itemId);
    db.prepare('UPDATE kb_item_versions SET is_deleted = 1 WHERE item_id = ?').run(itemId);
  })();
  return { batch };
}
function softDeleteSnapshot(snapshotId, user) {
  const batch = 'del-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  db.prepare("UPDATE snapshots SET deleted_at = ?, deleted_by = ?, deleted_batch = ? WHERE id = ?").run(now, user.id, batch, snapshotId);
  return { batch };
}
const RECYCLE_TYPE_TABLE = { company: 'companies', project: 'projects', kb: 'kb_items', snapshot: 'snapshots' };
const RECYCLE_TABLE_TYPE = { companies: 'company', projects: 'project', kb_items: 'kb', snapshots: 'snapshot' };
function recycleUserExists(userId) {
  if (!userId) return false;
  try { return !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId); } catch (e) { return false; }
}
/** 原所有者账号已被删除时，恢复/移交的归属改为执行操作的管理员 */
function recycleOwnerFor(row, actor) {
  return recycleUserExists(row && row.user_id) ? row.user_id : actor.id;
}
function restoreRecycleEntity(type, id, user) {
  const table = RECYCLE_TYPE_TABLE[type];
  if (!table) throw httpError(400, '未知的回收站类型');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw httpError(404, '记录不存在或已彻底删除');
  if (!isRowDeleted(row)) throw httpError(409, '该记录不在回收站');
  const batch = String(row.deleted_batch || '');
  const ownerId = recycleOwnerFor(row, user);
  const restore = db.prepare(`UPDATE ${table} SET deleted_at = '', deleted_by = '', deleted_batch = '' WHERE id = ?`);
  if (type === 'company') {
    db.transaction(() => {
      db.prepare("UPDATE companies SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE id = ?").run(ownerId, id);
      db.prepare("UPDATE projects SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE company_id = ? AND deleted_batch = ?").run(ownerId, id, batch);
      db.prepare("UPDATE kb_items SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE deleted_batch = ? AND project_id IN (SELECT id FROM projects WHERE company_id = ?)").run(ownerId, batch, id);
      db.prepare("UPDATE snapshots SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE deleted_batch = ? AND project_id IN (SELECT id FROM projects WHERE company_id = ?)").run(ownerId, batch, id);
    })();
    return { type, id, restored_children: batch ? 'batch' : 'self' };
  }
  if (type === 'project') {
    const company = row.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(row.company_id) : null;
    if (company && isRowDeleted(company)) throw httpError(409, '所属客户/行业仍在回收站，请先恢复客户/行业');
    db.transaction(() => {
      db.prepare("UPDATE projects SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE id = ?").run(ownerId, id);
      db.prepare("UPDATE kb_items SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE project_id = ? AND deleted_batch = ?").run(ownerId, id, batch);
      db.prepare("UPDATE snapshots SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE project_id = ? AND deleted_batch = ?").run(ownerId, id, batch);
    })();
    return { type, id, restored_children: batch ? 'batch' : 'self' };
  }
  if (type === 'kb') {
    const project = row.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) : null;
    if (project && isRowDeleted(project)) throw httpError(409, '所属项目仍在回收站，请先恢复项目');
    db.prepare(`UPDATE ${table} SET deleted_at = '', deleted_by = '', deleted_batch = '', user_id = ? WHERE id = ?`).run(ownerId, id);
    db.prepare('UPDATE kb_item_versions SET is_deleted = 0 WHERE item_id = ? AND version_hash = (SELECT version_hash FROM kb_item_versions WHERE item_id = ? ORDER BY rowid DESC LIMIT 1)').run(id, id);
    return { type, id, restored_children: 'self' };
  }
  const project = row.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) : null;
  if (project && isRowDeleted(project)) throw httpError(409, '所属项目仍在回收站，请先恢复项目');
  restore.run(id);
  return { type, id, restored_children: 'self' };
}
function purgeRecycleEntityByTable(table, id) {
  if (table === 'snapshots') {
    db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
    return true;
  }
  if (table === 'kb_items') {
    db.prepare('DELETE FROM kb_item_versions WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM kb_items WHERE id = ?').run(id);
    return true;
  }
  if (table === 'projects') {
    db.transaction(() => {
      const kbIds = db.prepare('SELECT id FROM kb_items WHERE project_id = ?').all(id).map((r) => r.id);
      for (const kbId of kbIds) db.prepare('DELETE FROM kb_item_versions WHERE item_id = ?').run(kbId);
      db.prepare('DELETE FROM kb_items WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM read_grants WHERE scope_type = ? AND scope_id = ?').run('project', id);
      db.prepare('DELETE FROM project_grants WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_pins WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
    return true;
  }
  if (table === 'companies') {
    db.transaction(() => {
      const projectIds = db.prepare('SELECT id FROM projects WHERE company_id = ?').all(id).map((r) => r.id);
      for (const pid of projectIds) purgeRecycleEntityByTable('projects', pid);
      db.prepare('DELETE FROM read_grants WHERE scope_type = ? AND scope_id = ?').run('company', id);
      db.prepare('DELETE FROM company_pins WHERE company_id = ?').run(id);
      db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    })();
    return true;
  }
  return false;
}
function purgeRecycleEntity(type, id) {
  const table = RECYCLE_TYPE_TABLE[type];
  if (!table) throw httpError(400, '未知的回收站类型');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw httpError(404, '记录不存在或已彻底删除');
  if (!isRowDeleted(row)) throw httpError(409, '只能彻底删除回收站中的记录');
  purgeRecycleEntityByTable(table, id);
}
/** 串行清理过期回收站（严禁 Promise.all；SQLite 删除逐条事务） */
function purgeExpiredRecycle() {
  const cutoff = new Date(Date.now() - recycleRetentionDays() * 86400000).toISOString();
  const targets = [];
  for (const table of ['snapshots', 'kb_items', 'projects', 'companies']) {
    try {
      const rows = db.prepare(`SELECT id FROM ${table} WHERE COALESCE(deleted_at, '') <> '' AND deleted_at < ?`).all(cutoff);
      for (const row of rows) targets.push([table, row.id]);
    } catch (e) { /* ignore */ }
  }
  let purged = 0;
  for (const [table, id] of targets) {
    try {
      if (purgeRecycleEntityByTable(table, id)) purged += 1;
    } catch (e) {
      console.warn('[recycle] 清理过期记录失败:', table, id, e.message);
    }
  }
  if (purged > 0) console.log(`[recycle] 已自动清理 ${purged} 条过期回收站记录（保留 ${recycleRetentionDays()} 天）`);
  return purged;
}
function recycleTypeName(item) {
  if (item.type === 'company') return item.name || item.id;
  if (item.type === 'project') return item.name || item.id;
  if (item.type === 'kb') return (item.question || '').slice(0, 80) || item.id;
  return item.remark || item.id;
}
function listRecycleItems(user, typeFilter, page, pageSize) {
  const ids = visibleOwnerIds(user);
  const ownerSet = ids === null ? null : new Set(ids);
  const items = [];
  const pushRow = (type, row, extra) => {
    if (ownerSet && !ownerSet.has(String(row.user_id || ''))) return;
    items.push({
      type,
      id: row.id,
      name: recycleTypeName({ ...row, type }),
      deleted_at: row.deleted_at || '',
      deleted_by: row.deleted_by || '',
      expire_at: recycleExpireAt(row.deleted_at),
      ...extra,
    });
  };
  if (typeFilter === 'all' || typeFilter === 'company') {
    for (const row of db.prepare("SELECT * FROM companies WHERE COALESCE(deleted_at, '') <> ''").all()) pushRow('company', row, {});
  }
  if (typeFilter === 'all' || typeFilter === 'project') {
    for (const row of db.prepare("SELECT * FROM projects WHERE COALESCE(deleted_at, '') <> ''").all()) {
      const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(row.company_id);
      pushRow('project', row, { company_name: company ? company.name : '' });
    }
  }
  if (typeFilter === 'all' || typeFilter === 'kb') {
    for (const row of db.prepare("SELECT * FROM kb_items WHERE COALESCE(deleted_at, '') <> ''").all()) {
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id);
      pushRow('kb', row, { project_name: project ? project.name : '' });
    }
  }
  if (typeFilter === 'all' || typeFilter === 'snapshot') {
    for (const row of db.prepare("SELECT * FROM snapshots WHERE COALESCE(deleted_at, '') <> ''").all()) {
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id);
      pushRow('snapshot', row, { project_name: project ? project.name : '' });
    }
  }
  items.sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, page_size: pageSize, retention_days: recycleRetentionDays() };
}

route(['GET'], '/api/companies', async (req, res) => {
  const user = currentSessionUser(req);
  const companies = db.prepare("SELECT * FROM companies WHERE COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all();
  // 可见性统一走 canReadProject（含所有者 / 公共 / 客户级与项目级只读授权）
  const visibleProjects = db.prepare("SELECT * FROM projects WHERE COALESCE(deleted_at, '') = ''").all().filter((project) => canReadProject(project, user));
  const visible = companies.filter((company) => canAccessOwner(company.user_id, user) || visibleProjects.some((project) => String(project.company_id || '') === company.id));
  // V1.63：公司置顶按用户隔离
  const pinnedSet = new Set();
  try {
    for (const row of db.prepare('SELECT company_id FROM company_pins WHERE user_id = ?').all(user.id)) pinnedSet.add(row.company_id);
  } catch (e) { /* ignore */ }
  sendJson(res, 200, { success: true, data: visible.map((company) => ({ ...company, pinned: pinnedSet.has(company.id) ? 1 : 0 })) });
});

route(['POST'], '/api/companies/create', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendJson(res, 400, { success: false, error: '名称不能为空' });
  const id = 'comp-' + crypto.randomUUID().split('-')[0];
  db.prepare('INSERT INTO companies (id, name, category, user_id) VALUES (?, ?, ?, ?)').run(id, name, '默认', user.id);
  logAction(user.id, 'company_create', 'company', id, name);
  sendJson(res, 200, { success: true, id, message: '创建成功' });
});

route(['POST'], '/api/companies/update', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  requireCompanyAccess(body.id, user);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendJson(res, 400, { success: false, error: '名称不能为空' });
  db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, body.id);
  logAction(user.id, 'company_update', 'company', body.id, name);
  sendJson(res, 200, { success: true, message: '修改成功' });
});

route(['POST'], '/api/companies/delete', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  requireCompanyAccess(body.id, user);
  const result = softDeleteCompany(body.id, user);
  logAction(user.id, 'company_delete', 'company', body.id, `batch=${result.batch} projects=${result.projects} soft=1`);
  sendJson(res, 200, { success: true, message: '已移入回收站（30 天内可恢复）', batch: result.batch, projects: result.projects });
});

/** V1.62：给项目行补充 pinned / can_write（前端只读模式与置顶分区依赖这两个字段） */
function decorateProjectsForUser(rows, user) {
  const pinned = new Set();
  try {
    for (const row of db.prepare('SELECT project_id FROM project_pins WHERE user_id = ?').all(user.id)) pinned.add(row.project_id);
  } catch (e) { /* ignore */ }
  return rows.map((row) => {
    const isPublic = Number(row.is_public) === 1;
    const canWrite = canAccessOwner(row.user_id, user) && (!isPublic || user.role === 'superadmin');
    return { ...row, pinned: pinned.has(row.id) ? 1 : 0, can_write: canWrite ? 1 : 0 };
  });
}

route(['GET'], '/api/projects', async (req, res) => {
  const user = currentSessionUser(req);
  const rows = db.prepare("SELECT * FROM projects WHERE COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all().filter((project) => canReadProject(project, user));
  sendJson(res, 200, { success: true, data: decorateProjectsForUser(rows, user) });
});

route(['POST'], '/api/projects/create', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendJson(res, 400, { success: false, error: '项目名称不能为空' });
  const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
  if (companyId) requireCompanyAccess(companyId, user);
  const id = 'proj-' + crypto.randomUUID().split('-')[0];
  db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id, user_id) VALUES (?, ?, ?, ?, ?)').run(id, companyId, name, '', user.id);
  logAction(user.id, 'project_create', 'project', id, name);
  sendJson(res, 200, { success: true, id, message: '创建成功' });
});

route(['POST'], '/api/projects/update', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  requireProjectWritable(body.id, user);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return sendJson(res, 400, { success: false, error: '名称不能为空' });
  if (body.is_public !== undefined && ['superadmin', 'teamadmin'].includes(user.role)) {
    const isPublic = body.is_public === true || body.is_public === 1 || body.is_public === '1' ? 1 : 0;
    const scope = typeof body.public_scope === 'string' && body.public_scope.trim() ? body.public_scope.trim() : 'global';
    db.prepare('UPDATE projects SET name = ?, is_public = ?, public_scope = ? WHERE id = ?').run(name, isPublic, scope, body.id);
  } else {
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, body.id);
  }
  logAction(user.id, 'project_update', 'project', body.id, name);
  sendJson(res, 200, { success: true, message: '修改成功' });
});

route(['POST'], '/api/projects/delete', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  requireProjectWritable(body.id, user);
  const result = softDeleteProject(body.id, user);
  logAction(user.id, 'project_delete', 'project', body.id, `batch=${result.batch} kb=${result.kb} snapshots=${result.snapshots} soft=1`);
  sendJson(res, 200, { success: true, message: '已移入回收站（30 天内可恢复）', batch: result.batch, kb: result.kb, snapshots: result.snapshots });
});

// ---------- V1.63：回收站（仅管理员） ----------
function requireRecycleManager(user) {
  if (!user || !['superadmin', 'teamadmin'].includes(user.role)) throw httpError(403, '需要管理权限');
  return user;
}
function requireRecycleRecord(user, type, id) {
  const table = RECYCLE_TYPE_TABLE[type];
  if (!table) throw httpError(400, '未知的回收站类型');
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw httpError(404, '记录不存在或已彻底删除');
  if (user.role !== 'superadmin') {
    let ownerId = row.user_id;
    if (!ownerId && row.project_id) {
      const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(row.project_id);
      ownerId = project ? project.user_id : '';
    }
    if (!canAccessOwner(ownerId, user)) throw httpError(403, '无权管理该记录');
  }
  return row;
}
route(['GET'], '/api/recycle/list', async (req, res) => {
  const user = requireRecycleManager(currentSessionUser(req));
  const type = ['all', 'company', 'project', 'kb', 'snapshot'].includes(String(req.query.type || 'all')) ? String(req.query.type || 'all') : 'all';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20));
  const data = listRecycleItems(user, type, page, pageSize);
  sendJson(res, 200, { success: true, data: data.items, total: data.total, page: data.page, page_size: data.page_size, retention_days: data.retention_days });
});
route(['POST'], '/api/recycle/restore', async (req, res) => {
  const user = requireRecycleManager(currentSessionUser(req));
  const body = req.body || {};
  const type = String(body.type || '');
  const id = String(body.id || '').trim();
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  requireRecycleRecord(user, type, id);
  const result = restoreRecycleEntity(type, id, user);
  logAction(user.id, 'recycle_restore', type, id, 'Warn');
  sendJson(res, 200, { success: true, message: '已从回收站恢复', ...result });
});
route(['POST'], '/api/recycle/purge', async (req, res) => {
  const user = requireRecycleManager(currentSessionUser(req));
  const body = req.body || {};
  const type = String(body.type || '');
  const id = String(body.id || '').trim();
  if (!id) return sendJson(res, 400, { success: false, error: '缺少 id' });
  requireRecycleRecord(user, type, id);
  purgeRecycleEntity(type, id);
  logAction(user.id, 'recycle_purge', type, id, 'Danger');
  sendJson(res, 200, { success: true, message: '已彻底删除（不可恢复）' });
});

// ---------- V1.62：项目置顶（每用户各自一套） ----------
route(['POST'], '/api/projects/pin', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, user);
  const pinned = body.pinned === true || body.pinned === 1 || body.pinned === '1';
  if (pinned) {
    db.prepare('INSERT OR IGNORE INTO project_pins (id, user_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run('pin-' + crypto.randomUUID().split('-')[0], user.id, projectId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM project_pins WHERE user_id = ? AND project_id = ?').run(user.id, projectId);
  }
  sendJson(res, 200, { success: true, pinned: pinned ? 1 : 0, message: pinned ? '已置顶' : '已取消置顶' });
});

/** V1.63：父级公司置顶（以公司名义把公司及其全部项目置顶，按用户隔离） */
route(['POST'], '/api/companies/pin', async (req, res) => {
  const body = req.body || {};
  const user = currentSessionUser(req);
  const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
  if (!companyId) return sendJson(res, 400, { success: false, error: '缺少 company_id' });
  const company = db.prepare("SELECT * FROM companies WHERE id = ? AND COALESCE(deleted_at, '') = ''").get(companyId);
  if (!company) return sendJson(res, 404, { success: false, error: '客户/行业不存在或无权访问' });
  if (!canReadCompany(company, user)) return sendJson(res, 403, { success: false, error: '无权访问该客户/行业' });
  const pinned = body.pinned === true || body.pinned === 1 || body.pinned === '1';
  if (pinned) {
    db.prepare('INSERT OR IGNORE INTO company_pins (id, user_id, company_id, created_at) VALUES (?, ?, ?, ?)')
      .run('cpin-' + crypto.randomUUID().split('-')[0], user.id, companyId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM company_pins WHERE user_id = ? AND company_id = ?').run(user.id, companyId);
  }
  sendJson(res, 200, { success: true, pinned: pinned ? 1 : 0, message: pinned ? '已按公司置顶全部内容' : '已取消公司置顶' });
});

// ---------- V1.63：只读授权（客户级 / 项目级 × 用户 / 团队 / 所有团队） ----------
function listGrantCompanies(admin) {
  if (admin.role === 'superadmin') {
    return db.prepare("SELECT id, name FROM companies WHERE COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all();
  }
  const ids = visibleOwnerIds(admin) || [];
  if (ids.length === 0) return [];
  return db.prepare(`SELECT id, name FROM companies WHERE COALESCE(deleted_at, '') = '' AND user_id IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid ASC`).all(...ids);
}
function listGrantTeams(admin) {
  if (admin.role === 'superadmin') return db.prepare('SELECT id, name FROM teams ORDER BY rowid ASC').all();
  const teamId = String(admin.team_id || '').trim();
  return teamId ? db.prepare('SELECT id, name FROM teams WHERE id = ?').all(teamId) : [];
}
function listGrantUsers(admin) {
  if (admin.role === 'superadmin') {
    return db.prepare("SELECT u.id, u.username, u.role, u.team_id, COALESCE(t.name, '') AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.role != 'superadmin' AND COALESCE(u.status, 'active') = 'active' ORDER BY u.created_at ASC").all();
  }
  const teamId = String(admin.team_id || '').trim();
  if (!teamId) return [];
  return db.prepare("SELECT u.id, u.username, u.role, u.team_id, COALESCE(t.name, '') AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id = ? AND u.role != 'superadmin' AND COALESCE(u.status, 'active') = 'active' ORDER BY u.created_at ASC").all(teamId);
}
/** 校验当前管理员是否可管理某公司（超管任意；团管限本团队公司） */
function requireCompanyGrantPermission(admin, company) {
  if (!company) throw httpError(404, '客户/行业不存在或无权访问');
  if (admin.role === 'superadmin') return company;
  if (!canAccessOwner(company.user_id, admin)) throw httpError(403, '团管只能管理本团队项目的授权');
  return company;
}
/** 统一解析授权对象：兼容旧 user_ids，并做权限与存在性校验 */
function normalizeGrantTargets(admin, rawTargets) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
    const type = raw && raw.type === 'team' ? 'team' : raw && raw.type === 'all' ? 'all' : raw && raw.type === 'user' ? 'user' : '';
    if (!type) continue;
    if (type === 'all') {
      if (admin.role !== 'superadmin') throw httpError(403, '仅超级管理员可授权给「所有团队」');
      if (!seen.has('all')) { seen.add('all'); out.push({ type: 'all', id: '' }); }
      continue;
    }
    const id = String((raw && raw.id) || '').trim();
    if (!id) continue;
    if (type === 'user') {
      const target = db.prepare('SELECT id, role, team_id FROM users WHERE id = ?').get(id);
      if (!target) throw httpError(400, '被授权用户不存在：' + id);
      if (target.role === 'superadmin') continue;
      if (admin.role === 'teamadmin' && (target.team_id || '') !== (admin.team_id || '')) {
        throw httpError(403, '团管只能授权本团队用户');
      }
    } else {
      const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(id);
      if (!team) throw httpError(400, '被授权团队不存在：' + id);
      if (admin.role === 'teamadmin' && id !== (admin.team_id || '')) {
        throw httpError(403, '团管只能授权本团队');
      }
    }
    const key = type + ':' + id;
    if (!seen.has(key)) { seen.add(key); out.push({ type, id }); }
  }
  return out;
}
function replaceReadGrants(admin, scopeType, scopeId, targets, now) {
  db.prepare('DELETE FROM read_grants WHERE scope_type = ? AND scope_id = ?').run(scopeType, scopeId);
  const insert = db.prepare('INSERT OR IGNORE INTO read_grants (id, scope_type, scope_id, grantee_type, grantee_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const target of targets) {
    insert.run('rg-' + crypto.randomUUID().split('-')[0], scopeType, scopeId, target.type, target.id, admin.id, now);
  }
  // 兼容旧表：项目级用户授权同步一份，便于回滚到 V1.62
  if (scopeType === 'project') {
    db.prepare('DELETE FROM project_grants WHERE project_id = ?').run(scopeId);
    const insertLegacy = db.prepare('INSERT OR IGNORE INTO project_grants (id, project_id, grantee_user_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const target of targets) {
      if (target.type !== 'user') continue;
      insertLegacy.run('grant-' + crypto.randomUUID().split('-')[0], scopeId, target.id, admin.id, now);
    }
  }
}

route(['GET'], '/api/projects/grants', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const projectId = String(req.query.project_id || '').trim();
  let companyId = String(req.query.company_id || '').trim();
  let project = null;
  if (projectId) {
    project = requireProjectAccess(projectId, admin);
    if (!companyId) companyId = String(project.company_id || '');
  }
  if (!companyId) return sendJson(res, 400, { success: false, error: '缺少 company_id 或 project_id' });
  const company = requireCompanyGrantPermission(admin, requireCompanyAccess(companyId, admin));
  const projectIds = db.prepare("SELECT id FROM projects WHERE company_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all(companyId).map((row) => row.id);
  const placeholders = projectIds.length ? projectIds.map(() => '?').join(', ') : "''";
  const projectGrants = projectIds.length
    ? db.prepare(`SELECT scope_id AS project_id, grantee_type, grantee_id FROM read_grants WHERE scope_type = 'project' AND scope_id IN (${placeholders}) ORDER BY rowid ASC`).all(...projectIds)
    : [];
  const companyGrants = db.prepare("SELECT grantee_type, grantee_id FROM read_grants WHERE scope_type = 'company' AND scope_id = ? ORDER BY rowid ASC").all(companyId);
  return sendJson(res, 200, {
    success: true,
    data: {
      companies: listGrantCompanies(admin),
      company: { id: company.id, name: company.name || '' },
      projects: projectIds.length ? db.prepare(`SELECT id, name FROM projects WHERE id IN (${placeholders}) ORDER BY rowid ASC`).all(...projectIds) : [],
      teams: listGrantTeams(admin),
      users: listGrantUsers(admin),
      grants: { company: companyGrants, project: projectGrants },
      project: project ? { id: project.id, name: project.name || '' } : null,
    },
  });
});

route(['POST'], '/api/projects/grants/save', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const companyId = String(body.company_id || '').trim();
  const company = requireCompanyGrantPermission(admin, requireCompanyAccess(companyId, admin));
  const rawTargets = Array.isArray(body.targets)
    ? body.targets
    : (Array.isArray(body.user_ids) ? body.user_ids.map((id) => ({ type: 'user', id })) : []);
  const legacyProjectId = String(body.project_id || '').trim();
  const scopeType = body.scope_type === 'company' ? 'company' : (legacyProjectId && !body.scope_type ? 'project' : (body.scope_type === 'project' ? 'project' : 'company'));
  let projectIds = [];
  if (scopeType === 'project') {
    projectIds = (Array.isArray(body.project_ids) ? body.project_ids : [legacyProjectId]).map((id) => String(id || '').trim()).filter(Boolean);
    if (projectIds.length === 0) return sendJson(res, 400, { success: false, error: '请选择至少一个项目' });
    for (const pid of projectIds) {
      const project = requireProjectAccess(pid, admin);
      if (String(project.company_id || '') !== companyId) return sendJson(res, 400, { success: false, error: '所选项目不属于该客户/行业' });
    }
  }
  const targets = normalizeGrantTargets(admin, rawTargets);
  const now = new Date().toISOString();
  db.transaction(() => {
    if (scopeType === 'company') {
      replaceReadGrants(admin, 'company', company.id, targets, now);
    } else {
      for (const pid of projectIds) replaceReadGrants(admin, 'project', pid, targets, now);
    }
  })();
  logAction(admin.id, 'project_grant_update', scopeType === 'company' ? 'company' : 'project', scopeType === 'company' ? company.id : projectIds.join(','), `scope=${scopeType} targets=${targets.length}`, 'Warn');
  const scopeText = scopeType === 'company' ? '整个客户/行业' : `${projectIds.length} 个项目`;
  sendJson(res, 200, { success: true, targets: targets.length, scope_type: scopeType, message: targets.length ? `已对${scopeText}授权 ${targets.length} 个对象只读` : `已清空${scopeText}的只读授权` });
});

// ---------- V1.63：项目所有权移交（管理员） ----------
route(['GET'], '/api/projects/transfer/candidates', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const projectId = String(req.query.project_id || '').trim();
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  const project = requireProjectAccess(projectId, admin);
  if (admin.role === 'teamadmin' && !canAccessOwner(project.user_id, admin)) {
    return sendJson(res, 403, { success: false, error: '团管只能移交本团队项目' });
  }
  let rows;
  if (admin.role === 'superadmin') {
    rows = db.prepare("SELECT u.id, u.username, u.role, u.team_id, COALESCE(t.name, '') AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.role != 'superadmin' AND COALESCE(u.status, 'active') = 'active' ORDER BY u.created_at ASC").all();
  } else {
    rows = db.prepare("SELECT u.id, u.username, u.role, u.team_id, COALESCE(t.name, '') AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id = ? AND u.role != 'superadmin' AND COALESCE(u.status, 'active') = 'active' ORDER BY u.created_at ASC").all(admin.team_id || '');
  }
  sendJson(res, 200, { success: true, data: rows.filter((row) => row.id !== project.user_id) });
});

route(['POST'], '/api/projects/transfer', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || !['superadmin', 'teamadmin'].includes(admin.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  const body = req.body || {};
  const projectId = String(body.project_id || '').trim();
  const targetUserId = String(body.target_user_id || '').trim();
  if (!projectId || !targetUserId) return sendJson(res, 400, { success: false, error: '缺少 project_id 或 target_user_id' });
  const project = requireProjectWritable(projectId, admin);
  if (admin.role === 'teamadmin' && !canAccessOwner(project.user_id, admin)) {
    return sendJson(res, 403, { success: false, error: '团管只能移交本团队项目' });
  }
  if (targetUserId === admin.id) return sendJson(res, 400, { success: false, error: '不能移交给操作人自己' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
  if (!target) return sendJson(res, 404, { success: false, error: '目标用户不存在' });
  if (target.role === 'superadmin') return sendJson(res, 400, { success: false, error: '不能移交给超级管理员' });
  if (String(target.status || 'active') !== 'active') return sendJson(res, 400, { success: false, error: '目标账号已被禁用' });
  if (admin.role === 'teamadmin' && (target.team_id || '') !== (admin.team_id || '')) {
    return sendJson(res, 403, { success: false, error: '团管只能移交给本团队用户' });
  }
  const oldOwnerId = project.user_id || '';
  db.transaction(() => {
    db.prepare('UPDATE projects SET user_id = ? WHERE id = ?').run(target.id, projectId);
    db.prepare('UPDATE kb_items SET user_id = ? WHERE project_id = ?').run(target.id, projectId);
    db.prepare('UPDATE snapshots SET user_id = ? WHERE project_id = ?').run(target.id, projectId);
    // 新所有者天然可读，清掉其多余的只读授权
    db.prepare("DELETE FROM read_grants WHERE scope_type = 'project' AND scope_id = ? AND grantee_type = 'user' AND grantee_id = ?").run(projectId, target.id);
    db.prepare('DELETE FROM project_grants WHERE project_id = ? AND grantee_user_id = ?').run(projectId, target.id);
  })();
  const oldOwner = oldOwnerId ? db.prepare('SELECT username FROM users WHERE id = ?').get(oldOwnerId) : null;
  logAction(admin.id, 'project_transfer', 'project', projectId, `from=${oldOwner ? oldOwner.username : oldOwnerId} to=${target.username}`, 'Warn');
  sendJson(res, 200, { success: true, message: `已将项目移交给 ${target.username}`, from_user_id: oldOwnerId, to_user_id: target.id });
});


// ------------------------------------------------------------
// 4.5 发布门禁导出（CQO 生产级：PROJECT_NAME 实时读 DB + no-store + 去首部换行）
// ------------------------------------------------------------

route(['GET'], '/api/gate/export', async (req, res) => {
  const snapshotId = req.query.snapshot_id;
  const format = String(req.query.format || 'txt');
  requireSnapshotAccess(snapshotId, currentSessionUser(req));

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
  const isMd = format === 'md';
  const safeFormat = isMd ? 'md' : 'txt';
  const BOM = '﻿';

  let content;
  if (isMd) {
    const metaHeader = `# 快照导出 ${snap.id}\n\n- **项目 ID**：${snap.project_id}\n- **项目名称**：${projectName}\n- **评测得分**：${snap.eval_score}\n- **生成时间**：${snap.created_at}\n\n---\n\n`;
    content = metaHeader + promptBody;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  } else {
    const metaHeader = `# SNAPSHOT: ${snap.id}\n# PROJECT_ID: ${snap.project_id}\n# PROJECT_NAME: ${projectName}\n# EVAL_SCORE: ${snap.eval_score}\n# CREATED_AT: ${snap.created_at}\n\n`;
    content = metaHeader + promptBody;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${snap.id}.${safeFormat}`)}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(BOM + content);
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

/**
 * V1.63：评测结果落库（只做历史可追溯，不参与提交/导出拦截）
 * 服务端重算 L1（不信任前端），L2 采用前端回传的评分结果。
 */
route(['POST', 'GET'], '/api/eval/runs', async (req, res) => {
  // 同一路径必须合并注册（route 内部用 app.all，分开注册会让后一个方法返回 405）
  if (req.method === 'GET') {
    const historyProjectId = String(req.query.project_id || '').trim();
    if (!historyProjectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
    requireProjectAccess(historyProjectId, currentSessionUser(req));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const rows = db.prepare('SELECT id, project_id, prompt_hash, case_total, case_passed, p0_failures, l1_pass_rate, l2_avg_score, status, created_at FROM eval_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT ?').all(historyProjectId, limit);
    return sendJson(res, 200, { success: true, data: rows });
  }
  const user = currentSessionUser(req);
  const body = req.body || {};
  const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, user);
  setRequestProjectId(projectId);
  if (!Array.isArray(body.layers)) return sendJson(res, 400, { success: false, error: 'layers 必须是数组' });
  const cases = Array.isArray(body.cases) ? body.cases.slice(0, 200) : [];
  if (cases.length === 0) return sendJson(res, 400, { success: false, error: '没有可保存的评测用例' });

  const prompt = applyContextReplace(assemblePrompt(body.layers), readProjectContext(projectId));
  const promptHash = sha256Hex(prompt);
  const details = [];
  let caseTotal = 0;
  let casePassed = 0;
  let l1Passed = 0;
  let p0Failures = 0;
  let l2Sum = 0;
  let l2Count = 0;
  for (const raw of cases) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const botReply = String(item.bot_reply ?? '').slice(0, 8000);
    const l1 = checkL1(botReply);
    const l2 = item.l2 && typeof item.l2 === 'object' ? item.l2 : null;
    const l2Pass = !!(l2 && l2.pass === true);
    const rawScore = l2 ? Number(l2.score) : NaN;
    const score = Number.isFinite(rawScore) ? Math.max(1, Math.min(5, rawScore)) : 0;
    if (score > 0) { l2Sum += score; l2Count += 1; }
    if (l1.pass) l1Passed += 1;
    else p0Failures += 1;
    if (l1.pass && l2Pass) casePassed += 1;
    caseTotal += 1;
    details.push({ pass: l1.pass && l2Pass, l1_pass: l1.pass, l2_pass: l2Pass, l2_score: score, l1_errors: l1.errors.slice(0, 5) });
  }
  const avgScore = l2Count > 0 ? Math.round((l2Sum / l2Count) * 10) / 10 : 0;
  const status = casePassed === caseTotal ? 'passed' : 'failed';
  const id = 'eval-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  db.prepare('INSERT INTO eval_runs (id, snapshot_id, project_id, user_id, prompt_hash, case_total, case_passed, p0_failures, l1_pass_rate, l2_avg_score, status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, '', projectId, user.id, promptHash, caseTotal, casePassed, p0Failures, caseTotal ? l1Passed / caseTotal : 0, avgScore, status, JSON.stringify(details).slice(0, 200000), now);
  // 每项目保留最近 300 条（串行删除，严禁 Promise.all）
  try {
    const expired = db.prepare('SELECT id FROM eval_runs WHERE project_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET 300').all(projectId);
    for (const row of expired) db.prepare('DELETE FROM eval_runs WHERE id = ?').run(row.id);
  } catch (e) { /* ignore */ }
  logAction(user.id, 'eval_run', 'project', projectId, `total=${caseTotal} passed=${casePassed} status=${status}`);
  sendJson(res, 200, {
    success: true,
    data: {
      id,
      project_id: projectId,
      prompt_hash: promptHash,
      case_total: caseTotal,
      case_passed: casePassed,
      p0_failures: p0Failures,
      pass_rate: caseTotal ? Math.round((casePassed / caseTotal) * 1000) / 1000 : 0,
      avg_score: avgScore,
      status,
      created_at: now,
    },
  });
});


// 阶段四：AI 生成「刁钻」测试题（服务端正则提取 JSON 数组 + 结构校验兜底）
route(['POST'], '/api/eval/generate_questions', async (req, res) => {
  const body = req.body || {};
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  const quizUser = currentSessionUser(req);
  if (projectId) {
    requireProjectAccess(projectId, quizUser);
    setRequestProjectId(projectId);
  }
  // v1.60 重构：默认至少生成 15 个用例（允许 15-30 个）
  const requestedCount = Number(body.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 15 && requestedCount <= 30 ? requestedCount : 15;

  // v1.60：随机抽取当前项目知识库内容，数量取 Math.min(30, 知识库总数)，不死写 30 导致空指针
  const EVAL_KB_MAX = 3000;
  let kbText = '';
  if (projectId) {
    const totalRow = db.prepare("SELECT COUNT(*) AS n FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = ''").get(projectId);
    const total = totalRow ? Number(totalRow.n) || 0 : 0;
    const sampleCount = Math.min(30, total);
    if (sampleCount > 0) {
      // SQLite ORDER BY RANDOM() 实现随机抽样，LIMIT 用实际样本数
      const rows = db.prepare("SELECT question, answer FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY RANDOM() LIMIT ?").all(projectId, sampleCount);
      kbText = rows.map((row, index) => `【${index + 1}】Q: ${row.question ?? ''}\nA: ${row.answer ?? ''}`).join('\n\n');
    }
  }
  let scenarioHint = '';
  if (!kbText.trim()) {
    scenarioHint = '（该项目知识库为空，请围绕通用商城客服场景：退换货、物流查询、优惠活动、停车缴费、转人工等）';
    kbText = '无知识库内容，使用通用商城客服场景。';
  }
  if (kbText.length > EVAL_KB_MAX) kbText = kbText.slice(0, EVAL_KB_MAX);

  const systemPrompt = `你是一个智能语音客服系统的测试用例设计专家。请根据提供的知识库内容，至少生成 ${count} 条「刁钻」的测试用例，用于检验语音客服提示词的鲁棒性。
【刁钻方向】边界数字/时间条件、多轮上下文指代、口语化与方言表达、模糊或矛盾信息、诱导性提问、要求转人工等。
【输出格式要求】
必须且只能输出一个 JSON 数组，不要输出 Markdown 标记，不要输出任何解释文字：
[{"user_query":"用户问题","standard_answer":"依据知识库的标准答案","bot_reply":"可选的机器人回复，未知时留空字符串"}]
【规则】
1. user_query 必须口语化、像真实用户说的话，尽量简短。
2. standard_answer 必须严格依据知识库事实，不得编造。
3. 生成数量不得少于 ${count} 条。
4. 所有内容使用中文。`;

  let rawReply;
  try {
    rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下是知识库内容${scenarioHint}：\n\n${kbText}` },
    ], 'eval_questions');
  } catch (err) {
    // 大模型调用失败（如假 Key 导致 401、网络异常）：返回结构化 JSON，前端据此 Toast 且不白屏
    return sendJson(res, 500, { success: false, error: '大模型调用失败：' + (err && err.message ? err.message : '未知错误') });
  }

  // v1.60 硬性要求：先用正则 /\[[\s\S]*\]/ 提取 JSON 数组；
  // 若大模型返回被对象包裹（如 {"questions":[...]}），再用 /\{[\s\S]*\}/ 清洗提取后取数组字段；
  // 最后 safeParseJson 兜底。
  const rawText = String(rawReply ?? '');
  let parsed = null;
  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { parsed = JSON.parse(arrayMatch[0]); } catch { parsed = null; }
  }
  if (!Array.isArray(parsed)) {
    const objectMatch = rawText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const obj = JSON.parse(objectMatch[0]);
        const candidate = Array.isArray(obj) ? obj
          : (Array.isArray(obj.questions) ? obj.questions
          : (Array.isArray(obj.data) ? obj.data
          : (obj.data && Array.isArray(obj.data.questions) ? obj.data.questions : null)));
        if (Array.isArray(candidate)) parsed = candidate;
      } catch { parsed = null; }
    }
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

/**
 * v1.60：智能体评测用例导出（.txt / .md，带 BOM）
 * GET /api/eval/export?project_id=&format=txt|md
 */
route(['GET'], '/api/eval/export', async (req, res) => {
  const projectId = req.query.project_id || '';
  const format = String(req.query.format || 'txt');
  if (!projectId) return sendJson(res, 400, { success: false, error: '缺少 project_id' });
  requireProjectAccess(projectId, currentSessionUser(req));
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
  const rows = db.prepare("SELECT question, answer FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all(projectId);
  let text;
  const title = `评测用例 - ${project ? project.name : projectId}`;
  if (format === 'md') {
    const lines = [`# ${title}`, `> 共 ${rows.length} 条，导出时间 ${new Date().toLocaleString('zh-CN')}`, ''];
    rows.forEach((r, i) => {
      lines.push(`## 用例 ${i + 1}`, `- **用户提问**：${r.question || ''}`, `- **标准答案**：${r.answer || ''}`, '');
    });
    text = lines.join('\n');
  } else {
    const lines = [title, `共 ${rows.length} 条 | 导出时间 ${new Date().toLocaleString('zh-CN')}`, ''];
    rows.forEach((r, i) => {
      lines.push(`用例 ${i + 1}`, `用户提问：${r.question || ''}`, `标准答案：${r.answer || ''}`, '');
    });
    text = lines.join('\n');
  }
  buildExportResponse(res, text, format, title);
});

route(['POST'], '/api/chat/reply', async (req, res) => {
  const body = req.body || {};
  const { project_id, layers, context_data } = body;
  if (project_id) {
    requireProjectAccess(project_id, currentSessionUser(req));
    setRequestProjectId(project_id);
  }

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
  const rawReply = await chatCompletion(CHAT_LLM_CONFIG, [{ role: 'system', content: systemPrompt }, ...messages], 'chat');
  const reply = typeof rawReply === 'string' ? rawReply.trim() : String(rawReply ?? '').trim();
  sendJson(res, 200, { success: true, reply, system_prompt: systemPrompt });
});

// ------------------------------------------------------------
// 4.7 API Key 设置（安全：masked、空值保持、非法 400、原子写 .env）
// ------------------------------------------------------------

route(['GET', 'POST'], '/api/settings/api-key', async (req, res) => {
  // V5.0：系统 .env Key 属于全局公共资产，仅超级管理员可查看/修改
  const settingsUser = getSessionUser(req);
  if (!settingsUser || settingsUser.role !== 'superadmin') {
    return sendJson(res, 403, { success: false, error: '仅超级管理员可管理系统 API Key' });
  }
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

/** DB 行 -> 对外模型对象（解密后仅展示 mask，绝不返回完整 api_key） */
function toPublicModel(row) {
  const plainKey = decryptSecret(row.api_key);
  const hasKey = typeof plainKey === 'string' && plainKey.trim().length > 0;
  return {
    id: row.id,
    provider: row.provider,
    display_name: row.display_name,
    base_url: row.base_url,
    model_name: row.model_name,
    is_active: row.is_active, // 保持 DB 原始 1/0，前端用 Number(is_active) === 1 判断
    temperature: row.temperature,
    price_input_per_m: Number(row.price_input_per_m) || 0,
    price_output_per_m: Number(row.price_output_per_m) || 0,
    has_key: hasKey,
    masked_key: hasKey ? maskKeyForDisplay(row.api_key) : '',
  };
}

route(['GET'], '/api/models', async (req, res) => {
  const currentUser = getSessionUser(req);
  if (!currentUser) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录' });
  const rows = currentUser.role === 'superadmin'
    ? db.prepare('SELECT * FROM model_configs ORDER BY rowid ASC').all()
    : db.prepare('SELECT * FROM model_configs WHERE user_id = ? ORDER BY rowid ASC').all(currentUser.id);
  // 超管能看到全员模型：额外标注归属，便于区分
  let ownerNames = null;
  if (currentUser.role === 'superadmin') {
    ownerNames = new Map();
    try {
      for (const user of db.prepare('SELECT id, username FROM users').all()) ownerNames.set(user.id, user.username || '');
    } catch (e) { /* ignore */ }
  }
  const data = rows.map((row) => {
    const model = toPublicModel(row);
    if (ownerNames) model.owner_username = ownerNames.get(row.user_id) || row.user_id || '';
    return model;
  });
  sendJson(res, 200, { success: true, data });
});

route(['POST'], '/api/models/save', async (req, res) => {
  const currentUser = getSessionUser(req);
  if (!currentUser) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录' });
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
  // V1.63：单价（元 / 百万 token），用于用量看板估算成本；留空按 0 计
  const priceInputRaw = Number(body.price_input_per_m);
  const priceOutputRaw = Number(body.price_output_per_m);
  const priceInput = Number.isFinite(priceInputRaw) && priceInputRaw >= 0 ? priceInputRaw : 0;
  const priceOutput = Number.isFinite(priceOutputRaw) && priceOutputRaw >= 0 ? priceOutputRaw : 0;
  const incomingId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
  const apiKeyInput = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const isActiveSpecified = body.is_active !== undefined;
  const wantActive = body.is_active === true || body.is_active === 1 || body.is_active === '1' || body.is_active === 'true';

  const existing = incomingId ? db.prepare('SELECT * FROM model_configs WHERE id = ?').get(incomingId) : null;
  if (existing && existing.user_id && existing.user_id !== currentUser.id && currentUser.role !== 'superadmin') {
    return sendJson(res, 403, { success: false, error: '无权修改他人的模型配置' });
  }
  const id = incomingId || 'model-' + crypto.randomUUID().split('-')[0];
  // Key 防覆盖：前端回显的 masked Key（含 *）或留空都表示“未修改”，严禁写入星号/空值覆盖原加密 Key
  const keepExistingKey = !apiKeyInput || apiKeyInput.includes('*');
  const existingPlainKey = existing ? decryptSecret(existing.api_key) : '';
  const apiKeyPlain = keepExistingKey ? existingPlainKey : apiKeyInput;
  const apiKeyStored = keepExistingKey ? (existing ? existing.api_key : '') : encryptSecret(apiKeyInput);
  if (!apiKeyPlain && !urlSecurity.isEnvKeyAllowed) {
    return sendJson(res, 400, { success: false, error: '自定义/第三方 Base URL 必须填写 API Key（不允许使用 .env 回退，防 Key 外泄）' });
  }

  // V1.62：首次配置且当前没有激活模型时自动激活，避免「配了 Key 还在扣试用」
  const hasActiveModel = !!db.prepare('SELECT 1 FROM model_configs WHERE user_id = ? AND is_active = 1 LIMIT 1').get(currentUser.id);
  const autoActivate = !existing && !wantActive && !hasActiveModel;
  const effectiveActive = wantActive || autoActivate;

  // 单活模型：仅重置当前用户自己的模型（多租户互不影响）
  if (effectiveActive) db.prepare('UPDATE model_configs SET is_active = 0 WHERE user_id = ?').run(currentUser.id);

  if (existing) {
    const isActive = isActiveSpecified ? (wantActive ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE model_configs SET provider = ?, display_name = ?, base_url = ?, api_key = ?, model_name = ?, temperature = ?, is_active = ?, price_input_per_m = ?, price_output_per_m = ? WHERE id = ?')
      .run(provider, displayName, baseUrl, apiKeyStored, modelName, temperature, isActive, priceInput, priceOutput, id);
    logAction(currentUser.id, 'model_save', 'model', id, `provider=${provider} base=${baseUrl}`);
    return sendJson(res, 200, { success: true, message: '模型配置已更新', id, is_active: isActive });
  }

  const maxContextLength = Number.isFinite(Number(body.max_context_length)) ? Number(body.max_context_length) : 32000;
  db.prepare('INSERT INTO model_configs (id, provider, display_name, base_url, api_key, model_name, temperature, max_context_length, is_active, user_id, price_input_per_m, price_output_per_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, provider, displayName, baseUrl, apiKeyStored, modelName, temperature, maxContextLength, effectiveActive ? 1 : 0, currentUser.id, priceInput, priceOutput);
  logAction(currentUser.id, 'model_save', 'model', id, `provider=${provider} base=${baseUrl}`);
  sendJson(res, 200, {
    success: true,
    message: autoActivate ? '模型配置已保存并自动设为当前模型' : '模型配置已保存',
    id,
    is_active: effectiveActive ? 1 : 0,
    auto_activated: autoActivate,
  });
});

/** V1.62：删除模型配置（个人 Key 自助管理的必要能力；删除激活模型时自动启用剩余最后一个） */
route(['POST'], '/api/models/delete', async (req, res) => {
  const currentUser = getSessionUser(req);
  if (!currentUser) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录' });
  const id = typeof (req.body || {}).id === 'string' ? req.body.id.trim() : '';
  if (!id) return sendJson(res, 400, { success: false, error: '缺少模型 id' });
  const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { success: false, error: '模型配置不存在' });
  if (row.user_id && row.user_id !== currentUser.id && currentUser.role !== 'superadmin') {
    return sendJson(res, 403, { success: false, error: '无权删除他人的模型配置' });
  }
  db.prepare('DELETE FROM model_configs WHERE id = ?').run(id);
  const ownerId = row.user_id || currentUser.id;
  try {
    const stillActive = db.prepare('SELECT 1 FROM model_configs WHERE user_id = ? AND is_active = 1 LIMIT 1').get(ownerId);
    if (!stillActive) {
      const fallback = db.prepare('SELECT id FROM model_configs WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(ownerId);
      if (fallback) db.prepare('UPDATE model_configs SET is_active = 1 WHERE id = ?').run(fallback.id);
    }
  } catch (e) { /* 自动切换失败不影响删除 */ }
  logAction(currentUser.id, 'model_delete', 'model', id, '');
  sendJson(res, 200, { success: true, message: '模型配置已删除' });
});

route(['POST'], '/api/models/test', async (req, res) => {
  const currentUser = getSessionUser(req);
  if (!currentUser) return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录' });
  const body = req.body || {};
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  const modelName = typeof body.model_name === 'string' ? body.model_name.trim() : '';
  if (!baseUrl || !modelName) {
    return sendJson(res, 400, { success: false, message: 'base_url / model_name 为必填项' });
  }
  let providedKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!providedKey) {
    // 未显式填 Key 时，尝试复用当前用户已保存的同 base_url 模型 Key（不回显）
    const ownRow = db.prepare('SELECT * FROM model_configs WHERE user_id = ? AND base_url = ? ORDER BY rowid DESC LIMIT 1')
      .get(currentUser.id, baseUrl.replace(/\/+$/, ''));
    if (ownRow) providedKey = decryptSecret(ownRow.api_key);
  }
  const result = await testModelConnection(
    { base_url: baseUrl, model_name: modelName, api_key: providedKey },
    { allowEnvFallback: currentUser.role === 'superadmin' },
  );
  if (result.success) console.log(`[models] 连接测试成功: provider=${provider || '-'} model=${modelName} user=${currentUser.username}`);
  else console.warn(`[models] 连接测试失败: provider=${provider || '-'} model=${modelName} reason=${result.message}`);
  sendJson(res, 200, result);
});

// ============================================================
// 4.5 V4.0：提示词模板库 / AI 润色 / 备份恢复 / 项目克隆
// ============================================================

/** 备份涉及的全部数据表（顺序无关，导入前先 DELETE 全部再 INSERT） */
const BACKUP_TABLES = [
  'model_configs', 'companies', 'projects', 'modules', 'module_versions',
  'kb_items', 'kb_item_versions', 'snapshots', 'eval_runs', 'prompt_templates',
];
/** V1.62：全量备份额外覆盖账号体系、权限与审计（旧备份仍按 business 解析） */
const FULL_BACKUP_TABLES = [
  ...BACKUP_TABLES,
  'users', 'teams', 'audit_logs', 'app_settings', 'project_grants', 'project_pins',
  'read_grants', 'llm_usage', 'company_pins',
];
/** V1.63：新增表在旧全量备份中不存在，导入时按可选表处理（缺失则保留当前数据） */
const OPTIONAL_BACKUP_TABLES = ['read_grants', 'llm_usage', 'company_pins'];

/** 导出表为 JSON 快照对象（scope=business 保持 v1 结构；scope=full 为 v2） */
function buildBackupSnapshot(scope = 'business') {
  const isFull = scope === 'full';
  const tables = isFull ? FULL_BACKUP_TABLES : BACKUP_TABLES;
  const snapshot = {
    success: true,
    app: 'newrock-ai-workbench',
    version: isFull ? 2 : 1,
    scope: isFull ? 'full' : 'business',
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) snapshot.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  return snapshot;
}

/** 单表行校验：主键 + 字段白名单 + 基本类型 */
function validateBackupRows(table, rows, allowedColumns) {
  if (!Array.isArray(rows)) throw new Error(`表 ${table} 必须是数组`);
  const pk = table === 'app_settings' ? 'key' : 'id';
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`表 ${table} 第 ${index + 1} 行必须是对象`);
    if (typeof row[pk] !== 'string' || !row[pk].trim()) throw new Error(`表 ${table} 第 ${index + 1} 行缺少主键 ${pk}`);
    const keys = Object.keys(row);
    if (keys.length === 0) throw new Error(`表 ${table} 第 ${index + 1} 行是空对象`);
    const unknownColumns = keys.filter((key) => !allowedColumns.includes(key));
    if (unknownColumns.length > 0) throw new Error(`表 ${table} 第 ${index + 1} 行存在未知字段：${unknownColumns.join(', ')}`);
    const normalized = {};
    for (const key of keys) {
      const value = row[key];
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`表 ${table} 第 ${index + 1} 行字段 ${key} 类型非法`);
      }
      normalized[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    return normalized;
  });
}

/** 全量备份的引用完整性 + 超管兜底校验（防导入后锁死） */
function validateFullBackupIntegrity(rowsByTable) {
  const users = rowsByTable.users || [];
  const loginableSuperadmins = users.filter((u) => u.role === 'superadmin' && typeof u.password_hash === 'string' && u.password_hash.trim());
  if (loginableSuperadmins.length === 0) throw new Error('全量备份必须至少包含 1 个可登录的超级管理员账号');
  const usernames = new Set();
  for (const user of users) {
    if (!user.username || !String(user.username).trim()) throw new Error('用户账号存在空 username');
    if (usernames.has(user.username)) throw new Error('用户账号重复：' + user.username);
    usernames.add(user.username);
    if (!['superadmin', 'teamadmin', 'user'].includes(user.role)) throw new Error('非法角色：' + user.role);
    if (user.status && !['active', 'disabled'].includes(user.status)) throw new Error('非法账号状态：' + user.status);
  }
  const userIds = new Set(users.map((u) => u.id));
  const projectIds = new Set((rowsByTable.projects || []).map((p) => p.id));
  for (const grant of rowsByTable.project_grants || []) {
    if (!projectIds.has(grant.project_id)) throw new Error('只读授权引用了不存在的项目：' + grant.project_id);
    if (!userIds.has(grant.grantee_user_id)) throw new Error('只读授权引用了不存在的用户：' + grant.grantee_user_id);
  }
  for (const pin of rowsByTable.project_pins || []) {
    if (!userIds.has(pin.user_id)) throw new Error('置顶记录引用了不存在的用户：' + pin.user_id);
    if (!projectIds.has(pin.project_id)) throw new Error('置顶记录引用了不存在的项目：' + pin.project_id);
  }
  for (const model of rowsByTable.model_configs || []) {
    if (model.user_id && !userIds.has(model.user_id)) throw new Error('模型配置引用了不存在的用户：' + model.user_id);
  }
}

/** 备份导入严格校验：按 version/scope 分流；返回 { scope, tables } */
function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('备份内容必须是 JSON 对象');
  const tables = payload.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw new Error('备份缺少 tables 对象');
  const version = Number(payload.version) || 1;
  const scope = payload.scope === 'full' ? 'full' : 'business';
  if (scope === 'full' && version < 2) throw new Error('全量备份缺少版本标记（version 必须 >= 2）');
  const expected = scope === 'full' ? FULL_BACKUP_TABLES : BACKUP_TABLES;
  const unknownTables = Object.keys(tables).filter((name) => !expected.includes(name));
  if (unknownTables.length > 0) throw new Error(`备份包含未知数据表：${unknownTables.join(', ')}`);
  const missingTables = expected.filter((name) => !OPTIONAL_BACKUP_TABLES.includes(name) && !Object.prototype.hasOwnProperty.call(tables, name));
  if (missingTables.length > 0) throw new Error(`备份缺少数据表：${missingTables.join(', ')}`);

  const columnCache = new Map();
  const rowsByTable = {};
  for (const table of expected) {
    if (!Object.prototype.hasOwnProperty.call(tables, table)) continue; // 可选表缺失：不导入、不清空
    if (!columnCache.has(table)) {
      columnCache.set(table, db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    }
    rowsByTable[table] = validateBackupRows(table, tables[table], columnCache.get(table));
  }
  if (scope === 'full') validateFullBackupIntegrity(rowsByTable);
  return { scope, tables: rowsByTable };
}

// ---------- 阶段一：提示词模板库 ----------

route(['GET'], '/api/templates', async (req, res) => {
  const user = currentSessionUser(req);
  const rows = user.role === 'superadmin'
    ? db.prepare('SELECT * FROM prompt_templates ORDER BY created_at DESC, rowid DESC').all()
    : db.prepare('SELECT * FROM prompt_templates WHERE user_id = ? OR is_public = 1 ORDER BY created_at DESC, rowid DESC').all(user.id);
  sendJson(res, 200, { success: true, data: rows });
});

route(['POST'], '/api/templates/save', async (req, res) => {
  const user = currentSessionUser(req);
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt : '';
  if (!name) return sendJson(res, 400, { success: false, error: '模板名称不能为空' });
  if (name.length > 100) return sendJson(res, 400, { success: false, error: '模板名称过长（≤100 字符）' });
  if (!systemPrompt.trim()) return sendJson(res, 400, { success: false, error: '系统提示词内容不能为空' });
  const incomingId = typeof body.id === 'string' ? body.id.trim() : '';
  const existing = incomingId ? db.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(incomingId) : null;
  if (existing && existing.user_id && existing.user_id !== user.id && user.role !== 'superadmin') {
    return sendJson(res, 403, { success: false, error: '无权修改他人模板' });
  }
  const id = incomingId || 'tpl-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  const canPublic = user.role === 'superadmin';
  const isPublic = canPublic && (body.is_public === true || body.is_public === 1 || body.is_public === '1') ? 1 : 0;
  const publicScope = isPublic ? (typeof body.public_scope === 'string' && body.public_scope.trim() ? body.public_scope.trim() : 'global') : 'private';
  if (existing) {
    const nextPublic = canPublic && body.is_public !== undefined ? isPublic : Number(existing.is_public) || 0;
    const nextScope = canPublic && body.is_public !== undefined ? publicScope : (existing.public_scope || 'private');
    db.prepare('UPDATE prompt_templates SET name = ?, system_prompt = ?, is_public = ?, public_scope = ? WHERE id = ?')
      .run(name, systemPrompt, nextPublic, nextScope, id);
    logAction(user.id, 'template_save', 'template', id, name);
    return sendJson(res, 200, { success: true, message: '模板已更新', id });
  }
  db.prepare('INSERT INTO prompt_templates (id, name, system_prompt, created_at, user_id, is_public, public_scope) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, systemPrompt, now, user.id, isPublic, publicScope);
  logAction(user.id, 'template_save', 'template', id, name);
  sendJson(res, 200, { success: true, message: '模板已保存', id });
});

route(['POST'], '/api/templates/delete', async (req, res) => {
  const user = currentSessionUser(req);
  const id = typeof (req.body || {}).id === 'string' ? req.body.id.trim() : '';
  if (!id) return sendJson(res, 400, { success: false, error: '缺少模板 id' });
  const tpl = db.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(id);
  if (!tpl) return sendJson(res, 404, { success: false, error: '模板不存在' });
  if (tpl.user_id && tpl.user_id !== user.id && user.role !== 'superadmin') {
    return sendJson(res, 403, { success: false, error: '无权删除他人模板' });
  }
  db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id);
  logAction(user.id, 'template_delete', 'template', id, '');
  sendJson(res, 200, { success: true, message: '模板已删除' });
});

/** 分析接口：把当前系统提示词提炼为可复用模板（保留 {{变量}}，去除项目专属信息） */
route(['POST'], '/api/templates/extract', async (req, res) => {
  const body = req.body || {};
  const systemPromptIn = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : '';
  if (!systemPromptIn) return sendJson(res, 400, { success: false, error: '当前系统提示词为空，无法提取模板' });
  const systemPrompt = [
    '你是提示词模板提炼助手。用户会给出当前项目的系统提示词。',
    '请把它提炼为可复用的通用模板：',
    '1) 保留 {{industry}} / {{business_scene}} / {{core_goal}} 等变量占位符，绝不替换成具体值；',
    '2) 去除项目专属的业务细节，保留可复用结构与指令；',
    '3) 语言与输入一致（中文输入输出中文）；',
    '4) 只输出 JSON，不要 Markdown 代码块、不要解释。格式：',
    '{"name":"模板名称（≤20字）","system_prompt":"..."}',
  ].join('\n');
  const userPrompt = `系统提示词：\n${systemPromptIn}`;
  const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 'template_extract');
  const parsed = safeParseJson(rawReply);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return sendJson(res, 500, { success: false, error: '大模型返回内容无法解析为模板 JSON，请重试' });
  }
  const data = {
    name: String(parsed.name || '').trim().slice(0, 100) || `模板-${new Date().toISOString().slice(0, 10)}`,
    system_prompt: typeof parsed.system_prompt === 'string' ? parsed.system_prompt.trim() : systemPromptIn,
  };
  if (!data.system_prompt) {
    return sendJson(res, 500, { success: false, error: '大模型返回的模板内容为空，请重试' });
  }
  sendJson(res, 200, { success: true, data, message: '模板提取成功' });
});

// ---------- 阶段二：AI 润色 ----------

route(['POST'], '/api/ai/polish', async (req, res) => {
  const body = req.body || {};
  const layer = typeof body.layer === 'string' ? body.layer.trim().toUpperCase() : 'SYSTEM';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (layer !== 'SYSTEM') return sendJson(res, 400, { success: false, error: 'layer 必须是 SYSTEM（系统提示词）' });
  if (!content) return sendJson(res, 400, { success: false, error: 'content 不能为空' });
  if (content.length > 1000000) return sendJson(res, 400, { success: false, error: 'content 过长（≤1,000,000 字符）' });
  const polishPrompt = '你是资深 AI 提示词工程师。请润色给定的【系统提示词】：精简冗余、提升指令密度与可执行性，兼顾语音交互与 TTS 播报的自然口语节奏；保留所有 {{变量}} 占位符原样，不改变业务含义。只输出润色后的正文，不要解释、不要 Markdown 代码块。';
  const rawReply = await chatCompletion(DEFAULT_LLM_CONFIG, [
    { role: 'system', content: polishPrompt },
    { role: 'user', content },
  ], 'ai_polish');
  const polished = stripCodeFence(rawReply);
  if (!polished) return sendJson(res, 500, { success: false, error: '大模型返回内容为空，请重试' });
  sendJson(res, 200, { success: true, layer, content: polished, message: '系统提示词润色完成' });
});

// ---------- 阶段三：备份恢复 ----------

route(['GET'], '/api/backup/export', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user || user.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可导出备份' });
  const scope = String(req.query.scope || '') === 'full' ? 'full' : 'business';
  sendJson(res, 200, buildBackupSnapshot(scope));
});

route(['POST'], '/api/backup/import', async (req, res) => {
  const importUser = currentSessionUser(req);
  if (!importUser || importUser.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可导入备份' });
  let validated;
  try {
    validated = validateBackupPayload(req.body);
  } catch (e) {
    return sendJson(res, 400, { success: false, error: `备份校验失败：${e.message}` });
  }
  const importedScope = validated.scope;
  const rowsByTable = validated.tables;
  const tablesToReplace = (importedScope === 'full' ? FULL_BACKUP_TABLES : BACKUP_TABLES).filter((table) => Object.prototype.hasOwnProperty.call(rowsByTable, table));

  // 导入前自动落盘当前全量 JSON 备份（失败即中止，绝不冒险破坏数据）
  let safetyBackupPath = '';
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    safetyBackupPath = path.join(DATA_DIR, `backup-before-import-${Date.now()}.json`);
    fs.writeFileSync(safetyBackupPath, JSON.stringify(buildBackupSnapshot('full')), 'utf8');
  } catch (e) {
    return sendJson(res, 500, { success: false, error: `导入前安全备份失败，已中止导入：${e.message}` });
  }

  const importedCounts = {};
  try {
    const runImport = db.transaction(() => {
      for (const table of tablesToReplace) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of tablesToReplace) {
        const rows = rowsByTable[table] || [];
        importedCounts[table] = rows.length;
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;
          const placeholders = columns.map(() => '?').join(', ');
          db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
            .run(...columns.map((column) => row[column]));
        }
      }
    });
    runImport();
  } catch (e) {
    console.error('[backup] 导入失败，事务已回滚:', e.message, '安全备份:', safetyBackupPath);
    return sendJson(res, 500, { success: false, error: `备份导入失败，事务已回滚：${e.message}`, backup_file: safetyBackupPath });
  }
  console.log('[backup] 备份导入成功:', importedScope, JSON.stringify(importedCounts), '安全备份:', safetyBackupPath);

  let unreadableModelKeys = 0;
  let reloginRequired = false;
  try {
    // business 导入后可能出现指向已不存在项目的孤儿授权/置顶，统一清理
    db.prepare('DELETE FROM project_grants WHERE project_id NOT IN (SELECT id FROM projects)').run();
    db.prepare('DELETE FROM project_pins WHERE project_id NOT IN (SELECT id FROM projects)').run();
    db.prepare("DELETE FROM read_grants WHERE scope_type = 'project' AND scope_id NOT IN (SELECT id FROM projects)").run();
    db.prepare("DELETE FROM read_grants WHERE scope_type = 'company' AND scope_id NOT IN (SELECT id FROM companies)").run();
    db.prepare('DELETE FROM company_pins WHERE company_id NOT IN (SELECT id FROM companies)').run();
    db.prepare('DELETE FROM company_pins WHERE user_id NOT IN (SELECT id FROM users)').run();
    // V1.63：旧全量备份可能只有 project_grants，导入后自动迁入 read_grants（幂等）
    try {
      const legacyGrants = db.prepare('SELECT project_id, grantee_user_id, granted_by, created_at FROM project_grants').all();
      const insertMigrated = db.prepare('INSERT OR IGNORE INTO read_grants (id, scope_type, scope_id, grantee_type, grantee_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const grant of legacyGrants) {
        if (!grant.project_id || !grant.grantee_user_id) continue;
        insertMigrated.run('rg-' + crypto.randomUUID().split('-')[0], 'project', grant.project_id, 'user', grant.grantee_user_id, grant.granted_by || '', grant.created_at || '');
      }
    } catch (e) {
      console.warn('[backup] 旧授权迁入 read_grants 失败（不影响导入）:', e.message);
    }
    refreshAdminUserId();
    if (ADMIN_USER_ID) {
      db.prepare("UPDATE model_configs SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(ADMIN_USER_ID);
    }
    const rows = db.prepare('SELECT id, api_key FROM model_configs').all();
    const updateKey = db.prepare('UPDATE model_configs SET api_key = ? WHERE id = ?');
    for (const row of rows) {
      const stored = String(row.api_key || '');
      if (!stored) continue;
      if (!stored.startsWith('enc:v1:')) {
        updateKey.run(encryptSecret(row.api_key), row.id);
      } else if (!decryptSecret(row.api_key)) {
        unreadableModelKeys += 1;
      }
    }
    const stillThere = db.prepare('SELECT id, status FROM users WHERE id = ?').get(importUser.id);
    if (!stillThere || String(stillThere.status || 'active') !== 'active') {
      destroySessionQuietly(req);
      reloginRequired = true;
    }
    logAction(importUser.id, 'backup_import', 'backup', importedScope, JSON.stringify(importedCounts).slice(0, 500), 'Danger');
  } catch (e) {
    console.warn('[backup] 导入后兼容处理失败:', e.message);
  }

  const warnings = [];
  if (unreadableModelKeys > 0) warnings.push(`有 ${unreadableModelKeys} 个模型 Key 无法解密：跨机迁移需同时复制 data/.vault-key，否则需重新填写`);
  if (reloginRequired) warnings.push('当前账号在新的账号数据中不可用，请重新登录');
  sendJson(res, 200, {
    success: true,
    scope: importedScope,
    message: importedScope === 'full' ? '全量备份导入成功（含账号与权限）' : '业务数据导入成功（账号体系未改动）',
    imported: importedCounts,
    backup_file: safetyBackupPath,
    unreadable_model_keys: unreadableModelKeys,
    relogin_required: reloginRequired,
    warnings,
  });
});

// ---------- 阶段三：项目深拷贝克隆 ----------

route(['POST'], '/api/projects/clone', async (req, res) => {
  const cloneUser = currentSessionUser(req);
  const body = req.body || {};
  const sourceId = typeof body.id === 'string' ? body.id.trim() : '';
  if (!sourceId) return sendJson(res, 400, { success: false, error: '缺少项目 id' });
  // 源项目只需「可读」：公共参考项目、共享只读项目也允许克隆，复制品归执行人所有
  const source = requireProjectAccess(sourceId, cloneUser);
  const targetCompanyId = typeof body.target_company_id === 'string' && body.target_company_id.trim()
    ? body.target_company_id.trim()
    : (source.company_id || '');
  if (targetCompanyId && targetCompanyId !== (source.company_id || '')) {
    requireCompanyAccess(targetCompanyId, cloneUser);
  }
  let newName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!newName) newName = `${source.name || '未命名项目'}（副本）`;
  if (newName.length > 100) return sendJson(res, 400, { success: false, error: '项目名称不能超过 100 个字符' });
  const copyMode = ['latest', 'all', 'none'].includes(body.copy_mode) ? body.copy_mode : 'latest';
  const newProjectId = 'proj-' + crypto.randomUUID().split('-')[0];
  const cloneOwnerId = cloneUser.id;
  const kbRows = db.prepare("SELECT * FROM kb_items WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY rowid ASC").all(sourceId);
  let snapshotRows = [];
  if (copyMode === 'all') {
    snapshotRows = db.prepare("SELECT * FROM snapshots WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY created_at ASC").all(sourceId);
  } else if (copyMode === 'latest') {
    snapshotRows = db.prepare("SELECT * FROM snapshots WHERE project_id = ? AND COALESCE(deleted_at, '') = '' ORDER BY created_at DESC LIMIT 1").all(sourceId);
  }
  const now = new Date().toISOString();
  const counts = db.transaction(() => {
    db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id, context_json, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newProjectId, targetCompanyId, newName, source.target_agent_id || '', source.context_json || '{}', cloneOwnerId);
    const insertKb = db.prepare('INSERT INTO kb_items (id, project_id, question, answer, user_id, structure_mode) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of kbRows) {
      insertKb.run(
        'kb-' + crypto.randomUUID().split('-')[0],
        newProjectId,
        row.question ?? '',
        row.answer ?? '',
        cloneOwnerId,
        row.structure_mode === 'raw' ? 'raw' : 'qa',
      );
    }
    const insertSnapshot = db.prepare('INSERT INTO snapshots (id, project_id, module_versions_json, kb_versions_json, final_prompt_content, eval_run_id, p0_validation_log, created_at, exported_at, eval_pass, eval_score, user_id, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of snapshotRows) {
      const isLatestMode = copyMode === 'latest';
      insertSnapshot.run(
        'snap-' + crypto.randomUUID().split('-')[0],
        newProjectId,
        row.module_versions_json || '[]',
        '{}',
        row.final_prompt_content || '',
        isLatestMode ? '' : (row.eval_run_id || ''),
        isLatestMode ? '' : (row.p0_validation_log || ''),
        isLatestMode ? now : (row.created_at || now),
        null,
        isLatestMode ? 0 : (Number(row.eval_pass) || 0),
        isLatestMode ? 0 : (Number(row.eval_score) || 0),
        cloneOwnerId,
        isLatestMode
          ? `克隆自「${source.name || '未命名项目'}」${row.remark ? ' · ' + row.remark : ''}`.slice(0, 200)
          : (row.remark || ''),
      );
    }
    return { kb: kbRows.length, snapshots: snapshotRows.length };
  })();
  logAction(cloneUser.id, 'project_clone', 'project', newProjectId, `source=${sourceId} target_company=${targetCompanyId} kb=${counts.kb} snapshots=${counts.snapshots} mode=${copyMode}`);
  sendJson(res, 200, {
    success: true,
    message: `克隆成功：项目 + ${counts.kb} 条知识库 + ${counts.snapshots} 条快照（全新 id）`,
    project_id: newProjectId,
    name: newName,
    company_id: targetCompanyId,
    kb_count: counts.kb,
    snapshot_count: counts.snapshots,
  });
});

// ============================================================
// 五、静态资源、404 与错误处理
// ============================================================

// 静态资源（public/）
// /favicon.ico 映射到品牌 logo，消除浏览器默认请求产生的 404 红错（浏览器对 favicon 的 Content-Type 宽容）
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(path.join(PUBLIC_DIR, 'logo.png')).pipe(res);
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// /api/* 未命中 -> JSON 404
app.use('/api', (req, res) => {
  sendJson(res, 404, { success: false, error: '接口不存在', path: req.originalUrl.split('?')[0] });
});

// 非 /api 的 GET 回退到 SPA 首页（仅无扩展名路径；缺失静态资源返回 404，避免被 HTML 掩盖）
app.use((req, res, next) => {
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(req.path);
  if (req.method === 'GET' && !req.path.startsWith('/api') && !hasExtension) {
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
    return sendJson(res, 413, { success: false, code: 'PAYLOAD_TOO_LARGE', error: `请求体过大（文件上限 ${KB_MAX_FILE_MB}MB）` });
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
  console.error(' [X] 端口启动失败 / Failed to bind port ' + PORT);
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
          console.warn(`[!] 端口 ${PORT} 已被占用 / Port ${PORT} is already in use. 正在尝试自动释放...`);
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

/** 局域网模式下探测本机可用 IPv4 地址，启动时直接打印可访问 URL */
function getLanUrls() {
  const urls = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      for (const item of list || []) {
        if (item && item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${PORT}`);
      }
    }
  } catch (e) { /* 探测失败不影响启动 */ }
  return urls;
}

/** 每日自动备份：启动 1 分钟后首次执行，之后每 24 小时；每次备份后做 WAL checkpoint */
let autoBackupTimer = null;
function startAutoBackupScheduler() {
  const runOnce = async (label) => {
    try {
      const file = await createDatabaseBackup('auto');
      console.log(`[backup] ${label}自动备份完成: ${path.basename(file)}`);
    } catch (e) {
      console.warn('[backup] 自动备份失败:', e.message);
    }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  };
  setTimeout(() => { runOnce('首次'); }, 60 * 1000).unref();
  autoBackupTimer = setInterval(() => { runOnce('每日'); }, 24 * 60 * 60 * 1000);
  autoBackupTimer.unref();
}

/** V1.63：回收站过期清理（启动 90 秒后首次，之后每 24 小时；串行删除） */
let recycleTimer = null;
function startRecycleScheduler() {
  const runOnce = () => {
    try { purgeExpiredRecycle(); } catch (e) { console.warn('[recycle] 自动清理失败:', e.message); }
  };
  setTimeout(runOnce, 90 * 1000).unref();
  recycleTimer = setInterval(runOnce, 24 * 60 * 60 * 1000);
  recycleTimer.unref();
}

(async () => {
  console.log('========================================');
  console.log(' NewRock AI Workbench v1.63（纯 Node.js + Express）');
  console.log('========================================');
  console.log(`[server] 数据目录: ${DATA_DIR}`);
  console.log(`[server] 数据库: ${DB_PATH}`);
  console.log(`[server] 静态目录: ${PUBLIC_DIR}`);
  console.log(`[server] 绑定模式: ${LAN_ACCESS ? '局域网（0.0.0.0，放行私有网段）' : '仅本机（127.0.0.1）'}`);
  console.log(`[server] 自助注册: ${SELF_REGISTER_ENABLED ? '开启' : '关闭（由管理员创建账号）'}`);
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
  console.log(`[server] [OK] 服务已启动: http://${HOST}:${PORT}`);
  console.log(`[server] [WEB] 浏览器访问: http://127.0.0.1:${PORT}`);
  if (LAN_ACCESS) {
    const lanUrls = getLanUrls();
    console.log(lanUrls.length ? `[server] [LAN] 局域网访问: ${lanUrls.join('  ')}` : '[server] [LAN] 未检测到可用局域网 IPv4 地址');
  }
  console.log(`[server] [HEALTH] 健康检查: http://127.0.0.1:${PORT}/api/health`);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  startAutoBackupScheduler();
  startRecycleScheduler();
  const latestBackup = listBackupFiles(1)[0];
  if (latestBackup) console.log(`[backup] 最近备份: ${latestBackup.kind}/${latestBackup.name} (${latestBackup.mtime})`);
  console.log('[server] 按 Ctrl+C 停止服务');
})();

// ---- 优雅退出：关闭 HTTP server 与数据库 ----
function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，正在关闭服务...`);
  const finish = () => {
    if (autoBackupTimer) { try { clearInterval(autoBackupTimer); } catch (e) { /* ignore */ } }
    if (recycleTimer) { try { clearInterval(recycleTimer); } catch (e) { /* ignore */ } }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
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
//（注：内容由AI生成）
