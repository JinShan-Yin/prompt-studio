// plugins/kb-manager/index.js
import { chatCompletion, safeParseJson } from '../model-gateway/gateway.js';
import { db } from '../db.js';
import crypto from 'crypto';

export const name = 'kb-manager'
export const inject = ['webServer']

const CHUNK_SIZE = 500;

export async function parseTxt(rawText) {
  const paragraphs = rawText.split(/\n\s*\n/).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + p).length > CHUNK_SIZE && buf) { chunks.push(buf); buf = ''; }
    buf += p + '\n';
  }
  if (buf.trim()) chunks.push(buf);

  const modelConfig = { base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', temperature: 0.1 };
  const results = [];
  const promises = chunks.map(async (chunk, index) => {
    const systemPrompt = `你是一个数据解析专家。请从以下文本中提取问答对（FAQ）。输出格式必须严格为 JSON 数组：[{"question":"...", "answer":"..."}]。不要编造任何事实。只输出 JSON。`;
    try {
      const rawReply = await chatCompletion(modelConfig, [{ role: 'system', content: systemPrompt }, { role: 'user', content: chunk }]);
      const pairs = safeParseJson(rawReply);
      return Array.isArray(pairs) ? pairs : [];
    } catch (err) { return []; }
  });
  const resolvedResults = await Promise.all(promises);
  resolvedResults.forEach(pairs => results.push(...pairs));
  return results;
}

export function apply(ctx) {
  console.log('[kb-manager] 知识库解析引擎已加载');

  const createHandler = (logic) => async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
    const sendJson = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)) }
    if (req.method !== 'POST' && logic.needsPost) return sendJson(405, { error: 'Method Not Allowed' })
    try {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const body = Buffer.concat(buffers).length > 0 ? JSON.parse(Buffer.concat(buffers).toString('utf-8')) : {};
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const params = Object.fromEntries(urlObj.searchParams);
      await logic.run(body, params, sendJson);
    } catch (e) { sendJson(500, { success: false, error: e.message }) }
  }

  // 1. 解析
  ctx.effect(() => ctx.webServer.register({
    path: '/api/kb/parse', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      if (!body.raw_text) return sendJson(400, { error: '文本不能为空' });
      const pairs = await parseTxt(body.raw_text);
      sendJson(200, { success: true, data: pairs });
    }})
  }), 'kb: parse')

  // 2. 入库
  ctx.effect(() => ctx.webServer.register({
    path: '/api/kb/save', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const { project_id, pairs } = body;
      const insertItem = db.prepare('INSERT INTO kb_items (id, project_id, question, answer) VALUES (?, ?, ?, ?)');
      const insertVer = db.prepare('INSERT INTO kb_item_versions (id, item_id, version_hash, content, is_deleted) VALUES (?, ?, ?, ?, 0)');
      db.transaction(() => {
        for (const pair of pairs) {
          const itemId = 'kb-' + crypto.randomUUID().split('-')[0];
          const versionId = 'v-' + crypto.randomUUID().split('-')[0];
          const contentStr = JSON.stringify(pair);
          const hash = crypto.createHash('md5').update(contentStr).digest('hex');
          insertItem.run(itemId, project_id, pair.question, pair.answer);
          insertVer.run(versionId, itemId, hash, contentStr);
        }
      })();
      sendJson(200, { success: true, message: `已成功入库 ${pairs.length} 条` });
    }})
  }), 'kb: save')

  // 3. 获取列表
  ctx.effect(() => ctx.webServer.register({
    path: '/api/kb/list', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      const rows = db.prepare('SELECT id, question, answer FROM kb_items WHERE project_id = ?').all(params.project_id || '');
      sendJson(200, { success: true, data: rows });
    }})
  }), 'kb: list')

  // 4. 删除条目
  ctx.effect(() => ctx.webServer.register({
    path: '/api/kb/delete', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      if (!body.id) return sendJson(400, { error: '缺少 ID' });
      db.prepare('DELETE FROM kb_items WHERE id = ?').run(body.id);
      db.prepare('UPDATE kb_item_versions SET is_deleted = 1 WHERE item_id = ?').run(body.id);
      sendJson(200, { success: true, message: '删除成功' });
    }})
  }), 'kb: delete')
}