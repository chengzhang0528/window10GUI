/* wf-fill-by-component.js — 联影 OA 按组件派发填充器（单次注入、可回读、不提交）
 *
 * 用法：
 *   1) 先注入配置：window.__OA_FILL__ = {
 *        values: { fieldmark: "原始值" | {pickText:"选项标签"} },
 *        generic: false,          // true = 对**文本类**空字段写 "验证-<组件>"（绝不碰 browser/select）
 *        scope: 'visible'|'all'   // visible = 只处理已渲染字段；all = 连未渲染的也处理（有显式值时）
 *      }
 *   2) 再以本文件为 chrome.evaluate 的 expression 执行。
 *   返回：[{ fieldmark, component, action, want, after, ok, ... }]
 *
 * 本脚本**只做同步能做完的事**，并如实把做不到的登记出来交给宿主（见 references/wf-validation.md 的编排）：
 *   - 文本类 (text_input/textarea/span_display) → changeFieldValue（对象形式）+ 回读
 *   - radio/checkbox                              → changeFieldValue（对象形式）+ 回读
 *   - **browser / browser_readonly**               → **一律拒绝硬写**，登记 needs-dialog-pick
 *   - **select_single / select_multi**             → 登记 needs-option-pick（开下拉要等异步渲染，
 *                                                    一次同步 evaluate 做不完；由 wf-interactive.js 分步完成）
 *   - rich_text                                    → 登记 cke-setData（本脚本不实现）
 *
 * 2026-10-08 修复（实测依据）：
 *  1) 旧实现把 browser 字段与文本字段一样走 changeFieldValue。实测 UIH-01 `项目号(field68007)`：
 *     硬写后 `getFieldValue` **立刻相等（假通过）**，但该行 3 秒内被重建 **133–153 次**（~50 次/秒），
 *     模型在 `"" ↔ 键` 间跳 —— 就是用户看到的"频闪"。同一实例改用弹框选行则 **0 次/3s** 且显示正确。
 *     ⇒ browser 字段硬写是**缺陷**，不是"可选路径"。现在直接拒绝。
 *  2) 分类顺序：wea-browser 必须先于 .ant-select*（否则 browser(multi) 被判 select_multi）。
 *  3) 一个单元格可能同时命中多个信号 → 记 `kinds`/`ambiguous`，不静默取第一个。
 *  4) 零尺寸 = 该状态下未渲染：没有显式值时记 `conditional_hidden`（有据可依未填，不算失败）；
 *     有显式值时仍写入，并记 `wasHidden:true`。
 */
(function () {
  var cfg = window.__OA_FILL__ || {};
  var VALUES = cfg.values || {};
  var GENERIC = !!cfg.generic;
  var SCOPE = cfg.scope || 'visible';

  var TEXTUAL = { text_input: 1, textarea: 1, span_display: 1 };
  var TOGGLES = { radio: 1, checkbox: 1 };
  var SELECTS = { select_single: 1, select_multi: 1, select_search: 1 };
  var BROWSERS = { browser: 1, browser_readonly: 1 };

  var RULES = [
    ['detail_table', 'table.excelDetailTable'],
    ['rich_text', '.cke_editor,[id^=cke_],.cke_wysiwyg_frame'],
    ['date', '.ant-calendar-picker'],
    ['browser', '.wea-browser:not(.wea-field-readonly)'],
    ['browser_readonly', '.wea-browser.wea-field-readonly'],
    ['select_multi', '.ant-select-selection--multiple'],
    ['select_search', '.ant-select-search__field'],
    ['select_single', '.ant-select'],
    ['radio', 'input[type=radio]'],
    ['checkbox', 'input[type=checkbox]'],
    ['textarea', 'textarea'],
    ['file', 'input[type=file]'],
    ['text_input', 'input.wf-input'],
    ['span_display', 'span[id$=span]']
  ];

  function kindsOf(cell) {
    var out = [];
    for (var i = 0; i < RULES.length; i++) {
      if (cell.querySelector(RULES[i][1])) out.push(RULES[i][0]);
    }
    if (out.indexOf('span_display') >= 0 && !cell.querySelector('input[type=hidden]')) {
      out = out.filter(function (k) { return k !== 'span_display'; });
    }
    return out;
  }

  var W = window.WfForm;
  var rep = [];

  // 回读判等：**不能只做字符串比较**。OA 会规范化数值（实测：写 '2' 回读 '2.000'、
  // 写 '5400' 回读 '5400.0000'），字符串比较会把成功的写入报成失败 —— 那是一种"假失败"，
  // 与本文档反复批评的"假通过"同样有害（会让人去改本来正确的代码）。
  function same(after, want) {
    if (after === null || after === undefined) return false;
    if (String(after) === String(want)) return true;
    var sa = String(after).trim(), sw = String(want).trim();
    if (sa === '' || sw === '') return false;
    var na = Number(sa), nw = Number(sw);
    return isFinite(na) && isFinite(nw) && na === nw;
  }
  var cells = Array.prototype.slice.call(document.querySelectorAll('td[class*=mainTd_]'))
    .filter(function (td) { return /_0(\b|$)/.test(td.className); });

  cells.forEach(function (td) {
    var val = td.parentElement.children[1];
    if (!val) return;
    var fm = val.querySelector('[data-fieldmark]');
    var fid = fm ? fm.getAttribute('data-fieldmark') : null;
    if (!fid) return;

    var kinds = kindsOf(val);
    var kind = kinds[0] || 'unknown';
    var r = val.getBoundingClientRect();
    var rendered = (r.width > 0 && r.height > 0);
    var raw = VALUES[fid];
    var pickText = (raw && typeof raw === 'object') ? raw.pickText : null;
    var hasExplicit = (raw !== undefined);

    if (SCOPE === 'visible' && !rendered && !hasExplicit) return;

    var existing = null;
    try { existing = W.getFieldValue(fid); } catch (e) {}
    var hasValue = (existing !== null && existing !== undefined && String(existing) !== '');

    var base = {
      fieldmark: fid,
      component: kind,
      kinds: kinds,
      ambiguous: kinds.length > 1,
      rendered: rendered,
      existing: hasValue ? String(existing).slice(0, 24) : ''
    };

    if (!hasExplicit && !rendered) {
      if (hasValue) {
        rep.push(Object.assign({}, base, { action: 'skip(has value)', ok: true, after: base.existing }));
      } else {
        rep.push(Object.assign({}, base, { action: 'conditional_hidden', ok: true, note: '该状态下未渲染，有据可依未填' }));
      }
      return;
    }

    if (kind === 'rich_text') {
      // **没实现就不要报 ok:true** —— 那正是本文件反复批评的"假通过"
      rep.push(Object.assign({}, base, {
        action: 'needs-cke-setData',
        ok: false,
        next: '宿主执行 CKEDITOR.instances[name].setData(html)；它只能用 getData() 验证'
      }));
      return;
    }

    if (BROWSERS[kind]) {
      if (!hasExplicit && hasValue) {
        // 已经有值且本次没要求改：如实记 skip，而不是无条件报 needs-dialog-pick（那是噪声）
        rep.push(Object.assign({}, base, { action: 'skip(has value)', ok: true, after: base.existing }));
        return;
      }
      rep.push(Object.assign({}, base, {
        action: 'needs-dialog-pick',
        ok: false,
        refused: hasExplicit ? String(raw) : null,
        reason: 'browser 字段禁止 changeFieldValue 硬写（实测会造成 ~50 次/秒重建的频闪且先返回假通过）',
        magnifierSelector: '[data-fieldmark="' + fid + '"] button.ant-btn-icon-only',
        next: '宿主：chrome.click 放大镜 → 等弹框且行数>0 → chrome.click 真实行 → 回读 getFieldValue'
      }));
      return;
    }

    if (SELECTS[kind]) {
      if (!hasExplicit && hasValue) {
        rep.push(Object.assign({}, base, { action: 'skip(has value)', ok: true, after: base.existing }));
        return;
      }
      if (pickText) {
        rep.push(Object.assign({}, base, {
          action: 'needs-option-pick',
          ok: false,
          pickText: pickText,
          selectSelector: '[data-fieldmark="' + fid + '"] .ant-select',
          next: '宿主：wf-interactive.js mode=select-open -> (等 ~450ms) -> mode=select-pick pickText=...'
        }));
        return;
      }
      if (hasExplicit && typeof raw === 'string') {
        // 仅当调用方**已经实测过**这个 optionValue 时才允许直接写
        var err1 = null, after1 = null;
        try { W.changeFieldValue(fid, { value: raw }); } catch (e) { err1 = String(e).slice(0, 80); }
        try { after1 = W.getFieldValue(fid); } catch (e) {}
        rep.push(Object.assign({}, base, {
          action: 'fill(optionValue)', want: raw.slice(0, 24),
          after: (after1 == null ? '' : String(after1)).slice(0, 24),
          ok: same(after1, raw), err: err1,
          note: '只对已实测的 optionValue 使用；否则请用 {pickText} 走点选'
        }));
        return;
      }
      rep.push(Object.assign({}, base, {
        action: 'needs-option-pick',
        ok: false,
        selectSelector: '[data-fieldmark="' + fid + '"] .ant-select',
        next: '宿主：wf-interactive.js mode=select-open -> 等 -> mode=select-pick（不给 pickText 则选第一个非空项）'
      }));
      return;
    }

    var want = raw;
    if (want === undefined) {
      if (!GENERIC) return;
      if (!TEXTUAL[kind] && !TOGGLES[kind]) return;   // generic 绝不碰 browser/select/file/detail
      var before = null;
      try { before = W.getFieldValue(fid); } catch (e) {}
      if (before !== null && before !== '' && before !== undefined) {
        rep.push(Object.assign({}, base, { action: 'skip(has value)', ok: true, after: String(before).slice(0, 24) }));
        return;
      }
      want = TOGGLES[kind] ? '1' : ('验证-' + kind);
    }

    var err = null, after = null;
    try { W.changeFieldValue(fid, { value: want }); } catch (e) { err = String(e).slice(0, 80); }
    try { after = W.getFieldValue(fid); } catch (e) {}
    rep.push(Object.assign({}, base, {
      action: 'fill',
      want: String(want).slice(0, 24),
      after: (after == null ? '' : String(after)).slice(0, 24),
      ok: same(after, want),
      err: err,
      wasHidden: !rendered
    }));
  });

  var tally = { filled: 0, ok: 0, failed: 0, needsDialogPick: 0, needsOptionPick: 0, needsCkeSetData: 0, conditionalHidden: 0, skippedHasValue: 0, other: 0 };
  rep.forEach(function (x) {
    if (x.action === 'fill' || x.action === 'fill(optionValue)') { tally.filled++; if (x.ok) tally.ok++; else tally.failed++; }
    else if (x.action === 'needs-dialog-pick') tally.needsDialogPick++;
    else if (x.action === 'needs-option-pick') tally.needsOptionPick++;
    else if (x.action === 'needs-cke-setData') tally.needsCkeSetData++;
    else if (x.action === 'conditional_hidden') tally.conditionalHidden++;
    else if (x.action === 'skip(has value)') tally.skippedHasValue++;
    else tally.other++;
  });
  return { href: location.href, summary: tally, results: rep };
})()
