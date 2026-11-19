# NewRock AI Workbench (v1.60)

## 项目简介
NewRock AI Workbench 是一个企业级多租户提示词协作与资产管理平台。用于管理 AI 智能体的提示词、知识库、多模型路由与自动化评测。

## 技术栈
- **前端**：100% 纯原生 HTML/CSS/JavaScript
- **后端**：Node.js + Express + Express-Session
- **数据库**：SQLite (better-sqlite3) + WAL 模式

## 启动与运行指南
### 云端 Linux 环境（当前环境）
1. 确保具备 C++ 编译环境。
2. 安装依赖：`npm install`
3. 启动服务：`node server.js` (若需后台常驻：`nohup node server.js > console.log 2>&1 &`)
4. 访问地址：`http://127.0.0.1:3100`

### 端口说明（重要）
服务默认端口为 **3100**（刻意避开 DeepSeek Harness 的 3000 / `dsh web` 的 3080、以及 Docker 惯用的 3079 / 3088）。
生效优先级：`.env` 的 `PORT` > 环境变量 `PORT` > 代码默认值 3100。改端口只需改 `.env` 的 `PORT=xxxx`。

### 开机自启（推荐）
`autostart/` 目录已提供开箱即用的自启配置，详见 `autostart/README-自启说明.md`：
- **Linux（systemd）**：`newrock.service`，两条命令完成安装
- **Linux / macOS（supervisord）**：`newrock-supervisor.conf`
- **Windows**：`start-newrock.bat` 双击启动 + 任务计划程序设置开机自启

### 快速自检
```bash
curl -I http://127.0.0.1:3100/login.html   # 期望返回 200
```

## 默认账号
- **超级管理员**：`admin`
- **默认密码**：`newrock123`（首次登录强制修改）

## ⚠️ 平台兼容性红线
根目录下的 `*.vbs` 和 `*.bat` 脚本仅限 Windows 本地使用。在当前 Linux 云电脑环境中，**严禁执行这些 Windows 脚本**。