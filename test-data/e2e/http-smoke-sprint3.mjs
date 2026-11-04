// test-data/e2e/http-smoke-sprint3.mjs — Sprint 3 后端冒烟（Lead 验收用）
// 用法: node test-data/e2e/http-smoke-sprint3.mjs <baseUrl> <token>
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3081';
const TOKEN = process.argv[3] || '';
const OUT_DIR = path.resolve('test-data/e2e/exports');
fs.mkdirSync(OUT_DIR, { recursive: true });
const ZIP_PATH = path.join(OUT_DIR, 'sprint3-export.zip');
const q = (p) => BASE + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);

let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 800) : '')); }
  results.push({ name, ok: !!cond, detail });
};
async function req(pathname, opts, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(q(pathname), { ...(opts || {}), signal: ctrl.signal });
    let body = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { body = await res.json(); } catch (e) { body = { __parseError: String(e) }; } }
    else body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  } finally { clearTimeout(t); }
}
const post = (p, payload) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

const PROJECT = 'proj-597e1045';
const NO_SNAP_PROJECT_NAME = 'Sprint3-临时空项目';

(async () => {
  console.log('== [1] API Key 设置接口（安全路径，不覆盖真实 Key） ==');
  let r = await req('/api/settings/api-key');
  const d = r.body?.data || {};
  check('GET /api/settings/api-key 成功', r.status === 200 && r.body?.success === true, r.body);
  check('返回 has_key=true 且 masked 已脱敏（含 ****）', d.has_key === true && typeof d.masked === 'string' && d.masked.includes('****'), d);
  check('masked 形态合法且不含明显完整 Key（长度≤16）', /^\S{3}\*{4}\S{4}$/.test(d.masked || '') && String(d.masked).length <= 16, d.masked);

  r = await post('/api/settings/api-key', { api_key: '' });
  check('POST 空 Key → 200 updated:false（保持原值）', r.status === 200 && r.body?.success === true && r.body.updated === false, r.body);
  r = await post('/api/settings/api-key', { api_key: '   ' });
  check('POST 纯空白 Key → 200 updated:false', r.status === 200 && r.body?.updated === false, r.body);
  r = await post('/api/settings/api-key', { api_key: 'abc' });
  check('POST 过短非法 Key → 400', r.status === 400 && r.body?.success === false, { status: r.status, body: r.body });

  console.log('== [2] 真实 Key 仍可用（未被破坏） ==');
  r = await post('/api/chat/reply', {
    project_id: PROJECT,
    layers: [{ layer: 'L0', name: '基座', content: '你是{{industry}}语音客服。' }],
    context_data: { industry: '商场客服', business_scene: [], core_goal: [] },
    messages: [{ role: 'user', content: '你好，请用一句话回复。' }]
  });
  check('空 Key 保存后 /api/chat/reply 仍真实调用成功', r.status === 200 && r.body?.success === true && typeof r.body.reply === 'string' && r.body.reply.trim().length > 0, { status: r.status, body: r.body });

  console.log('== [3] 快照详情 layers ==');
  const detailLayers = [
    { layer: 'L0', name: '全局安全', content: 'S3_DETAIL_L0 行业={{industry}}' },
    { layer: 'L1', name: '语音基座', content: 'S3_DETAIL_L1 <speak>要求</speak>' },
    { layer: 'L3', name: '项目话术', content: 'S3_DETAIL_L3 目标={{core_goal}}' }
  ];
  const detailCtx = { industry: '旅游行业', business_scene: [], core_goal: ['安抚客户情绪'] };
  let r2 = await post('/api/snapshots/create', { project_id: PROJECT, layers: detailLayers, context_data: detailCtx });
  const createdSnapId = r2.body?.snapshot_id;
  check('创建用于 detail 校验的 3 层快照', r2.status === 200 && r2.body?.success === true && !!createdSnapId, r2.body);
  r = await req('/api/snapshots/detail?id=' + createdSnapId);
  const detail = r.body?.data || {};
  const gotLayers = Array.isArray(detail.layers) ? detail.layers : [];
  check('detail 返回 layers 数组且含 L0/L1/L3', r.status === 200 && gotLayers.length === 3 && ['L0', 'L1', 'L3'].every((L) => gotLayers.some((x) => x.layer === L)), { keys: Object.keys(detail), layers: gotLayers.map((x) => x.layer) });
  check('detail 含 eval_pass/eval_score/created_at/final_prompt_content', detail.eval_pass !== undefined && detail.eval_score !== undefined && !!detail.created_at && typeof detail.final_prompt_content === 'string', Object.keys(detail));
  check('detail layers 内容与创建时一致（L0/L1/L3）', ['L0', 'L1', 'L3'].every((L) => { const src = detailLayers.find((x) => x.layer === L); const got = gotLayers.find((x) => x.layer === L); return src && got && got.content === src.content; }), gotLayers);

  console.log('== [4] POST /api/prompt/assemble（只读组装，不写库） ==');
  const beforeSnapCount = (await req('/api/snapshots/list?project_id=' + PROJECT)).body?.data?.length || 0;
  const layers = [
    { layer: 'L0', name: '全局安全', content: '行业={{industry}}；场景={{business_scene}}；目标={{core_goal}}。' },
    { layer: 'L1', name: '语音基座', content: '回复必须用 <speak> 包裹。' },
    { layer: 'L3', name: '项目话术', content: '再次强调行业={{industry}}。' }
  ];
  const ctx = { industry: '商场客服', business_scene: ['停车缴费'], core_goal: ['准确提供信息'] };
  r = await post('/api/prompt/assemble', { project_id: PROJECT, layers, context_data: ctx });
  const fp = r.body?.final_prompt || '';
  check('prompt/assemble 成功返回 final_prompt', r.status === 200 && r.body?.success === true && typeof fp === 'string' && fp.length > 0, r.body);
  check('assemble 完成 L0/L3 全局变量替换、无残留', fp.includes('行业=商场客服') && fp.includes('场景=停车缴费') && fp.includes('目标=准确提供信息') && (fp.match(/商场客服/g) || []).length >= 2 && !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(fp), fp.slice(0, 400));
  check('assemble 不包含「### 名称 (layer)」以外的多余内容?（结构完整）', fp.includes('### 全局安全 (L0)') && fp.includes('<speak>'), fp.slice(0, 200));
  const afterSnapCount = (await req('/api/snapshots/list?project_id=' + PROJECT)).body?.data?.length || 0;
  check('assemble 不新增快照（只读）', beforeSnapCount === afterSnapCount, { beforeSnapCount, afterSnapCount });

  console.log('== [5] GET /api/projects/export_zip ==');
  const rawZip = await fetch(q('/api/projects/export_zip?project_id=' + PROJECT));
  const zipBuf = Buffer.from(await rawZip.arrayBuffer());
  fs.writeFileSync(ZIP_PATH, zipBuf);
  const zipCt = rawZip.headers.get('content-type') || '';
  const cd = rawZip.headers.get('content-disposition') || '';
  check('export_zip 200 + application/zip + attachment', rawZip.status === 200 && zipCt.includes('application/zip') && /attachment/i.test(cd), { status: rawZip.status, zipCt, cd });
  check('下载文件为有效 ZIP（PK 头 + 大小 > 0）', zipBuf.length > 200 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b, { size: zipBuf.length, head: zipBuf.slice(0, 4).toString('hex') });
  check('ZIP 文件名安全（project-<id>-snapshots.zip）', /project-proj-[a-z0-9]+-snapshots\.zip/.test(cd), cd);

  const noParam = await fetch(q('/api/projects/export_zip'));
  check('缺 project_id → 400', noParam.status === 400, { status: noParam.status });
  const notFound = await fetch(q('/api/projects/export_zip?project_id=proj-not-exist-xyz'));
  check('项目不存在 → 404', notFound.status === 404, { status: notFound.status });

  // 临时创建空项目 → 导出应 404（无快照），测完删除
  const companies = await req('/api/companies');
  const companyId = companies.body?.data?.[0]?.id;
  const created = await post('/api/projects/create', { company_id: companyId, name: NO_SNAP_PROJECT_NAME });
  const tempId = created.body?.id;
  check('创建临时项目用于空快照分支', created.status === 200 && !!tempId, created.body);
  if (tempId) {
    const emptyZip = await fetch(q('/api/projects/export_zip?project_id=' + tempId));
    check('无快照项目 export_zip → 404 且 JSON 提示', emptyZip.status === 404, { status: emptyZip.status });
    const del = await post('/api/projects/delete', { id: tempId });
    check('临时项目已清理', del.status === 200 && del.body?.success === true, del.body);
  }

  console.log('\n========== 结果 ==========');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  console.log('ZIP 保存于: ' + ZIP_PATH);
  if (fail) { console.error(JSON.stringify(results.filter((x) => !x.ok), null, 2)); process.exitCode = 1; }
  else console.log('✅ Sprint3 HTTP 冒烟全部通过');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
