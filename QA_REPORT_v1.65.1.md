# V1.65.1 QA 报告

日期：2026-11-26 21:35 ｜ 环境：本机 Windows / Node v24 ｜ 生产 `data/newrock.db` 全程未被写入

## 一、结论

| 测试 | 结果 | 说明 |
|---|---|---|
| 后端冒烟 `scripts/smoke-v1.65.mjs` | **142 / 142 通过** | 临时目录 `data/tmp/smoke165-*`；版本断言已改为读 `package.json`（实测读到 1.65.1） |
| 页面全按钮回归（DOM 级） | **139 / 139 通过** | jsdom + 真实 3101 服务 + mock LLM；本版新增 16 条（登录页 9 + 项目树 7） |
| 事件处理函数清单 | **113 / 113 已定义** | `scripts/qa-button-inventory.mjs`（本版未新增按钮） |
| 文案守卫 | **白名单外 0 条** | `scripts/qa-wording.mjs`（44 行含「快照」均为备份域/注释/日志） |
| 未捕获 JS 异常 | **0** | 全程收集 `jsdomError` |
| 非预期 alert | **0** | 错误均走 toast |
| 真实渲染像素校验 | **通过** | headless Edge（`--headless=new --screenshot`）1280×860 截图 + Pillow 测像素 |

隔离方式：冒烟用 `data/tmp/smoke165-*`；DOM 回归用 `.qa-test/data`（3101，每轮重建）；像素截图打生产 3100 的 `/login.html`（只读 GET，不写库）。

## 二、登录页改版（V1.65.1-A）

### 1) 结构断言（jsdom，9 条）

1. `.login-brand` 存在且 `closest('.login-card') === null`（品牌在卡片外）。
2. 卡片内 `img` 数为 0（卡片只放表单）。
3. `.login-brand-name` 文本恰为 `AI Workbench`；`.login-brand` 规则含 `flex-direction: row` + `align-items: baseline` + `justify-content: center`，且 `img` 规则 `height: 44px`。
4. `.login-brand-name` 规则含 `color: #0c479b` + `font-size: 18px` + `font-weight: 700`。
5. 页面内已无 `.tabs / .tab`（胶囊标签组与灰底框删除）。
6. `#login-username / #login-password / #login-submit(submit)` 齐备。
7. 注册入口与服务端 `register_enabled` 一致（开启→链接可见且提示行隐藏；关闭→链接隐藏且提示行显示）；提示行文案**恰为**「如需创建账号，请联系管理员」，且页面内不再含「首次部署」字样。
8. 点 `#register-link` → 注册面板 active；点 `#back-to-login` → 登录面板 active。
9. 页脚 `.login-foot` 含 `/api/auth/config` 返回的版本号。

### 2) 像素级校验（真实渲染）

| 指标 | 实测 | 期望 |
|---|---|---|
| 品牌组水平中心 | x 491–787 → 中心 639 | 页面中心 640（±1px） |
| logo 渲染高度 | 44 px | 44 px |
| 「AI Workbench」文字底部 y | 247 | 与 logo 内文字底部 247 齐平（差 0px） |
| 「AI Workbench」颜色 | `rgb(12,71,155)` = `#0c479b` | 与 logo「时」字同色（原图取色同值 (12,71,155)） |
| 文字大写字母高度 | ≈12.6 px | logo 大写字母高度 12.95 px（538/1827×44），差 0.35px |
| 底部提示行 | 单行、卡片内水平居中（中心 640） | 「如需创建账号，请联系管理员」`12px #94a3b8`，仅注册关闭时显示 |

换算依据：`logo.png` 6402×1827，山形与字标之间空白带 y 1103–1268；字标 1268–1826（底边紧贴图片底边 1826/1827），拉丁大写 y 1287–1824（高 538px → 0.2944H）。因此 `align-items: baseline`（图片 baseline = 底边）即等价于「文字底部与 logo 内文字底部对齐」；字号按 `0.2944×44 ÷ 0.72 ≈ 18px`（Segoe UI cap≈0.72em）换算。

## 三、首页项目树默认收起（V1.65.1-B）

新增 7 条断言：

1. 新建项目后其父公司自动展开，且 `.menu-child.active` 文本为该新项目（选中即可见）。
2. 新建第二个 jsdom 实例模拟「重新登录」：所有 `.menu-children` 容器 `display === 'none'`（实测容器数与状态逐个打印）。
3. 收起态所有 `.tree-toggle` 文本为 `▶`。
4. 点击首个公司：仅该容器变 `block`、箭头变 `▼`，其余仍 `none`。
5. 再次点击：恢复 `none` / `▶`。
6. 展开态下调用 `window.fetchData()`（模拟重命名/置顶后的数据刷新）：仍保持 `block` / `▼`。
7. 搜索框输入项目名片段：命中公司容器全部 `block`（搜索恒展开的既有行为未回归）。

## 四、本轮发现并处理的问题

| # | 问题 | 处理 |
|---|---|---|
| D1 | 首次落地的「默认收起」搜索断言取第一家公司的子项做关键字，若该公司无项目则关键字为空导致断言自检失败 | 改为从全树取任一 `.menu-child` 的项目名片段；重跑通过 |
| D2 | 登录页品牌经历三版：纵向堆叠 → 同行居中（`align-items: center`）→ 同行 baseline 对齐 + 与 logo 同色同字号 | 以像素测量确认底部差 0px、色值一致后才定稿 |

## 五、残余风险与未覆盖

1. **jsdom 不做布局**：行内对齐只能靠「CSS 规则断言 + 真实渲染像素测量」双重验证；像素测量依赖本机字体（Segoe UI，cap≈0.72em），换机器字体可能有 1px 级差异。
2. **真实浏览器交互式 E2E 仍不可用**（本机 Edge 命名管道/IPC 被拒）；只有 `--headless=new --screenshot` 截图模式可用，已用于本次登录页验证。
3. 生产 3100 若未重启，`/api/health` 仍显示 `1.65.0`（本版无后端逻辑改动）；页面视觉刷新即生效。
4. 登录页 `<title>` 仍为「NewRock AI Workbench · 登录」（仅浏览器标签，未在本次要求范围内）。

## 六、复跑方式

```powershell
cd D:\prompt-studio
node scripts/smoke-v1.65.mjs                                   # 期望 RESULT pass=142 fail=0
powershell -NoProfile -ExecutionPolicy Bypass -File .qa-test\run-dom.ps1   # 期望 RESULT pass=139 fail=0
node scripts/qa-button-inventory.mjs                           # 期望 113
node scripts/qa-wording.mjs                                    # 期望 白名单外 0 条
```

像素复核（可选，需本机 Edge）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --window-size=1280,860 --user-data-dir=".qa-test\edge-profile" `
  --screenshot=".qa-test\login-v1651d.png" "http://127.0.0.1:3100/login.html"
```
