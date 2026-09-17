# Windows Agent CLI 当前设计

Status: Active
Kind: CurrentDesign
Scope: windows-agent-cli / 桌面底座与结构化流程宿主实现
Owner: 项目维护者
Updated: 2026-09-09
Depends On:
- PRODUCT_CONTRACT.md
- ../../../src/WindowsAgent.Cli/AGENTS.md

## 设计结论

设计与后续优化以 [产品契约的核心定位](PRODUCT_CONTRACT.md#核心定位与默认目标) 为准。默认 Agent 方法是观察当前页面，通过已有 `workflow.run`/`actions.batch` 或持久 NDJSON 宿主调用连续完成已知动作与检查，然后按新结果决定下一组动作；不要求预写完整场景。分组和恢复决策由调用方 Agent 的 Skill 指导，不是 CLI 自动规划或运行时强制批处理。[结构化流程宿主](../../../src/DeskPilot.Flow/README.md) 是匹配目标时可复用的执行入口，解释纯 JSON 及声明式判据，执行事实复核、逐步事件与主动 handoff，正常流程内部不调用模型；其数据格式与校验保持不变。

独立 worker 先解析和验证场景数据，再交通用执行器；不导入场景 .mjs、handler 或表达式。supervisor 在 worker 退出/超时时主动返回异常，无法确认旧执行树结束时保持 quiescent=false。Flow 宿主仅支持 Agent 判断后新 run，不支持跨进程断点续跑或自动重放未知副作用。确认执行者退出后，Agent 可重新观察并直接用 CLI 短批次完成剩余操作，无需先建立恢复文件；这不等于恢复旧 worker 的步骤状态。[设计](DECISION_STRUCTURED_FLOW.md) 中宿主字段不是 CLI 参数。
正常流程的业务预期可由宿主脚本或外部测试 runner 检查，不需要模型每一步介入。下面的已有实现记录不构成上述目标缺口已经补齐的证明。

| 结果 / 决策 | 当前支持 | 用户入口 | 所有者 | 持久化影响 | 证据 |
|---|---|---|---|---|---|
| CLI 风格标准输入输出接入且不启用 MCP Server | `win-agent.exe` 参数调用与 `exec --stdin --format ndjson` | stdin/stdout JSON/NDJSON | `Program.cs` | 仅 helper 进程内存状态 | 当前可执行文件实测；外部 CLI 仅为形态参考 |
| 操作已有 Windows 10 桌面窗口 | UIA、User32、SendInput、GDI | `windows.*`、`ui.*`、`input.*`、`screen.*` | `AutomationEngine.cs`、`NativeMethods.cs` | 无业务持久化 | Windows 10 build 19045 与 Chrome 实测 |
| CDP 与 GUI 同为一级 Provider | 内置 CDP HTTP/WebSocket、Runtime、DOM 脚本 + UIA/User32/SendInput/GDI | `chrome.*`、`windows.*`、`ui.*`、`input.*`、`workflow.run` | `ChromeCdp.cs`、`AutomationEngine.cs`、`NativeMethods.cs` | 受控 Chrome profile 可复用；GUI session 仅内存 | 本机本地 fixture 端到端实测 |
| Chrome target 与桌面窗口准确绑定 | page target 可列举并用 `chrome.attach` 精确切换；页面动作先 `Page.bringToFront`，再用 `Browser.getWindowForTarget` 的窗口 ID/边界结合进程、标题、前台与 target 可见性核验主窗口并返回 `window_binding` | `chrome.targets`、`chrome.attach` 及所有页面动作的 `target_id`、`window.window_id` | `ChromeCdp.cs`、`AutomationEngine.cs` | 仅 helper session 内存 | 多标签脚本新开空白页后仍重新带回原 target，`verified=true`、target 可见且边界距离为 0；GUI fixture 从绑定窗口找到网页输入框 |
| 防止旧界面引用误操作并稳定等待动态 UI | session、observation、element、screenshot 四类短期标识；`wait.element` 在同一超时预算内重试导航期 UIA 树重建等可重试查询错误，命中后才发布新引用，超时报告瞬态错误诊断；目标拥有的前台 popup 不触发父窗口再激活 | 每个结果的公开 ID、`wait.element` | `AutomationEngine.cs`、`NativeMethods.cs` | 进程退出即清理 | 坐标旧观察拒绝；GitHub 新文件导航期间 `ELEMENT_NOT_AVAILABLE` 复现并修复；微信搜索 owned popup 可截图并在不关闭弹层时点击 |
| 动作后由宿主脚本或 Agent 验证业务结果 | 动作响应报告执行层；读取/等待命令提供断言面和轻量诊断；`ui.get` 回读 UIA Toggle 状态，`ui.invoke` 优先用 TogglePattern 并报告前后状态 | `verify`、`ui.get/find`、`ui.invoke`、`wait.*` | CLI 与上层宿主共同负责 | 无 | Chrome 输入、选择、查询与复选框状态回读实测 |
| 让用户知道 Agent 正在操作并能看见稳定状态 | 每显示器一个原生 layered、`NOACTIVATE`、鼠标穿透的静态彩色控制边框；每次操作立即更新状态标签并重置 2 秒滑动熄灭计时；紧邻 lease 复用同一窗口；可选合成指针和脉冲目标高亮；稳定状态面板保留到下一状态或 `close` | `interaction.*`、`actions.batch` 或单步自动 lease；逐步 `action_label`；`show_action_trace=true`；`interaction.status` | `DesktopActivityOverlay.cs`、`DesktopActivityCoordinator.cs`、`AutomationEngine.cs` | 仅 helper 内存状态 | 面板存在不代表仍在控制；`overlay_visible` 只表示边框仍在可见期；合成指针不抢焦点；坐标 fallback 后尽力恢复真实鼠标位置 |
| 让用户可随时停止托管 | helper 并发接收控制请求；`interaction.cancel` 不等待生命周期锁，向当前动作/Chrome 等待发送取消信号；在动作/等待边界收口 lease，面板保留“已取消”状态 | `interaction.cancel`、`status=cancelled`、`ACTIVITY_CANCELLED` | `Program.cs`、`AutomationEngine.cs`、`ChromeCdp.cs` | 仅 helper 内存状态 | 取消确认、控制边框隐藏、状态面板留存和前台恢复可观察 |
| 缩短连续表单动作并统一收口 | 最多 32 步有序、非原子、默认 fail-fast；批次结束让控制边框按最后操作的 2 秒截止时间熄灭并尽力恢复原前台窗口，稳定状态面板保留“等待下一步/需用户处理/失败”等状态 | `actions.batch` | `AutomationEngine.cs` | 仅 helper 内存状态 | Chrome 本地表单批处理实测 |
| 通用桌面消息采集 | 可信窗口截图经 Windows 离线 OCR 转换为定位文本候选；调用方提供身份区、内容区和预期会话身份，身份不符时停止 | `messages.observe` | `AutomationEngine.cs`、`OfflineTextRecognition.cs`、`NativeMethods.cs` | 临时截图随 session 清理，不保存消息 | 微信 Qt 窗口完成身份断言、可见消息采集与回复回读；同一原语在 ChatGPT 窗口完成跨应用身份验证 |
| 通用底座与场景解耦 | CLI 只提供桌面/页面执行原语；业务流程由 Agent 宿主脚本组合 | `workflow.run`、`actions.batch`、公开命令协议 | `AutomationEngine.cs`、`ChromeCdp.cs`、`Program.cs` | 场景状态不进入 CLI | 闲鱼与本地表单均复用同一 GUI/CDP 能力 |
| 纯数据流程与通用执行器分离 | DeskPilot.Flow 读取动作、定位及完整比较判据，执行 requires/consumes/expect/final_checks；Skill 指导 Agent 调整数据 | `node src/DeskPilot.Flow/run.mjs`，详见宿主 README | `src/DeskPilot.Flow/` 与场景 JSON | 无数据库；持久化纯数据定义，执行状态默认内存 | 数据解析/谓词及宿主定向测试；Luna 通过 DeskPilot 验证只读场景、56 步父子对象闭环两次及保存前失效接管；测试数据已清理 |

## 底座与场景的责任分层

```text
场景脚本 / Agent 宿主
  ├─ 业务意图、选择器、断言、数据、报告、授权停止点
  └─ 调用公开的 workflow.run / actions.batch / 单步命令
                         │
                         ▼
Windows Agent CLI 底座
  ├─ Session / lease / timeout / cancellation / structured errors
  ├─ GUI provider：UIA、SendInput、Win32、可信截图、Windows 离线 OCR
  ├─ CDP provider：Chrome 页面导航、等待、脚本、DOM 操作
  └─ 观察凭据、引用生命周期、前台恢复、操作提示
                         │
                         ▼
Windows 10 交互式桌面与应用
```

底座的扩展点是 provider、通用动作、等待/读取和组合协议；场景 adapter 不进入核心执行器。判断一个需求是否进入底座时，先问它能否跨两个以上应用复用，且是否能通过公开原语表达；不能满足时留在上层脚本。

## 脚本编排与测试 runner 的责任边界

CLI 的 `workflow.run`/`actions.batch` 是稳定的动作协议，不是新的脚本语言。宿主可以直接生成 JSON/NDJSON，也可以使用现有语言或成熟开源 DSL（例如 JavaScript、PowerShell、Python 或既有测试框架）编写脚本，再由适配器把动作发送给 CLI。核心项目不维护一套与生态脱节的 DSL。

| 层 | 负责 | 依赖 CLI 的最小契约 | 不负责 |
|---|---|---|---|
| Windows Agent CLI | 窗口/页面动作、等待、观察、引用生命周期、超时、取消、结构化错误、截图和前台恢复 | `win-agent.exe exec --stdin --format ndjson`；`request_id` 配对；读取 `error.code`/`retryable`；按结果重新观察 | 业务意图、业务断言、用例发现、fixture、报告、CI |
| 脚本/DSL 适配器 | 将宿主语言或开源 DSL 编译/解释为 CLI 请求，组织变量和控制流 | 只使用公开命令和结果字段，不访问 HWND/UIA 对象 | 新增底层执行语义、替代 CLI 生命周期 |
| 场景 adapter | 页面选择器、业务流程、业务数据和业务成功谓词 | 调用 CLI 的通用动作与验证面 | 通用窗口/输入实现、测试平台能力 |
| 测试 runner | 用例发现、fixture/环境准备、断言组合、重试决策、并发、报告和 CI 退出码 | 把 CLI 当作外部执行器；写操作出现 `BATCH_OUTCOME_UNKNOWN` 时禁止盲目整批重试；用 `ui.get`/`chrome.query`/`wait.*` 等结果完成断言 | 重新实现 GUI/CDP 驱动、猜测业务成功 |

因此“可用于自动化测试”表示 CLI 可作为测试 runner 的执行器和证据来源，不表示 CLI 自带测试框架。测试 runner 需要的依赖是：可启动的 CLI 可执行文件、标准输入输出、稳定错误码和超时、可选的绝对截图路径，以及场景层提供的选择器、断言和测试数据。
## 后续工作的组织方式

后续工作按 [产品契约的两个独立方向](PRODUCT_CONTRACT.md#两个独立工作方向) 组织，不再用一条混合的能力增强顺序绑定场景打磨与底座重构。专项场景工作沉淀可复用流程与异常诊断方法；纯代码优化围绕执行契约和已有模块职责展开，保留必要定向验证。通用缺口以证据衔接，具体网站规则留在上层。

这些方向不是已启动的活动任务。新的 provider 仍按真实缺口评估；专用且无用户同时操作的交互式桌面不要求建设锁屏、服务会话或无人值守隔离平台。
## 架构

```text
Agent host
        │ argv 或 NDJSON stdin/stdout
        ▼
win-agent 前台 CLI
        │ 隐藏子进程、request id、超时、父进程退出联动
        ▼
stateful Windows helper
        ├─ Session / Window / Observation / Element / Screenshot cache
        ├─ UI Automation：查询、读取、Pattern 动作
        ├─ User32 + SendInput：窗口、焦点、键鼠 fallback
        ├─ Trusted screen copy / PrintWindow / GDI：核验前台关系与屏幕像素归属后取证
        ├─ Windows.Media.Ocr：离线识别带位置的桌面文本候选
        ├─ ChromeCdpProvider：本机 CDP 发现、自动启动、页面就绪、脚本和 DOM 动作
        ├─ DesktopActivityCoordinator：捕获原前台窗口、lease 深度、用户注意力窗口和恢复结果
        └─ DesktopActivityOverlay：独立 STA 消息线程上的多显示器非激活控制边框与稳定状态标签
                    │
                    ▼
       已登录用户的 Windows 10 桌面
```

CLI 前台进程只负责参数、NDJSON 转发和统一响应；所有 Windows 对象和短期引用由隐藏 helper 持有。这样单次命令保持简单，连续 GUI 动作又能共享同一个 session，而不需要常驻 MCP Server。
## 来自本机 ChatGPT Computer Use 的启发

本机安装的 OpenAI Codex/ChatGPT Windows 包采用 Electron/Chromium 外壳，并包含独立的 Windows computer-use helper。对其已安装资源的只读检查确认了这些封装思想：

- Windows 能力在独立 helper 进程中运行，父进程用隐藏 stdio 管道发送逐行 JSON。
- 请求使用 ID 关联结果，并有超时、helper 退出、父 PID 联动和进程清理。
- client 复用同一 transport 保存窗口和观察状态；动作前校验窗口/截图状态，动作后重新观察。
- 高影响应用访问可以产生 approval 请求，而不是由底层自动越权。

本项目只借鉴这些可验证的边界和协议思想，没有依赖、复制或调用安装包内的私有 helper。公开协议和实现由本仓库独立维护。

## 进程与协议

`Program.cs` 提供三种运行形态：

- `win-agent <domain> <command> ...`：一次请求；内部启动 helper 并在响应后关闭。
- `win-agent exec --stdin --format ndjson`：面向 Agent 宿主的持久会话；每行一个请求和响应。
- `win-agent --host --parent-pid <pid>`：内部 helper 入口，不作为 Agent 公共调用面。

helper 默认隐藏窗口、UTF-8 无 BOM、请求最大深度 64、超时 130 秒，并在父进程退出或 EOF 时结束。请求和响应都由 `request_id` 关联；异常映射成结构化错误。

连续桌面操作有两种等价入口：

- `actions.batch` 在一个请求中执行最多 32 个步骤。步骤可调用 GUI、等待和 `chrome.*` 能力，支持严格的向前结果引用（`step.result.field`、数组索引），不支持嵌套 batch、close 或回滚。
- `workflow.run` 接受相同的 `steps`/`actions` 数组，是脚本宿主的语义别名；一个请求可完成 Chrome 导航、等待、页面 JavaScript、控件填值/点击，以及需要时的 UIA/SendInput 动作。
- 持久 `exec --stdin` 会话可以先 `interaction.begin`，再发送多个普通请求，最后用返回的 `interaction_id` 调 `interaction.end`/`interaction.cancel`。begin/end 之间只创建一个提示框和一次前台恢复；`interaction.cancel` 可在长命令运行时并发发送，收到确认后在下一个动作或等待边界停止；EOF、close、父进程退出也走同一清理路径。

lease 是焦点恢复边界，不是安全锁；控制边框和稳定状态面板都是 session-scoped 提示状态。提示窗口使用 `WS_EX_NOACTIVATE`、`WS_EX_TRANSPARENT`、`HTTRANSPARENT`，不会主动获得焦点。每个操作开始时用步骤 `action_label` 原位更新面板并显示静态边框，同时把边框截止时间滑动到 2 秒后；正常 lease 结束只把面板切换为等待状态，不取消仍有效的截止时间，因此紧邻请求不会发生隐藏/重建。截止时间到达只清除边框和轨迹，不销毁面板；暂停、取消、失败立即清除。可选动作轨迹在约 300 ms 后才显示并在动作结束时清除，避免快速读取造成闪烁；只有会话 `close` 才销毁面板。截图时协调器会短暂隐藏提示层，保证证据不包含 DeskPilot 自身 UI。创建失败默认作为 best-effort 状态返回，`overlay_required=true` 才阻止继续执行。

## 状态模型

```text
session
  ├─ activity lease ── interaction_id / original foreground / control overlay state
  ├─ stable status panel ── running / idle / paused / cancelled / failed (session-scoped)
  └─ window_id  ── 当前 HWND 的会话内映射
       └─ observation_id ── 观察时窗口 bounds
            ├─ element_id ── UIA 元素短引用
            └─ screenshot_id ── 截图时窗口 bounds
```

- 窗口激活、动作或新观察会使旧 UIA 引用失效。
- `window_id` 绑定首次发现时的 HWND、PID 和窗口类名；句柄被关闭或回收后不会静默指向替代窗口，必须重新 `windows.find`。
- 坐标操作检查引用属于同一窗口、仍是该窗口最新观察，并且窗口 bounds 未变化。
- 当前前台是标准 owned popup 时直接按目标前台处理。同进程、无 owner 的 Qt 顶层窗口只有类名明确包含 popup/menu/tooltip，或同时满足 `WS_POPUP`、面积不超过目标 75%、且至少一半面积与目标重叠时，才作为瞬态弹层绑定并报告 `foreground_relation`；普通的第二个同进程窗口不会因重叠而冒充目标。
- `messages.observe` 在同一可信截图上分开处理身份与正文：先以原始比例识别完整窗口布局并按身份区过滤标题，避免裁剪破坏 OCR 上下文；再裁剪内容区并以 Cubic 插值和受 Windows OCR 最大图像尺寸约束的 3× 自适应比例改善小号正文，最后把坐标映射回原窗口；`expected_identity` 不匹配时返回 `CONTEXT_IDENTITY_MISMATCH`。CLI 不把几何文本块升级为已归并的用户、会话或业务消息。
- 观察树限制 `depth` 和 `max_nodes`；缓存也有数量上限，避免长会话无界增长。
- 每个 activity lease 在开始时捕获原前台窗口；正常结束顺序是清除可选动作轨迹 → 将稳定状态面板切换为“等待下一步”并保留尚未到期的控制边框 → 校验原 HWND 的 PID/类名 → 尽力恢复前台。边框在最后一次操作后 2 秒自行熄灭；下一操作先到则重置同一计时。若 Chrome 返回登录/风控暂停，面板切换为“等待用户处理”并立即清除边框，同时校验、保留匹配 Chrome 窗口前台，不恢复用户原窗口；取消和失败也立即清除边框，且取消不承诺撤销已发出的输入；失败只报告结构化清理错误，不绕过 Windows 前台策略。
- 批次步骤按输入顺序执行，默认第一处错误停止；`on_error=continue` 仅允许继续独立的非变更读取，遇到变更步骤会停止。任何变更成功或失败都会使旧观察引用不可复用。
- 自动生成的临时截图由 session 管理，在关闭或达到截图缓存上限时删除；单次命令会在响应后关闭 session，需跨命令读取时必须传入显式绝对 `path`，该文件归调用方所有并在会话结束后保留。
- 普通单步 activity lease 对会返回观察、元素或截图引用的读取方法默认保留目标窗口激活，以便下一请求消费引用；其余动作默认在结束处恢复开始前的前台窗口。lease 结束不立即销毁或隐藏提示窗口：控制边框沿用最后操作的 2 秒滑动截止时间，稳定状态面板继续可见，直到下一请求或会话关闭。检测到 Chrome 登录/风控暂停时，无论单步、batch 还是显式 interaction，均立即清除边框、保留用户注意力窗口并把面板置为暂停状态，返回暂停诊断。要统一收口应使用 interaction/batch，单步读取可显式传 `restore_original_window=true`。

## 执行层

| 动作 | 首选 | fallback | 返回的执行层 |
|---|---|---|---|
| 按钮/链接调用 | UIA `InvokePattern` | 元素中心点点击 | `uia_pattern` / `coordinate` |
| 输入框设值 | UIA `ValuePattern` | 聚焦、全选；纯 ASCII 用 `SendInput`，非 ASCII 临时粘贴并恢复原剪贴板 | `uia_pattern` / `uia_input` / `uia_clipboard_paste` / `clipboard_paste` |
| 下拉选择 | UIA Value/Selection Pattern | 聚焦、文本选择、Enter，并短轮询回读 | `uia_pattern` / `uia_input` |
| 窗口激活 | User32 恢复并置前台 | 无静默降级 | `win32` |
| 坐标/键盘/滚轮 | `SendInput` | 无 | `coordinate` / `send_input` |
| 截图 | 核验 PID、类名、边界、前台关系和屏幕采样归属后使用 `CopyFromScreen`；后台先尝试 `PrintWindow(PW_RENDERFULLCONTENT)` | 提示层在取证帧短暂隐藏；空白 `PrintWindow` 不解释为业务空白；无法证明窗口归属时明确失败 | `screen_copy_foreground_verified` / `screen_copy_after_blank_printwindow_verified` / `WINDOW_CAPTURE_UNTRUSTED` / `WINDOW_CAPTURE_EMPTY` |
| 桌面文本/消息候选 | `Windows.Media.Ocr` 离线识别可信窗口截图 | 按身份区/内容区过滤并返回 bounds、side、几何 `role_hint`；业务分组、去重、跨页滚动和回复策略在上层 | `windows_media_ocr_offline` / `CONTEXT_IDENTITY_MISMATCH` |
| Chrome 导航与就绪 | CDP `Page.bringToFront`/`Page.navigate` + `document.readyState` + 可操作内容探测 + 可选 CSS/脚本语义条件 + Network 请求计数和主文档导航链 | 默认 `DOMContentLoaded` 或已出现通用可操作内容；可在同一预算内等待业务控件/结果；登录/验证提前暂停，访问阻止返回 `CHROME_PAGE_BLOCKED`，超时返回 target、visibility、正文/控件数量、导航 initiator 和预算详情 | `cdp_page` |
| Chrome 控件填值 | CDP `Runtime.evaluate` 原型 setter + `input/change` 事件 + 回读 | 无 | `cdp_dom` |
| Chrome 控件选择 | CDP `<select>` value/label 匹配 + `input/change` 事件 + 回读 | UIA/SendInput 可作为同一 workflow 步骤 | `cdp_dom` / `uia_input` |
| Chrome 控件点击 | CDP DOM 查询、滚动到视口、可见/禁用校验、`Input.dispatchMouseEvent` 可信点击 | UIA/坐标动作可作为同一 workflow 步骤 | `cdp_input` / `uia_input` |

所有坐标是 Per-Monitor-V2 DPI aware 的物理像素；窗口相对坐标在输入前转换为虚拟屏幕坐标。

## 对外能力

`capabilities` 当前公开：

- 窗口与观察：`windows.list/find/activate/info`、`observe`、`screen.capture/capture_window`、`messages.observe`。
- UI 与输入：`ui.tree/find/find_all/get/invoke/click/set_value/select`、`input.click/double_click/right_click/type/key/hotkey/scroll`、`wait.window/element`。
- Chrome 与组合：`chrome.ensure/targets/attach/navigate/wait/evaluate/fill/select/click/query`、`workflow.run`、`actions.batch`、`interaction.begin/end/cancel/status`。
- 诊断：`doctor`、`schema`。

窗口选择器支持 `process`、`title_contains`、`title_exact`、`class_name`；元素选择器支持 `name`、`name_contains`、`automation_id`、`class_name`、`control_type`、`enabled`、`visible`。多结果默认返回歧义错误，只有调用方显式提供 ID、索引或 `first=true` 才继续。

## 可观察完成规则

第一版实现完成必须同时满足：

1. 当前 Windows 10 交互式桌面上的 `doctor` 报告 UIA、SendInput、可信截图和 Windows 离线 OCR 后端可用。
2. 工程构建为 0 警告、0 错误。
3. 同一持久 CLI 会话能通过 `workflow.run` 自动连接或启动 Chrome，在确定性本地页面等待就绪、填入文本、执行脚本选择下拉项、点击查询按钮，并用 CDP 回读一致结果。
4. 显式路径截图在 CLI 退出后仍可读取，且画面与结构化回读一致。
5. 正式文档检查通过。
6. 显式 activity 的每个操作会立即把准确 `action_label` 写入状态面板并令 `overlay_visible=true`；2 秒内的新操作会重置截止时间，正常结束响应允许边框处于余留可见期，最后操作 2 秒后 `interaction.status` 必须为 `overlay_visible=false` 且 `status_panel_visible=true`（除非调用方关闭提示），并报告 `restored_original_window`；暂停、取消和失败立即清除边框，静态边框不持续重绘，动作轨迹短操作不闪烁且不进入截图证据。
7. 一个不内置应用业务规则的 batch 能在 Qt 聊天窗口完成会话身份断言、可见消息候选采集、文本回复和发送后回读；同一 `messages.observe` 在第二个非聊天应用窗口也能完成身份断言。

本次最新实测环境是 Windows 10 build 19045、x64、Chrome 151.0.7922.173。除既有 Chrome 表单结果外，DeskPilot 在微信 Qt 窗口中识别到目标群聊身份并采集当前可见定位文本，发送测试回复后从排除输入区的消息区域回读到右侧候选；同一离线 OCR 原语在 ChatGPT 窗口用不同身份条件验证通过。场景选择器、消息统计和回复策略均未进入 CLI 核心。

## 当前限制与停止边界

- 工程目标是 `net10.0-windows10.0.19041.0`；自包含 Windows x64 便携包由源码根的 `build-portable.mjs` 生成，包含 CLI、相对路径 Skill、运行文档与可选 Flow 宿主。首次构建需要网络或已缓存的 .NET runtime pack，使用核心 CLI 无需目标机另装 .NET。
- Chrome 最小化时通常不暴露网页 UIA 子树，必须先恢复并置前台；部分自绘网页仍需键盘/坐标 fallback。
- `profile_mode=auto` 发现已有 CDP 后复用，否则启动独立受控 profile；不会关闭普通 Chrome。`current` 仅在没有运行中 Chrome 时尝试当前用户目录启动。精确 endpoint/port 失败不启动其他实例，`TryAttach` 保留有界的分阶段失败详情。
- `HostClient.Dispose` 收到 close 响应后等待最多 3 秒退出，避免将响应已完成误判为进程已退出；必要时仅终止 helper。Chrome 正常情况下保留供后续连接。DSH 等外部宿主的作业回收由宿主负责，使用方法见浏览器 Skill 的连接与恢复说明，不能把正常 CLI 退出验证外推为任意沙箱下的跨调用存活保证。
- CDP 页面动作适合 DOM 可访问的页面；跨域 iframe、浏览器内部页和需要真实用户手势的特殊控件可能仍需 UIA/SendInput 步骤。所有页面等待都受 `timeout_ms` 约束，失败必须按错误码重新观察。
- `PrintWindow/GDI` 不是 GPU、自绘、遮挡或 popup 场景的完整截图方案；前台可信屏幕拷贝要求目标关系和采样归属全部通过，后台不满足时会明确失败。WGC 与 Vision 属于后续独立能力。当前也不提供应用启动、拖拽、通用图像理解、应用语义消息解析、原生应用 adapter、安装器、签名、更新或日志审计流水。
- Windows 离线 OCR 会产生字符误识别，`role_hint` 只是左右几何提示，不是已确认的发送者身份。完整历史采集需要上层脚本用滚动、身份复核和去重循环完成；CLI 不承诺一次 `messages.observe` 覆盖不可见历史。
- activity overlay 与稳定状态面板都是用户提示而非隔离桌面；控制边框表示最近 2 秒内有操作而不等同于 lease，面板在连续请求之间保留最近状态，取证时会短暂隐藏提示层，系统重启、显示器变化和前台权限失败仍按 best-effort 清理并在结果中报告。`actions.batch` 不是事务；`BATCH_OUTCOME_UNKNOWN` 表示变更可能已经发生，禁止宿主自动整批重试，必须重新观察并由上层决定恢复动作。需要控制安全桌面、高完整性窗口或无人值守服务会话时停止；不得把普通用户交互式桌面的成功外推到这些环境。
