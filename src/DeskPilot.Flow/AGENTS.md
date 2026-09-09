# DeskPilot Flow 宿主适配入口

Scope: `src/DeskPilot.Flow/`

先读项目 `文档/项目/项目_windows-agent-cli/AGENTS.md`、ProductContract 与 DECISION_STRUCTURED_FLOW。此目录是公开 CLI 的宿主语言适配，不是 CLI 内置业务引擎或 XRain 源码。

- 浏览器动作只通过 DeskPilot NDJSON；不在场景里直接使用 HTTP、CDP 客户端或其他浏览器驱动。
- 场景是纯 JSON 数据；动作、targets 与 checks 只能使用 data-compiler 的有限词汇。成功由明确 predicate 决定，依赖事实必须重新检查，错误主动 handoff。
- worker 必须在创建 DeskPilot transport 前读取、JSON.parse、完整校验并编译场景；结构字段不接受 handler、expression 或脚本钩子，普通 inputs 的名称与值始终是数据。
- 不把底层命令成功当作业务成功；未知副作用不重放，交接前确认旧执行者退出。
- 场景只留定位与判据，不留秘密、客户数据、完整页面或运行日志。
- 运行 `node --test src/DeskPilot.Flow/*.test.mjs`；文档变化运行 `npm run check:docs`。
