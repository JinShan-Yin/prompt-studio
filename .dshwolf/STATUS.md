# STATUS

## 🚀 Next phase

**V2.0 全部 Sprint（1-3）已完成，等待用户最终全盘验收。**
后续可选：Sprint 4 —— 全局变量库/项目克隆/拖拽组装/模板市场（模块二剩余项）、Diff 对比、RBAC 与敏感接口鉴权、历史测试快照清理。

## ✅ Done

- Sprint 1：Token 预估 + {{变量}} 高亮（镜像 div + 透明 textarea）；AI 语境提取 + 标签多选 + 公共基座全局替换 + context_json 迁移。
- Sprint 2：KB 实时搜索 / 冲突检测（红色 modal + 横幅）/ TXT 批量导入；多轮对话模拟器（/api/chat/reply）；批处理回归（手动 fetch 循环 + 进度条 + 通过率报告）。
- Sprint 3：快照回滚 + API Key 设置（settings-engine，masked + .env/process.env）；复制为 NewLync Text；Ctrl+S 快捷键；/api/projects/export_zip（archiver@8）；模块七 UI 规范精修（indigo 主色 + 深色侧边栏 + 统一 hover/focus/间距/对比度）。
- 验收：S1/S2/S3 后端单测 25/25、25/25、22/22；HTTP 冒烟 23/23；Lead 浏览器 E2E（回滚/快捷键/APIKey/复制/Zip 下载/UI/回归）全通过；QA 审查无 P0/P1（1 个 P2 回滚竞态已修复复审通过）。

## 🧭 Notes

- 启动：`启动.bat` → start.cjs → dsh web --patch(3080) + server-ui(3081)。
- 真实 API Key 未被改动；有效 Key 写入路径需用户在 ⚙️ 弹窗输入新 Key 后生效（.env + process.env）。
- archiver@8 为纯 ESM，使用 `ZipArchive` 命名导出。
- 服务当前运行中；页面干净（Trip 项目、KB 97、快照 16、聊天/批量空态）。
- 报告：test-data/e2e-report.md / e2e-report-sprint2.md / e2e-report-sprint3.md；截图 test-data/e2e/。
