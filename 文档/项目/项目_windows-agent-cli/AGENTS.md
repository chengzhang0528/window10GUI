# Windows Agent CLI 项目智能体入口

Codename: DeskPilot（桌面领航）
Codename Scope: windows-agent-cli / internal communication only
Status: Active
Kind: AgentEntry
Scope: windows-agent-cli
Owner: 项目维护者
Updated: 2026-09-17
Depends On:
- ../../WORKSPACE_STRUCTURE.md
- ../../工作流/WORKFLOW_CONTRACT.md
- PRODUCT_CONTRACT.md
- CURRENT_DESIGN.md

## 路由

- 后续工作默认遵循 [产品契约的核心定位与默认目标](PRODUCT_CONTRACT.md#核心定位与默认目标)：Agent 围绕业务目标观察页面，以短批次连续操作和验证，在需要新判断时调整；有复用价值再沉淀流程，完整 JSON 不是首次操作的前置条件。方案与改动先读该契约及当前设计，不要求用户重复目标。
- 按产品契约的两个方向区分专项场景进化与纯代码底座优化；场景规则不进入 CLI，代码优化仍做必要定向验证，目标能力不得表述成已经实现。

- 产品目标、外部行为与安全边界以 [产品契约](PRODUCT_CONTRACT.md) 为唯一所有者。
- 已实现的架构、协议、状态模型和能力边界以 [当前设计](CURRENT_DESIGN.md) 为唯一所有者。
- 涉及结构化流程、步骤成功/异常、前序结果失效或 Agent 接管时，读取 [结构化流程与 Agent 接管设计](DECISION_STRUCTURED_FLOW.md)；以当前设计和源码核验已支持范围，宿主字段不能直接当作 CLI 参数。
- 用户只给网站与待操作、测试或配置的功能时，使用 [场景进化 Skill](../../../.agents/skills/deskpilot-flow-evolution/SKILL.md)，由 Luna 通过 DeskPilot 观察、分组执行、核验并根据实际状态恢复；只在已有场景匹配目标与副作用时复用，不要求用户描述步骤或先提供场景。宿主适配代码位于 `src/DeskPilot.Flow/`，使用或修改该宿主时读取其源码入口。
- 涉及代码时继续读取 [源码根入口](../../../src/WindowsAgent.Cli/AGENTS.md)、目标类型和测试夹具；先用 `rg` 查现有实现。
- 人类构建、接入和本地验证入口位于 [Windows Agent CLI 开发与验证](../../../src/WindowsAgent.Cli/README.md)。
- 已获授权的本地便携目录更新与回退使用 [本地更新 Runbook](RUNBOOK_LOCAL_UPDATE.md)；不得重建或替换已固定制品，不发布远端二进制。
- Agent 使用方法由仓库 Skill 提供：`deskpilot-core` 负责通用桌面执行，`deskpilot-browser` 负责 Chrome，`deskpilot-messaging` 负责跨应用桌面消息采集与回复编排，`deskpilot-testing` 仅在明确测试任务时加载；具体应用业务规则仍留在上层宿主。

## 项目边界

- 源码根：`src/WindowsAgent.Cli/`；宿主适配根：`src/DeskPilot.Flow/`。
- Development 验证夹具：`test-fixtures/agent-form.html`
- 默认本地生成物：`artifacts/`，不作为发布制品或正式证据所有者。
- 本项目面向已登录用户的交互式 Windows 10 桌面；不得把服务会话、锁屏、UAC 绕过或远程无人值守能力推断为已支持。
- 若请求把 CLI 扩展为端到端 Agent、业务 adapter 集合、自研 DSL/测试平台、云端编排或无人值守控制面，先停止实现并回到 `PRODUCT_CONTRACT.md` 的“方向不变量与变更门禁”；只有用户明确改变产品定位后才建立新的方向契约。

## 验证

源码改动至少执行：

```powershell
dotnet build src\WindowsAgent.Cli\WindowsAgent.Cli.csproj --no-restore
```

正式文档或入口变化还必须执行：

```powershell
npm run check:docs
```
