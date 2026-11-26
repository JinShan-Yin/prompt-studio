# NewRock AI Workbench v1.65.0 更新说明

发布日期：2026-11-26
适用：v1.64.0 → v1.65.0

本版定位「**运维可用性 + 体验修复**」，共 6 项：
1. 审计日志分页与筛选（P1）
2. 用量逐条明细导出（P2）
3. 提交记录「版本备注」手动编辑
4. 共享只读项目编辑器正文不可见修复
5. 首次登录加载慢修复（去 CDN 阻塞）
6. 文案口径统一（提交记录，删除提示「已删除」）

**数据库变更**：仅 `audit_logs` 3 个索引；**无新增表 / 列**，不写新的 `app_settings`，发布门禁、模板/变量兼容策略与备份策略均未改变。
**路由数**：83 → **84**（仅新增 `POST /api/snapshots/update-remark`）。

---

## 一、升级步骤

1. **先备份**。本次已执行在线备份 `auto-20261126_200751.db`，并复制为
   `data/backups/manual/pre-v1.65-20261126_200751.db`（升级前基线）。
2. 覆盖代码（**不要覆盖** `.env` 与 `data/`）。本版**无新增生产依赖**，无需 `npm install`。
3. `.env` 无需改动；本版没有新增环境变量。
4. 重启服务（生产 3100）。启动日志应出现：
   - `NewRock AI Workbench v1.65.0`
   - `已注册 API 路由: 84 条`
5. `curl http://127.0.0.1:3100/api/health` 期望 `version=1.65.0 / db_ok / mode=lan`。
6. 浏览器 **Ctrl+F5** 强制刷新一次（`index.html` 的脚本引用与样式有改动）。

> 启动前快照仍按 v1.63.1 策略**默认关闭**；本版迁移只建索引，幂等且不触碰业务数据。

---

## 二、新增能力

### 1) 审计日志分页与筛选

- `GET /api/admin/audit-logs` 新增入参：
  `page`（默认 1）、`page_size`（1–200，默认 50；`limit` 作为别名保留）、`level`、`action`、`user_id`、`q`（≤100 字）、`from`、`to`（ISO 时间）。
- 返回新增：`total`、`page`、`page_size`、`has_more`、`summary:{info,warn,danger}`；`data` 仍是数组（旧调用忽略新字段即可）。
- `from`/`to` 解析失败或时间倒置 → `400 INVALID_RANGE`；`q` 命中动作 / 详情 / 对象 ID / 用户名。
- 权限不变：**仅超管**；不记录「查看审计」本身，避免自噪声。
- 数据库：`audit_logs` 新增 `idx_audit_logs_created`、`idx_audit_logs_user`、`idx_audit_logs_action`（此前无任何索引）。
- 前端：审计面板新增日期范围、用户下拉、关键词、每页条数与翻页按钮；状态行显示「共 N 条（Info x / Warn y / Danger z）」。

> 注意：`limit` 仍可用，但上限由 1000 收紧为 200（与 `page_size` 对齐）。仓库内无以此为依赖的调用方。

### 2) 用量逐条明细导出

- `GET /api/admin/usage/export?mode=detail&days=30[&from=&to=&user_id=&model=&purpose=&status=&max_rows=]`
- 缺省或 `mode=aggregate` 时，**原有聚合 CSV 输出逐字节不变**。
- 明细 14 列：时间 / 日期(UTC) / 用户 / 项目 / 提供方 / 模型 / 路由 / 用途 / 状态 / 输入 token / 输出 token / 总 token / 耗时 ms / 估算成本(元)，末尾「合计」行；UTF-8 BOM；文本单元格做 CSV 注入防护。
- `max_rows` 1–100000（默认 50000）：先计数，`total > max_rows` → `400 TOO_MANY_ROWS`（附 `total`、`max_rows`），**不静默截断**。
- 权限与汇总接口一致：超管全部、团管本团队、普通用户 403；审计复用动作 `usage_export`（detail 写 `mode=detail`）。
- 前端：用量面板新增「⬇ 导出明细 CSV」，走 `fetch → blob` 下载，超限时 toast 提示缩小时间范围。

### 3) 提交记录「版本备注」可编辑

- `POST /api/snapshots/update-remark` `{id, remark}`：`remark` 必须为字符串，trim 后 ≤200 字，**空串 = 清空备注**。
- 权限：可读该记录 **且** 所属项目可写（共享只读授权 / 公共参考项目 403）。
- 审计：`snapshot_remark_update`（detail 含长度与新值）；超管/团管修改他人记录自动判 `Warn`。
- 前端：提交记录列表的备注单元格可直接点击编辑（复用全局输入弹窗），空备注显示「✏️ 添加备注」；只读项目不渲染编辑入口。

---

## 三、修复

### 1) 共享只读项目「编辑器一大片灰、正文看不见」

根因：编辑器是「底层 mirror 画字 + 上层透明 textarea」的双层结构，只读样式给 textarea 加了**不透明底色**，把下层文字整个盖住（1556 字一个都看不见），并非单纯配色问题。

修复：只读态改为 **10% 半透明**底（`--readonly-tint: rgba(15, 23, 42, 0.10)`）+ 虚线边框；文字恢复可见、可选中复制，编辑能力仍锁定。可写项目样式零变化。

### 2) 首次登录慢

根因：`index.html` 的 `</head>` 前有两条 **解析阻塞** 的 `cdn.bootcdn.net` 脚本；首次访问无缓存时整页不渲染，本地兜底要等 CDN 失败才执行 → 首次很慢、之后正常。服务端日志显示登录 122ms、页面 3ms，瓶颈在浏览器端。

修复：
- 改用随仓库分发的本地库 `/vendor/marked.min.js`（9.1.6）、`/vendor/purify.min.js`（3.0.6），删掉 CDN 与 `document.write` 兜底；
- `/vendor/*` 加入免登录静态白名单（原先未登录访问会被 302 到登录页）；
- 访问日志增加 ISO 时间戳，后续若再出现慢可用日志间隙定位。

### 3) 文案口径

- 提交记录批量删除：成功提示改为 **「已删除」**（不再出现「已删除 N 个快照」）；部分失败为「删除完成：成功 N 条，失败 M 条」。确认框同步改为「删除后将移入回收站（30 天内可恢复）」（原文案「不可恢复」与软删除事实不符）。
- 全站用户可见文案统一为「提交记录」：预览标题、回滚/复制/下载/Diff 提示、`快照 ID 无效`、导出文件标题、克隆成功提示等；服务端错误文案同步（`提交记录不存在或无权访问` 等）。
- **保留**「启动前快照 / 备份快照」——属于备份域概念，与提交记录无关。
- 新增 `scripts/qa-wording.mjs`：扫描 `public/index.html` 与 `server.js`，白名单外出现「快照」即失败（当前 44 处命中，全部为备份域或注释/日志）。

---

## 四、行为变化（升级需知）

1. `/api/admin/audit-logs` 返回新增 `total/page/page_size/has_more/summary`；`limit` 上限 1000 → 200。
2. `/api/admin/usage/export` 新增 `mode` 参数；**默认仍是聚合导出**，响应不变。
3. `/vendor/*` 变为免登录静态资源（仅 marked / DOMPurify 两个公开库）。
4. `logs/service.log` 每行增加 ISO 时间戳前缀（格式变化，便于排障）。
5. 提交接口 `POST /api/snapshots/create` 的 `message` 由「快照成功存入」改为「提交成功」；`GET /api/snapshots/detail` 额外返回 `remark`。
6. 提交记录列表「版本备注」列变为可点击编辑。
7. 明确不做：HTTPS、模板/变量 UI 恢复、发布门禁拦截、启动前快照开启。

---

## 五、数据库变更说明

| 项 | 内容 |
|---|---|
| 新增表 | 无 |
| 新增列 | 无 |
| 新增索引 | `audit_logs(created_at)`、`audit_logs(user_id, created_at)`、`audit_logs(action, created_at)` |
| app_settings | 无新增键 |

迁移在启动时幂等执行；万级审计行建索引为毫秒级。

---

## 六、回滚

- 代码回退到 v1.64.0 即可：本版无表/列变更，新增索引对旧代码无害（如需清理可 `DROP INDEX`）。
- 前端与后端需**同版本回退**（旧前端不带 `page` 参数，新后端仍兼容；新前端的筛选依赖新后端返回的 `total`）。
- 备注编辑、审计筛选、明细导出都不产生不可逆数据变更。

---

## 七、已知限制（本版未做，v1.66 候选）

1. **知识库大文档仍不自动分块**：LLM 模式 `/api/kb/parse` 按 500 字切块后全量并发，超长文档会占满模型队列并长时间挂起，失败块被静默丢弃；`/api/kb/parse-markdown` 一次收全文并同步计算，超大文档会短暂阻塞事件循环。
2. 右侧「解析文本」仍固定走 LLM 模式（与「保留原结构」模式不一致），大文档请优先用文件导入 + 人工拆分。
3. 审计日志暂不提供导出；用量明细导出单次上限 5 万行。
4. 真实浏览器自动化仍受本机 IPC 限制，UI 采用 jsdom 回归 + 人工抽查。
