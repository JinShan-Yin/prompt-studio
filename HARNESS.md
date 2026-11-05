# Prompt Studio 开发上下文与规范（V3.0）

## 一、项目概述
本地单机运行的**提示词工程流水线工具**：管理分层提示词（L0/L1/L2/L3.5/L3）、知识库、多轮对话评测、自动化回归与发布门禁。

- **前端**：`public/index.html`（单文件，纯原生 HTML/CSS/JS，无任何外部框架/CDN，无 contenteditable）。
- **后端**：`server.js`（纯 Node.js + Express 5，单文件，SQLite / better-sqlite3）。
- **架构**：彻底独立，**无 Cordis / 无 plugins / 无 token 鉴权**；仅监听 `127.0.0.1:3000`。
- **启动**：根目录 `node server.js` 或双击 `启动.bat` → 浏览器打开 `http://127.0.0.1:3000`。

## 二、绝对红线
1. **禁止引入任何外部 UI 框架、CDN、第三方前端库**；样式/交互全部原生 CSS/JS，图标用内联 SVG。`public/` 下不得出现 Vue/React 等遗留文件。
2. 保持**一键启动链路**：`启动.bat` → `node server.js` → `127.0.0.1:3000`（无 token、无 3080/3081 旧代理）。
3. 前端所有 API 统一 `/api` 前缀（同源相对路径）；**禁止出现 `?token=`**。
4. 禁止 `alert()/confirm()`，统一复用 `#global-modal` 与 `showToast()`。
5. 变量高亮必须使用「底层镜像 div + 上层透明 textarea」双层架构，禁止 contenteditable。
6. 禁止破坏既有业务逻辑；改 UI 只允许 CSS 覆盖或明确的逻辑修复，必须跑回归脚本。

## 三、当前功能基线（V3.0）
- 左侧树：场景/项目两级，折叠、置顶、重命名、删除、新建、**实时搜索过滤**。
- 提示词编辑：Token 实时预估（`ceil(chars*0.6)`，50ms 防抖）、`{{变量}}` 橙色高亮 + 中文 tooltip、插入变量下拉、Token 4000 红线进度条（蓝/橙/红）、一键清理排版。
- 语境配置：行业 / 业务场景 / 核心目标，标签化多选，AI 智能提取，公共基座全局替换（支持 `$&` 等正则特殊字符原样保留）。
- 知识库：TXT 批量导入、FAQ 解析入库、实时搜索、冲突检测、在线编辑、删除。
- 评测中心：多轮对话模拟器、AI 生成刁钻测试题、批量回归（进度条/通过率/失败报告）、单轮语义评测。
- 历史快照：生成/回滚/行级 Diff（LCS，左红右绿）/详情/下载 TXT/批量导出 Zip。
- 模型配置中心（Header ⚙️）：多模型 CRUD、单活路由、测试连通性、Key 掩码不回显、`.env` 回退。
- 视觉：极简蓝调（品牌蓝 `#4d6bfe`）、16px 圆角卡片 + 柔和阴影、Header `backdrop-filter: blur(12px)`、6px 滚动条、Esc 分层关闭弹层。

## 四、多模型路由与安全红线
- `chatCompletion` 优先级：`model_configs` 中 `is_active=1`（rowid 最新）> `.env`（`DEEPSEEK_API_KEY` + `https://api.deepseek.com/v1` + `deepseek-chat`）。
- DB 模型请求失败 → 自动回落 `.env` 重试一次（脱敏日志）；无激活模型 → 直接 `.env`。
- `GET /api/models` 永不返回完整 `api_key`，只回 `has_key/masked_key`；`is_active` 为 1/0。
- **只有官方 `api.deepseek.com` 允许回退 `.env` Key**；自定义/第三方 `base_url` 必须显式 Key，否则拒绝（防 Key 外泄）。
- `base_url` 做 SSRF 校验：非本机必须 https；禁内网/链路本地地址；CORS 仅本机 Origin；`/api` 校验 Host 头（防 DNS rebinding）；响应头含 `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`nosniff`。
- `settings/api-key` 只回 masked；空值不写、非法 400、合法原子写 `.env` 并即时生效；错误不回显 Key。

## 五、测试与验收（全部真跑）
| 类别 | 命令/脚本 | 基线 |
|---|---|---|
| 后端静态 | `node test-data/server-selftest-sprint-v3.mjs` | 19/19 |
| 阶段一 API | `node test-data/server-smoke-v3.mjs` | 41/41 |
| 阶段二/四 API | `node test-data/server-smoke-v3-p24.mjs` | 36/36 |
| 模型/KB/出题 | `node test-data/e2e/v3-p2-http.mjs` | 17/17 |
| P1 安全 | `node test-data/e2e/v3-security-p1-check.mjs` | 14/14 |
| Host/CORS/头 | `node test-data/e2e/v3-host-security-check.mjs` | 11/11 |
| 浏览器终验 | `dsh-ego-browser` + `test-data/e2e/final-acceptance-browser.js` | 16/16 |
| 性能 | 同上 `final-acceptance-perf.js` | 4/4 |

## 六、数据、备份与回滚
- DB：`data/prompt-studio.db`（WAL，`integrity_check=ok`）；表：companies/projects(含 context_json)/kb_items/kb_item_versions/snapshots/modules/module_versions/model_configs/eval_runs。
- `.env` 存放真实 Key（不入库、不回显、不打印）。
- 重构前备份：`backup_dsh/`（含 `RESTORE.ps1` 与 SHA256 清单）；V3 各阶段 Git 安全屋见 `git log` 与 `.v3-checkpoints/`。
- 重启工具：`node scripts/restart-server.cjs`（自动释放 3000 端口后后台启动）。

## 七、测试数据
- 提示词与验证素材：`test-data/`（`prompts.md`、e2e 脚本与报告、截图）。
- 已知 P3：历史测试快照/模型行会累积（`snapshots` 约 40+、`model_configs` 十余条测试行），无删除 API，不影响业务；可在确认后手工清理 DB。

## 八、V5.0 阶段一：多租户与认证（当前权威）
- 运行方式不变：node server.js / 启动.bat → http://127.0.0.1:3000；未登录访问页面 302 → /login.html，未登录 API → 401 JSON。
- 账号：默认超管 admin / newrock123（bcrypt 10 轮；首次登录提醒改密）；支持手机号/邮箱注册；need_change_password=1 表示需改密；管理员可将他人密码重置为 123456。
- Session：express-session + connect-sqlite3，独立 data/sessions.db；Cookie 2 小时 rolling；白名单仅登录页/登录注册接口/logo，避免死循环。
- 新增依赖：express-session、connect-sqlite3、bcryptjs、sqlite3（connect-sqlite3 运行时依赖）。
- 多租户隔离：业务表含 user_id；GET 按角色过滤（user=本人；teamadmin=同团队；superadmin=全部），写接口校验所有权；companies/projects/prompt_templates 含 is_public/public_scope。
- 模型 Key：AES-256-GCM 加密（data/.vault-key），接口只回掩码；保存时 Key 含 * 严禁覆盖；私有 Key → 超管公共 Key/.env（原子扣 3 次试用，失败回滚）；超管不消耗试用。
- 审计：audit_logs 记录登录/注册/登出/改密/重置/删除/修改/克隆/备份等。
- 新增接口：/api/auth/{register,login,logout,me,change-password}、/api/teams、/api/teams/create、/api/admin/users、/api/admin/users/reset-password、/api/admin/users/assign-team、/api/admin/audit-logs。
- 验收证据：test-data/v5-phase1-acceptance-report.md、test-data/e2e/v5-phase1-*.json、截图 v5-01-login-redirect.png / v5-02-tree-after-migration.png。
- 数据安全：迁移前备份 data/backup-pre-v5-*.db；已修复迁移前测试污染，当前业务数据 3 项目（GTP/Trip/途牛）+ KB 101 条，全部归属 admin，integrity_check=ok。

## 九、V5.0 阶段二：前端 Tab 大改造（增量）
- 改造原则：对既有 public/index.html 增量改造，V4 卡片 DOM/ID/事件/函数全部保留；server.js 仅补公共参考项目只读可见 + 写保护。
- 右侧三层：Header（当前项目同侧栏选中样式 + 剩余试用 + 退出登录，删除“本地开发环境”）→ 四大 Tab（提示词编辑/知识库管理/智能体评测/历史快照，选中 #4d6bfe 2px 下划线）→ 内容区；未选项目空状态 + Tab 灰显。
- Tab1：Token 工具条上移；语境配置折叠面板；切回 Tab1 在 setTimeout(...,0) 内 refreshAllEditorMirrors → textarea autoHeight + mirror 同步 → syncEditorScroll，保留 mirrorDiv+textarea 双层高亮。
- Tab2：左右 7:3；Checkbox 全选/批量删除；批量删除必须串行 await（禁 Promise.all），全屏 Loading；切项目清空 selectedKbIds。
- Tab3：左对话模拟器 / 右批量评测数据双栏，保留聊天 auto-scroll；Tab4：全宽快照表 + Diff 弹窗（挂 body）。
- 公共项目：is_public 检测 → textarea readonly + 写按钮禁用 + window.isPublicProject=true + 全局 guardPublicProject() 拦截 + 徽标；后端非超管写 403。
- 树多选：Checkbox 包裹层 stopPropagation，不触发折叠；顶部操作条“已选中 X 项 [批量删除]”，串行删除。
- 文案：开启新项目弹窗/占位符改为“创建客户或行业”等；菜单名精简；Token 进度条顶部工具条。
- 测试：test-data/e2e/v5p2-*（A 13、B1 8、B2 5、Tabs 7、Empty 2、Public 后端 6、高亮/布局 3 = 44 项全过）；截图 v5p2-01~05；报告 test-data/v5-phase2-acceptance-report.md。
- 数据清理：测试夹具已删，最终 3 项目 / 2 客户 / KB 101 / 快照 62 / 仅 admin，integrity ok。
