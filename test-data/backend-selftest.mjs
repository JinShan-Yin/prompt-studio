// test-data/backend-selftest.mjs
//
// 模块二后端 · 无服务器单元自测
// 运行：node test-data/backend-selftest.mjs
//
// 设计原则：
// - 只 import context-engine 的纯函数，不启动 HTTP 服务、不打开 SQLite（context-engine 内部按需动态 import db）；
// - 覆盖：语境归一化 / 大模型返回结构校验兜底 / 完整长文本上的全局占位符替换（含 $& 等特殊字符与多行文本）。
import assert from 'node:assert/strict';
import {
  normalizeContext,
  contextToReplacements,
  applyContextReplace,
  parseExtractResult,
  apply,
} from '../plugins/context-engine/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

const EMPTY_CONTEXT = { industry: '', business_scene: [], core_goal: [] };
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

console.log('============================================================');
console.log(' Prompt Studio · 模块二后端 无服务器单元自测');
console.log(' 只 import 纯函数，不启动 HTTP、不打开 SQLite');
console.log('============================================================');
console.log('');

console.log('[1] normalizeContext 语境归一化');

test('null / undefined / 空串 / 坏 JSON / 数组 / 数字 一律收敛为默认语境', () => {
  assert.deepEqual(normalizeContext(null), EMPTY_CONTEXT);
  assert.deepEqual(normalizeContext(undefined), EMPTY_CONTEXT);
  assert.deepEqual(normalizeContext(''), EMPTY_CONTEXT);
  assert.deepEqual(normalizeContext('{坏 JSON'), EMPTY_CONTEXT);
  assert.deepEqual(normalizeContext([1, 2, 3]), EMPTY_CONTEXT);
  assert.deepEqual(normalizeContext(123), EMPTY_CONTEXT);
});

test('industry 非字符串 -> ""；字符串会 trim', () => {
  assert.equal(normalizeContext({ industry: 123 }).industry, '');
  assert.equal(normalizeContext({ industry: ['旅游行业'] }).industry, '');
  assert.equal(normalizeContext({ industry: { name: 'x' } }).industry, '');
  assert.equal(normalizeContext({ industry: '  旅游行业  ' }).industry, '旅游行业');
});

test('business_scene 为字符串 -> [字符串]', () => {
  assert.deepEqual(normalizeContext({ business_scene: '售后退换货' }).business_scene, ['售后退换货']);
  assert.deepEqual(normalizeContext({ business_scene: '  停车缴费  ' }).business_scene, ['停车缴费']);
});

test('非法数组项被过滤 / 空串被过滤 / 重复项去重', () => {
  const out = normalizeContext({ business_scene: ['售后退换货', 123, null, {}, '停车缴费', '   ', '售后退换货'] });
  assert.deepEqual(out.business_scene, ['售后退换货', '停车缴费']);
});

test('core_goal 同样按规则归一化', () => {
  const out = normalizeContext({ core_goal: ['安抚客户情绪', 456, true, '引导转接人工'] });
  assert.deepEqual(out.core_goal, ['安抚客户情绪', '引导转接人工']);
});

test('从数据库读出的 JSON 字符串（projects.context_json）可安全解析', () => {
  const dbJson = JSON.stringify({ industry: '星汇Mall', business_scene: ['停车缴费'], core_goal: ['准确提供价格'] });
  assert.deepEqual(normalizeContext(dbJson), {
    industry: '星汇Mall',
    business_scene: ['停车缴费'],
    core_goal: ['准确提供价格'],
  });
});

test('只保留 industry / business_scene / core_goal 三个字段', () => {
  const out = normalizeContext({ industry: 'x', business_scene: ['y'], core_goal: ['z'], foo: 'bar', extra: 1 });
  assert.deepEqual(Object.keys(out).sort(), ['business_scene', 'core_goal', 'industry']);
});

console.log('');
console.log('[2] parseExtractResult 大模型返回结构校验兜底');

test('Markdown 代码围栏中的 JSON 可提取', () => {
  const raw = '```json\n{"industry":"旅游行业","business_scene":["售后退换货","停车缴费"],"core_goal":["安抚客户情绪"]}\n```';
  assert.deepEqual(parseExtractResult(raw), {
    industry: '旅游行业',
    business_scene: ['售后退换货', '停车缴费'],
    core_goal: ['安抚客户情绪'],
  });
});

test('JSON 前后夹带解释文字也能提取', () => {
  const raw = '好的，分析结果如下：\n{"industry":"星汇Mall","business_scene":["活动咨询"],"core_goal":["引导转接人工"]}\n希望有帮助。';
  assert.deepEqual(parseExtractResult(raw), {
    industry: '星汇Mall',
    business_scene: ['活动咨询'],
    core_goal: ['引导转接人工'],
  });
});

test('纯 JSON 字符串可解析', () => {
  const out = parseExtractResult('{"industry":"电商客服","business_scene":["售后退换货"],"core_goal":["准确提供价格"]}');
  assert.equal(out.industry, '电商客服');
});

test('business_scene / core_goal 为字符串时强制转数组', () => {
  const out = parseExtractResult('{"industry":"电商客服","business_scene":"活动咨询","core_goal":"准确提供价格"}');
  assert.deepEqual(out.business_scene, ['活动咨询']);
  assert.deepEqual(out.core_goal, ['准确提供价格']);
});

test('industry 非字符串 -> ""；数组中的非法项被过滤', () => {
  const out = parseExtractResult('{"industry":123,"business_scene":["场景A",9,null,{}, "场景B"],"core_goal":[]}');
  assert.equal(out.industry, '');
  assert.deepEqual(out.business_scene, ['场景A', '场景B']);
  assert.deepEqual(out.core_goal, []);
});

test('字段全部缺失时返回安全默认结构（不抛错）', () => {
  assert.deepEqual(parseExtractResult('{}'), EMPTY_CONTEXT);
});

test('完全无法解析为 JSON 对象时抛错（接口层转 500）', () => {
  assert.throws(() => parseExtractResult('抱歉，我无法完成这个任务。'), /无法解析为 JSON/);
  assert.throws(() => parseExtractResult('{"industry":'), /无法解析为 JSON/);
  assert.throws(() => parseExtractResult('[1,2,3]'), /无法解析为 JSON/);
});

console.log('');
console.log('[3] applyContextReplace 完整长文本全局占位符替换');

const CONTEXT = {
  industry: '旅游行业',
  business_scene: ['售后退换货', '停车缴费'],
  core_goal: ['安抚客户情绪', '准确提供价格'],
};
const L0_TEXT = `你是一个面向 {{industry}} 领域的智能语音助手。
当前业务场景为 {{business_scene}}。
你的核心目标是：{{core_goal}}。
严禁使用 Markdown。`;
const L3_TEXT = `### 项目层补充
再次强调：面向 {{industry}}，聚焦 {{business_scene}}，目标 {{core_goal}}。`;
const FULL_TEXT = `${L0_TEXT}\n\n### 项目层 (L3)\n${L3_TEXT}`;

test('占位符同时出现在 L0 与 L3 文本时全部被替换（完整长文本上替换）', () => {
  const out = applyContextReplace(FULL_TEXT, CONTEXT);
  assert.equal(out.includes('{{'), false, '替换后不应残留任何占位符');
  assert.equal(countOccurrences(out, '旅游行业'), 2, 'industry 在 L0/L3 各出现一次应都被替换');
  assert.equal(countOccurrences(out, '售后退换货、停车缴费'), 2, 'business_scene 应 join("、") 后两处都替换');
  assert.equal(countOccurrences(out, '安抚客户情绪、准确提供价格'), 2, 'core_goal 应 join("、") 后两处都替换');
  assert.equal(out.includes('### 项目层 (L3)'), true, '非占位符文本不应被破坏');
});

test('同一个占位符出现多次时全部替换（g 标志生效）', () => {
  const text = 'A={{industry}} B={{industry}} C={{industry}}';
  assert.equal(applyContextReplace(text, CONTEXT), 'A=旅游行业 B=旅游行业 C=旅游行业');
});

test('空数组 / 缺失字段 / 空 industry 统一兜底为「通用」', () => {
  const out = applyContextReplace('行业={{industry}} 场景={{business_scene}} 目标={{core_goal}}', {});
  assert.equal(out, '行业=通用 场景=通用 目标=通用');
  const out2 = applyContextReplace('行业={{industry}} 场景={{business_scene}}', {
    industry: '   ',
    business_scene: [],
    core_goal: [],
  });
  assert.equal(out2, '行业=通用 场景=通用');
});

test('替换值含 $& / $\' / $` / $1 等特殊字符时按字面量输出（不炸）', () => {
  const trickyIndustry = "A$&B$'C$`D$1";
  assert.equal(applyContextReplace('行业={{industry}}', { industry: trickyIndustry }), `行业=${trickyIndustry}`);

  const trickyScene = "退$&换$'货$`";
  assert.equal(
    applyContextReplace('场景={{business_scene}}', { business_scene: [trickyScene] }),
    `场景=${trickyScene}`,
  );
});

test('花括号内带空白 / 跨行的占位符也能命中', () => {
  const text = 'A={{  industry  }}\nB={{\n business_scene \n}}\nC={{ core_goal }}';
  assert.equal(
    applyContextReplace(text, CONTEXT),
    'A=旅游行业\nB=售后退换货、停车缴费\nC=安抚客户情绪、准确提供价格',
  );
});

test('多行文本 + 其它变量 / 相似变量不受影响', () => {
  const text = '第一行 {{industry}}\n第二行 {{user_name}}\n第三行 {{industryX}}\n第四行 {{ company_name }}\n第五行 {{business_scene}}';
  assert.equal(
    applyContextReplace(text, CONTEXT),
    '第一行 旅游行业\n第二行 {{user_name}}\n第三行 {{industryX}}\n第四行 {{ company_name }}\n第五行 售后退换货、停车缴费',
  );
});

test('模板里带反引号的占位符（需求文档写法）可替换', () => {
  const text = '你是一个面向 `{{industry}}` 领域的智能语音助手。当前业务场景为 `{{business_scene}}`。';
  assert.equal(
    applyContextReplace(text, CONTEXT),
    '你是一个面向 `旅游行业` 领域的智能语音助手。当前业务场景为 `售后退换货、停车缴费`。',
  );
});

test('text 非字符串（null / undefined）时不抛错', () => {
  assert.equal(applyContextReplace(null, CONTEXT), '');
  assert.equal(applyContextReplace(undefined, CONTEXT), '');
});

console.log('');
console.log('[4] contextToReplacements 替换字面量');

test('空语境 -> industry / business_scene / core_goal 均为「通用」', () => {
  assert.deepEqual(contextToReplacements(null), { industry: '通用', business_scene: '通用', core_goal: '通用' });
});

test('数组用中文顿号 join；单个字符串标签也可用', () => {
  assert.deepEqual(contextToReplacements({ industry: '星汇Mall', business_scene: '停车缴费', core_goal: ['引导转接人工'] }), {
    industry: '星汇Mall',
    business_scene: '停车缴费',
    core_goal: '引导转接人工',
  });
});

console.log('');
console.log('[5] context-engine 路由注册（mock ctx，无 HTTP server / 无 DB）');

test('apply(ctx) 注册 3 个契约路由且 kind 为 exact', () => {
  const routes = [];
  const fakeCtx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  };
  apply(fakeCtx);
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    ['/api/context/extract', '/api/context/get', '/api/context/save'],
  );
  assert.deepEqual(routes.map((r) => r.kind), ['exact', 'exact', 'exact']);
  assert.equal(routes.every((r) => typeof r.handler === 'function'), true);
});

console.log('');
console.log('------------------------------------------------------------');
const total = passed + failed;
if (failed === 0) {
  console.log(`\u2705 backend-selftest 全部通过：${passed}/${total} 项用例`);
  process.exitCode = 0;
} else {
  console.log(`\u274c backend-selftest 失败：${failed}/${total} 项用例未通过`);
  for (const f of failures) {
    console.log(`   - ${f.name}`);
    console.log(`     ${String(f.error && f.error.message).split('\n')[0]}`);
  }
  process.exitCode = 1;
}
