# 《V3.0 夜间托管开发交付报告》

> 执行模式：夜间无人值守 · 四阶段自动递进 · 每阶段 change-review/git 安全屋存档
> 时间：2026-11-05 凌晨 — 清晨
> 当前服务：`http://127.0.0.1:3000`（纯 Node.js + Express，无 Cordis、无 token）

## 1. 四阶段完成状态

| 阶段 | 内容 | 状态 | 安全屋 |
|---|---|---|---|
| 阶段一 | 彻底独立化为纯 Node.js 应用：`server.js`（Express 5 端口 3000）、全部 24 API 内联迁移、DB 初始化内联、静态托管、端口占用自动释放、前端全量删除 token、废弃 cordis.patch.yml/server-ui.js/start.cjs/plugins/、重写 `启动.bat` | **100% 完成** | commit `bcdf75b`（.v3-checkpoints/phase1.md） |
| 阶段二 | 多模型路由中枢：`model_configs` 表、`GET /api/models` / `POST /api/models/save` / `POST /api/models/test`、`chatCompletion` DB 动态路由 + 无激活/失败自动回落 `.env`；前端 Header ⚙️「模型配置中心」弹窗（厂商联动/测试连通性/保存单活/Key 不回显） | **100% 完成** | commit `24357bc`（phase2-3.md） |
| 阶段三 | 中文化交互：L0「➕ 插入变量」中文下拉（→英文占位符，光标插入）、镜像橙色 span 中文 `title` 悬浮提示（英文文本保持不变） | **100% 完成** | commit `24357bc`（phase2-3.md） |
| 阶段四 | 7 项：KB 在线编辑（/api/kb/update）、左侧树搜索、AI 生成刁钻测试题（/api/eval/generate_questions + 正则安全解析 + 填入批量）、一键清理排版、Token 红线进度条（4000 绿/黄/红）、快照行级 Diff（LCS 左红右绿）、全局 Esc 分层关闭 | **100% 完成** | commit `b5d431e`（phase4.md） |

**额外：P1 安全加固**（QA 发现「任意 base_url + 自动回退 .env Key」可被恶意网页跨站窃取真实 Key）：已修复并验证——非官方端点禁止 .env Key 回退、Base URL SSRF 校验、CORS 仅本机白名单 + `/api` 非本机 Origin 403。已并入 commit `b5d431e`。

## 2. 失败超过 3 次并回退的 Bug / 跳过项

**无。** 四阶段全部功能均已实现并验证，没有因反复失败而回退或跳过任何次要功能：
- 无任何阶段使用 backup_dsh 回滚（备份保持完好，仍可用于回滚）。
- 未触发 Ralph 无限循环；唯一需要多轮修复的是 QA 发现的 **P1 安全漏洞**（1 轮修复 + 独立验证通过），以及若干**测试断言口径**修正（CORS 白名单/自定义 base_url 安全策略导致旧测试期望需更新，属测试脚本适配，非产品缺陷）。
- 说明：阶段四首次 Diff 自动化断言因「空行在单元格中以 &nbsp; 占位」导致文本重建比对误报，修正测试归一化后通过（产品行级 LCS 本身正确，左右两栏逐字重建与旧/新 prompt 完全一致）。

## 3. 验收证据（全部真跑）

### 后端/接口
| 测试 | 结果 |
|---|---|
| `node test-data/server-selftest-sprint-v3.mjs` | ✅ 19/19 |
| `node test-data/server-smoke-v3.mjs` | ✅ 41/41（阶段一全 API，含真实 LLM） |
| `node test-data/server-smoke-v3-p24.mjs` | ✅ 36/36（模型路由/回退、kb/update、generate_questions） |
| `node test-data/e2e/v3-p2-http.mjs` | ✅ 17/17 |
| `node test-data/e2e/v3-security-p1-check.mjs` | ✅ 14/14（恶意 Origin 403、env Key 不回退自定义端、SSRF 拒绝、官方回退连通、chat 回归） |

### 真实浏览器（dsh-ego-browser，http://127.0.0.1:3000）
| 验收 | 结果文件 |
|---|---|
| 阶段一：页面/KB 97/语境/快照/项目 CRUD/0 token/0 错误 | `v3-result-p1.json` pass |
| 阶段二：模型配置中心（厂商联动、空 Key 真实连通 828~981ms、保存单活、无 Key 泄露） | `v3-result-p2a.json`、`v3-result-p2a-sec.json` pass |
| 阶段三：插入变量 7 选项、光标插入、title 中文映射、英文 only、统计正确 | `v3-result-p2b.json` pass |
| 阶段四 a：树搜索（过滤/无匹配/恢复）、KB 编辑（预填/保存/持久化/还原）、Esc 关全局 modal | `v3-result-p4a.json` pass |
| 阶段四 b：清理排版（空行/逗号/标签保留/减少 18 字符）、Token 3000→75% 绿、3501→87.5% 黄、5040→红+超限提示 | `v3-result-p4b.json` pass |
| 阶段四 c：行级 Diff +3/−2、左栏=旧 prompt 逐字、右栏=新 prompt 逐字、Esc 关 Diff/模型弹窗 | `v3-result-p4c.json` pass |
| 阶段四 d：AI 出题（真实 LLM 4 道）、卡片渲染、填入批量 4 条、运行解锁 | `v3-result-p4d.json` pass |

截图：`test-data/e2e/v3p2-01-model-config-modal.png`、`v3p2-02-insert-variable-title.png`、`v3p2-lead-01-model-config.png`、`v3p2-lead-02-insert-variable.png`、`v3p4-01~06`（树搜索/AI 出题/清理排版/Token 超限/Diff/KB 编辑）、`v3p4-lead-01-aigen.png`。

## 4. 当前系统状态

- 服务：`node server.js` 运行于 **http://127.0.0.1:3000**（Express 5，29 条 API，无 token）。
- 启动方式：双击 `启动.bat`（自动启动 + 延迟 2s 打开浏览器）；`npm start` 等价。
- 数据：`data/prompt-studio.db` 完好（integrity_check=ok，projects=3，kb_items=101），新增的测试快照为验收产物（eval_pass=1，无害）。
- 安全：真实 `.env` Key 未被覆盖/泄露（settings 仅安全路径、模型接口无 Key 回显、CORS 本机白名单、自定义端点禁止 env Key 回退）。
- 备份：`backup_dsh/`（V3 前 Cordis 版备份 + RESTORE.ps1）保持完好。
- 已知无阻断问题；少量 P3 可选优化（如 models 无 DELETE 接口、测试快照可清理）不影响使用。

## 5. 最终 QA 与安全收尾

- **QA 最终结论**：P1 修复复审通过（无 env Key 外泄绕过）、无新 P0/P1，V3.0 可交付。
- **P1（发布阻断，已修）**：模型路由「任意 base_url + 自动回退 .env Key」+ 全局 CORS `*` 可被恶意网页跨站窃取真实 Key。修复：非官方端点禁止 env Key 回退、Base URL SSRF 校验（非本机必须 https、禁内网）、CORS 本机白名单 + `/api` 非本机 Origin 403；`v3-security-p1-check.mjs` 14/14。
- **P2-A（已修）**：镜像层中文 `title` 因 `pointer-events:none`+textarea 上层而不可见 → 新增自定义 `#var-tooltip`（mousemove + span rect 命中 + rAF 节流），hover 中文可见、普通文本/滚动/移出隐藏、镜像英文与输入行为不变。最终浏览器复验通过。
- **P2-B（已修）**：Token 边界 80% 与颜色 → `>80% 才黄`（#eab308）、≤80% 绿、>100% 红；3200/3201/4000/4001 边界实测通过。另修 Host 头校验（防 DNS rebinding）+ `X-Frame-Options: DENY`/CSP frame-ancestors/nosniff + SPA fallback 仅无扩展名路径（缺失静态资源返回 404）；`v3-host-security-check.mjs` 11/11。
- **P2-C（既有，非 V3 引入，未改）**：树/菜单/快照行部分用户可控名称仍以 innerHTML 拼接（V2 遗留本地存储型 XSS 风险），建议后续统一 escapeHtml/事件委托。
- **P3（已记录）**：models 无 DELETE 接口/遗留测试模型与测试快照可清理、SSRF IPv6/域名解析残差（需显式 Key+本机工具）、EADDRINUSE 自动 kill、uncaughtException 不退出等，不影响当前使用。
- **logo 修复**：`/public/logo.png` → `/logo.png`，真机 naturalWidth=6402 正常显示。

## 6. 结论

夜间托管执行结束，当前系统状态为 **可运行**，请人类验收。

## 7. 附加交付：全局极简蓝调 UI 重构（用户追加需求）

- 侧边栏 `#f9fafb` / 主区 `#fcfcfc` / 卡片 `#ffffff` / 侧边栏右侧 `1px solid #e5e7eb`；深色 `<pre>` 全部改浅灰 `#f8fafc` + 深灰 `#334155` + 极细边框；弹窗/菜单/Toast 阴影统一 `0 10px 30px rgba(0,0,0,.08)`。
- 防溢出：树文本 ellipsis、Tag 最大 200px + 省略号 + 固定 16×16 关闭按钮、全局弹窗 `max-height:85vh; overflow-y:auto`（实测 816.85px = 85vh，底部按钮可见）。
- 原生清理：`*:focus{outline:none!important}`、输入框 focus 蓝色边框 `#4d6bfe` + 柔光 `0 0 0 3px rgba(77,107,254,.15)`、滚动条 6px 透明轨道 `#cbd5e1`/悬浮 `#94a3b8`。
- 层级与交互：子级项目 `border-left:1px solid #e5e7eb` + margin 22px 引导线；z-index 下拉 9990 / 弹窗 9999 / Toast 10000；图标按钮 Flex 居中 + 0.2s 过渡。
- 真机断言（`dsh-ego-browser`）：① 50 字超长项目名 → 侧边栏未变形、`text-overflow:ellipsis`、clientWidth 170 < scrollWidth 799；② 输入框聚焦 → outline:none、边框 rgb(77,107,254)、box-shadow 柔光；③ 树最底部 “...” 菜单 → 完整显示于视口内（left 81 / width 150）、elementFromPoint 命中菜单项、z-index 9990 > 卡片；④ 子级引导线 1px #e5e7eb；⑤ 全程 0 JS 报错。截图：`s5-01-sidebar-overflow-focus.png`、`s5-02-dropdown-over-card.png`、`s5-03-final-minimal-blue.png`。
