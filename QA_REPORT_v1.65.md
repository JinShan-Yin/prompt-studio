# V1.65.0 QA 报告

日期：2026-11-26 ｜ 环境：本机 Windows / Node v24 ｜ 生产 `data/newrock.db` 在回归期间未被写入（仅在线备份）

## 一、结论

| 测试 | 结果 | 说明 |
|---|---|---|
| 后端冒烟 `scripts/smoke-v1.65.mjs` | **142 / 142 通过** | 临时数据目录（`data/tmp/smoke165-*`），V1.64 全部基线 + V1.65 六项 |
| 页面全按钮回归（DOM 级） | **123 / 123 通过** | jsdom 执行真实页面脚本 + 真实 3101 服务 + mock LLM |
| 事件处理函数清单校验 | **113 / 113 已定义** | `scripts/qa-button-inventory.mjs` |
| 文案守卫 `scripts/qa-wording.mjs` | **白名单外 0 条** | 44 行仍含「快照」，全部为备份域文案 / 注释 / 服务端日志 |
| 未捕获 JS 异常 | **0** | 回归全程收集 `jsdomError` |
| 非预期 alert | **0** | 错误均走 toast |

隔离方式：冒烟使用 `data/tmp/smoke165-*`；DOM 回归使用 `.qa-test/data`（3101，每轮重建）；生产库仅执行一次在线备份。

## 二、V1.65 专项覆盖

### 1) 审计日志分页与筛选（A）

- 默认分页：`page=1&page_size=10` 返回 10 条、`total > 10`、`has_more=true`；第 2 页与第 1 页无重复 id。
- 级别筛选：`level=Warn` 每行均为 Warn，且 `summary.warn === total`。
- 时间范围：`from=昨天 / to=明天` 命中；时间倒置 → 400 `INVALID_RANGE`；`from=not-a-date` → 400。
- 用户筛选：`user_id=user-admin` 全部命中该用户；关键词 `q=login` 命中动作/详情/对象/用户名。
- `page_size=999` 归一为 200；`summary.info + warn + danger === total`；普通用户 403。
- 前端：筛选控件齐备、默认「第 1 / N 页」、级别/时间/重置/关键词筛选均刷新成功。
- 落库校验（QA 库）：`idx_audit_logs_created / idx_audit_logs_user / idx_audit_logs_action` 三个索引已创建。

### 2) 用量逐条明细导出（B）

- `mode=detail`：HTTP 200、`text/csv`、UTF-8 BOM、表头含「项目」「耗时ms」、末行「合计」、数据行 > 1。
- 过滤：`user_id=no-such-user` → 仅表头 + 合计两行。
- 超限：`max_rows=1`（库中 3 条调用）→ 400 `TOO_MANY_ROWS` 且返回 `total`。
- 非法 `mode` → 400；普通用户 403；聚合导出回归仍 200 且含 BOM/合计。
- 前端：明细按钮存在，点击走 `fetch → blob` 并提示「已导出最近 N 天明细」。

### 3) 提交记录版本备注编辑（E）

- 创建带备注提交 → `message` 为「提交成功」；更新为「新备注」→ 列表回显；清空（空格）→ `remark=''`；300 字截断为 200；非字符串 400；不存在 404。
- 权限：只读授权用户（`read_grants`）更新 → 403；超管代管改他人记录 → 审计 `snapshot_remark_update`（自动 Warn）。
- 前端：备注单元格可点击 → 弹窗预填当前值 → 保存后列表即时生效。

### 4) 只读编辑器可见性（C）

- 可写状态：`#val-system` 生效背景为 `transparent`（alpha=0）。
- 只读状态（`body.public-readonly`）：生效背景 `var(--readonly-tint)` → `rgba(15,23,42,0.10)`（alpha=0.1 < 1，正文可透出），边框 `dashed`。
- 校验方式：遍历 `<style>` 规则、用 `Element.matches` 命中编辑器、按 specificity + 顺序求最终生效声明（jsdom 自带 `getComputedStyle` 级联不完整，故自实现求值）。
- 结论：原「不透明 #f8fafc + textarea 文字透明」导致正文不可见的缺陷已消除。

### 5) 首登慢修复（D）

- `public/index.html` 不再引用 `cdn.bootcdn.net`，两条脚本指向 `/vendor/marked.min.js`、`/vendor/purify.min.js`。
- 未登录 `GET /vendor/marked.min.js` → 200 `application/javascript`（原为 302 到登录页）。
- 独立 jsdom（`resources:'usable'`）加载两个 vendor 文件成功：`marked.parse` 可用、`DOMPurify.sanitize` 可用。
- 服务端访问日志新增 ISO 时间戳（QA 日志已确认格式）。

### 6) 文案口径（F）

- 批量删除后 toast **恰为「已删除」**，不含「快照」。
- 全站用户可见文案统一「提交记录」；服务端 `snapshots/detail` 404 文案为「提交记录不存在」且不含「快照」。
- 备份域「启动前快照」保留（备份面板正常）。
- `qa-wording` 白名单外 0 条。

## 三、本轮发现并处理的问题

| # | 问题 | 处理 |
|---|---|---|
| D1 | 冒烟「明细超上限」用例只产生了 1 条 `llm_usage`，`max_rows=1` 不会触发 400 | 在 mock LLM 关闭前补 2 次对话调用，使总量 > 1 |
| D2 | jsdom `getComputedStyle` 不按 specificity 级联，无法验证只读背景 | 自实现「规则匹配 + specificity + 顺序」求值，并解析 `var(--readonly-tint)` |
| D3 | 只读背景声明是 CSS 变量，初次断言把 `var(...)` 当颜色导致误判 | 从样式源码解析变量实际值后再判断 alpha |
| D4 | `DOMPurify` 是函数（带 `.sanitize`），断言误写为 object | 改为 `function || object` 且校验 `.sanitize` |
| D5 | 文案守卫首跑命中一行行尾注释 `// 一次性拉取的全部快照` | 改写注释为「全部提交记录」，保持守卫「白名单外 0 条」 |

## 四、残余风险

1. **知识库大文档仍不自动分块**（本版明确不做）：LLM 模式全量并发、失败块静默、`parse-markdown` 同步阻塞事件循环；大文档仍需人工拆分。
2. **真实浏览器像素级回归不可用**：本机 IPC 限制未变，jsdom 不校验布局；只读编辑器、审计工具栏、明细按钮建议上线后人工抽查一次。
3. **`limit` 上限收紧为 200**：若有外部脚本依赖 1000 条一次性拉取，需改用 `page/page_size` 翻页。
4. **明细导出为一次性内存拼接**：5 万行约 10–15MB，上限内可接受；更大范围会返回 400 而不是流式导出。
5. **审计关键词为 `LIKE '%…%'`**：时间范围收窄后走索引，但纯关键词大范围查询仍是范围扫描（当前 51 行为毫秒级）。

## 五、复跑方式

```powershell
# 后端冒烟（零依赖、临时数据目录）
node scripts/smoke-v1.65.mjs
# 期望 RESULT pass=142 fail=0

# 页面全按钮回归（jsdom，仅装在 .qa-test）
powershell -NoProfile -ExecutionPolicy Bypass -File .qa-test\run-dom.ps1
# 期望 RESULT pass=123 fail=0

# 事件处理函数清单
node scripts/qa-button-inventory.mjs
# 期望 [qa] 共 113 个页面事件处理函数

# 文案守卫
node scripts/qa-wording.mjs
# 期望 白名单外 0 条
```
