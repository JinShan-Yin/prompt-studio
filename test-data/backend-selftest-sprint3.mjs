// test-data/backend-selftest-sprint3.mjs
//
// Sprint 3 后端 · 无服务器单元自测
// 覆盖：API Key 脱敏 / 校验 / .env 行 upsert（模块五）+ 最终 Prompt 组装变量替换（模块二/六复用）
// 运行：node test-data/backend-selftest-sprint3.mjs
//
// 安全说明：本测试只使用**假 Key**（不读取、不打印真实 .env / 环境变量），不启动 HTTP 服务、不写任何真实文件。
import assert from 'node:assert/strict';
import {
  maskApiKey,
  validateApiKey,
  upsertEnvLine,
  apply,
  KEY_NAME,
  API_KEY_MIN_LENGTH,
} from '../plugins/settings-engine/index.js';
import { applyContextReplace } from '../plugins/context-engine/index.js';

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

console.log('============================================================');
console.log(' Prompt Studio · Sprint3 后端 无服务器单元自测');
console.log(' API Key 脱敏/校验/.env upsert + Prompt 组装变量替换');
console.log('============================================================');
console.log('');

// 仅用于测试的假 Key（非真实 Key）
const FAKE_KEY = 'sk-1234567890abcdefghijklmn';

// ---------------------------------------------------------------
startSection('[1] maskApiKey 脱敏（绝不泄露完整 Key）');
// ---------------------------------------------------------------

test('长 Key（长度>8）-> 前 3 + **** + 后 4', () => {
  assert.equal(maskApiKey(FAKE_KEY), 'sk-****klmn');
  assert.equal(maskApiKey(FAKE_KEY).length, 11);
  assert.equal(maskApiKey('abcdefghijklmn'), 'abc****klmn');
});

test('长度恰好 9 -> 前 3 + **** + 后 4；长度 8 及以下 -> ****', () => {
  assert.equal(maskApiKey('abcdefghi'), 'abc****fghi');
  assert.equal(maskApiKey('abcdefgh'), '****');
  assert.equal(maskApiKey('abc'), '****');
});

test('空值 / 非字符串不抛错，统一返回 ****', () => {
  for (const input of ['', '   ', null, undefined, 0, 123, {}, []]) {
    assert.equal(maskApiKey(input), '****');
  }
});

test('脱敏结果永远不包含完整 Key / Key 中段', () => {
  const masked = maskApiKey(FAKE_KEY);
  assert.notEqual(masked, FAKE_KEY);
  assert.equal(masked.includes('****'), true);
  assert.equal(masked.includes('1234567890'), false, '中段必须被隐藏');
  assert.equal(masked.includes(FAKE_KEY.slice(3, -4)), false, '除前3/后4外不得出现');
});

test('首尾空白会先 trim 再脱敏', () => {
  assert.equal(maskApiKey(`  ${FAKE_KEY}  `), 'sk-****klmn');
});

test('常量契约：KEY_NAME / API_KEY_MIN_LENGTH', () => {
  assert.equal(KEY_NAME, 'DEEPSEEK_API_KEY');
  assert.equal(API_KEY_MIN_LENGTH, 20);
});

// ---------------------------------------------------------------
startSection('[2] validateApiKey 校验');
// ---------------------------------------------------------------

test('正常 Key 通过（长度>=20、无空白）', () => {
  assert.equal(validateApiKey(`sk-${'a'.repeat(40)}`), true);
  assert.equal(validateApiKey(FAKE_KEY), true);
});

test('长度 20 为边界：20 通过、19 不通过', () => {
  assert.equal(validateApiKey('a'.repeat(20)), true);
  assert.equal(validateApiKey('a'.repeat(19)), false);
});

test('过短 / 含空白或换行 -> 不通过', () => {
  assert.equal(validateApiKey('abc'), false);
  assert.equal(validateApiKey(`sk-${'a'.repeat(15)} ${'b'.repeat(10)}`), false, '内部空格');
  assert.equal(validateApiKey(`sk-${'a'.repeat(15)}\n${'b'.repeat(10)}`), false, '内部换行');
  assert.equal(validateApiKey(`sk-${'a'.repeat(15)}\t${'b'.repeat(10)}`), false, '内部制表符');
});

test('非字符串 -> 不通过（不抛错）', () => {
  for (const input of [null, undefined, 123, {}, [], true]) {
    assert.equal(validateApiKey(input), false);
  }
});

test('首尾空白会被 trim 后接受（内部空白仍然拒绝）', () => {
  assert.equal(validateApiKey(`  ${FAKE_KEY}\n`), true);
  assert.equal(validateApiKey(`sk-${'a'.repeat(16)}  ${'b'.repeat(10)}`), false);
});

// ---------------------------------------------------------------
startSection('[3] upsertEnvLine 安全替换/追加 .env 行');
// ---------------------------------------------------------------

test('替换已有 DEEPSEEK_API_KEY 行，保留其它变量与注释', () => {
  const env = `# 项目配置\nOTHER_KEY=abc\n${KEY_NAME}=old-secret-value\nTAIL=2\n`;
  const out = upsertEnvLine(env, KEY_NAME, 'new-secret-value');
  assert.equal(out.includes(`${KEY_NAME}=new-secret-value`), true);
  assert.equal(out.includes('old-secret-value'), false);
  assert.equal(out.includes('# 项目配置'), true);
  assert.equal(out.includes('OTHER_KEY=abc'), true);
  assert.equal(out.includes('TAIL=2'), true);
  assert.equal(out.split('\n').length, env.split('\n').length, '替换不应改变行数');
});

test('缺失时追加到末尾（自动补末尾换行）', () => {
  const out = upsertEnvLine('OTHER_KEY=abc\n', KEY_NAME, 'new-secret-value');
  assert.equal(out.endsWith(`${KEY_NAME}=new-secret-value\n`), true);
  assert.equal(out.includes('OTHER_KEY=abc'), true);
  assert.equal(out.split(KEY_NAME).length - 1, 1, '只追加一次');
});

test('空内容 -> 只有 Key 行；无结尾换行的内容 -> 先补换行再追加', () => {
  assert.equal(upsertEnvLine('', KEY_NAME, 'v'), `${KEY_NAME}=v\n`);
  assert.equal(upsertEnvLine('OTHER=1', KEY_NAME, 'v'), `OTHER=1\n${KEY_NAME}=v\n`);
});

test('保留原有空行 / 注释 / 其它变量（追加场景）', () => {
  const env = '# 注释\n\nOTHER=1\n# 结尾注释';
  const out = upsertEnvLine(env, KEY_NAME, 'v');
  assert.equal(out.startsWith('# 注释\n\nOTHER=1\n# 结尾注释\n'), true);
  assert.equal(out.endsWith(`${KEY_NAME}=v\n`), true);
});

test('值含 $& / $\' / $` 等特殊字符时按字面量写入（回调替换，不会炸）', () => {
  const tricky = "sk-$&$'$`$1\\n";
  const out = upsertEnvLine(`${KEY_NAME}=old\nOTHER=1\n`, KEY_NAME, tricky);
  assert.equal(out.includes(`${KEY_NAME}=${tricky}`), true);
  assert.equal(out.includes('OTHER=1'), true);
});

test('支持自定义 keyName；行首空格也能匹配替换', () => {
  assert.equal(upsertEnvLine('A=1\n', 'OTHER_KEY', 'v'), `A=1\nOTHER_KEY=v\n`);
  const out = upsertEnvLine(`  ${KEY_NAME}=old\nB=2\n`, KEY_NAME, 'new');
  assert.equal(out.includes(`${KEY_NAME}=new`), true);
  assert.equal(out.includes('old'), false);
  assert.equal(out.includes('B=2'), true);
});

test('重复调用结果稳定（幂等：第二次替换而不是再追加）', () => {
  const once = upsertEnvLine('OTHER=1\n', KEY_NAME, 'v1');
  const twice = upsertEnvLine(once, KEY_NAME, 'v2');
  assert.equal(twice.split(KEY_NAME).length - 1, 1, '始终只有一行 Key');
  assert.equal(twice.includes(`${KEY_NAME}=v2`), true);
  assert.equal(twice.includes('v1'), false);
});

// ---------------------------------------------------------------
startSection('[4] Prompt 组装变量替换（复用 context-engine 纯函数）');
// ---------------------------------------------------------------

const ASSEMBLED_TEXT = [
  '',
  '',
  '### 公共基座 (L0)',
  '你是一个面向 {{industry}} 领域的智能语音助手。',
  '当前业务场景为 {{business_scene}}。',
  '你的核心目标是：{{core_goal}}。',
  '',
  '### 项目层 (L3)',
  '再次强调：面向 {{industry}}，聚焦 {{business_scene}}，目标 {{core_goal}}。',
].join('\n');
const CONTEXT = {
  industry: '旅游行业',
  business_scene: ['售后退换货', '停车缴费'],
  core_goal: ['安抚客户情绪', '准确提供价格'],
};

test('完整长文本（模拟 assemblePrompt 输出）上的占位符全部替换', () => {
  const out = applyContextReplace(ASSEMBLED_TEXT, CONTEXT);
  assert.equal(out.includes('{{'), false, '不应残留占位符');
  assert.equal((out.match(/旅游行业/g) || []).length, 2);
  assert.equal((out.match(/售后退换货、停车缴费/g) || []).length, 2);
  assert.equal((out.match(/安抚客户情绪、准确提供价格/g) || []).length, 2);
});

test('语境为空时变量兜底为「通用」', () => {
  const out = applyContextReplace('行业={{industry}} 场景={{business_scene}} 目标={{core_goal}}', {});
  assert.equal(out, '行业=通用 场景=通用 目标=通用');
});

// ---------------------------------------------------------------
startSection('[5] 路由注册（mock ctx；无 HTTP server / 无文件写入）');
// ---------------------------------------------------------------

const routes = [];
const fakeCtx = { effect: (fn) => fn(), webServer: { register: (r) => { routes.push(r); return () => {}; } } };
apply(fakeCtx);

test('apply(ctx) 注册 /api/settings/api-key（kind=exact，handler 为函数）', () => {
  const route = routes.find((r) => r.path === '/api/settings/api-key');
  assert.notEqual(route, undefined);
  assert.equal(route.kind, 'exact');
  assert.equal(typeof route.handler, 'function');
});

test('settings-engine 只注册 1 条路由（不误抢其它路径）', () => {
  assert.equal(routes.length, 1);
});

// ---------------------------------------------------------------
// 执行 + 汇总
// ---------------------------------------------------------------
for (const section of sections) {
  console.log(section.title);
  for (const item of section.cases) {
    try {
      item.fn();
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
  console.log(`\u2705 sprint3 backend-selftest 全部通过：${passed}/${total} 项用例`);
  process.exitCode = 0;
} else {
  console.log(`\u274c sprint3 backend-selftest 失败：${failed}/${total} 项用例未通过`);
  for (const f of failures) {
    console.log(`   - ${f.name}`);
    console.log(`     ${String(f.error && f.error.message).split('\n')[0]}`);
  }
  process.exitCode = 1;
}
