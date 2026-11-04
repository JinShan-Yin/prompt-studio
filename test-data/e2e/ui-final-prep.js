// 极简风验收准备：清理孤儿项目 + 在有效公司下创建 50 字超长项目
const out = await page.evaluate(async () => {
  const projects = (await (await fetch('/api/projects')).json()).data || [];
  const companies = (await (await fetch('/api/companies')).json()).data || [];
  const validCompanyId = companies[0] && companies[0].id;
  const removed = [];
  for (const p of projects.filter((x) => String(x.name || '').startsWith('LEAD_UI_'))) {
    await fetch('/api/projects/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id }) });
    removed.push(p.id);
  }
  const LONG_NAME = 'LEAD_UI_长名' + '超长项目名称测试一二三四五六七八九十'.repeat(3).slice(0, 50);
  const created = await (await fetch('/api/projects/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: validCompanyId, name: LONG_NAME }) })).json();
  return { validCompanyId, removed, createdId: created.id, name: LONG_NAME };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));