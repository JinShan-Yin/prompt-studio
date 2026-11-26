# NewRock AI Workbench v1.64.0 更新说明

发布日期：2026-11-26
适用：v1.63.1 → v1.64.0

本版定位「运维与数据治理」：把 v1.63 引入的**回收站**与**用量看板**从「能用」做成「可运营」。
**无数据库结构变更**（用户保存配置时最多写入 app_settings 三个键：保留期与两个告警阈值），不改变发布门禁、模板/变量兼容策略与备份策略。

---

## 一、升级步骤

1. **先备份数据库**（服务停止状态下）：
   ```powershell
   New-Item -ItemType Directory -Force data\backup-v1.64 | Out-Null
   Copy-Item data\newrock.db,data\newrock.db-wal,data\newrock.db-shm data\backup-v1.64\ -ErrorAction SilentlyContinue
   ```
2. 覆盖代码（不要覆盖 `.env` 与 `data/`），本次**没有新增生产依赖**，无需 `npm install`。
3. `.env` 无需改动；本版没有新增环境变量。
4. 重启服务（生产 3100 需要管理员窗口）。启动日志应出现：
   - `NewRock AI Workbench v1.64.0`
   - `已注册 API 路由: 83 条`
   - 版本字段 `1.64.0`
5. `curl http://127.0.0.1:3100/api/health` 期望 `version=1.64.0 / db_ok / mode=lan`。

> 本版没有建表/加列，不会触碰业务数据；启动前快照仍按 v1.63.1 策略**默认关闭**，升级前请手动「立即备份」。

---

## 二、新增能力

### 1) 回收站批量治理与保留期可视化

- **批量彻底删除**：回收站表格新增当前页复选框、全选、「彻底删除所选」；也可以按单条记录对应的删除批次执行「按批次」清理。
  - 新接口 `POST /api/recycle/purge-batch`：逐条串行、**单次最多 200 条**，每条重新校验归属（防越权）；上级（公司/项目）级联删除后，子记录计为 `skipped` 而不是失败。
- **保留期可视化配置**：回收站面板新增 7/15/30/60/90 天下拉（仅超管可改），写入 `app_settings.recycle_retention_days`；
  - `GET|POST /api/admin/recycle/settings`（读取管理可见，写入仅超管）。
  - 修改后**不会立即删除**，在下一次自动清理时生效；面板会显示「下次自动清理」时间。
- **立即清理过期**：`POST /api/admin/recycle/prune`（仅超管）串行清理已过期记录并写审计（Danger）。
- **类型统计**：`GET /api/recycle/list` 新增 `type_counts`、`total_all`、`batch`、`next_purge_at`、`last_purge_at`。
- 审计新增：`recycle_purge_batch` / `recycle_retention_update` / `recycle_prune`。

### 2) 用量看板导出与阈值告警

- **CSV 导出**：`GET /api/admin/usage/export?days=30`，按「日期 × 模型 × 提供方 × 用途 × 用户」聚合导出，带 UTF-8 BOM，Excel 可直接打开；含「合计」行。权限与用量汇总一致（超管全量、团管按团队），普通用户 403。
- **阈值告警**：系统管理「用量看板」新增「日 token 阈值 / 日成本阈值（元）」，0 表示关闭（仅超管可改）。
  - `GET|POST /api/admin/usage/settings`；阈值存 `app_settings.usage_alert_daily_tokens` / `usage_alert_daily_cost`。
  - 汇总接口返回 `thresholds`、`alerts`、`today`；今日总量或近 7 天日均超阈值时，面板顶部显示黄色告警条。
  - **告警只展示，不阻断任何请求**；审计记录 `usage_alert_update`（Warn）与 `usage_export`（Info）。

---

## 三、行为变化（升级需知）

1. `/api/recycle/list` 返回值新增字段，旧前端忽略即可；`data` 仍是当前页数组。
2. `/api/recycle/purge-batch` 为新增接口，原 `/api/recycle/purge`（单条）行为不变。
3. `/api/admin/usage/summary` 返回值新增 `thresholds` / `alerts` / `today`；原有 `totals`、`by_model`、`by_user`、`by_day`、`by_purpose` 不变。
4. 同一路径的 GET/POST 已合并为单条路由注册，避免 v1.63 曾出现的同路径 405。
5. **明确不做**：HTTPS、模板/变量 UI 恢复、发布门禁拦截、启动前快照开启。这四项按产品决定继续保持现状。

---

## 四、回滚

- 代码回退到 v1.63.1 即可：本版没有结构变更，新增的 app_settings 键对旧代码无影响。
- 已执行的批量彻底删除无法恢复；回滚前请确认回收站中不需要保留记录。
- 保留期/阈值配置会保留在 app_settings 中，旧版本忽略它们（保留期仍按 v1.63.1 的 30 天逻辑读取同一键，行为一致）。
