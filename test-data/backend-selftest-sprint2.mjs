// test-data/backend-selftest-sprint2.mjs
//
// Sprint 2 · 模块四后端：多轮对话模拟器 LLM 代理（POST /api/chat/reply）无服务器单元自测
// 运行：node test-data/backend-selftest-sprint2.mjs
//
// 说明：
// - 不启动任何 HTTP 服务、不发起真实 LLM 调用（参数错误分支在调用 LLM 之前就返回）。
// - eval-runner 按任务要求静态复用 project-snapshot / context-engine / db 模块，
//   因此 import 时会把 SQLite 连接初始化一次（db.js 迁移幂等、本测试不写任何数据），不会影响运行中的服务。
import assert from 'node:assert/strict';
import {
  buildChatSystemPrompt,
  sanitizeChatMessages,
  apply,
  DEFAULT_CHAT_ROLE,
  CHAT_OUTPUT_CONSTRAINTS,
  CHAT_HISTORY_LIMIT,
  CHAT_CONTENT_MAX,
} from '../plugins/eval-runner/index.js';

let passed = 0;
let failed = 0;
const failures = [];
const sections = [];
let currentSection = null;

function startSection(title) {
  currentSection = { title, cases: [] };
  sections.push(currentSection);
}
function test(name, fn) {
  currentSection.cases.push({ name, fn });
}

const CONTEXT = {
  industry: '旅游行业',
  business_scene: ['售后退换货', '停车缴费'],
  core_goal: ['安抚客户情绪', '准确提供价格'],
};
const LAYERS = [
  { layer: 'L0', name: '公共基座', content: '你是一个面向 {{industry}} 领域的智能语音助手。\n当前业务场景为 {{business_scene}}。\n你的核心目标是：{{core_goal}}。' },
  { layer: 'L3', name: '项目层', content: '再次强调：面向 {{industry}}，聚焦 {{business_scene}}，目标 {{core_goal}}。' },
];

console.log('============================================================');
console.log(' Prompt Studio · Sprint2 模块四后端 无服务器单元自测');
console.log(' 多轮对话模拟器 LLM 代理：buildChatSystemPrompt / sanitizeChatMessages');
console.log('============================================================');
console.log('');

// ---------------------------------------------------------------
startSection('[1] buildChatSystemPrompt 系统提示词组装');
// ---------------------------------------------------------------

test('用 context_data 全局替换 {{industry}} / {{business_scene}} / {{core_goal}}（L0 与 L3 都替换）', () => {
  const out = buildChatSystemPrompt(LAYERS, CONTEXT);
  assert.equal(out.includes('{{'), false, '替换后不应残留占位符');
  assert.equal((out.match(/旅游行业/g) || []).length, 2, 'industry 在 L0/L3 各一次均替换');
  assert.equal((out.match(/售后退换货、停车缴费/g) || []).length, 2, 'business_scene join("、") 后两处均替换');
  assert.equal((out.match(/安抚客户情绪、准确提供价格/g) || []).length, 2, 'core_goal join("、") 后两处均替换');
  assert.equal(out.includes('再次强调'), true, '原有模板文本不能被破坏');
});

test('空 layers 时包含默认客服角色句', () => {
  const out = buildChatSystemPrompt([], {});
  assert.equal(out.includes(DEFAULT_CHAT_ROLE), true);
  assert.equal(out, DEFAULT_CHAT_ROLE + CHAT_OUTPUT_CONSTRAINTS);
});

test('layers 非数组 / null / undefined 时回落默认客服角色句（不抛错）', () => {
  for (const layers of [undefined, null, 'not-array', 123, {}]) {
    const out = buildChatSystemPrompt(layers, null);
    assert.equal(out.includes(DEFAULT_CHAT_ROLE), true, `layers=${String(layers)} 应回落默认角色`);
  }
});

test('始终以【输出约束】结尾且包含 <speak> 包裹要求', () => {
  const cases = [
    buildChatSystemPrompt([], {}),
    buildChatSystemPrompt(LAYERS, CONTEXT),
    buildChatSystemPrompt(LAYERS, null),
    buildChatSystemPrompt(undefined, undefined),
  ];
  for (const out of cases) {
    assert.equal(out.endsWith(CHAT_OUTPUT_CONSTRAINTS), true, '输出约束必须始终在结尾');
    assert.equal(out.includes('【输出约束】'), true);
    assert.equal(out.includes('<speak>...</speak>'), true);
    assert.equal(out.includes('禁止使用 Markdown'), true);
  }
});

test('有 layers 时保留模板内容（不插入默认角色句）', () => {
  const out = buildChatSystemPrompt(LAYERS, CONTEXT);
  assert.equal(out.includes(DEFAULT_CHAT_ROLE), false);
  assert.equal(out.includes('公共基座'), true);
  assert.equal(out.includes('项目层'), true);
});

// ---- P2-4 规格边界回归：layers 全为空内容时必须回落默认客服角色，不得残留「### 名称 (L0)」空壳 ----

test('P2-4：layers 全为空内容（前端恒发 3 层、编辑器为空）-> 回落默认客服角色句，不残留空壳', () => {
  const emptyLayers = [
    { layer: 'L0', name: '公共基座', content: '' },
    { layer: 'L1', name: '语音基座', content: '' },
    { layer: 'L3', name: '项目层', content: '' },
  ];
  for (const out of [buildChatSystemPrompt(emptyLayers, CONTEXT), buildChatSystemPrompt([], CONTEXT)]) {
    assert.equal(out.startsWith(DEFAULT_CHAT_ROLE), true, 'system_prompt 应以默认客服角色句开头');
    assert.equal(out, DEFAULT_CHAT_ROLE + CHAT_OUTPUT_CONSTRAINTS);
    assert.equal(out.includes('###'), false, '不应残留 assemblePrompt 的「### 名称 (L0)」空壳');
    assert.equal(out.includes('【输出约束】'), true);
    assert.equal(out.includes('<speak>...</speak>'), true);
  }
});

test('P2-4：仅空白 content / content 缺失的层 -> 回落默认客服角色句', () => {
  const cases = [
    [{ layer: 'L0', name: 'x', content: '   ' }],
    [
      { layer: 'L0', name: '公共基座', content: ' \n\t ' },
      { layer: 'L1', name: '语音基座', content: '\n' },
    ],
    [{ layer: 'L0', name: '公共基座' }, { layer: 'L3', name: '项目层', content: null }],
  ];
  for (const layers of cases) {
    const out = buildChatSystemPrompt(layers, CONTEXT);
    assert.equal(out, DEFAULT_CHAT_ROLE + CHAT_OUTPUT_CONSTRAINTS);
    assert.equal(out.includes('###'), false);
  }
});

test('P2-4：只要有一层有内容 -> 行为不变（走模板组装、不插默认角色句、替换与约束保持）', () => {
  const mixedLayers = [
    { layer: 'L0', name: '公共基座', content: '   ' },
    { layer: 'L3', name: '项目层', content: '行业={{industry}}，场景={{business_scene}}' },
  ];
  const out = buildChatSystemPrompt(mixedLayers, CONTEXT);
  assert.equal(out.includes(DEFAULT_CHAT_ROLE), false, '有内容时不应插入默认角色句');
  assert.equal(out.includes('行业=旅游行业，场景=售后退换货、停车缴费'), true);
  assert.equal(out.includes('{{'), false);
  assert.equal(out.includes('项目层'), true);
  assert.equal(out.endsWith(CHAT_OUTPUT_CONSTRAINTS), true);
});

test('context_data 缺失 / 空数组时变量兜底为「通用」', () => {
  const out = buildChatSystemPrompt([{ layer: 'L0', name: '基座', content: '行业={{industry}} 场景={{business_scene}} 目标={{core_goal}}' }], {});
  assert.equal(out.includes('行业=通用 场景=通用 目标=通用'), true);
});

test('context_data 脏数据也能安全组装（industry 非字符串 -> 通用，字符串标签 -> 数组）', () => {
  const out = buildChatSystemPrompt(
    [{ layer: 'L0', name: '基座', content: '行业={{industry}} 场景={{business_scene}}' }],
    { industry: 123, business_scene: '停车缴费' },
  );
  assert.equal(out.includes('行业=通用 场景=停车缴费'), true);
});

// ---------------------------------------------------------------
startSection('[2] sanitizeChatMessages 历史消息清洗');
// ---------------------------------------------------------------

test('非数组 / 空数组 -> []', () => {
  for (const input of [null, undefined, '', 'abc', 123, {}, [], true]) {
    assert.deepEqual(sanitizeChatMessages(input), []);
  }
});

test('只保留 role 为 user / assistant 的记录', () => {
  const out = sanitizeChatMessages([
    { role: 'system', content: '系统' },
    { role: 'user', content: '你好' },
    { role: 'tool', content: '工具' },
    { role: 'assistant', content: '您好' },
    { role: 'USER', content: '大写' },
    { role: null, content: '空角色' },
    { role: 1, content: '数字角色' },
    null,
    'bad-item',
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '您好' },
  ]);
});

test('非字符串 content 统一转字符串，null/undefined -> 空串', () => {
  const out = sanitizeChatMessages([
    { role: 'user', content: 123 },
    { role: 'assistant', content: null },
    { role: 'assistant', content: undefined },
    { role: 'assistant', content: true },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: '123' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'true' },
  ]);
});

test('每条 content 截断到 4000 字符（边界不误伤）', () => {
  assert.equal(CHAT_CONTENT_MAX, 4000);
  const out = sanitizeChatMessages([
    { role: 'user', content: 'x'.repeat(5000) },
    { role: 'assistant', content: 'y'.repeat(4000) },
    { role: 'assistant', content: 'z'.repeat(4001) },
  ]);
  assert.equal(out[0].content.length, 4000);
  assert.equal(out[0].content, 'x'.repeat(4000));
  assert.equal(out[1].content.length, 4000);
  assert.equal(out[2].content.length, 4000);
});

test('只保留最近 12 条（按清洗后的顺序）', () => {
  assert.equal(CHAT_HISTORY_LIMIT, 12);
  const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
  const out = sanitizeChatMessages(many);
  assert.equal(out.length, 12);
  assert.equal(out[0].content, 'm8');
  assert.equal(out[11].content, 'm19');
});

test('先过滤非法 role，再取最近 12 条', () => {
  const mixed = [];
  for (let i = 0; i < 20; i += 1) {
    mixed.push({ role: i % 3 === 0 ? 'system' : 'user', content: `k${i}` });
  }
  const out = sanitizeChatMessages(mixed);
  assert.equal(out.length, 12);
  // 过滤掉 role=system（i=0,3,6,9,12,15,18）后剩 13 条，取最近 12 条 -> 丢 k1
  assert.equal(out[0].content, 'k2');
  assert.equal(out[out.length - 1].content, 'k19');
  assert.equal(out.every((m) => m.role === 'user'), true);
});

test('丢弃 role/content 之外的字段（不把脏字段传给大模型）', () => {
  const out = sanitizeChatMessages([{ role: 'user', content: 'hi', extra: 1, name: 'x' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['content', 'role']);
});

// ---------------------------------------------------------------
startSection('[3] 路由注册（mock ctx；无 HTTP server）');
// ---------------------------------------------------------------

const routes = [];
const fakeCtx = { effect: (fn) => fn(), webServer: { register: (r) => { routes.push(r); return () => {}; } } };
apply(fakeCtx);
const chatRoute = routes.find((r) => r.path === '/api/chat/reply');

test('apply(ctx) 注册新的 /api/chat/reply（kind=exact，handler 为函数）', () => {
  assert.notEqual(chatRoute, undefined);
  assert.equal(chatRoute.kind, 'exact');
  assert.equal(typeof chatRoute.handler, 'function');
});

test('既有 /api/eval/run 仍然注册（回归保护，未改动）', () => {
  const evalRoute = routes.find((r) => r.path === '/api/eval/run');
  assert.notEqual(evalRoute, undefined);
  assert.equal(evalRoute.kind, 'exact');
  assert.equal(typeof evalRoute.handler, 'function');
});

// ---------------------------------------------------------------
startSection('[4] /api/chat/reply 参数校验分支（不触达 LLM / 不查 DB）');
// ---------------------------------------------------------------

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: { host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { this.body = chunk ?? ''; },
  };
}
async function callChatRoute(req) {
  const res = makeRes();
  await chatRoute.handler(req, res);
  return { status: res.statusCode, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
}

test('OPTIONS 预检 -> 204 + CORS 头', async () => {
  const r = await callChatRoute(makeReq('OPTIONS', '/api/chat/reply'));
  assert.equal(r.status, 204);
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(r.headers['Access-Control-Allow-Methods'].includes('POST'), true);
});

test('非 POST（GET）-> 405 {success:false}', async () => {
  const r = await callChatRoute(makeReq('GET', '/api/chat/reply'));
  assert.equal(r.status, 405);
  assert.equal(r.data.success, false);
});

test('messages 缺失 / 空数组 -> 400 {success:false}', async () => {
  let r = await callChatRoute(makeReq('POST', '/api/chat/reply', {}));
  assert.equal(r.status, 400);
  assert.equal(r.data.success, false);
  r = await callChatRoute(makeReq('POST', '/api/chat/reply', { messages: [] }));
  assert.equal(r.status, 400);
  assert.equal(r.data.success, false);
  assert.match(r.data.error, /messages/);
});

test('messages 清洗后无 user 消息 -> 400 {success:false}', async () => {
  let r = await callChatRoute(makeReq('POST', '/api/chat/reply', { messages: [{ role: 'assistant', content: '你好' }] }));
  assert.equal(r.status, 400);
  assert.equal(r.data.success, false);
  assert.match(r.data.error, /user/);
  r = await callChatRoute(makeReq('POST', '/api/chat/reply', { messages: [{ role: 'system', content: 'x' }, { role: 'tool', content: 'y' }] }));
  assert.equal(r.status, 400);
  assert.equal(r.data.success, false);
});

// ---------------------------------------------------------------
startSection('[5] /api/chat/reply 正常链路（stub globalThis.fetch，离线验证 handler 组装与 LLM 调用参数）');
// ---------------------------------------------------------------

// 临时替换全局 fetch（gateway.js 用 fetch 调 DeepSeek），并保证测试后恢复；无真实网络请求
function stubChatFetch(replyText) {
  const originalFetch = globalThis.fetch;
  const captured = {};
  globalThis.fetch = async (url, options) => {
    captured.url = String(url);
    captured.body = options && options.body ? JSON.parse(options.body) : null;
    captured.authorization = options && options.headers ? options.headers.Authorization : undefined;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: replyText } }] }),
      text: async () => '',
    };
  };
  return { captured, restore: () => { globalThis.fetch = originalFetch; } };
}

// 保证测试不依赖 .env 里是否配置了真实 key（只验证链路，不发真实请求）
function withTempApiKey(fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'DEEPSEEK_API_KEY');
  const oldKey = process.env.DEEPSEEK_API_KEY;
  if (!oldKey) process.env.DEEPSEEK_API_KEY = 'sk-test-dummy-key';
  const restoreKey = () => {
    if (hadKey) process.env.DEEPSEEK_API_KEY = oldKey;
    else delete process.env.DEEPSEEK_API_KEY;
  };
  return Promise.resolve().then(fn).finally(restoreKey);
}

test('正常请求 -> 200 {success:true, reply, system_prompt}；system 消息在首位且来自组装结果', async () => {
  const stub = stubChatFetch('  \n<speak>您好，很高兴为您服务。</speak>\n  ');
  try {
    await withTempApiKey(async () => {
      const r = await callChatRoute(makeReq('POST', '/api/chat/reply', {
        layers: LAYERS,
        context_data: CONTEXT,
        messages: [
          { role: 'system', content: '前端非法注入的 system 消息应被清洗掉' },
          { role: 'user', content: '我的快递到哪了？' },
          { role: 'assistant', content: '您好，我帮您查一下。' },
          { role: 'user', content: '好的，谢谢。' },
        ],
        project_id: 'proj-should-not-be-used',
      }));

      assert.equal(r.status, 200);
      assert.equal(r.data.success, true);
      assert.equal(r.data.reply, '<speak>您好，很高兴为您服务。</speak>', 'reply 应 trim 前后空白');
      assert.equal(r.data.system_prompt.endsWith(CHAT_OUTPUT_CONSTRAINTS), true);
      assert.equal(r.data.system_prompt.includes('旅游行业'), true);
      assert.equal(r.data.system_prompt.includes('{{'), false);

      assert.equal(stub.captured.url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(stub.captured.body.model, 'deepseek-chat');
      assert.equal(stub.captured.body.temperature, 0.7);
      assert.equal(stub.captured.body.messages.length, 4, 'system + 3 条合法消息（前端注入的 system 被过滤）');
      assert.deepEqual(stub.captured.body.messages[0], { role: 'system', content: r.data.system_prompt });
      assert.deepEqual(stub.captured.body.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
      assert.equal(String(stub.captured.authorization).startsWith('Bearer '), true);
    });
  } finally {
    stub.restore();
  }
});

test('LLM 调用抛错 -> 500 {success:false, error}', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('mock network down'); };
  try {
    await withTempApiKey(async () => {
      const r = await callChatRoute(makeReq('POST', '/api/chat/reply', {
        project_id: 'proj-597e1045',
        context_data: CONTEXT,
        messages: [{ role: 'user', content: '你好' }],
      }));
      assert.equal(r.status, 500);
      assert.equal(r.data.success, false);
      assert.match(r.data.error, /network down/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------
// 执行 + 汇总
// ---------------------------------------------------------------
for (const section of sections) {
  console.log(section.title);
  for (const item of section.cases) {
    try {
      await item.fn();
      passed += 1;
      console.log(`  \u2713 ${item.name}`);
    } catch (e) {
      failed += 1;
      failures.push({ name: item.name, error: e });
      console.log(`  \u2717 ${item.name}`);
      console.log(`    ${e.message}`);
    }
  }
  console.log('');
}

const total = passed + failed;
console.log('------------------------------------------------------------');
if (failed === 0) {
  console.log(`\u2705 sprint2 backend-selftest 全部通过：${passed}/${total} 项用例`);
  process.exitCode = 0;
} else {
  console.log(`\u274c sprint2 backend-selftest 失败：${failed}/${total} 项用例未通过`);
  for (const f of failures) {
    console.log(`   - ${f.name}`);
    console.log(`     ${String(f.error && f.error.message).split('\n')[0]}`);
  }
  process.exitCode = 1;
}
