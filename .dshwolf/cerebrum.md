# Cerebrum

Learned preferences, project conventions, and corrections.

## Preferences

## Conventions

- 前端 public/index.html 必须纯原生且中文输入法安全：Tag/输入 keydown 处理 Enter 前先判 `e.isComposing || e.keyCode === 229`；禁用原生 alert/confirm，复用 #global-modal/showToast。
- Prompt Studio 的 DB 迁移统一放 plugins/db.js：CREATE TABLE 内加列 + PRAGMA table_info 检查后幂等 ALTER，现有项目/知识库/快照数据不得破坏。
## Do-Not-Repeat

