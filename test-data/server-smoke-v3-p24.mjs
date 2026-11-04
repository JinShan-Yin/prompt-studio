// test-data/server-smoke-v3-p24.mjs
//
// V3.0 阶段二 + 阶段四后端 HTTP 冒烟（需先 `node server.js`，默认 http://127.0.0.1:3000）
// 运行：node test-data/server-smoke-v3-p24.mjs [baseUrl]
//
// 覆盖：
// [1] 多模型路由中枢：GET /api/models（masked 不泄露）、POST /api/models/save（单活）、
//     POST /api/models/test（真实 LLM）、chat/reply 走 DB 激活模型、DB 模型失败自动回落 .env、
//     无激活模型 → .env 回退、恢复激活模型；
// [2] 阶段四：POST /api/kb/update（成功/持久化/还原/404/400）；
// [3] 阶段四：POST /api/eval/generate_questions（真实 LLM + 服务端 JSON 数组提取校验）；
// [4] 阶段一核心回归（projects/context/kb/snapshot/detail/assemble/gate/export_zip/settings/静态）。
// 注意：绝不覆盖真实 API Key（models 的 api_key 一律留空，回落到 .env）。
import zlib from 'node:zlib';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PROJECT_ID = 'proj-597e1045';
const MODEL_DISPLAY_NAME = '自动验收-DeepSeek';
const BAD_MODEL_DISPLAY_NAME = '自动验收-BadURL';

let passed = 0;
let failed = 0;
const results = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    results.push({ name, detail });
    console.log(`  \u2717 ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : ''}`);
  }
}
function assertNoKeyLeak(text) {
  return !/(sk-[A-Za-z0-9]{20,})/.test(String(text));
}
async function request(method, requestPath, body, timeout = 120000) {
  const options = { method, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + requestPath, options);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: response.status, headers: response.headers, text, json };
}
const get = (p, t) => request('GET', p, undefined, t);
const post = (p, payload, t) => request('POST', p, payload, t);

async function requestBuffer(requestPath, timeout = 60000) {
  const response = await fetch(BASE + requestPath, { signal: AbortSignal.timeout(timeout) });
  const arrayBuffer = await response.arrayBuffer();
  return { status: response.status, headers: response.headers, buffer: Buffer.from(arrayBuffer) };
}

function parseZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let pointer = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
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

const noPlaceholders = (text) => typeof text === 'string' && !/\{\{\s*(industry|business_scene|core_goal)\s*\}\}/.test(text);

(async () => {
  console.log('============================================================');
  console.log(` Prompt Studio V3.0 · 阶段二/四 HTTP 冒烟 @ ${BASE}`);
  console.log('============================================================');
  console.log('');

  console.log('[1] 多模型路由中枢');
  let r = await get('/api/models');
  check('GET /api/models 成功返回数组', r.status === 200 && r.json && r.json.success === true && Array.isArray(r.json.data), r.json && { status: r.status });
  const models = (r.json && r.json.data) || [];
  check('模型列表不含完整 api_key 字段', models.every((m) => !('api_key' in m)), models[0] && Object.keys(models[0]));
  check('模型列表 masked_key / has_key 字段齐备', models.every((m) => typeof m.masked_key === 'string' && typeof m.has_key === 'boolean'), models[0] && { masked_key: models[0].masked_key, has_key: models[0].has_key });

  // 复用/新建一条「自动验收」模型（api_key 留空 -> 回落 .env）
  const existingAcceptanceModel = models.find((m) => m.display_name === MODEL_DISPLAY_NAME && m.provider === 'deepseek');
  r = await post('/api/models/save', {
    id: existingAcceptanceModel ? existingAcceptanceModel.id : undefined,
    provider: 'deepseek',
    display_name: MODEL_DISPLAY_NAME,
    base_url: 'https://api.deepseek.com/v1',
    model_name: 'deepseek-chat',
    api_key: '',
    is_active: true,
    temperature: 0.3,
  });
  const modelId = r.json && r.json.id;
  check('POST /api/models/save 保存激活模型成功', r.status === 200 && r.json && r.json.success === true && typeof modelId === 'string', r.json);
  check('save 响应不含 api_key', assertNoKeyLeak(r.text) && !('api_key' in (r.json || {})), r.json);

  r = await get('/api/models');
  const saved = ((r.json && r.json.data) || []).find((m) => m.id === modelId);
  check('GET /api/models 包含新模型且 is_active=1', Boolean(saved) && Number(saved.is_active) === 1, saved);
  check('新模型 has_key=false、masked_key 为空（api_key 留空）', Boolean(saved) && saved.has_key === false && saved.masked_key === '', saved && { has_key: saved.has_key, masked_key: saved.masked_key });

  r = await request('POST', '/api/models/save', { provider: '', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat' });
  check('POST /api/models/save 缺必填 -> 400', r.status === 400 && r.json && r.json.success === false, r.json);
  r = await request('POST', '/api/models/save', { provider: 'deepseek', base_url: 'ftp://invalid', model_name: 'deepseek-chat' });
  check('POST /api/models/save base_url 非法 -> 400', r.status === 400 && r.json && r.json.success === false, r.json);

  r = await post('/api/models/test', { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '' }, 90000);
  check('POST /api/models/test（Key 留空回落 .env）真实连通成功', r.status === 200 && r.json && r.json.success === true && /^连接成功（deepseek-chat，耗时 \d+ms）$/.test(r.json.message || ''), r.json);
  check('models/test 响应不含 Key', assertNoKeyLeak(r.text));

  // chat/reply 走 DB 激活模型
  const chatPayload = {
    project_id: PROJECT_ID,
    layers: [{ layer: 'L0', name: '基座', content: '你是{{industry}}语音客服，场景{{business_scene}}，目标{{core_goal}}。' }],
    context_data: { industry: '旅游行业', business_scene: ['停车缴费'], core_goal: ['安抚客户情绪'] },
    messages: [{ role: 'user', content: '只回复 OK' }],
  };
  r = await post('/api/chat/reply', chatPayload, 120000);
  check('DB 激活模型下 /api/chat/reply 真实成功', r.status === 200 && r.json && r.json.success === true && typeof r.json.reply === 'string' && r.json.reply.trim().length > 0, r.json && { status: r.status, error: r.json.error });

  // DB 模型故障 -> 自动回落 .env（用不可达 base_url 制造失败，验证防全盘崩溃）
  const allModels = ((await get('/api/models')).json || {}).data || [];
  const existingBad = allModels.find((m) => m.display_name === BAD_MODEL_DISPLAY_NAME);
  r = await post('/api/models/save', {
    id: existingBad ? existingBad.id : undefined,
    provider: 'deepseek',
    display_name: BAD_MODEL_DISPLAY_NAME,
    base_url: 'https://api.deepseek.com/v1',
    model_name: 'deepseek-chat',
    api_key: 'sk-invalid-smoke-test-key-1234567890',
    is_active: true,
  });
  check('保存「无效 Key 官方模型」并激活成功（安全策略：官方域名允许显式 Key）', r.status === 200 && r.json && r.json.success === true, r.json);
  const badModelId = r.json && r.json.id;
  r = await post('/api/chat/reply', chatPayload, 120000);
  check('DB 模型请求失败 -> 自动回落 .env 重试成功（防全盘崩溃）', r.status === 200 && r.json && r.json.success === true && typeof r.json.reply === 'string' && r.json.reply.trim().length > 0, r.json && { status: r.status, error: r.json.error });

  // 无激活模型 -> .env 回退
  if (badModelId) await post('/api/models/save', { id: badModelId, provider: 'deepseek', display_name: BAD_MODEL_DISPLAY_NAME, base_url: 'http://127.0.0.1:1/v1', model_name: 'deepseek-chat', api_key: '', is_active: false });
  await post('/api/models/save', { id: modelId, provider: 'deepseek', display_name: MODEL_DISPLAY_NAME, base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: false });
  const noActive = ((await get('/api/models')).json || {}).data || [];
  check('可将全部模型置为非激活（无激活模型）', noActive.every((m) => Number(m.is_active) !== 1), noActive.map((m) => ({ id: m.id, active: m.is_active })));
  r = await post('/api/chat/reply', chatPayload, 120000);
  check('无激活模型时 .env 回退仍可用', r.status === 200 && r.json && r.json.success === true && typeof r.json.reply === 'string' && r.json.reply.trim().length > 0, r.json && { status: r.status, error: r.json.error });

  // 恢复一条激活模型（供后续浏览器验收）
  r = await post('/api/models/save', { id: modelId, provider: 'deepseek', display_name: MODEL_DISPLAY_NAME, base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: '', is_active: true, temperature: 0.3 });
  const actived = ((await get('/api/models')).json || {}).data || [];
  check('恢复一条激活模型（单活：仅 1 条 is_active=1）', r.status === 200 && r.json.success === true && actived.filter((m) => Number(m.is_active) === 1).length === 1, actived.map((m) => ({ id: m.id, display_name: m.display_name, active: m.is_active })));

  console.log('');
  console.log('[2] 阶段四：知识库在线编辑');
  r = await get(`/api/kb/list?project_id=${encodeURIComponent(PROJECT_ID)}`);
  const kbList = (r.json && r.json.data) || [];
  check('知识库列表可用（回归）', r.status === 200 && r.json.success === true && kbList.length > 0, { count: kbList.length });
  const target = kbList[0];
  const originQuestion = target.question;
  const originAnswer = target.answer;
  const marker = '【V3-P24编辑测试】';
  r = await post('/api/kb/update', { id: target.id, question: originQuestion + marker, answer: originAnswer + marker });
  check('POST /api/kb/update 更新成功', r.status === 200 && r.json && r.json.success === true && r.json.message === '更新成功', r.json);
  const afterList = ((await get(`/api/kb/list?project_id=${encodeURIComponent(PROJECT_ID)}`)).json || {}).data || [];
  const updatedItem = afterList.find((x) => x.id === target.id);
  check('KB 更新已持久化', Boolean(updatedItem) && updatedItem.question.includes(marker) && updatedItem.answer.includes(marker), updatedItem);
  r = await post('/api/kb/update', { id: target.id, question: originQuestion, answer: originAnswer });
  check('KB 编辑已还原原始内容', r.status === 200 && r.json.success === true, r.json);
  r = await post('/api/kb/update', { id: 'not-exist-kb-id', question: 'q', answer: 'a' });
  check('KB 更新不存在 id -> 404', r.status === 404 && r.json && r.json.success === false, r.json);
  r = await post('/api/kb/update', { id: target.id, question: '', answer: '' });
  check('KB 更新空字段 -> 400', r.status === 400 && r.json && r.json.success === false, r.json);
  r = await post('/api/kb/update', { question: 'q', answer: 'a' });
  check('KB 更新缺 id -> 400', r.status === 400 && r.json && r.json.success === false, r.json);

  console.log('');
  console.log('[3] 阶段四：AI 生成刁钻测试题（真实 LLM）');
  r = await post('/api/eval/generate_questions', { project_id: PROJECT_ID, count: 5 }, 120000);
  const questions = (r.json && r.json.data) || [];
  check('POST /api/eval/generate_questions 成功', r.status === 200 && r.json && r.json.success === true && Array.isArray(questions), r.json && { status: r.status, error: r.json.error });
  check('生成题目结构合法（≥1 条，user_query/standard_answer 非空字符串）', questions.length >= 1 && questions.every((q) => typeof q.user_query === 'string' && q.user_query.trim() && typeof q.standard_answer === 'string' && q.standard_answer.trim()), questions.slice(0, 2));
  check('生成题目数量合理（1~10 条）', questions.length >= 1 && questions.length <= 10, questions.length);

  console.log('');
  console.log('[4] 阶段一核心回归');
  r = await get('/api/projects');
  const project = ((r.json && r.json.data) || []).find((p) => p.id === PROJECT_ID);
  check('GET /api/projects 可用', r.status === 200 && r.json.success === true && Boolean(project), { count: ((r.json && r.json.data) || []).length });
  r = await get(`/api/context/get?project_id=${encodeURIComponent(PROJECT_ID)}`);
  check('GET /api/context/get 可用', r.status === 200 && r.json.success === true && typeof r.json.data.industry === 'string', r.json.data);
  r = await get('/');
  check('静态首页可访问', r.status === 200 && /<html/i.test(r.text), { status: r.status });

  const layers = [
    { layer: 'L0', name: '公共基座', content: '面向 {{industry}} 的语音助手，场景 {{business_scene}}，目标 {{core_goal}}。' },
    { layer: 'L3', name: '项目层', content: '再次强调：{{industry}} / {{business_scene}} / {{core_goal}}。' },
  ];
  const contextData = { industry: '旅游行业', business_scene: ['停车缴费'], core_goal: ['安抚客户情绪'] };
  r = await post('/api/snapshots/create', { project_id: PROJECT_ID, layers, context_data: contextData });
  const snapshotId = r.json && r.json.snapshot_id;
  check('POST /api/snapshots/create 成功且占位符全替换', r.status === 200 && r.json.success === true && noPlaceholders(r.json.final_prompt) && r.json.final_prompt.includes('旅游行业'), r.json && r.json.final_prompt && r.json.final_prompt.slice(0, 100));
  r = await get(`/api/snapshots/detail?id=${encodeURIComponent(snapshotId)}`);
  const detail = (r.json && r.json.data) || {};
  check('GET /api/snapshots/detail 含 layers/eval_pass/eval_score', r.status === 200 && Array.isArray(detail.layers) && detail.layers.length === 2 && detail.eval_pass === 1 && detail.eval_score === 5, { layers: detail.layers && detail.layers.length, eval_pass: detail.eval_pass });
  r = await post('/api/prompt/assemble', { layers, context_data: contextData });
  check('POST /api/prompt/assemble 成功且与快照一致', r.status === 200 && r.json.success === true && r.json.final_prompt === detail.final_prompt_content, r.json && r.json.final_prompt && r.json.final_prompt.slice(0, 80));
  r = await get(`/api/gate/export?snapshot_id=${encodeURIComponent(snapshotId)}`);
  check('GET /api/gate/export 含 PROJECT_NAME 且 no-store', r.status === 200 && r.text.includes(`# PROJECT_NAME: ${project.name}`) && /no-store/.test(r.headers.get('cache-control') || '') && noPlaceholders(r.text), r.text.slice(0, 120));
  r = await requestBuffer(`/api/projects/export_zip?project_id=${encodeURIComponent(PROJECT_ID)}`);
  let zipEntries = [];
  try { zipEntries = parseZip(r.buffer); } catch { zipEntries = []; }
  check('GET /api/projects/export_zip 返回合法 Zip', r.status === 200 && r.buffer.length > 4 && r.buffer[0] === 0x50 && r.buffer[1] === 0x4b && zipEntries.some((e) => e.name === 'manifest.json'), { status: r.status });
  r = await get('/api/settings/api-key');
  check('GET /api/settings/api-key 仍只回 masked', r.status === 200 && r.json.success === true && typeof r.json.data.masked === 'string' && typeof r.json.data.has_key === 'boolean', r.json && r.json.data);

  console.log('');
  console.log('------------------------------------------------------------');
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\u2705 server-smoke v3 阶段二/四 全部通过：${passed}/${total} 项`);
    process.exitCode = 0;
  } else {
    console.log(`\u274c server-smoke v3 阶段二/四 失败：${failed}/${total} 项`);
    for (const item of results) console.log(`   - ${item.name} :: ${JSON.stringify(item.detail).slice(0, 400)}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('\n\u274c 冒烟脚本异常:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
