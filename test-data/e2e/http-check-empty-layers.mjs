// test-data/e2e/http-check-empty-layers.mjs — P2-4 修复验证：空内容 layers 应回落默认客服角色
const BASE = process.argv[2] || 'http://127.0.0.1:3081';
const TOKEN = process.argv[3] || '';
const q = (p) => BASE + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
const post = async (path, payload) => {
  const res = await fetch(q(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
};
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name + ' :: ' + JSON.stringify(detail).slice(0, 500)); } };

const DEFAULT_ROLE = '你是一个专业、礼貌、高效的智能语音客服助手。';
const emptyLayers = [
  { layer: 'L0', name: '公共基座', content: '' },
  { layer: 'L1', name: '语音基座', content: '   ' },
  { layer: 'L3', name: '项目层', content: '' }
];
let r = await post('/api/chat/reply', { project_id: 'proj-597e1045', layers: emptyLayers, messages: [{ role: 'user', content: '你好，你是谁？' }] });
const sp = (r.body && r.body.system_prompt) || '';
check('空内容 layers：请求成功且返回 system_prompt/reply', r.status === 200 && r.body?.success === true && typeof r.body.reply === 'string' && r.body.reply.length > 0, { status: r.status, body: r.body });
check('空内容 layers：system_prompt 以默认客服角色句开头', sp.startsWith(DEFAULT_ROLE), sp.slice(0, 120));
check('空内容 layers：无「### 名称 (L0)」空壳模板', !sp.includes('###'), sp.slice(0, 200));
check('空内容 layers：含【输出约束】与 <speak> 要求', sp.includes('【输出约束】') && sp.includes('<speak>'), sp.slice(-200));

r = await post('/api/chat/reply', { layers: [], messages: [{ role: 'user', content: '你好' }] });
check('layers=[] 同样回落默认客服角色', r.status === 200 && r.body?.system_prompt.startsWith(DEFAULT_ROLE) && !r.body.system_prompt.includes('###'), (r.body && r.body.system_prompt || '').slice(0, 150));

r = await post('/api/chat/reply', {
  project_id: 'proj-597e1045',
  layers: [
    { layer: 'L0', name: '公共基座', content: '你是面向{{industry}}领域的语音客服。' },
    { layer: 'L3', name: '项目层', content: '目标：{{core_goal}}。' }
  ],
  context_data: { industry: '旅游行业', business_scene: ['售后退换货'], core_goal: ['安抚客户情绪'] },
  messages: [{ role: 'user', content: '你好' }]
});
check('有内容 layers：仍保留模板并完成变量替换', r.status === 200 && r.body?.success === true && r.body.system_prompt.includes('### 公共基座 (L0)') && r.body.system_prompt.includes('旅游行业') && r.body.system_prompt.includes('安抚客户情绪') && !/\{\{/.test(r.body.system_prompt), (r.body && r.body.system_prompt || '').slice(0, 300));

console.log(`\nPASS ${pass} / FAIL ${fail}`);
if (fail) process.exitCode = 1; else console.log('✅ 空 layers 回落验证全部通过');
