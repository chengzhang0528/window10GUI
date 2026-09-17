# Chrome 连接与恢复

适用于能启动本地进程并读写 stdin/stdout 的智能体宿主，包括 DSH。以下 JSON 每行是一条请求，发送到同一个 `win-agent.exe exec --stdin --format ndjson` 进程。示例中的 id 可替换为本次唯一请求 ID。

## 1. 建立会话

先使用宿主支持的持久进程工具启动 CLI，并保存它实际返回的会话／作业 ID。保持 stdin 打开。不要把固定几行请求通过管道发送后退出，随后仍试图复用原 window_id。

如果宿主会在前台工具返回时回收子进程，用宿主的持久／后台作业承载这个 CLI。后台作业存在不证明 Chrome 存活；跨工具调用后仍需重连核验。没有持久进程能力时，一个批次可以完成已知动作，但每次新进程必须重新取得所有会话内引用。

## 2. 选择一种连接方式

已获得真实 endpoint 时，通过 `endpoint` 字段原样传回，或使用其中实际端口：

```json
{"id":"connect","method":"chrome.ensure","params":{"port":9222,"auto_start":false}}
```

9222 只是示例值，必须换成实际返回或明确配置的端口。显式 endpoint 失败会返回错误，不会改连其他端口或启动另一浏览器。

没有 endpoint，且需要尝试已有调试浏览器时：

```json
{"id":"connect","method":"chrome.ensure","params":{"profile_mode":"auto","auto_start":true}}
```

需要独立受控 profile 时：

```json
{"id":"connect","method":"chrome.ensure","params":{"profile_mode":"managed","auto_start":true,"url":"about:blank"}}
```

`managed` 不扫描普通 9222 端口，只复用受控 profile 的端点记录，否则启动受控 Chrome。默认 `auto` 不重启现有 Chrome；`current` 也不会替用户关闭运行中的 Chrome。不要用杀死所有 Chrome、修改 profile 的退出标记、固定调试端口或自行添加浏览器绕过参数来恢复连接。

连接后保存返回的 endpoint。已有多个标签页时先 `chrome.targets`，根据 URL/title 选择，再 `chrome.attach` 指定真实 target_id。随后导航到用户要求的 URL；连接成功不代表已经在目标页面。需要 GUI fallback 时使用返回的绑定窗口，不能选进程列表的第一个窗口。

## 3. 登录分支

- `page_state=login_required`：停止尚未执行的业务步骤。核对当前页面和已有授权。
- 用户已明确授权当前演示租户／角色的快捷体验入口时，可点击该页面提供的快捷登录按钮，再核验租户、角色和登录后的 URL。登录状态下 Chrome 写动作可能返回 `CHROME_USER_ATTENTION_REQUIRED`；此时使用已绑定 window_id 重新 `observe`／`ui.find`，通过 UIA 操作这个已授权按钮，不用脚本填密码或绕过页面检查。授权其他站点不算；看到按钮本身也不算授权。
- 真实密码、OTP、验证码或风控挑战交给用户，保留目标窗口与宿主持久会话。用户完成后重新观察，再继续原目标。
- 普通已登录页面上的“登录”链接，不足以证明必须暂停。

## 4. 失败分支

`CHROME_CDP_UNAVAILABLE` 时读取 `error.details.attempts`：

| stage | 已知失败范围 | 下一步 |
|---|---|---|
| version | 获取或解析 `/json/version`，或缺少 WebSocket URL | 核对实际 endpoint、进程是否存活与工具是否刚结束 |
| targets | 获取 `/json/list` 或不存在可连接的 page | 检查是否已经有页面；不要把端口可达当作页面可操作 |
| websocket_or_initialization | WebSocket 连接或 CDP 域初始化 | 保留错误码，核对宿主限制与同一端点；不要归因为端口扫描遗漏 |

最多进行一次同参数、同端点的只读重连核验。仍失败时报告失败阶段和所需宿主能力，不循环 `ensure` 启动多个实例。`ensure` 失败而稍后 `evaluate` 成功，只能证明后一次请求成功；比较时间、完整参数、会话与 endpoint 后再归因。`evaluate` 也会执行连接准备，不是绕过连接层的独立证据。

`exit_type=Crashed`、PID/端口变化、窗口消失均是现象，不能单独证明谁终止了浏览器。应区分 CLI 正常关闭、CLI 超时、宿主作业回收与沙箱拒绝。文件访问权限并不证明命名管道或进程沙箱限制已经解除。

## 5. 结束与汇报

任务结束用 `interaction.end` 释放 lease，然后用 `close` 或 EOF 结束 CLI。等待用户登录期间保留会话。不要把 `job_kill` 当作正常“关闭浏览器”接口：作业终止的影响由宿主决定。

只报告三项：已验证页面／业务结果；当前暂停或失败原因；下一步需要的动作。把未经验证的原因标为待核查，不声称独占接管了桌面，不因一次成功承诺跨调用永久存活。
