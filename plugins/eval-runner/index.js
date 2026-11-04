// plugins/eval-runner/index.js
import * as cheerio from 'cheerio';
import { chatCompletion, safeParseJson } from '../model-gateway/gateway.js';

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
}