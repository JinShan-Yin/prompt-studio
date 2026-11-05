// V5 阶段一：数据修复（恢复被前置测试破坏的途牛项目；清理 QA 克隆/批量导入造成的孤儿 KB 与测试账号/团队/模型）
const Database = require('better-sqlite3');
const fs = require('fs');
(async () => {
  const src = new Database('data/prompt-studio.db', { readonly: true });
  const backupPath = 'data/backup-before-v5-repair-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db';
  await src.backup(backupPath);
  src.close();
  const db = new Database('data/prompt-studio.db');
  db.pragma('journal_mode = WAL');
  const report = { backupPath, restored: {}, deleted: {} };
  const tx = db.transaction(() => {
    // 1) 恢复「途牛热线」项目（历史行被误删，但其快照/数据仍在）
    const tniu = db.prepare("SELECT id FROM projects WHERE id = 'proj-7ec6f484'").get();
    if (!tniu) {
      db.prepare("INSERT INTO projects (id, company_id, name, target_agent_id, context_json, user_id, is_public, public_scope) VALUES (?, ?, ?, ?, ?, ?, 0, 'private')")
        .run('proj-7ec6f484', 'comp-f555acd9', '途牛热线', '', '{}', 'user-admin');
      report.restored.tuniu = true;
    }
    // 2) 删除测试克隆/QA 项目（Trip 副本、团队测试项目）
    const testProjects = ['proj-47f785f8', 'proj-12b264a4'];
    report.deleted.projects = testProjects.map((id) => {
      const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return { id, changes: info.changes };
    });
    // 3) 清理孤儿 KB：仅保留真实项目 + 历史演示项目 xinghui-mall-agent 的知识
    const keep = ['proj-4562700e', 'proj-597e1045', 'proj-7ec6f484', 'xinghui-mall-agent'];
    const placeholders = keep.map(() => '?').join(',');
    const orphanIds = db.prepare(`SELECT DISTINCT project_id FROM kb_items WHERE project_id NOT IN (${placeholders})`).all(...keep).map((r) => r.project_id);
    const delKb = db.prepare(`DELETE FROM kb_items WHERE project_id NOT IN (${placeholders})`).run(...keep);
    report.deleted.orphanProjectsForKb = orphanIds;
    report.deleted.kbItems = delKb.changes;
    // 4) 清理无主 KB 版本
    const delVer = db.prepare('DELETE FROM kb_item_versions WHERE item_id NOT IN (SELECT id FROM kb_items)').run();
    report.deleted.kbVersions = delVer.changes;
    // 5) 清理 QA 测试客户/团队/账号/模型
    report.deleted.company = db.prepare('DELETE FROM companies WHERE id = ?').run('comp-d153a149').changes;
    report.deleted.team = db.prepare('DELETE FROM teams WHERE id = ?').run('team-c6c86468').changes;
    const testUsers = ['user-218ef329', 'user-8e99557d', 'user-86c96f8a'];
    report.deleted.users = db.prepare(`DELETE FROM users WHERE id IN (${testUsers.map(() => '?').join(',')})`).run(...testUsers).changes;
    report.deleted.badModel = db.prepare('DELETE FROM model_configs WHERE id = ?').run('model-1610d09a').changes;
    // 6) 清理 QA 测试审计日志（只删测试用户的记录，保留 admin 登录等真实审计）
    report.deleted.testAuditLogs = db.prepare(`DELETE FROM audit_logs WHERE user_id IN (${testUsers.map(() => '?').join(',')})`).run(...testUsers).changes;
    // 校准旧项目 user_id
    db.prepare("UPDATE projects SET user_id = 'user-admin' WHERE id IN ('proj-4562700e','proj-597e1045','proj-7ec6f484')").run();
    db.prepare("UPDATE companies SET user_id = 'user-admin' WHERE id IN ('comp-f555acd9','comp-25a9de7d')").run();
  });
  tx();
  report.final = {
    projects: db.prepare('select id,name from projects order by rowid').all(),
    companies: db.prepare('select id,name from companies order by rowid').all(),
    kbByProject: db.prepare('select project_id, count(*) c from kb_items group by project_id order by c desc').all(),
    users: db.prepare('select id,username,role from users').all(),
    teams: db.prepare('select * from teams').all(),
    integrity: db.pragma('integrity_check', { simple: true }),
  };
  db.close();
  fs.writeFileSync('test-data/e2e/v5-data-repair-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('REPAIR_FAILED', e); process.exit(1); });
