#!/usr/bin/env node
/**
 * NewRock AI Workbench v1.60 · 纯 Node.js + Express 独立服务
 * ============================================================
 * 运行方式：node server.js        监听 http://127.0.0.1:3100（端口可由 .env 的 PORT 覆盖）
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

const PORT = Number(process.env.PORT) || 3100;
const HOST = '127.0.0.1';
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
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
    // 知识库结构标记：raw=保留原结构（智能分块，标题即 question）；qa=大模型提取的问答对（默认，旧数据兼容）
    addColumnIfMissing('kb_items', 'structure_mode', "TEXT DEFAULT 'qa'");
    try {
      database.prepare("UPDATE audit_logs SET level = 'Info' WHERE level IS NULL OR level = ''").run();
    } catch (e) {
      console.error('[v5] 审计日志 level 回填失败（已跳过）:', e.message);
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
            }, messages);
          }
        } catch (dbError) {
          console.warn('[LLM] DB 激活模型调用失败，自动回落 .env:', redactSecrets(dbError && dbError.message ? dbError.message : dbError));
        }
      }
      return requestChatCompletion(buildEnvLlmConfig(callerConfig.temperature), messages);
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
      return await requestChatCompletion(dbConfig, messages);
    } catch (error) {
      // 大模型报错/超时 → 回滚本次试用扣减
      if (usingTrial) rollbackTrial(contextUser.id);
      if (isSuperadmin && route.kind === 'private') {
        // 管理员私有模型失败 → 仍回落 .env（保持既有韧性；不涉及试用）
        try {
          console.warn('[LLM] 管理员私有模型失败，自动回落 .env:', redactSecrets(error && error.message ? error.message : error, [route.key]));
          return await requestChatCompletion(buildEnvLlmConfig(callerConfig.temperature), messages);
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
// Host 头校验（防 DNS rebinding：攻击者用同端口恶意域名解析到 127.0.0.1 后无 Origin 访问本机 API）
function isLocalHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) return false;
  try {
    const u = new URL('http://' + raw);
    return LOCAL_ORIGIN_HOSTS.has(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  } catch { return false; }
}
app.use(cors({
  origin(origin, cb) {
    if (isLocalOrigin(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
// 双重防线：非本机 Origin 或伪造 Host 的 /api 请求一律 403
app.use('/api', (req, res, next) => {
  if (!isLocalOrigin(req.headers.origin)) {
    return res.status(403).json({ success: false, error: '跨站请求被拒绝：仅允许本机同源访问' });
  }
  if (!isLocalHostHeader(req.headers.host)) {
    return res.status(403).json({ success: false, error: 'Host 不被允许：仅限本机访问（防 DNS rebinding）' });
  }
  return next();
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

// ============================================================
// v1.61：认证会话改用 express-session 默认内存存储（MemoryStore，不持久化、不依赖原生 sqlite3）
// 内网单机系统，重启后重新登录即可；不引入任何第三方会话存储包
app.use(session({
  secret: 'newrock-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000 }
}));
// 为每个请求建立用户上下文（供 chatCompletion 试用扣减/模型路由使用；并记录审计 IP）
app.use((req, res, next) => {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
  requestContext.run({ userId: req.session && req.session.userId ? req.session.userId : null, ip }, next);
});

// 白名单：登录页 / 登录注册接口 / 登录页所需静态资源；其余未登录访问一律拦截
const AUTH_WHITELIST_PATHS = new Set(['/login.html', '/api/auth/login', '/api/auth/register', '/api/auth/logout']);
const AUTH_PUBLIC_STATIC_RE = /^\/(logo\.png|favicon\.ico)$/i;
function authGate(req, res, next) {
  const requestPath = req.path;
  if (AUTH_WHITELIST_PATHS.has(requestPath) || AUTH_PUBLIC_STATIC_RE.test(requestPath)) return next();
  const loggedIn = !!(req.session && req.session.userId);
  if (loggedIn) return next();
  if (requestPath.startsWith('/api/')) {
    return sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期，请重新登录' });
  }
  return res.redirect(302, '/login.html');
}
app.use(authGate);

function getSessionUser(req) {
  const userId = req.session && req.session.userId ? String(req.session.userId) : '';
  if (!userId) return null;
  try {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
  } catch (e) { return null; }
}
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    team_id: user.team_id || '',
    need_change_password: Number(user.need_change_password) || 0,
    trial_count: Number(user.trial_count) || 0,
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
    const rows = db.prepare('SELECT id FROM users WHERE team_id = ?').all(user.team_id || '');
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
function requireProjectAccess(projectId, user) {
  const project = projectId ? db.prepare('SELECT * FROM projects WHERE id = ?').get(String(projectId)) : null;
  if (!project) throw httpError(404, '项目不存在或无权访问');
  if (!canAccessOwner(project.user_id, user) && !canReadPublicProject(project, user)) throw httpError(403, '无权访问该项目');
  return project;
}
/** 写操作校验：公共参考项目禁止修改（超管管理场景除外） */
function requireProjectWritable(projectId, user) {
  const project = requireProjectAccess(projectId, user);
  if (Number(project.is_public) === 1 && (!user || user.role !== 'superadmin')) {
    throw httpError(403, '无权修改公共项目');
  }
  return project;
}
/** 已有项目行时的写保护（KB 等通过 project 行校验的场景） */
function assertProjectWritableByRow(project, user) {
  if (project && Number(project.is_public) === 1 && (!user || user.role !== 'superadmin')) {
    throw httpError(403, '无权修改公共项目');
  }
  return project;
}
/** 校验公司访问权 */
function requireCompanyAccess(companyId, user) {
  const company = companyId ? db.prepare('SELECT * FROM companies WHERE id = ?').get(String(companyId)) : null;
  if (!company) throw httpError(404, '客户/行业不存在或无权访问');
  if (!canAccessOwner(company.user_id, user)) throw httpError(403, '无权访问该客户/行业');
  return company;
}
/** 校验快照访问权（优先 user_id，缺失则回落到项目归属） */
function requireSnapshotAccess(snapshotId, user) {
  const snapshot = snapshotId ? db.prepare('SELECT * FROM snapshots WHERE id = ?').get(String(snapshotId)) : null;
  if (!snapshot) throw httpError(404, '快照不存在或无权访问');
  let ownerId = snapshot.user_id;
  let projectRow = null;
  if (snapshot.project_id) {
    projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(snapshot.project_id) || null;
    if (!ownerId && projectRow) ownerId = projectRow.user_id;
  }
  if (!canAccessOwner(ownerId, user) && !(projectRow && canReadPublicProject(projectRow, user))) throw httpError(403, '无权访问该快照');
  return snapshot;
}
/** 校验知识库条目访问权（回落到所属项目） */
function requireKbAccess(kbId, user) {
  const item = kbId ? db.prepare('SELECT * FROM kb_items WHERE id = ?').get(String(kbId)) : null;
  if (!item) throw httpError(404, '知识条目不存在或无权访问');
  const project = item.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(item.project_id) : null;
  if (!project || !canAccessOwner(project.user_id, user)) throw httpError(403, '无权访问该知识条目');
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
route(['POST'], '/api/auth/register', async (req, res) => {
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
    db.prepare('INSERT INTO users (id, username, password_hash, role, team_id, need_change_password, trial_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, bcrypt.hashSync(password, 10), 'user', '', 0, 0, new Date().toISOString());
  } catch (e) {
    return sendJson(res, 409, { success: false, error: '注册失败：账号已存在' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.save((err) => {
    if (err) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
    logAction(user.id, 'register', 'user', user.id, `username=${user.username}`);
    return sendJson(res, 200, { success: true, user: publicUser(user) });
  });
});

route(['POST'], '/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return sendJson(res, 400, { success: false, error: '请输入账号和密码' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return sendJson(res, 401, { success: false, error: '账号或密码错误' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.save((err) => {
    if (err) return sendJson(res, 500, { success: false, error: '会话保存失败，请重试' });
    logAction(user.id, 'login', 'user', user.id, `role=${user.role}`);
    return sendJson(res, 200, { success: true, user: publicUser(user) });
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

route(['GET'], '/api/admin/users', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user || !['superadmin', 'teamadmin'].includes(user.role)) return sendJson(res, 403, { success: false, error: '需要管理权限' });
  let rows;
  if (user.role === 'superadmin') {
    rows = db.prepare('SELECT id, username, role, team_id, need_change_password, trial_count, created_at FROM users ORDER BY created_at ASC').all();
  } else {
    rows = db.prepare('SELECT id, username, role, team_id, need_change_password, trial_count, created_at FROM users WHERE team_id = ? ORDER BY created_at ASC').all(user.team_id || '');
  }
  sendJson(res, 200, { success: true, data: rows });
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
  db.prepare('UPDATE users SET password_hash = ?, need_change_password = 1 WHERE id = ?').run(bcrypt.hashSync('123456', 10), target.id);
  logAction(admin.id, 'admin_reset_password', 'user', target.id, 'reset to 123456');
  sendJson(res, 200, { success: true, message: '密码已重置为 123456，用户下次登录需修改密码' });
});

route(['POST'], '/api/admin/users/assign-team', async (req, res) => {
  const admin = currentSessionUser(req);
  if (!admin || admin.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可分配团队' });
  const body = req.body || {};
  const targetId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const teamId = typeof body.team_id === 'string' ? body.team_id.trim() : '';
  const target = targetId ? db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) : null;
  if (!target) return sendJson(res, 404, { success: false, error: '用户不存在' });
  if (teamId && !db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) return sendJson(res, 404, { success: false, error: '团队不存在' });
  const nextRole = body.role === 'teamadmin' ? 'teamadmin' : (target.role === 'teamadmin' ? 'user' : target.role);
  db.prepare('UPDATE users SET team_id = ?, role = ? WHERE id = ?').run(teamId, nextRole === 'superadmin' ? 'superadmin' : nextRole, target.id);
  logAction(admin.id, 'assign_team', 'user', target.id, `team=${teamId} role=${nextRole}`);
  sendJson(res, 200, { success: true, message: '团队分配成功' });
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
  const rows = db.prepare('SELECT id, question, answer FROM kb_items WHERE project_id = ? ORDER BY rowid ASC').all(projectId);
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
  const rows = db.prepare('SELECT id, question, answer, structure_mode FROM kb_items WHERE project_id = ?').all(projectId);
  sendJson(res, 200, { success: true, data: rows });
});

route(['POST'], '/api/kb/delete', async (req, res) => {
  const body = req.body || {};
  if (!body.id) return sendJson(res, 400, { error: '缺少 ID' });
  const user = currentSessionUser(req);
  const kbAccess = requireKbAccess(body.id, user);
  assertProjectWritableByRow(kbAccess.project, user);
  db.prepare('DELETE FROM kb_items WHERE id = ?').run(body.id);
  db.prepare('UPDATE kb_item_versions SET is_deleted = 1 WHERE item_id = ?').run(body.id);
  logAction(user.id, 'kb_delete', 'kb', body.id, '');
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
  db.prepare('INSERT INTO snapshots (id, project_id, module_versions_json, final_prompt_content, created_at, eval_pass, eval_score, user_id, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(snapshotId, project_id, JSON.stringify(layers), prompt, now, 1, 5.0, snapshotUser.id, snapshotRemark);

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
  requireProjectAccess(req.query.project_id, currentSessionUser(req));
  const rows = db.prepare('SELECT id, created_at, eval_pass, eval_score, remark FROM snapshots WHERE project_id = ? ORDER BY created_at DESC').all(req.query.project_id);
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
  const info = db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  sendJson(res, 200, { success: true, deleted: info.changes, id });
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
  const user = currentSessionUser(req);
  const ids = visibleOwnerIds(user);
  if (ids === null) {
    return sendJson(res, 200, { success: true, data: db.prepare('SELECT * FROM companies').all() });
  }
  const publicCompanySql = "id IN (SELECT company_id FROM projects WHERE is_public = 1 AND (public_scope = 'global' OR public_scope IS NULL OR public_scope = ''))";
  const rows = ids.length === 0
    ? db.prepare(`SELECT * FROM companies WHERE ${publicCompanySql}`).all()
    : db.prepare(`SELECT * FROM companies WHERE user_id IN (${ids.map(() => '?').join(', ')}) OR ${publicCompanySql}`).all(...ids);
  sendJson(res, 200, { success: true, data: rows });
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
  db.prepare('DELETE FROM companies WHERE id = ?').run(body.id);
  db.prepare('DELETE FROM projects WHERE company_id = ?').run(body.id);
  logAction(user.id, 'company_delete', 'company', body.id, '');
  sendJson(res, 200, { success: true, message: '删除成功' });
});

route(['GET'], '/api/projects', async (req, res) => {
  const user = currentSessionUser(req);
  const ids = visibleOwnerIds(user);
  if (ids === null) {
    return sendJson(res, 200, { success: true, data: db.prepare('SELECT * FROM projects').all() });
  }
  const publicProjectSql = "is_public = 1 AND (public_scope = 'global' OR public_scope IS NULL OR public_scope = '')";
  const rows = ids.length === 0
    ? db.prepare(`SELECT * FROM projects WHERE ${publicProjectSql}`).all()
    : db.prepare(`SELECT * FROM projects WHERE user_id IN (${ids.map(() => '?').join(', ')}) OR (${publicProjectSql})`).all(...ids);
  sendJson(res, 200, { success: true, data: rows });
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
  db.prepare('DELETE FROM projects WHERE id = ?').run(body.id);
  logAction(user.id, 'project_delete', 'project', body.id, '');
  sendJson(res, 200, { success: true, message: '删除成功' });
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

// 阶段四：AI 生成「刁钻」测试题（服务端正则提取 JSON 数组 + 结构校验兜底）
route(['POST'], '/api/eval/generate_questions', async (req, res) => {
  const body = req.body || {};
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  const quizUser = currentSessionUser(req);
  if (projectId) requireProjectAccess(projectId, quizUser);
  // v1.60 重构：默认至少生成 15 个用例（允许 15-30 个）
  const requestedCount = Number(body.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 15 && requestedCount <= 30 ? requestedCount : 15;

  // v1.60：随机抽取当前项目知识库内容，数量取 Math.min(30, 知识库总数)，不死写 30 导致空指针
  const EVAL_KB_MAX = 3000;
  let kbText = '';
  if (projectId) {
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM kb_items WHERE project_id = ?').get(projectId);
    const total = totalRow ? Number(totalRow.n) || 0 : 0;
    const sampleCount = Math.min(30, total);
    if (sampleCount > 0) {
      // SQLite ORDER BY RANDOM() 实现随机抽样，LIMIT 用实际样本数
      const rows = db.prepare('SELECT question, answer FROM kb_items WHERE project_id = ? ORDER BY RANDOM() LIMIT ?').all(projectId, sampleCount);
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
    ]);
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
  const rows = db.prepare('SELECT question, answer FROM kb_items WHERE project_id = ? ORDER BY rowid ASC').all(projectId);
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
  if (project_id) requireProjectAccess(project_id, currentSessionUser(req));

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
  sendJson(res, 200, { success: true, data: rows.map(toPublicModel) });
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

  // 单活模型：仅重置当前用户自己的模型（多租户互不影响）
  if (wantActive) db.prepare('UPDATE model_configs SET is_active = 0 WHERE user_id = ?').run(currentUser.id);

  if (existing) {
    const isActive = isActiveSpecified ? (wantActive ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE model_configs SET provider = ?, display_name = ?, base_url = ?, api_key = ?, model_name = ?, temperature = ?, is_active = ? WHERE id = ?')
      .run(provider, displayName, baseUrl, apiKeyStored, modelName, temperature, isActive, id);
    logAction(currentUser.id, 'model_save', 'model', id, `provider=${provider} base=${baseUrl}`);
    return sendJson(res, 200, { success: true, message: '模型配置已更新', id, is_active: isActive });
  }

  const maxContextLength = Number.isFinite(Number(body.max_context_length)) ? Number(body.max_context_length) : 32000;
  db.prepare('INSERT INTO model_configs (id, provider, display_name, base_url, api_key, model_name, temperature, max_context_length, is_active, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, provider, displayName, baseUrl, apiKeyStored, modelName, temperature, maxContextLength, wantActive ? 1 : 0, currentUser.id);
  logAction(currentUser.id, 'model_save', 'model', id, `provider=${provider} base=${baseUrl}`);
  sendJson(res, 200, { success: true, message: '模型配置已保存', id, is_active: wantActive ? 1 : 0 });
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

/** 去除大模型输出里的 Markdown 代码围栏 */
function stripCodeFence(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
  return s.trim();
}

/** 导出全部表为 JSON 快照对象 */
function buildBackupSnapshot() {
  const snapshot = {
    success: true,
    app: 'newrock-ai-workbench',
    version: 1,
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const table of BACKUP_TABLES) snapshot.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  return snapshot;
}

/** 备份导入严格校验：表名白名单 / 必须包含全部表 / 每行对象 / 字段白名单 / 基本类型校验 */
function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('备份内容必须是 JSON 对象');
  const tables = payload.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw new Error('备份缺少 tables 对象');
  const unknownTables = Object.keys(tables).filter((name) => !BACKUP_TABLES.includes(name));
  if (unknownTables.length > 0) throw new Error(`备份包含未知数据表：${unknownTables.join(', ')}`);
  const missingTables = BACKUP_TABLES.filter((name) => !Object.prototype.hasOwnProperty.call(tables, name));
  if (missingTables.length > 0) throw new Error(`备份缺少数据表：${missingTables.join(', ')}`);

  const columnCache = new Map();
  const rowsByTable = {};
  for (const table of BACKUP_TABLES) {
    const rows = tables[table];
    if (!Array.isArray(rows)) throw new Error(`表 ${table} 必须是数组`);
    if (!columnCache.has(table)) {
      columnCache.set(table, db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    }
    const allowedColumns = columnCache.get(table);
    rowsByTable[table] = rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`表 ${table} 第 ${index + 1} 行必须是对象`);
      // 所有表均以 id 为主键：缺失/非法主键一律拒绝（防脏数据进入事务）
      if (typeof row.id !== 'string' || !row.id.trim()) throw new Error(`表 ${table} 第 ${index + 1} 行缺少主键 id`);
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
  return rowsByTable;
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
  ]);
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
  ]);
  const polished = stripCodeFence(rawReply);
  if (!polished) return sendJson(res, 500, { success: false, error: '大模型返回内容为空，请重试' });
  sendJson(res, 200, { success: true, layer, content: polished, message: '系统提示词润色完成' });
});

// ---------- 阶段三：备份恢复 ----------

route(['GET'], '/api/backup/export', async (req, res) => {
  const user = currentSessionUser(req);
  if (!user || user.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可导出全量备份' });
  sendJson(res, 200, buildBackupSnapshot());
});

route(['POST'], '/api/backup/import', async (req, res) => {
  const importUser = currentSessionUser(req);
  if (!importUser || importUser.role !== 'superadmin') return sendJson(res, 403, { success: false, error: '仅超级管理员可导入全量备份' });
  let rowsByTable;
  try {
    rowsByTable = validateBackupPayload(req.body);
  } catch (e) {
    return sendJson(res, 400, { success: false, error: `备份校验失败：${e.message}` });
  }

  // 导入前自动落盘当前全量 JSON 备份（失败即中止，绝不冒险破坏数据）
  let safetyBackupPath = '';
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    safetyBackupPath = path.join(DATA_DIR, `backup-before-import-${Date.now()}.json`);
    fs.writeFileSync(safetyBackupPath, JSON.stringify(buildBackupSnapshot()), 'utf8');
  } catch (e) {
    return sendJson(res, 500, { success: false, error: `导入前安全备份失败，已中止导入：${e.message}` });
  }

  const importedCounts = {};
  try {
    const runImport = db.transaction(() => {
      for (const table of BACKUP_TABLES) db.prepare(`DELETE FROM ${table}`).run();
      for (const table of BACKUP_TABLES) {
        const rows = rowsByTable[table];
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
  console.log('[backup] 备份导入成功:', JSON.stringify(importedCounts), '安全备份:', safetyBackupPath);
  // 兼容旧备份：补齐 user_id 归属并加密明文模型 Key（在事务外执行，失败不影响已导入数据）
  try {
    if (ADMIN_USER_ID) {
      for (const table of BACKUP_TABLES) {
        if (table === 'model_configs') db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL OR user_id = ''`).run(ADMIN_USER_ID);
      }
    }
    const rows = db.prepare('SELECT id, api_key FROM model_configs').all();
    const updateKey = db.prepare('UPDATE model_configs SET api_key = ? WHERE id = ?');
    for (const row of rows) {
      if (row.api_key && !String(row.api_key).startsWith('enc:v1:')) updateKey.run(encryptSecret(row.api_key), row.id);
    }
    logAction(importUser.id, 'backup_import', 'backup', '', JSON.stringify(importedCounts).slice(0, 500));
  } catch (e) {
    console.warn('[backup] 导入后 user_id/Key 兼容处理失败:', e.message);
  }
  sendJson(res, 200, { success: true, message: '备份导入成功（全部表已替换）', imported: importedCounts, backup_file: safetyBackupPath });
});

// ---------- 阶段三：项目深拷贝克隆 ----------

route(['POST'], '/api/projects/clone', async (req, res) => {
  const cloneUser = currentSessionUser(req);
  const sourceId = typeof (req.body || {}).id === 'string' ? req.body.id.trim() : '';
  if (!sourceId) return sendJson(res, 400, { success: false, error: '缺少项目 id' });
  requireProjectAccess(sourceId, cloneUser);
  const source = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId);
  if (!source) return sendJson(res, 404, { success: false, error: '源项目不存在' });
  const newProjectId = 'proj-' + crypto.randomUUID().split('-')[0];
  const newName = `${source.name || '未命名项目'}（副本）`;
  const cloneOwnerId = cloneUser.id;
  const kbRows = db.prepare('SELECT * FROM kb_items WHERE project_id = ?').all(sourceId);
  const clone = db.transaction(() => {
    db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id, context_json, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newProjectId, source.company_id, newName, source.target_agent_id || '', source.context_json || '{}', cloneOwnerId);
    const kbIds = [];
    for (const row of kbRows) {
      const newKbId = 'kb-' + crypto.randomUUID().split('-')[0];
      db.prepare('INSERT INTO kb_items (id, project_id, question, answer, user_id) VALUES (?, ?, ?, ?, ?)')
        .run(newKbId, newProjectId, row.question ?? '', row.answer ?? '', cloneOwnerId);
      kbIds.push(newKbId);
    }
    return kbIds;
  });
  const newKbIds = clone();
  logAction(cloneUser.id, 'project_clone', 'project', newProjectId, `source=${sourceId} kb=${newKbIds.length}`);
  sendJson(res, 200, {
    success: true,
    message: `克隆成功：项目 + ${newKbIds.length} 条知识库记录已复制（全新 id）`,
    project_id: newProjectId,
    name: newName,
    kb_count: newKbIds.length,
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

(async () => {
  console.log('========================================');
  console.log(' NewRock AI Workbench v1.60（纯 Node.js + Express）');
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
  console.log(`[server] [OK] 服务已启动: http://${HOST}:${PORT}`);
  console.log(`[server] [WEB] 浏览器访问: http://${HOST}:${PORT}`);
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
//（注：内容由AI生成）
