# OA 填单坑与处理办法（deskpilot-oa-fill）

本文件只记录**联影 OA 专属**的坑；「换一个网站也会遇到的通用坑」（端点粘连、登录控件非 button、框架绑定字段、下拉累积、测试假卡死）见 [deskpilot-browser/references/universal-pitfalls.md](../../deskpilot-browser/references/universal-pitfalls.md)。全部来自实测，非推测。

## 1. 会话超时清空整张表单（本轮触发 4 次）

**现象**：OA 空闲超时后**关闭表单标签页**，所有未保存数据丢失。

**解法**：
- 完整填单在一次连续 pass 内做完，中间不停顿等待。
- 填完每步回读校验，一旦发现表单被清就立即重做，不要继续盲填。
- 提交前不引入长时间人为停顿。

## 2. 明细行按钮

**现象**：点外层 `div.detailButtonDiv` 无效。

**解法**：点按钮元素本身 `#addbutton0`（handler 挂在 `i.icon-coms-Add-to-hot` 上）。新增后明细表 `tbody tr` 增加，字段 id 形如 `field679xx_N`（N 行号 0 起）。

## 3. 必填字段无标签

**现象**：部分必填字段（页面上带 `wf-input-required` 红标）没有可见的 label 单元格，无法一眼看出字段名。例：底部签批行最左的 `#field84777`，`data-fieldname="sapxmhnew"`，实为 **SAP项目号**（曾被误判为"经费负责人"）。

**解法**：不要靠内部名猜语义，也不要用写探针值的方式试探（会污染字段）。优先用**只读**手段判定：`ui.find name_contains="SAP项目号"` 一步命中并返回控件类名；或截图 + OCR 读相邻标签（见 [universal-pitfalls.md#6](../../deskpilot-browser/references/universal-pitfalls.md)）。也可对照同类型已提交单据（如 SPRS00020155）确定列含义。

**取值**：SAP项目号是 **OA/SAP 侧派生字段，不由用户填写**。实测：表头「项目号」`#field68007`（`data-fieldname=xmh`）= `100167003201` 时，SAP项目号 `#field84777`（`data-fieldname=sapxmhnew`）= `67003201`（即项目号去掉前缀 `1001` 后的部分）。把它当普通必填文本去填，只会写入一个会被覆盖/不符的值。模板应标 `type: "derived"`，引擎跳过、校验器不计必填。

## 4. 工厂组合范围

**现象**：示例单用「上海联影研发工厂」，但当前账号的工厂弹窗仅有 8 个「生产工厂」(1201–1208)，搜索「研发」返回 0 行。

**解法**：以当前账号实测的工厂弹窗为准，选账号可用的值（如 `上海联影生产工厂-CO`）；不要按示例单写「研发工厂」（那是别的权限账号）。

## 5. 登录提交控件是 `div.loginBtn`

**现象**：`oa.united-imaging.com` 登录页（e7/e9）提交控件是 `div.loginBtn`（DIV 不是 `<button>`），按 `<button>` 找会漏掉。

**解法**：登录脚本先找 `div.loginBtn`（`oa-login.mjs` 已实现三形态兜底）。通用形态的「提交控件非 button」已归入通用层，这里只记 OA 的**具体值为 `div.loginBtn`**。

## 6. 明细行：列映射按 data-fieldname 对齐，联动列不可手填

**现象（两个真实坑，均已修）**：
1. **列映射按视觉列序猜会错**：曾把 `field67980_0` 当「物料大类」，其 `data-fieldname` 实为 **`mfr`**；把 `field67937_0` 当「数量」位，实为 **`dw`（单位）**。结果「物料大类」填不进、相邻列错位。
2. **品名描述写入后被清**：`field67936_N`（`data-fieldname=pmms`）用 `chrome.fill` 写入报 `verified:true`，但 1.5 秒内即被 OA 异步校验清空 —— 它是**物料号（`wlh`）联动带出**的字段，不允许手填。

**解法**：
- 列映射**必须用 `data-fieldname` / `data-fieldmark` 对齐**，不要按截图里的列顺序推断。一次 `chrome.evaluate` 列出 `[data-fieldmark$="_0"]` 的 `fieldmark/fieldname/value/坐标` 即得权威对照表（实测：物料大类=`field67975_0`/`wlzl`、单位=`field67937_0`/`dw`、数量=`field67938_0`/`sl`、单价=`field67939_0`/`wsdj`、总价=`field67940_0`/`wszj`、供应商=`field67935_0`/`gysjpp`、物料号=`field67932_0`/`wlh`、品名描述=`field67936_0`/`pmms`）。
- 联动带出的列（品名描述 `pmms`、预估总价 `wszj`）在模板里标 `derived: true`：引擎跳过、校验器不计必填；先填触发列（物料号），其余由页面带出。

**验证**：`detail:verify#N` 在**填完那一刻**回读本行各列；若某列 `verified:true` 却回读为空，即为联动列或映射错误。

## 7. 开单入口与"表单真的打开了"的判据（2026-10-08 复测）

**背景**：台账里曾有一条 open 项称"点目录项后表单不再真正打开：外层 URL 停在 `#/main/workflow/add`、`iframe#mainFrame` 恒为 `about:blank`、新开标签 `perfNav` 是 wui/index.html?#/main"。**该现象本次未复现**，且其隐含的"表单宿主是外层页里的 iframe"模型与当前事实不符。

**本次实测的成功路径（未跑任何 cleanup 的既有浏览器上）**：
1. 「新建流程」目录页就是 wui/index.html#/main/workflow/add（可直接 attach 该页拿目录，**不必**先点顶部「流程」再点左侧「新建流程」—— 本次即跳过了这两步）。
2. 目录条目判定：`chrome.wait` 断言 `a` 的 `innerText`（去多余空白后）**精确等于**目标名；实测目标 `UIH-01 采购申请单(上海联影)-SAP` 命中，`parentElement.className === 'fontItem'`。
3. 点击方式：**页内 `el.scrollIntoView({block:'center'})` + `el.click()`**（与 `oa-open-form.mjs` 一致）。实测点完立刻生效。
4. **结果判据只能是"多出一个新的顶层 static4form target + 该 target 真的渲染了"**：
   - `chrome.targets` 点击前后对比，新增 `static4form/index.html?_rdm=<新值>#/main/workflow/req?...workflowid=2562`；
   - 对**新 target** 回读：`title = 创建 - UIH-01 采购申请单(上海联影)-SAP`、`location.href` 含 `static4form`、`[data-fieldname]` 去重 **66**、`input[id^=field]` **81**、`detailRows=0`、`modalCount=0`；
   - `chrome.wait` 用 `input[id^=field]` 等首个文本框选择器确认 Vue 树已渲染（新开标签页 CDP 可 attach 时表单可能还是空的）。
   **不要**再用 `iframe#mainFrame` 或外层页 URL 判断开单成败。

**顺带确认**：登录态有效时（cookie 在）点目录项**不出现任何登录/确认弹框**（`modalCount` 全程 0）——"有弹框"不是这个入口的常态，别把"没弹框"当成失败。

**遗留**：原 open 项的根因仍差一步对照实验（可信 `chrome.click` 点同一锚点 vs 页内 `el.click()`），故台账中该项保留 open，不据此宣布"已修复"。

**2026-10-08 补充（重要）：`oa-open-form.mjs` 会报**假阴性**。** 实测同一次操作里该脚本返回
`{"status":"form_not_opened","target_id":null,"elapsed_ms":16589}`，但紧接着 `chrome.targets`
就列出了**新的顶层 target** `F5CE8144…`（标题 `创建 - UIH-01 采购申请单(上海联影)-SAP`，`_rdm=179144789…`），
而且它**完全可填**（本轮就是在它上面完成了整轮填充）。
即：**"没打开"和"探测那一刻没读到"必须分开**。可能原因是探测期间该新标签页的 `chrome.evaluate`
失败（当轮确实出现过 `WINDOW_ACTIVATION_FAILED`），于是被记为"未渲染"。
⇒ **看到 `form_not_opened` 时，一定先 `chrome.targets` 复核一次**，不要据此重开或改造流程；
这也解释了台账 open 项里"表单不再真正打开"的一部分现象可能只是**校验假阴性**。

