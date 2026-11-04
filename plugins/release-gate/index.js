// plugins/release-gate/index.js
import { db } from '../db.js';

export const name = 'release-gate'
export const inject = ['webServer']

export function apply(ctx) {
  console.log('[release-gate] 发布门禁引擎已加载');

  // 导出接口（增加实测结果拦截）
  ctx.effect(() => ctx.webServer.register({
    path: '/api/gate/export', kind: 'exact',
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
      
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const snapshotId = urlObj.searchParams.get('snapshot_id');
      
      try {
        const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
        if (!snap) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Snapshot Not Found');
        }

        // 核心门禁：检查数据库中的评测结果
        if (snap.eval_pass !== 1) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(`【发布门禁拦截】\n该快照未通过评测（得分：${snap.eval_score}），禁止导出！\n请在生成快照时提供符合标准的模拟对话。`);
        }

        // CQO 生产级元数据：项目名称必须在导出时实时从 DB 读取（重命名后旧快照同步生效），
        // 并做换行/CR 注入清洗，避免污染 TXT 头部结构。
        const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(snap.project_id);
        const projectName = String((project && project.name) || '(未命名项目)').replace(/[\r\n]+/g, ' ').trim() || '(未命名项目)';
        const promptBody = String(snap.final_prompt_content || '').replace(/^\n+/, '');
        const metaHeader = `# SNAPSHOT: ${snap.id}\n# PROJECT_ID: ${snap.project_id}\n# PROJECT_NAME: ${projectName}\n# EVAL_SCORE: ${snap.eval_score}\n# CREATED_AT: ${snap.created_at}\n\n`;

        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${snap.id}.txt"`,
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(metaHeader + promptBody);
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    }
  }), 'release-gate: /api/gate/export')
}