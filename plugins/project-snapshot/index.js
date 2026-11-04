// plugins/project-snapshot/index.js
import { db } from '../db.js';
import crypto from 'crypto';
import { checkL1, evaluateL2 } from '../eval-runner/index.js'; // 引入评测函数

export const name = 'project-snapshot'
export const inject = ['webServer']

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3.5', 'L3']

function assemblePrompt(layers) {
  const sorted = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  const prompt = sorted.map(l => `\n\n### ${l.name} (${l.layer})\n${l.content}`).join('');
  const warnings = [];
  if (prompt.includes('严禁') && prompt.includes('Markdown') && /列表|列出|1\.\s*2\./.test(prompt)) {
    if (!prompt.includes('不要用列表')) warnings.push('潜在冲突：存在“严禁 Markdown”与“使用列表”的指令，请人工确认');
  }
  return { prompt, warnings };
}

export function apply(ctx) {
  console.log('[project-snapshot] 组装引擎已加载')

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

  // 1. 组装并生成快照（增加评测强绑定）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/create', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const { project_id, layers, evalData } = body;
      if (!layers || !Array.isArray(layers)) return sendJson(400, { error: '缺少 layers' });
      if (!evalData) return sendJson(400, { error: '必须提供测试数据以进行发布前评测' });

      // 1. 执行评测
      const l1 = checkL1(evalData.bot_reply);
      const l2 = await evaluateL2(evalData.user_query, evalData.standard_answer, evalData.bot_reply);
      
      const isPassed = l1.pass && l2.pass && l2.score >= 4; // 综合判定标准
      
      // 2. 组装
      const { prompt, warnings } = assemblePrompt(layers);
      const snapshotId = 'snap-' + crypto.randomUUID().split('-')[0];
      const now = new Date().toISOString();
      
      // 3. 存入数据库（记录评测结果）
      db.prepare(`
        INSERT INTO snapshots (id, project_id, module_versions_json, final_prompt_content, created_at, eval_pass, eval_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(snapshotId, project_id, JSON.stringify(layers), prompt, now, isPassed ? 1 : 0, l2.score);

      sendJson(200, { 
        success: true, 
        snapshot_id: snapshotId, 
        warnings, 
        eval_pass: isPassed,
        eval_result: { l1, l2 },
        message: isPassed ? '评测通过，快照已成功存入数据库！' : '评测未通过，快照已存为草稿（无法导出）'
      });
    }})
  }), 'snapshot: create')

  // 2. 获取最新快照（用于回填）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/latest', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      if (!params.project_id) return sendJson(400, { error: '缺少 project_id' });
      const row = db.prepare('SELECT module_versions_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(params.project_id);
      if (!row) return sendJson(200, { success: true, data: null });
      sendJson(200, { success: true, data: JSON.parse(row.module_versions_json) });
    }})
  }), 'snapshot: latest')

  // 3. 获取快照列表
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/list', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      const rows = db.prepare('SELECT id, created_at, eval_pass, eval_score FROM snapshots WHERE project_id = ? ORDER BY created_at DESC').all(params.project_id || '');
      sendJson(200, { success: true, data: rows });
    }})
  }), 'snapshot: list')

  // ---- 保持原有的公司、项目增删改查接口逻辑 ----
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects', kind: 'exact', handler: createHandler({ needsPost: false, run: async (b,p,s) => s(200, { success: true, data: db.prepare('SELECT * FROM projects').all() }) }) }), 'api: projects')
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects/create', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { const id='proj-'+crypto.randomUUID().split('-')[0]; db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id) VALUES (?, ?, ?, ?)').run(id, b.company_id, b.name, ''); s(200, { success: true, id, message: '创建成功' }) } }) }), 'api: projects:create')
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects/update', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(b.name, b.id); s(200, { success: true, message: '修改成功' }) } }) }), 'api: projects:update')
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies', kind: 'exact', handler: createHandler({ needsPost: false, run: async (b,p,s) => s(200, { success: true, data: db.prepare('SELECT * FROM companies').all() }) }) }), 'api: companies')
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies/create', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { const id='comp-'+crypto.randomUUID().split('-')[0]; db.prepare('INSERT INTO companies (id, name, category) VALUES (?, ?, ?)').run(id, b.name, '默认'); s(200, { success: true, id, message: '创建成功' }) } }) }), 'api: companies:create')
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies/update', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(b.name, b.id); s(200, { success: true, message: '修改成功' }) } }) }), 'api: companies:update')
}