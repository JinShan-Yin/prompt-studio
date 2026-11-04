// plugins/context-engine/index.js
//
// 模块二后端：AI 语境分析引擎（行业 / 业务场景 / 核心目标）
// 接口：
//   GET  /api/context/get?project_id=xxx   读取项目语境（安全解析 projects.context_json）
//   POST /api/context/save                 保存项目语境（归一化后写入 projects.context_json）
//   POST /api/context/extract              读取项目知识库 -> 调 DeepSeek 提取语境 JSON
//
// 说明：数据库连接在 handler 内按需动态 import（getDb），
// 这样 normalizeContext / parseExtractResult / applyContextReplace 等纯函数
// 可以被 test-data/backend-selftest.mjs 直接 import 做无服务器单测，
// 不会因为 import 本模块而打开（或迁移）正在被服务使用的 data/prompt-studio.db。

import { chatCompletion, safeParseJson } from '../model-gateway/gateway.js';

export const name = 'context-engine'
export const inject = ['webServer']

// 与 kb-manager / eval-runner 保持一致；api_key 由 gateway 自动从 .env 的 DEEPSEEK_API_KEY 读取
const LLM_CONFIG = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.1 }

// 发送给大模型的知识库文本上限（字符），防止超出上下文
const KB_TEXT_MAX = 12000

// 懒加载数据库：纯函数单测不能有打开 DB 的副作用
let dbPromise = null
function getDb() {
  if (!dbPromise) dbPromise = import('../db.js').then((m) => m.db)
  return dbPromise
}

/** 把任意值收敛成「去重后的非空字符串数组」：字符串 -> [字符串]，非数组 -> [] */
function toTagArray(value) {
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) return []
  const result = []
  const seen = new Set()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/**
 * 语境归一化：null / 坏 JSON / 非对象 / 字段类型不对，一律收敛为安全结构。
 * @param {*} raw 可能是对象、JSON 字符串（来自 DB）、null 或任意脏数据
 * @returns {{industry: string, business_scene: string[], core_goal: string[]}}
 */
export function normalizeContext(raw) {
  let data = raw
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { data = null }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
  return {
    industry: typeof data.industry === 'string' ? data.industry.trim() : '',
    business_scene: toTagArray(data.business_scene),
    core_goal: toTagArray(data.core_goal),
  }
}

/** 语境 -> 最终用于替换的字面量：industry 空 -> '通用'；数组 join('、')，空数组/无效 -> '通用' */
export function contextToReplacements(rawContext) {
  const context = normalizeContext(rawContext)
  const joinTags = (tags) => (tags.length > 0 ? tags.join('、') : '通用')
  return {
    industry: context.industry || '通用',
    business_scene: joinTags(context.business_scene),
    core_goal: joinTags(context.core_goal),
  }
}

/**
 * 在完整长文本上全局替换 {{industry}} / {{business_scene}} / {{core_goal}}。
 * - 用带 g 的正则 + 回调函数替换：替换值内含 $& / $' / $` / $1 等字符时按字面量输出，不会炸；
 * - 正则容忍花括号内空白（含换行）：{{  industry  }}、{{\n industry \n}} 均可命中。
 * @param {string} text 组装后的完整长文本（L0~L3 全量）
 * @param {*} rawContext 语境（对象或 JSON 字符串）
 * @returns {string}
 */
export function applyContextReplace(text, rawContext) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const values = contextToReplacements(rawContext)
  return source
    .replace(/\{\{\s*industry\s*\}\}/g, () => values.industry)
    .replace(/\{\{\s*business_scene\s*\}\}/g, () => values.business_scene)
    .replace(/\{\{\s*core_goal\s*\}\}/g, () => values.core_goal)
}

/**
 * 大模型返回内容 -> 安全语境结构（结构校验兜底，硬性要求）。
 * 1) 先用 /\{[\s\S]*\}/ 提取 JSON 再 JSON.parse；失败再用 safeParseJson 兜底；
 * 2) industry 非字符串 -> ''；business_scene / core_goal 是字符串 -> [字符串]；非法数组项过滤。
 * @param {string} raw 大模型原始回复
 * @returns {{industry: string, business_scene: string[], core_goal: string[]}}
 * @throws 完全无法解析成 JSON 对象时抛错（接口层转 500）
 */
export function parseExtractResult(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  let parsed = null
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try { parsed = JSON.parse(match[0]) } catch { parsed = null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    try { parsed = safeParseJson(text) } catch { parsed = null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('大模型返回内容无法解析为 JSON 对象')
  }
  return normalizeContext(parsed)
}

/** 安全读取项目语境：旧库没有 context_json 列 / 坏 JSON 时返回默认语境，绝不 500 */
function readProjectContext(db, projectId) {
  try {
    const row = db.prepare('SELECT context_json FROM projects WHERE id = ?').get(projectId)
    return normalizeContext(row?.context_json)
  } catch (e) {
    console.warn('[context-engine] 读取 projects.context_json 失败，返回默认语境:', e.message)
    return normalizeContext(null)
  }
}

export function apply(ctx) {
  console.log('[context-engine] 语境分析引擎已加载')

  const createHandler = (logic) => async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
    const sendJson = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)) }
    if (req.method !== 'POST' && logic.needsPost) return sendJson(405, { error: 'Method Not Allowed' })
    try {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const rawBody = Buffer.concat(buffers).toString('utf-8');
      const body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const params = Object.fromEntries(urlObj.searchParams);
      await logic.run(body, params, sendJson);
    } catch (e) { sendJson(500, { success: false, error: e.message }) }
  }

  // 1) 读取项目语境
  ctx.effect(() => ctx.webServer.register({
    path: '/api/context/get', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      const projectId = params.project_id || body.project_id || '';
      if (!projectId) return sendJson(400, { success: false, error: '缺少 project_id' });
      const db = await getDb();
      const context = readProjectContext(db, projectId);
      sendJson(200, { success: true, data: context });
    }})
  }), 'context: get')

  // 2) 保存项目语境（归一化后写入 projects.context_json，供切换项目回填）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/context/save', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const projectId = body.project_id || params.project_id || '';
      if (!projectId) return sendJson(400, { success: false, error: '缺少 project_id' });
      const context = normalizeContext(body.context_data);
      const db = await getDb();
      const info = db.prepare('UPDATE projects SET context_json = ? WHERE id = ?').run(JSON.stringify(context), projectId);
      sendJson(200, { success: true, updated: info.changes > 0, data: context });
    }})
  }), 'context: save')

  // 3) 读取知识库 -> 大模型提取语境（结构化 JSON）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/context/extract', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const projectId = body.project_id || params.project_id || '';
      if (!projectId) return sendJson(400, { success: false, error: '缺少 project_id' });

      const db = await getDb();
      const rows = db.prepare('SELECT question, answer FROM kb_items WHERE project_id = ?').all(projectId);
      if (rows.length === 0) {
        return sendJson(200, { success: false, message: '知识库为空，请先解析入库知识库' });
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
      const rawReply = await chatCompletion(LLM_CONFIG, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      const data = parseExtractResult(rawReply);
      sendJson(200, { success: true, data, message: '语境提取成功' });
    }})
  }), 'context: extract')
}
