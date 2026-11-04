// test-data/e2e/http-smoke.mjs — Sprint 1 集成 HTTP 冒烟（Lead 验收用）
// 用法: node test-data/e2e/http-smoke.mjs <baseUrl> <token>
const BASE = process.argv[2] || 'http://127.0.0.1:3081';
const TOKEN = process.argv[3] || '';
const q = (p) => BASE + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push({ ok: true, name }); }
  else { fail++; results.push({ ok: false, name, detail }); console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
  if (cond) console.log('  ✓ ' + name);
}
async function getJson(path, opts) {
  const res = await fetch(q(path), opts);
  let body; try { body = await res.json(); } catch (e) { body = { __parseError: String(e), text: '' }; }
  return { status: res.status, body };
}
async function postJson(path, payload, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await getJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
  } finally { clearTimeout(t); }
}
const noPlaceholder = (s) => !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(s);

(async () => {
  console.log('== [1] 项目与语境基础 ==');
  const projRes = await getJson('/api/projects');
  check('GET /api/projects 成功且有项目', projRes.body?.success === true && projRes.body.data.length >= 3, projRes.body);
  const PROJ = 'proj-597e1045';

  let r = await getJson('/api/context/get?project_id=' + PROJ);
  check('GET /api/context/get 返回安全默认结构', r.body?.success === true && typeof r.body.data.industry === 'string' && Array.isArray(r.body.data.business_scene) && Array.isArray(r.body.data.core_goal), r.body);

  console.log('== [2] 语境保存与回填 ==');
  const ctx = { industry: '旅游行业', business_scene: ['售后退换货', '停车缴费'], core_goal: ['安抚客户情绪', '准确提供价格'] };
  r = await postJson('/api/context/save', { project_id: PROJ, context_data: ctx });
  check('POST /api/context/save 成功', r.body?.success === true, r.body);
  r = await getJson('/api/context/get?project_id=' + PROJ);
  check('save→get 回读一致', r.body?.success === true && r.body.data.industry === ctx.industry && JSON.stringify(r.body.data.business_scene) === JSON.stringify(ctx.business_scene) && JSON.stringify(r.body.data.core_goal) === JSON.stringify(ctx.core_goal), r.body);

  console.log('== [3] 快照全局替换（L0 与 L3 同时命中） ==');
  const layers = [
    { layer: 'L0', name: '全局安全基座', content: '你是面向{{industry}}领域的语音助手。\n业务场景：{{business_scene}}。\n核心目标：{{core_goal}}。\n跨行变量：{{\ntest\n}}\n严禁 Markdown。' },
    { layer: 'L1', name: '语音基座', content: '请保持 <speak> 标签。' },
    { layer: 'L3', name: '项目话术', content: '再次强调行业={{industry}}；场景={{ business_scene }}；目标={{core_goal}}。' }
  ];
  r = await postJson('/api/snapshots/create', { project_id: PROJ, layers, context_data: ctx });
  const snap = r.body;
  check('POST /api/snapshots/create 成功（原 500 bug 已修复）', r.status === 200 && snap?.success === true && typeof snap.final_prompt === 'string', snap);
  const fp = snap.final_prompt || '';
  check('final_prompt 含 industry 真实值', fp.includes('旅游行业'));
  check('final_prompt 含 business_scene 顿号拼接值', fp.includes('售后退换货、停车缴费'));
  check('final_prompt 含 core_goal 顿号拼接值', fp.includes('安抚客户情绪、准确提供价格'));
  check('final_prompt 无 {{industry}}/{{business_scene}}/{{core_goal}} 残留', noPlaceholder(fp), fp.match(/\{\{[^}]*\}\}/g));
  check('跨行变量 {{\\ntest\\n}} 原样保留（不在替换范围）', fp.includes('{{\ntest\n}}'));
  check('L0 与 L3 两处均替换（行业出现 2 次以上）', (fp.match(/旅游行业/g) || []).length >= 2);
  check('花括号内空白的占位符也被替换', !fp.includes('{{ business_scene }}'));
  check('context_applied 返回替换字面量', snap.context_applied?.industry === '旅游行业' && snap.context_applied?.business_scene === '售后退换货、停车缴费', snap.context_applied);

  const sid = snap.snapshot_id;
  r = await getJson('/api/snapshots/detail?id=' + sid);
  check('GET /api/snapshots/detail 返回最终 Prompt 且与 create 一致', r.body?.success === true && r.body.data.final_prompt_content === fp, { status: r.status, has: !!r.body?.data });
  r = await getJson('/api/snapshots/list?project_id=' + PROJ);
  check('GET /api/snapshots/list 保留可用', r.body?.success === true && Array.isArray(r.body.data) && r.body.data.some((x) => x.id === sid), r.body?.data?.slice?.(0, 3));

  console.log('== [4] 替换值特殊字符注入安全（$& / $\' / $`） ==');
  const weird = { industry: 'A$&B', business_scene: ["X$'Y"], core_goal: ['Z$`W'] };
  r = await postJson('/api/snapshots/create', {
    project_id: 'proj-4562700e',
    layers: [{ layer: 'L0', name: '注入测试', content: 'I={{industry}} S={{business_scene}} G={{core_goal}}' }],
    context_data: weird
  });
  check('特殊字符替换不报错且按字面量输出', r.body?.success === true && r.body.final_prompt.includes('I=A$&B') && r.body.final_prompt.includes("S=X$'Y") && r.body.final_prompt.includes('G=Z$`W'), r.body?.final_prompt || r.body);

  console.log('== [5] AI 语境提取（空知识库分支 / 真实 LLM） ==');
  r = await postJson('/api/context/extract', { project_id: 'proj-4562700e' });
  check('空知识库项目 extract → success:false 且提示知识库为空', r.status === 200 && r.body?.success === false && String(r.body.message || '').includes('知识库为空'), r.body);
  console.log('  … 真实 LLM 提取中（可等待约 5-30s）…');
  r = await postJson('/api/context/extract', { project_id: PROJ }, 150000);
  const ex = r.body;
  check('有知识库项目 extract 成功', r.status === 200 && ex?.success === true, { status: r.status, body: ex });
  if (ex?.success) {
    check('extract 结构合法：industry string / 两数组', typeof ex.data.industry === 'string' && Array.isArray(ex.data.business_scene) && Array.isArray(ex.data.core_goal), ex.data);
    check('extract 内容非空（industry 或场景/目标有值）', ex.data.industry.length > 0 || ex.data.business_scene.length > 0 || ex.data.core_goal.length > 0, ex.data);
    check('extract 数组元素均为字符串', ex.data.business_scene.every((x) => typeof x === 'string') && ex.data.core_goal.every((x) => typeof x === 'string'), ex.data);
  }

  console.log('== [6] 空 layers / 缺参数容错 ==');
  r = await postJson('/api/snapshots/create', { project_id: PROJ });
  check('缺 layers → 400 且不崩溃', r.status === 400 && r.body?.success !== true, { status: r.status, body: r.body });
  r = await getJson('/api/context/get');
  check('缺 project_id → 400', r.status === 400, { status: r.status, body: r.body });

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ HTTP 冒烟全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
