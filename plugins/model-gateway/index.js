// plugins/model-gateway/index.js
import { db } from '../db.js';
import { chatCompletion } from './gateway.js';

export const name = 'model-gateway'

// 关键：声明本插件需要 webServer 服务
export const inject = ['webServer']

export function apply(ctx) {
  console.log('====================================')
  console.log('[model-gateway] 插件已成功加载！')
  console.log('[数据库] 已连接，路径:', db.name)
  console.log('====================================')

  // 用 ctx.webServer.register 注册路由
  ctx.effect(() => ctx.webServer.register({
    path: '/api/models/test',
    kind: 'exact',
    handler: async (req, res) => {
      
      // 1. 处理跨域预检请求 (OPTIONS)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        })
        return res.end()
      }

      // 2. 封装统一发送 JSON 的函数，强制指定 utf-8 编码
      const sendJson = (statusCode, data) => {
        res.writeHead(statusCode, { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*' 
        })
        res.end(JSON.stringify(data))
      }

      if (req.method !== 'POST') {
        return sendJson(405, { error: 'Method Not Allowed' })
      }

      try {
        // 3. 健壮的请求体读取方式
        const buffers = []
        for await (const chunk of req) {
          buffers.push(chunk)
        }
        const dataStr = Buffer.concat(buffers).toString('utf-8')
        const body = JSON.parse(dataStr)

        const { base_url, model_name } = body
        
        // 4. 注意：这里不再强制校验 api_key，因为 gateway.js 会自动从 .env 读取
        if (!base_url || !model_name) {
          return sendJson(400, { error: '缺少必要参数 (base_url, model_name)' })
        }

        // 5. 组装配置并调用大模型
        const config = { base_url, model_name, temperature: 0.1 }
        const messages = [
          { role: 'system', content: '你是一个测试助手。请简短回复：连接成功。' },
          { role: 'user', content: '测试' }
        ]

        const reply = await chatCompletion(config, messages)
        
        // 6. 返回成功结果
        sendJson(200, { success: true, message: reply })
        
      } catch (error) {
        console.error('[API 错误]', error.message)
        sendJson(500, { success: false, error: error.message })
      }
    }
  }), 'model-gateway: /api/models/test')
}