# V5.0 阶段二（前端 Tab 大改造）验收报告

- 角色：高级前端工程师 / Lead 验收人
- 日期：2026-11-05
- 依据：`PRD-V5.0.md` + `TASK-Phase-2-Frontend.md`
- 改造方式：**对现有 `public/index.html` 做增量改造，未推倒重写**；V4 已有卡片的 DOM、ID、事件与函数全部保留。另对 `server.js` 增加公共参考项目只读可见/写保护最小后端支撑。

## 一、六个步骤完成情况

### 步骤一：Tab 导航骨架与 Header ✅
- 右侧三层结构：Header（当前项目 + 剩余试用 + 设置/备份/快捷键/退出登录）→ 四大 Tab 栏 → 内容区。
- 已删除“本地开发环境”字样。
- “当前项目：XXX”颜色/字号/字重与左侧选中项完全一致（实测：`rgb(77,107,254) / 600 / 14px` 双方一致）。
- Tab：📝 提示词编辑 / 📚 知识库管理 / ⚖️ 智能体评测 / 🕒 历史快照；选中品牌蓝 #4d6bfe + 加粗 + 底部 2px 下划线 + `white-space:nowrap` + 0.2s 过渡。
- 未选中项目：居中“请在左侧选择一个项目开始工作”空状态，Tab 栏灰显 `pointer-events:none` 不可点。

### 步骤二：Tab 1 - 提示词编辑（防坍塌核心）✅
- 保留原有 `mirrorDiv + textarea` 双层高亮结构、`oninput/onscroll`、`renderEditorMirror/syncEditorScroll` 渲染函数。
- 顶部工具栏：模板提取/应用、清理排版；Token 进度条已上移至 Tab1 顶部工具栏（Token 占用 + 进度条 + 超限告警）。
- 语境配置收拢为可展开折叠面板（默认收起，展开时触发高度重算）。
- **切回 Tab1 强制重算**：`setTimeout(...,0)` 内依次执行 ①`refreshAllEditorMirrors()` ②每个 textarea `height='auto'` → `scrollHeight+'px'` 并同步 mirror 高度 ③`syncEditorScroll()`；实测切 Tab2 再切回后 60 个变量 span、高度 682px/682px、scrollDelta=0、橙色高亮 `rgb(245,158,11)` 不错位。
- 公共项目下 textarea 置 `readonly`、写入按钮禁用、`window.isPublicProject=true`；切回私有项目恢复。

### 步骤三：Tab 2 - 知识库管理（防并发锁死）✅
- 左右 7:3 网格分栏：左侧搜索/全选/批量删除/Checkbox 列表，右侧 TXT 粘贴解析入库。
- 列表行渲染 Checkbox，全选/单选实时计数“已选 X 项”；切换项目时 `selectedKbIds` 清空、Checkbox 重置。
- **批量删除严格串行**：`for (const id of ids) { await fetch('/api/kb/delete', ...) }`，全屏 Loading 遮罩；实测 5 个请求 `maxConcurrent=1`（非 Promise.all），6 条 → 1 条。
- 修复 Checkbox 传参 bug（改为 `data-id` 读取，避免 JSON 引号实体导致选中失效）。

### 步骤四：Tab 3 - 智能体评测 ✅
- 双栏布局：左侧多轮对话模拟器（气泡、AI 生成刁钻测试题、发送）；右侧评测/批量回归数据面板。
- 保留原 V4 聊天自动滚底逻辑（`container.scrollTop = container.scrollHeight`）。
- 所有弹窗仍直接挂在 `<body>` 下。

### 步骤五：Tab 4 - 历史快照与 Diff ✅
- 全宽快照表格（快照 ID、时间、状态 Tag、对比当前/下载/复制）。
- Diff 弹窗 `#diff-modal` 父节点为 `BODY`，全屏 `position:fixed; z-index` 层级（原有 V4 结构保留并复核）。

### 步骤六：文案与多选 Bug 修复 ✅
- 开启新项目文案：标题“开启新项目”；选项“➕ 创建客户或行业…”；占位符“请输入新客户或行业”、“请输入项目名称(留空 = 仅创建客户或行业)”；标题“创建客户或行业”。
- 菜单名：“提示词编辑”、“生成为历史快照”、“历史快照”（移除“历史快照中心”）。
- 多选真正生效：点击“☑️ 多选”后树节点渲染 Checkbox；Checkbox 放入 `.tree-check-wrap` 包裹层并 `stopPropagation()`，点击勾选框/包裹层均不触发公司折叠展开；树顶部浮出固定条“已选中 X 项 [批量删除] [取消]”，批量删除走串行请求。

## 二、红线遵守情况

| 红线 | 结果 |
|---|---|
| 增量改造，严禁推倒重写 | ✅ 仅修改既有 index.html；V4 卡片 DOM/ID/函数保留，`git diff` 可审计 |
| 保护双层高亮 mirrorDiv + textarea | ✅ 原结构、oninput/onscroll、渲染函数全保留 |
| 切回 Tab 强制重算高度 | ✅ `setTimeout(...,0)` + autoHeight + mirror 同步 + syncScroll，实测 0 偏差 |
| 所有 JS 改值必须 dispatch input | ✅ 沿用 `setEditorLayerValues` 的 input 派发；Tab 切换逻辑不动值 |
| 弹窗挂载 `<body>` + fixed 9999 | ✅ 6 个全屏弹窗父节点均实测为 BODY |
| 公共项目只读 + window.isPublicProject 拦截 | ✅ 前端拦截 toast“公共项目禁止修改”且不发请求；后端普通用户写接口 403 |
| 保留 V4 模板/润色/复制/Token/快捷键/备份/Diff | ✅ 全部元素与处理器存在并逐一断言通过 |

## 三、真实浏览器测试（dsh-ego-browser）

| 组 | 内容 | 结果 |
|---|---|---|
| A | Tab 骨架/Header 字体/Tab1 长文本 40 行切 Tab2 再切回/几何重合/V4 功能保留/无 JS Error | **13/13 PASS** |
| B1 | 多选 Checkbox 出现/包裹层点击不折叠/本体点击不折叠/退出恢复 | **4/4 PASS** |
| B1 | 公共项目 isPublicProject/readonly/徽标/按钮禁用/F12 去 readonly 后保存被拦截（0 网络请求） | **4/4 PASS** |
| B2 | 7:3 布局/勾选 5 条计数/串行删除 maxConcurrent=1/6→1/切项目重置 | **5/5 PASS** |
| C | 四大 Tab 内容映射/弹窗 body 挂载/聊天滚底保留/快照表格 + Diff | **7/7 PASS** |
| D | 未选中项目空状态 + Tab 灰显不可点 | **2/2 PASS** |
| E | 普通用户公共项目只读可见 + 快照/语境/知识库写接口 403 兜底 | **6/6 PASS** |
| F | 切回后橙色高亮对齐（60 spans, 682=682, delta=0）/Tab3 双栏 585+351/切回 Tab1 重算 | **3/3 PASS** |
| **合计** | **44 项自动断言全部通过**，另人工点击退出登录验证 → 跳转 login.html | **PASS** |

截图：
- [Tab1 提示词编辑（Token 工具条 + 高亮）](v5p2-01-tab1-edit.png)
- [Tab2 知识库管理（7:3 + 批量管理）](v5p2-02-tab2-kb.png)
- [Tab3 智能体评测（左对话/右数据双栏）](v5p2-03-tab3-eval.png)
- [Tab4 历史快照](v5p2-04-tab4-snapshot.png)
- [切 Tab 后长文本橙色高亮仍对齐](v5p2-05-highlight-after-tab-switch.png)

## 四、数据与回归

- 阶段二测试使用临时客户/公共项目/KB 项目，测试后已清理：最终 **projects=3（GTP/Trip/途牛）、companies=2（Sam/政府）、kb_items=101、snapshots=62、users 仅 admin、integrity_check=ok**。
- 阶段一验收冒烟重跑：`v5-final-smoke` **11/11 PASS**、`v5-phase1-smoke` 全通过，认证/多租户/Key 策略未被破坏。
- 后端新增最小支撑：`GET /api/projects|companies` 对普通用户返回全局公共项目；`requireProjectWritable/assertProjectWritableByRow` 对非超管写公共项目返回 403；`projects/update` 支持超管/团管设置 `is_public/public_scope`（供阶段三 UI 接入）。

## 五、已知限制 / 待后续阶段

1. 公共项目“设为公开”目前仅有后端 API/字段，尚无前端管理入口（PRD 属阶段三资产管理/权限深化范围）。
2. 左侧树批量删除只按项目粒度串行删除，公司节点暂不提供批量删除。
3. 语境配置默认折叠（符合“收拢为折叠面板”），展开后编辑器高度会自动重算。
4. `public/index.html` 体积更大，但仍是单文件原生 JS，未引入框架；所有 V4 函数名/ID 保持不变以兼容前期脚本。

**结论：V5.0 阶段二前端大改造完成，Tab 导航、双层高亮防坍塌、知识库串行批删、公共项目只读拦截、树多选防折叠均通过真机自测，V4 功能保留，数据零污染。**

V5.0 阶段二前端大重构完毕，请人类验收。
