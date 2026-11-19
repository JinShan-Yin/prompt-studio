# NewRock AI Workbench

企业级、多租户的**提示词协作与 AI 资产管理平台**。基于纯 Node.js + 原生前端构建，用于集中管理 AI 智能体的提示词、知识库、多模型路由、历史快照与自动化评测，数据通过 SQLite 本地存储，仅监听本机回环地址，适合团队内网或个人本地部署。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [配置说明](#配置说明)
- [开机自启](#开机自启)
- [默认账号](#默认账号)
- [API 概览](#api-概览)
- [安全设计](#安全设计)
- [常见问题](#常见问题)
- [相关文档](#相关文档)

---

## 功能特性

- **多租户与权限**：团队（Team）隔离、基于角色的访问控制、管理员用户管理、完整审计日志。
- **提示词管理**：项目化组织提示词、模板库、提示词一键组装、版本备注与克隆。
- **知识库**：支持 TXT / Markdown / PDF / DOCX / XLSX 多格式解析，Markdown 智能分块、Q&A 提取，知识库增删改查与导入导出。
- **历史快照**：版本快照创建、列表、详情、对比与删除，支持批量操作与跨页勾选。
- **多模型路由**：模型配置、API Key 加密存储、连通性测试、活跃模型一键切换，支持 `.env` 与私有模型多级回落。
- **自动化评测**：自动生成测试问题、评测运行、结果报告与导出，支持 Bad Case 联动。
- **AI 对话与润色**：内置对话调试入口与 AI 文本润色。
- **备份与迁移**：一键备份 / 恢复、项目克隆、整库导出 ZIP，数据库升级自动平滑迁移、不破坏旧数据。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript（无框架），marked + DOMPurify 做 Markdown 安全渲染 |
| 后端 | Node.js（ESM）+ Express 5 + Express-Session |
| 数据库 | SQLite（better-sqlite3）+ WAL 模式 |
| 关键依赖 | bcryptjs、archiver、cheerio、mammoth、pdf-parse、xlsx、p-limit、dotenv、cors |

## 快速开始

### 环境要求

- Node.js 18 及以上（推荐 20 / 22 LTS），npm
-  better-sqlite3 为原生模块，首次安装需要可用的 C++ 编译环境（多数平台提供预编译二进制）

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 创建配置文件
cp .env.example .env
#   编辑 .env，填入 DEEPSEEK_API_KEY（无真实 Key 时可先填占位值）

# 3. 启动服务
npm start
#   等价于 node server.js
```

启动后访问：

```
http://127.0.0.1:3100
```

### 快速自检

```bash
curl -I http://127.0.0.1:3100/login.html     # 期望返回 200
```

## 目录结构

```
.
├── server.js              # 应用主入口（路由、中间件、启动逻辑）
├── package.json
├── .env.example           # 环境变量模板
├── public/                # 前端静态资源
│   ├── index.html         # 主工作台
│   ├── login.html         # 登录页
│   ├── logo.png
│   └── vendor/            # marked / DOMPurify 本地副本（离线可用）
├── lib/
│   └── markdownChunker.js # Markdown 本地切片算法
├── data/                  # SQLite 数据库（git 忽略）
├── logs/                  # 运行日志（git 忽略）
├── backups/               # 备份目录（git 忽略）
└── autostart/             # 各平台开机自启配置
```

## 配置说明

通过项目根目录的 `.env` 文件配置（参考 `.env.example`）：

```ini
PORT=3100
DEEPSEEK_API_KEY=sk-your_api_key_here
```

### 端口

- 默认端口 **3100**，刻意避开 DeepSeek Harness 的 3000 / 3080 以及 Docker 常用的 3079 / 3088。
- 生效优先级：`.env` 的 `PORT`  >  系统环境变量 `PORT`  >  代码默认值 3100。
- 更换端口只需修改 `.env`，无需改动代码。

## 开机自启

`autostart/` 目录提供各平台开箱即用的方案，详细说明见 [`autostart/README-自启说明.md`](autostart/README-自启说明.md)。

| 环境 | 方案 | 权限 |
|---|---|---|
| Linux 服务器（systemd） | `install-systemd.sh` + `newrock.service` | sudo |
| 容器 / 无 systemd | `newrock-supervisor.conf`（supervisord）或 `start-newrock.sh bg` | 不需要 |
| Windows 本机 | 任务计划程序 + VBS 静默启动 | 管理员 |

### Windows：后台静默运行（无黑窗口）

1. 右键 `autostart/install-autostart-windows.bat` → **以管理员身份运行**；
2. 在数字菜单中选择：
   - `[1] Install autostart`：安装开机自启（登录时通过 VBS 隐藏窗口后台运行）；
   - `[2] Uninstall autostart`：取消自启并停止服务；
   - `[3] Exit`：退出。
3. 服务在后台静默运行、不弹窗、不自动打开浏览器，运行日志写入 `logs/service.log`。
4. 若 `node` 不在系统 PATH，编辑 `start-newrock.bat` 中的 `NODE_EXE` 为绝对路径，例如 `C:\Program Files\nodejs\node.exe`。

> 手动调试（带窗口、可看实时输出）可双击 `autostart/start-newrock.bat`；
> 只想立即静默启动而不设置开机自启，可双击 `autostart/start-newrock-silent.vbs`。

### Linux：systemd 一键安装

```bash
sudo bash autostart/install-systemd.sh
systemctl status newrock
journalctl -u newrock -f                       # 实时日志
sudo bash autostart/install-systemd.sh uninstall   # 取消自启
```

## 默认账号

- 用户名：`admin`
- 密码：`newrock123`
- **首次登录强制修改密码**。

## API 概览

服务启动时注册 53 条 API 路由，主要分组：

| 分组 | 代表端点 |
|---|---|
| 鉴权 | `POST /api/auth/login`、`/logout`、`GET /api/auth/me`、`POST /api/auth/change-password` |
| 团队 / 用户 | `GET /api/teams`、`GET /api/admin/users`、`POST /api/admin/users/assign-team` |
| 项目 | `GET /api/projects`、`POST /api/projects/create`、`/clone`、`GET /api/projects/export_zip` |
| 快照 | `POST /api/snapshots/create`、`GET /api/snapshots/list`、`/detail` |
| 知识库 | `POST /api/kb/parse`、`/save`、`GET /api/kb/list` |
| 模型 | `GET /api/models`、`POST /api/models/save`、`/test` |
| 评测 | `POST /api/eval/run`、`/generate_questions`、`GET /api/eval/export` |
| 系统 | `POST /api/chat/reply`、`/api/ai/polish`、`GET|POST /api/settings/api-key`、`/api/backup/export` |

完整说明见 [`API_REFERENCE.md`](API_REFERENCE.md)。

## 安全设计

- **数据隔离**：多租户基于团队与 `user_id` 做行级隔离，角色控制可访问范围。
- **密码安全**：使用 bcrypt 哈希存储，不保存明文。
- **会话保护**：HttpOnly 会话 Cookie，未登录访问受保护接口返回 401。
- **密钥加密**：模型 API Key 加密后落库，迁移时自动加密旧数据。
- **防 XSS**：Markdown 经 DOMPurify 净化后再渲染，默认关闭危险内容。
- **审计可追溯**：关键操作写入审计日志。
- **最小暴露面**：仅监听 `127.0.0.1:3100`，不对外网暴露，且不修改任何系统级代理或路由配置。

## 常见问题

**Q：启动提示端口已被占用？**
`server.js` 内置端口占用自动释放逻辑并打印占用进程 PID；若仍失败，可手动处理：

```bash
# Linux / macOS
lsof -i tcp:3100 && kill -TERM <PID>
# Windows
netstat -ano | findstr :3100
taskkill /PID <PID> /F
```

**Q：修改 `.env` 端口后服务仍在旧端口？**
若自启配置（systemd / supervisord）中显式设置了 `PORT`，它会覆盖 `.env`，请同步修改对应配置。

**Q：开机后服务没有自动启动？**
- systemd：`systemctl status newrock` 与 `journalctl -u newrock -n 50` 排查（常见为 node 路径或目录权限问题）；
- Windows：在任务计划程序中查看 `NewRockAIWorkbench` 的上次运行结果；
- 容器：确认 `pid 1` 是否为 systemd，否则需使用 supervisord 方案。

**Q：会与其他 agent / 服务冲突吗？**
不会。运行环境相互独立，服务仅监听本机回环地址，且端口已与常见组件错开。

## 相关文档

- [开机自启详细说明](autostart/README-自启说明.md)
- [API 参考](API_REFERENCE.md)
- [当前状态与交接说明](CURRENT_STATUS.md)
- [项目上下文](PROJECT_CONTEXT.md)
- [v1.60 需求文档](v1.60_REQUIREMENTS.md)
