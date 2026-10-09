---
name: deskpilot-oa-fill
description: Fill forms in the UH United-Imaging OA system (oa.united-imaging.com, 泛微 e-cology / static4form) through DeskPilot. Use when the user asks to fill a UIH purchase requisition or any OA workflow form, to learn a new OA form or read its real option sets, or to consolidate OA form-filling capability. Owns TWO write mechanisms — per-component WfForm classification (scripts/wf-explore-components.js, wf-fill-by-component.js, wf-interactive.js) and the selector/template CDP engine (src/DeskPilot.Flow/oa-*.mjs) — plus OA form templates, the pure-data to template mapping step, and OA-specific pitfalls. Applies the deskpilot-core / deskpilot-browser / deskpilot-flow-evolution skills for actual operations and deskpilot-flow-evolution for the universal/site-specific pitfall split; does not redefine them.
---

# DeskPilot OA Fill

Fill forms in the UH United-Imaging OA system (`oa.united-imaging.com`). This skill owns OA form filling as a reusable method and the OA template assets; it does not own generic Chrome operations (see [deskpilot-browser](../deskpilot-browser/SKILL.md)) or generic Web UI goal completion (see [deskpilot-flow-evolution](../deskpilot-flow-evolution/SKILL.md)), and it never re-implements the session/lease lifecycle (see [deskpilot-core](../deskpilot-core/SKILL.md)). Universal pitfalls (endpoint pinning, framework-bound inputs, …) live in [deskpilot-flow-evolution](../deskpilot-flow-evolution/SKILL.md); this skill keeps only OA-specific ones.

## Two write mechanisms — pick deliberately

This skill owns **two** ways to get values into an OA form. They are not interchangeable styles; each has a job.
(On 2026-10-08 the second one lived in a separate user-level skill `uih-oa-form-filling`; it was merged back here,
and the wrong rule it carried was corrected — see 规则 1 of [references/mechanism-a-hard-rules.md](references/mechanism-a-hard-rules.md).)

| | **A. Component classification + `WfForm` API** (fast path) | **B. Selector/template + CDP clicks** (governed path) |
|---|---|---|
| Assets | `scripts/wf-explore-components.js`, `scripts/wf-fill-by-component.js`, `scripts/wf-interactive.js`, `references/wf-component-catalog.json`, `references/wf-validation.md` | `../../../src/DeskPilot.Flow/oa-*.mjs` (engine + templates + data), the four phases below |
| Granularity | a few injected `chrome.evaluate` calls; **no per-form template** | one template + one pure-data file per form |
| Best for | learning a form fast, filling many fields, reading real option sets — **the default for a new form** | repeatable business runs on a form already learned; where gates and regression matter |
| Evidence | `references/wf-validation.md` | the four-phase gates below |

**Rule: write through `WfForm` wherever the component allows it, and drop to CDP clicks exactly where
`WfForm` cannot express the interaction** (browser pickers, selects whose options must load, dates,
rich text, detail rows, submit).

### Hard rules for mechanism A — 每条都是实测的失败，不是风格偏好

见 [references/mechanism-a-hard-rules.md](references/mechanism-a-hard-rules.md)：browser 拒硬写、分类顺序、0×0 字段、`tr` 级变异计数、弹窗可见性、选项值、数值比较、明细行，8 条各带实测证据。

## Data precheck: block, ask, or fill

Phase 3 output is checked by `oa-data-validate.mjs` **before** any browser work. Three outcomes, and the middle one is the one people get wrong:

| Outcome | Meaning | What the agent does |
|---|---|---|
| pass (exit 0) | every required value present, and every value it can check is inside the explored catalog | run the engine |
| **needsConfirm (exit 2)** | a value the system **cannot verify** — outside the explored candidate set, or the field's value domain was never explored | **stop and ask the user to confirm**, listing the known options and exactly how to confirm (`verified_values: {"字段": true}`) |
| incomplete (exit 2) | a required value is absent or still a placeholder | ask the user for the value |

**Never silently fill an unverified value, and never silently drop it.** "I don't know whether this is valid" is a question for the user, not a decision for the engine. Note the deliberate asymmetry: a field with **no** catalog is *unknown*, not *wrong* — only a field with a catalog and a value outside it is flagged.

The catalog in `template.value_catalog` is filled from phase 2, so the more thoroughly phase 2 was done, the more precheck can actually verify.

## Exploring without the user's data

Phase 1–2 must **not** wait on the user's values, and must not use them:

- **Never require the user to supply a search term.** When a dialog needs input, try: (a) open it with no search and read what is already listed — several dialogs here list all candidates immediately; (b) search a **single letter or digit** to get a sample and learn the row shape; (c) search the value the form *already* holds. The goal is to learn the control's behaviour, not to find the user's row.
- **Search boxes are addressed by id/semantics, never by index.** Measured: the 经费号_SAP采购 dialog has boxes `id=jfh`(经费号) and `id=xmh`(项目号); box 0 is 经费号, so an index-0 search with a project number always returns 0 rows. Box counts differ per dialog (project dialog 3, expense dialog 2), so an index has no portability at all. The engine resolves `search_box_id` → id/name match → sole box → and only then falls back to an index, recording that fallback as a **failure** so it cannot hide.
- **A control's dialog identity can depend on form state.** Measured: the same `[data-fieldname=jf]` magnifier opened 「经费号_SAP采购」 early on and 「关联采购订单」 later, after upstream values changed. So a template must not hard-code "field → dialog"; phase 2 should record the state the observation was made in, and the run should confirm the dialog identity before picking a row.

## The four phases (do them in this order — never interleave)

The failure mode this section exists to prevent: **exploring and verifying at the same time.** Running the engine, seeing one field fail, patching the template, re-running, seeing the next field fail — each round reveals exactly one field and the data gets invented as you go. That is not a mechanism; it is a loop that never converges.

| Phase | Do | Deliverable | Do NOT |
|---|---|---|---|
| **1. Census** | `oa-explore-form.mjs` — dump every `[data-fieldname]` with its control kind, size, id, required flag | the form's full field inventory | run the engine |
| **2. Exhaust** | `oa-explore-options.mjs` — open every select/dialog, record **all** options; select each value and record what changes on the page | a behaviour dictionary: options per control + linkage deltas | write any template |
| **3. Author data** | from phases 1–2, write **several** pure-data files covering the branches (one per meaningful scenario) | versioned data files, no guessing | touch the engine |
| **4. Verify once** | run each data file end-to-end, read back, then time it | pass/fail per scenario + the elapsed number | patch the template mid-run |

Phase 2 must reach **exhaustion** before phase 3 starts. "I got one option and it worked" is not exhaustion — record the whole list, including options that look irrelevant, because the branch you skip is the one the user's data will take.

Measured on UIH-01 (2026-09-23): the census found **66** `[data-fieldname]` nodes — browser-clickable 10, browser-select 12, select 13, radio 6, text 15, other 10. Every earlier estimate based on reading the rendered labels was wrong, which is precisely why the census comes first.

## Phase gates: the loop must be able to fail itself

见 [references/phase-gates.md](references/phase-gates.md)：gate 1–4 判定图、失败回退映射、三类结果（技术失败 / 业务拒绝 / 有据未填）、末端补写与 `oa-run.mjs` 单入口。

## The three-layer contract

纯数据（业务用户唯一要碰的一层）→ 模板（本 skill 从真实页面录制）→ 引擎（通用脚本）；映射步骤由 agent 完成。详见 [references/three-layer-contract.md](references/three-layer-contract.md)。

## Where things live

见 [references/asset-inventory.md](references/asset-inventory.md)：脚本、模板与纯数据、报告身份、自检工具与机制 A 资产清单。

## Fill loop

0. **Budget timeouts from measurement, not guesswork** (baseline in `../../../src/DeskPilot.Flow/timeouts.mjs`). Every `win-agent` process start costs ~7s fixed (process + CDP handshake) before the operation itself — batch related requests into one call to amortize it. Measured (Chrome 151, 2026-09-23): cold `chrome.ensure` **3.5s**, `ensure` when ready **1.2s**, one `chrome.evaluate` **8.0s**, five chained **12.2s**. Hence: `ensure` 20s / single request 15s / UI wait 20s / whole flow 60s. A failure must surface as an error, never as a long silent wait — an oversized timeout (60s for a 3.5s start) turns failure into wasted time and hides the cause. Emit per-step `elapsed_ms` so a hang shows *where*, not merely *that*.
1. Resolve the managed Chrome endpoint explicitly (read `references/oa-pitfalls.md` — endpoint pinning). Never let the CLI auto-pick; a ChatGPT desktop app occupies 9229.
2. Check login state; on `login_required` re-login via the hosted credential store (see `references/oa-pitfalls.md` for the `div.loginBtn` shape).
3. Clean stale `static4form` tabs first (`close-stale-tabs.mjs`) — OA opens a new tab per card click and `chrome.attach` with a static condition then hits `AMBIGUOUS_CHROME_TARGET`.
4. Open the target form from its template's `entry` block; attach to the new form tab.
   **Use the scripted entry, not hand-driving**: `oa-open-form.mjs --name "<表单名>"` walks 门户 → 顶部「流程」→ 左侧「新建流程」→ 目标条目 (`a`, parent `div.fontItem`) and verifies the new `static4form` tab actually appeared (实测 2.7s, returns `target_id`). Cold start otherwise strands you on `about:blank` with no recorded route. Two traps it already handles: `chrome.click`'s `text` param does **not** filter (it hits the first same-shaped element — 「门户」 instead of 「流程」), and the catalog renders asynchronously.
   After attaching, **wait for the form to render** before writing (`chrome.wait` on the first text field's selector): a freshly opened `static4form` tab is CDP-attachable while its Vue tree is still empty, and an immediate `chrome.fill` then fails with `CHROME_ELEMENT_NOT_FOUND`.
5. Enumerate the fields that are **currently rendered** before writing: a field is usable only if its selector matches **and** its box has non-zero size (`getBoundingClientRect().width>0 && height>0`). A field can be present in the DOM, report `visibility: visible`, yet have a zero-sized ancestor chain because it is not rendered in this form state — clicking it then fails as "not actionable" and looks like a wrong selector.
6. For each field in the template, map the pure-data value and write it:
   - text → `chrome.fill` (framework-bound inputs revert an inline `document value =`).
   - `wea-select` → click the widget, pick from the *currently visible* `.ant-select-dropdown` (options accumulate across dropdowns).
   - `wea-browser` → **open the dialog with `chrome.click` (CDP trusted input), never an in-page `.click()`**: `wea-associative` ignores untrusted events, so `.click()` returns success while no dialog appears. Scroll the widget into view first, or `chrome.click` fails `CHROME_ELEMENT_NOT_ACTIONABLE`. Then choose among the **currently visible** `.wea-browser-modal`s — several stay open at once and `querySelector` returns only the first, so scope to the last-opened one; find rows inside `table.ant-table-body tbody tr` (fixed-header tables put rows there, not in a plain `tbody`). Respect the template's `search` flag: when the dialog already lists all candidates set `search: false` (blindly searching an unrelated box filters the list to zero). After picking, **read back the selection** (`input` checked / row `selected` class) — `clicked:true` only means a click was sent. **Never shortcut this with `WfForm.changeFieldValue(fid,{value:'<key>'})`**: measured 2026-10-08 it returns a **false pass** and puts the row into a **~50/s re-render loop** (the field flickers) — see the hard rules above and `references/wf-validation.md` §3.1.
   - detail rows → click the add button by its own element id (`#addbutton0`), fill per column via the `_N` row-suffix ids, and map columns by `data-fieldname` — never by visual column order.
   - skip columns the template marks `derived` (品名描述 `pmms` comes from the material number, 预估总价 `wszj` is computed): OA silently reverts a write to them.
   - identify any field whose meaning is unconfirmed **read-only** (see [deskpilot-browser](../deskpilot-browser/SKILL.md) §6); `references/oa-pitfalls.md` §3 is the case where a probe-based guess was wrong.
7. Read back every value and the computed totals (合计未税金额) — proof the data reached the form model, not just the DOM. Read back each detail row as it is filled, not only at the end.
8. Stop before submit unless the user authorized it in that run. OA idle timeout wipes the whole unsaved form, so one continuous pass.

## Required final output

End with the actionable report defined in [deskpilot-flow-evolution](../deskpilot-flow-evolution/SKILL.md) (settled / open / what the user must supply next). OA specifics on top of that:

- **Lead with the phase and the gate.** Every report opens with a line of the form `阶段 <n>/4 <名称> — gate <n> <通过|未通过>` plus, when failed, the phase the failure maps back to. This is what lets the user see whether to wait, unblock, or move on. Example: `阶段 2/4 穷尽 — gate 2 未通过（经费弹窗未在目标状态下观察）→ 回到阶段 2，不进阶段 3`.
- When gate 4 passes, **name the next larger stage explicitly** and say the loop is done (见 [references/phase-gates.md](references/phase-gates.md) 的 Exit to the next larger stage).
- Run `oa-data-validate.mjs` and relay its report verbatim — it already lists each gap as `[范围] 字段：原因` + `怎么做：<which values/detail_rows key>`, distinguishes 必填缺失 from 占位值未替换, and states the next step.
- Say plainly that the OA form is **not submitted**, and that OA idle timeout wipes the whole unsaved form (so gaps must close before running).
- Report what was written with read-back evidence (e.g. the page-computed 合计未税金额), and which fields were skipped as `derived` or reverted by the system.
- Never report an input event or `verified:true` as business success without a read-back.
- Machine-readable: `{"event":"data.incomplete","gaps":[…],"optional":[…],"needsConfirm":[…]}` from the validator; `{"event":"fill.done","results":[…],"snapshot":…}` from the engine.

## Boundaries

- Real selectors and values come only from observing the real page; never invent field ids.
- Credentials stay in the user-level hosted store; this skill never reads or writes them to files or docs.
- Submission is a user decision per run, never automatic.
- This skill owns the OA method and template assets, not the consuming project's business rules.
