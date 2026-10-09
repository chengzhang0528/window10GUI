# The three-layer contract（三层契约）

> 从 `SKILL.md` 移出以满足热路径预算；规则与实测证据原文未改。


This is the core separation this skill enforces. Only one layer is authored by the business user.

| Layer | Author | Content | User touches |
|---|---|---|---|
| **Pure data JSON** | business user / consuming project | business values: material no., description, qty, unit price, supplier, due date | yes, only this |
| **Template JSON** | this skill, recorded from a real page | business-field-name → page selector/widget/text mapping, required markers, fixed options | no |
| **Engine** | generic script | reads template + pure data, drives the form | no |

The mapping step (pure data → template → actions) is performed by the agent using this skill, never handed to the user.
