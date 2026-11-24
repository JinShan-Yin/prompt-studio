# NewRock AI Workbench v1.62 更新说明

发布日期：2026-11-24
适用：v1.61（含 update9）→ v1.62

## 一、升级步骤

1. **先备份数据库**（服务停止状态下）：
   ```powershell
   New-Item -ItemType Directory -Force data\backup-v1.62 | Out-Null
   Copy-Item data\newrock.db,data\newrock.db-wal,data\newrock.db-shm data\backup-v1.62\ -ErrorAction SilentlyContinue
   ```
2. 覆盖代码（不要覆盖 `.env` 与 `data/`），在本地执行 `npm install`（严禁拷贝 `node_modules`）。
3. 按需修改 `.env`：
   ```ini
   LAN_ACCESS=true      # 需要局域网访问时才开；默认 false 仅本机
   ALLOW_SELF_REGISTER= # 局域网模式默认关闭自助注册
   ```
4. `npm start` 启动。启动日志应出现 `v1.62`、`已注册 API 路由: 68 条`、`[backup] 启动前数据库快照: ...`。
5. 需要局域网访问时，以管理员身份运行 `autostart/open-lan-firewall.ps1`，再用启动日志里的 `[LAN]` 地址访问。

> 本次迁移只新增表（`app_settings` / `project_grants` / `project_pins`）与用户列（`feature_overrides/status/session_version/last_login_at`），不重建、不删除旧数据；失败可还原第 1 步备份。

## 二、新增能力

- **局域网访问**：`LAN_ACCESS` 开关 + 私有网段 Host/Origin 白名单 + 防火墙脚本 + 启动打印局域网 URL。
- **功能级权限**：角色默认矩阵 + 个人三态覆盖；4 个功能组（提示词编辑 / 知识库 / 评测 / 快照）可独立关闭，关闭后前端隐藏且接口 403；超管永久全开。
- **项目只读授权**：管理员可把项目只读共享给指定用户（项目 + 知识库 + 快照），写操作全部 403。
- **项目置顶**：改为服务端持久化（每人一套），只置顶项目并显示公司名，置顶项从下方树移除。
- **跨公司克隆**：克隆弹窗可选目标公司与快照复制模式（仅最新 / 全部 / 不复制），修复知识库 `structure_mode` 丢失。
- **个人 API Key**：一键添加并启用、首次保存自动激活、删除与切换当前模型、试用耗尽引导；普通用户不再看到超管专用入口。
- **账号治理**：启用/禁用、强制下线、删除空账号、团队创建；禁用/踢下线/重置密码后旧会话立即失效。
- **备份两档**：业务数据 / 全量（含账号、团队、审计、权限）；导入前全量安全备份；校验至少 1 个可登录超管。
- **自动备份与运维**：启动前快照（保留 5）+ 每日在线备份（保留 14）+ `/api/health` + 日志轮转 + WAL checkpoint。
- **安全**：会话密钥持久化、Cookie 名统一 `newrock.sid`、登录失败限流、局域网模式默认关闭自助注册。

## 三、行为变化（升级需知）

1. 会话 Cookie 名由默认 `connect.sid` 改为 `newrock.sid`，且加了会话版本校验；升级后所有人需要重新登录一次。
2. `/api/models` 对超管返回的行新增 `owner_username`；普通用户仍只看到自己的模型。
3. 备份接口新增 `?scope=full`；不带参数仍导出「业务数据」，旧备份文件可继续导入。
4. Windows 启动脚本不再导出 `PORT`，只读取 `.env` 用于显示；改端口以 `.env` 为准。
5. 删除项目/公司会级联清理对应的只读授权与置顶记录。

## 四、已知边界

- 发布门禁仍是占位实现（`eval_pass=1` / `eval_score=5.0`），计划 V1.63 落地。
- 全量备份中的模型 Key 依赖 `data/.vault-key`；跨机恢复需同时复制该文件，否则需重新填写 Key。
- 局域网为 HTTP 明文，仅限可信内网，不要做公网端口映射。
- 会话仍为内存存储，重启需重新登录。

## 五、回滚

1. 停止服务。
2. 用 `data/backup-v1.62/` 中的 `newrock.db`（含 `-wal/-shm`）覆盖 `data/`。
3. 回退代码到 v1.61 后重启。
