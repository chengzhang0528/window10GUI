# 通用坑与处理办法（deskpilot-flow-evolution）

凡「换一个网站也会遇到同样陷阱与同样解法」的坑，都记在这里；某网站专属的坑去那个网站的 skill。全部来自实测，非推测。

## 1. 端点粘连（最高频）

**现象**：`chrome.evaluate` / `chrome.attach` / `chrome.targets` 不显式带 `endpoint` 时，CLI 连到「第一个可用的调试实例」。本机若另有调试浏览器（如 ChatGPT 桌面应用占 9229），所有 `getElementById` 返回 null，字段全 `missing`，或 `AMBIGUOUS_CHROME_TARGET` / `CHROME_TARGET_NOT_FOUND`——像选择器写错，实为连错浏览器。

**解法**：每个 `chrome.*` 请求显式带 `endpoint`。受控 Chrome 的端口记在 profile 的 `DeskPilotDevToolsEndpoint`；先读它，别扫 9222–9232（枚举覆盖不到动态端口）。

**验证**：返回的 `endpoint` 必须等于你传的；不一致即连错。

## 2. 登录提交控件不是 `<button>`

**现象**：自动登录返回 `submit_not_found`，因为提交控件可能是一个 DIV（如 `div.loginBtn`），不是 `<button>`。

**解法**：按三种形态依次找：具体站点已知的提交选择器 → `<button type=submit>` → `form.requestSubmit()`。

**凭据**：托管在用户级环境变量时，子进程可能只继承到一部分（实测 ACCOUNT 可见、PASSWORD 不可见），必须回落到 `HKCU\Environment` 读取，否则 `not_configured`。

## 3. 框架绑定字段写不进去（关键）

**现象**：页面脚本直接 `el.value = 'x'` 后派发 `input` 事件，值被**立即清空**（`afterSet=TEST-A → afterInput=(空)`）。

**根因**：input 自带 `value` setter + `oninput` 处理器（React/Vue/ant-design 通用），DOM 直写被框架还原。

**解法**：走 `chrome.fill`（CDP 可信输入，生成浏览器 native 事件），以返回 `verified: true` 为准；页面内脚本只用于「读」和「点」，不用于「写框架绑定字段」。

## 4. 下拉选项累积

**现象**：多个自定义下拉（wea-select / ant-select）的选项累积在同一批 DOM 节点里，直接 `querySelectorAll` 会拿到别的下拉的选项。

**解法**：先点对应 widget 展开，再从**当前可见**的 `.ant-select-dropdown`（`getBoundingClientRect().width>0` 且非 `display:none`）里按文本精确匹配。

## 5. 测试方式的假卡死

**现象**：用 `Start-Job` / 管道跑 `win-agent` 会「卡住」——是 PowerShell 作业基础设施拖死 CLI 输出，不是 `win-agent` 或 managed Chrome 的问题。

**解法**：用 `Start-Process` + `-RedirectStandardOutput` 到文件，或直接用宿主编排（如 `node .../run.mjs`）；不要用 `Start-Job` 断言「卡死」。

## 6. 无标签字段的身份判定：先用 UIA / OCR，不要先写探针值

**现象**：某些控件没有可读的 `label`（`innerText` 为空、无 `<label for>`），只有内部名（如 `data-fieldname`），无法直接判断业务含义；内部名还可能与显示标签语义不符（例：`sapxmhnew` 曾被误判为"经费负责人"，实为 **SAP项目号**）。

**解法（按成本从低到高，先试前面的）**：
1. **UIA 直读（首选）**：`ui.find` / `ui.tree` 按名字或类型查控件，能直接拿到控件名、类名与精确 bounds。实测 `ui.find name_contains="SAP项目号"` 一步命中，返回 `class_name="detail_1_4_16 etype_2 td_textalign_left"` 与坐标 —— 无需写任何值。
2. **截图 + OCR / 视觉**：`screen.capture_window` 取窗口图，用 OCR 后端（`paddle_tiny_offline` / `windows_media_ocr_offline`）读标签文字；相邻可见标签即业务含义。
3. **坐标法（纯 DOM 兜底）**：取所有可见文本节点，按与目标控件同排（垂直中心差 < 15px）或紧邻上方筛选，得到真实标签。
4. **写探针值（最后手段）**：仅当前三者都拿不到时，才写入可识别、无副作用的探针值再截图确认。探针值可能进入表单草稿，确认后应改为真实值或清空。

**教训**：先写值再猜语义会制造污染（本项目出现过探针/搜索值污染到该字段）；UIA 与 OCR 是**只读**手段，优先且零副作用。

## 7. 弹窗候选已列全时不要盲目搜索

**现象**：关联搜索弹窗（browser）打开后**已列出全部候选行**（如 SAP工厂弹窗「共8条」）。此时若仍执行"填搜索框 → 点搜索"，而搜索框语义与填的值不匹配（如往「工厂组织」框填工厂描述），结果会被过滤成 **0 行**，表现为 `row_not_found:0`。

**根因**：弹窗通常有多个同构搜索框（工厂组织/工厂编码/工厂描述，或内部订单/订单类型/订单描述），填错框即搜不到；而初始列表本来就是全量。

**解法**：模板为每个 browser 字段声明 `search`：
- `search: false` —— 弹窗打开即全量列出时，跳过搜索，直接按 `pick` 选行。
- `search: true` + `search_index` + `search_value` —— 目标不在首页、必须搜索时，显式指定用第几个可见搜索框（`.ant-input` 且可见）搜什么值。

**验证**：`search:false` 时结果应为 `skipped`；`search:true` 时应回显实际框数（不同弹窗框数不同，工厂弹窗 2 个、项目号弹窗 3 个），据此确认 index 正确。

## 8. 逐字符打字时字符泄漏到页面另一字段

**现象**：往弹窗搜索框打字（逐字符 `set value` + `input` 事件），部分字符落进了**页面上的另一个字段**。实测：搜项目号 `100167003201`，前 4 位进搜索框，后 8 位 `67003201` 漏进了底部的「经费负责人」`#field84777`。

**根因**：弹窗在输入过程中重渲染/失焦，焦点回到页面，后续字符就写到了当时的焦点元素上。逐字符路径只要有一步焦点不在目标上，就会出现这种静默串写 —— 而且**不报错**，只在事后回读时才暴露。

**解法**（两条一起用）：
1. **优先用 `chrome.fill`（CDP 可信输入）**，它对框架绑定字段和不稳定焦点都更可靠；不能定位弹窗内元素时才退回页面内 `typeInto`。
2. 凡是页面内逐字符写入，**写完必须立即回读目标元素的值并比对**；不一致就整段重填。不要假设"没报错就等于写对了"。

**验证**：回读每个被写入字段的实际值；对"本不该有值的字段"也做一次抽查，能发现泄漏。

## 9. 超时给太大 = 把失败伪装成慢（超时治理）

**现象**：给 `chrome.ensure` 配 60000ms 去启动一个实测 3.5s 的 Chrome，冷启动失败时不会很快报错，而是**静默耗掉几分钟**。实测一次 5 分 24 秒的"卡住"，本质是超时预算与操作量级不匹配，把"起不来"拖成了"等很久"。

**根因**：`win-agent` 每次调用有约 **7s 固定开销**（进程启动 + CDP 握手）；在此之上单条 `chrome.evaluate` 只有约 1s 增量（1 条=8.0s，5 条=12.2s）。超时不按这个量级设定，就会在失败路径上浪费成倍时间，还掩盖真实原因。

**实测基线**（Chrome 151，2026-09-23，本机）：

| 操作 | 实测 |
|---|---|
| win-agent 进程启动（固定） | ~7s |
| chrome.ensure（已就绪） | 1.2s |
| chrome.ensure（冷启动 managed） | 3.5s |
| chrome.evaluate ×1 / ×5 | 8.0s / 12.2s |
| chrome.targets | ~7.2s |
| 登录提交（evaluate 长脚本） | ~1.3s |

**解法**：
1. 超时集中定义在 `src/DeskPilot.Flow/timeouts.mjs`（`request` 15s / `requestUi` 20s / `ensure` 20s / `flow` 60s / `close` 3s），不要在脚本里散落硬编码数字。
2. 按量级配额度：约为实测的 **2 倍余量**即可；超出量级一个数量级的超时就是缺陷。
3. **合并请求摊薄固定开销**：7s 固定开销意味着 5 条请求批成一发只多花 4s，而不是 35s。
4. 每步输出 `elapsed_ms`：卡住时要能指出**卡在哪一步**，而不只是"卡住了"。
5. 超时触发即报错，不做静默重试 —— 重试会把失败再放大一遍耗时。

**验证**：修好后再测同一路径，登录从 5m24s 降到 1.3s、已登录快路径 993ms。若某操作稳定在超时的 80% 以上，说明额度该调或该拆分。

## 10. 「点了但没反应」：页面内 .click() vs chrome.click，以及先滚进视口

**现象**：对关联搜索字段的触发元素 `#field68033span`（`.wea-associative-click`）执行页面内 `el.click()`，返回成功、不报错，但**弹窗根本不出现** —— 后续每一步都变成 `no_modal`。改用 `chrome.click` 后报 `CHROME_ELEMENT_NOT_ACTIONABLE: matched page element is not visible in the viewport`。

**根因**：
1. `wea-associative` 这类组件只响应**真实输入事件**（与框架绑定字段必须用 `chrome.fill` 同源）。`el.click()` 派发的是不可信事件，组件忽略它。**"没报错"完全不等于"生效了"**。
2. `chrome.click` 走 CDP 可信输入，但它要求元素**在视口内**；长表单里字段常在首屏之外。

**解法**（两步都要）：
1. 先页面内 `el.scrollIntoView({block:'center'})`，再 `chrome.click`（CDP）。
2. 点击后**回读后果**（弹窗是否出现 / 值是否变化），不要以 `clicked:true` 作为成功。`clicked:true` 只说明"发出了一次点击"。

**教训**：这条与 #3（框架绑定字段）、#8（逐字符泄漏）是同一类问题的三个面 —— **凡是"写/点之后没报错"，都要立刻回读实际状态**。

## 11. 元素"存在"不等于"可见"：尺寸为 0 的字段必须回读尺寸

**现象**：`querySelector('#field68033span')` 能命中元素，`getComputedStyle` 也报 `display:inline-block; visibility:visible`，但 `getBoundingClientRect()` 与 `offsetWidth/Height` **全是 0**；整条祖先链（swapDiv → td）宽度也是 0。

**根因**：该字段在当前表单状态下**没有渲染**（本题里 `lcck` 是明细行列，不在主表），或者被联动折叠。仅凭"选择器命中"就以为字段可用，必然在点击/填写阶段失败，而且失败原因看起来像是"元素不可点"。

**解法**：判定字段可用要**同时**满足 `querySelector` 命中 **且** `getBoundingClientRect().width>0 && height>0`（必要时连祖先一起查）。用尺寸筛出"当前真正渲染出来的字段清单"，再决定填哪些；尺寸为 0 的字段应报成"当前状态下不存在/不可用"，而不是硬点。

**验证**：列出所有 `[data-fieldname]` 且宽度>0 的字段，与本表单要求的字段做差集 —— 差集里的字段不该在本轮被填，也不该被当成选择器写错。

**补充（2026-09-23 实测）**：**同一个 `data-fieldname` 可能出现多次，两处状态可以完全相反。** 实测某表单里 `wllx` 同时是明细行里 w=334 的真交互下拉，和主表里 w=0、`tr display:none` 的文本框。若遍历时"后写覆盖前写"，就会把可交互下拉记成隐藏文本框，后续阶段整个跳过它 —— 表现为"这张表单没有下拉"，而其实有。

**解法**：按 fieldname **去重，并优先保留"尺寸非零"的那个**：

```
seen = {}
for el in querySelectorAll('[data-fieldname]'):
    rendered = rect.width>0 && rect.height>0
    if seen[fn] and (seen[fn].rendered or not rendered): continue   # 已有更好或同等的一个
    seen[fn] = {el, rendered}
```

不要只看"哪个先出现"或"哪个后出现"—— **哪个真的渲染出来了才算数**。

## 12. 选择器连错两次就停止猜测，先截图（成本最低的一步）

**现象**：一个关联搜索字段，连续三次换触发方式都失败 —— 页面内 `el.click()`（无反应）、`chrome.click` 点输入区 `#fieldNNNNNspan`（`execution_layer:cdp_input`、元素 178×30 在真实坐标、`clicked:true`，但**页面上没有任何弹层出现**）、`chrome.fill` 写内层 `input.ant-select-search__field`（`verified:true`，仍无候选）。三次都"成功"、三次都没效果。

**根因**：我一直假设触发元素是**输入区**。截图一看，每个关联字段右侧清清楚楚有个**放大镜图标** —— 那才是搜索按钮，是和输入框**并列的另一个元素**。`observe` 一张截图就能看到，我却用三轮 DOM 探测去猜。

**解法**：
1. **选择器连续两次不奏效 → 立即 `observe` 截图看页面**，不要再猜第三个选择器。截图是一次调用，比三轮探测便宜得多，而且能直接看到"页面上到底有什么可点的东西"。
2. 读 DOM 时要问"这个字段里**所有**可点子元素是什么"，而不是只在已知的那个元素上换点击方式：`el.querySelectorAll('button, [class*=icon], [class*=search]')`。
3. 同理，字段结构要给**整段** `outerHTML`，不要只看开头 —— 触发按钮常在末尾。

**验证**：改成点放大镜按钮后，一次就打开了弹窗（标题「SAP工厂」），点行即回填并自动关闭。

**教训**：DOM 探测适合确认细节，不适合发现"我漏看了一个元素"。后者靠看。

## 13. 弹窗不关 → 逐字段静默错位（最危险，因为不报错）

**现象**：连续处理多个"点开弹窗→选行"的字段时，第 N 个字段打开的是**第 N-1 个字段遗留的弹窗**。实测：处理「项目号」时弹窗仍是「SAP_币种」，于是搜索框 id 取到了币种弹窗的 `con57482_value`、选行也选在币种弹窗里 —— 结果**币种被写成 ZWR、项目号留空**。

**为什么最危险**：每一步都返回成功。打开 `clicked:true`、填写 `verified:true`、选行也"点到了行"。**没有任何一步报错**，只有最后整体回读时才看出字段串了。如果恰好没做回读，就会静默提交一张错单。

**解法**（两条一起用）：
1. **每次打开弹窗后回读标题，与期望值比对**。模板为每个字段声明 `expect_dialog`（如「SAP_币种」）；实际标题不符时**立即停手、不搜不选**，记为 `WRONG_DIALOG`。宁可留空并报错，也不要把值写进别的字段。
2. **每个字段收尾统一关弹窗，并回读残留数**。关闭按可靠性排序：①「取消」按钮（最可靠）② 右上角 X `.ant-modal-close` ③ Esc。关键是**每步都回读可见弹窗数**——只"点了"不算关掉，实测点 X 有时无效。

**验证**：回读每个字段打开时的弹窗标题；处理完每个字段后回读可见弹窗数应为 0。

**推广**：任何"打开一个上下文容器 → 在其中操作 → 关闭"的循环都有这个风险（弹窗、抽屉、下拉、iframe 页签）。要点是**进入时确认身份，离开时确认已离开**。


> 分册索引：#1–#13 `universal-pitfalls.md`、#14–#18 `universal-pitfalls-14-18.md`、#19–#21 `universal-pitfalls-19-21.md`、#22–#27 `universal-pitfalls-22-27.md`、#28–#30 `universal-pitfalls-28-30.md`。
