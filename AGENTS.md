

<!-- dsh-openwolf:start -->
# Code Map
Generated 2026-11-05T00:02:43.578Z · 268 files · 7545 lines · 0.50s

## ./
- `HARNESS.md` — 57 lines · 本地单机运行的**提示词工程流水线工具**：管理分层提示词（L0/L1/L2/L3.5/L3）、知识库、多轮对话评测、自动化回归与发布门禁。
- `package-lock.json` — 0 lines · [file too large]
- `package.json` — 26 lines
- `requirements.md` — 105 lines · 目标是让写提示词像写代码一样爽，告别纯文本的枯燥。
- `server.js` — 0 lines · [file too large]
- `启动.bat` — 13 lines · @echo off

## public
- `public/index.html` — 0 lines · [file too large]
- `public/logo.png` — 0 lines · [file too large]

## scripts
- `scripts/restart-server.cjs` — 68 lines · net, PORT, listListeningPids, killPids, waitPortFree · const { execSync, spawn } = require('child_process');

## test-data
- `test-data/backend-selftest-sprint2.mjs` — 448 lines · passed, failed, failures, sections, currentSection, startSection · buildChatSystemPrompt,
- `test-data/backend-selftest-sprint3.mjs` — 255 lines · passed, failed, failures, sections, currentSection, startSection · maskApiKey,
- `test-data/backend-selftest.mjs` — 267 lines · passed, failed, failures, test, EMPTY_CONTEXT, countOccurrences · normalizeContext,
- `test-data/baseline.png` — 0 lines · [binary]
- `test-data/batch-regression-sample.json` — 21 lines · [
- `test-data/e2e-report-cqo.md` — 85 lines · > 验收角色：生产环境首席质量官（CQO）
- `test-data/e2e-report-sprint2.md` — 92 lines · > 范围：`requirements.md` **模块三（知识库增强）** + **模块四（多轮测试与批量回归）**
- `test-data/e2e-report-sprint3.md` — 89 lines · > 范围：`requirements.md` **模块五（版本与安全）**、**模块六（生态融合与快捷键）**、**模块七（UI 审查）**
- `test-data/e2e-report-v3.md` — 88 lines · > 执行模式：夜间无人值守 · 四阶段自动递进 · 每阶段 change-review/git 安全屋存档
- `test-data/e2e-report.md` — 95 lines · > 范围：`requirements.md` 模块一（Token 预估 + 变量高亮）+ 模块二（AI 语境提取 / 标签化多选 / 公共基座全局替换）
- `test-data/prompts.md` — 580 lines · <system_instructions>
- `test-data/qa-regression-report-v3.md` — 93 lines · - 测试时间：2026-11-05（夜间/清晨）
- `test-data/server-selftest-sprint-v3.mjs` — 223 lines · ROOT, SERVER_PATH, passed, failed, failures, test · const ROOT = process.cwd();
- `test-data/server-smoke-v3-p24.mjs` — 247 lines · BASE, PROJECT_ID, MODEL_DISPLAY_NAME, BAD_MODEL_DISPLAY_NAME, passed, failed · const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
- `test-data/server-smoke-v3.mjs` — 241 lines · BASE, PROJECT_ID, passed, failed, results, check · const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');

## test-data/e2e
- `test-data/e2e/01-longtext-highlight-align.png` — 0 lines · [file too large]
- `test-data/e2e/02-longtext-bottom-crossline-var.png` — 0 lines · [file too large]
- `test-data/e2e/03-snapshot-success-toast.png` — 0 lines · [file too large]
- `test-data/e2e/04-empty-kb-toast.png` — 0 lines · [file too large]
- `test-data/e2e/05-editor-card-stats-highlight.png` — 0 lines · [file too large]
- `test-data/e2e/06-final-context-refilled.png` — 0 lines · [file too large]
- `test-data/e2e/07-snapshot-list-new-row.png` — 0 lines · [file too large]
- `test-data/e2e/08-context-save-racefix-final.png` — 0 lines · [file too large]
- `test-data/e2e/09-lead-editor-longtext-top.png` — 0 lines · [file too large]
- `test-data/e2e/10-lead-editor-longtext-scrolled.png` — 0 lines · [file too large]
- `test-data/e2e/11-lead-final-ui.png` — 0 lines · [file too large]
- `test-data/e2e/12-kb-conflict-modal-red.png` — 0 lines · [file too large]
- `test-data/e2e/13-kb-import-batch.png` — 0 lines · [file too large]
- `test-data/e2e/14-chat-multiturn-bubbles.png` — 0 lines · [file too large]
- `test-data/e2e/15-batch-progress-running.png` — 0 lines · [file too large]
- `test-data/e2e/16-batch-report.png` — 0 lines · [file too large]
- `test-data/e2e/17-batch-sample-report.png` — 0 lines · [file too large]
- `test-data/e2e/18-final-ui-sprint2.png` — 0 lines · [file too large]
- `test-data/e2e/_qa_extract.js` — 0 lines · [file too large]
- `test-data/e2e/batch-regression-deterministic.json` — 5 lines · [
- `test-data/e2e/browser-e2e.js` — 283 lines · result · const result = await page.evaluate(async () => {
- `test-data/e2e/cqo-a1-full-replace.js` — 77 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-a2-empty-fallback.js` — 41 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-a3-injection.js` — 42 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-b1-align-tags.js` — 64 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-b2-ime-debounce.js` — 60 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-c1-cross-project.js` — 61 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-c2-rename-header.js` — 70 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-clipboard-pasted.txt` — 7 lines · 【CQO 剪贴板验收】你是 剪贴板行业Y 语音客服。
- `test-data/e2e/cqo-copied-newlync.txt` — 7 lines · CQO_D_L0 行业=COPY行业X 目标=通用
- `test-data/e2e/cqo-d-copy-purity.js` — 62 lines · out, fs · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-e-alignment-shots.js` — 29 lines · out, sleep, ta, mirror, lines, indent · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-f-final-snapshot.js` — 41 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/cqo-final-a1.json` — 0 lines · {"pass":true,"snapshotId":"snap-5b43d86a","finalPrompt":"\n\n### 全局安全 (L0)\nCQO_A1_L0 行业=CQO行业A 目标=CQO目标A 结尾L0\n\n### 语音基座 (L1)\nCQO_A1_L1 行…
- `test-data/e2e/cqo-final-a2.json` — 0 lines · {"pass":true,"snapshotId":"snap-e2a9b0c4","genericCount":7,"braces":0,"emptyAssign":false,"finalPrompt":"\n\n### 全局安全 (L0)\nCQO_A2_L0 行业=通用 …
- `test-data/e2e/cqo-final-a3.json` — 0 lines · {"pass":true,"snapshotId":"snap-b39051c8","inject":"$&$& <script>alert(1)</script> \\n","industryCount":3,"keepsScript":true,"keepsSlashN":t…
- `test-data/e2e/cqo-final-b1.json` — 0 lines · {"pass":true,"text":{"length":11842,"lines":223,"chars":11842,"newlines":222,"brCount":223},"alignment":{"styleDiff":[],"wDiff":0,"textMatch…
- `test-data/e2e/cqo-final-b2.json` — 0 lines · {"pass":true,"ime":{"before":0,"afterSpace":0,"afterComposition":0,"afterEnter":1},"debounce":{"baseChars":2636,"immediateChars":2636,"settl…
- `test-data/e2e/cqo-final-c1.json` — 0 lines · {"pass":true,"A":{"snapshotId":"snap-34a1e3e2","fpHead":"\n\n### 全局安全 (L0)\nA项目测试 行业=PROJ_A_行业_9F3\n\n### 语音基座 (L1)\nA项目 L1\n\n### 项目话术 (L3)…
- `test-data/e2e/cqo-final-export.txt` — 16 lines · 你是面向 星汇Mall 领域的智能语音客服助手。
- `test-data/e2e/cqo-final-summary-1.json` — 0 lines · {"cqo-final-a1":{"pass":true},"cqo-final-a2":{"pass":true},"cqo-final-a3":{"pass":true},"cqo-final-b1":{"pass":true},"cqo-final-b2":{"pass":…
- `test-data/e2e/cqo-result-a1.json` — 0 lines · {"pass":false,"snapshotId":"snap-b79be96f","finalPrompt":"\n\n### 全局安全 (L0)\nCQO_A1_L0 行业=CQO行业A 目标=CQO目标A 结尾L0\n\n### 语音基座 (L1)\nCQO_A1_L1 …
- `test-data/e2e/cqo-result-a2.json` — 0 lines · {"pass":false,"snapshotId":"snap-97fadfab","genericCount":7,"braces":0,"emptyAssign":false,"finalPrompt":"\n\n### 全局安全 (L0)\nCQO_A2_L0 行业=通用…
- `test-data/e2e/cqo-result-a3.json` — 0 lines · {"pass":true,"snapshotId":"snap-477402bd","inject":"$&$& <script>alert(1)</script> \\n","industryCount":3,"keepsScript":true,"keepsSlashN":t…
- `test-data/e2e/cqo-result-b1.json` — 0 lines · {"pass":true,"text":{"length":11842,"lines":223,"chars":11842,"newlines":222,"brCount":223},"alignment":{"styleDiff":[],"wDiff":0,"textMatch…
- `test-data/e2e/cqo-result-b2.json` — 0 lines · {"pass":true,"ime":{"before":0,"afterSpace":0,"afterComposition":0,"afterEnter":1},"debounce":{"baseChars":2636,"immediateChars":2636,"settl…
- `test-data/e2e/cqo-result-c1.json` — 0 lines · {"pass":true,"A":{"snapshotId":"snap-b9da962e","fpHead":"\n\n### 全局安全 (L0)\nA项目测试 行业=PROJ_A_行业_9F3\n\n### 语音基座 (L1)\nA项目 L1\n\n### 项目话术 (L3)…
- `test-data/e2e/cqo-result-c2.json` — 0 lines · {"pass":false,"snapshotId":"snap-b9da962e","menuOpened":true,"renameItemFound":true,"modalOpened":true,"inputValueBefore":"Trip旅游AI接线员","ren…
- `test-data/e2e/cqo-result-c2b.json` — 0 lines · {"pass":false,"snapshotId":"snap-b9da962e","menuOpened":true,"renameItemFound":true,"modalOpened":true,"inputValueBefore":"Trip旅游AI接线员_CQO_R…
- `test-data/e2e/cqo-result-c2c.json` — 0 lines · {"pass":true,"snapshotId":"snap-b9da962e","menuOpened":true,"renameItemFound":true,"modalOpened":true,"inputValueBefore":"Trip旅游AI接线员","rena…
- `test-data/e2e/cqo-result-c2d.json` — 0 lines · {"pass":true,"snapshotId":"snap-b9da962e","menuOpened":true,"renameItemFound":true,"modalOpened":true,"inputValueBefore":"Trip旅游AI接线员","rena…
- `test-data/e2e/cqo-result-clipboard.json` — 0 lines · {"clip":null,"err":"Failed to execute 'readText' on 'Clipboard': Document is not focused.","expected":"### 全局安全 (L0)\n【CQO 剪贴板验收】你是 剪贴板行业Y 语…
- `test-data/e2e/cqo-result-d.json` — 0 lines · {"pass":false,"checks":{"nonEmpty":true,"noLeadingBlank":false,"noTrailingBlank":true,"noHtmlTags":true,"noCssResidue":true,"noUiText":true,…
- `test-data/e2e/cqo-result-d2.json` — 0 lines · {"pass":true,"checks":{"nonEmpty":true,"noLeadingBlank":true,"noTrailingBlank":true,"noHtmlTags":true,"noCssResidue":true,"noUiText":true,"n…
- `test-data/e2e/cqo-result-debug-cache.json` — 0 lines · {"before":"Trip旅游AI接线员","rename":{"success":true,"message":"修改成功"},"dbNow":"Trip旅游AI接线员_RENAMED_DEBUG3","headPlain":"# SNAPSHOT: snap-b9da96…
- `test-data/e2e/cqo-result-e-alignment.json` — 0 lines · {"chars":11846,"lines":223,"spans":221,"styleDiff":[],"rectDiff":{"top":0,"left":0,"width":0,"height":0},"heights":{"ta":4926,"mirror":4926,…
- `test-data/e2e/cqo-result-f.json` — 0 lines · {"pass":true,"snapshotId":"snap-fea1d52f","rows":25,"firstRowBtnText":"下载 TXT","finalPrompt":"\n\n### 全局安全 (L0)\n你是面向 星汇Mall 领域的智能语音客服助手。\n当…
- `test-data/e2e/final-acceptance-browser.js` — 99 lines · out · const out = await page.evaluate(async () => {
- `test-data/e2e/final-acceptance-perf-result.json` — 0 lines · {"results":[{"name":"F2.1 页面导航加载（DOMContentLoaded < 3000ms）","ok":true,"detail":{"domContentLoaded":55,"load":58}},{"name":"F2.2 1000字/50变量渲…
- `test-data/e2e/final-acceptance-perf.js` — 48 lines · out · const out = await page.evaluate(async () => {
- … 184 more file(s)
<!-- dsh-openwolf:end -->
