// plugins/db.js
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'prompt-studio.db');

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  
  // 建表语句
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_configs ( id TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, model_name TEXT NOT NULL, temperature REAL DEFAULT 0.1, max_context_length INTEGER NOT NULL DEFAULT 32000, is_active INTEGER DEFAULT 1 );
    CREATE TABLE IF NOT EXISTS companies ( id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL );
    CREATE TABLE IF NOT EXISTS projects ( id TEXT PRIMARY KEY, company_id TEXT, name TEXT NOT NULL, target_agent_id TEXT, context_json TEXT DEFAULT '{}' );
    CREATE TABLE IF NOT EXISTS modules ( id TEXT PRIMARY KEY, layer TEXT, name TEXT, sensitivity TEXT DEFAULT 'P2' );
    CREATE TABLE IF NOT EXISTS module_versions ( id TEXT PRIMARY KEY, module_id TEXT, version TEXT, content TEXT );
    CREATE TABLE IF NOT EXISTS kb_items ( id TEXT PRIMARY KEY, project_id TEXT, question TEXT, answer TEXT );
    CREATE TABLE IF NOT EXISTS kb_item_versions ( id TEXT PRIMARY KEY, item_id TEXT, version_hash TEXT, content TEXT, is_deleted INTEGER DEFAULT 0 );
    CREATE TABLE IF NOT EXISTS snapshots ( id TEXT PRIMARY KEY, project_id TEXT, module_versions_json TEXT, kb_versions_json TEXT, final_prompt_content TEXT, eval_run_id TEXT, p0_validation_log TEXT, created_at TEXT, exported_at TEXT, eval_pass INTEGER DEFAULT 0, eval_score REAL DEFAULT 0 );
    CREATE TABLE IF NOT EXISTS eval_runs ( id TEXT PRIMARY KEY, snapshot_id TEXT, l1_pass_rate REAL, l2_avg_score REAL, status TEXT );
  `)

  // 兼容旧数据库：如果缺少 eval_pass 和 eval_score 字段，自动加上
  try {
    const columns = db.prepare("PRAGMA table_info(snapshots)").all();
    if (!columns.some(c => c.name === 'eval_pass')) {
      db.exec("ALTER TABLE snapshots ADD COLUMN eval_pass INTEGER DEFAULT 0;");
      db.exec("ALTER TABLE snapshots ADD COLUMN eval_score REAL DEFAULT 0;");
    }
  } catch (e) {
    console.error("数据库升级检查失败，如遇报错请手动删除 data/prompt-studio.db 重新初始化", e);
  }

  // 兼容旧数据库：V2.0 模块二「AI 语境提取」需要 projects.context_json 字段（幂等、非破坏）
  try {
    const projectColumns = db.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some(c => c.name === 'context_json')) {
      db.exec("ALTER TABLE projects ADD COLUMN context_json TEXT DEFAULT '{}';");
    }
  } catch (e) {
    console.error("数据库升级检查失败（projects.context_json），如遇报错请手动删除 data/prompt-studio.db 重新初始化", e);
  }

  return db;
}

export const db = initDb();