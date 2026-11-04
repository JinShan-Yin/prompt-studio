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

        const metaHeader = `# SNAPSHOT: ${snap.id}\n# PROJECT_ID: ${snap.project_id}\n# EVAL_SCORE: ${snap.eval_score}\n# CREATED_AT: ${snap.created_at}\n\n`;
        
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${snap.id}.txt"`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(metaHeader + snap.final_prompt_content);
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    }
  }), 'release-gate: /api/gate/export')
}