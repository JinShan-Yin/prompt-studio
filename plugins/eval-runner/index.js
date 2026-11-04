// plugins/eval-runner/index.js
import * as cheerio from 'cheerio';
import { chatCompletion, safeParseJson } from '../model-gateway/gateway.js';
import { assemblePrompt } from '../project-snapshot/index.js';
import { applyContextReplace, normalizeContext } from '../context-engine/index.js';
import { db } from '../db.js';

export const name = 'eval-runner'
export const inject = ['webServer']

// L1 确定性断言
export function checkL1(agentOutput) {
  const errors = [];
  const speakIndex = agentOutput.indexOf('<speak>');
  const toolIndex = agentOutput.indexOf('<tool>');
  
  if (speakIndex === -1 && toolIndex !== -1) errors.push('违规：检测到工具调用，但缺少播报话术 <speak>');
  else if (speakIndex !== -1 && toolIndex !== -1 && speakIndex > toolIndex) errors.push('违规时序：工具调用 <tool> 出现在了语音播报 <speak> 之前');

  if (/\*\*|^#+\s|^\s*-\s/m.test(agentOutput)) errors.push('违规格式：包含 Markdown 标记');
  if (/[一二三四五六七八九十百千万]+/g.test(agentOutput)) errors.push('违规播报：检测到中文数字单位，电话号码必须逐位播报');

  return { pass: errors.length === 0, errors };
}

// L2 语义评测
export async function evaluateL2(userQuery, standardAnswer, botReply) {
  const systemPrompt = `你是一个极其严格的智能语音客服质量评测专家。你的任务是根据【知识库标准答案】和【机器人语音回复】，对机器人进行打分。
【评测原则】
1. 事实绝对优先：严格核对数字、时间、条件，必须与知识库完全一致。
2. 忽略标点差异，重点评估是否有书面语。
【输出格式要求】
必须且只能输出以下 JSON 格式，不要输出 Markdown 标记：
{"score": <1到5的整数>, "pass": <true或false>, "violations": ["错误点"], "comment": "简短评价"}`;

  const userPrompt = `【用户提问】：${userQuery}\n【知识库标准答案】：${standardAnswer}\n【机器人语音回复】：${botReply}`;
  const modelConfig = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.1 };

  const rawReply = await chatCompletion(modelConfig, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);
  return safeParseJson(rawReply);
}

// ===== Sprint2 模块四：多轮对话模拟器（/api/chat/reply）纯函数与配置 =====

// 多轮对话历史条数上限（控制上下文长度）
export const CHAT_HISTORY_LIMIT = 12
// 单条消息内容最大字符数
export const CHAT_CONTENT_MAX = 4000
// layers 组装结果为空时的默认客服角色
export const DEFAULT_CHAT_ROLE = '你是一个专业、礼貌、高效的智能语音客服助手。'
// 语音业务输出约束：每次回复都必须整体包裹 <speak>
export const CHAT_OUTPUT_CONSTRAINTS = '\n\n【输出约束】请使用自然口语回答；最终回复必须整体用 <speak>...</speak> 包裹；禁止使用 Markdown、列表符号或标题。'

// 多轮对话 LLM 配置：temperature 比评测稍高以模拟真实对话；api_key 由 gateway 自动从 .env 读取
const CHAT_LLM_CONFIG = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.7 }

/** layers 中是否存在有效内容层：至少一层的 content 去掉空白后非空 */
function hasLayerContent(layers) {
  return Array.isArray(layers) && layers.some((l) => String(l?.content ?? '').trim().length > 0)
}

/**
 * 组装多轮对话的 System Prompt（纯函数，不碰 DB）。
 * 1) P2-4 修复：前端恒发 3 层，编辑器为空时 assemblePrompt 仍会拼出「### 名称 (L0)」空壳，
 *    因此先判断是否存在有效内容层；全部为空 -> 直接回落默认客服角色句（不产生空壳标题）。
 * 2) 有内容时：用 layers 组装完整长文本，并在完整长文本上替换 {{industry}} / {{business_scene}} / {{core_goal}}
 * 3) 末尾始终追加语音业务【输出约束】
 */
export function buildChatSystemPrompt(layers, contextData) {
  if (!hasLayerContent(layers)) return `${DEFAULT_CHAT_ROLE}${CHAT_OUTPUT_CONSTRAINTS}`
  const assembled = applyContextReplace(assemblePrompt(layers), contextData)
  const base = assembled.trim().length > 0 ? assembled : DEFAULT_CHAT_ROLE
  return `${base}${CHAT_OUTPUT_CONSTRAINTS}`
}

/**
 * 清洗多轮对话 messages（纯函数）：
 * - 非数组 / 空数组 -> []
 * - 只保留 role 为 user / assistant 的记录，丢弃其它字段
 * - content 统一转字符串并截断到 CHAT_CONTENT_MAX（4000）字符
 * - 只取最近 CHAT_HISTORY_LIMIT（12）条
 */
export function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages)) return []
  const cleaned = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const rawContent = message.content
    const content = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : String(rawContent)
    cleaned.push({ role: message.role, content: content.slice(0, CHAT_CONTENT_MAX) })
  }
  return cleaned.slice(-CHAT_HISTORY_LIMIT)
}

/** body.context_data 必须是「对象且非空」才优先于数据库 */
function isUsableChatContextData(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

/** 从 DB 安全读取项目语境：无 project_id / 旧库无列 / 坏 JSON 一律回落默认语境，不抛错 */
function readProjectContextSafe(projectId) {
  if (!projectId || typeof projectId !== 'string') return normalizeContext(null)
  try {
    const row = db.prepare('SELECT context_json FROM projects WHERE id = ?').get(projectId)
    return normalizeContext(row?.context_json)
  } catch (e) {
    console.warn('[eval-runner] 读取项目语境失败，使用默认语境:', e.message)
    return normalizeContext(null)
  }
}

export function apply(ctx) {
  console.log('[eval-runner] 评测引擎已加载');

  // 注册真实评测接口
  ctx.effect(() => ctx.webServer.register({
    path: '/api/eval/run',
    kind: 'exact',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
        return res.end()
      }
      const sendJson = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(data))
      }
      if (req.method !== 'POST') return sendJson(405, { error: 'Method Not Allowed' })

      try {
        const buffers = []; for await (const chunk of req) buffers.push(chunk);
        const { bot_reply, standard_answer, user_query } = JSON.parse(Buffer.concat(buffers).toString('utf-8'))
        
        const l1 = checkL1(bot_reply)
        const l2 = await evaluateL2(user_query, standard_answer, bot_reply)
        
        sendJson(200, { success: true, l1, l2 })
      } catch (e) { sendJson(500, { success: false, error: e.message }) }
    }
  }), 'eval-runner: /api/eval/run')

  // ===== Sprint2 模块四：多轮对话模拟器 LLM 代理 =====
  ctx.effect(() => ctx.webServer.register({
    path: '/api/chat/reply',
    kind: 'exact',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
        return res.end()
      }
      const sendJson = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(data))
      }
      if (req.method !== 'POST') return sendJson(405, { success: false, error: 'Method Not Allowed' })

      try {
        const buffers = []; for await (const chunk of req) buffers.push(chunk)
        const rawBody = Buffer.concat(buffers).toString('utf-8')
        const body = rawBody.length > 0 ? JSON.parse(rawBody) : {}
        const { project_id, layers, context_data } = body

        // 1) messages 校验与清洗（只留 user/assistant、截断 4000、最近 12 条）
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return sendJson(400, { success: false, error: 'messages 必须是非空数组' })
        }
        const messages = sanitizeChatMessages(body.messages)
        if (!messages.some((m) => m.role === 'user')) {
          return sendJson(400, { success: false, error: 'messages 中至少需要一条 user 消息' })
        }

        // 2) 语境：body.context_data（对象且非空）优先，否则安全读取 DB；默认 {}
        const context = isUsableChatContextData(context_data) ? normalizeContext(context_data) : readProjectContextSafe(project_id)

        // 3) System Prompt：组装 + 全局变量替换 + 末尾输出约束
        const systemPrompt = buildChatSystemPrompt(layers, context)

        // 4) 调 DeepSeek 生成符合语音业务格式的回复
        const rawReply = await chatCompletion(CHAT_LLM_CONFIG, [{ role: 'system', content: systemPrompt }, ...messages])
        const reply = typeof rawReply === 'string' ? rawReply.trim() : String(rawReply ?? '').trim()

        sendJson(200, { success: true, reply, system_prompt: systemPrompt })
      } catch (e) { sendJson(500, { success: false, error: e.message }) }
    }
  }), 'eval-runner: /api/chat/reply')
}