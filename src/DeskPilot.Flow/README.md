# DeskPilot 结构化流程宿主

此目录通过 DeskPilot 公开 NDJSON 执行结构化 Web UI 流程。正常步骤由脚本检查；当前检查失败或前序结果失效时，返回 `run.handoff` 并停止后续步骤。它是普通 Node 宿主适配器，业务检查没有进入 Windows CLI。

## 先完成当前目标

首次操作由 Agent 观察页面，把已明确的动作、等待和结果检查放入一次 DeskPilot 批处理，根据返回的新状态继续。直接执行入口见 [CLI 操作说明](../WindowsAgent.Cli/README.md)。无需先编写本目录的 JSON。只有已有场景的目标、数据与副作用都匹配，或需要保存已验证的重复操作时，才使用下面的场景重放入口。

`xrain.json` 是特定页面基线的验证用例；`xrain-picklist-loop.json` 是会创建、修改并删除专用父子数据的固定闭环用例。它们不代表一般浏览、创建或配置请求。选项集用例中的部分按钮定位仍含固定名称，不能只修改 inputs 就声称适用于任意数据。

## Development：准备与执行

前置条件：已登录且未锁屏的 Windows 10 交互式桌面、本机已验证的 Node.js 24.19.0、Chrome，以及按 [CLI 构建说明](../WindowsAgent.Cli/README.md) 构建的 win-agent.exe。实际网页操作只使用 DeskPilot。快捷管理员登录仅在用户授权的演示站使用。

在仓库根目录运行：

```powershell
node --test src/DeskPilot.Flow/*.test.mjs
```

成功标志为测试失败数 0；这些是宿主定向测试，不会操作浏览器。场景入口是经过完整校验的纯 JSON 数据文件；编译器只从有限的 action、target 和 predicate 词汇生成通用检查函数：

```powershell
node src/DeskPilot.Flow/run.mjs --scenario src/DeskPilot.Flow/scenarios/xrain.json --case simple
```

默认只输出一条终态 JSON，成功退出码 0，接管退出码 2，取消退出码 130。`--events` 额外输出步骤进度；`--executable` 可指定已构建 CLI 的绝对路径。选择其他 case 前读取 [场景数据](scenarios/xrain.json)，确认操作和预期仍符合当前授权。

XRain 场景要求受管 Chrome 已登录演示租户。若脚本返回 USER_ATTENTION_REQUIRED，Agent 可在用户已明确授权时通过 DeskPilot 点击演示站的租户管理员快捷入口，再重新运行；真实密码、验证码仍交用户。流程始终在 ensure 后显式 navigate，连接已有 Chrome 不代表已经到达输入网址。

| case | 操作与预期 |
|---|---|
| simple | 总览与租户身份检查，2 步 |
| medium | 当前对象的空记录表搜索与清空，4 步；验证“没有符合条件的记录”与“暂无记录”的状态切换，不代表已验证非空数据筛选算法 |
| complex | 对象设计 → 唯一 Email message 对象 → 字段页，4 步；验证 API 名、选中标签、Accepted at 与当前 22 字段基线 |
| probe | 故意将未提交搜索词从 Email 改为 Feishu；预期在 dependent_read 前返回 PRIOR_RESULT_INVALIDATED，后续动作不派发 |

probe 是机制负向检查，退出码 2 是预期结果；读完异常确认 quiescent=true 后，可运行 medium 恢复正常搜索状态。页面数据/字段基线变化应报告并核查，不修改网站数据来迎合旧预期。检查反馈只返回比较结果、数量和长度，不返回页面正文、输入值或完整表格内容。

## 父子对象的 56 步闭环

[选项集闭环数据](scenarios/xrain-picklist-loop.json) 在同一演示租户创建专用选项集与子选项值，完成修改、回读和清理。父编码为 `deskpilot_loop_20260907_a1__c`，子编码为 `deskpilot_loop_value_20260907_a1`；创建前核对编码与名称不存在，删除前核对本次对象。运行前读取 inputs 和对应目标定位，名称变化时同步其行操作定位。

```powershell
node src/DeskPilot.Flow/run.mjs --scenario src/DeskPilot.Flow/scenarios/xrain-picklist-loop.json --case closed_loop
```

| 步骤 | 操作与判据 |
|---|---|
| 1–8 | 创建父选项集，填写编码、名称、说明，设为停用并保存 |
| 9–19 | 离开后回读；修改名称、说明并启用；再次离开并回读全部字段 |
| 20–27 | 确认父对象身份，创建子选项值，填写编码、名称、说明及颜色并保存 |
| 28–43 | 重新加载回读子值；修改名称、说明、颜色并停用；再次回读确认 |
| 44–50 | 删除专用子值，重新加载确认已删除，再返回父列表 |
| 51–56 | 请求并取消父删除，确认记录仍在；再次确认删除，重新加载确认清理完成 |

成功结果须为 completed、56 步 succeeded、quiescent=true，且最后的重新加载证明本次父子测试数据已清理。选项集有子值时服务会拒绝删除，流程按先子后父执行。取消后的弹层可能仍在 DOM，场景将确认弹层限定为未带 ant-popover-hidden 的节点，关闭判据检查实际可见弹层。

同一文件的 `--case probe` 在首次保存前改变未提交编码，预期在 save_created 复核 fill_code 的事实时交接，保存动作不得派发。确认异常包证明未保存且 quiescent=true 后，Agent 可发起 closed_loop；它先重新导航清除草稿并检查初始不存在。中途已写入的异常须先确认旧执行者退出并回读精确记录身份和效果，再通过直接 DeskPilot 批次完成剩余操作；需要复用时可写局部恢复 JSON，不能盲目重跑创建前缀。

正常执行只需一次宿主调用；Agent 按需读取步骤摘要或异常关联的检查定义，避免每次把整个流程与页面内容重新送入上下文。

## 结构化流程与检查

JSON 场景顶层字段是 `schema_version=1`、`scenario_id`、`inputs`、`targets` 与 `flows`；每个 flow 包含 `flow_id`、正整数 `revision`、`timeout_ms`、`checks`、`steps` 与非空 `final_checks`。worker 会在创建 transport 前解析并校验整个场景的所有 flow；未知字段、缺少检查、前向依赖和已释放依赖均在 0 动作时拒绝。以下是已登录演示站的总览流程写法：

```json
{
  "schema_version": 1,
  "scenario_id": "xrain-overview-example",
  "inputs": { "url": "https://lower-code.atlas-xrain.com/overview" },
  "targets": {},
  "flows": {
    "simple": {
      "flow_id": "xrain-overview", "revision": 3, "timeout_ms": 180000,
      "checks": {
        "authenticated": {
          "predicate": { "type": "page", "text": { "contains": ["demo-admin", "XRain Demo"], "not_contains": "欢迎回来" } },
          "timeout_ms": 15000, "poll_ms": 200, "stable_ms": 200
        },
        "overviewReady": {
          "predicate": { "type": "page", "url": { "equals": { "input": "url" } }, "text": { "contains": ["租户总览", "成员概况", "业务对象"] } },
          "timeout_ms": 15000, "poll_ms": 200, "stable_ms": 200
        }
      },
      "steps": [{
        "id": "ensure", "label": "连接已登录工作区", "timeout_ms": 45000,
        "action": { "type": "ensure", "auto_start": true, "profile_mode": "managed", "url": { "input": "url" } },
        "expect": ["authenticated"]
      }, {
        "id": "open", "label": "打开租户总览", "timeout_ms": 30000,
        "requires": ["authenticated"],
        "action": { "type": "navigate", "url": { "input": "url" }, "wait_until": "load" },
        "expect": ["overviewReady"]
      }],
      "final_checks": ["open.overviewReady"]
    }
  }
}
```

| 字段 | 当前实现 |
|---|---|
| action | `ensure`、`attach`、`navigate`、`fill`、`select`、`click`、`query`、`wait` 八种有限动作；编译为公开 `chrome.*` 方法；参数中的 `{ "input": "name" }` 由宿主解析，不是 CLI 参数语法 |
| target | 命名 CSS 定位；可增加 `text: {"contains": "infra_email_message"}` 文本限定，值也可引用输入。文本限定支持 click 与 element 检查，其他动作引用时在预校验拒绝 |
| requires / expect | 命名检查 ID 列表；前置先检查，后置全部通过才成功 |
| consumes | `步骤ID.检查ID`，使用前重新检查原条件；旧成功标记不足以继续 |
| releases | 当前步骤成功后释放已不适用的旧条件，例如导航后旧表单 |
| min_delay_ms | 动作返回后的最小延迟，仍需后置检查，默认 0 |
| timeout_ms | 整步总预算，包括前置、动作、延迟与后置；受流程总预算约束 |
| final_checks | 最后重新检查指定活跃事实，全部通过才 completed |

检查定义包含 `predicate`、timeout_ms、poll_ms 与 stable_ms。predicate 支持 `all`、`any`、`page`、`element`：all/any 组合非空 conditions；page 比较 url/text；element 比较 count、visible、enabled、editable、value、text 或 attribute。字符串比较使用 equals/contains/not_contains，equals 可引用输入；count 使用整数 equals。文本先合并空白，value 与 attribute 保留精确字符串；属性读取要求目标唯一，属性缺失不等于空字符串。editable 检查非 disabled、非 readOnly，不能单独证明输入已成功。

检查由共享编译器生成，通过 DeskPilot 只读观察后返回 pass/fail；读取异常由执行引擎归为 unknown。场景不提供 handler、expression 或脚本回调；普通 inputs 的参数名与值始终按数据处理。文本限定点击也由共享原语生成，重新确认唯一且可操作后点击，后置判据仍必须通过。

`fail` 可等待到预算结束；`unknown` 或函数异常不会变成通过；pass 必须跨采样持续达到 stable_ms。采样间隙内的瞬态变化不承诺检出。只返回本次判据所需的少量脱敏信息，不返回整页正文或客户记录。

## 异常与 Agent 接管

`run.handoff` 带 fault、steps、affected、quiescent、cleanup_errors 与 resume。例：填写检查曾通过，提交前输入被清空，得到 `PRIOR_RESULT_INVALIDATED`，detected_at 指向提交，producer_step_id 指向填写，提交保持 action_dispatched=false。

脚本会关闭本次执行会话后交接；quiescent=false 时不得再启动写执行者。effect=unknown 表示动作可能发生，先回读，不自动重复。Agent 读取终态后用 DeskPilot 诊断，修订有依据的定位或等待，再启动新流程。当前没有跨进程断点续跑，不能通过跳过失败步骤假装恢复。

调用方应保留工具调用到终态返回；终态是 Agent 的接管入口，不是日志通知服务。独立 supervisor 在场景 worker 崩溃/超时时合成 handoff，记录已派发动作的未知效果并尝试停止其执行树；无法核验树退出时保留 quiescent=false。取消后输出 cancelled，不能自动改成修复。外层 supervisor 本身被终止仍由调用方处理工具进程退出，不宣称可以自动唤醒休眠模型。

metrics 中 intermediate_model_calls=0 只表示宿主执行内部无模型调用，不能当作整个任务的 Token 消耗；发现页面和修订流程仍需要 Agent。业务预期不因执行失败而被削弱。

## SystemTest 与 Deployment

以上为当前机制的 Development 定向验证入口。独立系统测试、修改演示站产品或部署均不是该宿主的默认操作。
