// plugins/project-snapshot/index.js
import { db } from '../db.js';
import crypto from 'crypto';
// archiver@8 是纯 ESM：无 default export，用命名导出 ZipArchive 构造 Zip 流（v7 的 archiver('zip', ...) 已移除）
import { ZipArchive } from 'archiver';
import { applyContextReplace, contextToReplacements, normalizeContext } from '../context-engine/index.js';

export const name = 'project-snapshot'
export const inject = ['webServer']

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3.5', 'L3']

// 组装：沿用原有 LAYER_ORDER 排序与 `\n\n### name (layer)\n content` 拼接
export function assemblePrompt(layers) {
  const list = Array.isArray(layers) ? layers : []
  const sorted = [...list].sort((a, b) => LAYER_ORDER.indexOf(a?.layer) - LAYER_ORDER.indexOf(b?.layer))
  return sorted.map(l => `\n\n### ${l?.name ?? ''} (${l?.layer ?? ''})\n${l?.content ?? ''}`).join('')
}

// 安全读取项目语境：旧库没有 context_json 列 / 坏 JSON 时返回默认语境，绝不 500
function readProjectContext(projectId) {
  try {
    const row = db.prepare('SELECT context_json FROM projects WHERE id = ?').get(projectId)
    return normalizeContext(row?.context_json)
  } catch (e) {
    console.warn('[project-snapshot] 读取项目语境失败，使用默认语境:', e.message)
    return normalizeContext(null)
  }
}

// body.context_data 必须是「对象且非空」才优先于数据库
function isUsableContextData(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

// 安全解析 snapshots.module_versions_json（layers）：坏 JSON / 非数组一律返回 []
function safeParseLayers(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
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

  // --- 快照相关 ---
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/create', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const { project_id, layers, context_data } = body;
      if (!project_id || typeof project_id !== 'string') return sendJson(400, { success: false, error: '缺少 project_id' });
      if (!Array.isArray(layers)) return sendJson(400, { success: false, error: 'layers 必须是数组' });

      // 1) 语境来源：body.context_data（对象且非空）优先；否则安全读取 DB projects.context_json；默认 {}
      const useBodyContext = isUsableContextData(context_data);
      const context = useBodyContext ? normalizeContext(context_data) : readProjectContext(project_id);

      // 2) 关键修复：在「完整长文本」上做全局变量替换，占位符无论在 L0 还是 L3 都生效
      const prompt = applyContextReplace(assemblePrompt(layers), context);

      // 3) 请求体带语境时同步持久化，供切换项目时回填
      if (useBodyContext) {
        try {
          db.prepare('UPDATE projects SET context_json = ? WHERE id = ?').run(JSON.stringify(context), project_id);
        } catch (e) {
          console.warn('[project-snapshot] 语境持久化失败（快照仍会生成）:', e.message);
        }
      }

      const snapshotId = 'snap-' + crypto.randomUUID().split('-')[0];
      const now = new Date().toISOString();

      db.prepare(`INSERT INTO snapshots (id, project_id, module_versions_json, final_prompt_content, created_at, eval_pass, eval_score) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshotId, project_id, JSON.stringify(layers), prompt, now, 1, 5.0);

      sendJson(200, { success: true, snapshot_id: snapshotId, final_prompt: prompt, context_applied: contextToReplacements(context), message: '快照成功存入' });
    }})
  }), 'snapshot: create')

  // 获取快照列表接口
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/list', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      if (!params.project_id) return sendJson(400, { success: false, error: '缺少 project_id' });
      const rows = db.prepare('SELECT id, created_at, eval_pass, eval_score FROM snapshots WHERE project_id = ? ORDER BY created_at DESC').all(params.project_id);
      sendJson(200, { success: true, data: rows });
    }})
  }), 'snapshot: list')

  // 获取单条快照详情（含最终 Prompt，供前端/测试验证变量替换结果）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/snapshots/detail', kind: 'exact',
    handler: createHandler({ needsPost: false, run: async (body, params, sendJson) => {
      const id = params.id || body.id;
      if (!id) return sendJson(400, { success: false, error: '缺少 id' });
      const row = db.prepare('SELECT id, project_id, final_prompt_content, created_at, module_versions_json, eval_pass, eval_score FROM snapshots WHERE id = ?').get(id);
      if (!row) return sendJson(404, { success: false, error: '快照不存在' });
      sendJson(200, {
        success: true,
        data: {
          id: row.id,
          project_id: row.project_id,
          final_prompt_content: row.final_prompt_content,
          created_at: row.created_at,
          eval_pass: row.eval_pass,
          eval_score: row.eval_score,
          layers: safeParseLayers(row.module_versions_json),
        },
      });
    }})
  }), 'snapshot: detail')

  // 仅组装、不落库：POST /api/prompt/assemble（供编辑器预览最终 Prompt）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/prompt/assemble', kind: 'exact',
    handler: createHandler({ needsPost: true, run: async (body, params, sendJson) => {
      const { project_id, layers, context_data } = body;
      if (!Array.isArray(layers)) return sendJson(400, { success: false, error: 'layers 必须是数组' });

      // 语境来源同快照组装：body.context_data（对象且非空）优先，否则安全读取 DB；默认 {}
      const useBodyContext = isUsableContextData(context_data);
      const context = useBodyContext
        ? normalizeContext(context_data)
        : (project_id && typeof project_id === 'string' ? readProjectContext(project_id) : normalizeContext(null));

      // 只做组装 + 全局变量替换，不写数据库、不生成快照
      sendJson(200, {
        success: true,
        final_prompt: applyContextReplace(assemblePrompt(layers), context),
        context_applied: contextToReplacements(context),
      });
    }})
  }), 'prompt: assemble')

  // 批量导出该项目全部历史快照为 Zip：GET /api/projects/export_zip?project_id=xxx
  ctx.effect(() => ctx.webServer.register({
    path: '/api/projects/export_zip', kind: 'exact',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
      const sendJson = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)) }
      if (req.method !== 'GET') return sendJson(405, { success: false, error: 'Method Not Allowed' })

      try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const projectId = urlObj.searchParams.get('project_id');
        if (!projectId) return sendJson(400, { success: false, error: '缺少 project_id' });

        const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
        if (!project) return sendJson(404, { success: false, error: '项目不存在' });

        const snapshots = db.prepare('SELECT id, created_at, eval_pass, eval_score, final_prompt_content FROM snapshots WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
        if (snapshots.length === 0) return sendJson(404, { success: false, error: '该项目暂无历史快照可导出' });

        const manifest = {
          project_id: project.id,
          project_name: project.name,
          exported_at: new Date().toISOString(),
          count: snapshots.length,
          snapshots: snapshots.map(s => ({
            id: s.id,
            created_at: s.created_at,
            eval_pass: s.eval_pass,
            eval_score: s.eval_score,
            file: `snapshots/${s.id}.txt`,
          })),
        };

        // 原生 res 流式输出 Zip：先写头，再 pipe archive（不能用 sendJson 二次写头）
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="project-${project.id}-snapshots.zip"`,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });

        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('error', (err) => {
          console.error('[project-snapshot] 导出 Zip 失败:', err.message);
          res.destroy(err);
        });
        archive.pipe(res);
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
        for (const s of snapshots) {
          archive.append(String(s.final_prompt_content ?? ''), { name: `snapshots/${s.id}.txt` });
        }
        await archive.finalize();
      } catch (e) {
        if (!res.headersSent) return sendJson(500, { success: false, error: e.message });
        res.destroy(e);
      }
    }
  }), 'projects: export_zip')

  // --- 公司相关 ---
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies', kind: 'exact', handler: createHandler({ needsPost: false, run: async (b,p,s) => s(200, { success: true, data: db.prepare('SELECT * FROM companies').all() }) }) }), 'api: companies')
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies/create', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { const id='comp-'+crypto.randomUUID().split('-')[0]; db.prepare('INSERT INTO companies (id, name, category) VALUES (?, ?, ?)').run(id, b.name, '默认'); s(200, { success: true, id, message: '创建成功' }) } }) }), 'api: companies:create')
  ctx.effect(() => ctx.webServer.register({ path: '/api/companies/update', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(b.name, b.id); s(200, { success: true, message: '修改成功' }) } }) }), 'api: companies:update')

  ctx.effect(() => ctx.webServer.register({ path: '/api/companies/delete', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { 
    db.prepare('DELETE FROM companies WHERE id = ?').run(b.id); 
    db.prepare('DELETE FROM projects WHERE company_id = ?').run(b.id);
    s(200, { success: true, message: '删除成功' }) 
  } }) }), 'api: companies:delete')

  // --- 项目相关 ---
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects', kind: 'exact', handler: createHandler({ needsPost: false, run: async (b,p,s) => s(200, { success: true, data: db.prepare('SELECT * FROM projects').all() }) }) }), 'api: projects')
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects/create', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { const id='proj-'+crypto.randomUUID().split('-')[0]; db.prepare('INSERT INTO projects (id, company_id, name, target_agent_id) VALUES (?, ?, ?, ?)').run(id, b.company_id, b.name, ''); s(200, { success: true, id, message: '创建成功' }) } }) }), 'api: projects:create')
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects/update', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(b.name, b.id); s(200, { success: true, message: '修改成功' }) } }) }), 'api: projects:update')
  ctx.effect(() => ctx.webServer.register({ path: '/api/projects/delete', kind: 'exact', handler: createHandler({ needsPost: true, run: async (b,p,s) => { db.prepare('DELETE FROM projects WHERE id = ?').run(b.id); s(200, { success: true, message: '删除成功' }) } }) }), 'api: projects:delete')
}
