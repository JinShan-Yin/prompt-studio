

<!-- dsh-openwolf:start -->
# Code Map
Generated 2026-11-04T15:47:46.626Z · 38 files · 3986 lines · 0.10s

## ./
- `HARNESS.md` — 38 lines · 本项目是一个**本地单机运行的提示词工程流水线工具**。用于管理未来 500+ 智能体的提示词分层、知识库、自动化评测与发布门禁。
- `cordis.patch.yml` — 13 lines · - insert:
- `package-lock.json` — 414 lines · prompt-studio
- `package.json` — 23 lines
- `requirements.md` — 105 lines · 目标是让写提示词像写代码一样爽，告别纯文本的枯燥。
- `server-ui.js` — 46 lines · PORT, DSH_PORT, server, bodyData, buffer, options · const PORT = 3081;
- `start.cjs` — 65 lines · http, killPort, main · const { spawn, exec } = require('child_process');
- `启动.bat` — 4 lines · @echo off

## plugins
- `plugins/db.js` — 47 lines · DB_PATH, initDb, db · Exports db

## plugins/context-engine
- `plugins/context-engine/index.js` — 206 lines · name, inject, LLM_CONFIG, KB_TEXT_MAX, dbPromise, getDb · Exports name, inject, normalizeContext, contextToReplacements, applyContextReplace +2 more

## plugins/eval-runner
- `plugins/eval-runner/index.js` — 71 lines · name, inject, checkL1, evaluateL2, apply · Exports name, inject, checkL1, evaluateL2, apply

## plugins/kb-manager
- `plugins/kb-manager/index.js` — 101 lines · name, inject, CHUNK_SIZE, parseTxt, apply · Exports name, inject, parseTxt, apply

## plugins/model-gateway
- `plugins/model-gateway/gateway.js` — 62 lines · limit, chatCompletion, baseUrl, url, finalApiKey, res · Exports chatCompletion, safeParseJson
- `plugins/model-gateway/index.js` — 78 lines · name, inject, apply · Exports name, inject, apply

## plugins/project-snapshot
- `plugins/project-snapshot/index.js` — 122 lines · name, inject, LAYER_ORDER, assemblePrompt, readProjectContext, isUsableContextData · Exports name, inject, assemblePrompt, apply

## plugins/release-gate
- `plugins/release-gate/index.js` — 44 lines · name, inject, apply, urlObj, snapshotId, snap · Exports name, inject, apply

## public
- `public/index.css` — 0 lines · [file too large]
- `public/index.full.min.js` — 0 lines · [file too large]
- `public/index.html` — 1221 lines · <!DOCTYPE html>
- `public/logo.png` — 0 lines · [file too large]
- `public/vue.global.prod.js` — 0 lines · [file too large]

## test-data
- `test-data/backend-selftest.mjs` — 267 lines · passed, failed, failures, test, EMPTY_CONTEXT, countOccurrences · normalizeContext,
- `test-data/baseline.png` — 0 lines · [binary]
- `test-data/e2e-report.md` — 95 lines · > 范围：`requirements.md` 模块一（Token 预估 + 变量高亮）+ 模块二（AI 语境提取 / 标签化多选 / 公共基座全局替换）
- `test-data/prompts.md` — 580 lines · <system_instructions>

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
- `test-data/e2e/browser-e2e.js` — 283 lines · result · const result = await page.evaluate(async () => {
- `test-data/e2e/http-smoke.mjs` — 101 lines · BASE, TOKEN, q, pass, results, check · const BASE = process.argv[2] || 'http://127.0.0.1:3081';
<!-- dsh-openwolf:end -->
