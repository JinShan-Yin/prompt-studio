// test-data/server-smoke-v3.mjs
//
// V3.0 阶段一 · server.js HTTP 冒烟（需先 `node server.js` 启动，默认 http://127.0.0.1:3000）
// 运行：node test-data/server-smoke-v3.mjs [baseUrl]
//
// 覆盖任务要求的全部冒烟点：companies/projects、context、kb、snapshots create/list/detail、
// prompt assemble（不写库）、gate export（PROJECT_NAME + no-store + 无 {{）、chat/reply 真实 LLM、
// eval/run 真实 LLM、settings GET masked / 空值保持 / 非法 400、export_zip（PK 头 + manifest + txt 内容）、
// OPTIONS 预检、/api 404、index.html 回退。
// 注意：只使用 GET / 空值 / 非法 Key 做 settings 冒烟，绝不覆盖真实 API Key。
import zlib from 'node:zlib';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PROJECT_ID = process.argv[3] || 'proj-597e1045';

let passed = 0;
let failed = 0;
const results = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    results.push({ ok: false, name, detail });
    console.log(`  \u2717 ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`);
  }
}

async function request(method, requestPath, body, timeout = 60000) {
  const options = { method, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + requestPath, options);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { status: response.status, headers: response.headers, text, json };
}

async function requestBuffer(requestPath, timeout = 60000) {
  const response = await fetch(BASE + requestPath, { signal: AbortSignal.timeout(timeout) });
  const arrayBuffer = await response.arrayBuffer();
  return { status: response.status, headers: response.headers, buffer: Buffer.from(arrayBuffer) };
}

/** 最小 Zip 解析（中央目录），仅用于冒烟校验 manifest/文件内容 */
function parseZip(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let pointer = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(pointer) !== 0x02014b50) throw new Error('bad central dir signature');
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf-8');
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, content: method === 0 ? raw : zlib.inflateRawSync(raw) });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function noPlaceholders(text) {
  return typeof text === 'string' && !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(text);
}

(async () => {
  console.log('============================================================');
  console.log(` Prompt Studio V3.0 · HTTP 冒烟 @ ${BASE}`);
  console.log('============================================================');
  console.log('');

  console.log('[1] 静态托管 / 路由回退 / /api 404');
  let r = await request('GET', '/');
  check('GET / -> 200 且返回 index.html', r.status === 200 && /<html/i.test(r.text), { status: r.status });
  r = await request('GET', '/some-spa-route');
  check('非 /api GET 回退 index.html', r.status === 200 && /<html/i.test(r.text), { status: r.status });
  r = await request('GET', '/api/not-exist-path');
  check('GET /api/未命中 -> JSON 404', r.status === 404 && r.json && r.json.success === false, r.json);
  r = await request('GET', '/api/models');
  check('/api/models 阶段二已可用（success + 数组）', r.status === 200 && r.json && r.json.success === true && Array.isArray(r.json.data), r.json && { status: r.status });
  r = await request('OPTIONS', '/api/projects', undefined);
  check('OPTIONS 预检 -> 204 + Access-Control-Allow-Origin', (r.status === 204 || r.status === 200) && r.headers.get('access-control-allow-origin') === '*', { status: r.status, acao: r.headers.get('access-control-allow-origin') });

  console.log('');
  console.log('[2] 公司 / 项目 / 语境 / 知识库 基础接口');
  r = await request('GET', '/api/companies');
  check('GET /api/companies 成功', r.status === 200 && r.json.success === true && Array.isArray(r.json.data), r.json && r.json.success);
  r = await request('GET', '/api/projects');
  const projects = (r.json && r.json.data) || [];
  check('GET /api/projects 成功且 ≥3 个项目', r.status === 200 && r.json.success === true && projects.length >= 3, { count: projects.length });
  const project = projects.find((p) => p.id === PROJECT_ID) || projects[0];
  check(`目标项目存在（${project ? project.id : PROJECT_ID}）`, Boolean(project));

  r = await request('GET', `/api/context/get?project_id=${encodeURIComponent(project.id)}`);
  check('GET /api/context/get 返回安全语境结构', r.status === 200 && r.json.success === true && typeof r.json.data.industry === 'string' && Array.isArray(r.json.data.business_scene) && Array.isArray(r.json.data.core_goal), r.json);

  r = await request('GET', `/api/kb/list?project_id=${encodeURIComponent(project.id)}`);
  const kbRows = (r.json && r.json.data) || [];
  check('GET /api/kb/list 成功且知识库非空', r.status === 200 && r.json.success === true && kbRows.length > 0, { count: kbRows.length });

  console.log('');
  console.log('[3] 快照 create / list / detail + prompt assemble');
  const contextData = {
    industry: '旅游行业',
    business_scene: ['售后退换货', '停车缴费'],
    core_goal: ['安抚客户情绪', '准确提供价格'],
  };
  const layers = [
    { layer: 'L0', name: '公共基座', content: '你是一个面向 {{industry}} 领域的智能语音助手。当前业务场景为 {{business_scene}}。核心目标：{{core_goal}}。' },
    { layer: 'L1', name: '语音基座', content: '保持自然口语，电话中不得使用书面语。' },
    { layer: 'L3', name: '项目层', content: '再次强调：行业={{industry}}；场景={{business_scene}}；目标={{core_goal}}。' },
  ];
  r = await request('POST', '/api/snapshots/create', { project_id: project.id, layers, context_data: contextData });
  const snapshotId = r.json && r.json.snapshot_id;
  check('POST /api/snapshots/create 成功', r.status === 200 && r.json.success === true && typeof snapshotId === 'string', r.json && r.json.success);
  check('final_prompt 无 {{ 占位符且已完成替换', Boolean(r.json) && noPlaceholders(r.json.final_prompt) && r.json.final_prompt.includes('旅游行业') && r.json.final_prompt.includes('售后退换货、停车缴费'), r.json && r.json.final_prompt && r.json.final_prompt.slice(0, 120));
  check('context_applied 返回替换字面量', r.json.context_applied && r.json.context_applied.industry === '旅游行业', r.json && r.json.context_applied);

  r = await request('GET', `/api/snapshots/list?project_id=${encodeURIComponent(project.id)}`);
  const snapshotRows = (r.json && r.json.data) || [];
  check('GET /api/snapshots/list 成功且包含新快照', r.status === 200 && r.json.success === true && snapshotRows.some((s) => s.id === snapshotId), { count: snapshotRows.length });

  r = await request('GET', `/api/snapshots/detail?id=${encodeURIComponent(snapshotId)}`);
  const detail = (r.json && r.json.data) || {};
  check('GET /api/snapshots/detail 含 layers（3 层）', r.status === 200 && r.json.success === true && Array.isArray(detail.layers) && detail.layers.length === 3, { layers: Array.isArray(detail.layers) ? detail.layers.length : null });
  check('detail 含 eval_pass / eval_score / final_prompt_content', detail.eval_pass === 1 && detail.eval_score === 5 && typeof detail.final_prompt_content === 'string', { eval_pass: detail.eval_pass, eval_score: detail.eval_score });

  const countBefore = snapshotRows.length;
  r = await request('POST', '/api/prompt/assemble', { project_id: project.id, layers, context_data: contextData });
  check('POST /api/prompt/assemble 成功且变量已替换', r.status === 200 && r.json.success === true && noPlaceholders(r.json.final_prompt) && r.json.final_prompt.includes('旅游行业'), r.json && r.json.final_prompt && r.json.final_prompt.slice(0, 120));
  check('assemble 返回与快照一致的 final_prompt', Boolean(r.json) && r.json.final_prompt === detail.final_prompt_content, { assembleLen: r.json && r.json.final_prompt && r.json.final_prompt.length, snapshotLen: detail.final_prompt_content.length });
  r = await request('GET', `/api/snapshots/list?project_id=${encodeURIComponent(project.id)}`);
  check('prompt assemble 不写库（快照数不变）', ((r.json && r.json.data) || []).length === countBefore, { before: countBefore, after: ((r.json && r.json.data) || []).length });

  console.log('');
  console.log('[4] 发布门禁导出 / 快照 Zip 导出');
  r = await request('GET', `/api/gate/export?snapshot_id=${encodeURIComponent(snapshotId)}`);
  const gateText = r.text || '';
  check('GET /api/gate/export 成功（text/plain）', r.status === 200 && (r.headers.get('content-type') || '').includes('text/plain'), { status: r.status });
  check('TXT 头部含 PROJECT_NAME（实时读 DB）', gateText.includes(`# PROJECT_NAME: ${project.name}`), gateText.slice(0, 200));
  check('TXT 含 SNAPSHOT/EVAL_SCORE 元数据且 0 个 {{', gateText.includes(`# SNAPSHOT: ${snapshotId}`) && gateText.includes('# EVAL_SCORE: 5') && noPlaceholders(gateText), gateText.slice(0, 200));
  check('gate export 带 no-store 缓存头', /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  check('gate export 首部无多余空行', gateText.startsWith('# SNAPSHOT:'), gateText.slice(0, 10));
  r = await request('GET', '/api/gate/export?snapshot_id=snap-not-exist');
  check('gate export 不存在快照 -> 404', r.status === 404 && r.text.includes('Snapshot Not Found'), { status: r.status });

  r = await requestBuffer(`/api/projects/export_zip?project_id=${encodeURIComponent(project.id)}`);
  check('GET /api/projects/export_zip 返回 application/zip', r.status === 200 && (r.headers.get('content-type') || '').includes('application/zip'), { status: r.status, contentType: r.headers.get('content-type') });
  check('Zip 魔数 PK\\x03\\x04', r.buffer.length > 4 && r.buffer[0] === 0x50 && r.buffer[1] === 0x4b && r.buffer[2] === 0x03 && r.buffer[3] === 0x04, r.buffer.subarray(0, 4).toString('hex'));
  let entries = [];
  try { entries = parseZip(r.buffer); } catch (e) { console.log('    zip parse error:', e.message); }
  check('Zip 含 manifest.json + snapshots/<id>.txt', entries.some((e) => e.name === 'manifest.json') && entries.some((e) => e.name === `snapshots/${snapshotId}.txt`), entries.map((e) => e.name).slice(0, 6));
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (manifestEntry) {
    const manifest = JSON.parse(manifestEntry.content.toString('utf-8'));
    check('manifest 字段完整（project_name/count/snapshots）', manifest.project_id === project.id && manifest.project_name === project.name && typeof manifest.exported_at === 'string' && manifest.count === entries.length - 1 && Array.isArray(manifest.snapshots), { count: manifest.count });
  }
  const snapshotTxt = entries.find((e) => e.name === `snapshots/${snapshotId}.txt`);
  check('快照 txt 内容与 detail.final_prompt_content 一致', Boolean(snapshotTxt) && snapshotTxt.content.toString('utf-8') === detail.final_prompt_content);
  r = await request('GET', '/api/projects/export_zip');
  check('export_zip 缺 project_id -> 400 JSON', r.status === 400 && r.json && r.json.success === false, r.json);
  r = await request('GET', '/api/projects/export_zip?project_id=proj-not-exist');
  check('export_zip 项目不存在 -> 404 JSON', r.status === 404 && r.json && r.json.success === false, r.json);

  console.log('');
  console.log('[5] 多轮对话 / 评测（真实 LLM 调用）');
  r = await request('POST', '/api/chat/reply', {
    project_id: project.id,
    layers,
    context_data: contextData,
    messages: [
      { role: 'user', content: '你好，我的快递什么时候能到？' },
      { role: 'assistant', content: '<speak>您好，请提供订单号，我帮您查询。</speak>' },
      { role: 'user', content: '订单号是 12345，大概多久？' },
    ],
  }, 180000);
  check('POST /api/chat/reply 成功（真实 LLM）', r.status === 200 && r.json && r.json.success === true && typeof r.json.reply === 'string' && r.json.reply.length > 0, r.json && { status: r.status, error: r.json.error });
  check('chat system_prompt 含组装内容 + 【输出约束】', r.json && typeof r.json.system_prompt === 'string' && r.json.system_prompt.includes('【输出约束】') && r.json.system_prompt.includes('<speak>...'), r.json && r.json.system_prompt && r.json.system_prompt.slice(0, 120));
  if (r.json && typeof r.json.reply === 'string' && r.json.reply.includes('<speak>')) {
    check('chat reply 为语音播报格式（<speak> 包裹）', true);
  } else {
    console.log('  ! 注意：本次 LLM 回复未包含 <speak>（模型偶发不遵守输出约束，接口本身成功，不计失败）');
  }

  r = await request('POST', '/api/eval/run', {
    user_query: '停车怎么收费？',
    standard_answer: '停车每小时8元。',
    bot_reply: '<speak>停车每小时八元。</speak>',
  }, 180000);
  check('POST /api/eval/run 成功（真实 LLM）', r.status === 200 && r.json && r.json.success === true && r.json.l1 && typeof r.json.l1.pass === 'boolean', r.json && { status: r.status, error: r.json.error });
  check('eval 返回 l2.score（1-5）与 pass/violations', r.json && r.json.l2 && typeof r.json.l2.score === 'number' && r.json.l2.score >= 1 && r.json.l2.score <= 5 && typeof r.json.l2.pass === 'boolean' && Array.isArray(r.json.l2.violations), r.json && r.json.l2);

  console.log('');
  console.log('[6] API Key 设置（只读 masked / 空值 / 非法，不覆盖真实 Key）');
  r = await request('GET', '/api/settings/api-key');
  const settingsData = (r.json && r.json.data) || {};
  check('GET /api/settings/api-key 只回 masked', r.status === 200 && r.json.success === true && typeof settingsData.has_key === 'boolean' && typeof settingsData.masked === 'string' && settingsData.source === 'env' && /^(.{3}\*{4}.{4}|\*{4})$/.test(settingsData.masked), settingsData);
  r = await request('POST', '/api/settings/api-key', { api_key: '' });
  check('POST 空 Key -> updated:false 保持原值', r.status === 200 && r.json.success === true && r.json.updated === false && r.json.message === '未提供新 Key，保持原值', r.json);
  r = await request('POST', '/api/settings/api-key', { api_key: 'short-key' });
  check('POST 非法 Key -> 400 指定文案', r.status === 400 && r.json.success === false && r.json.error === 'API Key 格式不正确（长度需≥20 且不含空白）', r.json);
  r = await request('GET', '/api/settings/api-key');
  check('非法 POST 后 Key 未被改动（masked 不变）', ((r.json && r.json.data) || {}).masked === settingsData.masked, { before: settingsData.masked, after: (r.json && r.json.data || {}).masked });

  // 注意：合法 Key 写入分支会真实覆盖 .env，故本冒烟**不执行**（task-16 明确要求 settings 只 GET/空值/非法）。
  // 合法写入逻辑与原子写/立即生效已在 Sprint3 单测 + 离线集成验证中覆盖。

  console.log('');
  console.log('------------------------------------------------------------');
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\u2705 server-smoke v3 全部通过：${passed}/${total} 项`);
    process.exitCode = 0;
  } else {
    console.log(`\u274c server-smoke v3 失败：${failed}/${total} 项`);
    for (const item of results) console.log(`   - ${item.name} :: ${JSON.stringify(item.detail).slice(0, 300)}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('\n\u274c 冒烟脚本异常:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
