# v1.61_update9 · 端口迁移 + 开机自启

本次只做端口与运维配置，**不改任何业务逻辑、不改前端 UI**。

## 一、本次变更（共 4 类）

| 文件 | 变更内容 |
|---|---|
| `server.js` | 仅 2 处：第 5 行注释改为 3100；第 41 行默认端口 `|| 3000` → `|| 3100` |
| `.env` | `PORT=3000` → `PORT=3100`（**此文件未打进 zip**，需你本地自行修改） |
| `.env.example` | `PORT=3000` → `PORT=3100` |
| `README.md` | 访问地址 3100；新增端口说明与自启指引 |
| `autostart/`（**新增目录，7 个文件**） | 开机自启方案：systemd / supervisord / 通用脚本 / Windows / 说明 |

### 刻意没有改的地方（重要）
`server.js` 里还有两处 `3000`，**与端口无关，保持原样**：

- `const EVAL_KB_MAX = 3000;` —— 评测知识库的**字数上限**
- `}, 3000).unref();` —— 服务关闭时的**3 秒超时**（毫秒）

把它们改成 3100 会直接改变业务行为，因此未动。

## 二、端口为什么是 3100

- DeepSeek Harness 核心 web 组件默认 **3000**
- `npx @deepseek-ai/dsh web` 官方默认 **3080**
- Docker 部署社区惯例建议避开 **3079 / 3088**

3100 与以上全部错开，且实测当前环境所有系统监听端口（80/443/5900/6080/8079/8081/8091/8118/9222/10000/10080/10900/10901/18080/18081/8080）均无占用。

## 三、如何更新你本地的文件

### 方式 A：整体替换（推荐，最不容易漏）
1. 备份你本地整个项目目录（尤其是 `data/` 数据库与 `.env`）。
2. 解压 `v1.61_update9.zip`，得到 `newrock-v1.60/`。
3. 把新目录覆盖到原位置，**注意保留你自己的 `data/`、`.env`、`node_modules/`**（zip 里不含这三样）。
4. 打开你本地的 `.env`，把 `PORT=3000` 改成 `PORT=3100`。
5. `npm install`（如果 node_modules 已存在可跳过），然后重启服务。

### 方式 B：最小改动（只动 4 处，适合不想整目录替换）
1. `server.js`：搜 `const PORT = Number(process.env.PORT) || 3000;`，把 `3000` 改成 `3100`。
   （注释那行改不改都行，不影响运行。）
2. `.env`：`PORT=3000` → `PORT=3100`。
3. `.env.example`：同上。
4. 把 zip 里的 `autostart/` 整个目录复制到你项目根目录下。
5. 重启服务。

> ⚠️ 无论哪种方式，都不要动 `EVAL_KB_MAX = 3000` 和 `}, 3000).unref();`。

### 更新后验证
```bash
# 停止旧服务，重新启动
node server.js           # 应打印 http://127.0.0.1:3100

# 另开一个终端验证
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login.html   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/            # 302（未登录跳转，正常）
```

浏览器访问 **http://127.0.0.1:3100**，账号 `admin` / `newrock123`（首次登录会提示改密）。

## 四、开机自启怎么装（按你的环境选一个）

详见 `autostart/README-自启说明.md`，速查：

| 你的环境 | 一条命令 |
|---|---|
| Linux 服务器（有 systemd） | `sudo bash autostart/install-systemd.sh` |
| 容器 / 云沙箱（无 systemd） | `supervisord -c autostart/newrock-supervisor.conf -d` |
| Windows 本机 | 管理员运行 `autostart/install-autostart-windows.bat` |
| 只想临时后台跑 | `bash autostart/start-newrock.sh bg` |

判断有没有 systemd：

```bash
systemctl is-system-running      # 输出 running 才有；输出 offline 或报错就是没有
```

## 五、回滚方法

把 `server.js` 的 `|| 3100` 改回 `|| 3000`、`.env` 改回 `PORT=3000`，重启即可。`autostart/` 目录直接删除不影响业务。

## 六、本次验证记录

- `node --check server.js` 通过
- 服务在 3100 启动成功，`/login.html` 返回 200，`/` 返回 302
- 3000 端口无监听（连接被拒绝）
- `autostart/start-newrock.sh` 全流程实测：bg 启动 → 健康检查 200 → 重复启动被拦截 → stop 正常 → 停止后 000
- zip 校验：28 个文件，`.env` 已排除、`.env.example` 与 `public/logo.png` 保留、`node_modules`/`data` 未打入；解压后 `node --check` 通过；11 个关键文件 md5 全部 MATCH；`*.sh` 可执行权限保留
