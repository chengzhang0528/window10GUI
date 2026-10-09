# 通用坑与处理办法（续：#19–#21）

> 接前篇 `universal-pitfalls.md`；本册覆盖坑 #19–#21，续篇 `universal-pitfalls-22-27.md`。

## 19. 明细行行号从 `_1` 开始，`_0` 是永远填不进去的占位行（最隐蔽）

**现象**：ERP 物料申请单的明细列按模板写死在 `#fieldNNNNN_0`。每一列都 `verified: true`，回读却恒为空 / `(未渲染)`；`trCount` 明明在增加，"新增行"也确实点成功了。

**根因**：OA 的 `excelDetailTable` 里 **`_0` 是"占位/无数据行"，不是第一行数据**。真正新建出来的数据行索引是 **`_1`**。实测同一张表（`#oTable0`）同时存在：

| id | 尺寸 | 含义 |
|---|---|---|
| `field67789_0` | **0 × 0** | 占位行（`etype_3_swapDiv` 仅 334×2，未 swap） |
| `field67785_0` | 322 × 26 | 占位行的另一列 |
| **`field67789_1`** | **322 × 26** | ✅ 真实数据行 |
| **`field67785_1`** | **322 × 26** | ✅ 真实数据行 |

对应的 `<tr>` 也分两类：真实行带 **`detail_data_row`**（`detail_odd_row detail_data_row` / `detail_even_row detail_data_row`），占位行没有。

**所以写 `_0` 的每一列都是"写进一个未 swap 的占位节点"** —— `chrome.fill` 返回 `verified: true`，因为"它确实写进去了"，但那个节点不参与表单模型。这与 #18 是同一族问题的下一个变种。

**解法**：**不要按数据数组下标硬编码行号**，要先读出真实数据行的索引：

```js
// 真实数据行 = 带 detail_data_row 的 tr，其 _N 才是可写行号
const idxs = [];
document.querySelectorAll('tr.detail_data_row').forEach((tr, k) => idxs.push(k));
```

更稳的做法：**新增一行后，用"该行第一列 input 的宽高 > 0"来定位新行号**，而不是假定它等于循环变量 `i`：

```js
// 新增后扫描所有 _N，取"刚出现的、已渲染的"那个 N
const n = [...document.querySelectorAll('[id^=fieldNNNNN_]')]
  .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map(el => Number(el.id.split('_').pop()))
  .sort((a, b) => b - a)[0];   // 最大的行号 = 最新建的行
```

**验证**：点新增行前只有 `_0` 且 `0×0`；点成功后出现 `_1` 且 `322×26`，写入 `_1` 才能回读到值。回读必须看**业务行号**，不是循环下标。

**教训**：`verified: true` 是"写进了这个 DOM 元素"，**不是**"写进了业务模型"。当"每步都成功、结果全为空"时，优先怀疑**目标行号/节点选错了**（占位行 vs 数据行），而不是怀疑写入方式。

**重要更正（同日晚些时候实测）：`_0` 是"占位行"还是"唯一数据行"取决于表的当前状态，不能写死。**

- **表为空时**：`_0` 是占位行（`0×0`，未 swap），此时点「新增行」，数据行出现在 **`_1`**。
- **表已有数据行时**：`_0` **就是**那条真实数据行（可写、回读有值）。

实测 UIH-03：先跑一轮创建出数据行后，第二轮 `input[id^=field67789_]` 只剩 **1 个节点**且值为 `DP-VERIFY-0001`；`#oTable0` 里出现带**序号 `1`** 的真实数据行，值确实落库。

**正确做法（引擎已实现）**：不要假设固定行号，也不要**无条件**点「新增行」：
1. 先看该列**已渲染**的下标集合；
2. 若已有第 `i` 行可用 → **直接复用，不点新增**（UIH-01 的明细表**预置了数据行**：工厂/子库/成本中心/SAP项目号 都已有值；对它点新增既多余又无效）；
3. 若没有可写行 → 点「新增行」，再取**新增前后下标差集**里新出现的那个（UIH-03 得到 `_1`）。

**反面教材**：我一度用"已渲染 `tr.detail_data_row` 的行数"当行号，在 UIH-01 上算出 `#field67932_8` 这种**不存在**的选择器 → `CHROME_ELEMENT_NOT_FOUND`。行数与 id 下标**没有**对应关系，必须用**下标差集**。

**再一层（同日最终定位）：判断"行是否存在"必须扫全部列，不能只看第一列 —— 因为 OA 会把"已有值"的单元格 `display:none`。**

实测 UIH-01 采购申请单：明细行**一直都在 `_0`**，且是 `tr.detail_odd_row.detail_data_row`，里面 子库=`CO11`、SAP项目号=`100167003201`、成本中心=`1001618014`、物料号=`10011181` 都有值。但同一行里：

| 单元格 | 尺寸 | display | 值 |
|---|---|---|---|
| `field67979_0`(MPN型号) | 161×26 | inline-block | 空 |
| `field67938_0`(数量) | 161×26 | inline-block | 空 |
| `field67932_0`(物料号) | **0×0** | **none** | 空 |
| `field67967_0` | 0×0 | none | `29830` |
| `field68956_0` | 0×0 | inline-block | `0.00` |

即：**空的可编辑列渲染出来，已有值的列被隐藏**。而模板的 `firstColSel` 恰好是 `#field67932_N`（物料号）—— 正好是被隐藏的那个。于是"已渲染下标"为空 → 误判"没有行" → 去点「新增行」（无效）→ 报 `row_not_created`。**整条链路的失败，源于拿一个可能被隐藏的列当探针。**

**正确判据**：扫模板里**所有**列前缀，只要某个下标上存在"位于 `tr.detail_data_row` 内的 `input`"，就认为该行存在 —— **不要求任何一列可见**：

```js
const prefixes = [...allTemplateColumnPrefixes];   // #field67932 -> field67932 ...
const seen = {};
for (const p of prefixes)
  for (const el of document.querySelectorAll('[id^="' + p + '_"]')) {
    if (el.tagName !== 'INPUT') continue;
    const tr = el.closest('tr');
    if (!tr || !tr.classList.contains('detail_data_row')) continue;   // 排除占位行
    seen[Number(String(el.id).split('_').pop())] = true;
  }
return Object.keys(seen).map(Number).sort((a, b) => a - b);
```

**教训**：凡是"用某个元素当探针去推断更大结构"的地方，都要先问一句 —— **这个探针本身会不会因为业务状态而不可见？** 一旦会，就必须换成语义更可靠的判据（这里是"行"而非"某个单元格"）。

**教训**：`verified: true` 的语义是**"我往这个元素里写了"**，不是**"这个值进了业务表单"**。凡是"写/点之后没报错"，都必须回读**业务状态**（行数、值、尺寸），这是 #3 / #10 / #11 的同一个面。

## 20. `CHROME_CDP_UNAVAILABLE` 未必是 Chrome 坏了 —— 先清残留 worker 进程

**现象**：所有 `chrome.*` 调用突然报
`CHROME_CDP_UNAVAILABLE: The specified CDP endpoint could not be attached`，`attempts.stage = websocket_or_initialization`，`error_code = TaskCanceledException`。`deskpilot_session reset` **无效**，连续重试全部失败。

**误判方向**：很容易得出"Chrome 挂了 / 端口变了 / 要重启浏览器"。实测这三条**全错**：

| 检查 | 结果 |
|---|---|
| 受控 Chrome 进程（pid 31360） | **活着** |
| `GET 127.0.0.1:58212/json/version` | **HTTP 200** |
| 直连 CDP WebSocket（`new WebSocket(webSocketDebuggerUrl)` + `Runtime.evaluate`） | **成功返回页面标题** |

即 **Chrome 与 CDP 两端都完全正常**，坏的是**中间那层 CLI（win-agent）**。

**根因**：机器上累积了 **6 个隔天残留的 `win-agent` 进程**（`StartTime` 是前一天）。它们把持/争用了 attach 路径，导致新会话建立 WebSocket 时被取消。

**解法**：先看有没有隔天的残留进程，清掉再试：

```powershell
# 只看不是今天启动的（不要杀当前会话正在用的）
Get-Process win-agent | Where-Object { $_.StartTime.Date -ne (Get-Date).Date } |
  ForEach-Object { Stop-Process -Id $_.Id -Force }
```

实测清掉 6 个隔天进程后，**同一条普查命令立刻恢复正常**（从连续失败变为 1.5s 成功、94 字段）。

**定位顺序（照这个顺序查，最省时间）**：
1. **先直连 WebSocket 验证 CDP 本身**（几行 Node 代码即可）—— 能通就说明问题不在浏览器；
2. 再查 `win-agent` 残留进程（按启动日期区分）；
3. 最后才去怀疑端口/profile/Chrome 重启。

**教训**：`CHROME_CDP_UNAVAILABLE` 里 "CDP" 是**报错方**的名字，不是**故障方**。一个底层依赖健康时，报错往往来自它与依赖之间的那一层；"重启最底层组件"是最贵且最可能无效的动作。

## 21. 日期选择器：能真填，但**必须先翻到目标月份**（否则永远 not found）

**背景**：这类控件（OA 的 `wea-date-picker`）结构是
`div.wea-date-picker.noInput > span.ant-calendar-picker > span.picker-icon`，
内部 **input 是 `type="hidden"`**（如 `#field67027_0`）—— 所以 `chrome.fill` 写不进去，早期一律记 `skipped(unsupported_kind)`。

**实测可以真填**（2026-09-23 跑通），三步：

1. **CDP 点击日历图标**（`.picker-icon`）→ 出现 `.ant-calendar` 面板；
2. 面板里每个可选日是 **`td[title="YYYY-M-D"]`** —— **`title` 就是不补零的 ISO 日期**，是最可靠的判据（不要用 `innerText`，那只是「23」这种日号，跨月会重名）；
3. **CDP 点击该单元格** → 隐藏 input 立刻被写成 `YYYY-MM-DD`（实测 `""` → `"2026-09-23"`）。

**最容易踩的坑**：**日历默认只显示当前月**。若目标日期不在当前月（今天是 9 月、要选 `2026-10-31`），面板里**根本没有那个单元格**，直接找 `td[title=...]` 必然失败 —— 而且失败现象是"单元格找不到"，看起来像选择器写错。

**解法**：找不到目标单元格时，**先比较年月并翻月**，再重试：

```js
const cur  = curYear * 12 + curMonth;          // 从 .ant-calendar-month/year-select 读
const want = wantYear * 12 + wantMonth;
const btn  = panel.querySelector(want > cur ? '.ant-calendar-next-month-btn'
                                            : '.ant-calendar-prev-month-btn');
```

实测日志（可复现的判据链）：`cell → ["nav","next","2026-9"]` → 翻页 → `cell → ["ok"]` → `after → "2026-10-31"`。

**顺带一条**：同族的**时间**控件（`.ant-time-picker`）页面**自带当前时间**（实测 `21:38`），不必手填；`day_count` 之类的天数是**只读派生**显示，不该写。

**教训**：判"这个控件能不能自动填"之前，先问"**它的目标值在当前视图里可见吗**"。日历、分页表格、虚拟滚动列表都有同一个陷阱 —— **值存在 ≠ 值当前可见**，需要先导航到它。

