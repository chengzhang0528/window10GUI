# Phase gates —— 机制必须能自己失败

> 从 `SKILL.md` 移出以满足热路径预算；规则与实测证据原文未改。


Written rules alone do not hold. Measured failure (2026-09-23): this file already said "phase 2 must be exhausted before phase 3", and the run **violated it anyway** — it went to phase 4, discovered three unfilled fields there, and only then understood that phase 2 had never covered the dialogs. The rule was prose; nothing checked it.

So each phase ends with a **gate**: a mechanical check whose result is recorded, plus a bounded loop back. Never advance on "looks done".

```
┌─ Phase 1 Census ──────► gate 1
│                          │ inventory has ≥1 field per control kind found in the DOM,
│                          │ and every kind present on the page is classified
│                          │ (no field left as "other" unless its raw HTML was inspected)
│                          ▼ fail → re-census the missing kinds
├─ Phase 2 Exhaust ─────► gate 2   ← the gate that was skipped
│                          │ for EVERY interactive control:
│                          │   · select → full option list recorded (not a sample)
│                          │   · browser → dialog TITLE, full column headers, row count,
│                          │     search-box ids, whether rows exist WITHOUT searching
│                          │   · radio → all labels of every group
│                          │ and for every browser control, the dialog was observed
│                          │ **in the state the data will actually produce** — a dialog's
│                          │ identity can change with upstream values, so a single-state
│                          │ snapshot is not exhaustion
│                          ▼ fail → return to phase 2, do NOT proceed
├─ Phase 3 Author data ─► gate 3
│                          │ ≥1 data file per meaningful branch, and
│                          │ oa-data-validate.mjs reports no needsConfirm + no gaps
│                          ▼ fail → fix data or send the question to the user
└─ Phase 4 Verify ──────► gate 4
                           │ every template field read back with a real value, or
                           │ explicitly recorded as readonly/derived/skipped-by-rule
                           ▼ fail → the failure names a phase; return THERE, not to phase 4
```

**The critical rule for a failed gate 4:** map the failure to its true phase before fixing anything.

| Failure seen in phase 4 | Actually a phase | Go back to |
|---|---|---|
| a control never opened / no rows found | 2 — its dialog was never exhausted | 2 |
| the dialog that opened is not the expected one | 2 — state-dependence not mapped | 2 |
| a field needs a value no data file carries | 3 — branch not authored | 3 |
| a value is outside every explored option | 3 + user | 3, then ask |
| a selector is wrong / element zero-sized | 1 — census entry was never verified | 1 |

**But not every red step is a bug.** Classify before you "fix" — three kinds, and only the first is yours:

| Kind | Signal (measured) | Action |
|---|---|---|
| **Technical failure** | element not found / dialog never opened / value stayed **empty** | map to a phase and fix |
| **Business-rule rejection** | clicked the right row, but the field holds a **different non-empty value** — measured: picking project 100167003201 in CR变更 mode leaves `0`; the identical action in 普通 mode keeps 100167003201 | **not a defect.** Report as `REJECTED_BY_FORM` for the user to judge. Do **not** go "fix" OA's business rule |
| **Excused gap** | conditional field not rendered, optional field with no candidates, a `datepicker` whose calendar interaction isn't implemented, or a `finance_section` field the applicant cannot fill | record it, don't block — but never hide it |

Field kinds the engine treats as **excused rather than failed** (each must carry its reason into the report):

- `conditional-detail` — row hidden in this form state (UIH-01 工厂)
- `optional: true` — no candidate available, or a dialog with no data
- `datepicker` — a `wea-date-picker` holds only a hidden input; `chrome.fill` cannot write it, and selecting a date needs the calendar interaction. Until that is implemented the engine records `skipped(unsupported_kind)` and **never pretends to have written it**.
- `finance_section: true` — fields in the accounting-voucher block (UIH-02 凭证年份/凭证号 sit next to 记账人 and the voucher table). The applicant does not fill these; the validator lists them under "不由申请人填写" and lets the run proceed. **Never invent a voucher number.**

Conflating these is costly in both directions: treating a business rule as a bug burns rounds trying to "fix" it; treating a real failure as a business rule ships a broken form.

**Cross-field side effects exist — re-verify at the end and re-apply.** Measured on CR变更: 项目节点/组合管理分类 passed their own step-level read-back (`R3-G3` / `生命周期`) and held when tested alone, yet read back **empty** at the end of a full run — opening the later dialogs reset them. So: after the whole pass, re-read every field, and for any that should hold a value but came back empty, **re-apply once and re-verify**. Bound it to one retry: if it is still empty, report it — do not loop, and do not let the retry mask a real failure.

Patching the template or the engine in response to a phase-4 failure is the anti-pattern this whole section exists to stop: it "fixes" the symptom while the unexplored branch stays unexplored, so the next run fails one field later.

**Report the phase honestly.** State which phase is complete and which gate is blocking. Do not describe phase-4 partial success as progress on the method — and do not claim a phase is done because its output file exists; the gate is the evidence.

**Run the gates; do not eyeball them.** `oa-gate.mjs` evaluates them mechanically, sequentially — it stops at the first failing gate and prints the phase to return to. Run it before moving on, and paste its verdict:

**Better: run the whole thing through the single entry `oa-run.mjs`.** The four phases used to live in five scripts called by hand, which means the mechanism only held if the agent remembered the order — forget the precheck, or declare success without running the gates, and it is worthless. `oa-run.mjs` freezes the order into code:

```
node oa-run.mjs --data data/<case>.data.json [--form "<表单名>"]
```

It runs precheck → cleanup → login → open form → fill → gate 1–4, prints a per-step timing table and the read-back summary, and exits `0` only when all four gates pass. **Measured (2026-09-23): scenario A and B both pass, 37.3s / 38.5s total, and three consecutive scenario-A runs gave identical results (18 fields filled, exit 0)** — the repeatability is the point, not the single lucky pass.

Use `oa-gate.mjs` directly only when diagnosing one gate in isolation.

Measured demonstration (2026-09-23): run against the real artifacts, `--phase 2` failed with `22/22 个 browser 字段没有观察到弹窗 → 回到阶段 2` — the same defect that had previously gone unnoticed until phase 4. That is the mechanism working: the loop fails itself at the right phase instead of leaking a phase-2 gap into phase-4 debugging.

**Exit to the next larger stage.** When gate 4 passes for the scenarios in scope, the loop is done and the work moves up a level — from *learning this form* to *operating it*. Say so explicitly and name the next stage, rather than quietly continuing: e.g. "四阶段通过（表单已学会）→ 下一阶段：用真实业务数据填单 / 扩展到第二张表单 / 固化为例行能力". Stopping silently at the end of gate 4 leaves the user unsure whether to wait.
