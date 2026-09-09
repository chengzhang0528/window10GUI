# Windows Agent CLI 产品契约

Status: Active
Kind: ProductContract
Scope: windows-agent-cli / Windows 10 交互式桌面 GUI 自动化
Owner: 项目维护者
Updated: 2026-09-09
Depends On:
- ../../WORKSPACE_STRUCTURE.md

## 产品结果

### 核心定位与默认目标

面向专门配置、已登录且保持可交互桌面的 Windows，用户给出 Web UI 业务目标后，Agent 观察当前页面，将已明确的相关动作与检查放入一次短批次连续执行；在新页面、结果分支或偏差处重新观察和判断，继续完成目标。首次操作与局部恢复不以建立完整场景 JSON 为前提。批次内由执行器处理动作和等待，减少不需要新判断的模型往返。

已有流程仅在目标、参数、前提与副作用均匹配时复用；用户要求复用或已验证的重复操作有沉淀价值时，再保存纯数据流程。成熟流程由通用执行器检查并连续运行，偏差交给 Agent。固定验证场景不是任意业务目标的默认操作路径；场景文件生成或重放成功不代替用户目标完成。

后续方案、开发与场景工作默认以此目标评估，不要求用户重复说明。共享桌面人工干扰和跨应用通用性不是首要优化目标；现有通用桌面能力继续保留。没有用户同时操作不等于锁屏、服务会话或安全桌面执行，也不表示已承诺远程无人值守能力。

### 连续操作与结构化复用

- Agent 拥有意图理解、观察和下一批次选择；CLI 保持通用执行底座，不内置模型规划。复用同一个交互会话只减少焦点和提示开销，不等于减少模型调用；已明确的多个动作必须在同一次工具执行中完成。
- 批次边界由是否需要新信息决定。已观察的表单可连续填写并统一回读；未知弹窗、保存结果或新的搜索结果需要观察后再选择下一批次。等待在执行器内按有界就绪条件完成，不要求模型反复轮询。
- 可恢复偏差由 Agent 在确认旧执行者退出、读取当前状态和已发生效果后继续处理。未知写入效果不能盲目重放；常规恢复不要求先编写恢复 JSON，也不需要用户逐步批准。
- 以下数据约束仅适用于选择保存或重放的结构化流程，不限制 Agent 通过公开 CLI 进行临时批次编排。

- 场景流程必须是人和 Agent 都可阅读、局部修改的纯数据，表达输入参数、有序步骤、稳定步骤 ID、用户可读标签、动作、定位、等待条件和完整成功判据。当前采用 JSON；不能用导出对象的 .mjs、可执行表达式或指向场景函数的 handler 代替数据。
- 通用执行器保留程序实现，将有限动作与声明式判据映射到公开 CLI。具体网站的判断依据必须留在流程数据中；已有原语无法表达时显式暴露能力缺口，再优化通用能力，不要求 Agent 为每个场景编写代码。
- 等待可以同时表达最小延迟与有界就绪条件，例如至少等待 200 ms 后继续检查表单可见；时间经过不等于页面就绪。
- 每一步反馈执行状态、预期是否满足、实际结果、耗时及必要错误/证据引用。用户展示与 Agent 消费使用同一执行结果，分别呈现简洁进度与结构化详情。
- 脚本必须主动检查当前步骤的前置条件、动作后置条件，以及当前步骤依赖的前序结果；条件不成立或无法可靠检查时停止正常流程并抛出结构化异常，由宿主将异常返回给 Agent 接管，不能只写日志或等待模型从截图中发现问题。后续发现前序结果失效时，分别报告发现步骤、结果产生步骤、受影响步骤及证据，不把结果失效直接当成已确认根因。
- 正常步骤由脚本及场景层检查后继续，不要求模型逐步读取完整页面、截图与历史；异常时向 Agent 提供相关步骤和必要上下文，由其决定等待、重新观察、局部调整或停止。
- 明确区分事件已发送、控件值正确、页面状态稳定与业务结果成立。业务成功谓词归场景层或外部测试工具，不由 CLI 猜测。
- 异常恢复先读取已发生的状态，再决定继续位置；不得对结果不明的变更盲目整批重试。测试发现产品错误时不得修改业务预期来获得通过；业务预期变化须有需求依据。
- 通用进化方法归 Skill，网址/定位/参数引用/预期归可复用场景流程，执行反馈归调用方；不把所有网站步骤和执行历史塞入 Skill，不保存秘密或客户数据。
- 整体体验以首次有效动作时间、实际模型往返、业务完成率、恢复成本和用户中断次数等证据评估；复用效果另计流程完成率、耗时和 Token 消耗。宿主内部无模型调用不代表整个任务无模型成本，不以单次成功或改成 JSON 作为成熟证明。

以上为目标契约，不表示统一场景格式、逐步预期检查、恢复和自动进化均已实现；当前支持与缺口由 [当前设计](CURRENT_DESIGN.md) 区分。

结构化步骤、成功判定、前序结果复核与主动异常交接的目标设计见 [结构化流程与 Agent 接管设计](DECISION_STRUCTURED_FLOW.md)；该设计不表示代码已实现。

### 两个独立工作方向

1. **专项场景验证、调整与进化 Skill**：建立“复用或生成流程 → 执行与检查 → 偏差诊断 → 有依据的局部调整 → 验证后复用”的方法，打磨具体场景。方法与场景文件分开，产品缺陷与执行定位问题分开。
2. **执行底座的纯代码技术优化**：优化协议、模块职责、步骤反馈、等待、超时、取消、引用与恢复边界，保持已有接口可用；不承担具体网站选择器、业务预期或场景效果打磨。代码改动仍需范围匹配的定向验证。

两个方向通过已证实的通用执行能力缺口衔接；网站特有变化留在场景层。方向定义不自动启动任务，也不自动授权独立系统测试或部署。

Windows Agent CLI 为上层 Agent 提供一个进程级、与 Agent 框架无关的 Windows 10 GUI 操作入口。上层只表达“找窗口、观察界面、找控件、执行动作、等待并读取结果”，不直接持有 `HWND`、COM 或 `AutomationElement`。

第一版交付结果是：任意能启动本地进程并读写标准输入输出的 Agent 宿主，都能在已登录用户的交互式 Windows 10 桌面中，通过 JSON/NDJSON 调用该能力；接入不要求 MCP Server。

## 底座定位与职责边界

Windows Agent CLI 固定为“可被任意 Agent 编排的 Windows 10 交互式桌面自动化执行底座”。它不是端到端智能体、业务自动化产品、脚本语言或测试平台，也不内置模型、规划和视觉决策。闲鱼、表单和其他应用只能作为验证底座能力的场景；场景数量增加时，优先沉淀可跨应用复用的执行原语，不把场景规则写入底座。

### 底座负责

- 通过 argv/NDJSON 提供稳定的进程级调用协议、会话、操作 lease、超时、取消和结构化错误。
- 发现、观察、激活和操作 Windows 窗口及控件，并提供 UIA、SendInput、Win32、可信截图和离线桌面文本识别等 GUI provider。
- 通过内置 CDP provider 操作 Chrome 页面；CDP 与 GUI 是平级执行层，可在同一工作流中混用。
- 提供等待、结果读取、观察凭据、引用失效、截图证据、前台恢复和用户可见操作提示。
- 提供可组合的 `workflow.run`/`actions.batch` 原子步骤，使上层宿主可以编写脚本完成连续动作。

### 场景层负责

- 业务意图、页面/应用选择器、流程编排、业务断言、测试数据、重试策略和结果报告。
- 登录态、账号选择、验证码/OTP、付款或其他业务高影响动作的授权与停止点。
- 对具体网站或应用的适配、领域 API、业务对象和数据清理；这些不进入 CLI 公共契约。

### 明确不属于底座

- 闲鱼购物、支付、客服、发布商品等任何特定业务流程。
- 自研脚本 DSL、业务断言库、测试 runner、测试管理平台、报告平台、CI 调度和场景编排。
- MCP Server、浏览器扩展、云端编排和跨机器控制。
- 绕过 UAC、验证码、权限或安全桌面，以及锁屏/服务会话中的无人值守操作。

### 方向不变量与变更门禁

以下内容是产品方向不变量，后续需求不得从单个场景、一次验证结果或“以后可能有用”推断改变：

1. CLI 只拥有本地 Windows 桌面/Chrome 的执行、等待、观察、证据和生命周期协议；Agent 宿主拥有意图、规划和授权。
2. 脚本使用公开的 JSON/NDJSON、`workflow.run` 和 `actions.batch` 即可完成编排。需要更高层语法时，优先复用宿主语言或成熟开源 DSL，通过适配器调用 CLI，不在核心新增自研语言。
3. 测试 runner、断言、fixture、重试、并发、报告和 CI 属于外部通用工具或场景层。CLI 只提供 runner 所需的稳定进程协议、结构化错误、超时、验证面和可选证据路径。
4. 新 provider 或通用动作只有在至少两个独立场景复用、且不改变现有 session、引用、超时、错误、恢复和确认不变量时，才可进入底座。

若提案要把 CLI 变成端到端 Agent、业务 adapter 集合、自研脚本/测试平台、云端或无人值守控制面，必须先由用户明确提出“改变产品定位”，并单独修订本契约、当前设计和验收边界；在此之前应停止实现，不得以增强名义扩张职责。

### 后续场景的扩展准入规则

1. 新能力必须能用“窗口/页面/控件/输入/等待/读取/证据”描述，并至少可被两个不同场景复用，才进入底座。
2. 只服务一个网站、应用或业务对象的逻辑放在上层脚本、宿主或独立 adapter 中，通过公开 CLI 调用底座。
3. 新 provider 只能扩展执行层，不得改变会话引用、超时、错误、恢复和确认等公共不变量。
4. 场景验证结果用于证明能力，不自动升级为产品承诺；只有跨场景稳定、可观察的行为才写入本契约。
5. 脚本 DSL、断言和测试 runner 默认在 CLI 外部复用成熟开源技术；只有补齐 CLI 进程协议缺口的最小适配能力才进入底座。

## 已确认环境与接入边界

- 目标操作系统是 Windows 10 build 19041 或更高，当前只支持 `win-x64`。
- 运行位置是已登录用户的交互式桌面会话；CLI 默认以当前普通用户权限运行。
- Agent 接口是可执行文件的参数或持久标准输入输出。NDJSON 请求为 `{ "id", "method", "params" }`，响应为 `{ "ok", "request_id", "result" }` 或 `{ "ok", "request_id", "error" }`。
- MCP、gRPC、浏览器扩展和外部自动化服务不是依赖；Chrome 页面增强使用 CLI 内置的本机 DevTools Protocol 客户端（localhost HTTP/WebSocket），不要求用户安装插件或手动打开开发者工具。
- Agent 只能使用会话内的 `window_id`、`observation_id`、`element_id` 和 `screenshot_id`；不得向其暴露原生句柄或 UIA 对象。

## 行为契约

执行顺序固定为结构化能力优先：

1. UI Automation Pattern。
2. UIA 元素定位后的真实键鼠输入。
3. Win32 窗口管理和输入。
4. 带新鲜观察凭据的坐标输入。

Vision 和通用图像理解是后续 provider 边界。当前离线 OCR 只把可信窗口截图转换为带位置的文本候选，不负责理解应用或业务语义。应用存在稳定原生 API 时，应由应用专用工具负责业务语义，本 CLI 只负责 GUI 和系统交互。

第一版公开能力覆盖：

- 窗口：列举、查询、激活、读取信息。
- 观察：有界 UIA 树、焦点、可信窗口截图、屏幕/DPI 元数据，以及 `messages.observe` 提供的离线定位文本候选。
- 控件：查找、读取、调用、点击、输入值、选择选项。
- 输入：窗口内坐标点击、双击、右击、文本、按键、组合键、滚轮。
- 等待：等待窗口或控件出现。
- Chrome 页面：自动连接已有调试端点，或启动受控 Chrome；显式列出/切换 page target，并把当前 `target_id` 与核验后的主 Chrome `window_id` 绑定返回；导航默认等待 `DOMContentLoaded` 或已出现的通用可操作内容，也可按调用方要求等待 `load`/`complete`/稳定的 `network_idle`，或在同一导航预算内等待可用控件/结果条件；执行 JavaScript、CSS 控件查询、填值、选择、可信浏览器输入点击并回读校验。
- 工作流：`workflow.run`/`actions.batch` 在一个 NDJSON 请求中按顺序组合 Chrome DOM/脚本操作和现有 Windows GUI 操作。
- 诊断：能力列表、Windows/GUI/Chrome/CDP 分项运行环境诊断，以及等待/导航失败的稳定错误码和轻量状态详情。

### 操作提示与批处理

- `actions.batch` 接收最多 32 个有序步骤，在同一个 session 中连续执行；步骤可调用 `chrome.*`；默认遇到第一处错误即停止，步骤之间不是事务，不提供回滚。`workflow.run` 是面向脚本宿主的同等入口，返回一个额外的 `workflow` 包装层，其状态同步为 `completed`、`paused` 或 `cancelled`。
- `interaction.begin`、`interaction.status`、`interaction.end` 和 `interaction.cancel` 允许宿主显式持有一段连续的桌面操作。`begin` 返回不透明 `interaction_id`；正常结束会把面板切换为等待状态，并让控制边框按“最后一次操作后 2 秒”滑动截止时间自然熄灭，紧邻请求到来时复用同一提示窗口而不先隐藏再创建；暂停、取消和失败则立即熄灭边框。结束仍会尽力恢复开始前的前台窗口。稳定状态面板继续显示最近状态，直到下一次请求更新或会话 `close` 销毁；若 Chrome 报告 `page_state=login_required` 或 `risk_challenge`，则用户注意力窗口优先级更高，结束时保留匹配的 Chrome 窗口在前台，宿主应让用户处理后再发起后续请求。
- 批处理或显式 interaction 默认显示跨显示器的无激活、鼠标穿透彩色控制边框、状态标签和稳定状态面板；它不锁住桌面，也不承诺隔离桌面。activity 请求传 `show_overlay=false` 可抑制这些提示，`overlay_required=true` 可把提示创建失败变成错误。控制边框是静态的瞬时提示：每个新操作立即显示并重置 2 秒滑动截止时间，不以高频动画持续重绘；状态面板是 session-scoped 的稳定可见状态，并立即显示当前步骤的 `action_label`。不得把面板存在解释为仍在控制屏幕，`overlay_visible` 只表示控制边框当前仍在可见期内。
- 需要观看 Agent 动作时，在批次、`workflow.run` 或 `interaction.begin` 传 `show_action_trace=true`（也接受 `visualize_actions=true`）。覆盖层会在每个可定位动作处绘制醒目的合成指针、脉冲圆环和动作标签；步骤可用 `action_label` 提供语义标签。状态面板的步骤文案不依赖动作轨迹开关；可选动作轨迹采用约 300 ms 去抖，短读取不闪烁，动作结束立即清除；合成指针不移动、不隐藏用户真实鼠标，也不获得焦点。坐标 fallback 为发送事件可能短暂使用 OS 鼠标，动作后尽力恢复用户原位置。该提示是 best-effort，`activity.action_trace_requested`/`action_trace_visible`/`current_action` 会返回可观察状态。
- `interaction.cancel` 可在同一持久 `exec --stdin` 会话中作为并发控制请求发送。它先返回 `status=cancellation_requested`，当前命令在下一个动作或等待边界停止，批次最终返回 `status=cancelled` 并清理 activity lease；已发送的输入不能撤销，步骤不会回滚。无正在执行的命令时，cancel 直接结束活动并将稳定状态面板留在“已取消”，而不是让下一请求前出现空白提示。
- 为支持上述控制请求，`exec --stdin` 可同时提交尚未完成的 NDJSON 请求；引擎仍按生命周期锁串行执行普通命令，响应按完成顺序返回，必须用 `request_id` 配对，不能依赖发送顺序。
- 自动单步调用也会按方法显示短时提示；返回观察、元素或截图引用的读取方法默认保留目标窗口激活，以便下一请求消费短期引用，其余动作默认恢复开始前的前台窗口。若要统一收口，应使用批处理或显式 interaction；单步读取也可明确传 `restore_original_window=true`。
- 恢复是 best-effort：原窗口被关闭、句柄身份变化、权限或 Windows 前台策略阻止时，结果通过 `restoration_error` 和 `cleanup_errors` 报告；不绕过 Windows 前台限制。登录/风控暂停时，结果还会返回 `status=paused`、`pause`、`foreground_preserved`、`preserved_window` 和 `preservation_error`；此时不应把“恢复原窗口”当作成功标准。

## 状态与正确性

- 一个持久 helper 进程拥有一个 session；窗口、元素、观察和截图标识只在该 session 内有效。
- `window_id` 绑定发现时的窗口身份；如果 HWND 被关闭或回收，旧 ID 必须重新发现，不能复用到替代窗口。
- 元素必须绑定产生它的当前观察。窗口激活、移动、缩放、新观察或动作导致旧引用失效时，调用方必须重新观察或查询。
- 坐标动作默认必须提供当前窗口最新的 `observation_id` 或 `screenshot_id`，并通过窗口边界检查。
- 目标窗口拥有的前台菜单、下拉或补全列表视为目标仍处于前台；除标准 owner 关系外，同进程、无 owner、且能由弹层类名或相对目标的受限尺寸与重叠关系证明为瞬态的 Qt 顶层弹层也按目标关系处理。普通的第二个同进程窗口不得仅因使用 popup 样式和发生重叠而冒充目标。观察和坐标动作不得为重新激活真实弹层而关闭它，返回值用 `foreground_relation` 报告绑定依据，坐标仍必须落在父窗口边界及新鲜截图范围内。
- `messages.observe` 必须使用调用方提供的 `identity_region`、`content_region` 和可选 `expected_identity` 识别当前可见上下文；身份不匹配返回 `CONTEXT_IDENTITY_MISMATCH`，不得继续把其他会话或窗口文本归入目标。返回的是带 bounds、左右几何提示和来源块的 `message_candidates`；消息分组、去重、跨页滚动、用户身份归并、统计和回复策略仍由上层场景脚本负责。
- “输入事件已发送”不等于业务成功。关键动作之后，调用方必须用 `ui.get`、`ui.find`、`windows.find` 或等待命令验证业务谓词。
- `input.type` 和输入框的 UIA 键盘 fallback 对纯 ASCII 保留 `SendInput`；含非 ASCII 的文本使用临时 Unicode 剪贴板粘贴以兼容 Qt、自绘等会丢弃 `VK_PACKET` 字符的控件，执行层分别报告 `clipboard_paste` 或 `uia_clipboard_paste`。CLI 在内存中保留并恢复原剪贴板对象；若粘贴期间已有其他参与者更新剪贴板，则不以旧值覆盖新值。
- 操作 lease 结束后，因恢复前台或动作造成的 UIA/坐标引用均视为不可复用；批处理返回的步骤结果用于审计和后续判断，新的动作应重新观察。
- 未指定输出路径的临时截图由 session 管理，关闭或达到缓存上限时删除；需要在单次命令退出后或跨进程读取时，调用方必须提供显式绝对 `path`。
- 批处理只支持向前引用已完成步骤的结果，例如 `{ "$ref": "query.result.elements[0].element_id" }`；引用错误不会执行该步骤。写操作失败时结果为 `BATCH_OUTCOME_UNKNOWN`，宿主不得自动整批重试。
- 所有失败返回稳定 `error.code` 和 `retryable`，调用方不得解析自然语言消息决定恢复路径。

### Chrome 自动化与国内网络

- `chrome.ensure` 先尝试 loopback 地址的 9222..9232 端口、调用方指定的端点、受管 profile 的 DeskPilot 端点记录或 Chrome `DevToolsActivePort`；没有端点且 `auto_start=true`（默认）时，CLI 自动寻找本机 Chrome，为受控 profile 分配一个动态非零 loopback 调试端口并记录端点。不得用 `--remote-debugging-port=0` 启动受控 Chrome，因为 Chromium 会因此暴露 `navigator.webdriver=true`，改变普通页面行为。整个握手只发生在本机，不依赖境外服务、CDN、插件商店或用户手工操作。
- `profile_mode=auto`（默认）在没有端点时由 GUI 请求当前 Chrome 窗口优雅退出，再用同一用户目录尝试启动 CDP；Chrome 版本或 profile 策略拒绝时自动切换受控 profile。`profile_mode=current` 只允许同目录接管，失败返回 `CHROME_CURRENT_PROFILE_UNAVAILABLE`；`profile_mode=managed` 明确不触碰普通 Chrome。受控 profile 默认位于 `%LOCALAPPDATA%\WindowsAgent\ChromeProfile`，也可通过 `user_data_dir` 指定。
- `chrome.navigate` 的 `timeout_ms` 是一次导航总预算；默认 `wait_until=domcontentloaded`，`interactive` 或已出现通用可操作内容即可继续，不把 `readyState=complete` 当作必要条件。调用方可传 `ready_selector`、`ready_expression`（可选 `ready_stable_ms`）等待真正可用的控件或结果；显式 `wait_until=load|complete|network_idle` 仍表示更强的技术等待要求。技术或语义等待超时均返回有界、稳定的错误码，并带 target、阶段、URL、标题、readyState、visibility、页面正文长度、可操作元素数量、页面状态、暂停原因、请求计数、主文档 `navigation_trace` 和耗时详情。等待中识别到登录/验证时以 `CHROME_USER_ATTENTION_REQUIRED` 提前停止；页面明确报告访问或操作被临时阻止时以 `CHROME_PAGE_BLOCKED` 提前停止；两者都不消耗完整 selector timeout。脚本异常返回 `CHROME_SCRIPT_EXCEPTION`。
- Chrome 页面状态会在导航、等待、脚本回读及等待失败诊断中报告：`usable`、`loading`、`login_required`、`risk_challenge` 或 `access_blocked`。只有真实密码控件、登录 iframe/dialog/大面积遮挡面才进入 `login_required`，页头登录链接不能单独触发暂停。登录、验证码和风控挑战是需要用户处理的可观察暂停状态；`access_blocked` 是站点明确拒绝当前访问/操作的可重试失败，不伪装为登录。CLI 不自动绕过或伪造用户通过。
- `chrome.ensure`、`chrome.attach` 以及后续页面动作先用 `Page.bringToFront` 选择准确 tab，再用 `Browser.getWindowForTarget` 返回的浏览器窗口 ID/边界结合进程、标题和前台状态核验并激活对应主 Chrome 窗口；结果返回 `window`/`window_binding`，只有 target 可见且窗口证据一致时 `verified=true`。Chrome 翻译提示、恢复气泡等独立顶层窗口不得靠进程枚举顺序冒充页面窗口。受管 Chrome 强制 renderer accessibility，并关闭后台渲染节流和崩溃恢复气泡，使 CDP 等待与 GUI fallback 在短时恢复用户原窗口后仍可继续。
- 所有前台窗口的 `screen.capture`/`screen.capture_window` 只有在窗口 PID、类名、边界、前台关系及屏幕采样点归属均通过核验后才使用屏幕拷贝，并在 `capture_layer` 标记 `screen_copy_foreground_verified`。截图期间活动提示层会短暂隐藏，证据不包含 DeskPilot 自身边框或动作轨迹。`PrintWindow/GDI` 的空白结果不会被当作页面空白；无法建立可信归属时返回 `WINDOW_CAPTURE_UNTRUSTED`、`WINDOW_CAPTURE_EMPTY`、`WINDOW_IDENTITY_MISMATCH` 或 `WINDOW_CAPTURE_FAILED`。后台窗口绝不拿屏幕上的其他应用冒充目标。
- `chrome.fill` 使用页面原型 setter 并派发 `input`/`change` 事件，随后严格回读值；框架页面未真正接受输入时返回 `CHROME_VALUE_NOT_VERIFIED`，不能把“键盘已发送”误判为业务成功。

## 安全边界

- CLI 不绕过 UAC、安全桌面、应用权限或 Windows 完整性级别。
- 宿主可以在写操作中要求确认；缺少明确确认时返回 `NEED_USER_CONFIRMATION`。
- UIA 标记为密码的控件不会通过 `ui.get` 回读值，`ui.set_value` 和聚焦后的 `input.type` 返回 `SENSITIVE_INPUT_BLOCKED`；登录、OTP 和验证码仍由用户手动完成。
- 提交、发送、删除、安装和系统设置等高影响语义由上层 Agent/宿主识别并授权，底层 GUI CLI 不凭控件名称猜测业务权限。
- CLI 不记录或持久化密钥、输入正文、客户数据或操作日志；截图由调用方明确决定是否保留。
- Unicode 文本输入只在操作期间临时持有调用方文本与原剪贴板对象，不写入文件或日志；正常完成后恢复原剪贴板。

## 当前不承诺

- 不承诺控制锁屏、安全桌面、管理员权限高于 CLI 的窗口或 Windows 服务会话。
- 不承诺第一版提供应用启动、进程管理、Vision、WGC、拖拽、任意图像理解、应用语义消息解析、安装器或自动更新；已交付的 Windows 离线 OCR 只提供定位文本候选。
- 不承诺内置脚本语言、通用断言库、测试 runner、测试报告、测试管理平台或 CI 集成；这些由上层宿主或外部开源工具负责。
- 不承诺所有 GPU、自绘、DirectX、OpenGL 或远程桌面内容都能被 GDI 截图或 UIA 识别。
- 不承诺独立 Windows Desktop、无人值守隔离或“用户完全看不到”的运行模式；当前实现仍在已登录用户的可见交互桌面操作，并只用非激活控制边框与稳定状态面板提示操作状态。
- 不承诺批处理原子性、撤销或业务成功；`timeout_ms` 是协作式步骤预算，超时和写操作失败都必须按结构化结果重新观察或人工判断。
- 不把本地 Development 冒烟验证等同于独立 SystemTest、正式发布或 Deployment。
