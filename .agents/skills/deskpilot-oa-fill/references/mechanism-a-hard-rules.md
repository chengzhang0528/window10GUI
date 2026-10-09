# 机制 A 硬规则 —— 每条都是实测的失败，不是风格偏好

> 从 `SKILL.md` 移出以满足热路径预算；规则与实测证据原文未改。

### Hard rules for mechanism A — each one is a measured failure, not a style preference

1. **`browser` / `browser_readonly`: never `changeFieldValue`.** Open the field's own dialog with a **trusted**
   `chrome.click` on `[data-fieldmark="<fid>"] button.ant-btn-icon-only` → wait for the modal **and its rows** →
   `chrome.click` the real row. Hard-writing the key makes the control re-render **~50 times/second** (the field
   flickers forever) *while* `getFieldValue` returns the value immediately — a **false pass**. Measured:
   `wf-validation.md` §3.1 (133–153 mutations in 3 s vs 0 after a real row pick).
2. **Classify before you write, in the fixed order** — `browser` **before** every `.ant-select*` (otherwise a
   `wea-browser` multi control is read as `select_multi`, which is how rule 1 gets violated). A cell matching
   several signals must report **all** of them (`kinds` / `ambiguous`); never silently take the first.
   **Re-classify on every pass — a field's component is not stable across linkage.** Measured: `wllx` 物料类型 read
   `browser` while empty, then `browser_readonly` (magnifier gone, `0` trigger buttons) after the upstream picks.
   A cached classification will send you looking for a button that no longer exists.
3. **A field measuring 0×0 is not rendered in this state — and that is often *fixable*, so try before excusing it.**
   `WfForm.changeFieldAttr(fid, { view: 0 })` **clears the linkage hide**: measured 2026-10-08, 工厂 `field68033` went from
   `tr.linkage_hide` / `display:none` / magnifier `0×0` to `display:table-row` with a clickable `16×28` magnifier, and the
   dialog row pick then worked (`1201`). Only if that fails (or the field is genuinely not applicable) record
   `conditional_hidden` as excused — and **state which of the two you did**, because forcing the render **overrides OA's own
   linkage decision** (the field may have been hidden on purpose for the current upstream values).
   `CHROME_ELEMENT_NOT_ACTIONABLE` on its own usually means this, not a scroll problem.
4. **`getFieldValue === want` is not proof of success** — it has false passes. For browser and linkage-prone
   fields also re-read after a delay **and** count mutations on the field's **`tr`** (never the cell: OA replaces
   the cell node, so a cell-scoped `MutationObserver` reports 0 and lies). Always measure a **control field that
   holds a value** in the same pass, or "0 mutations" proves nothing.
5. **Modal visibility: never test `offsetParent`** — antd modals are `position: fixed`, so it is `null` even when
   open (measured: predicate false while `matched_count: 1`). Use `getBoundingClientRect()` size + computed
   `display`. And wait for the **rows**, not just the modal container (container at 713 body chars, rows only
   later at 1563).
6. **Never invent an `optionValue`, and never copy one from another form.** The option `li` here carries no
   `data-value`; learn the value by clicking a real option and reading it back, or drive the pick by label
   (`{pickText:'…'}`). Measured on this tenant: 采购类型「普通」⇒`0`, 签批跳转「采购下单」⇒`3`,
   是否包含培训费「否」⇒`0`.
7. **Compare numeric fields numerically, not as strings.** OA **normalizes** what you write — `'2'` reads back `'2.000'`,
   `'5400'` reads back `'5400.0000'` — so `String(after) === String(want)` produces **false failures** on correct writes
   (measured: 4 of 14 detail writes were reported failed while the page-computed totals `10800.00`/`16000.00` proved they
   had landed). `wf-fill-by-component.js` has a `same()` helper for this; a false failure is as harmful as a false pass.
8. **Detail tables**: the symbol comes from `getLayoutStore().tableInfo` (here **`detail_1`**). Add a row with
   `WfForm.addDetailRow('detail_1','1')`, then **wait ~1 s** — the row renders asynchronously — before addressing its
   columns. Address columns by **`data-fieldname`** (`sl`/`wsdj`/…), never by visual column order (this table has 83
   columns, most hidden). **Never hand-write derived columns**: `wszj` 预估总价 is computed from 数量 × 单价, and
   `pmms` 品名描述 / `dw` 单位 / `wlzl` 物料中类 come from the 物料号 (`wlh`) picker — writing them gets overwritten.
   Fill the drivers (物料号 via its dialog), then let the page compute the rest and **read the computed column back as
   evidence** (`wszj` = 10800.00 = 2 × 5400 and 16000.00 = 5 × 3200).

Mechanism A **cannot** finish `select_*` or `browser*` inside one synchronous `evaluate` (options and dialog rows
render asynchronously, and `wea-associative` ignores in-page synthetic clicks). `scripts/wf-interactive.js` splits
them into `select-open → (wait ~450 ms) → select-options/select-pick` and
`dialog-locate → (trusted click) → dialog-mark → (trusted click) → dialog-verify`.
