# Sprint 3 端到端验收报告（Lead）— V2.0 收尾

> 范围：`requirements.md` **模块五（版本与安全）**、**模块六（生态融合与快捷键）**、**模块七（UI 审查）**
> 结论：**全部需求项通过，可交付。V2.0 模块一~七全部完成。**

## 1. 环境与服务

| 项 | 值 |
|---|---|
| 工作目录 | `D:\prompt-studio` |
| 启动链路 | 双击 `启动.bat` → `node start.cjs` → `dsh web --patch ./cordis.patch.yml`(3080) + `node server-ui.js`(3081) |
| 页面 | `http://127.0.0.1:3081/?token=…`（token 由启动控制台输出；当前已运行） |
| 新增后端 | `settings-engine` 插件（API Key 设置）、`project-snapshot` 扩展（detail layers / prompt assemble / export_zip） |
| 新增依赖 | `archiver@8.0.0`（纯 ESM，使用官方 v8 `ZipArchive` API；用户明确要求安装） |

## 2. 变更清单

| 文件 | 变更 |
|---|---|
| `plugins/settings-engine/index.js` | 新建：`GET/POST /api/settings/api-key`；masked 永不泄露完整 Key；空值保持；非法 400；合法时原子写 `.env`（temp+rename，保留其它行/注释）并更新 `process.env` 立即生效；导出 `maskApiKey` / `validateApiKey` / `upsertEnvLine` |
| `plugins/project-snapshot/index.js` | 纯扩展：`snapshots/detail` 增加 `layers`（容错 parse）/`eval_pass`/`eval_score`；新增 `POST /api/prompt/assemble`（只组装不写库）；新增 `GET /api/projects/export_zip`（archiver 流式：manifest.json + snapshots/\<id\>.txt） |
| `cordis.patch.yml` | 注册 settings-engine |
| `package.json` / `package-lock.json` | 新增 `archiver@^8.0.0` |
| `public/index.html` | 1915 → 2363 行：①快照行「回滚」；②Header 齿轮 API Key 弹窗；③「复制为 NewLync Text」；④Ctrl+S 快捷键（+并发保护）；⑤「批量导出 Zip」；⑥模块七 UI 规范精修（设计变量、深色侧边栏、indigo 主色、统一 hover/focus/间距/对比度） |
| `test-data/backend-selftest-sprint3.mjs` | 新建 22 条纯函数单测 |

## 3. 自动化验收结果

### 3.1 后端自测（三套全绿，最终回归）

| 测试 | 结果 |
|---|---|
| `node test-data/backend-selftest.mjs`（S1） | **25/25 ✅** |
| `node test-data/backend-selftest-sprint2.mjs`（S2） | **25/25 ✅** |
| `node test-data/backend-selftest-sprint3.mjs`（S3） | **22/22 ✅**（mask 6 / validate 5 / upsertEnvLine 7 / assemble 替换 2 / 路由注册 2） |

### 3.2 HTTP 集成冒烟 —— 23/23 通过（`test-data/e2e/http-smoke-sprint3.mjs`）

- **API Key 安全路径**：GET 返回 `has_key=true` + `masked`（前3+****+后4，长度≤16，无完整 Key）；POST 空值/纯空白 → `updated:false` 保持原值；POST 过短非法 → 400；**随后真实 `/api/chat/reply` 仍成功**（证明真实 Key 未被破坏）。
- **快照详情**：创建 3 层快照 → `GET /api/snapshots/detail` 返回 `layers` 数组（L0/L1/L3 内容与创建时逐字一致）+ `eval_pass`/`eval_score`/`created_at`/`final_prompt_content`。
- **只读组装**：`POST /api/prompt/assemble` → `final_prompt` 中 L0/L3 的 `{{industry}}/{{business_scene}}/{{core_goal}}` 全部替换、零残留；调用前后快照数不变（不写库）。
- **Zip 导出**：200 + `application/zip` + `attachment; filename="project-proj-597e1045-snapshots.zip"`；PK 文件头有效；缺参 400；项目不存在 404；临时空项目（无快照）404（测后已删除）。
- **ZIP 内容实测**（PowerShell `Expand-Archive`）：manifest.json（project_name=Trip旅游AI接线员、count=15~16、snapshots 明细）+ `snapshots/<id>.txt` 数量一致；txt 中文 UTF-8 内容正确。

### 3.3 Lead 真实浏览器 E2E（dsh-ego-browser / 真实 Chrome）

| # | 验收项 | 实测证据 |
|---|---|---|
| 1 | **Ctrl+S 快捷键 + 快照回滚** | 派发可取消 Ctrl+S：`defaultPrevented=true`，抓包 `/api/snapshots/create` 成功（3 层 layers 内容一致、新快照 snap-6ae1284b、列表 15→16 行）；改坏三层后点首行「回滚」→ L0/L1/L3 全部恢复（逐字一致）、镜像层橙色高亮、Token 统计 166=预期、toast「已回滚到快照…（尚未生成新快照）」，无 JS 异常 |
| 2 | **⚙️ API Key 设置** | 齿轮弹窗标题「⚙️ API Key 设置」；消息区仅显示 masked `sk-****8a2e ✅已配置（来源：env）`，页面无完整 Key；input `type=password`；空值保存 → `updated:false` + toast「未提供新 Key，保持原值」+ 弹窗关闭；非法短值 → 400 + toast「API Key 格式不正确（长度需≥20 且不含空白）」+ 弹窗保持；关闭后 input type 恢复 `text`（不污染其它 modal） |
| 3 | **📋 复制为 NewLync Text** | 点击 → 抓包 `POST /api/prompt/assemble`（3 层 layers + context_data）→ `final_prompt` 199 字符、`{{industry}}` 已替换；剪贴板写入内容与 final_prompt **完全一致**；toast「已复制到剪贴板（199 字符）」；快照数 16→16（不生成快照） |
| 4 | **📦 批量导出 Zip（真实下载）** | 点击按钮 → `ego_download` 捕获真实下载 `project-proj-597e1045-snapshots.zip`（8,243B）→ `Expand-Archive` 解压：**17 entries = manifest.json + 16 个快照 txt**；manifest.count=16、project_name=Trip旅游AI接线员 一致；txt 中文正常 |
| 5 | **模块七 UI 审查** | 计算样式实测：侧边栏背景 `rgb(30,27,75)`（深紫）、选中项 indigo + 左侧 3px 指示条、文字对比度 **15.99:1**；`--primary=#4f46e5`、主按钮 `rgb(79,70,229)`；页面底 `#f8fafc`、Header 白色；卡片 `radius 12px / margin-bottom 24px / body padding 24px`、统一阴影；表格 thead `#f8fafc/600`、行 hover 规则统一、边框 `#e5e7eb`；按钮圆角 6px + 统一 transition；全站 **34 条 hover 规则**；无横向溢出；图标/按钮/输入框/下拉/tag/聊天气泡/进度条全部主题化；功能色（橙色变量高亮、红色告警、绿色成功）保留 |
| 6 | **回归** | Token 统计 130 字→78 Token（ceil*0.6）、橙色高亮 `<speak>` 原文保留、两层高度差 0；KB 搜索「纠纷」→ 21 匹配；聊天/批量/回滚/复制/Zip 入口齐全；页面无 `window.onerror`/`unhandledrejection`；红线扫描：contenteditable=0、外链/CDN=0、原生 alert/confirm=0、DOM 无完整 Key |

### 3.4 独立 QA 审查（qa-reviewer）

- **结论：可交付，无 P0/P1**；唯一 **P2（回滚竞态）已修复并聚焦复审通过**：`rollbackSnapshot` 增加 `rollbackSeq + projectIdAtRollback` 双守卫、`d.data.project_id` 归属校验、catch 内守卫、切项目递增 seq（在途/乱序回滚均失效，最后点击生效）。
- QA 同时确认：settings-engine 安全（无 Key 泄露路径、原子写、固定错误文案）、export_zip 流式正确（live 实测 16 entries=manifest+15 txt、头注入无效）、detail layers 容错、assemble 只读、UI 主题与 Sprint1/2 功能无回归。
- QA 指出的 P3 UI 对比度/红色统一已一并修复：`--warning-strong:#b45309`（白字对比 5.02:1）、`--text-muted:#6b7280`（4.83:1）、`--bg-soft:#f8fafc`、`--danger:#ef4444` 全站统一（`#f56c6c`/`#9ca3af` 残留 0；变量橙 `#f59e0b` 保留）。

## 4. 数据清理与最终状态

- 冒烟测试创建的临时空项目已删除；测试快照保留为项目历史记录（16 条）。
- 项目语境已恢复「旅游行业 / [售后退换货, 停车缴费] / [安抚客户情绪, 准确提供价格]」。
- 页面已 reload 回干净状态：Trip 选中、KB 97 条、快照 16 条、聊天/批量为空态、fetch 原生；服务 3080/3081 运行中。
- **真实 API Key 全程未被修改**（E2E 仅走「空值保持」与「非法短值」两条安全路径；POST 合法 Key 的写入路径由纯函数单测 + 后端离线集成 + 静态审查覆盖，需用户实际输入新 Key 时生效）。

## 5. 截图证据（test-data/e2e/）

| 文件 | 内容 |
|---|---|
| `s3-01-rollback-restored.png` | 快照回滚后编辑器恢复 + 高亮 |
| `s3-02-apikey-masked.png` / `s3-03-apikey-invalid-keep-open.png` | API Key 弹窗 masked / 非法值报错不关闭 |
| `s3-04-copy-newlync-text.png` | 复制为 NewLync Text + toast |
| `s3-05-zip-empty-project-toast.png` | 空快照项目导出提示 |
| `s3-06~s3-11` | UI 全卡片 / 窄窗口 1180/720 / 最终界面 |
| `s3-12/13/14` | 回滚正常 / 在途切项目守卫 / 乱序最后生效 |
| `s3-15-ui-colors-contrast.png` | 颜色对比度与红色统一 |
| `s3-lead-01-main.png` / `s3-lead-02-snapshot.png` / `s3-lead-03-chat-batch.png` | Lead 独立截图：主界面 / 快照中心（回滚+Zip） / 批量卡片 |
| `s3-project-export.zip` / `s3-lead-export.zip` | 真实导出的项目快照 Zip（可解压验证） |

## 6. 已知非阻塞事项

1. **API Key 有效值写入路径**未在 E2E 覆盖（为避免覆盖真实 Key），仅由纯函数单测 + 后端离线集成 + 静态审查验证；用户在 UI 输入新 Key 保存时立即更新 `.env` 与 `process.env`。
2. `archiver` 使用 8.x 纯 ESM API（`ZipArchive`），与 v7 的 `archiver('zip')` 调用不同但功能等价（zlib level 9、流式、错误处理一致）。
3. settings 写接口沿用本地工具既有架构（无登录鉴权、CORS *）；如未来联网部署建议加 Origin/token 校验。
4. 快照列表测试历史记录（16 条）保留；旧 `public/` Vue 残留文件已无引用（可清理，不影响运行）。
5. 已知 P3（QA 提出，未阻断）：settings 对重复 `DEEPSEEK_API_KEY` 行只替换第一处；export_zip 全量读取快照内容（超大项目内存峰值）；`btn-warning` 已修复对比度，仍有少量既有 inline 主题色残留。
