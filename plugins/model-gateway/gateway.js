// plugins/model-gateway/gateway.js
import 'dotenv/config'; // 自动读取根目录 .env 文件中的环境变量
import pLimit from 'p-limit';

// 控制最大并发数为 5
const limit = pLimit(5);

/**
 * 调用大模型 API
 */
export async function chatCompletion(config, messages) {
  return limit(async () => {
    // 处理 URL 末尾斜杠
    const baseUrl = config.base_url.replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;
    
    // 如果传入的 config 里没有 api_key，就自动去环境变量里找 DEEPSEEK_API_KEY
    const finalApiKey = config.api_key || process.env.DEEPSEEK_API_KEY;
    
    if (!finalApiKey) {
      throw new Error('未提供 API Key，且环境变量中未找到 DEEPSEEK_API_KEY');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalApiKey}`, // 使用最终确定的 Key
      },
      body: JSON.stringify({
        model: config.model_name,
        messages: messages,
        temperature: config.temperature || 0.1,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM 调用失败 (${res.status}): ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  });
}

/**
 * 容错解析 JSON (防止大模型输出带 markdown 格式)
 */
export function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 尝试用正则提取 JSON 块
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {}
    }
    throw new Error('无法解析为 JSON: ' + raw.slice(0, 100));
  }
}