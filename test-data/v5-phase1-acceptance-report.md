# V5.0 阶段一（底层架构重构）验收报告

- 角色：系统架构师 / Lead 验收人
- 日期：2026-11-05
- 依据：`PRD-V5.0.md` + `TASK-Phase-1-Backend.md`
- 红线遵守：**`public/index.html` 零修改**（`git diff public/index.html` 为空），仅新增 `public/login.html`；`server.js` 为 V5 后端扩展。

## 一、四个步骤完成情况

### 步骤一：依赖安装与数据库平滑升级 ✅
- 安装依赖：`express-session`、`connect-sqlite3`、`bcryptjs`（`connect-sqlite3` 需要 `sqlite3` 运行时，已一并安装；`crypto` 使用 Node 内置模块）。
- `journal_mode = WAL` 已开启（业务库与 `sessions.db` 分离）。
- 新建表：`teams`、`users`、`audit_logs`；`users` 字段与任务要求一致（id/username/password_hash/role/team_id/need_change_password/trial_count/created_at）。
- 默认超管：`users` 为空时写入 `admin` / `newrock123`（bcrypt 10 轮哈希，`role=superadmin`，`need_change_password=1`）。
- 安全加列（全部幂等 + try/catch + PRAGMA 判断，重复启动不报错）：
  - `projects` / `prompt_templates`：`is_public INTEGER DEFAULT 0`、`public_scope TEXT DEFAULT 'private'`
  - `companies/projects/kb_items/kb_item_versions/snapshots/eval_runs/model_configs/modules/module_versions/prompt_templates`：`user_id TEXT`
- 旧数据迁移：全部业务表 `user_id` 为空记录归属 `admin`（`user-admin`）。
- **历史明文模型 Key 平滑加密迁移**（AES-256-GCM，`enc:v1:` 前缀，密钥文件 `data/.vault-key` 权限 600），迁移 2 条。
- 迁移前数据库在线备份：`data/backup-pre-v5-2026-11-05T04-06-19-481Z.db`（integrity ok）。

### 步骤二：Session 持久化与 Auth 拦截 ✅
- `express-session` + `connect-sqlite3` → **独立 `data/sessions.db`**（与业务库分离，防死锁）。
- Cookie：`httpOnly`、`sameSite=lax`、有效期 **2 小时**（rolling：每次操作刷新，无操作自动登出；实测 Expires≈7200s）。
- 鉴权中间件：`requireLogin` / `requireSuperAdmin` / `requireManager`（含数据所有权辅助）。
- 白名单严格：`/login.html`、`/api/auth/login`、`/api/auth/register`、`/api/auth/logout`、`/logo.png`、`/favicon.ico`；其余页面未登录 **302 → /login.html**，`/api/*` 未登录 **401 JSON**（不引起前端死循环）。
- 新增独立品牌登录页 `public/login.html`（NewRock Prompt Studio Logo / 手机号或邮箱正则校验 / 登录+注册 Tab / 默认密码改密提醒面板 / 原生 CSS 无外部依赖）。
- 鉴权接口：`/api/auth/register`、`/login`、`/logout`、`/me`、`/change-password`（额外）全部实测通过；注册自动登录。

### 步骤三：API Key 安全保存、脱敏与防并发扣减 ✅
- 模型 Key 存储 AES-256-GCM 加密；`GET /api/models` **解密后只回掩码**（保留末 4 位），永不返回完整 Key。
- `POST /api/models/save`：传入字符串含 `*` 视为“未修改”，**绝不覆盖数据库原加密 Key**（实测掩码回显一致）；空 Key + 非官方端点拒绝；单活仅作用于当前用户。
- 阶梯路由：
  1. 当前用户私有激活 Key → 直接使用（不消耗试用）；
  2. 无私有 Key → 超管公共激活模型 / 系统 `.env` Key → **原子扣减** `UPDATE users SET trial_count = trial_count + 1 WHERE id = ? AND trial_count < 3`，`changes===0` 直接 **403**；
  3. 大模型报错/超时 → `UPDATE users SET trial_count = trial_count - 1` 回滚补偿；超管不消耗试用。
- **并发实测**：新用户（无私钥）并发 5 次 `/api/eval/run` → **3 成功 / 2 × 403**，`trial_count=3`；公共模型换无效 Key 后请求失败，`trial_count` **回滚为 0**。

### 步骤四：数据隔离与越权拦截 + 审计 ✅
- 所有业务 GET（companies/projects/context/kb/snapshots/templates/models/gate/export/export_zip）按角色过滤：
  - `user`：`WHERE user_id = ?`
  - `teamadmin`：团队 owner ids 过滤（等价 JOIN users ON team_id）
  - `superadmin`：全量
- 写接口全部所有权校验（项目/公司/KB/快照/模板/克隆/模型），越权返回 403；创建自动写入 `user_id`；备份导出/导入仅超管。
- `logAction` 黑匣子审计：登录、注册、登出、改密、重置密码、项目/公司/KB/模板/模型/克隆/备份操作均落库 `audit_logs`。
- 团队与用户管理 API（阶段一支撑）：`/api/teams`、`/api/teams/create`、`/api/admin/users`、`/api/admin/users/reset-password`（→123456 + 强制改密）、`/api/admin/users/assign-team`、`/api/admin/audit-logs`。

## 二、真实测试结果（dsh-ego-browser + HTTP 实测）

| 测试 | 结果 |
|---|---|
| V5 基础链路（重定向/登录/旧数据/审计/sessions.db） | **11/11 PASS** |
| 强制自测（并发扣减 3/2、失败回滚、个人隔离、越权 403、团管隔离、审计） | **16/16 PASS** |
| 补充（重置 123456/首次登录提醒/自助改密/掩码不覆盖/迁移语境） | **9/9 PASS** |
| dsh-ego-browser：未登录访问 `/` → 302 登录页、品牌页渲染 | PASS（截图 `v5-01-login-redirect.png`） |
| dsh-ego-browser：admin 登录成功 → 默认密码改密提醒 → 跳过进入工作台 | PASS |
| dsh-ego-browser：登录后旧项目树（Trip/途牛）与 KB 97 正常、刷新不掉登录 | PASS（截图 `v5-02-tree-after-migration.png`） |
| dsh-ego-browser：退出登录后访问 `/` → 重定向 login.html | PASS |
| 会话有效期 | Expires ≈ 7200s（2 小时） |

**合计 36 条 HTTP 断言 + 7 条浏览器交互断言 = 43 项，全部通过。**

## 三、数据安全与修复说明（重要）

- 迁移前已有业务数据：3 个项目（GTP-V6接綫員 / Trip旅游AI接线员 / 途牛热线）、2 个客户/行业（Sam / 政府）、Trip 知识库 97 条、Trip 语境（旅游行业 / 售后退换货、停车缴费 / 安抚客户情绪、准确提供价格）。
- 迁移过程未删除任何旧表/旧数据；`PRAGMA integrity_check=ok`。
- **发现并修复了迁移前已存在的测试污染**（V4 QA 克隆/备份导入测试残留）：数据库内曾有 10 份孤儿 97 条 KB 副本、缺失的「途牛热线」项目行、Trip 副本项目、QA 测试账号/团队/模型。已用迁移前全量 JSON 备份佐证，并通过安全事务修复：
  - 恢复「途牛热线」项目（其 5 条历史快照原仍在库）；
  - 清理 1067 条孤儿 KB 副本与 36 条孤儿版本、删除 Trip 副本/团队测试项目与测试账号/团队/坏模型；
  - 最终业务数据：3 项目 / 2 客户 / KB 101 条 / 全部归属 admin；integrity ok。
  - 修复前后备份：`data/backup-pre-v5-*.db`、`data/backup-before-v5-repair-*.db`、`data/backup-before-import-*.json`。
- 登录页默认超管密码 `newrock123` 保持默认状态（首次登录有改密提醒），等待人类验收后自行修改。

## 四、已知限制 / 阶段二衔接

1. `public/index.html` 未做任何 UI 改造（按阶段一红线）；登录态由 Session 控制，顶栏暂无“退出/用户信息”入口，属阶段二 UI 范围。
2. `connect-sqlite3` 运行需要 `sqlite3` 依赖，已在 `package.json` 增加 `sqlite3`（其余新增依赖符合任务指定）。
3. 免费试用次数按“一次大模型请求”计；批量回归/评测每轮会消耗一次（阶段二可按业务粒度调整）。
4. 团队管理目前仅有后端 API，尚无前端管理界面（阶段二实现）。
5. 已重置为 123456 的账号会 `need_change_password=1`，登录页强制/提醒改密。

**结论：V5.0 阶段一底层架构重构完毕，四步骤全部实现并通过真实浏览器 + HTTP 并发/隔离/回滚验收，旧数据零丢失且已修复迁移前测试污染，可进入阶段二开发。**
