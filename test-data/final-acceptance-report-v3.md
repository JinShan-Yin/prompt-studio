# 《V3.0 全周期回顾与最终验收报告》

- 验收角色：Lead（工程总负责人 / 最终验收人）
- 验收时间：2026-11-05（V3.0 交付前最终验收）
- 服务状态：`http://127.0.0.1:3000`（纯 Node/Express，29 条 API，无 token）
- 验收结论：**PASS —— 可交付人类验收**（本次终验直接执行 **158 条断言全绿**；叠加 QA 回归 **39 条** = 近期 **197 条全绿**）

---

## 一、全周期开发回顾

| 阶段 | 交付内容 | 关键验收 |
|---|---|---|
| V1/V2 基线 | 项目树/分层提示词编辑/知识库/评价门禁基础 | commit `ce434c6`、`1561f05` |
| Sprint 1 | Token 实时预估（0.6 系数+50ms 防抖）、`{{变量}}` 双层镜像高亮、AI 语境提取、标签化多选、公共基座全局替换（`$&` 注入安全） | selftest 25/25、HTTP smoke、浏览器 e2e；修复 `context_json` 迁移 500 |
| Sprint 2 | 知识库实时搜索/冲突检测/TXT 批量导入、多轮对话模拟器、批量回归（进度条+通过率+失败报告）、竞态双守卫 | 25/25 + 23/23；批量/聊天/导入/回滚竞态修复 |
| Sprint 3 | 快照回滚、API Key 设置（掩码/原子写 `.env`）、复制 NewLync Text、Ctrl+S、Zip 导出、UI 统一 | 22/22 + 23/23；CQO 验收 |
| CQO 零容忍 | 修复 3 个真实缺陷：导出缺实时 `PROJECT_NAME` + 缓存、复制首部空行、`window.open` 下载不可靠 | CQO 四维全 PASS：**生产级标准验收通过** |
| V3.0 阶段一 | 彻底独立化：`server.js`（Express 5 / 3000）、24 API 内联、DB 初始化内联、静态托管、端口自动释放、删除 token、废弃 Cordis/plugins/旧启动链路 | 静态 18/18、API smoke 41/41、浏览器 CRUD E2E |
| V3.0 阶段二 | 多模型路由中枢：`model_configs` 单活、`/api/models*`、`chatCompletion` DB→`.env` 回退、模型配置中心 UI | 17/17、真实 LLM 路由验证 |
| V3.0 阶段三 | 中文化交互：插入变量中文下拉、镜像中文 tooltip（修复原生 title 不可见） | E2E 全部通过 |
| V3.0 阶段四 | KB 在线编辑、树搜索、AI 刁钻出题、一键清理排版、Token 4000 红线、行级 LCS Diff、Esc 分层 | 浏览器逐项 E2E |
| 安全加固（P1） | 修复「任意 base_url + env Key 回退」跨站窃取通道：官方域名白名单、SSRF 校验、CORS 本机白名单、Host 头校验、安全响应头 | 安全 14/14 + Host/头 11/11 |
| 视觉重构 | 极简蓝调 → 商业级精修：品牌蓝 `#4d6bfe`、次按钮去色、16px 卡片+柔光、Header 玻璃拟态、Token 三色、Tag 防溢出 | 视觉断言全过 |
| QA 自动化回归 | 6 套件 39 条断言（真实浏览器+网络探针），发现并修复启动脚本编码/引号、排版逗号折叠、window Esc、视觉规格 4 类 Bug | **39/39 PASS** |

**研发方法论**：需求分阶段 → change-review/git 安全屋（`bcdf75b`→`24357bc`→`b5d431e`→`ba29b61`→`557e6ac`→UI→`199fbfe`）→ 每个 UI/逻辑改动必须真浏览器验证 → 安全问题零容忍（QA 独立对抗审查）→ 最终全量回归。

---

## 二、最终验收方案（12 维审查矩阵）

| # | 维度 | 验收标准（阈值） | 验收方法 / 证据 |
|---|---|---|---|
| 1 | 架构与启动 | 纯 Node/Express 单文件；无 Cordis/plugins/token；`启动.bat` 启动后 HTTP 200；端口冲突可自愈 | 静态审查 + `启动.bat` 实测 + 29 路由清单 |
| 2 | API 契约与回归 | 所有既有接口 2xx/4xx/404 语义正确，CQO 生产细节保留 | 后端 6 套件：selftest 19、smoke 41、p24 36、p2 17 |
| 3 | 安全与密钥 | 全站无完整 Key 泄露；只有官方 DeepSeek 可回退 `.env`；CORS/Host/SSRF/XSS 防护 | security 14/14、host 11/11、DOM `sk-` 扫描、网络探针 |
| 4 | 数据完整性 | `integrity_check=ok`；迁移幂等；CRUD 持久化 | DB 只读核查 + KB/项目/快照刷新页面回归 |
| 5 | 并发与竞态 | 长任务双守卫、运行中禁用、不串项目 | 历史竞态修复 + 代码审查（批量/聊天/导入/回滚） |
| 6 | 编辑器核心 | 双层镜像 `scrollHeight` 误差 ≤2px、滚动同步、IME 防误触、`$&`/`<script>` 原样保留、Token 防抖 | 浏览器 E2E（50 变量/50 换行/994 字） |
| 7 | 多模型路由 | Kimi 等第三方模型请求发往配置 URL 且携带配置 Key；失败自动回落 `.env` | Node fetch 探针（脱敏）：`api.moonshot.cn` + `sk-kim****7890` |
| 8 | 功能完整性 | 四阶段全部功能可用；7 项阶段四逐项通过 | 浏览器终验 + QA 39 断言 |
| 9 | 视觉系统 | 品牌蓝/圆角/阴影/玻璃/悬浮/省略号/z-index/焦点态规格 | computedStyle 断言 + 截图 |
| 10 | 性能与响应 | DOMContentLoaded <3s、1000 字渲染 <500ms、防抖正确、200 次高频输入 <1.5s | 性能脚本 4/4（实测 55ms / 3ms / 323ms） |
| 11 | 工程卫生 | 文档与架构一致、无死文件、备份可用、依赖锁定 | HARNESS.md 重写、AGENTS 代码图刷新、删除 1.4MB 无引用 Vue/CSS、`backup_dsh` 完整 |
| 12 | 交付与回滚 | 一键启动；备份/安全屋可回滚；已知风险透明 | `启动.bat` 实测 200；`RESTORE.ps1` + Git 提交链 |

---

## 三、本次终验执行结果（真实数据）

### 3.1 后端自动化（6 套件）
| 套件 | 结果 |
|---|---|
| `server-selftest-sprint-v3.mjs` | ✅ 19/19 |
| `server-smoke-v3.mjs`（阶段一全 API + 真实 LLM） | ✅ 41/41 |
| `server-smoke-v3-p24.mjs`（模型路由/KB/出题） | ✅ 36/36 |
| `v3-p2-http.mjs` | ✅ 17/17 |
| `v3-security-p1-check.mjs` | ✅ 14/14 |
| `v3-host-security-check.mjs` | ✅ 11/11 |
| **小计** | **138/138** |

### 3.2 浏览器终验（真实 Chromium）
- 核心闭环与视觉 **16/16 PASS**：项目树、KB 97 条、语境回填、快照列表、模型中心开合、Token 75%蓝/88%橙/100%红、超长 Tag 150px 省略号、清理排版、树搜索、行级 Diff、品牌蓝主按钮、16px 卡片+柔光、Header `blur(12px)`、选中项品牌蓝、**0 JS Error**；交互总耗时约 9.5s。
- 性能 **4/4 PASS**：DOMContentLoaded 55ms、1000字/50变量渲染 3ms（镜像同步误差 0）、Token 防抖 5000字→3000 Token、200 次高频 input 323ms。

### 3.3 安全与数据
- 模型接口仅 `has_key/masked_key`（完整 Key 0 泄露）；恶意 Origin/Host 均 403；安全头齐全；导出含实时 `PROJECT_NAME` + `no-store`；Zip 合法。
- DB：`integrity_check=ok`；companies=1、projects=3、kb=101、snapshots=49、model_configs=12（单活=1）、context_json 已持久化 3 个项目。
- 启动：`启动.bat` → `HTTP 200`；正式服务运行中（PID 9964）。

### 3.4 工程卫生（本次发现并修复）
| 发现 | 严重度 | 处理 |
|---|---|---|
| `HARNESS.md` 仍描述 Cordis/3081/token 旧架构（与 V3.0 事实不符） | P2-文档 | **已重写为 V3.0 架构规范**（57 行，含安全红线/测试基线/回滚） |
| `AGENTS.md` 代码图仍含已删除的 plugins/server-ui 等旧条目 | P3-文档 | **已执行 `wolf_refresh` 重扫**（268 文件 / 7545 行） |
| `public/` 下遗留 3 个无引用前端文件（Vue 构建产物~1.4MB） | P3-卫生 | **已删除**；`public/` 仅剩 `index.html` + `logo.png`（纯原生铁证） |

### 3.5 已知 P2/P3（非阻断，已透明记录）
- P2（既有，非 V3 引入）：树/菜单/快照行部分用户可控名称仍以 innerHTML 拼接（本地存储型 XSS 面，建议统一 `escapeHtml`）。
- P3：DB 有历史测试快照/模型行累积（无删除 API）；SSRF 残差（IPv6/域名解析私网，仅本机显式 Key 可用）；EADDRINUSE 会清理占用 3000 的进程；`uncaughtException` 仅记录不退出；本地无鉴权（仅监听 127.0.0.1）。

---

## 四、最终判定

| 验收维度 | 结论 |
|---|---|
| 功能完整性 | PASS（四阶段 + 历史 Sprint 全部可复跑） |
| 安全性 | PASS（无 P0/P1 遗留；P1 已修复并独立复审） |
| 数据与持久化 | PASS（integrity ok；持久化闭环验证） |
| 视觉与体验 | PASS（品牌蓝/玻璃/圆角/防溢出/焦点态全达标） |
| 性能 | PASS（加载 55ms，渲染 3ms） |
| 工程可维护性 | PASS（文档已同步、死文件已清、备份/安全屋完整） |
| 交付可用性 | PASS（`启动.bat` 一键启动 HTTP 200） |

**最终结论：V3.0 全周期开发与最终验收完成，本次直接执行 158 条断言全部通过（叠加 QA 回归 39 条 = 197 条近期全绿），无 P0/P1 遗留，系统可交付人类验收。**
