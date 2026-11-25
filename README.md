# NewRock AI Workbench v1.63

企业级、多租户的**提示词协作与 AI 资产管理平台**。纯 Node.js（Express 5）+ 原生前端构建，用于集中管理 AI 智能体的提示词、知识库、多模型路由、提交记录与自动化评测。数据通过 SQLite 本地存储；默认仅监听本机 `127.0.0.1:3100`，开启 `LAN_ACCESS` 后可让局域网内设备访问。

> **版本说明**：当前代码为 **v1.60 底座 + v1.61 知识库结构化升级 + v1.62（局域网 / 权限框架 / 置顶 / 跨公司克隆 / 个人 Key / 账号治理 / 备份与运维）+ v1.63（评测历史 / 客户级授权 / 回收站 / 知识库分页 / 用量看板 / 所有权移交 / 用户治理 + 顶部精简）**。
> `package.json`、启动日志与 `/api/health` 统一为 `1.63.0`。

---

## 目录

- [功能特性](#功能特性)
- [v1.63 更新要点](#v163-更新要点)
- [v1.62 更新要点](#v162-更新要点)
- [v1.61 更新要点](#v161-更新要点)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [配置说明](#配置说明)
- [数据与迁移](#数据与迁移)
- [开机自启](#开机自启)
- [默认账号](#默认账号)
- [API 概览](#api-概览)
- [安全设计](#安全设计)
- [二次开发约定](#二次开发约定)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [相关文档](#相关文档)

---

## 功能特性

### 多租户与权限

- 团队（Team）、用户、三种角色：`superadmin` / `teamadmin` / `user`。
- 手机号或邮箱注册、bcrypt 密码哈希、首次登录会提示修改密码（可“稍后再说”跳过）、管理员重置密码为 `123456`。
- 数据按 `user_id` + 角色做行级隔离：个人仅见本人，团管可见同团队，超管可见全部。
- 公共参考项目（`global` / `team` 两种范围）全员或同团队只读访问。
- 审计日志（黑匣子）：记录登录、增删改、代管操作、备份导入等；分 `Info` / `Warn` / `Danger` 三级并记录 IP，仅超管可查看。
- 普通用户可使用超管配置的公共模型 Key 试用 3 次；超出后需配置自己的 Key。

### 提示词工程

- 客户/行业 → 项目的两级树，支持置顶、搜索、多选批量删除、项目克隆（含知识库）。
- **单层系统提示词编辑**（v1.60 起由原 L0/L1/L3 扁平化而来）。
- **双层镜像编辑器**：底层 mirror div 着色、上层透明 textarea 输入，绝不使用 contenteditable；实时字符数与 Token 估算（`字符数 × 0.6`，50ms 防抖）。
- AI 润色：卡片右上角入口，整段系统提示词交给大模型精简改写，保留业务语义与结构。
- 模板库：搜索 / 应用 / 删除已有模板、恢复初始模板；「提取新模板」入口已移除（后端 `/api/templates/extract|save` 仅保留兼容）。
- 本地草稿：按项目写入 `localStorage`，切换项目自动恢复。
- 提交时可填写版本备注，并支持 `Ctrl/Cmd + S` 快捷提交。

### 知识库

- 导入格式：`.txt` / `.md` / `.markdown` / `.doc` / `.docx` / `.xls` / `.xlsx` / `.pdf`（旧版 `.doc` 为二进制 OLE，仅做文本容错提取，建议先另存为 `.docx`）。
- 两种入库模式：
  - **保留原结构（智能分块）**：本地 Markdown 算法，按 `#` ~ `######` 标题切块，单块超过 1500 字符先按段落、再按字符强切；表格自动拆成“子表 + 自然语言描述”（如“中环店的电话是 3100 2002”），不调用大模型。
  - **提取为 Q/A 问答对**：调用大模型把文本改写为标准问答对。
- 知识库列表：关键字搜索、冲突检测（同问题不同答案）、Markdown 安全渲染（marked + DOMPurify），表格限高并可横向滚动。
- 在线编辑：直接编辑原始 Markdown 源码（不做渲染），保存时写入新版本记录。
- 删除：支持单条与批量；**批量删除严格串行**，避免 SQLite 锁死。
- 导出：`.txt` / `.md`，带 UTF-8 BOM，Windows 记事本/Excel 打开不乱码。

### 提交记录

- 提交（保存组装后的完整提示词 + 原始 layers + 语境替换结果 + 版本备注）。
- 前端分页（20 条/页）、跨页多选、批量删除、版本备注展示。
- 预览：只读弹窗展示提交记录正文，`Esc` 关闭。
- 对比：纯原生行级 LCS 算法，左旧右新双栏 Diff，超大文本自动退化为整段对比防卡死。
- 回滚：把提交记录内容写回当前编辑器（兼容旧三层快照的 L0/L1/L3 合并），并提示需重新提交。
- 下载：单条 / 批量下载 `.txt` / `.md`，带 BOM；批量逐条延时触发，避免浏览器拦截。
- 项目级 ZIP 导出：`manifest.json` + 每条提交记录一个 `.txt`。
- 发布门禁导出接口：`GET /api/gate/export`（校验 `eval_pass`，带 `no-store` 防缓存）。

### 多模型路由

- 模型配置中心：厂商预设（DeepSeek / OpenAI / 通义千问 / 智谱 / Moonshot / 自定义）、Base URL、模型名、温度、最大上下文、激活开关。
- API Key 使用 **AES-256-GCM** 加密后落库（密钥在 `data/.vault-key`），前端只返回掩码（前 3 + 后 4）。
- 连通性测试（20s 超时）、单用户单活模型、超管公共模型回落与试用扣减。
- `.env` 的 `DEEPSEEK_API_KEY` 支持页面原子写入、立即生效；仅超管可查看/修改。
- 安全限制：非本机 Base URL 必须 HTTPS、禁止内网/链路本地地址；`.env` 真实 Key 只允许发送给 `api.deepseek.com`，自定义端点必须自带 Key。

### 评测与对话

- 多轮对话模拟器：用当前系统提示词组装 System Prompt，追加 `<speak>` 语音输出约束，保留最近 12 条历史。
- AI 生成测试用例：基于知识库（截断 3000 字）生成 15–30 道「刁钻」用例，服务端正则清洗 JSON。
- 一键回归测试：串行执行「对话 → L1 规则断言 → L2 大模型语义评分」，每轮间隔 500ms，可中止；生成通过/未通过报告与 Bad Case。
- 评测用例导出：`.txt` / `.md`，带 BOM。
- 对话与评测均带项目切换竞态守卫，避免旧响应污染新项目。

### 备份与迁移

- 备份两档：**业务数据**（10 张业务表，兼容旧备份）与**全量**（额外含 `users` / `teams` / `audit_logs` / `app_settings` / `project_grants` / `project_pins`）。
- 备份导入：按 `version/scope` 分流严格校验（字段白名单、主键、引用完整性、至少 1 个可登录超管）；导入前自动落一份全量安全备份；事务失败自动回滚。
- 自动备份：启动前文件级快照（保留 5 份）＋ 每日在线备份（保留 14 份）；管理面板可查看与手动触发。
- 数据库自动迁移：旧库改名、补列、多租户升级、`prompt_templates` 重建表，全部幂等，失败不影响启动。
- 项目克隆：支持**跨公司克隆**（A 公司项目 → B 公司），可选「仅最新提交记录 / 全部提交记录 / 不复制」；知识库保留 `structure_mode`。

### 运维

- 默认仅监听 `127.0.0.1`，端口默认 `3100`；`LAN_ACCESS=true` 时监听 `0.0.0.0` 并只放行私有网段来源。
- `GET /api/health` 免登录健康检查（版本 / 运行时长 / 数据库 / 模式 / 端口）。
- 启动自动生成 WAL checkpoint + 启动前数据库快照；每日在线备份并保留最近 14 份。
- `logs/service.log` 超 10MB 自动轮转（保留 5 份）；WAL 定期 checkpoint，退出前再收敛一次。
- 启动自带端口占用检测与自动释放；`SIGINT` / `SIGTERM` 优雅关闭并关闭数据库。
- 静态资源托管、SPA 回退、`/favicon.ico` 映射品牌 logo。
- 三套开机自启：systemd、supervisord、Windows 任务计划 + VBS 静默启动（详见 `autostart/`）。

---

## v1.63 更新要点

| 类别 | 内容 |
|---|---|
| 评测历史（不拦截） | `POST/GET /api/eval/runs` 落库评测结果（用例/通过/L1 失败/平均分/提示词哈希），评测页显示最近 5 次；提交关联同版评测 `eval_run_id`，但 `eval_pass=1 / eval_score=5.0` 与导出门禁行为保持不变 |
| 只读授权升级 | 新表 `read_grants`：客户级（覆盖该客户后续新项目）或项目级 × 用户 / 团队 / 所有团队；旧 `project_grants` 自动迁入；公司/项目菜单均有「共享只读…」入口 |
| 回收站 | 项目 / 公司 / 知识条目 / 提交记录软删除，按批次恢复；保留 30 天自动清理；修复删除项目/公司遗留孤儿知识库与提交记录的问题 |
| 知识库分页 | `/api/kb/list` 支持 `page/page_size/q`；前端 50 条/页 + 服务端搜索；单文件上限 `KB_MAX_FILE_MB`（默认 20MB），超限返回 413 JSON |
| 用量/成本看板 | 新增 `llm_usage` 记录每次 LLM 调用的 token/耗时/用途/模型；系统管理「📊 用量看板」按模型/用户/天聚合；模型配置新增输入/输出单价（元/百万 token） |
| 所有权移交 | 项目菜单「👤 移交所有权…」，同步项目/知识库/提交记录归属；超管任意、团管限本团队 |
| 父级公司置顶 | 公司菜单「📌 置顶公司（全部内容）」：以公司名义进入置顶区并展示旗下全部项目，普通树中不再重复；按用户隔离，只读授权用户也可置顶可见公司 |
| 用户治理 | 超管可编辑用户角色与团队（团队管理员必须选团队，保存后强制重登）；有数据账号支持强制删除：数据移交超管或连同数据进回收站 |
| 顶部精简 | 顶部 6 个入口合并为 1 个「系统管理」齿轮菜单（用户与权限/备份/审计/快捷键/模型配置/退出）；删除功能导航与备份 JSON 快捷图标 |
| 编辑页精简 | 删除「应用模板」「恢复初始模板」入口与模板弹窗；新建项目弹窗「创建客户或行业」改为与「新增项目」一致的圆+图标按钮，文案统一 |
| 缺陷修复 | AI 润色缺少 `stripCodeFence` 导致 500；团管空团队越权；assign-team 隐式降级；上传 413；L1 中文数字误判；成本舍入；同路径 GET/POST 路由 405 |

> 升级提醒：首次以 v1.63 启动前先把 `data/newrock.db`（含 `-wal/-shm`）复制到 `data/backup-v1.63/`。迁移只新增表/列，不重建、不删除旧数据；启动前仍会自动做文件级快照。

---

## v1.62 更新要点

| 类别 | 内容 |
|---|---|
| 局域网访问（P0） | 新增 `LAN_ACCESS` 开关：默认仅本机，开启后监听 `0.0.0.0`；`Host/Origin` 白名单放行 RFC1918 私有网段与 IPv6 ULA/链路本地，仍拒绝任意域名（防 DNS rebinding）。启动日志打印局域网访问 URL |
| 功能级权限 | `app_settings.feature_matrix` 角色默认矩阵 + `users.feature_overrides` 个人三态覆盖；4 个功能组（提示词编辑 / 知识库 / 评测 / 提交记录）可独立关闭，关闭后前端隐藏入口且后端 403；超管永久全开 |
| 项目只读授权 | 新增 `project_grants`：管理员可把任意项目只读共享给指定用户，覆盖项目 + 知识库 + 提交记录；所有写接口 403；编辑者/超管不受影响 |
| 项目置顶 | 置顶改为服务端持久化（`project_pins`，每人一套），只置顶项目并显示所属公司；置顶项从下方树移除，不再重复 |
| 跨公司克隆 | 克隆弹窗可选目标公司与提交记录复制模式；修复 `structure_mode` 丢失；默认复制最新提交记录，克隆品可直接回滚到原提示词 |
| 个人 API Key | 模型中心新增「一键添加我的 Key」；首次保存自动激活；支持删除与设为当前；试用耗尽自动引导；普通用户不再看到超管专用的 `.env Key` 入口 |
| 账号治理 | `users.status / session_version / last_login_at`；管理员可启用/禁用、强制下线、重置密码、删除空账号；禁用或踢下线后旧会话立即 401 |
| 备份升级 | 备份分「业务数据 / 全量」两档；全量覆盖账号与权限；导入前全量安全备份；模型 Key 跨机恢复需同步 `data/.vault-key` |
| 自动备份与运维 | 启动前快照 + 每日在线备份 + 保留策略；`/api/health`；日志轮转（`autostart/rotate-logs.ps1`）；WAL 定期 checkpoint |
| 局域网安全 | 局域网模式默认关闭自助注册；新增登录失败限流（10 分钟 10 次）；会话密钥持久化到 `data/.session-secret`，Cookie 名统一为 `newrock.sid` |

> 升级提醒：首次以 v1.62 启动前先把 `data/newrock.db`（含 `-wal/-shm`）复制到 `data/backup-v1.62/`。本次迁移只新增表与列，不重建、不删除旧数据。

---

## v1.61 更新要点

| 类别 | 内容 |
|---|---|
| 知识库切片 | 新增 `lib/markdownChunker.js`：本地 Markdown 标题切块、1500 字双重熔断、表格感知分片 + 自然语言化 |
| 新增接口 | `POST /api/kb/parse-markdown`（本地切片，不调用大模型），与旧 `/api/kb/parse`（LLM 提取）并存 |
| 文档解析 | 新增 `POST /api/kb/extract-text`，支持 `.docx`（mammoth）、`.xls/.xlsx`（SheetJS）、`.pdf`（pdf-parse） |
| 前端渲染 | 引入 marked 9.1.6 + DOMPurify 3.0.6（bootcdn 国内源，`public/vendor/` 本地兜底），知识库卡片安全渲染 Markdown |
| 表格样式 | 表格外层限高并横向滚动、单元格 1px 灰边框、JSON 代码块深色底 |
| 端口/运维 | v1.61_update9：端口 3000 → 3100，新增 `autostart/`（systemd / supervisord / Windows），未改业务逻辑 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript（单文件 `public/index.html`，无框架）；marked + DOMPurify 做 Markdown 安全渲染 |
| 后端 | Node.js（ESM）+ Express 5 + express-session（内存会话） |
| 数据库 | SQLite（better-sqlite3）+ WAL 模式 |
| 文档解析 | mammoth（.docx）、xlsx（.xls/.xlsx）、pdf-parse（.pdf） |
| 其他依赖 | bcryptjs、archiver 8（`ZipArchive`）、cors、dotenv、p-limit |
| 运行环境 | Node.js 20+（实测 24.21），npm 10+；better-sqlite3 为原生模块，首次安装需可用的编译环境或预编译二进制 |

---

## 快速开始

### 环境要求

- Node.js 20 及以上（推荐 20 / 22 / 24 LTS），npm
- Windows / Linux / macOS 均可；本机 3100 端口未被占用

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 创建配置文件
cp .env.example .env
# Windows: copy .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY（没有真实 Key 时可先填占位值）

# 3. 启动服务
npm start
# 等价于 node server.js
```

启动后访问：

```
http://127.0.0.1:3100
```

首次启动会自动创建 `data/newrock.db`；如果检测到旧库 `data/prompt-studio.db`，会先整体改名迁移，旧数据不丢。

### 快速自检

```bash
node --check server.js
curl -I http://127.0.0.1:3100/login.html     # 期望 200
curl -I http://127.0.0.1:3100/               # 未登录 302 到登录页
```

---

## 目录结构

```
.
├── server.js                  # 主入口：路由、中间件、DB 初始化、LLM 路由、启动逻辑（约 2800 行）
├── package.json
├── .env.example               # 环境变量模板
├── lib/
│   └── markdownChunker.js     # v1.61 本地 Markdown 切片（标题切块 / 熔断 / 表格自然语言化）
├── public/
│   ├── index.html             # 主工作台（单文件，内嵌 CSS/HTML/JS）
│   ├── login.html             # 登录 / 注册 / 修改密码提示页
│   ├── logo.png
│   ├── vbs.ico
│   └── vendor/                # marked / DOMPurify 本地离线副本（CDN 失败时兜底）
├── data/                      # SQLite 数据库、备份与加密密钥（git 忽略）
│   ├── newrock.db             # 业务库（WAL：newrock.db-wal / -shm）
│   ├── .vault-key             # 模型 Key 加密主密钥（0600，迁移时务必保留）
│   ├── backup-v1.60/          # v1.60 结构迁移前的文件级备份
│   └── backup-before-import-*.json  # 每次备份导入前的安全快照
├── logs/                      # Windows 自启运行日志 service.log；Linux 脚本日志 newrock.log
├── autostart/                 # systemd / supervisord / Windows 任务计划 / 通用启动脚本
└── node_modules/
```

> `exports/`、`backups/` 为历史目录，当前版本不再默认创建。

---

## 配置说明

通过项目根目录的 `.env` 文件配置（参考 `.env.example`）：

```ini
PORT=3100
DEEPSEEK_API_KEY=sk-your_api_key_here
# 局域网访问（默认 false，仅监听 127.0.0.1）
LAN_ACCESS=false
# 局域网模式下是否保留自助注册（默认关闭）
ALLOW_SELF_REGISTER=
# 会话密钥（可选；留空自动生成并保存在 data/.session-secret）
SESSION_SECRET=
```

### 端口

- 默认端口 **3100**，刻意避开 DeepSeek Harness 的 3000 / 3080 以及 Docker 常用的 3079 / 3088。
- 实际优先级：**系统环境变量 `PORT` > `.env` 的 `PORT` > 代码默认值 3100**（`dotenv` 不会覆盖已存在的环境变量）。
- systemd / supervisord 配置里显式写了 `Environment=PORT=3100`，会覆盖 `.env`；改端口时两处要同步。
- Windows 启动脚本不再导出 `PORT`，只读取 `.env` 用于提示；因此改端口以 `.env` 为准。

### 局域网访问（v1.62）

1. 在 `.env` 设置 `LAN_ACCESS=true`，重启服务；启动日志会打印 `[server] [LAN] 局域网访问: http://192.168.x.x:3100`。
2. 以管理员身份运行 `autostart/open-lan-firewall.ps1` 放行 Windows 防火墙 TCP 3100（仅专用网络配置）；卸载用 `-Uninstall`。
3. 其他设备直接访问上面的局域网地址；`/api` 仍会校验 `Host` / `Origin`，只接受回环与私有网段，公网域名一律 403。
4. 局域网模式默认关闭自助注册，账号请在「系统管理 → 用户与团队」创建。
5. 局域网为 **HTTP 明文**，仅用于可信内网；不要做公网端口映射。会话仍是内存存储，重启需重新登录。

### API Key 与模型

- 系统级 `.env` Key 属于全局公共资产，仅超管可在「模型配置中心 → 快速设置 .env Key」查看掩码/修改。
- 普通用户可在模型配置中心保存自己的模型与 Key；Key 加密落库，页面只显示掩码。
- 普通用户没有私有 Key 时，会使用超管的激活模型并消耗一次试用额度（共 3 次）；请求失败会自动回滚额度。
- 自定义/第三方 Base URL 必须自带 API Key，禁止回退系统 `.env` Key。

---

## 数据与迁移

- **数据库文件**：`data/newrock.db`（WAL 模式，同时存在 `-wal` / `-shm`）。
- **备份目录**：启动前快照 `data/backups/startup/`（保留 5 份）；每日/手动在线备份 `data/backups/auto/`（保留 14 份）；导入前安全备份 `data/backup-before-import-*.json`。
- **旧库改名**：首次启动若只存在 `data/prompt-studio.db`，会自动改名为 `newrock.db`（含 WAL/SHM），失败则回退旧路径并打印错误。
- **启动迁移**（全部幂等，失败仅记录日志、不影响启动）：
  - `snapshots` 补 `eval_pass` / `eval_score` / `remark`；
  - `projects` 补 `context_json` / `is_public` / `public_scope` / `user_id`；
  - `model_configs` 补齐动态路由所需列；
  - 新建 `teams` / `users` / `audit_logs`，业务表补 `user_id`，旧数据归属超管；
  - 历史明文模型 Key 自动加密；
  - `prompt_templates` 三层合并为 `system_prompt` 并重建表（迁移前自动备份到 `data/backup-v1.60/`）。
- **备份范围**：全量 JSON 备份只覆盖 10 张业务表，**不含 `users` / `teams` / `audit_logs`**；导入只替换这 10 张表，账号与团队不受影响。
- **加密密钥**：`data/.vault-key` 丢失后，数据库中已加密的模型 Key 将无法解密，迁移/换机时请与数据库一并保留。

---

## 开机自启

`autostart/` 目录提供各平台开箱即用的方案，详细说明见 [`autostart/README-自启说明.md`](autostart/README-自启说明.md)。

| 环境 | 方案 | 权限 |
|---|---|---|
| Linux 服务器（systemd） | `install-systemd.sh` + `newrock.service` | sudo |
| 容器 / 无 systemd | `newrock-supervisor.conf`（supervisord）或 `start-newrock.sh bg` | 不需要 |
| Windows 本机 | 任务计划程序 + VBS 静默启动 | 管理员 |

### Windows：后台静默运行（无黑窗口）

1. 右键 `autostart/install-autostart-windows.bat` → **以管理员身份运行**；
2. 菜单选择：
   - `[1] Install autostart`：创建登录时触发的任务 `NewRockAIWorkbench`，通过 VBS 隐藏窗口后台运行；
   - `[2] Uninstall autostart`：删除任务并执行 `taskkill /f /im node.exe`（会结束本机所有 node 进程，有其他 node 服务时请手动处理）；
   - `[3] Exit`。
3. 运行日志写入 `logs/service.log`，不弹窗、不自动打开浏览器。
4. 若 `node` 不在系统 PATH，编辑 `autostart/start-newrock.bat` 的 `NODE_EXE` 为绝对路径。
5. 只想立即静默启动、不设自启：双击 `autostart/start-newrock-silent.vbs`；手动调试可双击 `start-newrock.bat`。

### Linux：systemd 一键安装

```bash
sudo bash autostart/install-systemd.sh
systemctl status newrock
journalctl -u newrock -f
sudo bash autostart/install-systemd.sh uninstall   # 取消自启
```

### 通用脚本（前台 / 后台 / 状态 / 停止）

```bash
bash autostart/start-newrock.sh        # 前台运行
bash autostart/start-newrock.sh bg     # 后台运行（logs/newrock.log、logs/newrock.pid）
bash autostart/start-newrock.sh status
bash autostart/start-newrock.sh stop
```

---

## 默认账号

- 用户名：`admin`
- 密码：`newrock123`
- **首次登录会提示修改密码**（可点“稍后再说”跳过，之后仍会继续提示）。
- 仅当 `users` 表为空时才会自动创建该账号；已有账号不会被覆盖。
- 管理员重置他人密码为 `123456`，并提示对方下次登录时修改（可“稍后再说”跳过）。

---

## API 概览

服务启动时注册 **78 条** `/api` 路由（启动日志会逐条打印）。主要分组：

| 分组 | 代表端点 |
|---|---|
| 鉴权 / 探活 | `POST /api/auth/login`、`/logout`、`/register`、`/change-password`；`GET /api/auth/me`、`/api/auth/config`、`/api/health` |
| 团队 / 用户 / 审计 | `GET /api/teams`、`POST /api/teams/create`、`GET /api/admin/users`、`POST /api/admin/users/create`、`/role`、`/features`、`/status`、`/kick`、`/delete`（支持 `force + data_mode`）、`/reset-password`、`/assign-team`、`GET /api/admin/features`、`POST /api/admin/features/matrix`、`GET /api/admin/backups`、`POST /api/admin/backups/run`、`GET /api/admin/audit-logs`、`GET /api/admin/usage/summary` |
| 语境（遗留） | `GET /api/context/get`、`POST /api/context/save`、`POST /api/context/extract` |
| 知识库 | `POST /api/kb/parse`、`/parse-markdown`、`/extract-text`、`/save`、`/update`、`/delete`；`GET /api/kb/list`、`/export` |
| 提示词 / 快照 | `POST /api/prompt/assemble`、`/api/snapshots/create`、`/delete`；`GET /api/snapshots/list`、`/detail`、`/api/gate/export` |
| 客户 / 项目 | `GET/POST /api/companies*`、`/api/projects*`、`POST /api/projects/clone`（支持 `target_company_id` / `copy_mode`）、`/api/projects/pin`、`GET /api/projects/grants`（客户级/项目级）、`POST /api/projects/grants/save`、`GET /api/projects/transfer/candidates`、`POST /api/projects/transfer`、`GET /api/projects/export_zip` |
| 评测 / 对话 | `POST /api/eval/run`、`/generate_questions`、`POST/GET /api/eval/runs`（评测历史）、`GET /api/eval/export`、`POST /api/chat/reply` |
| 回收站 | `GET /api/recycle/list`、`POST /api/recycle/restore`、`POST /api/recycle/purge` |
| 模型 / 设置 | `GET/POST /api/settings/api-key`、`GET /api/models`、`POST /api/models/save`、`/delete`、`/test` |
| 模板 / 润色 | `GET /api/templates`、`POST /api/templates/save`、`/delete`、`/extract`、`POST /api/ai/polish` |
| 备份 | `GET /api/backup/export`、`POST /api/backup/import` |

> `API_REFERENCE.md` 为精简版；完整路由、参数与返回结构以 `server.js` 与启动日志为准。

---

## 安全设计

- **最小暴露面**：默认只监听 `127.0.0.1`；`LAN_ACCESS=true` 时监听 `0.0.0.0`，但 `Host` / `Origin` 白名单只放行回环与 RFC1918 / IPv6 ULA / 链路本地，任意域名仍 403（防 DNS rebinding）。
- **会话保护**：`express-session` HttpOnly + SameSite=Lax Cookie（名 `newrock.sid`），未登录接口 401、页面 302；会话密钥来自 `SESSION_SECRET` 或持久化的 `data/.session-secret`，不再硬编码。
- **登录限流**：同一 IP + 账号 10 分钟内失败 10 次即 429；账号被禁用后无法登录，已登录会话立即失效。
- **密码安全**：bcrypt 哈希存储，不保存明文；登录/改密/重置均走统一校验。
- **数据隔离**：业务查询按 `user_id` + 角色过滤；公共项目只读；越权返回 403、不存在返回 404。
- **密钥加密**：模型 API Key 使用 AES-256-GCM 加密落库，`data/.vault-key` 权限 0600；前端只展示掩码，保存时留空或含 `*` 表示保持原值。
- **防 SSRF / Key 外泄**：非本机 Base URL 必须 HTTPS，禁止内网/链路本地地址；`.env` 真实 Key 只允许注入 `api.deepseek.com`。
- **防 XSS**：Markdown 先 `marked.parse` 再 `DOMPurify.sanitize`，失败降级纯文本；动态 HTML 统一 `escapeHtml`。
- **审计可追溯**：关键操作写 `audit_logs`，代管修改记 `Warn`，删除/备份导入记 `Danger`。
- **响应头**：`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`。

---

## 二次开发约定

1. **前端纯原生**：不引入 UI 框架；`public/vendor/` 只放离线副本，CDN 仅作加速与兜底。
2. **禁止 contenteditable**：编辑器依赖「底层 mirror div + 上层透明 textarea」；修改高度/滚动/赋值时必须同步 mirror（`refreshEditor` / `syncEditorHeight` / `syncEditorGutter` / `syncEditorScroll`），程序赋值要使用原生 `value` setter 并派发 `input` 事件。
3. **弹窗挂 body**：全屏弹窗/Portal 菜单必须挂在 `document.body`，避免被祖先 `overflow: hidden` 裁剪。
4. **SQL 必须带归属过滤**：所有业务查询带 `user_id` 或角色判断，新增接口同样遵守。
5. **数据变更先备份**：涉及表结构/迁移的改动，先在真实库上验证幂等与回滚。

---

## 已知限制

1. **发布门禁按产品决定保持不拦截**：`/api/snapshots/create` 仍写入 `eval_pass=1`、`eval_score=5.0`，`/api/gate/export` 继续放行；V1.63 的评测结果已落库并关联提交（`eval_run_id`），仅用于历史追溯，不参与提交/导出判断。
2. **变量/语境配置与模板库 UI 已移除**（2026-11-25）：前端不再有「插入变量」、语境卡片、变量高亮、模板应用入口；后端 `/api/context/*`、`/api/templates*` 与 `applyContextReplace` 仅保留兼容。
3. **全量备份中的模型 Key 依赖本机主密钥**：`model_configs.api_key` 由 `data/.vault-key` 加密；跨机恢复时需同时复制该文件，否则导入后这些 Key 无法解密（界面会提示，需重新填写）。
4. **会话为内存存储**：重启服务后需重新登录；禁用 / 踢下线 / 重置密码通过 `session_version` 立即失效。
5. **删除账号分两种**：无业务数据可直接删除；有数据时超管可选择强制删除（业务数据移交给当前超管 / 连同数据进回收站，30 天内可恢复）。
6. **回收站保留 30 天**：到期自动串行清理；彻底删除不可恢复。
7. **未做 HTTPS**：局域网仍为 HTTP 明文，仅用于可信内网。
8. **真实浏览器自动化受本机限制**：本机系统策略拒绝 Edge 的命名管道/IPC，改用 jsdom DOM 级回归（见 `QA_REPORT_v1.63.md`）；像素级 UI 仍需人工抽查。
9. **V1.64 候选**：真实发布门禁、可选 HTTPS、知识库自动分块、用量导出/告警、回收站保留期配置。

---

## 常见问题

**Q：启动提示端口已被占用？**
`server.js` 内置端口占用检测与自动释放，会打印占用进程 PID 并重试一次；若仍失败可手动处理：

```bash
# Linux / macOS
lsof -i tcp:3100 && kill -TERM <PID>
# Windows
netstat -ano | findstr :3100
taskkill /PID <PID> /F
```

**Q：修改 `.env` 端口后服务仍在旧端口？**
检查系统环境变量或 systemd/supervisord 配置里的 `PORT`，它们会覆盖 `.env`。

**Q：数据库在哪？旧库怎么办？**
当前库为 `data/newrock.db`。首次启动检测到 `data/prompt-studio.db` 时会自动改名迁移；迁移前还会在 `data/backup-v1.60/` 留文件级备份。

**Q：重启后要重新登录？**
会话使用 `express-session` 内存存储，不持久化；这是预期行为。

**Q：大模型报 401 / 无可用 Key？**
超管在「模型配置中心 → 快速设置 .env Key」配置系统 Key，或每人在模型配置中保存自己的 Key；普通用户 3 次试用用完后必须配置私有 Key。

**Q：导入备份会覆盖账号吗？**
分两种：导入「业务数据」备份只替换 10 张业务表，账号保持不变；导入「全量」备份会同时替换 `users` / `teams` / `audit_logs` / 权限表，导入后可能需要重新登录。

**Q：局域网内其他电脑打不开？**
1) 确认 `.env` 有 `LAN_ACCESS=true` 且已重启；2) 启动日志应出现 `[server] [LAN] 局域网访问: http://...`；3) 以管理员运行 `autostart/open-lan-firewall.ps1` 放行 3100；4) 用 `http://<本机局域网IP>:3100` 访问，不要用 `127.0.0.1`。若仍失败，检查是否处于「公用网络」配置文件或路由隔离。

**Q：忘记密码 / 账号被禁用怎么办？**
超管在「系统管理 → 用户与团队」重置密码为 `123456` 或启用账号；被禁用账号无法登录，启用后即可恢复。

**Q：置顶为什么换浏览器还在？**
v1.62 起置顶存储于数据库 `project_pins`，按用户独立保存，不再依赖 localStorage。

**Q：以前提示词里的 `{{变量}}` 现在怎么办？**
2026-11-25 起已移除「插入变量」与「语境配置」界面及前端高亮/提示，直接写具体内容即可。旧提示词中的 `{{industry}}` 等占位符若仍存在，服务端会按项目遗留 `context_json` 替换（为空时替换为「通用」）；如需完全保留字面量，请手动改为普通文本。

**Q：开机后服务没有自动启动？**
- systemd：`systemctl status newrock` 与 `journalctl -u newrock -n 50`（常见为 node 路径或目录权限问题）；
- Windows：任务计划程序查看 `NewRockAIWorkbench` 的上次运行结果，日志在 `logs/service.log`；
- 容器：确认 `pid 1` 是否为 systemd，否则改用 supervisord 方案。

---

## 相关文档

- [开机自启详细说明](autostart/README-自启说明.md)
- [API 参考（精简）](API_REFERENCE.md)
- [当前状态与交接说明](CURRENT_STATUS.md)
- [项目上下文与开发红线](PROJECT_CONTEXT.md)
- [v1.60 需求文档](v1.60_REQUIREMENTS.md)
- [v1.61_update9 端口与自启说明](UPDATE_v1.61_update9.md)
- [v1.62 更新说明](UPDATE_v1.62.md)
