// test-data/server-selftest-sprint-v3.mjs
//
// V3.0 阶段一 · server.js 静态自检（无服务器，只读文件 + node --check）
// 运行：node test-data/server-selftest-sprint-v3.mjs
//
// 覆盖任务硬性要求：
// 1) node --check server.js 通过；
// 2) server.js 不得 import/require 任何 plugins/*；
// 3) 监听 3000、express/cors/json/static、日志、/api 404、index.html 回退；
// 4) EADDRINUSE 自动处理（netstat/taskkill 或 Get-NetTCPConnection 提示）；
// 5) 全部 API 路径已内联（24 条，含 models 阶段二预留不实现）；
// 6) DB 初始化：WAL + context_json 迁移 + model_configs 列迁移；
// 7) CQO 生产细节：gate export PROJECT_NAME + no-store；export_zip 用 archiver@8 ZipArchive；
// 8) settings/api-key 安全（masked、原子写 .env、不泄露完整 Key）；
// 9) 无 token 校验逻辑、SIGINT/SIGTERM 优雅退出。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const SERVER_PATH = path.join(ROOT, 'server.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

console.log('============================================================');
console.log(' Prompt Studio V3.0 · server.js 静态自检（无服务器）');
console.log('============================================================');
console.log('');

assert(fs.existsSync(SERVER_PATH), 'server.js 不存在');
const source = fs.readFileSync(SERVER_PATH, 'utf-8');
// 去掉注释后再做「不得出现 xxx」类断言，避免注释误伤
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

console.log('[1] 语法与独立性');
test('server.js 存在且 node --check 通过', () => {
  execSync('node --check server.js', { cwd: ROOT, stdio: 'pipe' });
});

test('server.js 不 import / require 任何 plugins/*（彻底脱离 Cordis）', () => {
  const badImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*plugins\//.exec(source);
  assert(!badImport, `发现 plugins 引用: ${badImport && badImport[0]}`);
  assert(!/cordis/i.test(codeOnly), '代码中不应出现 cordis 加载逻辑');
});

test('不依赖旧插件加载 / webServer 注册 / token 校验', () => {
  assert(!/webServer\.register/.test(codeOnly), '不应再使用 ctx.webServer.register');
  assert(!/req\.query\.token|searchParams\.get\(['"]token|token\s*===/.test(codeOnly), '不应保留 token 校验');
});

console.log('');
console.log('[2] 依赖与中间件');
test('使用 express / cors / better-sqlite3 / dotenv / p-limit', () => {
  for (const dep of ['express', 'cors', 'better-sqlite3', 'dotenv/config', 'p-limit']) {
    assert(source.includes(dep), `缺少依赖 import: ${dep}`);
  }
});

test('监听 3000 端口，启动时打印 URL', () => {
  assert(/const PORT = 3000/.test(source), 'PORT 应为 3000');
  assert(/服务已启动: http:\/\//.test(source), '启动日志应打印 URL');
});

test('express.json({limit:\'10mb\'}) + cors() + express.static(public) + 访问日志', () => {
  assert(/express\.json\(\{\s*limit:\s*'10mb'\s*\}\)/.test(source), '缺少 express.json({limit:\'10mb\'})');
  assert(/app\.use\(cors\(\)\)/.test(source), '缺少 cors()');
  assert(/express\.static\(PUBLIC_DIR/.test(source), '缺少 express.static(public)');
  assert(/res\.on\('finish'/.test(source), '缺少 method/path/耗时访问日志');
});

test('/api/* 未命中返回 JSON 404；非 /api GET 回退 index.html', () => {
  assert(/app\.use\('\/api',\s*\(req, res\)/.test(source), '缺少 /api 404 处理');
  assert(/sendFile\(INDEX_HTML/.test(source), '缺少 index.html 回退');
});

test('EADDRINUSE 自动处理：定位 PID + 强杀 + 重试一次 + 手动释放提示', () => {
  assert(/EADDRINUSE/.test(source), '缺少 EADDRINUSE 分支');
  assert(/netstat -ano -p TCP/.test(source), '缺少 netstat 查询');
  assert(/taskkill \/PID/.test(source), '缺少 taskkill 强杀');
  assert(/Get-NetTCPConnection/.test(source), '缺少手动释放命令提示');
  assert(/tryListen\(true\)/.test(source), '缺少重试一次 listen');
});

console.log('');
console.log('[3] 接口平移完整性（24 条，models 阶段二预留）');
const REQUIRED_ROUTES = [
  '/api/companies', '/api/companies/create', '/api/companies/update', '/api/companies/delete',
  '/api/projects', '/api/projects/create', '/api/projects/update', '/api/projects/delete',
  '/api/context/get', '/api/context/save', '/api/context/extract',
  '/api/kb/parse', '/api/kb/save', '/api/kb/list', '/api/kb/delete',
  '/api/snapshots/create', '/api/snapshots/list', '/api/snapshots/detail',
  '/api/prompt/assemble', '/api/projects/export_zip',
  '/api/gate/export', '/api/eval/run', '/api/chat/reply', '/api/settings/api-key',
];
test(`全部 ${REQUIRED_ROUTES.length} 条 API 路径均已内联注册`, () => {
  const missing = REQUIRED_ROUTES.filter((routePath) => !source.includes(`'${routePath}'`));
  assert(missing.length === 0, `缺少路由: ${missing.join(', ')}`);
});
test('models 三接口按阶段一要求仅预留（未注册）', () => {
  assert(!source.includes("'/api/models'"), '阶段一不应注册 /api/models');
  assert(/阶段二/.test(source), '应保留阶段二说明');
});

console.log('');
console.log('[4] DB 初始化内联');
test('WAL + 全部建表 SQL + context_json 幂等迁移', () => {
  assert(/journal_mode = WAL/.test(source), '缺少 WAL');
  for (const table of ['model_configs', 'companies', 'projects', 'modules', 'module_versions', 'kb_items', 'kb_item_versions', 'snapshots', 'eval_runs']) {
    assert(source.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `缺少建表: ${table}`);
  }
  assert(/PRAGMA table_info\(projects\)/.test(source), '缺少 projects.context_json 迁移检查');
  assert(/ADD COLUMN context_json TEXT DEFAULT '\{\}'/.test(source), '缺少 context_json ALTER');
});
test('model_configs 九列要求 + PRAGMA 检查后 ALTER 补列', () => {
  const requiredModelColumns = ['provider', 'display_name', 'base_url', 'api_key', 'model_name', 'temperature', 'max_context_length', 'is_active'];
  for (const column of requiredModelColumns) {
    assert(new RegExp(`\\['${column}',`).test(source), `model_configs 迁移缺少列: ${column}`);
  }
  assert(/PRAGMA table_info\(model_configs\)/.test(source), '缺少 model_configs 列检查');
});

console.log('');
console.log('[5] 核心复用函数已内联');
test('assemblePrompt（LAYER_ORDER L0,L1,L2,L3.5,L3）/ applyContextReplace / normalizeContext / parseExtractResult', () => {
  assert(/\['L0', 'L1', 'L2', 'L3\.5', 'L3'\]/.test(source), 'LAYER_ORDER 不正确');
  for (const fn of ['function assemblePrompt', 'function applyContextReplace', 'function normalizeContext', 'function parseExtractResult', 'function maskApiKey', 'function validateApiKey', 'function upsertEnvLine', 'function checkL1', 'function evaluateL2', 'function buildChatSystemPrompt', 'function sanitizeChatMessages', 'async function chatCompletion']) {
    assert(source.includes(fn), `缺少内联函数: ${fn}`);
  }
});
test('chatCompletion 保持阶段一行为（config 或 .env，默认 deepseek 配置，p-limit 并发 5）', () => {
  assert(/process\.env\[KEY_NAME\]/.test(source), '应从 .env 读取 DEEPSEEK_API_KEY');
  assert(/https:\/\/api\.deepseek\.com\/v1/.test(source), '缺少默认 base_url');
  assert(/pLimit\(5\)/.test(source), '缺少 p-limit(5) 限流');
});

console.log('');
console.log('[6] CQO 生产级细节');
test('gate export：PROJECT_NAME 实时读 DB + no-store + 403/404 + 去首部换行', () => {
  assert(/SELECT name FROM projects WHERE id = \?/.test(source), 'PROJECT_NAME 应实时读 DB');
  assert(/# PROJECT_NAME: \$\{projectName\}/.test(source), '缺少 PROJECT_NAME 头');
  assert(/Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'/.test(source), '缺少 no-store');
  assert(/'Pragma': 'no-cache'/.test(source), '缺少 Pragma: no-cache');
  assert(/res\.writeHead\(403/.test(source), '缺少未通过 403');
  assert(/Snapshot Not Found/.test(source), '缺少 404');
  assert(/\.replace\(\/\^\\n\+\/, ''\)/.test(source), '缺少去除 prompt 首部换行');
});
test('export_zip：archiver@8 ZipArchive + manifest.json + snapshots/<id>.txt + 原生流式', () => {
  assert(/import \{ ZipArchive \} from 'archiver'/.test(source), '必须使用 archiver@8 命名导出 ZipArchive');
  assert(/new ZipArchive\(\{ zlib: \{ level: 9 \} \}\)/.test(source), '缺少 ZipArchive zlib level 9');
  assert(/manifest\.json/.test(source), '缺少 manifest.json');
  assert(/snapshots\/\$\{s\.id\}\.txt/.test(source), '缺少 snapshots/<id>.txt');
  assert(/archive\.pipe\(res\)/.test(source), '缺少流式 pipe');
  assert(/res\.writeHead\(200, \{[\s\S]{0,200}application\/zip/.test(source), '缺少 zip 响应头');
});
test('settings/api-key 安全：masked + 空值保持 + 非法 400 + 原子写 .env', () => {
  assert(/前 3 \+ '\*\*\*\*' \+ 后 4/.test(source) || /slice\(0, 3\)\}\*\*\*\*\$\{key\.slice\(-4\)/.test(source), 'masked 规则不正确');
  assert(/未提供新 Key，保持原值/.test(source), '缺少空值保持分支');
  assert(/API Key 格式不正确（长度需≥20 且不含空白）/.test(source), '缺少非法 400 文案');
  assert(/renameSync\(tmpPath, ENV_PATH\)/.test(source), '缺少临时文件 + rename 原子写');
  assert(/请求体不是合法 JSON/.test(source), 'JSON 解析失败错误文案缺失（防泄露）');
});

console.log('');
console.log('[7] 退出与健壮性');
test('启动打印路由数 + SIGINT/SIGTERM 关闭 db 与 server', () => {
  assert(/已注册 API 路由: \$\{registeredRoutes\.length\}/.test(source), '缺少路由数量打印');
  assert(/process\.on\('SIGINT'/.test(source) && /process\.on\('SIGTERM'/.test(source), '缺少信号处理');
  assert(/db\.close\(\)/.test(source), '退出时应关闭 db');
  assert(/httpServer\.close\(/.test(source), '退出时应关闭 http server');
});

const total = passed + failed;
console.log('');
console.log('------------------------------------------------------------');
if (failed === 0) {
  console.log(`\u2705 server-selftest v3 全部通过：${passed}/${total} 项`);
  process.exitCode = 0;
} else {
  console.log(`\u274c server-selftest v3 失败：${failed}/${total} 项`);
  for (const f of failures) console.log(`   - ${f.name} :: ${f.error.message}`);
  process.exitCode = 1;
}
