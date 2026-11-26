# V1.64.0 QA 报告

日期：2026-11-26 ｜ 环境：本机 Windows / Node v24 ｜ 生产库在回归期间未参与（最后才重启生产服务）

## 一、结论

| 测试 | 结果 | 说明 |
|---|---|---|
| 后端冒烟 `scripts/smoke-v1.64.mjs` | **115 / 115 通过** | 临时数据目录，V1.63.1 全部基线 + V1.64 回收站批量/保留期/清理 + 用量 CSV/阈值告警 |
| 页面全按钮回归（DOM 级） | **105 / 105 通过** | jsdom 执行真实页面脚本 + 真实 3101 服务 + mock LLM |
| 事件处理函数清单校验 | **109 / 109 已定义** | `scripts/qa-button-inventory.mjs` 生成清单，回归末尾逐个断言 |
| 未捕获 JS 异常 | **0** | 回归全程收集 `jsdomError` |
| 非预期 alert | **0** | 错误均走 toast |

隔离方式：冒烟使用 `data/tmp/smoke164-*`；DOM 回归使用 `.qa-test/data`（3101）；生产 `data/newrock.db` 全程未打开。

## 二、V1.64 专项覆盖

### 回收站

- 列表返回 `batch / type_counts / total_all / next_purge_at / last_purge_at`；面板显示总数、各类型条数、下次自动清理时间。
- 当前页复选框 + 全选 / 取消全选；「彻底删除所选」走确认后提交 `purge-batch`。
- 按删除批次清理：公司/项目级联后，子记录返回 `skipped` 而非失败；冒烟验证 `purged=1, failed=0`。
- 上限与校验：单次 >200 条返回 400；空批次返回 400；普通用户 403。
- 保留期 7/15/30/60/90：超管可改并持久化；0 天返回 400；普通用户读写均 403。
- 「立即清理过期」：无过期记录返回 `purged=0`；普通用户 403；操作写 Danger 审计。

### 用量

- CSV 导出：HTTP 200、`text/csv; charset=utf-8`、UTF-8 BOM（EF BB BF）、含「日期」表头与「合计」行；普通用户 403。
- 阈值：负数 400；超管可读写；普通用户写 403。
- 告警：阈值 1 时返回 `alerts`（tokens/today），面板显示黄色告警条；阈值改回 0 后告警条隐藏；不阻断任何业务请求。

## 三、本轮发现并处理的问题

| # | 问题 | 处理 |
|---|---|---|
| D1 | 同路径 `GET/POST` 若分两次 `route()` 注册，`app.all` 会先返回 405（v1.63 曾出现） | 回收站设置、用量设置均合并为单条 `route(['GET','POST'])`，按方法分支 |
| D2 | 冒烟里「按批次清理」误期望 `skipped>=1`：按 `{type,batch}` 只扫该表，子表不在目标列表 | 修正断言：`purged=1`，级联清理由后续「知识条目不可见」断言覆盖 |
| D3 | `fetch().text()` 会剥离 UTF-8 BOM，导致 BOM 断言误判 | 改为读 `arrayBuffer` 后检查前 3 字节 EF BB BF |

## 四、残余风险

1. **保留期修改不立即删除**：按设计在下一次自动清理（启动 90 秒后首次，之后每 24h）生效；面板已提示「下次自动清理」时间。
2. **告警按 UTC 日切分**：与 `llm_usage.created_at` 存储口径一致；如需本地时区日切需另行调整。
3. **CSV 为聚合行**：不导出逐条调用明细，避免大表拖垮内存；如需明细可后续加分页导出。
4. **真实浏览器像素级回归仍不可用**：本机 IPC 限制未变，jsdom 不校验布局；上线前建议人工抽查回收站/用量面板。
5. **批量彻底删除不可恢复**：已有二次确认与 200 条上限，但仍建议管理员操作前确认。

## 五、复跑方式

```powershell
# 后端冒烟（零依赖、临时数据目录）
node scripts/smoke-v1.64.mjs
# 期望 RESULT pass=115 fail=0

# 页面全按钮回归（jsdom，仅装在 .qa-test）
powershell -NoProfile -ExecutionPolicy Bypass -File .qa-test\run-dom.ps1
# 期望 RESULT pass=105 fail=0

# 事件处理函数清单
node scripts/qa-button-inventory.mjs
# 期望 [qa] 共 109 个页面事件处理函数
```
