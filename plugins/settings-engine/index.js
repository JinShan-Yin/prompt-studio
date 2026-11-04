// plugins/settings-engine/index.js
//
// Sprint3 模块五后端：API Key 设置接口（DeepSeek）
// - GET  /api/settings/api-key  读取当前 Key 的脱敏信息（has_key / masked / source），绝不返回完整 Key
// - POST /api/settings/api-key  校验后更新 process.env（立即生效，无需重启）并原子写回项目根 .env
//
// 安全约束（重要）：
// - 任何响应 / 日志路径都不允许出现完整 Key；masked 规则：长度>8 取前 3 + '****' + 后 4，否则 '****'
// - POST 的 JSON 解析失败时返回固定文案，不把原始 body 片段带进 error（V8 的 JSON.parse 报错可能截取输入片段）
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const name = 'settings-engine'
export const inject = ['webServer']

export const KEY_NAME = 'DEEPSEEK_API_KEY'
export const API_KEY_MIN_LENGTH = 20

// 项目根 .env：与 db.js 一致，以服务进程 cwd 为项目根（启动.bat 在项目根目录启动）
const ENV_PATH = path.join(process.cwd(), '.env')

/** 转义正则元字符，避免 keyName 影响匹配 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * API Key 脱敏（纯函数）：长度 > 8 -> 前 3 + '****' + 后 4；否则 '****'。
 * 绝不返回完整 Key；空值 / 非字符串不抛错。
 */
export function maskApiKey(raw) {
  if (typeof raw !== 'string') return '****'
  const key = raw.trim()
  if (!key) return '****'
  if (key.length > 8) return `${key.slice(0, 3)}****${key.slice(-4)}`
  return '****'
}

/** 校验 API Key（纯函数）：长度 >= 20 且不含空白/换行 */
export function validateApiKey(raw) {
  if (typeof raw !== 'string') return false
  const key = raw.trim()
  if (key.length < API_KEY_MIN_LENGTH) return false
  return !/\s/.test(key)
}

/**
 * 把 .env 内容中的 KEY 行替换为 KEY=value（不存在则追加到末尾）（纯函数）。
 * - 保留其它行、注释、空行与原有换行；
 * - 用回调函数替换，value 中的 $& / $' / $` 等特殊字符按字面量写入，不会被当成替换语法。
 */
export function upsertEnvLine(envContent, keyName = KEY_NAME, value = '') {
  const content = typeof envContent === 'string' ? envContent : ''
  const name = typeof keyName === 'string' && keyName.trim() ? keyName.trim() : KEY_NAME
  const line = `${name}=${String(value ?? '')}`
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*=.*$`, 'm')
  if (pattern.test(content)) return content.replace(pattern, () => line)
  if (!content) return `${line}\n`
  const separator = content.endsWith('\n') ? '' : '\n'
  return `${content}${separator}${line}\n`
}

/** 从 .env 文本中解析 KEY 的值（支持单/双引号包裹，纯内部辅助） */
function parseEnvValue(envContent, keyName) {
  if (typeof envContent !== 'string' || !envContent) return ''
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(keyName)}[ \\t]*=(.*)$`, 'm')
  const match = envContent.match(pattern)
  if (!match) return ''
  let value = match[1].trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
  }
  return value.trim()
}

/** 读取项目根 .env 内容（不存在 / 无权限 -> 空串，不抛错） */
function readEnvContent() {
  try { return fs.readFileSync(ENV_PATH, 'utf-8') } catch { return '' }
}

/** 当前生效的 Key：优先 process.env（运行时已加载的），否则回落到 .env 文件解析 */
function getCurrentApiKey() {
  const fromProcess = typeof process.env[KEY_NAME] === 'string' ? process.env[KEY_NAME].trim() : ''
  if (fromProcess) return fromProcess
  return parseEnvValue(readEnvContent(), KEY_NAME)
}

/** 原子写 .env：写临时文件 + rename，避免写一半损坏配置 */
function atomicWriteEnv(content) {
  const directory = path.dirname(ENV_PATH)
  const tmpPath = path.join(directory, `.env.tmp-${process.pid}-${crypto.randomUUID().split('-')[0]}`)
  let mode = 0o600
  try { mode = fs.statSync(ENV_PATH).mode } catch { /* 文件不存在，用默认权限 */ }
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode })
  try {
    fs.renameSync(tmpPath, ENV_PATH)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore cleanup error */ }
    throw e
  }
}

export function apply(ctx) {
  console.log('[settings-engine] 设置引擎已加载')

  const handler = async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      return res.end()
    }
    const sendJson = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(data))
    }
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(405, { success: false, error: 'Method Not Allowed' })

    try {
      // ---- GET：只返回脱敏信息 ----
      if (req.method === 'GET') {
        const key = getCurrentApiKey()
        return sendJson(200, { success: true, data: { has_key: Boolean(key), masked: maskApiKey(key), source: 'env' } })
      }

      // ---- POST：校验 -> 原子写 .env -> 更新 process.env（立即生效）----
      const buffers = []; for await (const chunk of req) buffers.push(chunk)
      const rawBody = Buffer.concat(buffers).toString('utf-8')
      let body = {}
      if (rawBody.length > 0) {
        try { body = JSON.parse(rawBody) } catch { return sendJson(400, { success: false, error: '请求体不是合法 JSON' }) }
      }
      const rawKey = body && typeof body === 'object' ? body.api_key : undefined
      const trimmedKey = typeof rawKey === 'string' ? rawKey.trim() : ''

      // trim 后为空：保持原值，不写文件
      if (!trimmedKey) {
        const current = getCurrentApiKey()
        return sendJson(200, { success: true, updated: false, masked: maskApiKey(current), message: '未提供新 Key，保持原值' })
      }

      if (!validateApiKey(trimmedKey)) {
        return sendJson(400, { success: false, error: 'API Key 格式不正确（长度需≥20 且不含空白）' })
      }

      // 先写文件，成功后再更新 process.env，避免出现「半生效」状态
      atomicWriteEnv(upsertEnvLine(readEnvContent(), KEY_NAME, trimmedKey))
      process.env[KEY_NAME] = trimmedKey
      return sendJson(200, { success: true, updated: true, masked: maskApiKey(trimmedKey), message: 'API Key 已保存并立即生效' })
    } catch (e) {
      console.error('[settings-engine] API Key 设置接口异常:', e.message)
      sendJson(500, { success: false, error: e.message })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    path: '/api/settings/api-key', kind: 'exact',
    handler,
  }), 'settings: api-key')
}
