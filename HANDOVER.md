# NewRock AI Workbench · 移交记录（给新窗口）

> 生成时间：2026-11-25 10:18（Asia/Shanghai）
> 工作区：`D:\prompt-studio`
> 交接对象：下一个接管本项目的 Agent 窗口
> 原则：**先读本文件 + `Readme.md` + DSH 工作区记忆；再动代码。不要凭旧对话/旧文档直接改。**

---

## 0. 一句话现状

项目是 **NewRock AI Workbench v1.62**，单机 Node.js + Express 5 + SQLite，生产服务跑在 `http://127.0.0.1:3100`（LAN 模式）。  
V1.62 功能与近期 UI 精修均已完成并提交；**origin/main 已包含代码提交 `858dd7c`、交接提交 `cef3743` 与 tag `v1.62`**。本地当前有未推送的 docs 修订（修复 .gitignore 编码/交接状态），具体 ahead 数以 `git status -sb` 为准。当前没有进行中的代码任务。

---

## 1. 接手前必须知道的 6 件事

1. **生产服务不要随意重启**：3100 当前监听 `0.0.0.0:3100`，PID **22300**，是提升权限的进程，普通 shell 的 `taskkill` 可能 Access denied。前端静态改动刷新即可；改 `server.js` 必须用管理员权限重启才生效。
2. **生产库是 `data/newrock.db`**，不是旧的 `data/prompt-studio.db`。禁止用生产库做测试。
3. **QA 必须隔离**：用 `NEWROCK_DATA_DIR` 指向独立目录 + 端口 3101；测试结束删除临时目录/库。生产库当前：2 用户、2 公司、4 项目、67 条提交记录、464 条知识库、5 个模型、1 个模板。
4. **Git 状态**：远程 `origin/main` 已同步到 `cef3743`（含交接文件 + tag `v1.62`）；最新代码提交是 `858dd7c`。本地当前有未推送的 docs 修订，以 `git status -sb` 为准；推送前确认远程/权限。
5. **本地临时文件**：`.session-headers.jsonl`（DSH 会话头文件）已由 `.gitignore` 忽略，**不要提交**；`.qa-test/` 同样忽略。
6. **本文件已提交在 `cef3743`**；若新窗口再修订本文件，会产生一个本地 docs 提交，ahead 数以 `git status -sb` 为准。

---

## 2. 版本与运行信息

| 项 | 值 |
|---|---|
| 版本 | `1.62.0`（package.json / 启动日志 / `/api/health`） |
| 入口 | `server.js`（约 3664 行） |
| 前端 | `public/index.html`（约 6059 行，单文件原生 HTML/CSS/JS） |
| 数据库 | `data/newrock.db`（SQLite + WAL） |
| 主密钥 | `data/.vault-key`（模型 Key 解密依赖） |
| 会话密钥 | `data/.session-secret` |
| 备份 | `data/backups/{startup,auto}`；导入前 `data/backup-before-import-*.json` |
| 路由数 | 68 条 `/api` |
| 生产 URL | http://127.0.0.1:3100 |
| 监听 | `0.0.0.0:3100`（`.env` 中 `LAN_ACCESS=true`） |
| 账号 | `admin`（密码见项目记忆/本机部署记录；**不要写进仓库**） |
| 冒烟 | `node scripts/smoke-v1.62.mjs`（52 项断言，临时数据目录） |

启动：

```powershell
cd D:\prompt-studio
npm start        # = node server.js
```

自检：

```powershell
curl.exe -s http://127.0.0.1:3100/api/health
# 期望：success/status/version=1.62.0/db_ok/mode=lan
```

**端口优先级**：系统环境变量 `PORT` > `.env` 的 `PORT` > 代码默认 3100。  
不要改这两个“3000”：`EVAL_KB_MAX=3000`、关闭超时 `3000`。

---

## 3. 本阶段改了什么（最近 5 个提交）

| 提交 | 内容 |
|---|---|
| `858dd7c` | 编辑页精简：提交改白底次按钮、移除复制为txt/Token 进度栏/系统提示词 label/清理排版；AI 润色移到卡片右上角；新增项目改名 + 图标修复；提交记录操作列右对齐；项目名 title 悬浮 |
| `32bda54` | 「生成历史快照」→「提交」，「历史快照」→「提交记录」；Tab/卡片/空状态/克隆/功能权限/toast 同步 |
| `b1f0898` | 提交记录表格移除快照 ID 列；备注→版本备注；5 列布局、列宽/对齐；操作列修正 |
| `6fa8262` | 移除「提取新模板」按钮/弹窗/前端逻辑；模板库保留搜索/应用/删除/恢复 |
| `f3ba814` | 移除「插入变量」下拉、语境配置卡片、变量高亮/tooltip、前端 `context_data` 发送 |

累计（相对阶段起点）：5 个文件，+117 / −962 行；`public/index.html` 净减约 987 行。

### 当前 UI 状态（不要擅自恢复）

- **4 个 Tab**：提示词编辑 / 知识库 / 评测 / **提交记录**。
- **编辑页**：
  - 卡片右上角：`应用模板`、`AI 润色`（恢复初始模板按需出现）。
  - 编辑框无「系统提示词」label；无 Token 进度栏；下方保留字符数/Token 估算。
  - 底部：版本备注输入 + `提交`（白底细边）+ 无「复制为txt」。
  - 无「清理排版」。
- **提交记录表格**：勾选 / **版本备注** / 生成时间 / 评测状态 / 操作；**不展示快照 ID**（ID 在预览标题、下载文件名中）。
- **侧边栏**：`新增项目`；图标 14px 完整圆圈；长项目名 hover 显示完整名称。
- 术语：底层仍是 `snapshots` 表和接口；界面统一「提交 / 提交记录」。

### 保留的兼容项（不要误删）

- 后端 `/api/context/*` 与 `applyContextReplace` 仍然存在：旧提示词中的 `{{industry}}` 等若还有人写，会按遗留 `context_json` 替换（空则「通用」）。
- 后端 `/api/templates/extract|save` 仍然存在；只是前端没有新建模板入口。
- `copyTextToClipboard` 仍被「提交记录」的复制功能使用，不要一起删。

---

## 4. 代码地图

```
server.js                 后端入口：路由、DB、迁移、权限、加密、备份、LLM 路由（约 3664 行）
public/index.html         前端全部 UI/JS（约 6059 行）
public/login.html         登录/注册页
lib/markdownChunker.js    v1.61 本地 Markdown 切片器
scripts/smoke-v1.62.mjs   后端 52 项冒烟（零依赖，临时数据目录）
autostart/                Windows 启动脚本、日志轮转、局域网防火墙脚本
data/                     SQLite、密钥、备份（不要提交）
logs/                     运行日志
Readme.md                 当前权威文档
UPDATE_v1.62.md           v1.62 升级说明 + 追加变更
QA_REPORT_v1.62.md        各轮 E2E/回归记录
API_REFERENCE.md          API 精简参考（以 server.js 实际路由为准）
CURRENT_STATUS.md         历史 v1.60 文档，不要当现状
PROJECT_CONTEXT.md        历史 v1.60 文档，不要当现状
```

关键表：`users / teams / companies / projects / kb_items / snapshots / model_configs / prompt_templates / audit_logs / app_settings / project_grants / project_pins`。

---

## 5. 开发红线（必须遵守）

### 5.1 前端双层编辑器

- 编辑器 = **底层 `div#mirror-*` + 上层透明 `textarea#val-*`**；**严禁 contenteditable**。
- 两层 CSS 必须完全一致；mirror 的 `scrollTop/scrollLeft/paddingRight` 必须跟随 textarea。
- 切 Tab 回来 / resize / 选中项目后必须 `refreshAllEditorMirrors()` 或 `refreshEditorLayoutAfterTabShow()`。
- 程序赋值必须原生 setter + 派发 `input` 事件；禁止直接 `el.value = ...`。

### 5.2 SQLite

- 批量删除**必须串行**，严禁 `Promise.all`。
- 表结构迁移幂等、先备份；SQLite 不直接 DROP COLUMN，用重建表；新表保留全部旧字段。

### 5.3 权限与数据

- 所有业务 SQL 必须带 `user_id` 或角色过滤；越权 403、不存在 404。
- 功能关闭 = 隐藏入口 + 后端 403，不以隐藏代替鉴权。
- 超管功能权限不可禁用/删除（防锁死）。
- 数据变更前备份真实库；不提交 `.env`、`data/`、`logs/`。

### 5.4 网络

- 默认只监听回环；`LAN_ACCESS=true` 才 0.0.0.0；Host/Origin 白名单只认字面回环/私有 IP/localhost，拒绝任意域名。
- 局域网是 HTTP 明文，只用于可信内网。

---

## 6. 测试 / 回归方法

### 6.1 后端冒烟（首选，不碰生产库）

```powershell
cd D:\prompt-studio
node scripts/smoke-v1.62.mjs
# 期望 RESULT pass=52 fail=0
```

### 6.2 隔离 QA（浏览器）

- 使用端口 3101 + 独立 `NEWROCK_DATA_DIR`：

```powershell
$env:PORT='3101'
$env:NEWROCK_DATA_DIR='D:\prompt-studio\.qa-test\data'
$env:LAN_ACCESS='false'
node server.js
```

- QA 库必须从生产库的 `db.backup()` 复制，**不要直接复制正在写入的 `-wal`**；否则 WAL 分裂会让首登面板卡住。
- 账号密码在 QA 库中重置；首登改密通过 `/api/auth/change-password` 完成，不要直接改 DB 绕过流程。
- Playwright 安装到 `.qa-test`，不要污染仓库 `package.json`。
- 测试结束：停 3101、删除 `.qa-test` 与 `data/qa-test.db*`，核验生产库无 QA 用户/公司。

### 6.3 本轮已做过的回归

- 5 轮浏览器回归，共 **60 项通过**（15 + 6 + 12 + 11 + 16）。
- 后端冒烟每轮 **52 / 52**。
- 最近一次：编辑页精简 16/16；操作列文字右对齐误差 ≤1px；图标圆圈无裁剪；长项目名 title 完整。
- 详细记录见 [QA_REPORT_v1.62.md](QA_REPORT_v1.62.md)。

---

## 7. 已知限制 / 当前注意事项

1. **发布门禁仍是占位**：`/api/snapshots/create` 写死 `eval_pass=1`、`eval_score=5.0`；回归结果不落库、不关联提交记录。计划 V1.63。
2. **变量/语境 UI 已按产品决策移除**：不要因为“变量没入口”又恢复；后端接口只为兼容保留。
3. **模板新建入口已移除**：模板库只能应用/删除已有模板；如果要恢复“保存为模板”，需要产品确认后单独加入口。
4. **快照 ID 不作为表格列**：排障时点「预览」，标题含完整 ID；下载文件名也含 ID。
5. **服务端标签未生效**：当前 3100 进程启动早于 `server.js` 的「提交记录」标签改动；前端对旧标签做了兼容映射。下次用管理员权限重启后完全一致。
6. **Git 未推送**：9 个提交待 push；推之前确认 GitHub 凭据。`.session-headers.jsonl` 未跟踪，勿提交。
7. **全量备份的模型 Key 依赖 `data/.vault-key`**：跨机恢复必须一并复制，否则需重填。
8. **会话是 MemoryStore**：重启需重新登录；禁用/踢下线用 `session_version` 立即失效。
9. **删除账号有限制**：仅“无业务数据”账号可删；有数据请禁用。

---

## 8. V1.63 待办（未开始）

- 真实发布门禁：评测结果落库 + `/api/gate/export` 真正拦截。
- 软删除/回收站。
- 知识库大文件上限与分页。
- 用量/成本看板。
- 可选 HTTPS。
- 项目所有权移交。
- 模板新建入口是否需要恢复（产品决策）。

---

## 9. 新窗口接管步骤

1. **读**：本文件 → [Readme.md](Readme.md) → [UPDATE_v1.62.md](UPDATE_v1.62.md) → [QA_REPORT_v1.62.md](QA_REPORT_v1.62.md) → DSH 工作区记忆 `project-memory`。
2. **查状态**：

```powershell
cd D:\prompt-studio
git status -sb
git log --oneline -10
git remote -v
curl.exe -s http://127.0.0.1:3100/api/health
```

3. **不要**默认重启 3100；先确认是否需要服务端改动。纯前端改动只需浏览器 **Ctrl+F5** 强刷。
4. **任何修改**：先确定是否影响生产数据；用 3101 隔离 QA；先跑 `node scripts/smoke-v1.62.mjs`，再做浏览器回归。
5. **提交**：只 add 代码/文档；不要提交 `.env`、`data/`、`logs/`、`.session-headers.jsonl`。提交后如需要，询问用户是否 push（当前 9 个提交未推送）。
6. **交接完成标准**：新窗口能独立说明当前版本、UI 决策、红线、测试方式、未完成事项，并能在不碰生产库的前提下跑通 52 项冒烟。

---

## 10. 协作偏好（来自本阶段）

- 用户偏好**中文、结果优先、少铺垫**；能直接判断就给出判断和方案。
- 不要为了“确认”反复打断；重大数据变更/不可逆操作前先备份。
- 用户会直接指出 UI 细节（对齐、色块、图标、文案），修改后要**截图/量化验证**，不要只说“已改”。
- 当前产品方向：**界面持续做减法**；不常用的变量/模板提取/清理排版等入口已被移除，除非用户明确要求，不要恢复。

---

## 11. 最近提交清单

```
cef3743 docs: 更新 V1.62 交接文档并忽略本地临时文件（origin/main，tag v1.62）
01f1456 docs: 增加新窗口移交记录 HANDOVER.md
858dd7c feat(ui): 精简编辑页并修正新增项目/提交记录操作列 + docs(qa): 16 项回归通过
32bda54 feat(ui): 生成历史快照改为提交，历史快照改为提交记录 + docs(qa): 11 项回归通过
b1f0898 fix(ui): 历史快照表格移除快照 ID 列并修正对齐/列宽/版本备注 + docs(qa): 12 项回归通过
6fa8262 feat(ui): 移除提取新模板按钮与弹窗，模板库保留应用/删除 + docs(qa): 6 项回归通过
f3ba814 feat(ui)!: 移除插入变量与语境配置界面及前端逻辑 + docs(qa): 15 项回归通过
d3422dc feat(ui): 恢复语境配置面板并修复变量填值/只读/切项目丢输入问题 + docs(qa): 33 项回归通过
e4dd1dd fix(ui): clone modal radio visibility + docs(qa): v1.62 full E2E acceptance report
47fbaa9 docs(v1.62): README/API/升级说明与自启文档同步（局域网、权限、克隆、备份、运维）
9feb438 feat(v1.62): 局域网访问、功能权限框架、项目只读授权与置顶、跨公司克隆、个人 API Key、账号治理、备份与运维
```

远程：`https://github.com/JinShan-Yin/prompt-studio.git`

---

**交接结论**：当前没有进行中的代码任务；项目可运行、可回归、文档与记忆已同步。新窗口从「第 9 节 接管步骤」开始即可。
