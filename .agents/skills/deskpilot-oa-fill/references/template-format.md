# OA 填单模板格式（deskpilot-oa-fill 资产）

模板是「业务字段名 → 页面控件」的映射，由本 skill 在对真实页面实测后沉淀。业务用户不接触模板，只交纯数据。

## 顶层

```json
{
  "form_key": "uih01-purchase-requisition",
  "biz_name": "UIH-01 采购申请单(上海联影)-SAP",
  "entry": { "url": ".../workflow/add?...", "card": { "selector": "div.fontItem > a", "text_contains": "UIH-01 采购申请单(上海联影)-SAP" }, "attach": { "url_contains": "static4form" } },
  "field_map": { "…": "…" },
  "detail_columns": { "add": "#addbutton0", "…": "…" }
}
```

## form_key 与 `biz_name`：两个都要写对，但作用不同

| 键 | 作用 | 取值来源 |
|---|---|---|
| `form_key` | **给程序认领模板用**（纯数据里也有同名键） | 自定义稳定标识，如 `uih03-erp-material-application` |
| `biz_name` | **打开表单用**（门户目录条目的精确文本） | **必须照抄门户原文**，不可"规范化" |

**`oa-run.mjs` 认模板的顺序**（`--template` 未显式给出时）：

1. 用**纯数据里的 `form_key`** 认领：模板 `form_key` 与之**相等**，或模板文件名是它的**前缀**（`uih03-erp-material` 是 `uih03-erp-material-application` 的前缀）；
2. 再按**场景名前缀**（`uihNN`）匹配模板文件名；
3. 都认不出 → **报错退出（exit 2）**，打印 form_key / 前缀 / 正确用法。

> 第 3 步是刻意的：**绝不回落到任何默认模板**。曾因静默回落把 UIH-03 的数据拿去套 UIH-01 的模板，报出一堆假"必填缺失"（真问题只有 1 项），而更危险的情形是它**不报错地填错整张表单**。

> **`biz_name` 不要按编号"修正"**。实测 OA 门户里那张 ERP 物料申请单的目录名就叫《UIH-01 ERP物料申请单-SAP》（`workflowid=2226`），而《UIH-01 采购申请单(上海联影)-SAP》是另一张（`workflowid=2562`）。`oa-open-form.mjs` 按 `innerText` **精确相等**点击，改一个字就打不开。

## field_map 值类型

| type | 含义 | 控件要点 |
|---|---|---|
| `text` | 普通文本输入 | `selector: "#fieldXXX"`；框架绑定字段必须走 `chrome.fill` |
| `text_browser` | 关联搜索弹窗 | `widget: "#fieldXXXspan"`（弹窗在 `.wea-browser-modal`，须 wait） |
| `select` | 自定义下拉 | `widget: "weaSelect_N"`（选项累积，须限定可见 dropdown） |
| `radio` | 单选 | 精确匹配标签文本，避免「不指定供应商」被「指定供应商」误命中 |
| `datepicker` | 日期选择器（真实现） | 内部只有 `type=hidden` 的 input，**不能 `chrome.fill`**。引擎会：点 `.picker-icon` 开日历 → 按需**翻月** → 点 `td[title="YYYY-M-D"]` → 回读确认。数据给 `YYYY-MM-DD` 即可 |
| `upload` | 附件上传（**内容为构造，非磁盘文件**） | 数据给 `{ "name": "...", "content": "..." }`。引擎在页面内构造 `File` 赋给容器内的 `input[type=file]` 并派发 change，再轮询 `.wea-upload-list` 确认出现文件名。**CLI 无 `DOM.setFileInputFiles`**，故**无法选磁盘真实文件** —— 这条只用于验证上传链路，`optional: true` 且在 note 里写明边界 |

## 单选（radio）怎么放

单选**不写在 `field_map` 里**，而是：

- 模板顶层用 `radios: ["选项A", "选项B", ...]` 列出**页面上实际存在的选项全集**（供普查/校验对照）；
- 纯数据里用 **`radio_selected: ["要选的选项文本", ...]`** 指定要勾哪些。

匹配按 `label.ant-radio-wrapper` 的 `innerText` **精确相等**，所以选项文本必须与页面**逐字一致**。

### `disabled` 是业务规则，不是失败 —— 但必须报出来

实测某表单单选组里 4 个选项**全部 `disabled`**（且「无固定资产/无形资产/在建工程」已被系统勾选）。这说明**该组由系统/上游决定，申请人不可选**。

引擎的处置：

| state | 含义 | 报告 |
|---|---|---|
| `ok` | 已选中 | `selected` |
| `disabled` | 表单锁定该项 | `skipped(form_disabled —— 该选项被表单锁定，由系统/上游决定，申请人不可选)` |
| `not_found` | 页面上没这个标签（多半选项名写错） | 失败，报原文 |
| `unchecked` | 点了没选上 | 失败 |

> **数据要与规则一致**：若数据要求勾选一个 `disabled` 的选项（例如要求「有固定资产…」而系统已判「无固定资产…」），应**改数据**去匹配系统结论，而不是想办法绕过禁用。这是 `REJECTED_BY_FORM` 类问题。

## detail_columns

明细行字段 id 形如 `field679xx_N`（`N` 为行号）。`add` 是新增按钮 id，点元素本身、不点外层 `div`（handler 挂在 `i` 上）。

**列的定义与取值必须分层，不要塞进 `field_map`：**

```json
"detail_columns": {
  "add": "#addbutton0",
  "columns": {
    "物料编码": { "selector": "#field67789_N", "fieldname": "wlbm", "required": true },
    "物料描述": { "selector": "#field67785_N", "fieldname": "wlsm" },
    "物料类型": { "type": "select", "widget": "#weaSelect_6", "selector": "#weaSelect_6", "fieldname": "wllx" }
  }
}
```

对应纯数据放 `detail_rows`（数组，每项一个业务行）：

```json
"detail_rows": [ { "物料编码": "10011181", "物料描述": "数字万用表", "物料类型": "服务类物料申请" } ]
```

> **反面教材**：曾把「物料编码/物料描述/物料类型」写进 `field_map` 且 selector 写死 `#fieldNNNNN_0`。结果每一列都 `chrome.fill` 成功（`verified: true`）、回读却恒为空 —— 因为这些值根本没走明细行机制，而 `_0` 在空表里是**永远填不进去的占位行**。

### 四条硬约束（全部来自实测，违反任意一条都会静默失败）

1. **行号不要写死，也不要用循环下标。**
   `_0` 的含义**随表状态变化**：
   - 表为空时，`_0` 是 `0×0` 的占位行（未 swap），真实数据行出现在 `_1`；
   - 表已有数据行时，`_0` **就是**那条真实行。

   引擎现在的做法：先看**所有列**在任何下标上是否存在"位于 `tr.detail_data_row` 内的 `input`" → 够用就**复用，不点新增**；不够才点新增，并用**新增前后下标差集**定位新行。

2. **不要无条件点「新增行」。** 实测两张表单行为相反：某表单**预置了整行数据**（子库/SAP项目号/成本中心都已有值），对它点新增既多余又无效；另一张表是空的，必须点新增。所以"该不该点"必须由**当前页面状态**决定，不能由模板写死。

3. **判断"行是否存在"不能只看第一列。** OA 会把**已有值的单元格 `display:none`**。若拿一列恰好被隐藏的字段（如"物料号"）当探针，会误判"没有行"，进而点新增、报 `row_not_created` —— 而那一行其实一直都在。必须**扫所有列前缀**，且**不要求任何一列可见**。

4. **`add` 按钮的 `id` 可能重复**（同页两张明细表各一个 `addbutton0`）。`getElementById` 只返回第一个，而实测第一个常是 `0×0` 的隐藏表，点它毫无反应。必须按 `[id="X"]` 取**所有**候选，挑**已渲染（宽高>0）**的那个。

5. **多行是支持的，但每行都要先确认"这一行真的建出来了"**。引擎按行循环：新增 → 用**新增前后下标差集**定位新行 → 写列 → 回读。实测 3 行场景下标演进为 `[0]` → `[0,1]` → `[0,1,2]`，三行各自独立（第 2 行数量 2 × 单价 3200，页面联动把总价算成 6400，未被其它行干扰）。**不要用"行数"当行号** —— 两者没有对应关系。

详见 `.agents/skills/deskpilot-browser/references/universal-pitfalls.md` #18/#19。


## 必填识别

页面用 `wf-input-required` / `wea-required-e9` 标记必填。部分必填字段无可见标签，只能靠容器 id 反查（如 `field84777span` → `sapxmhnew`）。

## 沉淀规则

- 模板里的 selector/widget/text 必须来自对真实页面的一次实测，附上该次表单的 URL 与日期。
- 模板不含具体业务取值（那些在纯数据里），也不含凭据。
- 同一类表单（如所有 `UIH-01` 变体）优先复用模板，只换 `biz_name` 与入口。
