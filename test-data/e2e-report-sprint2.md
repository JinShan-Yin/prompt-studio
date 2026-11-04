# Sprint 2 端到端验收报告（Lead）

> 范围：`requirements.md` **模块三（知识库增强）** + **模块四（多轮测试与批量回归）**
> 结论：**全部需求项通过，可交付。用户要求的 3 项浏览器自测（搜索 / 多轮聊天气泡 / JSON 批量回归）全部通过。**

## 1. 环境与服务

| 项 | 值 |
|---|---|
| 工作目录 | `D:\prompt-studio` |
| 启动链路 | 双击 `启动.bat` → `node start.cjs` → `dsh web --patch ./cordis.patch.yml`(3080) + `node server-ui.js`(3081) |
| 页面 | `http://127.0.0.1:3081/?token=…`（token 由启动控制台输出） |
| 新增后端 | `POST /api/chat/reply`（挂载于 eval-runner 插件） |
| 前端 | `public/index.html` 100% 纯原生，无任何外部库/CDN；批量循环为手写 `for + fetch` |

## 2. 变更清单

| 文件 | 变更 |
|---|---|
| `public/index.html` | 1222 → 1835 行：①KB 卡片新增实时搜索（缓存 `currentKbData` + `renderKbList` 过滤/计数/空态/HTML 转义）；②冲突检测（规范化分组 → 红色 `#global-modal` 警告 + 红色内联横幅）；③批量导入 TXT（多文件串行 `file.text → /api/kb/parse → /api/kb/save`，进度/禁用/失败统计）；④`deleteKb` 原生 confirm → `#global-modal` 红色确认；⑤卡片3 改为「多轮对话模拟器」（气泡 UI、Enter 发送含 IME 守卫、每轮 `/api/chat/reply`、历史上下文、清空）；⑥新增「批处理回归测试」卡片（JSON 上传、手动 fetch 顺序循环、缺 `bot_reply` 自动生成、CSS 进度条、通过率 + 失败用例报告、全过 🎉） |
| `plugins/eval-runner/index.js` | +111 行（0 删除）：新增 `POST /api/chat/reply`，复用 project-snapshot 组装 + context-engine 全局替换；system prompt 追加【输出约束】（自然口语 / `<speak>` 包裹 / 禁 Markdown）；messages 清洗（role 白名单、截断 4000、最近 12 条、无 user→400）；导出纯函数 `buildChatSystemPrompt` / `sanitizeChatMessages`；既有 `/api/eval/run` 未改动 |
| `test-data/backend-selftest-sprint2.mjs` | 新建，22 条纯函数/路由/错误分支断言 |
| `test-data/e2e/http-smoke-sprint2.mjs` | 新建，17 项 HTTP 集成冒烟 |
| `test-data/batch-regression-sample.json`、`test-data/e2e/{batch-regression-deterministic.json,import-sample-*.txt}` | 验收/演示测试数据 |

## 3. 自动化验收结果

### 3.1 后端单测 —— 22/22 通过
```
node test-data/backend-selftest-sprint2.mjs
✅ 22/22（buildChatSystemPrompt 7 / sanitizeChatMessages 7 / 路由注册与 eval 回归 2 / 参数分支 4 / 正常链路与 LLM 异常 2）
```

### 3.2 HTTP 集成冒烟 —— 17/17 通过
```
node test-data/e2e/http-smoke-sprint2.mjs http://127.0.0.1:3081 <token>
PASS 17 / FAIL 0
```
覆盖：`OPTIONS /api/chat/reply` 204+CORS；正常对话返回 `reply`+`system_prompt`；`system_prompt` 内 `{{industry}}/{{business_scene}}/{{core_goal}}` 已替换且以【输出约束】结尾；多轮含 assistant 历史；不传 context_data 时 DB `context_json` 兜底；缺/空/非数组 messages、仅 system 消息均 400；GET 405；`/api/eval/run`、`/api/kb/list`、`/api/context/get`、`/api/snapshots/create` 全部回归正常。

### 3.3 Lead 独立浏览器 E2E（dsh-ego-browser / 真实 Chrome）

| # | 验收项 | 实测证据 |
|---|---|---|
| 1 | **实时搜索** | Trip 项目 97 条：搜索「纠纷」→ 可见 21 条且全部含关键字，计数「共 97 条 / 匹配 21 条」；大小写不敏感（`icc`→3）；无匹配→「无匹配条目」；清空→恢复 97 条；答案字段也参与匹配；KB 文本含 `<img>/<b>` 时以纯文本渲染（无 XSS） |
| 2 | **冲突检测** | 注入确定性数据（同问题 2 个不同答案 + 1 正常）→ 弹窗标题「⚠️ 检测到 1 组知识冲突」、标题/确定按钮均为 `rgb(245, 108, 108)`、消息区列出问题与全部不同答案、KB 内红色横幅可见；关闭后样式复位（标题恢复 `rgb(48,49,51)`、按钮恢复蓝色），既有「新建项目」modal 不受影响 |
| 3 | **批量导入 TXT** | 通过真实 file input 上传 2 个 TXT → 串行解析（2 次 `/api/kb/parse`、2 次 `/api/kb/save`）→ toast「导入完成：成功 2 文件 / 入库 5 条」，列表/计数更新；空文件跳过、失败计数逻辑存在 |
| 4 | **多轮对话模拟器** | 真实 DeepSeek 两轮：气泡 2→4（user 右蓝/assistant 左白）；抓包 `/api/chat/reply` 请求 `messages` 历史 1→3 递增、含 3 层 layers 与 context_data、含 prior assistant；回复均为 `<speak>…</speak>` 且无 Markdown；清空按钮→气泡 0 |
| 5 | **批处理回归（进度条+报告）** | 上传 3 条确定性 JSON：`/api/eval/run` 调用 3 次；进度 0% → 33% → 67% → **100%**（`已完成 n/3`），运行中按钮禁用、结束恢复；报告「通过率：1/3（33%）」，失败 #2（L1 Markdown 违规）、#3（L2 事实错误 8→10、50→100）；单条异常不中断 |
| 6 | **缺 bot_reply 自动生成** | 单条无 `bot_reply` 的 JSON：先调 1 次 `/api/chat/reply` 再调 1 次 `/api/eval/run`，进度 100%、报告「1/1（100%）🎉」 |
| 7 | **Sprint1 回归** | Token 统计 40 字符→24 Token（`ceil*0.6`）；`{{industry}}` 橙色 `rgb(245,158,11)`；`<speak>` 原文保留；两层高度差 0；语境回填正常；全流程无未捕获 JS 异常 |

### 3.4 QA 独立审查 + P2 修复复验

独立代码审查（qa-reviewer，只读）：**无 P0/P1 阻断项**，指出 4 个 P2 竞态/边界 + 1 个验收覆盖缺口，已全部修复并复验：

| QA 问题 | 修复 | Lead 复验结果 |
|---|---|---|
| P2-1 批处理运行中切项目/重选文件 → item undefined、按钮/进度不收尾 | 运行时 cases 快照 + `batchRunSeq` 失效机制 + `projectIdAtRun` 双守卫 + 整段 try/finally + 运行中禁选文件 | ✅ 运行中切项目：本轮 UI 重置为待选文件态（运行/选择按钮态正确、进度/报告隐藏），挂起响应回来 0 未捕获异常，重新选文件后可再次运行（`s2-result-phase7c.json` pass:true） |
| P2-2 聊天在途响应跨项目污染 + pending 竞态 | `chatSeq` + `projectIdAtSend` 双守卫，reset 递增序号 | ✅ 发送后 180ms 切项目：新项目聊天区 0 气泡、旧响应回来仍 0 气泡、按钮恢复正常、0 异常（`s2-result-phase7b.json` pass:true） |
| P2-3 KB 导入在途切项目 → 串项目写入 | `projectIdAtImport` 快照 + 每个 await 后校验，变则中止 | ✅ 解析在途切项目：途经 KB 0→0、Trip 97→97（零串写）、中止提示、0 异常（`s2-result-phase7d.json` pass:true） |
| P2-4 空 layers 时默认客服角色不生效（后端规格边界） | `hasLayerContent` 判断，全空回落 `DEFAULT_CHAT_ROLE + 输出约束`；补 3 条单测 | ✅ 空内容 layers/`[]`：system_prompt 以默认客服角色句开头、无「###」空壳、含【输出约束】；有内容 layers 行为不变（`http-check-empty-layers.mjs` 6/6；selftest 25/25） |
| P2-5 deleteKb 的 modal 路径缺真机证据 | 前端补测 + Lead 独立复验 | ✅ 注入临时 KB → 搜索命中 → 点「删除」→ 红色 `#global-modal`「删除知识确认」（无原生 confirm）→ 确定 → 条目消失、搜索词保留、API 回读 0 条（`s2-result-phase7a.json` pass:true） |

修复后回归：`node test-data/backend-selftest-sprint2.mjs` **25/25**；`http-smoke-sprint2.mjs` **17/17**；前端修复轮真机复测（批量/聊天/导入/删除/正常路径）全部通过，`window.onerror`/`unhandledrejection` 全程为空。qa-reviewer 聚焦复审结论：**通过**（序号/项目双守卫逐行复核无漏洞，未发现新 P0/P1/P2；中止 toast 出现在新项目属提示不影响数据）。

## 4. 测试数据清理

- 途牛热线（proj-7ec6f484）注入的 6 条种子 + 5 条导入数据 **已全部通过 `/api/kb/delete` 清理**（清理后 0 条）。
- Trip 项目语境已恢复为「旅游行业 / [售后退换货, 停车缴费] / [安抚客户情绪, 准确提供价格]」。
- 当前 DB：Trip KB 97 条、xinghui 4 条、途牛 0 条；无残留测试数据；Trip 语境已恢复「旅游行业 / [售后退换货, 停车缴费] / [安抚客户情绪, 准确提供价格]」。
- 页面已回到干净状态（Trip 选中、KB 97 条、语境回填正确、聊天/批量为空态、fetch 恢复原生），最终截图 `s2-06-final-after-fixes.png`。

## 5. 截图证据（test-data/e2e/）

| 文件 | 内容 |
|---|---|
| `s2-01-conflict-red-modal.png` | 冲突检测红色弹窗（标题/按钮红色，列出 2 个不同答案） |
| `s2-02-kb-import.png` | 批量导入后 KB 列表与计数 |
| `s2-04-kb-search.png` | 实时搜索「纠纷」→「共 97 条 / 匹配 21 条」 |
| `s2-05-final-ui.png` | 最终干净界面（知识库工具栏/多轮对话/批量回归卡片） |
| `12-kb-conflict-modal-red.png` ~ `18-final-ui-sprint2.png` | 前端工程师自测截图（冲突/导入/气泡/进度条/报告/最终 UI） |
| `s2-1-batch-race-after-switch.png` | P2-1 修复复验：批量运行中切项目 → UI 重置 |
| `s2-2-chat-race-after-switch.png` | P2-2 修复复验：聊天在途切项目 → 新项目无旧气泡 |
| `s2-3-import-race-after-switch.png` | P2-3 修复复验：导入在途切项目 → 未串写 |
| `s2-4-delete-modal-red.png` / `s2-5-delete-after-search-retained.png` | P2-5 修复复验：页内删除红色确认 modal / 删除后搜索词保留 |

## 6. 已知非阻塞事项

1. Trip 项目知识库内容本身为法律事务类测试语料（AI 回复/评测结果随之，属数据非功能问题）。
2. 批量回归的 L1 断言较严格（禁止中文数字单位/Markdown），自动生成回复可能因此被判失败，属既有评测规则设计。
3. Sprint1 既有遗留：`public/` 下旧 Vue 产物无引用可清理（不影响运行）；编辑层 L0/L1/L3 不随项目持久化（既有设计）。
