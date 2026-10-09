# WfForm 组件化填单 —— 验证记录（续：§6.3–§8）

> 接前篇 `wf-validation.md`；本册覆盖 §6.3–§8，续篇 `wf-validation-9-10.md`。

### 6.3 收尾三改 + 端到端一次连续 pass（2026-10-08 16:2x，**已完成**）

**收尾三改已复跑验证**（无显式值跑一遍）：

```
summary={"filled":0,"ok":0,"failed":0,"needsDialogPick":4,"needsOptionPick":0,
         "needsCkeSetData":1,"conditionalHidden":3,"skippedHasValue":8,"other":0}
field-4 rich_text → needs-cke-setData ok=false        <-- 不再假通过
field68058/68011/68014/93808 → skip(has value)        <-- 已有值不再被当成缺口
other=0                                                <-- tally 分项正确
```

**一次连续 pass（重登 → 新建流程 → 能填的全填）**，在新开的干净表单上：

| 动作 | 结果 |
|---|---|
| 文本类 + radio（含条件隐藏字段的显式写值） | `filled:6 ok:6 failed:0`（申请原因 / 采购需求说明 / 指定供应商名称 / 存放供应商 / 固定资产预编号 / 采购选项 radio） |
| 三个真下拉**点真实选项** | 采购类型→普通 `after=0`；签批跳转→采购下单 `after=3`；是否含培训费→否 `after=0` |
| 项目号 **弹框选行** | 弹框 `SAP_项目号` 10 行 → 选行 → `after=100110000001`、`modalOpen:false` |
| **频闪复测**（项目号 `tr`，对照=采购类型 `tr`，3.12s） | 项目号 **0 次变更**、`noTr:false`；对照组 **0 次** |
| 截图 | `screen.capture_window` 成功（页面无「登录超时」横幅） |

**仍然没填的（都有据可依，不是失败）**：

| 字段 | 原因 |
|---|---|
| 工厂 `field68033` | 放大镜 `rendered:false`（`rect=0×0`）→ 条件未渲染。注意填充脚本会报 `needs-dialog-pick`（它量的是**值单元格**，有尺寸），而 `wf-interactive.js dialog-locate` 量的是**触发按钮**，给出 `rendered:false` —— 两者不矛盾，判"能不能点"要用后者 |
| 加签人 `field68029` | 弹框**能打开**（`modalOpen:true`）但 **`rows:0`** → 人员选择器无候选数据，标 optional |
| 明细物料类型汇总 `field68046` / 仓库主计划 `field68057` | 未渲染 |
| 申请人 `field68001` / 经费负责人 `field68037` | `browser_readonly` 系统字段，按规则跳过（申请人已有 `4503`） |
| 签字意见 `field-4` | `rich_text` 未实现；**且用户明确说这个不用管** |

**关于"前台丢失"**：16:2x 那次 `WINDOW_ACTIVATION_FAILED`（7 个窗口 `foreground_handle` 全为 0）在 16:2x 后**自行恢复**，
并**不是**代码问题；期间会话重登仍返回 `already_usable`，只是原表单实例被空闲超时弹回了登录页（未保存数据丢失，符合已知行为）。
⇒ **教训：`static4form` 实例会被空闲超时弹回登录页，一轮填单必须连续做完。**

---

## 7. 复跑确认（2026-10-08 16:5x，同日第二次独立 pass）

用户要求"再重新跑一下确认"。在**同一张表单**上原样重跑，并且**换用不同的值**（`验证-复跑-*`）
以证明是**真写入**而不是"已有值被跳过"：

| 步骤 | 第一次 pass | 复跑 pass |
|---|---|---|
| 普查 | total=22 / unknown=0 / ambiguous=6 / notRendered=11 / pickerTypes=37 | **total=22 / unknown=0 / ambiguous=6 / notRendered=10 / pickerTypes=37** |
| 文本类 + radio | `filled:6 ok:6 failed:0` | **`filled:6 ok:6 failed:0`**，且持久性回读拿到的是**新值** `验证-复跑-*` |
| browser 拒绝硬写 | `refused=100110000001` | **`refused=100110000001`**（同样给值、同样拒绝） |
| 3 个真下拉点真实选项 | 普通/采购下单/否 → `0/3/0` | **同样 → `0/3/0`** |
| 项目号弹框选行 | 10 行 → `100110000001`，弹框关闭 | **同样 10 行 → `100110000001`，弹框关闭** |
| 无显式值回读 | filled=0 / skipped=8 / needsCke=1 / other=0 | **完全一致** |
| 频闪（项目号 `tr`，对照=采购类型） | 0 次 / 3.1s（对照 0） | **0 次 / 3.12s（对照 0）**，`noTr:false` |
| 「登录超时」横幅 | 无 | **无（回读 `超时横幅:false`）** |

`notRendered` 第一次 11、复跑 10 的差异来自联动：某次状态变化让一个字段变得可渲染 —— 这正是
"**不要缓存渲染状态、每次重新普查**"的理由。

**结论：这条路径可重复，且复跑的写入是真实生效的（不是跳过）。**

---

## 8. 用户追问后补做的两项（2026-10-08 17:0x）

用户指出"工厂 `0×0` 有些你应该能解决吧，另外添加明细也没做" —— 两条都成立，之前我把话说早了。

### 8.1 条件隐藏字段**可以强制显示**（`changeFieldAttr`）

| | 改前 | 改后 |
|---|---|---|
| `tr.className` | `" linkage_hide"` | `""` |
| `tr` computed `display` | `none` | `table-row` |
| 放大镜 rect | `0×0` | **`16×28`（可点）** |

用的是 **`WfForm.changeFieldAttr('field68033', { view: 0 })`**（同一次里试了 `{view:0}` → 立即成功，故未再试其它）。
之后走正常弹框流程：`SAP工厂` 弹框 **8 行** → 可信点击真实行 → **`after: "1201"`**，弹框关闭，
界面显示「上海联影生产工厂-MR」。

**两个必须记住的附带事实**：
1. **这是在覆盖 OA 自己的联动决定** —— 工厂本来按当前上游值被隐藏。填之前要想清楚该不该填，填了要如实说明。
2. **`getFieldCurViewAttr` 不能用来判断有没有真的显示** —— 它在该字段上**恒返回 `3`**，而 DOM 已经从 `display:none` 变成 `table-row`。判据必须看 `tr` 的 class/display 与按钮尺寸。

### 8.2 明细表：加行 + 按 `data-fieldname` 填列

- symbol 从 `getLayoutStore().tableInfo` 取：本表 = **`detail_1`**；`getDetailRowCount('detail_1')` 加行前 **1** → `addDetailRow('detail_1','1')` → **2**，`getDetailAllRowIndexStr` = `"0,1"`。
- `detail_1` 共 **83 个列位**（绝大多数隐藏）——所以**必须按 `data-fieldname` 定位**，按视觉列序必然错。
- 两行各填 6 列直填字段 + 1 列数值：

```
summary: writes=14  ok=14  fail=0
行0: sl=2.000  wsdj=5400.0000  gysjpp/mpn/tzbb/mfr/wlbb = 验证-*-R1
行1: sl=5.000  wsdj=3200.0000  gysjpp/mpn/tzbb/mfr/wlbb = 验证-*-R2
```

- **派生列一律不手写**，而是回读它们作为"联动真的算出来了"的独立证据：
  `field67940 wszj 预估总价` = **10800.00**（2×5400）与 **16000.00**（5×3200），
  页面自算的 **合计未税金额 = 26800.00**；`dw 单位 = M`、`wlzl 物料中类 = 3219` 由
  **物料号 `wlh`（`field67932_*`）弹框选行**（`SAP_物料主数据` 10 行 → `TRST-M`）带出。

### 8.3 顺带修掉一个我自己的**假失败**

OA 会规范化数值：写 `'2'` 回读 **`'2.000'`**、写 `'5400'` 回读 **`'5400.0000'`**。
第一版判定用 `String(after) === String(want)`，于是 **14 条成功写入里有 4 条被报成失败**。
`wf-fill-by-component.js` 已加 `same()`（数值容差判等）。

**教训：假失败与假通过同样有害** —— 假通过会让人相信没做的事，假失败会让人去改本来正确的代码（我差点就去"修"数量列）。
判据必须同时能解释两侧：这一轮真正的独立证据是**页面算出来的 10800.00 / 16000.00 / 26800.00**。

### 8.4 同时消掉的一处噪声

browser 字段**已有值**且本次无显式要求时，原实现仍报 `needs-dialog-pick`；现改为 `skip(has value)`。
回归后 `needsDialogPick` 从 5 降到 2（只剩真正没值的 `经费负责人` 与弹框无数据的 `加签人`）。

---

