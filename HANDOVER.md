# NewRock AI Workbench · 移交记录（给新窗口）

> 生成时间：2026-11-25 22:20（Asia/Shanghai）
> 工作区：`D:\prompt-studio`
> 交接对象：下一个接管本项目的 Agent 窗口
> 原则：**先读本文件 + `Readme.md` + DSH 工作区记忆；再动代码。**

---

## 0. 一句话现状

项目是 **NewRock AI Workbench v1.65.1**，单机 Node.js + Express 5 + SQLite，生产服务跑在 `http://127.0.0.1:3100`（LAN 模式）。V1.65.1 已完成并通过冒烟 142/142 + 页面全按钮回归 139/139（事件处理函数 113 个）；路由 84 条。备份策略不变（每日 10:00 / 保留 7 份 / 启动前快照关闭）。

> 生产 3100 自 2026-11-26 20:33 起由桌面双击 `autostart/start-newrock-silent.vbs` 拉起的**持久进程**提供，与会话解耦；v1.65.1 的静态改动 Ctrl+F5 即生效，`/api/health` 版本号需重启（再次双击同一个 vbs，端口自愈会替换旧实例）后才变为 `1.65.1`。

---

## 1. 接手前必须知道的 6 件事

1. **生产服务不要随意重启**：3100 若以**管理员权限**运行，普通 shell 的 `taskkill` 会报「拒绝访问」；UAC 提权重启（`autostart\restart-newrock-elevated.bat` 或管理员 PowerShell 跑 `restart-newrock.ps1`）可用，但**提权 PowerShell 退出后其子进程可能被连带终止**（2026-11-26 20:27 实测如此），所以重启后必须复核 `/api/health`，掉线就重新拉起。**重启的正确顺序**（2026-11-26 21:46 实测）：只双击 `autostart\start-newrock-silent.vbs` **不会**替换已在跑的实例——旧进程占着 3100，新进程静默退出且 `logs/service.log` 不出现新 banner（曾因此「以为重启了」却仍是旧版本 70 分钟）。可靠做法：① `cmd /c "netstat -ano | findstr :3100"` 找监听 PID → `Stop-Process -Id <PID> -Force`；② `wscript.exe autostart\start-newrock-silent.vbs`；③ 轮询 `/api/health` 确认版本变化。wscript 拉起的 node 会脱离当前 shell（跨工具调用存活），无需 UAC；`restart-newrock-elevated.bat` 仍可用但其子进程可能随提权窗口退出被连带终止。前端静态改动 Ctrl+F5；`server.js` 改动必须重启。日志写入 `logs/service.log` / `logs/restart-elevated.log`。
2. **生产库是 `data/newrock.db`**，禁止用于测试。V1.63.1 起**启动前快照默认关闭**；如需在结构迁移前备份，先手动「立即备份」，或临时设 `BACKUP_STARTUP_ENABLED=true`。
3. **QA 必须隔离**：端口 3101 + `NEWROCK_DATA_DIR=.qa-test/data`；测试结束停进程并清理。生产库当前为 4 用户、2 模型配置、2 公司、3 项目、43 知识条目、3 提交（未被本轮测试触碰）。
4. **Git**：本轮改动以 `git status -sb` 为准；提交前确认。**不要提交** `.env`、`data/`、`logs/`、`.session-headers.jsonl`、`.qa-test/`。
5. **浏览器自动化受本机限制**：Edge 在本机因命名管道/mojo 被系统拒绝而无法启动（即使完全访问权限），真实浏览器 E2E 跑不了；本轮改用 jsdom DOM 级回归（见 §6）。
6. **门禁策略按产品决定保持现状**：`/api/snapshots/create` 仍写死 `eval_pass=1 / eval_score=5.0`，`/api/gate/export` 仍放行；评测结果只落库做历史，不拦截提交/导出。

> 数据状态（2026-11-26 03:00）：生产已有真实业务数据（见上一行）；V1.64 改动前备份：`data/backups/manual/pre-v1.64-20261126_0245.db`（含 -wal/-shm）。

---

## 2. 版本与运行信息

| 项 | 值 |
|---|---|
| 版本 | `1.65.1`（package.json / 启动日志 / `/api/health`） |
| 入口 | `server.js`（约 5.2k 行） |
| 前端 | `public/index.html`（约 7.2k 行，单文件原生 HTML/CSS/JS） |
| 数据库 | `data/newrock.db`（SQLite + WAL） |
| 主密钥 / 会话密钥 | `data/.vault-key` / `data/.session-secret` |
| 路由数 | **84 条** `/api` |
| 生产 URL | http://127.0.0.1:3100 |
| 冒烟 | `node scripts/smoke-v1.65.mjs`（142 项，临时目录，零依赖） |
| 页面回归 | `.qa-test\run-dom.ps1`（jsdom，139 项；依赖已装在 `.qa-test`，仓库依赖未变） |
| 文案守卫 | `node scripts/qa-wording.mjs`（白名单外不得出现「快照」） |

启动：

```powershell
cd D:\prompt-studio
npm start        # = node server.js
curl.exe -s http://127.0.0.1:3100/api/health
# 期望 version=1.65.1 / db_ok / mode=lan
```

> 不要改这两个「3000」：`EVAL_KB_MAX=3000`、关闭超时 `3000`。

---

## 3. V1.63 改了什么

### 3.1 顶部与编辑页（产品要求）

- 顶部 6 个入口合并为 1 个「系统管理」齿轮菜单：用户与权限 / 备份 / 审计日志（黑匣子）/ 快捷键面板 / 模型配置中心 / 退出登录；按角色显示条目。
- 删除「功能导航」下拉、顶部「导出/导入备份 JSON」快捷图标；备份能力保留在系统管理「备份与运维」tab。
- 删除「应用模板」「恢复初始模板」、模板应用弹窗与相关 JS/CSS；后端 `/api/templates*` 保留兼容。
- 新建项目弹窗：placeholder 统一「请输入项目名称（留空 = 仅创建公司或行业）」；「创建客户或行业」改为与「新增项目」相同的圆+ SVG 按钮。

### 3.2 后端功能

- **评测落库**：`POST/GET /api/eval/runs`，服务端重算 L1，记录用例/通过/L1 失败/平均分/提示词哈希；每项目保留 300 条；提交仅补 `eval_run_id` 关联，不改 1/5.0、不拦截导出。
- **只读授权**：新表 `read_grants`（客户级/项目级 × 用户/团队/所有团队），旧 `project_grants` 幂等迁入；`/api/projects/grants` 扩展并兼容旧入参。
- **回收站**：4 张业务表加 `deleted_at/deleted_by/deleted_batch`；`/api/recycle/{list,restore,purge}`；30 天保留期 + 启动/每日串行清理。
- **知识库**：`/api/kb/list` 分页 + 服务端搜索；`KB_MAX_FILE_MB`（默认 20）；413 JSON。
- **用量看板**：`llm_usage` 表 + `/api/admin/usage/summary`；模型配置新增输入/输出单价。
- **所有权移交**：`/api/projects/transfer` + candidates。
- **父级公司整体置顶**：`/api/companies/pin` + `company_pins`（每人一套）；置顶区以公司名义展示公司及旗下全部项目，普通树不重复；只读授权用户可置顶可见公司。
- **用户治理**：`/api/admin/users/role`；`/api/admin/users/delete` 支持 `force + data_mode`。
- **修复**：L1 中文数字误判、团管空团队越权、assign-team 隐式降级、删除孤儿数据、上传 413、AI 润色缺少 `stripCodeFence`、成本舍入、同路径 GET/POST 路由冲突。

### 3.3 数据迁移（幂等）

`eval_runs` 7 列；`companies/projects/kb_items/snapshots` 各 3 个软删列；`read_grants`、`llm_usage` 新表；`model_configs` 2 个单价列；6 个索引；`recycle_retention_days=30`。V1.63.1 无结构变更；启动前快照默认关闭，迁移前请手动备份或临时开启。

### 3.4 V1.63.1 备份策略

- 自动备份：**每日 10:00**（`BACKUP_AUTO_HOUR`）在线备份一次，保留 **7 份**（`BACKUP_AUTO_KEEP`）；删除了旧版「每次启动 60 秒后首次备份」。
- 启动前快照：**默认完全关闭**（`BACKUP_STARTUP_ENABLED=false`），启动时清理历史启动快照；临时开启时保留 3 份，只复制非空 WAL，不复制 `-shm`。
- 漏备份兜底：最近 auto 不存在或超过 24h，启动 5 分钟后补备一次，随后回到每日 10:00。
- 清理：`POST /api/admin/backups/prune`（超管，审计 Danger）；删 .db 同步删 `-wal/-shm`，启动自动清理孤儿边车。
- 备份面板显示总量/策略/下次自动时间，并新增「清理旧备份」按钮。

---

### 3.5 V1.64 运维与数据治理

- **回收站批量清理**：`POST /api/recycle/purge-batch`（单次上限 200，串行，逐条校验归属；上级级联后子记录计 skipped）；面板支持当前页全选、「彻底删除所选」、「按批次」。
- **保留期可视化**：`GET|POST /api/admin/recycle/settings`（读管理可见，写仅超管），7/15/30/60/90 天；改后下次自动清理生效；`POST /api/admin/recycle/prune` 立即清理过期（超管，Danger 审计）。
- **回收站列表**：新增 `batch/type_counts/total_all/next_purge_at/last_purge_at`。
- **用量 CSV**：`GET /api/admin/usage/export` 按日期×模型×用途×用户聚合，UTF-8 BOM + 合计行；权限同 summary。
- **用量阈值告警**：`GET|POST /api/admin/usage/settings`（日 token / 日成本，0=关闭，写仅超管）；summary 返回 `thresholds/alerts/today`；超阈值仅黄条提示，不阻断。
- **无结构变更**：只写 `app_settings`（`recycle_retention_days`、`usage_alert_daily_tokens`、`usage_alert_daily_cost`）；路由 78 → 83。
- 新增审计动作：`recycle_purge_batch`、`recycle_retention_update`、`recycle_prune`、`usage_export`、`usage_alert_update`。

### 3.6 V1.65 运维可用性与体验修复

- **审计日志分页/筛选**：`GET /api/admin/audit-logs` 支持 `page/page_size(=limit)/level/action/user_id/q/from/to`，返回 `total/has_more/summary{info,warn,danger}`；`from/to` 非法或倒置 → 400 `INVALID_RANGE`；`limit` 上限 1000 → 200；`audit_logs` 新增 3 个索引（此前无索引）；面板加日期/用户/关键词/每页条数/翻页，仅超管。
- **用量逐条明细导出**：`GET /api/admin/usage/export?mode=detail`，14 列（含项目/耗时/成本）+ 合计行 + BOM + CSV 注入防护；`max_rows` 默认 5 万，超限 400 `TOO_MANY_ROWS`（不静默截断）；`mode` 缺省或 `aggregate` 时聚合输出不变；抽出 `getModelPriceMap()` 复用。
- **提交记录备注可编辑**：`POST /api/snapshots/update-remark` `{id,remark}`（≤200 字，空串清除）；`requireSnapshotAccess` + `requireProjectWritable` 双层校验；审计 `snapshot_remark_update`（代管自动 Warn）；列表备注单元格点击即改，只读项目不渲染入口。
- **只读编辑器修复**：原只读样式给上层 textarea 加不透明底，把 mirror 文字整个盖住（正文不可见）；改为 10% 半透明 `--readonly-tint: rgba(15,23,42,0.10)` + 虚线边框，正文可见可复制。
- **首登慢修复**：`index.html` 去掉两条解析阻塞的 bootcdn 脚本，改用 `/vendor/marked.min.js`（9.1.6）与 `/vendor/purify.min.js`（3.0.6）；`AUTH_PUBLIC_STATIC_RE` 增加 `vendor/`；访问日志加 ISO 时间戳。
- **文案口径**：删除成功提示改为「已删除」，确认框改为「移入回收站（30 天内可恢复）」；用户可见文案统一「提交记录」；服务端 message/错误同步；新增 `scripts/qa-wording.mjs` 守卫（备份域「启动前快照」保留）。
- **数据库**：仅 3 个索引，无表/列变更，无新增 `app_settings`；路由 83 → 84。

### 3.7 V1.65.1 登录页改版 + 首页树默认收起（纯前端）

- **登录页**（`public/login.html` 重写）：品牌移到卡片之外：`logo.png`（44px）与「AI Workbench」同一行，`align-items: baseline` 使文字底部与 logo 内文字底部齐平，整组 `justify-content: center`（`mix-blend-mode: multiply` 去掉 logo 白底；文字 `#0c479b` 取 logo「时」字同色，字号 18px/700 按 logo 大写字母高度 0.2944H 换算；品牌文案去掉「NewRock」，公司名由 logo 承载）；**删除「登录 / 注册」胶囊标签组与灰底框**（`.tabs/.tab` 已不存在）；卡片只留 `#msg` + 表单，输入框改浅灰填充 + 占位符 + `.sr-only` label；注册改为底部文字链接 `#register-entry/#register-link`（自助注册关闭时隐藏并显示管理员提示），注册面板加 `#back-to-login`；页脚 `.brand-foot → .login-foot`（显示版本与访问模式）。**登录鉴权/校验/首登改密逻辑零改动。**
- **首页项目树**（`public/index.html`）：新增会话级 `expandedCompanyIds: Set`（内存、不落 localStorage），删除 `fetchData()` 里强制的 `open: true`；`renderTree` 四处读取点统一读 Set；`toggleCompany` 维护 Set；`fetchData` 清理已删公司 id；`selectProject` 自动展开父公司（新建/克隆后能看到高亮项）；新增 `window.fetchData` 暴露（回归用）。**折叠项仍渲染进 DOM，仅 `display:none`。**
- **测试**：`scripts/smoke-v1.65.mjs` 版本断言改为读 `package.json`（避免升版即失败）；DOM 回归新增 16 条断言（登录页 9 + 新建项目自动展开 1 + 树折叠/保持/搜索 6），总数 123 → **139**。
- **无 API / 无库变更**，路由仍 84；`/api/health` 版本 `1.65.0 → 1.65.1`。

---

## 4. 代码地图

```
server.js                    后端：路由、DB/迁移、权限、加密、备份、LLM、评测、回收站、用量
public/index.html            前端全部 UI/JS
public/login.html            登录/注册/首登改密
lib/markdownChunker.js       Markdown 切片
public/vendor/               marked 9.1.6 / DOMPurify 3.0.6 本地库（v1.65 起唯一加载源）
scripts/smoke-v1.65.mjs      后端 142 项冒烟
scripts/smoke-v1.64.mjs      历史冒烟（保留参考）
scripts/smoke-v1.63.mjs      历史冒烟（保留参考）
scripts/qa-button-inventory.mjs  页面事件清单（113 个）
scripts/qa-wording.mjs       文案守卫（用户可见文案不得出现「快照」）
scripts/smoke-v1.62.mjs      历史冒烟（保留参考）
.qa-test/                    QA 产物（已忽略）：dom-e2e.mjs / run-dom.ps1 / e2e.mjs / run-e2e.ps1
autostart/                   Windows/Linux 自启脚本
data/                        数据库、密钥、备份（不要提交）
logs/                        运行日志
Readme.md                    权威文档
UPDATE_v1.65.md              V1.65 升级说明（登录页/项目树为 V1.65.1，见 UPDATE_v1.65.1.md）
QA_REPORT_v1.65.md           V1.65 回归记录
UPDATE_v1.65.1.md            V1.65.1 升级说明（登录页改版 + 首页树默认收起）
QA_REPORT_v1.65.1.md         V1.65.1 回归记录
UPDATE_v1.64.md              V1.64 升级说明
QA_REPORT_v1.64.md           V1.64 回归记录
UPDATE_v1.63.md              V1.63 升级说明
QA_REPORT_v1.63.md           V1.63 回归记录
API_REFERENCE.md             API 精简参考（以 server.js 实际路由为准）
```

关键表：`users / teams / companies / projects / kb_items / kb_item_versions / snapshots / eval_runs / model_configs / prompt_templates / audit_logs / app_settings / project_grants / project_pins / read_grants / llm_usage`。

---

## 5. 开发红线

### 5.1 前端双层编辑器
- 编辑器 = 底层 `div#mirror-*` + 上层透明 `textarea#val-*`；**严禁 contenteditable**。
- 两层 CSS 一致；mirror 的 scroll/padding 跟随 textarea；切 Tab/切项目后刷新 mirror。
- 程序赋值必须原生 setter + `input` 事件。

### 5.2 SQLite
- 批量删除必须串行，严禁 `Promise.all`。
- 表结构迁移幂等、先备份；不直接 DROP COLUMN，用重建表；新表保留全部旧字段。
- 软删除查询统一 `COALESCE(deleted_at,'') = ''`；彻底删除要显式清理 kb/snapshots/read_grants/pins。

### 5.3 权限与数据
- 业务 SQL 必须带 `user_id` 或角色过滤；越权 403、不存在 404、已删除 404。
- 功能关闭 = 隐藏入口 + 后端 403；超管功能权限不可禁用。
- 数据变更前备份真实库；不提交 `.env`、`data/`、`logs/`。

### 5.4 网络
- 默认只监听回环；`LAN_ACCESS=true` 才 `0.0.0.0`；Host/Origin 白名单只认字面回环/私有 IP。
- 局域网是 HTTP 明文，只用于可信内网；本轮**未做 HTTPS**。

---

## 6. 测试 / 回归

### 6.1 后端冒烟（首选，不碰生产库）

```powershell
node scripts/smoke-v1.65.mjs
# 期望 RESULT pass=142 fail=0（临时目录 data/tmp/smoke165-*）
```

### 6.2 页面全按钮回归（DOM 级）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .qa-test\run-dom.ps1
# 期望 RESULT pass=139 fail=0
```

- 环境：3101 + `.qa-test/data` 全新库；`.qa-test` 内 mock LLM 3301；jsdom 执行真实页面脚本。
- 覆盖：登录/首登改密、四个 Tab、侧边栏全部菜单、系统管理六面板、备份策略与清理、模型配置、回收站（含批量清理/保留期）、用量（含导出/阈值告警/明细导出）、审计（分页+筛选）、提交记录备注编辑、只读编辑器级联校验、本地 vendor 加载、退出；末尾校验清单内 113 个事件处理函数全部已定义。
- 文案守卫：`node scripts/qa-wording.mjs` 期望「白名单外 0 条」。
- **真实浏览器 E2E 不可用**：本机系统策略拒绝 Edge 的命名管道/IPC（mojo 0x5），Playwright/Edge 启动即崩溃；如需像素级回归，换一台不受限的机器或用真实浏览器人工抽查。

### 6.3 隔离 QA（人工）

- 端口 3101 + 独立 `NEWROCK_DATA_DIR`；不直接复制正在写入的 `-wal`。
- 手工验收建议：用真实 Key 跑一次 15 题回归 → 提交 → 导出，确认评测历史与用量看板有数据。

---

## 7. 已知限制 / 注意事项

1. **发布门禁仍不拦截**：提交写死 1/5.0、导出放行；评测仅历史可追溯（按 V1.63 产品决定）。真实门禁未排期。
2. **模板库前端入口已移除**：后端 `/api/templates*` 与 `prompt_templates` 表保留；不要擅自恢复 UI。
3. **变量/语境配置 UI 已移除**：后端 `/api/context/*` 与 `applyContextReplace` 仅兼容；不要恢复。
4. **未做 HTTPS**。
5. **真实浏览器自动化受本机 IPC 限制**（见 §6.2）。
6. **全量备份模型 Key 依赖 `data/.vault-key`**：跨机恢复必须一并复制。
7. **会话是 MemoryStore**：重启需重新登录；禁用/踢下线用 `session_version` 立即失效。
8. **角色变更后目标账号需重新登录**（会话版本 +1）。
9. **删除账号**：无数据直接删；有数据必须走强制删除二选一。
10. **回滚注意**：升级后软删的数据在 v1.62 代码看来仍存在，回滚前先恢复需要保留的数据。
11. **前端已更新但服务端未重启时**：授权面板会显示「服务端版本不匹配，请管理员重启 3100」并禁用保存，不再报「缺少 project_id」或一直「加载中」。
12. **启动前快照默认关闭（产品决定）**：升级/迁移前请先「立即备份」或临时设 `BACKUP_STARTUP_ENABLED=true`；关闭状态下启动会清理 `data/backups/startup/` 历史快照。
13. **批量彻底删除不可恢复**：`/api/recycle/purge-batch` 单次最多 200 条，逐条校验归属；操作前建议先导出或确认批次。
14. **回收站保留期修改不立即删除**：下次自动清理（启动 90 秒后首次，之后每 24h）才生效；需要立即清过期用「立即清理过期」。
15. **用量告警只提示不阻断**：阈值按 UTC 日切分与近 7 天日均判定；0 表示关闭。
16. **知识库大文档仍不自动分块**（v1.65 未做）：LLM 模式 `parseTxt` 按 500 字切块后全量并发，超长文档占满模型队列、长时间挂起且失败块静默丢弃；`parse-markdown` 一次收全文并同步计算，超大文档短时阻塞事件循环；右侧「解析文本」仍固定走 LLM。大文档先人工拆分。
17. **审计日志不提供导出**；用量明细导出单次上限 5 万行（`max_rows` 可调至 10 万）。
18. **`audit-logs` 的 `limit` 上限为 200**：旧调用若传 1000 会被归一为 200，改用 `page/page_size` 翻页。
19. **文案口径守卫**：用户可见文案不得再出现「快照」，改「提交记录」；备份域「启动前快照」保留。改完文案先跑 `node scripts/qa-wording.mjs`。

---

## 8. V1.66 候选（未开始）

- 知识库大文档自动分块（前端按标题/段落分片 → 顺序调用 `parse-markdown` → 去重 → 预览 → 批量入库；LLM 模式加上限与串行化；是否引入 `kb_parse_jobs` 另议）。
- 审计日志导出（CSV）与按 `action` 下拉筛选。
- 用量明细在面板内直接按用户/模型过滤（当前仅时间范围）。
- 真实发布门禁、可选 HTTPS、模板/变量 UI 恢复：**按产品决定继续不做**。

---

## 9. 新窗口接管步骤

1. 读：本文件 → `Readme.md` → `UPDATE_v1.65.md` → `QA_REPORT_v1.65.md` → DSH 工作区记忆。
2. 查状态：
   ```powershell
   git status -sb
   git log --oneline -10
   curl.exe -s http://127.0.0.1:3100/api/health
   ```
3. 不改生产：纯前端改动刷新即可；`server.js` 改动需管理员重启 3100。
4. 改代码前先跑 `node scripts/smoke-v1.65.mjs`；涉及 UI 再跑 `.qa-test\run-dom.ps1`；改文案跑 `scripts/qa-wording.mjs`。
5. 提交只 add 代码/文档；不要提交 `.env`、`data/`、`logs/`、`.session-headers.jsonl`、`.qa-test/`。

---

## 10. 协作偏好

- 中文、结果优先、少铺垫；能直接判断就给判断和方案。
- 不要为「确认」反复打断；重大数据变更/不可逆操作前先备份。
- UI 细节修改后要截图/量化验证，不要只说「已改」。
- 产品方向：界面持续做减法；未被明确要求的旧入口不要恢复。

---

## 11. 提交清单

V1.64.0 已提交（`94c7806`）；V1.65.0 已提交并推送（`04ff8d1`，origin/main 已同步）。V1.65.1 改动尚未提交，确认后再 commit：

```
feat(v1.65): 审计日志分页/时间/用户/关键词筛选 + 3 索引，用量逐条明细导出
feat(v1.65): 提交记录版本备注可编辑（update-remark + 列表内编辑 + Warn 审计）
fix(v1.65): 共享只读项目编辑器正文被不透明底色遮挡（改 10% 半透明 + 虚线）
fix(v1.65): 首登慢——marked/DOMPurify 改本地 vendor、/vendor/ 免登录、日志时间戳
fix(v1.65): 文案口径统一为「提交记录」，删除提示改为「已删除」
test(v1.65): 142 项冒烟 + 123 项 DOM 回归 + 113 个事件处理函数 + 文案守卫
docs(v1.65): README/UPDATE/QA/HANDOVER/API_REFERENCE 同步
```

历史提交：

```
feat(v1.64): 回收站批量清理/保留期配置/立即清理，用量 CSV 导出与阈值告警
test(v1.64): 115 项冒烟 + 105 项 DOM 回归 + 109 个事件处理函数
docs(v1.64): README/UPDATE/QA/HANDOVER/API_REFERENCE
feat(v1.63.1): 每日 10:00 备份、保留 7 份、关闭启动前快照、清理接口
feat(v1.63): 顶部系统管理合并 / 模板入口移除 / 评测落库 / 授权升级 / 回收站 / 用量看板
```
