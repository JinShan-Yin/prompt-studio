# NewRock AI Workbench · 开机自启说明

> 服务端口已从 **3000** 调整为 **3100**。
> 原因：DeepSeek Harness 的核心 web 组件默认用 3000，`dsh web` 官方命令默认用 3080，Docker 社区惯例建议避开 3079 / 3088。3100 与这些以及平台占用的端口（8080 / 8118 / 9222 / 10000 等）全部错开。

## 一、端口是怎么生效的

`server.js` 里的逻辑是：

```js
const PORT = Number(process.env.PORT) || 3100;
```

即优先级为：`.env` 的 `PORT` → 系统环境变量 `PORT` → 代码默认 3100。

- 想换端口：只改 `.env` 的 `PORT=xxxx`，**不需要改代码**。
- 自启配置文件里的 `PORT` 必须与 `.env` 保持一致（不一致时环境变量优先，容易排查困难）。

## 二、三种环境选一个

| 环境 | 用哪个文件 | 是否需要 root / 管理员 |
|---|---|---|
| Linux 服务器（有 systemd） | `install-systemd.sh` + `newrock.service` | 需要 sudo |
| 容器 / 云沙箱 / 无 systemd | `newrock-supervisor.conf`（supervisord）或 `start-newrock.sh bg` | 不需要 |
| Windows 本机 | `install-autostart-windows.bat` + `start-newrock.bat` | 需要管理员 |

---

### 方案 A：Linux + systemd（推荐，服务器用）

```bash
# 1. 进入项目根目录
cd /opt/newrock-ai-workbench

# 2. 一键安装（会自动替换路径、node 路径、端口，并做健康检查）
sudo bash autostart/install-systemd.sh

# 3. 验证
systemctl status newrock
curl -I http://127.0.0.1:3100/login.html     # 期望 200

# 4. 常用运维
journalctl -u newrock -f                      # 实时日志
sudo systemctl restart newrock                # 重启
sudo bash autostart/install-systemd.sh uninstall   # 取消自启
```

要点：
- 脚本会把 `newrock.service` 里的 `/opt/newrock-ai-workbench` 替换为**你项目的真实路径**，把 `/usr/bin/node` 替换为实际 node 路径。
- 若希望以降权用户运行，取消 `newrock.service` 里 `User=` / `Group=` 两行注释，并先把项目目录 `chown` 给该用户。

---

### 方案 B：容器 / 无 systemd 环境（supervisord）

有些云电脑、云沙箱里 `pid 1` 不是 systemd（`systemctl is-system-running` 返回 `offline`），装了 systemd 服务也不会在开机时拉起。这类环境用 supervisord：

```bash
# 情形 1：机器上已经有 supervisord 在跑
#   只把 newrock-supervisor.conf 里的 [program:newrock] 这一段追加进去，
#   不要复制 [supervisord] / [unix_http_server] 等段（段重复会报错）
sudo tee -a /etc/supervisord.conf < <(sed -n '/^\[program:newrock\]/,$p' autostart/newrock-supervisor.conf)
sudo mkdir -p /var/log/newrock
supervisorctl reread && supervisorctl update
supervisorctl status newrock

# 情形 2：没有 supervisord，用本配置独立起一个（整份文件包含必需的 [supervisord] 段）
mkdir -p /var/log/newrock
supervisord -c autostart/newrock-supervisor.conf -d
supervisorctl -c autostart/newrock-supervisor.conf status
```

部署前请修改 `newrock-supervisor.conf` 中的 `directory` 和 `command` 路径。

---

### 方案 C：Windows 本机

1. 双击 `autostart/start-newrock.bat` 可手动启动（会自动打开浏览器、缺依赖时自动 `npm install`）。
2. 设置开机自启：**右键 `autostart/install-autostart-windows.bat` → 以管理员身份运行**。
   - 原理：用任务计划程序创建登录时触发的任务（`onlogon` + 最高权限）。
   - 取消自启：管理员运行 `install-autostart-windows.bat uninstall`。
3. 若 `node` 不在 PATH，编辑 `start-newrock.bat` 里的 `set NODE_EXE=` 为绝对路径，如 `C:\Program Files\nodejs\node.exe`。

---

### 方案 D：只想临时后台跑（任意 Linux/macOS）

```bash
bash autostart/start-newrock.sh bg       # 后台启动（日志 logs/newrock.log，PID 写 logs/newrock.pid）
bash autostart/start-newrock.sh status   # 查看状态 + 健康检查
bash autostart/start-newrock.sh stop     # 停止
bash autostart/start-newrock.sh          # 前台运行，Ctrl+C 停止
```

> 注意：`bg` 方式只保证"本次运行不退出"，**不保证开机自动恢复**。要开机自启请用方案 A / B / C。

## 三、验证清单

```bash
# 1. 端口是否在监听（应只有 3100，不应再有 3000）
ss -tlnp | grep -E ':3100|:3000'

# 2. 页面是否正常
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login.html   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/             # 302（未登录跳转，正常）

# 3. 数据库是否可读写（服务启动日志里应无报错）
tail -30 logs/newrock.log 2>/dev/null || journalctl -u newrock -n 30 --no-pager
```

## 四、常见问题

**Q1：启动报"端口已被占用"**
`server.js` 自带自动释放逻辑（会打印占用 PID）。若仍失败，手动处理：

```bash
# Linux/macOS
lsof -i tcp:3100                     # 查占用进程
kill -TERM <PID>
# Windows
netstat -ano | findstr :3100
taskkill /PID <PID> /F
```

**Q2：改了 `.env` 端口但服务还在旧端口**
自启配置里如果写了 `Environment=PORT=xxx`，它会覆盖 `.env`。请同步修改 `newrock.service` 或 `newrock-supervisor.conf` 里的 PORT。

**Q3：开机后服务没起来**
- systemd：`systemctl status newrock` 看是否 `failed`，`journalctl -u newrock -n 50` 看原因（常见是 node 路径不对、项目目录权限不足）。
- Windows：任务计划程序里找 `NewRockAIWorkbench`，查看"上次运行结果"。
- 容器：确认 `pid 1` 是不是 systemd；不是的话必须用 supervisord 方案。

**Q4：会不会和其它 agent 冲突？**
不会。每个 agent 环境是独立的容器/网络空间；本服务只监听 `127.0.0.1:3100`（仅本机可访问，不对外暴露），且不修改任何系统级代理或路由配置。

## 五、文件清单

| 文件 | 用途 |
|---|---|
| `newrock.service` | systemd unit 模板 |
| `install-systemd.sh` | systemd 一键安装/卸载（自动替换路径与端口） |
| `newrock-supervisor.conf` | supervisord 配置片段 |
| `start-newrock.sh` | 通用启动脚本（前台 / 后台 / 状态 / 停止 / 健康检查） |
| `start-newrock.bat` | Windows 双击启动 |
| `install-autostart-windows.bat` | Windows 开机自启安装/卸载 |
| `README-自启说明.md` | 本文件 |
