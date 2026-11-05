// V4.0 后端集成测试：在 3100 端口起测试实例（不触碰 3000 运行中的服务），
// 覆盖模板 CRUD/提取、AI 润色、备份导出导入（含非法结构回滚）、项目深拷贝克隆、原快照生成。
process.env.PORT = '3100';
process.chdir('D:/prompt-studio');
const BASE = 'http://127.0.0.1:3100';
const DB_PATH = 'D:/prompt-studio/data/prompt-studio.db';

const results = [];
let failed = 0;
function check(name, ok, detail) {
  const item = { name, ok: !!ok, detail: detail === undefined ? null : detail };
  results.push(item);
  if (!item.ok) failed++;
  console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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

// 等待测试实例就绪（server.js 启动时会自动建表）
let ready = false;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(BASE + '/api/companies');
    if (r.status === 200) { ready = true; break; }
  } catch { /* 等待 */ }
  await sleep(150);
}
if (!ready) { console.log('FATAL: 测试实例 3100 未就绪'); process.exit(2); }
check('测试实例启动（3100，独立于 3000）', true);

// ========== 阶段一：模板库 ==========
const tplSave = await post('/api/templates/save', {
  name: 'V4-BACKEND-模板A',
  l0_content: '你是面向 {{industry}} 的语音助手。',
  l1_content: '保持自然口语。',
  l3_content: '核心目标：{{core_goal}}。',
});
check('模板 save 新建', tplSave.status === 200 && tplSave.body && tplSave.body.success && !!tplSave.body.id, tplSave.body);
const tplId = tplSave.body && tplSave.body.id;
let tplList = await get('/api/templates');
check('模板 list 含新建模板', tplList.status === 200 && Array.isArray(tplList.body.data) && tplList.body.data.some((t) => t.id === tplId));
const tplUpdate = await post('/api/templates/save', { id: tplId, name: 'V4-BACKEND-模板A-改', l0_content: 'L0 v2', l1_content: 'L1 v2', l3_content: 'L3 v2' });
check('模板 save 更新（同 id）', tplUpdate.status === 200 && tplUpdate.body.success && tplUpdate.body.message.includes('更新'));
const tplBad = await post('/api/templates/save', { name: '', l0_content: 'x' });
check('模板 save 校验空名称 → 400', tplBad.status === 400);
const tplExtract = await post('/api/templates/extract', {
  l0_content: '你是面向 {{industry}} 领域的智能语音助手，当前业务场景为 {{business_scene}}，核心目标是 {{core_goal}}。请保持专业并遵守安全规范。',
  l1_content: '保持自然口语，适合电话播报，避免书面语。',
  l3_content: '项目专属话术：退换货请引导用户提供订单号；停车缴费问题请核实车牌。',
});
check('模板 extract（分析接口）返回三层内容', tplExtract.status === 200 && tplExtract.body && tplExtract.body.success && typeof tplExtract.body.data.l0_content === 'string' && typeof tplExtract.body.data.l1_content === 'string' && typeof tplExtract.body.data.l3_content === 'string' && (tplExtract.body.data.l0_content + tplExtract.body.data.l1_content + tplExtract.body.data.l3_content).trim().length > 0, tplExtract.body && tplExtract.body.data ? { name: tplExtract.body.data.name, len: (tplExtract.body.data.l0_content + tplExtract.body.data.l1_content + tplExtract.body.data.l3_content).length } : tplExtract.body);
const tplDel = await post('/api/templates/delete', { id: tplId });
check('模板 delete', tplDel.status === 200 && tplDel.body.success);
tplList = await get('/api/templates');
check('模板 delete 后列表不含该 id', !tplList.body.data.some((t) => t.id === tplId));

// ========== 阶段二：AI 润色 ==========
const polish = await post('/api/ai/polish', { layer: 'L0', content: '你是面向{{industry}}领域的智能语音助手。请注意，务必，一定要保持专业、礼貌、热情、耐心，不要使用书面语。' });
check('AI polish L0 返回正文', polish.status === 200 && polish.body && polish.body.success && typeof polish.body.content === 'string' && polish.body.content.trim().length > 0 && !/```/.test(polish.body.content), polish.body && { layer: polish.body.layer, len: (polish.body.content || '').length });
const polishL1 = await post('/api/ai/polish', { layer: 'L1', content: '语音基座：电话沟通时请保持自然口语。' });
check('AI polish L1', polishL1.status === 200 && polishL1.body.success && typeof polishL1.body.content === 'string');
const polishBad = await post('/api/ai/polish', { layer: 'LX', content: 'x' });
check('AI polish 非法 layer → 400', polishBad.status === 400);
const polishEmpty = await post('/api/ai/polish', { layer: 'L0', content: '' });
check('AI polish 空 content → 400', polishEmpty.status === 400);

// ========== 阶段三：备份导出 / 导入（含非法结构回滚） ==========
const export1 = await get('/api/backup/export');
const expectedTables = ['model_configs', 'companies', 'projects', 'modules', 'module_versions', 'kb_items', 'kb_item_versions', 'snapshots', 'eval_runs', 'prompt_templates'];
const exportTables = export1.body && export1.body.tables ? Object.keys(export1.body.tables) : [];
check('备份导出包含全部 10 张表', export1.status === 200 && expectedTables.every((t) => exportTables.includes(t)), { got: exportTables, status: export1.status });
const counts1 = {};
for (const t of expectedTables) counts1[t] = (export1.body.tables[t] || []).length;
check('备份导出各表行数可读', expectedTables.every((t) => Array.isArray(export1.body.tables[t])), counts1);

// 原样导入（数据不变）→ 校验事务 DELETE+INSERT 正常
const importSame = await post('/api/backup/import', export1.body);
check('备份原样导入成功', importSame.status === 200 && importSame.body.success && importSame.body.imported, importSame.body && { imported: importSame.body.imported });
const export2 = await get('/api/backup/export');
const counts2 = {};
for (const t of expectedTables) counts2[t] = (export2.body.tables[t] || []).length;
check('原样导入后行数完全一致', expectedTables.every((t) => counts2[t] === counts1[t]), { before: counts1, after: counts2 });

// 非法结构：缺表 / 行类型错误 / 未知字段 / 未知表 → 400 且数据不变
const badNoTables = await post('/api/backup/import', { version: 1 });
check('备份导入缺 tables → 400', badNoTables.status === 400);
const badMissingTable = JSON.parse(JSON.stringify(export1.body)); delete badMissingTable.tables.snapshots;
const badMissing = await post('/api/backup/import', badMissingTable);
check('备份导入缺数据表 → 400', badMissing.status === 400);
const badRowType = JSON.parse(JSON.stringify(export1.body)); badRowType.tables.snapshots = [42];
const badRow = await post('/api/backup/import', badRowType);
check('备份导入行类型非法 → 400', badRow.status === 400);
const badUnknownTable = JSON.parse(JSON.stringify(export1.body)); badUnknownTable.tables.hacker_table = [];
const badTable = await post('/api/backup/import', badUnknownTable);
check('备份导入未知表 → 400', badTable.status === 400);
const export3 = await get('/api/backup/export');
const counts3 = {};
for (const t of expectedTables) counts3[t] = (export3.body.tables[t] || []).length;
check('非法导入全部被拒且数据未被破坏', expectedTables.every((t) => counts3[t] === counts1[t]), { after: counts3 });

// ========== 阶段三：项目深拷贝克隆 ==========
const companies = (await get('/api/companies')).body.data || [];
const companyId = companies[0] && companies[0].id;
const srcProj = await post('/api/projects/create', { company_id: companyId, name: 'V4克隆源-TEST' });
const srcId = srcProj.body.id;
check('创建克隆源项目', srcProj.status === 200 && !!srcId);
await post('/api/kb/save', { project_id: srcId, pairs: [{ question: 'V4克隆Q1', answer: 'V4克隆A1' }, { question: 'V4克隆Q2', answer: 'V4克隆A2' }] });
const srcKb = (await get(`/api/kb/list?project_id=${srcId}`)).body.data || [];
check('源项目知识库 2 条', srcKb.length === 2);
const clone = await post('/api/projects/clone', { id: srcId });
check('克隆接口成功', clone.status === 200 && clone.body.success && clone.body.project_id && clone.body.project_id !== srcId && clone.body.kb_count === 2, clone.body);
const cloneId = clone.body.project_id;
const allProjects = (await get('/api/projects')).body.data || [];
const clonedRow = allProjects.find((p) => p.id === cloneId);
const srcRow = allProjects.find((p) => p.id === srcId);
check('克隆项目存在且为全新 id / 名称带副本标记', !!clonedRow && clonedRow.id !== srcId && clonedRow.name.includes('副本') && !!srcRow);
const cloneKb = (await get(`/api/kb/list?project_id=${cloneId}`)).body.data || [];
check('克隆知识库 2 条且 project_id 指向新项目', cloneKb.length === 2 && cloneKb.every((k) => k.project_id === cloneId), cloneKb.length);
const srcIds = new Set(srcKb.map((k) => k.id));
check('克隆知识库记录全部使用新 id（不共用旧数据）', cloneKb.length === 2 && cloneKb.every((k) => !srcIds.has(k.id)) && new Set(cloneKb.map((k) => k.id)).size === 2);
const cloneMissing = await post('/api/projects/clone', { id: 'proj-not-exist' });
check('克隆不存在项目 → 404', cloneMissing.status === 404);

// 清理克隆测试数据
for (const k of cloneKb) await post('/api/kb/delete', { id: k.id });
for (const k of srcKb) await post('/api/kb/delete', { id: k.id });
await post('/api/projects/delete', { id: cloneId });
await post('/api/projects/delete', { id: srcId });
const afterCleanup = (await get(`/api/kb/list?project_id=${cloneId}`)).body.data || [];
const projectsAfter = (await get('/api/projects')).body.data || [];
check('克隆测试数据清理完成', afterCleanup.length === 0 && !projectsAfter.some((p) => p.id === cloneId || p.id === srcId));

// ========== 原功能回归：生成快照 ==========
const trip = projectsAfter.find((p) => p.name && p.name.includes('Trip旅游')) || projectsAfter.find((p) => p.name && !p.name.includes('V4'));
const snap = await post('/api/snapshots/create', {
  project_id: trip.id,
  layers: [
    { layer: 'L0', name: '全局安全', content: 'V4 回归：面向 {{industry}} 的语音助手。' },
    { layer: 'L1', name: '语音基座', content: '保持自然口语。' },
    { layer: 'L3', name: '项目话术', content: '项目话术：目标 {{core_goal}}。' },
  ],
  context_data: { industry: '旅游行业', business_scene: ['售后'], core_goal: ['安抚情绪'] },
});
check('原有生成快照正常（含语境替换）', snap.status === 200 && snap.body.success && typeof snap.body.final_prompt === 'string' && snap.body.final_prompt.includes('旅游行业'), snap.body && { snapshot_id: snap.body.snapshot_id });
const snapId = snap.body && snap.body.snapshot_id;
const detail = snapId ? await get(`/api/snapshots/detail?id=${snapId}`) : { status: 0, body: null };
check('快照 detail 可回读', detail.status === 200 && detail.body.success && !!detail.body.data);

// 测试数据清理：删除本次测试快照 + 测试 kb 版本记录
try {
  const Database = (await import('better-sqlite3')).default;
  const cleanupDb = new Database(DB_PATH);
  if (snapId) cleanupDb.prepare('DELETE FROM snapshots WHERE id = ?').run(snapId);
  cleanupDb.prepare("DELETE FROM kb_item_versions WHERE item_id IN (SELECT id FROM kb_items WHERE question LIKE 'V4克隆%')").run();
  cleanupDb.close();
  check('测试快照与残留版本清理', true);
} catch (e) {
  check('测试快照与残留版本清理', false, e.message);
}

console.log('\n========== RESULT ==========');
console.log(JSON.stringify({ total: results.length, failed, results }, null, 2));
console.log(failed === 0 ? 'ALL_V4_BACKEND_TESTS_PASSED' : `V4_BACKEND_TESTS_FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
