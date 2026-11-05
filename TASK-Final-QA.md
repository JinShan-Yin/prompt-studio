# TASK: V5.0 终极 QA 与生产环境验收指令

**【角色定位】**：自动化测试工程师 (QA Bot) 兼安全渗透专家
**【当前任务】**：对 V5.0 系统进行全量 E2E 回归测试。你**必须**使用 `dsh-ego-browser` 进行真实 DOM 交互，并配合浏览器 Console 脚本断言和终端日志断言。严禁仅阅读代码或用 `curl` 替代！
**【纪律红线】**：在此阶段，**未经人类明确许可，严禁修改任何业务逻辑代码**。你的任务是找茬、验证和报告。

**⚠️ 【测试纪律与防作弊红线】**
1. **测试隔离**：所有测试脚本必须写在独立的临时文件或浏览器 Console 中。
2. **状态重置**：测试并发前，必须用 `admin` 重置测试用户的 `trial_count = 0`，清空其私有 Key，且确认 `admin` 有有效公共 Key。
3. **真实数据断言**：涉及安全拦截和并发测试，必须在测试后通过查询 SQLite 数据库获得真实数据，不接受口头“测试通过”。
4. **清理安全**：测试结束后的清理，严禁直接 `DELETE FROM users`。如果系统缺少删除 API，允许编写一次性的 SQL 脚本清理，但必须在报告中说明。
5. **清理留痕**：测试结束后，必须删除所有临时添加的 `console.log` 和测试脚本文件。如果测试中途报错，也必须确保清理代码被执行（使用 try...finally）。

请严格执行以下 6 个测试套件并出具真实数据报告：

### 套件一：V4.0 核心资产（双层高亮与快照）存活断言
1. **前置准备**：在 L0 输入超长文本（包含 50 个换行和 50 个 `{{变量}}`），确保出现垂直滚动条。
2. **高亮同步断言**：
   - 在 Console 执行 `document.querySelector('textarea').scrollTop = 150`。
   - **断言**：读取底层 `mirrorDiv` 的 `scrollTop`，断言必须等于 150（证明同步滚动机制未崩溃）。
3. **Tab 切换防坍塌断言**：
   - 切到 Tab 2，再切回 Tab 1。
   - **断言**：`textarea` 高度被重新撑开，光标与高亮无错位。
4. **导出链路**：点击生成快照，去 Tab 4 点击下载 TXT，断言返回 200 状态码。

### 套件二：多租户与数据绝对隔离（垂直越权）
1. **注册与创建**：注册用户 A，登录后创建项目。在 Console 执行 `fetch('/api/projects').then(r=>r.json())`，记录 A 的 `project_id`。
2. **彻底登出**：调用 `/api/auth/logout` 清除 A 的 Session。注册并登录用户 B。
3. **越权拦截断言**：
   - 用 B 的 Session 在 Console 执行 `fetch('/api/projects/A的项目ID', { method: 'DELETE' })`。
   - **断言**：HTTP 状态码必须为 403 或 404，且切回 `admin` 查库确认该数据未被删除。

### 套件三：API Key 阶梯与并发穿透防御
1. **前置准备与 Payload 构造**：
   - 用 `admin` 重置用户 C 的 `trial_count = 0`。
   - **直接阅读 `server.js` 中 `/api/eval/run` 的源码**，弄清它需要的 JSON 参数格式，手动构造一个合法的 Payload。
2. **并发白嫖真实断言**：
   - 在 Console 执行：`Promise.all(Array(5).fill().map(() => fetch('/api/eval/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(构造的Payload) })))`。
   - **断言（核心）**：等待请求全部完成后，运行后端脚本查询 `SELECT trial_count FROM users WHERE username='C'`，断言该值必须精确等于 **3**。
3. **Key 脱敏断言**：用户 C 配置真实 Key 后，刷新页面，读取设置输入框的 `value`，断言必须包含 `*` 号。

### 套件四：公共项目只读与“抓包绕过”防御
1. **获取目标 ID**：**直接通过 SQLite 脚本查询** `SELECT id FROM projects WHERE public_scope = 'global' LIMIT 1`，记录该公共项目 ID。
2. **UI 级只读断言**：普通用户进入该项目，断言 `textarea.readOnly === true`，保存按钮有 `disabled` 属性。
3. **API 级绕过防御（硬核）**：
   - 普通用户在 Console 执行：`fetch('/api/snapshots/create', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project_id: '查到的公共ID' }) })`。
   - **断言**：后端必须返回 403，提示“无权修改公共项目”。

### 套件五：黑匣子日志与深拷贝完整性
1. **代管日志断言**：超管 `admin` 进入用户 A 的项目修改并保存。去日志面板断言出现一条 `Warn` 级别日志。
2. **深拷贝主键隔离断言**：用户 A 克隆一个自带 3 条知识库的项目。断言新项目知识库也是 3 条。在 Tab 2 中删除新项目的一条知识库，断言原项目的数据依然为 3 条。

### 套件六：知识库批量管理的“串行删除”验证
1. **临时插桩（try...finally 保护）**：
   - 在 `server.js` 的“单条删除知识库 API”中加入：`console.log('正在删除 ID:', id);`。
2. **前端触发**：勾选 5 条知识库，点击批量删除。
3. **断言**：观察后端终端日志，这 5 条 `console.log` 必须是**按顺序、逐条打印**的。
4. **绝对清理**：无论测试成功与否，必须立即删除刚加入的 `console.log`。

📋 【交付报告要求】
全部跑通后，请出具《V5.0 终极 QA 报告》，必须包含：
1. 6 个套件的测试结果（PASS / FAIL 及具体数据）。
2. 给出“并发白嫖”（查库的 trial_count）和“API绕过拦截”（返回的 403 JSON）的真实数据。
3. 说明你是如何清理测试数据以及是否已完全恢复被临时插桩的代码。
4. 明确回复：“V5.0 生产环境终极验收通过，V4.0 核心功能 100% 存活，代码健康度 100%，可正式上线。”