# WfForm 组件化填单 —— 验证记录

本文件是"组件分类 + WfForm 写值"这条路径的**可复核验证记录**（原先散在用户级 skill 的
`VALIDATION.md` 与一次长会话里，2026-10-08 合并回工作区）。

被测表单：**UIH-01 采购申请单(上海联影)-SAP，`workflowid=2562`**
端点：`127.0.0.1:49406`（受控 Chrome；**每个 `chrome.*` 都必须显式带 `endpoint`**）

---

## 1. 普查可复现（2026-10-08 两次独立复测）

```
total=22，unknown=0，browserPickerTypeCount=37
componentCounts = text_input:5, select_multi:5, select_single:4,
                  browser_readonly:2, span_display:2, textarea:2, radio:1, rich_text:1
```

与 2026-10-08 12:30 的旧记录**逐项一致** —— 说明这份字段模型可复现，不是一次性巧合。

## 2. 按组件写入并回读（旧记录 + 本次复测）

| fieldmark | 字段 | 组件 | 写法 | 结果 |
|---|---|---|---|---|
| field68058 | 采购类型 | select_single | **点真实选项「普通」** | 模型 `0`，界面显示「普通」 |
| field68011 | 签批跳转 | select_single | **点真实选项「采购下单」** | 模型 `3` |
| field93808 | 是否包含培训费 | select_single | **点真实选项「否」** | 模型 `0` |
| field68017 | 采购选项 | radio | `changeFieldValue(fid,{value:'0'})` | 模型 `0`，该单选组变为可见 |
| field68021 | 指定供应商名称 | span_display/text_input（**歧义**） | `{value:'验证-span-可见'}` | 模型与 DOM 一致 |
| field68028 | 采购需求说明(技术及法规等) | textarea | `{value:'验证-采购需求说明'}` | 模型与 `textarea.value` 一致 |
| field68006 | 申请原因 | textarea | `{value:'验证-申请原因'}` | 模型与 `textarea.value` 一致 |
| field68007 | 项目号 | **browser**（不是 select_multi！） | **弹框选行** `100110000001 / Z020 / BD-Uxt0344` | 模型 `100110000001`，界面正确显示，**行 0 次变更/3s** |

`select_single` 的完整选项集（实测，li **没有 data-value**，值只能靠点选回读）：
- 签批跳转：`(空)`、采购下单、简单修改、重大修改、归档
- 采购单类型隐藏：`(空)`、普通采购、CR验证合格的量产物料采购、试制及小批量采购
- 是否包含培训费：`(空)`、否、是

## 3. ⚠️ 本轮发现的真实缺陷（已修，证据在下方）

### 3.1 browser 字段硬写 = 频闪（最严重，且**旧 skill 的规则是错的**）

| 同一实例 · 项目号所在 `tr` · 观察 ~3.2 秒 | 变更次数 | 模型 |
|---|---|---|
| 空值（基线，全新实例） | **0** | `""` |
| 经**弹框真实选行**填入 `100110000001` | **0** | `100110000001`（稳定、显示正确） |
| 用 `changeFieldValue` **硬塞键值** | **133–153**（~50 次/秒） | `"" ↔ 100110000001` 反复跳 |
| 对照：采购类型（有值 `0`）/ 申请原因（有文本） | **0 / 0** | — |

结论：**硬写让 `wea-browser` 组件的显示态与模型态失配，陷入自激重建循环**；用户看到的"项目号频闪"就是这个。
并且写入后立刻 `getFieldValue` 会**先返回成功（假通过）**——这正是它此前被当成"已验证通过"的原因。

⇒ **修复**：`scripts/wf-fill-by-component.js` 对 `browser` / `browser_readonly` **一律拒绝硬写**，
登记 `needs-dialog-pick`；必须走 `scripts/wf-interactive.js` 的 `dialog-locate → (可信 chrome.click) →
dialog-mark → (可信 chrome.click) → dialog-verify`。

### 3.2 分类顺序错误

旧分类器把 `.ant-select-selection--multiple` 排在 `.wea-browser` 之前 → `项目号(field68007)`
被误判成 `select_multi`（这正是 3.1 的入口）。现顺序固定为
`detail_table → rich_text → date → browser → browser_readonly → select_multi → …`。

### 3.3 观察器挂错节点会得出相反结论

我第一版把 `MutationObserver` 挂在**单元格**上，数到 **0 次**变更，据此得出"不闪"的**错误结论**——
因为 OA 会**整体替换单元格节点**，观察器看的是一个已脱离文档的节点。必须观察 **`tr`**。
方法论教训：**测量必须带对照**（同一次测一个普通有值字段），否则"0 次"无法解释。

### 3.4 无法用 `offsetParent` 判断弹框可见

`waitmodal` 曾超时 15s 报"没弹框"，而同期诊断里 `matched_count:1`、正文 914→1563、可操作元素 +7
——弹框**已经开了**。真因：antd 弹框 `position: fixed`，`offsetParent` **打开时也恒为 `null`**。
改用 `getBoundingClientRect()` 尺寸 + computed `display`。

### 3.5 弹框"容器到了、行还没到"

弹框容器出现时正文仅 713 字符、表体 **0 行**；数据行是异步加载的（稍后 1563 字符、10 行）。
等待条件必须包含"弹框内 `.ant-table-body tbody tr` 行数 > 0"，否则会把"还没加载"误判成"该弹框没有数据"。

### 3.6 `CHROME_ELEMENT_NOT_ACTIONABLE` 的真实含义

「工厂 `field68033`」两次点击失败，命中测试显示其放大镜 `rect = 0x0 @ (0,0)`、
`elementFromPoint` 落在 `DIV.ant-col-24 wea-new-top-req-main` —— 该字段在当前状态下**根本没渲染**，
属**条件隐藏（excused）**，不是滚动/选择器问题，也不该重试。

## 4. 尚未实现 / 有据可依未填（如实登记，不许假装）

| 项 | 原因 |
|---|---|
| `rich_text`（签字意见 `field-4`） | 只登记策略 `CKEDITOR.instances[name].setData()`，本能力**未实现**；且 `getFieldValue` 对它永远为空，必须用 `getData()` 验证 |
| `datepicker`（`wea-date-picker`） | 内部只有 hidden input，`chrome.fill` 写不进；日历交互未实现 → 记 `skipped(unsupported_kind)` |
| `browser` 字段 | 需要宿主发**可信** `chrome.click`（wea-associative 忽略页内合成点击），故由 `wf-interactive.js` 分步完成，脚本本身只登记 |
| `select_*` | 开下拉后候选项异步渲染，一次同步 `evaluate` 读不到，故拆成 `select-open → 等 → select-pick` |
| 工厂 `field68033` | 条件未渲染（0x0），excused |
| 加签人 `field68029` | 人员弹窗，历史实测各标签页 0 行（数据可得性），标 optional |
| 明细物料类型汇总 `field68046` / 仓库主计划 `field68057` | 隐藏字段 |
| 存放供应商 `field68036` | 条件未渲染（w=0）；有显式值时仍可写入并记 `wasHidden:true` |

## 5. 提交 / 保存

**始终未触碰。** OA 空闲超时较短（实测会把 `static4form` 直接弹回登录页），
一次完整 pass 必须连续做完；重登后原表单实例作废，必须经「新建流程」重开。

---

## 6. 修复即验证（2026-10-08，跑的是磁盘上的真实脚本文件）

**怎么跑的**：用 Node 写一个 NDJSON 客户端直连公开 CLI（`win-agent.exe exec --stdin --format ndjson`）——
`readFileSync` 保证跑的就是 skill 里那个文件，`JSON.stringify` 负责转义。
**为什么要这样**：把手写脚本塞进工具参数要手工转义，极易把脚本改坏（ledger #117 的教训）；
而 PowerShell 侧又先后踩了「`return` + 换行触发 ASI → 语法错误」和「函数作用域取不到变量」两个坑。

### 6.1 `wf-explore-components.js`（只读普查）—— 分类顺序修复已验证

```
total=22  unknown=0  ambiguousCount=6  notRenderedCount=11  browserPickerTypeCount=37
componentCounts: text_input=5  browser_readonly=2  select_single=4  browser=5
                 radio=1  span_display=2  textarea=2  rich_text=1
```

| 字段 | 结果 | 判定 |
|---|---|---|
| `field68007` 项目号 | `component=browser`，`kinds=[browser,select_multi,select_single]`，`ambiguous=true`，`triggerBox=16x28` | ✅ **不再是 `select_multi`**（这正是频闪的入口） |
| `field68033` 工厂 | `component=browser`，`rendered=false`，`triggerBox=0x0` | ✅ 条件隐藏可判 |
| `field68029` 加签人 | `component=browser`，`ambiguous=true` | ✅ |
| `field68021` 指定供应商名称 | `component=span_display` | ✅ 不再在两次运行间漂移 |
| `field84777` sapxmhnew | 值 `10000001` | ✅ 印证 derived（项目号 `100110000001` 去掉前缀 `1001`） |

### 6.2 `wf-fill-by-component.js`（填充）—— "拒绝硬写"已验证

显式**给出** browser 字段的值，脚本必须拒绝它：

```
summary={"filled":2,"ok":2,"failed":0,"needsDialogPick":4,"needsOptionPick":1,"conditionalHidden":11,"other":1}
field68007 browser          needs-dialog-pick   refused=100110000001   <-- 关键
field68001 browser_readonly needs-dialog-pick
field68037 browser_readonly needs-dialog-pick
field68029 browser          needs-dialog-pick
field68028 textarea         fill ok=true
field68006 textarea         fill ok=true
field68058 select_single    needs-option-pick                          <-- 不再猜 optionValue
```

**结论**：造成频闪的那条路径已在代码层被堵死 —— 即使调用方给了值，browser 字段也只会被登记为
`needs-dialog-pick` 并附上 `refused`，不会再走 `changeFieldValue`。


> 分册索引：§1–§6.2 `wf-validation.md`、§6.3–§8 `wf-validation-6.3-8.md`、§9–§10 `wf-validation-9-10.md`。
