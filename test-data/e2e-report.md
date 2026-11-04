# Sprint 1 端到端验收报告（Lead）

> 范围：`requirements.md` 模块一（Token 预估 + 变量高亮）+ 模块二（AI 语境提取 / 标签化多选 / 公共基座全局替换）
> 结论：**全部需求项通过，可交付。用户强制自测 3 项全部通过。**

## 1. 环境与服务

| 项 | 值 |
|---|---|
| 工作目录 | `D:\prompt-studio` |
| 启动链路 | 双击 `启动.bat` → `node start.cjs` → `dsh web --patch ./cordis.patch.yml`(3080) + `node server-ui.js`(3081) |
| 页面 | `http://127.0.0.1:3081/?token=…`（token 由 `启动.bat` 控制台打印） |
| 后端插件 | model-gateway / context-engine（新增）/ project-snapshot / kb-manager / eval-runner / release-gate |
| 数据库 | `data/prompt-studio.db`（已幂等迁移 `projects.context_json`） |
| 前端红线 | `public/index.html` 100% 纯原生；无 CDN / 第三方库 / contenteditable |

## 2. 变更清单（Sprint 1）

| 文件 | 变更 |
|---|---|
| `public/index.html` | +528/−4：模块一（镜像 div + 透明 textarea 高亮、50ms 防抖 Token 统计）+ 模块二（语境配置卡片、Tag 组件、AI 提取、AbortController、context_data 传参、切换项目清空回填、语境静默保存） |
| `plugins/context-engine/index.js` | 新增：`GET /api/context/get`、`POST /api/context/save`、`POST /api/context/extract`；导出纯函数 `normalizeContext` / `contextToReplacements` / `applyContextReplace` / `parseExtractResult` |
| `plugins/project-snapshot/index.js` | 修复旧 500 bug；`/api/snapshots/create` 全量长文本全局替换 + 返回 `final_prompt`；新增 `GET /api/snapshots/detail` |
| `plugins/db.js` | `projects.context_json` 建表字段 + 幂等迁移（非破坏） |
| `cordis.patch.yml` | 注册 context-engine |
| `test-data/backend-selftest.mjs` | 25 条纯函数单测 |
| `test-data/e2e/http-smoke.mjs` | 23 项 HTTP 集成冒烟（会写本地测试库） |
| `test-data/e2e/browser-e2e.js` | 55 项真实浏览器 E2E（ego-browser） |

## 3. 自动化验收结果

### 3.1 后端纯函数单测 —— 25/25 通过
```
node test-data/backend-selftest.mjs
✅ 25/25（normalizeContext 7 / parseExtractResult 7 / applyContextReplace 8 / contextToReplacements 2 / 路由注册 1）
```

### 3.2 HTTP 集成冒烟 —— 23/23 通过（经 3081 真实代理）
```
node test-data/e2e/http-smoke.mjs http://127.0.0.1:3081 <token>
PASS 23 / FAIL 0
```
覆盖要点：
- `context/get` 默认安全结构、`context/save`→`get` 回读一致；
- `snapshots/create`：**原 500 bug 已修复**；L0 与 L3 中 `{{industry}}`/`{{business_scene}}`/`{{core_goal}}` 全部替换；数组顿号拼接；空值/空数组→「通用」；跨行 `{{\ntest\n}}` 原样保留；**替换值含 `$&` / `$'` / `` $` `` 按字面量输出不炸**；
- `snapshots/detail` 与 create 返回的 `final_prompt` 一致；`snapshots/list` 保留可用；
- `context/extract`：空知识库项目 → `{success:false, message:"知识库为空…"}`；有知识库项目 → 真实 DeepSeek 调用成功，`industry` 为字符串、两数组元素均为字符串；
- 缺参容错：缺 `layers`/缺 `project_id` → 400 且不崩溃。

### 3.3 真实浏览器 E2E（ego-browser / Chrome）—— 55/55 通过
```
ego_script → test-data/e2e/browser-e2e.js
PASS 55 / 55，页面无未捕获 JS 异常
```
关键实测数据：

| 验证点 | 实测证据 |
|---|---|
| 超长文本 + 两层像素对齐 | L0 221 行 / 约 11k 字符：textarea 与 mirror `clientHeight` 均 **4992px**（差 0），`scrollHeight` 均 4992（差 0，无内部滚动条）；15 个关键 CSS 属性 + 宽度逐项对比**完全相等**（diff=[]，wDiff=0） |
| 变量高亮 | 222 个占位符 → 222 个 `<span>`，computed color 全部 `rgb(245, 158, 11)`（#f59e0b）；`<speak>` 以纯文本保留（镜像层无 `<speak>` 元素） |
| 跨行变量 | `{{⏎newline test⏎}}` 被整体包裹橙色高亮 |
| 自动撑高 / 防塌陷 | 长文本 `height: 4992px`；清空后回落 196px；mirror 高度始终同值 |
| 滚动同步 | 人为让两层可滚动后派发 scroll：`textarea.scrollTop=200 → mirror.scrollTop=200`（diff=0） |
| Token 预估 + 50ms 防抖 | 总字符 1290 → Token 774 = `Math.ceil(1290*0.6)`；input 后同步读取仍为旧值 `0`，>50ms 后变 `1`（证明防抖生效） |
| 中文输入法拦截 | `isComposing:true` 与 `keyCode:229` 两种组合态回车均**不生成 Tag**；组合结束后正常回车生成；`×` 删除、重复/空白不加、trim 均正常 |
| Tag XSS | 标签 `<img src=x onerror=…>` 以纯文本渲染，无 img 元素、无脚本执行 |
| 快照抓包 | 请求 body 含 `context_data:{industry:"旅游行业", business_scene:["售后退换货","停车缴费"], core_goal:["安抚客户情绪","准确提供价格"]}`；响应 `final_prompt` 中 **L0 与 L3 两处**占位符均被真实数据替换、零残留；非语境变量 `{{var_n}}`、跨行 `{{newline test}}` 不被误替换 |
| AI 智能提取 | 真实 LLM 调用：请求 `/api/context/extract` → 响应结构合法（industry 字符串 + 两数组）→ 回填 UI 数量一致（15 场景 / 6 目标）→ 按钮 loading 后恢复 |
| 切换项目 | 切至空库项目「途牛热线」：行业置空、0 标签；切回「Trip旅游AI接线员」：由 `context_json` 正确回填（行业 + 2 场景 + 2 目标） |
| 空知识库拦截 | 点 AI 提取先 toast「知识库为空…」，**网络层 extract 调用数 0**（前端先判空） |
| 回归 | 树导航 / 知识库 97 条 / 快照列表 / 评测卡片正常；无 console 错误 |

配套独立代码审查（qa-reviewer，只读）：**未发现 P0/P1 阻断缺陷**；唯一 P2（语境静默自动保存 800ms 竞态）已修复并复验通过（A→B→A 快速切换无串写、pending 任务被丢弃、快照仍带实时 context_data）。

## 4. 截图证据（test-data/e2e/）

| 文件 | 内容 |
|---|---|
| `01-longtext-highlight-align.png` | 15,573 字符 / 184 行长文本高亮与文字重合、无重影 |
| `02-longtext-bottom-crossline-var.png` | 跨行变量 `{{newline test}}` 两行均橙色、末尾空行不塌 |
| `03-snapshot-success-toast.png` | 快照生成成功 toast |
| `04-empty-kb-toast.png` | 空知识库 AI 提取 toast |
| `05-editor-card-stats-highlight.png` | Token 统计条 + `<speak>` 原文 + 高亮 |
| `06-final-context-refilled.png` | 刷新后切换项目语境回填 |
| `07-snapshot-list-new-row.png` | 快照中心新增记录 |
| `08-context-save-racefix-final.png` | 自动保存竞态修复后的最终语境 |
| `09-lead-editor-longtext-top.png` / `10-lead-editor-longtext-scrolled.png` | Lead 独立复查：长文本顶部 / 滚动后两层重合 |
| `11-lead-final-ui.png` | Lead 最终界面截图（Token 232→140、橙色变量、语境配置卡片） |

## 5. 已知非阻塞事项

1. `deleteKb()` 中仍有原生 `confirm()`（Sprint 1 之前既有代码，本次未改；建议 Sprint 2 迁移到 `#global-modal`）。
2. `public/` 下残留旧 Vue 产物 `vue.global.prod.js` / `index.full.min.js` / `index.css`（已无任何引用，可清理）。
3. Trip 项目知识库内容本身是法律事务类测试语料（AI 提取出「律师事务所 / 离婚纠纷…」），与项目名不一致属测试数据问题，非功能缺陷。
4. 切换项目时 L0/L1/L3 编辑框不会自动回填（Sprint 1 之前的既有行为，需求未要求）。
