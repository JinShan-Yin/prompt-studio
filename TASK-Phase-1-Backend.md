# TASK: V5.0 阶段一 - 底层架构重构开发指令

**【角色定位】**：系统架构师兼全栈安全专家
**【当前任务】**：请严格根据 `PRD-V5.0.md` 进行底层重构。**⚠️ 绝对红线：本轮严禁修改 `public/index.html` 中的任何布局，仅允许新增独立的 `login.html`。**

**【🛠️ 强制插件协同策略（必须遵守）】**
1. 先使用 `dsh-openwolf` 建立上下文。
2. 所有涉及 `ALTER TABLE` 和新增逻辑的修改，必须配合 `change-review` 在修改前存档。
3. 重构完毕后，**必须**使用 `dsh-ego-browser` 打开真实浏览器测试登录与数据隔离，不要只写代码不验证。

### 步骤一：依赖安装与数据库平滑升级（极其重要）
1. 安装依赖：`npm install express-session connect-sqlite3 bcryptjs`（**注意：`crypto` 是 Node 内置模块，不要用 npm 安装**）。
2. 开启 WAL 模式：`db.pragma('journal_mode = WAL')`。
3. **严格按顺序升级数据库**：
   - 新建 `teams` 表：`id TEXT PRIMARY KEY, name TEXT, created_at TEXT`。
   - 新建 `users` 表：`id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, team_id TEXT, need_change_password INTEGER, trial_count INTEGER DEFAULT 0, created_at TEXT`。
   - **插入默认超管**：检查 `users` 表，若为空，写入 `admin` / `newrock123` 哈希，角色为 `superadmin`。
   - **安全加列**：给 `projects`、`prompt_templates` 添加 `is_public INTEGER DEFAULT 0` 和 `public_scope TEXT DEFAULT 'private'`；给所有业务表（含 `snapshots`、`kb_items`、`model_configs`）添加 `user_id TEXT`。
   - **⚠️ 防崩溃加列**：必须用 `try...catch` 包裹 `ALTER TABLE`，或者通过查询 `PRAGMA table_info` 判断字段是否已存在，防止重复添加报错退出。
   - **旧数据迁移**：将上述表中 `user_id` 为空的记录，全部 `UPDATE` 为 `admin` 的 ID。

### 步骤二：Session 持久化与 Auth 拦截
1. 配置 `express-session`，存储库使用 `connect-sqlite3`，**但必须指向一个独立的 `sessions.db` 文件**（防止与业务库死锁）。配置 Cookie `maxAge` 为 2 小时。
2. 编写鉴权中间件：`requireLogin` 和 `requireAdmin`。
3. **路由拦截与白名单（防死循环）**：
   - 新建 `public/login.html`。
   - 在 `server.js` 中拦截：当未登录用户访问除 `/login.html`、`/api/auth/login`、`/api/auth/register` 以及静态资源（css/js/logo）以外的路径时，302 重定向到 `login.html`。**（⚠️ 必须严格配置白名单，否则 `login.html` 和 css 自身也会被拦截，导致死循环崩溃！）**
4. 提供鉴权接口：`/api/auth/register`、`/api/auth/login`、`/api/auth/logout`、`/api/auth/me`。

### 步骤三：API Key 安全保存、脱敏与防并发扣减（核心难点）
1. **Key 脱敏与防覆盖**：
   - 查询 `/api/models` 时，后端解密，保留末尾 4 位，其余替换为 `*`。
   - 保存 Key 时（`/api/models/save`）：**⚠️ 后端必须检查传入的 API Key**。如果字符串中包含 `*`，说明用户没修改，**严禁覆盖数据库中的原有加密 Key**；否则会存进假的星号。
2. **防穿透阶梯扣减逻辑（极其重要）**：
   - 先查当前用户的私有 Key；若没有，查超管的公共 Key。
   - 若使用公共 Key：必须先查当前用户的 `trial_count`。
   - **⚠️ 防并发白嫖**：查完之后立刻执行 `UPDATE users SET trial_count = trial_count + 1 WHERE id = ? AND trial_count < 3`。如果 `changes === 0`（说明并发已经被抢光了），直接 403 抛错。
   - 发起大模型请求。**若大模型报错或网络超时，必须执行回滚补偿**：`UPDATE users SET trial_count = trial_count - 1 WHERE id = ?`。
   - 若 `trial_count >= 3`，抛错 403 阻断。

### 步骤四：数据隔离与越权拦截
1. 所有业务表（项目、快照、知识库等）的 `GET` 列表接口，必须根据角色走不同 SQL：
   - **个人 (user)**：`WHERE user_id = ?`
   - **团管 (teamadmin)**：**连表查询** `JOIN users ON projects.user_id = users.id WHERE users.team_id = ?`
   - **超管 (superadmin)**：无条件全表查询。
2. 编写 `logAction` 辅助函数，在登录、删除、修改、代管等关键路由中写入 `audit_logs` 表。

### ⚠️ 强制自测与交付
请务必使用 `dsh-ego-browser` 完成以下验收：
1. 旧数据是否平滑归属给 `admin`？用账号登录后旧项目还在不在？
2. 注册一个新用户（不配 Key），并发发起 5 次评测请求，确认是否只有 3 次成功，剩下 2 次被 403 拦截？且超时失败后次数是否自动回滚？
3. 刷新页面，确认是否被成功重定向到 `login.html`。

自测全部通过后，向我汇报：“V5.0 阶段一底层架构重构完毕，请人类验收”。