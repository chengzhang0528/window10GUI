# Windows Agent CLI

这是面向 Windows 10 交互式桌面的 Agent GUI 操作 CLI，内部代号 DeskPilot。Agent 只发送公开的命令和 JSON/NDJSON，不接触 `HWND`、COM 或 `AutomationElement`。当前实现不需要 MCP Server：任意宿主都可以直接启动 `win-agent`，用标准输入输出传输请求；Feishu CLI 仅作为这种接入形态的参考，与本项目没有依赖关系。

架构、状态模型、底座职责和本机 ChatGPT Computer Use 的参考结论见 [Windows Agent CLI 当前设计](../../文档/项目/项目_windows-agent-cli/CURRENT_DESIGN.md)。

需要复用结构化场景、自动检查步骤结果与异常接管时，使用 [DeskPilot 结构化流程宿主](../DeskPilot.Flow/README.md)。该宿主通过本 CLI 执行，不把业务断言放入 CLI。

## 底座职责

CLI 是通用 Windows 10 交互式桌面执行底座：负责窗口/页面观察、GUI/CDP 动作、等待、引用生命周期、超时、结构化错误、批量组合、操作提示和前台恢复。外部 Agent 宿主负责业务意图、场景脚本、选择器、断言、测试数据、结果报告和高影响动作的授权。

CLI 不内置模型、规划、自研脚本 DSL、通用断言库或测试 runner。脚本应直接使用 JSON/NDJSON，或复用宿主语言和成熟开源测试框架，通过 `workflow.run`/`actions.batch` 调用 CLI；测试发现、fixture、断言、重试、报告和 CI 由外部 runner 或场景层负责。`workflow.run` 外层状态同步为 `completed`、`paused` 或 `cancelled`；暂停时先让用户处理登录/验证，取消时重新观察后再发起后续请求。

闲鱼、表单或其他应用示例只用于验证底座，不会成为核心业务模块。后续需求只有在能够跨应用复用、且可以通过公开命令表达时才沉淀到 CLI；单一网站或业务对象的逻辑应留在上层脚本/adapter。新增 provider 不得破坏 session、超时、错误、恢复和确认等公共契约。

## Development：构建 CLI

前置条件：Windows 10 build 19041 或更高、已登录的交互式桌面，以及本机 .NET SDK 10.0.302。当前工程只发布 `win-x64`；Chrome 为可选运行时，若存在则由 CLI 自动连接或启动，不需要插件、MCP Server、开发者工具或额外服务。

在仓库根目录执行：

```powershell
dotnet restore src\WindowsAgent.Cli\WindowsAgent.Cli.csproj --ignore-failed-sources
dotnet build src\WindowsAgent.Cli\WindowsAgent.Cli.csproj --no-restore
```

成功标志是 `0 个错误`。可直接执行的入口位于 `src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe`，同目录也保留 `win-agent.dll`。

需要不依赖目标机 .NET 安装时，使用自包含发布：

```powershell
dotnet publish src\WindowsAgent.Cli\WindowsAgent.Cli.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

自包含发布会下载 `win-x64` runtime pack；发布机需具备网络或预缓存该 runtime pack。要生成包含相对路径 Skills 和说明的便携目录，运行 `node src/WindowsAgent.Cli/build-portable.mjs --output <空目录>`。脚本拒绝非空目标，先生成并验证候选，再替换分发目录；不要覆盖正在使用的二进制。

## CLI 契约

单次调用适合诊断：

```powershell
src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe doctor
src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe windows find --process chrome
```

长任务使用一个持久 host 和 NDJSON；每行一个请求，每行一个响应：

```powershell
$requests = @(
  '{"id":"1","method":"windows.activate","params":{"process":"chrome"}}',
  '{"id":"2","method":"observe","params":{"process":"chrome","include_screenshot":false,"include_text":true,"depth":3}}'
)
$requests -join "`n" | src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe exec --stdin --format ndjson
```

同一 host 会继续接收尚未完成命令的输入；普通命令仍按生命周期锁串行执行，但响应按完成顺序返回，必须按 `request_id` 配对。这是长任务期间并发发送 `interaction.cancel` 的基础。

响应统一为 `ok`、`request_id`、`result` 或 `error`。常用方法是 `windows.list/find/activate/info`、`observe`、`ui.tree/find/get/invoke/click/set_value/select`、`input.click/type/key/scroll`、`screen.capture`、`messages.observe`、`wait.window/element`；Chrome 页面增强使用 `chrome.ensure/targets/attach/navigate/wait/evaluate/fill/select/click/query`。窗口可用 `process`、`title_contains` 等条件直接定位；返回的 `window_id` 仍只在当前 host 会话有效。单次调用和持久 NDJSON 会话的成功/失败封装都写入 stdout，stderr 仅保留非协议诊断。

`wait.element` 在总 `timeout_ms` 内轮询真正可用的 UIA 控件。Chrome 导航或动态界面重建导致的 `ELEMENT_NOT_AVAILABLE`、`UIA_QUERY_FAILED` 等可重试查询错误会被等待器吸收并继续轮询；只有预算耗尽才返回 `WAIT_TIMEOUT`，详情包含瞬态错误次数和最后一个瞬态错误码。调用方仍应选择只在目标状态出现的控件，避免源页面和目标页面共有文本造成过早匹配。

`ui.get` 对支持 UIA `TogglePattern` 的复选框、开关等控件返回 `toggle_state=on|off|indeterminate`。`ui.invoke` 优先使用控件的 `InvokePattern`，否则使用 `TogglePattern`，最后才回退到坐标点击；切换结果返回 `toggle_state_before`/`toggle_state_after`，上层必须据此或重新 `ui.get` 验证状态，不能把坐标点击已发送当作切换成功。

`input.type` 和 `ui.set_value` 的键盘 fallback 对纯 ASCII 使用 `SendInput`；含非 ASCII 的文本改用临时 Unicode 剪贴板粘贴，返回 `clipboard_paste` 或 `uia_clipboard_paste`。DeskPilot 只在内存中保留原剪贴板对象，粘贴消费后立即恢复；若期间已有其他参与者更新剪贴板，则保留新值而不以旧值覆盖。这个路径用于兼容会显示但丢弃或重复 `VK_PACKET` 字符的 Qt/自绘输入框，关键输入仍必须通过截图或控件值回读验证。

### 通用桌面消息采集

`messages.observe` 对指定窗口先执行可信截图，再用 Windows 自带的离线 OCR 返回带位置的文本候选。调用方应传窗口相对坐标的 `identity_region`、`content_region`，并用 `expected_identity` 断言当前会话；身份不匹配时命令返回 `CONTEXT_IDENTITY_MISMATCH`，不会把其他会话内容误归到目标。

```json
{"id":"observe-chat","method":"messages.observe","params":{"process":"ExampleChat","identity_region":{"x":260,"y":0,"width":620,"height":90},"content_region":{"x":260,"y":90,"width":620,"height":520},"expected_identity":["Support queue"],"identity_match":"all","restore_original_window":true}}
```

默认结果只包含身份区文本、内容区文本和 `message_candidates`，每项带 `bounds`、`side` 与几何 `role_hint`；调试时可传 `include_text_blocks=true`，需要逐词坐标时再加 `include_words=true`。OCR 字符可能有误，左右位置也不等于已确认用户身份。消息气泡归并、发送者识别、去重、跨页滚动、统计、回复策略和应用选择器由上层 Agent 脚本负责，CLI 不内置微信、客服软件或网站流程。

### 国内网络下的全自动 Chrome 页面操作

`chrome.ensure` 默认先连接本机已有 CDP；没有端点时启动受控 profile，不关闭已有 Chrome。受控 Chrome 使用动态非零 loopback 调试端口并记录端点，不要求插件或 DevTools。`profile_mode=managed` 只复用受控 profile 的端点；`current` 不会替用户关闭运行中的 Chrome。显式 endpoint/port 只连接该目标，失败不改连其他实例。失败详情 `attempts` 给出 version、targets、websocket_or_initialization 阶段与错误码。操作步骤见 [连接与恢复](../../.agents/skills/deskpilot-browser/references/connection-and-recovery.md)。

关闭 CLI 会话会等待 helper 退出，必要时只终止 helper，不终止其浏览器子树。外部宿主可能有自己的子进程回收规则；在 DSH 等宿主中使用支持跨工具调用的持久会话，保留 stdin 和真实作业 ID，跨调用后核验 endpoint。`interaction.end` 只结束 lease，`close`/EOF 结束 CLI，均不是关闭浏览器。已授权的演示快捷登录可由 Agent 点击并核验；密码、OTP 和风控验证交给用户。

每个 `chrome.ensure`、`chrome.attach` 和页面动作结果都返回 `target_id`、`window` 与 `window_binding`。GUI fallback 必须复用这个 `window.window_id`；不要从 `windows.find --process chrome` 的第一个结果猜主窗口，因为翻译提示、恢复气泡也可能是独立 Chrome 顶层窗口。已有 CDP 包含多个页面时，先 `chrome.targets`，再按已核验的 URL/标题用精确 `target_id` 调 `chrome.attach`。

```powershell
$fixture = "file:///" + ((Resolve-Path "test-fixtures\agent-form.html").Path.Replace("\", "/"))
$request = @{ id = "chrome-workflow"; method = "workflow.run"; params = @{ timeout_ms = 90000; show_overlay = $true; restore_original_window = $true; steps = @(
  @{ step_id = "ensure"; method = "chrome.ensure"; params = @{ auto_start = $true; url = $fixture } },
  @{ step_id = "load"; method = "chrome.navigate"; params = @{ url = $fixture; wait_until = "network_idle"; timeout_ms = 30000 } },
  @{ step_id = "fill"; method = "chrome.fill"; params = @{ selector = "#query"; value = "Domestic network" } },
  @{ step_id = "choose"; method = "chrome.select"; params = @{ selector = "#category"; value = "Automation" } },
  @{ step_id = "run"; method = "chrome.click"; params = @{ selector = "#run" } },
  @{ step_id = "ready"; method = "chrome.wait"; params = @{ selector = "#result"; expression = "document.querySelector('#result').textContent.includes('Domestic network')"; timeout_ms = 5000; stable_ms = 100 } },
  @{ step_id = "read"; method = "chrome.evaluate"; params = @{ expression = "document.querySelector('#result').textContent" } }
) } } | ConvertTo-Json -Depth 20 -Compress
$request | src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe exec --stdin --format ndjson
```

`chrome.navigate` 默认等待 `DOMContentLoaded`，但页面已出现通用可操作内容时即使 `readyState=loading` 也可继续，不会把 `readyState=complete` 当作所有页面的前置条件。需要等真正可用的控件或结果时，可直接在导航中传 `ready_selector`、`ready_expression` 和可选 `ready_stable_ms`，例如：

```json
{"method":"chrome.navigate","params":{"url":"http://127.0.0.1:8080/search","ready_selector":"#results","ready_expression":"document.querySelector('#results').children.length > 0","timeout_ms":30000}}
```

也可继续用 `chrome.wait` 组合多个条件。技术或语义等待超时分别返回 `CHROME_PAGE_LOAD_TIMEOUT`、`CHROME_WAIT_TIMEOUT`；详情包含 target、阶段、URL/title、readyState、visibility、正文长度、可操作元素数量、`page_state`、`pause_reason`、匹配数量、请求计数、主文档 `navigation_trace` 和耗时预算。等待期间出现登录或验证时立即返回 `CHROME_USER_ATTENTION_REQUIRED`；页面明确显示访问频繁、访问拒绝或操作暂时不可用时立即返回 `CHROME_PAGE_BLOCKED`，不再空耗完整 selector timeout。`page_state=login_required` 或 `risk_challenge` 表示需要用户处理的暂停，不是可自动绕过的失败；`access_blocked` 是站点拒绝当前访问/操作，不得误报为页头登录。CLI 会激活绑定的 Chrome 登录/验证主窗口并停留在那里，不恢复到用户原工作窗口。批次此时返回 `status=paused`、`pause` 以及 activity 的 `foreground_preserved`/`preserved_window`/`preservation_error`，宿主应等待用户处理后再发起后续请求。脚本抛错为 `CHROME_SCRIPT_EXCEPTION`，填值/选择回读不一致分别为 `CHROME_VALUE_NOT_VERIFIED`、`CHROME_SELECTION_NOT_VERIFIED`。工作流步骤按顺序执行，使用同一个彩色提示边框和一次前台恢复（暂停时改为保留用户注意力窗口）。

### 一次 lease 批量完成 GUI 动作

填写表单、选择选项、提交并回读时，优先使用 `actions.batch`，让提示框和原前台窗口恢复只发生一次：

```powershell
$request = '{"id":"form","method":"actions.batch","params":{"activity_label":"AGENT 操作中","show_overlay":true,"show_action_trace":true,"restore_original_window":true,"actions":[{"step_id":"query_input","method":"ui.find","params":{"automation_id":"query","first":true}},{"step_id":"fill","method":"ui.set_value","params":{"element_id":{"$ref":"query_input.result.elements[0].element_id"},"value":"Latest build check","confirmed":true}},{"step_id":"category_input","method":"ui.find","params":{"automation_id":"category","first":true}},{"step_id":"select","method":"ui.select","params":{"element_id":{"$ref":"category_input.result.elements[0].element_id"},"value":"Automation","confirmed":true}},{"step_id":"run_button","method":"ui.find","params":{"automation_id":"run","first":true}},{"step_id":"run","method":"ui.invoke","params":{"element_id":{"$ref":"run_button.result.elements[0].element_id"},"confirmed":true}}]}}'
$request | src\WindowsAgent.Cli\bin\Debug\net10.0-windows10.0.19041.0\win-x64\win-agent.exe exec --stdin --format ndjson
```

批次最多 32 步，按输入顺序执行，默认首错停止且不回滚；`on_error=continue` 只适用于相互独立的非变更读取。步骤可以用严格的向前 `$ref` 引用前一步结果（例如 `find.result.element`、`list.result.windows[0].window_id`），引用只是一份结果数据，变更或 lease 结束后不能拿它当作仍然有效的 UIA 观察。

如果需要跨多次请求继续操作，使用持久 host 的显式 lease：

```json
{"id":"begin","method":"interaction.begin","params":{"label":"AGENT 操作中","show_overlay":true,"show_action_trace":true,"restore_original_window":true}}
{"id":"step","method":"windows.find","params":{"process":"chrome"}}
{"id":"end","method":"interaction.end","params":{"interaction_id":"<begin.result.interaction_id>"}}
```

`interaction.begin` 返回不透明的 `interaction_id`。每个操作会立即用准确的 `action_label` 原位更新稳定状态面板、显示静态多显示器彩色控制边框，并把边框截止时间滑动到 2 秒后；相邻操作到来时只重置计时，不隐藏/重建窗口。正常 `end` 把面板切换为“等待下一步”，边框按原截止时间自然熄灭；`cancel`、暂停和失败立即熄灭边框。稳定状态面板保持到下一次请求更新或会话 `close`。若 Chrome 在 lease 内进入 `login_required`/`risk_challenge`，结束时会保留该 Chrome 窗口在前台，让用户完成登录或验证。边框和面板都是非激活、鼠标穿透的可见提示，不是隔离桌面或安全锁；面板存在不代表仍在控制屏幕。需要提示框创建失败时阻止操作可传 `overlay_required=true`。需要观看每一步时可在 `interaction.begin`、`actions.batch` 或 `workflow.run` 传 `show_action_trace=true`；可选覆盖层在动作持续约 300 ms 后绘制合成指针和脉冲高亮，动作结束立即清除。合成指针不移动用户真实鼠标，坐标 fallback 发送事件后会尽力恢复用户原位置；截图会在取证帧短暂隐藏提示层。长命令运行期间可并发发送 `interaction.cancel`；先收到 `cancellation_requested`，当前动作在边界停止，批次返回 `status=cancelled` 并清理 lease，已发出的输入不回滚。单步命令也会自动创建短 lease；返回观察、元素或截图引用的读取方法默认保留目标窗口激活，其余动作默认恢复原窗口（用户注意力暂停除外）。要让单步读取也恢复焦点可传 `restore_original_window=true`；连续操作应使用批处理或显式 lease。
`interaction.status` 和各批次返回的 `activity` 会同时给出 `status`、`status_panel_visible`、`status_panel_label` 与 `overlay_visible`。`overlay_visible` 只表示控制边框仍在最近操作的 2 秒可见期内；`status_panel_visible=true` 可以只是稳定面板保留最近状态。

## Agent 操作规则

1. 先 `windows.activate`，再 `observe` 或 `ui.find`。最小化窗口没有可靠的 UIA 内容。
2. `ui.find` 返回的 `element_id` 必须和同一响应中的 `observation_id` 一起使用；下一次观察会使旧元素失效。
3. 坐标输入必须带当前 `observation_id` 或 `screenshot_id`；只有明确传 `allow_unobserved=true` 才允许无观察坐标。
   目标窗口拥有的前台菜单、下拉或补全列表会被视为目标仍在前台；同进程、无 owner 的 Qt 顶层窗口还必须由 popup/menu/tooltip 类名或受限的相对尺寸与重叠关系证明为瞬态弹层，才会绑定到目标。普通的第二个同进程窗口不会因使用 popup 样式且重叠而冒充目标。结果中的 `foreground_relation` 可用于诊断绑定依据。
4. `verify=true` 只请求动作后的再次观察，不替调用方判断业务谓词；真正的成功条件应再调用 `ui.get`、`ui.find` 或 `windows.find`。
5. UAC、管理员权限窗口、删除/提交等高影响动作不由 CLI 绕过或自动确认。
6. 宿主可以在写操作参数中传 `require_confirmation=true`；未同时传 `confirmed=true` 时，CLI 返回 `NEED_USER_CONFIRMATION`。
7. UIA 标记为密码的控件不会回读值；`ui.set_value` 或聚焦后 `input.type` 会返回 `SENSITIVE_INPUT_BLOCKED`，登录、OTP、验证码由用户手动完成。
8. `input.scroll.amount` 使用 Windows 鼠标滚轮原始增量（正值向上、负值向下）；调用方应显式传值，不依赖默认值。
9. `screen.capture` 未传 `path` 时返回的是当前 session 拥有的临时文件，只应在截图缓存达到上限或持久会话关闭前消费；单次命令会在响应后立即关闭 session，若要在命令退出后读取截图必须传入显式绝对 `path`。屏幕拷贝前会核验窗口 PID、类名、边界、前台关系和 3×3 采样点归属，可信结果返回 `trusted=true`、`foreground_relation`、`ownership_samples` 和 `screen_copy_foreground_verified`；提示边框在取证帧短暂隐藏。无法证明目标归属或得到有效画面时会返回 `WINDOW_CAPTURE_UNTRUSTED`、`WINDOW_CAPTURE_EMPTY`、`WINDOW_IDENTITY_MISMATCH` 或 `WINDOW_CAPTURE_FAILED`，不会拿其他应用画面或 `PrintWindow` 空图冒充目标结果。
10. `actions.batch` 返回每个步骤的 `step_id`、`ok`、`result`、`error` 和 `outcome`。若变更可能已经发送到 Windows 但结果不确定，顶层为 `BATCH_OUTCOME_UNKNOWN`；宿主必须重新观察后再决定恢复，不要自动整批重试。

## Development：当前 Chrome 验证

测试页 `test-fixtures\agent-form.html` 是本地、无网络的确定性页面，包含输入框、下拉框、查询按钮和可选的 `?delay_ms=800` 延迟条件。以下动作已在当前已登录 Chrome 的新标签页中用 `win-agent.exe` 的同一 NDJSON 会话实际完成：输入 `Latest build check`，选择 `Automation`，调用按钮，并从 UIA 文本和窗口标题读回 `Query: Latest build check | Category: automation`。显式保留的截图位于 [`artifacts\chrome-cli-final-overlay-batch.png`](../../artifacts/chrome-cli-final-overlay-batch.png)。activity 的验收标准是操作后 `overlay_was_visible=true`、最后操作 2 秒后 `overlay_visible=false`、`status_panel_visible=true`、`status=idle`、`restored_original_window=true`，说明瞬时控制提示与稳定状态面板已经分离。

网页控件是否出现在 Chrome UIA 树取决于窗口是否已恢复并置前台；若网页树为空，应先重新 `activate → observe`，仍为空时使用键盘/坐标 fallback，不把 UIA 空树当成页面不存在。`doctor` 会把 GUI、Windows 离线 OCR 与 Chrome/CDP 分开报告，Chrome 不可用时 GUI 仍可用。可信前台窗口截图标明 `screen_copy_foreground_verified`；后台 `PrintWindow/GDI` 结果为空或不可信时明确失败，应先激活后再取证。

## Development：通用桌面消息采集与回复验证

同一公开 CLI 已在当前 Windows 10 桌面完成两类应用的 Development 级验证：在 Qt 聊天窗口中用调用方给定区域断言目标会话身份、采集当前可见消息候选、填写并发送一条测试回复，再从排除输入框的消息区域回读到右侧候选；在 ChatGPT 窗口中复用同一 `messages.observe`，使用另一组身份条件成功读取定位文本。微信窗口的下拉弹层在列窗与截图期间保持打开，证明观察没有通过重新激活父窗口破坏弹层。

这项验证只证明通用执行原语，不把任何应用业务流程写入 CLI。一次调用只覆盖当前可见区域；完整历史需要上层 Agent 用滚动、每页身份复核和去重循环完成。测试截图由 session 临时管理并已清理，没有把聊天内容写入仓库。

## SystemTest 与 Deployment

本目录当前只提供 Development 级 CLI 和本地冒烟验证，没有独立 SystemTest 计划、安装器或已授权 Deployment。发布前应另行建立测试与部署入口，并验证自包含包、权限边界、DPI/多显示器和失败重试。
