// V4.0 后端 HTTP 自测（针对运行中的 3000 服务，不启动/停止任何服务）
const BASE = 'http://127.0.0.1:3000';
const DB_PATH = 'D:/prompt-studio/data/prompt-studio.db';
const results = [];
let failed = 0;
function check(name, ok, detail) {
  const item = { name, ok: !!ok, detail: detail === undefined ? null : detail };
  results.push(item);
  if (!item.ok) failed++;
  console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${name}${detail !== undefined && detail !== null ? ' | ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}
async function req(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, options);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);

// ===== 基础可用性 =====
const health = await get('/api/companies');
check('3000 服务可用（GET /api/companies）', health.status === 200 && Array.isArray(health.body.data));

// ===== 阶段一：模板库 =====
const tplSave = await post('/api/templates/save', {
  name: 'V4-HTTP-模板A',
  l0_content: '你是面向 {{industry}} 的语音助手。',
  l1_content: '保持自然口语。',
  l3_content: '核心目标：{{core_goal}}。',
});
check('模板 save 新建', tplSave.status === 200 && tplSave.body.success && !!tplSave.body.id, tplSave.body && { id: tplSave.body.id });
const tplId = tplSave.body && tplSave.body.id;
let tplList = await get('/api/templates');
check('模板 list 含新建模板', tplList.status === 200 && Array.isArray(tplList.body.data) && tplList.body.data.some((t) => t.id === tplId));
const tplUpdate = await post('/api/templates/save', { id: tplId, name: 'V4-HTTP-模板A-改', l0_content: 'L0 v2', l1_content: 'L1 v2', l3_content: 'L3 v2' });
check('模板 save 更新（同 id）', tplUpdate.status === 200 && tplUpdate.body.success && tplUpdate.body.message.includes('更新'));
const tplBad = await post('/api/templates/save', { name: '', l0_content: 'x' });
check('模板 save 空名称校验 → 400', tplBad.status === 400);
const extract = await post('/api/templates/extract', {
  l0_content: '你是面向 {{industry}} 领域的智能语音助手，当前业务场景为 {{business_scene}}，核心目标 {{core_goal}}。请保持专业并遵守安全规范。',
  l1_content: '保持自然口语，适合电话播报，避免书面语。',
  l3_content: '项目专属话术：退换货请引导用户提供订单号；停车缴费问题请核实车牌。',
});
const extractData = extract.body && extract.body.data;
check('模板 extract（LLM 分析）返回三层', extract.status === 200 && extract.body.success && extractData && typeof extractData.l0_content === 'string' && typeof extractData.l1_content === 'string' && typeof extractData.l3_content === 'string' && (extractData.l0_content + extractData.l1_content + extractData.l3_content).trim().length > 0, extractData ? { name: extractData.name, lens: [extractData.l0_content.length, extractData.l1_content.length, extractData.l3_content.length] } : extract.body);
check('extract 保留 {{变量}} 占位符', extractData && (extractData.l0_content + extractData.l1_content + extractData.l3_content).includes('{{'), extractData ? { hasBrace: (extractData.l0_content + extractData.l1_content + extractData.l3_content).includes('{{') } : null);
const tplDel = await post('/api/templates/delete', { id: tplId });
check('模板 delete', tplDel.status === 200 && tplDel.body.success);
tplList = await get('/api/templates');
check('模板 delete 后列表不含该 id', !tplList.body.data.some((t) => t.id === tplId));

// ===== 阶段二：AI 润色 =====
const polish0 = await post('/api/ai/polish', { layer: 'L0', content: '你是面向{{industry}}领域的智能语音助手。请注意，务必，一定要保持专业、礼貌、热情、耐心，不要使用书面语。' });
check('AI polish L0 返回正文', polish0.status === 200 && polish0.body.success && typeof polish0.body.content === 'string' && polish0.body.content.trim().length > 0 && !/```/.test(polish0.body.content), polish0.body && { layer: polish0.body.layer, len: (polish0.body.content || '').length });
const polish1 = await post('/api/ai/polish', { layer: 'L1', content: '语音基座：电话沟通时请保持自然口语。' });
check('AI polish L1 生效', polish1.status === 200 && polish1.body.success && typeof polish1.body.content === 'string');
const polishBadLayer = await post('/api/ai/polish', { layer: 'LX', content: 'x' });
check('AI polish 非法 layer → 400', polishBadLayer.status === 400);
const polishEmpty = await post('/api/ai/polish', { layer: 'L0', content: '' });
check('AI polish 空 content → 400', polishEmpty.status === 400);

// ===== 阶段三：备份导出 / 导入 =====
const export1 = await get('/api/backup/export');
const expectedTables = ['model_configs', 'companies', 'projects', 'modules', 'module_versions', 'kb_items', 'kb_item_versions', 'snapshots', 'eval_runs', 'prompt_templates'];
const exportTables = export1.body && export1.body.tables ? Object.keys(export1.body.tables) : [];
check('备份导出含全部 10 表', export1.status === 200 && expectedTables.every((t) => exportTables.includes(t)), { got: exportTables });
const counts1 = {};
for (const t of expectedTables) counts1[t] = (export1.body.tables[t] || []).length;
check('备份各表均为数组', expectedTables.every((t) => Array.isArray(export1.body.tables[t])), counts1);

const importSame = await post('/api/backup/import', export1.body);
check('备份原样导入成功（DELETE 全部 + INSERT）', importSame.status === 200 && importSame.body.success && importSame.body.imported, importSame.body && { imported: importSame.body.imported });
const export2 = await get('/api/backup/export');
const counts2 = {};
for (const t of expectedTables) counts2[t] = (export2.body.tables[t] || []).length;
check('原样导入后行数完全一致', expectedTables.every((t) => counts2[t] === counts1[t]), { before: counts1, after: counts2 });

const badNoTables = await post('/api/backup/import', { version: 1 });
check('缺 tables → 400', badNoTables.status === 400);
const badMissing = JSON.parse(JSON.stringify(export1.body)); delete badMissing.tables.snapshots;
check('缺数据表 → 400', (await post('/api/backup/import', badMissing)).status === 400);
const badRow = JSON.parse(JSON.stringify(export1.body)); badRow.tables.snapshots = [42];
check('行类型非法 → 400', (await post('/api/backup/import', badRow)).status === 400);
const badUnknownTable = JSON.parse(JSON.stringify(export1.body)); badUnknownTable.tables.hacker_table = [];
check('未知数据表 → 400', (await post('/api/backup/import', badUnknownTable)).status === 400);
const badField = JSON.parse(JSON.stringify(export1.body));
if (badField.tables.companies.length > 0) badField.tables.companies[0].hacker_field = 'x';
check('未知字段 → 400', (await post('/api/backup/import', badField)).status === 400);
const export3 = await get('/api/backup/export');
const counts3 = {};
for (const t of expectedTables) counts3[t] = (export3.body.tables[t] || []).length;
check('非法导入全部被拒且数据未破坏', expectedTables.every((t) => counts3[t] === counts1[t]), { after: counts3 });

// ===== 阶段三：项目深拷贝克隆 =====
const companies = (await get('/api/companies')).body.data || [];
const companyId = companies[0] && companies[0].id;
const srcProj = await post('/api/projects/create', { company_id: companyId, name: 'V4-HTTP-克隆源' });
const srcId = srcProj.body && srcProj.body.id;
check('创建克隆源项目', srcProj.status === 200 && !!srcId);
await post('/api/kb/save', { project_id: srcId, pairs: [{ question: 'V4克隆Q1', answer: 'V4克隆A1' }, { question: 'V4克隆Q2', answer: 'V4克隆A2' }] });
const srcKb = (await get(`/api/kb/list?project_id=${srcId}`)).body.data || [];
check('源项目知识库 2 条', srcKb.length === 2);
const clone = await post('/api/projects/clone', { id: srcId });
const cloneId = clone.body && clone.body.project_id;
check('克隆成功且 kb_count=2', clone.status === 200 && clone.body.success && !!cloneId && cloneId !== srcId && clone.body.kb_count === 2, clone.body && { project_id: cloneId, kb_count: clone.body.kb_count });
const allProjects = (await get('/api/projects')).body.data || [];
const clonedRow = allProjects.find((p) => p.id === cloneId);
const srcRow = allProjects.find((p) => p.id === srcId);
check('克隆项目为新 id 且源项目保留', !!clonedRow && !!srcRow && clonedRow.id !== srcRow.id && clonedRow.name.includes('副本'), clonedRow && { name: clonedRow.name });
const cloneKb = (await get(`/api/kb/list?project_id=${cloneId}`)).body.data || [];
const srcIds = new Set(srcKb.map((k) => k.id));
let cloneKbLinked = false;
let cloneKbDbRows = 0;
try {
  const Database = (await import('better-sqlite3')).default;
  const rdb = new Database(DB_PATH, { readonly: true });
  cloneKbDbRows = rdb.prepare('SELECT COUNT(*) AS n FROM kb_items WHERE project_id = ?').get(cloneId).n;
  rdb.close();
  cloneKbLinked = cloneKbDbRows === 2;
} catch (e) { cloneKbLinked = false; }
check('克隆知识库 2 条且关联新项目（DB 校验 project_id）', cloneKb.length === 2 && cloneKbLinked, { apiCount: cloneKb.length, dbLinkedCount: cloneKbDbRows });
check('克隆知识库全部新 id（不共用旧数据）', cloneKb.length === 2 && cloneKb.every((k) => !srcIds.has(k.id)) && new Set(cloneKb.map((k) => k.id)).size === 2);
check('克隆不存在项目 → 404', (await post('/api/projects/clone', { id: 'proj-not-exist' })).status === 404);
// 清理克隆测试数据
for (const k of cloneKb) await post('/api/kb/delete', { id: k.id });
for (const k of srcKb) await post('/api/kb/delete', { id: k.id });
await post('/api/projects/delete', { id: cloneId });
await post('/api/projects/delete', { id: srcId });
const projectsAfter = (await get('/api/projects')).body.data || [];
check('克隆测试数据清理完成', !projectsAfter.some((p) => p.id === cloneId || p.id === srcId));

// ===== 原功能回归：生成快照 =====
const trip = projectsAfter.find((p) => p.name && p.name.includes('Trip旅游')) || projectsAfter[0];
const snap = await post('/api/snapshots/create', {
  project_id: trip.id,
  layers: [
    { layer: 'L0', name: '全局安全', content: 'V4 回归：面向 {{industry}} 的语音助手。' },
    { layer: 'L1', name: '语音基座', content: '保持自然口语。' },
    { layer: 'L3', name: '项目话术', content: '项目话术：目标 {{core_goal}}。' },
  ],
  context_data: { industry: '旅游行业', business_scene: ['售后'], core_goal: ['安抚情绪'] },
});
check('原生成快照正常（语境替换）', snap.status === 200 && snap.body.success && typeof snap.body.final_prompt === 'string' && snap.body.final_prompt.includes('旅游行业'), snap.body && { snapshot_id: snap.body.snapshot_id, promptLen: (snap.body.final_prompt || '').length });
const snapId = snap.body && snap.body.snapshot_id;
const snapDetail = snapId ? await get(`/api/snapshots/detail?id=${snapId}`) : { status: 0, body: null };
check('快照 detail 可回读', snapDetail.status === 200 && snapDetail.body.success && !!snapDetail.body.data);
const snapList = await get(`/api/snapshots/list?project_id=${trip.id}`);
check('快照列表接口正常', snapList.status === 200 && Array.isArray(snapList.body.data) && snapList.body.data.some((s) => s.id === snapId));

// 清理测试快照（直接删 DB 行，避免污染业务数据）
try {
  const Database = (await import('better-sqlite3')).default;
  const cleanupDb = new Database(DB_PATH);
  if (snapId) cleanupDb.prepare('DELETE FROM snapshots WHERE id = ?').run(snapId);
  cleanupDb.prepare("DELETE FROM kb_item_versions WHERE item_id IN (SELECT id FROM kb_items WHERE question LIKE 'V4克隆%')").run();
  cleanupDb.close();
  check('测试快照/KB 版本残留清理', true);
} catch (e) {
  check('测试快照/KB 版本残留清理', false, e.message);
}

console.log('\n========== RESULT ==========');
console.log(JSON.stringify({ total: results.length, failed }, null, 2));
console.log(failed === 0 ? 'ALL_V4_HTTP_BACKEND_TESTS_PASSED' : `V4_HTTP_BACKEND_TESTS_FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
