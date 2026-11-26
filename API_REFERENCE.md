# 核心 API 参考（v1.65.0）

> 完整路由以 `server.js` 启动日志为准（共 **84 条**）。所有 `/api` 请求默认要求登录会话（白名单除外），并校验 `Host` / `Origin`。`/vendor/*`（marked / DOMPurify 本地库）为公开静态资源，不要求登录。

## 鉴权 / 探活 / 配置

- `POST /api/auth/login` `{username,password}`
- `POST /api/auth/register`（局域网模式默认关闭，返回 `REGISTER_DISABLED`）
- `POST /api/auth/logout`
- `GET /api/auth/me` → 含 `features`、`trial_count`、`trial_limit`、`status`
- `POST /api/auth/change-password` `{old_password,new_password}`
- `GET /api/auth/config`（公开）→ `{register_enabled,lan_mode,version,kb_max_file_mb}`
- `GET /api/health`（公开）→ `{status,version,uptime_s,db_ok,mode,port}`

## 团队 / 用户 / 权限 / 备份 / 审计（管理）

- `GET /api/teams`、`POST /api/teams/create`（超管）
- `GET /api/admin/users` → 含 `status/last_login_at/features/overrides/team_name`
- `POST /api/admin/users/create` `{username,password,role,team_id}`
- `POST /api/admin/users/features` `{user_id,overrides:{edit,kb,eval,snapshot}}`（超管目标 403）
- `POST /api/admin/users/status` `{user_id,status:'active'|'disabled'}`
- `POST /api/admin/users/kick` `{user_id}`
- `POST /api/admin/users/delete` `{user_id}`（有业务数据返回 409 `USER_HAS_DATA`）
- `POST /api/admin/users/reset-password` `{user_id}`
- `POST /api/admin/users/assign-team` `{user_id,team_id,role}`
- `POST /api/admin/users/role` `{user_id,role,team_id}`
- `GET /api/admin/features`、`POST /api/admin/features/matrix`（超管）
- `GET /api/admin/backups`、`POST /api/admin/backups/run`、`POST /api/admin/backups/prune`（超管）
- `GET /api/admin/audit-logs?page=&page_size=&level=&action=&user_id=&q=&from=&to=`（超管；v1.65）
  → `{data,total,page,page_size,has_more,summary:{info,warn,danger}}`；`limit` 仍可用（= `page_size`，上限 200）
  → `from`/`to` 为 ISO 时间（前端把本地日期边界转 ISO）；解析失败或 `from>to` → 400 `INVALID_RANGE`
  → `q` 命中动作 / 详情 / 对象 / 用户名；不记录"查看审计"本身

## 客户 / 项目 / 授权 / 置顶 / 移交

- `GET /api/companies`、`POST /api/companies/create|update|delete`
- `GET /api/projects` → 每行含 `pinned`、`can_write`
- `POST /api/projects/create|update|delete`
- `POST /api/projects/clone` `{id,target_company_id?,name?,copy_mode?:'latest'|'all'|'none'}`
- `POST /api/projects/pin` `{project_id,pinned}`
- `POST /api/companies/pin` `{company_id,pinned}`（父级公司整体置顶）
- `GET /api/projects/grants`、`POST /api/projects/grants/save`
  `{scope_type:'company'|'project', company_id?, project_ids?, targets:[{grantee_type:'user'|'team'|'all',grantee_id?}]}`
- `GET /api/projects/transfer/candidates?project_id=`、`POST /api/projects/transfer` `{project_id,target_user_id}`
- `GET /api/projects/export_zip`

## 语境 / 知识库 / 快照

- `GET /api/context/get`、`POST /api/context/save|extract`（遗留兼容）
- `POST /api/kb/parse`、`/parse-markdown`、`/extract-text`、`/save`、`/delete`、`/update`
- `GET /api/kb/list?project_id=&page=&page_size=&q=`、`/export?format=txt|md`
- `POST /api/prompt/assemble`
- `POST /api/snapshots/create|delete`、`GET /api/snapshots/list|detail`
- `POST /api/snapshots/update-remark` `{id,remark}`（v1.65；空串=清空，≤200 字，需项目可写）
  → `{success,id,remark}`；越权/只读授权 403；审计动作 `snapshot_remark_update`
- `GET /api/gate/export?snapshot_id=&format=txt|md`

## 评测 / 对话 / 模型 / 模板 / 备份

- `POST /api/eval/run`、`/generate_questions`、`POST|GET /api/eval/runs`、`GET /api/eval/export`
- `POST /api/chat/reply`
- `GET|POST /api/settings/api-key`（超管）
- `GET /api/models`、`POST /api/models/save|delete|test`
- `GET /api/templates`、`POST /api/templates/save|delete|extract`
- `POST /api/ai/polish`
- `GET /api/backup/export?scope=business|full`、`POST /api/backup/import`

## 回收站（v1.64）

- `GET /api/recycle/list?type=all|company|project|kb|snapshot&page=&page_size=`
  → `data[]` 每项含 `type/id/name/deleted_at/expire_at/batch`；另返回 `total_all/type_counts/retention_days/next_purge_at/last_purge_at`
- `POST /api/recycle/restore` `{type,id}`
- `POST /api/recycle/purge` `{type,id}`（单条彻底删除）
- `POST /api/recycle/purge-batch` `{items:[{type,id}]}` 或 `{type,batch}`
  → `{purged,failed[],skipped}`；单次上限 200；串行执行；逐条校验归属
- `GET|POST /api/admin/recycle/settings`
  → GET：`{retention_days,next_purge_at,last_purge_at,counts}`
  → POST（超管）：`{retention_days:1..365}`
- `POST /api/admin/recycle/prune`（超管）→ `{purged}`

## 用量（v1.63 / v1.64）

- `GET /api/admin/usage/summary?days=30`
  → `totals/by_model/by_user/by_day/by_purpose`，并新增 `thresholds/alerts/today`
- `GET /api/admin/usage/export?days=30`
  → `text/csv; charset=utf-8`（UTF-8 BOM，含「合计」行）；聚合：日期 × 模型 × 提供方 × 用途 × 用户
- `GET /api/admin/usage/export?mode=detail&days=30[&from=&to=&user_id=&model=&purpose=&status=&max_rows=]`（v1.65）
  → 逐条明细 14 列（时间/日期/用户/项目/提供方/模型/路由/用途/状态/输入/输出/总 token/耗时/成本）+ 合计行
  → `max_rows` 1–100000（默认 50000）；`total > max_rows` → 400 `TOO_MANY_ROWS`（不静默截断）
  → 非法 `mode` → 400 `INVALID_MODE`；作用域同 summary（超管全部 / 团管本团队）
- `GET|POST /api/admin/usage/settings`
  → GET：`{tokens,cost}`；POST（超管）：`{alert_daily_tokens,alert_daily_cost}`（0=关闭）

## 权限与错误码

- `401 UNAUTHORIZED`：未登录 / 会话失效（禁用、踢下线、版本变化）
- `403 FEATURE_DISABLED`：功能组被管理员关闭
- `403 ACCOUNT_DISABLED`：账号被禁用
- `403 SUPERADMIN_LOCKED`：试图修改超管功能权限
- `403 TRIAL_EXHAUSTED`：免费试用额度用完（前端会引导配置个人 Key）
- `409 USER_HAS_DATA`：账号仍有业务数据，不能删除
- `413 FILE_TOO_LARGE`：知识库单文件超过 `KB_MAX_FILE_MB`
- `400 INVALID_RANGE`：审计/用量导出的 `from`/`to` 非法或时间倒置（v1.65）
- `400 INVALID_MODE`：用量导出 `mode` 只支持 `aggregate|detail`（v1.65）
- `400 TOO_MANY_ROWS`：用量明细超过 `max_rows`（返回 `total` 与 `max_rows`）（v1.65）
- `409`（回收站恢复）：上级仍在回收站，需先恢复上级
- `429 LOGIN_LOCKED`：登录失败次数过多
