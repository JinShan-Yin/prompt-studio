# NewRock AI Workbench · 移交记录（给新窗口）

> 生成时间：2026-11-25 22:20（Asia/Shanghai）
> 工作区：`D:\prompt-studio`
> 交接对象：下一个接管本项目的 Agent 窗口
> 原则：**先读本文件 + `Readme.md` + DSH 工作区记忆；再动代码。**

---

## 0. 一句话现状

项目是 **NewRock AI Workbench v1.63**，单机 Node.js + Express 5 + SQLite，生产服务跑在 `http://127.0.0.1:3100`（LAN 模式）。V1.63 已完成并通过冒烟 80/80 + 页面全按钮回归 90/90；**生产 3100 仍是 v1.62 进程，需要管理员权限重启后才加载 v1.63 服务端改动**（前端静态文件刷新即生效）。

---

## 1. 接手前必须知道的 6 件事

1. **生产服务不要随意重启**：3100 是提升权限进程（PID 以实际为准），普通 shell `taskkill` 可能 Access denied。前端静态改动 Ctrl+F5；`server.js` 改动需管理员重启。
2. **生产库是 `data/newrock.db`**，禁止用于测试。V1.63 迁移只加表/列，启动前会自动做一次文件级快照（`data/backups/startup`）。
3. **QA 必须隔离**：端口 3101 + `NEWROCK_DATA_DIR=.qa-test/data`；测试结束停进程并清理。生产库当前仍是 2 用户、0 业务数据、5 个模型配置（未被本轮测试触碰）。
4. **Git**：本轮改动尚未提交（`public/index.html`、`server.js`、`scripts/smoke-v1.63.mjs`、文档）；提交前 `git status -sb` 确认。**不要提交** `.env`、`data/`、`logs/`、`.session-headers.jsonl`、`.qa-test/`。
5. **浏览器自动化受本机限制**：Edge 在本机因命名管道/mojo 被系统拒绝而无法启动（即使完全访问权限），真实浏览器 E2E 跑不了；本轮改用 jsdom DOM 级回归（见 §6）。
6. **门禁策略按产品决定保持现状**：`/api/snapshots/create` 仍写死 `eval_pass=1 / eval_score=5.0`，`/api/gate/export` 仍放行；评测结果只落库做历史，不拦截提交/导出。

> 数据状态（2026-11-25 10:52，未变）：生产业务表已清空；保留 2 个账号、5 个模型配置与 `app_settings`。清理前全量备份：`data/backups/manual/cleanup-before-20261125_025225.db`。

---

## 2. 版本与运行信息

| 项 | 值 |
|---|---|
| 版本 | `1.63.0`（package.json / 启动日志 / `/api/health`） |
| 入口 | `server.js`（约 4.3k 行） |
| 前端 | `public/index.html`（约 6.6k 行，单文件原生 HTML/CSS/JS） |
| 数据库 | `data/newrock.db`（SQLite + WAL） |
| 主密钥 / 会话密钥 | `data/.vault-key` / `data/.session-secret` |
| 路由数 | **77 条** `/api` |
| 生产 URL | http://127.0.0.1:3100 |
| 冒烟 | `node scripts/smoke-v1.63.mjs`（80 项，临时目录，零依赖） |
| 页面回归 | `.qa-test\run-dom.ps1`（jsdom，90 项；依赖已装在 `.qa-test`，仓库依赖未变） |

启动：

```powershell
cd D:\prompt-studio
npm start        # = node server.js
curl.exe -s http://127.0.0.1:3100/api/health
# 期望 version=1.63.0 / db_ok / mode=lan
```

> 不要改这两个「3000」：`EVAL_KB_MAX=3000`、关闭超时 `3000`。

---

## 3. V1.63 改了什么

### 3.1 顶部与编辑页（产品要求）

- 顶部 6 个入口合并为 1 个「系统管理」齿轮菜单：用户与权限 / 备份 / 审计日志（黑匣子）/ 快捷键面板 / 模型配置中心 / 退出登录；按角色显示条目。
- 删除「功能导航」下拉、顶部「导出/导入备份 JSON」快捷图标；备份能力保留在系统管理「备份与运维」tab。
- 删除「应用模板」「恢复初始模板」、模板应用弹窗与相关 JS/CSS；后端 `/api/templates*` 保留兼容。
- 新建项目弹窗：placeholder 统一「请输入项目名称（留空 = 仅创建公司或行业）」；「创建客户或行业」改为与「新增项目」相同的圆+ SVG 按钮。

### 3.2 后端功能

- **评测落库**：`POST/GET /api/eval/runs`，服务端重算 L1，记录用例/通过/L1 失败/平均分/提示词哈希；每项目保留 300 条；提交仅补 `eval_run_id` 关联，不改 1/5.0、不拦截导出。
- **只读授权**：新表 `read_grants`（客户级/项目级 × 用户/团队/所有团队），旧 `project_grants` 幂等迁入；`/api/projects/grants` 扩展并兼容旧入参。
- **回收站**：4 张业务表加 `deleted_at/deleted_by/deleted_batch`；`/api/recycle/{list,restore,purge}`；30 天保留期 + 启动/每日串行清理。
- **知识库**：`/api/kb/list` 分页 + 服务端搜索；`KB_MAX_FILE_MB`（默认 20）；413 JSON。
- **用量看板**：`llm_usage` 表 + `/api/admin/usage/summary`；模型配置新增输入/输出单价。
- **所有权移交**：`/api/projects/transfer` + candidates。
- **用户治理**：`/api/admin/users/role`；`/api/admin/users/delete` 支持 `force + data_mode`。
- **修复**：L1 中文数字误判、团管空团队越权、assign-team 隐式降级、删除孤儿数据、上传 413、AI 润色缺少 `stripCodeFence`、成本舍入、同路径 GET/POST 路由冲突。

### 3.3 数据迁移（幂等）

`eval_runs` 7 列；`companies/projects/kb_items/snapshots` 各 3 个软删列；`read_grants`、`llm_usage` 新表；`model_configs` 2 个单价列；6 个索引；`recycle_retention_days=30`。启动前文件快照先于迁移执行。

---

## 4. 代码地图

```
server.js                    后端：路由、DB/迁移、权限、加密、备份、LLM、评测、回收站、用量
public/index.html            前端全部 UI/JS
public/login.html            登录/注册/首登改密
lib/markdownChunker.js       Markdown 切片
scripts/smoke-v1.63.mjs      后端 80 项冒烟
scripts/qa-button-inventory.mjs  页面事件清单（100 个）
scripts/smoke-v1.62.mjs      历史冒烟（保留参考）
.qa-test/                    QA 产物（已忽略）：dom-e2e.mjs / run-dom.ps1 / e2e.mjs / run-e2e.ps1
autostart/                   Windows/Linux 自启脚本
data/                        数据库、密钥、备份（不要提交）
logs/                        运行日志
Readme.md                    权威文档
UPDATE_v1.63.md              本版升级说明
QA_REPORT_v1.63.md           本轮回归记录
API_REFERENCE.md             API 精简参考（以 server.js 实际路由为准）
```

关键表：`users / teams / companies / projects / kb_items / kb_item_versions / snapshots / eval_runs / model_configs / prompt_templates / audit_logs / app_settings / project_grants / project_pins / read_grants / llm_usage`。

---

## 5. 开发红线

### 5.1 前端双层编辑器
- 编辑器 = 底层 `div#mirror-*` + 上层透明 `textarea#val-*`；**严禁 contenteditable**。
- 两层 CSS 一致；mirror 的 scroll/padding 跟随 textarea；切 Tab/切项目后刷新 mirror。
- 程序赋值必须原生 setter + `input` 事件。

### 5.2 SQLite
- 批量删除必须串行，严禁 `Promise.all`。
- 表结构迁移幂等、先备份；不直接 DROP COLUMN，用重建表；新表保留全部旧字段。
- 软删除查询统一 `COALESCE(deleted_at,'') = ''`；彻底删除要显式清理 kb/snapshots/read_grants/pins。

### 5.3 权限与数据
- 业务 SQL 必须带 `user_id` 或角色过滤；越权 403、不存在 404、已删除 404。
- 功能关闭 = 隐藏入口 + 后端 403；超管功能权限不可禁用。
- 数据变更前备份真实库；不提交 `.env`、`data/`、`logs/`。

### 5.4 网络
- 默认只监听回环；`LAN_ACCESS=true` 才 `0.0.0.0`；Host/Origin 白名单只认字面回环/私有 IP。
- 局域网是 HTTP 明文，只用于可信内网；本轮**未做 HTTPS**。

---

## 6. 测试 / 回归

### 6.1 后端冒烟（首选，不碰生产库）

```powershell
node scripts/smoke-v1.63.mjs
# 期望 RESULT pass=80 fail=0（临时目录 data/tmp/smoke163-*）
```

### 6.2 页面全按钮回归（DOM 级）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .qa-test\run-dom.ps1
# 期望 RESULT pass=90 fail=0
```

- 环境：3101 + `.qa-test/data` 全新库；`.qa-test` 内 mock LLM 3301；jsdom 执行真实页面脚本。
- 覆盖：登录/首登改密、四个 Tab、侧边栏全部菜单、系统管理六面板、模型配置、回收站、用量、退出；末尾校验清单内 100 个事件处理函数全部已定义。
- **真实浏览器 E2E 不可用**：本机系统策略拒绝 Edge 的命名管道/IPC（mojo 0x5），Playwright/Edge 启动即崩溃；如需像素级回归，换一台不受限的机器或用真实浏览器人工抽查。

### 6.3 隔离 QA（人工）

- 端口 3101 + 独立 `NEWROCK_DATA_DIR`；不直接复制正在写入的 `-wal`。
- 手工验收建议：用真实 Key 跑一次 15 题回归 → 提交 → 导出，确认评测历史与用量看板有数据。

---

## 7. 已知限制 / 注意事项

1. **发布门禁仍不拦截**：提交写死 1/5.0、导出放行；评测仅历史可追溯（按 V1.63 产品决定）。真实门禁未排期。
2. **模板库前端入口已移除**：后端 `/api/templates*` 与 `prompt_templates` 表保留；不要擅自恢复 UI。
3. **变量/语境配置 UI 已移除**：后端 `/api/context/*` 与 `applyContextReplace` 仅兼容；不要恢复。
4. **未做 HTTPS**。
5. **真实浏览器自动化受本机 IPC 限制**（见 §6.2）。
6. **全量备份模型 Key 依赖 `data/.vault-key`**：跨机恢复必须一并复制。
7. **会话是 MemoryStore**：重启需重新登录；禁用/踢下线用 `session_version` 立即失效。
8. **角色变更后目标账号需重新登录**（会话版本 +1）。
9. **删除账号**：无数据直接删；有数据必须走强制删除二选一。
10. **回滚注意**：升级后软删的数据在 v1.62 代码看来仍存在，回滚前先恢复需要保留的数据。

---

## 8. V1.64 候选（未开始）

- 真实发布门禁（评测结果与提交/导出强关联）。
- 可选 HTTPS。
- 知识库自动分块解析大文档（当前超限只提示拆分）。
- 用量看板导出/告警阈值。
- 回收站按类型批量清理、保留期可视化配置。
- 模板库是否恢复入口（产品决策）。

---

## 9. 新窗口接管步骤

1. 读：本文件 → `Readme.md` → `UPDATE_v1.63.md` → `QA_REPORT_v1.63.md` → DSH 工作区记忆。
2. 查状态：
   ```powershell
   git status -sb
   git log --oneline -10
   curl.exe -s http://127.0.0.1:3100/api/health
   ```
3. 不改生产：纯前端改动刷新即可；`server.js` 改动需管理员重启 3100。
4. 改代码前先跑 `node scripts/smoke-v1.63.mjs`；涉及 UI 再跑 `.qa-test\run-dom.ps1`。
5. 提交只 add 代码/文档；不要提交 `.env`、`data/`、`logs/`、`.session-headers.jsonl`、`.qa-test/`。

---

## 10. 协作偏好

- 中文、结果优先、少铺垫；能直接判断就给判断和方案。
- 不要为「确认」反复打断；重大数据变更/不可逆操作前先备份。
- UI 细节修改后要截图/量化验证，不要只说「已改」。
- 产品方向：界面持续做减法；未被明确要求的旧入口不要恢复。

---

## 11. 本轮提交清单（提交后以 git log 为准）

```
feat(v1.63): 顶部系统管理合并 / 模板入口移除 / 文案与图标精修
feat(v1.63): 评测落库、授权升级、回收站、知识库分页、用量看板、所有权移交、用户治理
test(v1.63): 80 项冒烟 + 90 项页面全按钮回归
docs(v1.63): README/UPDATE/QA/HANDOVER 同步
```
