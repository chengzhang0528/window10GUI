# 根任务总控

Status: Active
Kind: TaskControl
Scope: coder_driver-template / 可恢复活动任务
Owner: 项目维护者
Updated: 2026-10-08
Depends On:
- ../AGENTS.md

这里是当前已授权且需要跨会话恢复的活动工作唯一事实源，不是全部后续工作的清单。状态只允许 `InProgress`、`Review`、`Blocked`；未开始或未授权的结果不在此登记。

## 当前队列

| ID | 状态 | 执行类型 | 范围 | 候选/制品 | 下一可验证结果 | 入口 |
|---|---|---|---|---|---|---|
| T-WF-OA-COMPONENT | Review | Development | 联影总部 OA 表单填写能力：组件分类 + WfForm 写值路径，并与工作区 skill 合并为唯一所有者 | - | 已达成（2026-10-08）：`wf-explore-components.js` 判 `项目号=browser`、`wf-fill-by-component.js` 对 browser 显式给值仍 `needs-dialog-pick`+`refused`、整轮连续 pass 填 6 字段 + 3 个真实选项 + 项目号弹框选行，且 `项目号` 所在 `tr` 3.12s 内 **0 次变更**。下一可选结果：把这套机制推广到第二张 OA 表单（如 UIH-02 借款单）并确认组件目录可复用 | `.agents/skills/deskpilot-oa-fill/SKILL.md` |

## 维护规则

- 只有已授权工作需要跨会话恢复、持续阻断恢复或外部部分状态恢复时才登记。
- 每个独立结果只保留一个活动项；同一结果的纠正更新原项。
- Development 使用 `-` 作为候选/制品。持久 SystemTest 与 Deployment 分别链接 SystemTestPlan 与 DeploymentPlan，并固定其候选或制品。
- Git 未提交、未推送或并行改动不维持活动项，也不反转任务结论。
