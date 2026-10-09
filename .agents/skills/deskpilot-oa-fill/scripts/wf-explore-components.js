/* wf-explore-components.js — 联影 OA（泛微 e-cology / static4form）字段普查 + 组件分类
 *
 * 用法：作为 chrome.evaluate 的 expression 注入（只读，不改任何值）。
 * 返回：{ total, componentCounts, ambiguousCount, browserPickerTypeCount, browserPickerTypes, manifest[] }
 *   manifest[] = { label, fieldmark, fieldname, component, kinds, ambiguous, readonly, rendered, value, strategy }
 *
 * 2026-10-08 修复（均为实测，不是推测）：
 *  1) **分类顺序**：`.wea-browser` 必须先于所有 `.ant-select*` 判定。
 *     旧实现把 `.ant-select-selection--multiple` 排在前面，于是 `项目号(field68007)` 这种
 *     wea-browser(multi) 被误判成 `select_multi`，接着被硬写业务键 → 控件 ~50 次/秒重建（频闪）。
 *  2) **歧义不再静默**：一个单元格可能同时命中多个信号（实测 field68021 在普查里像
 *     span_display、在填充时像 text_input）。这里把全部命中记入 `kinds`，`ambiguous=true` 暴露出来，
 *     而不是每次取到哪个算哪个。
 *  3) **`rendered` 用真实尺寸**判定：字段"在 DOM 里"不等于"渲染了"。还额外给出**触发按钮**的尺寸，
 *     因为条件隐藏时单元格可能仍有尺寸、而里面的放大镜是 0×0（实测 工厂 field68033）。
 */
(function () {
  var STRATEGY = {
    text_input: 'changeFieldValue(fid,{value:"<text>"})',
    textarea: 'changeFieldValue(fid,{value:"<text>"})',
    span_display: 'changeFieldValue(fid,{value:"<text>"})',
    select_single: '{pickText:"<选项标签>"} 开下拉点真实 li；或 changeFieldValue(fid,{value:"<已实测的optionValue>"})',
    select_multi: '{pickText:"<选项标签>"} 开下拉点真实 li；或 changeFieldValue(fid,{value:"<已实测值>"})',
    select_search: '点搜索框输入触发加载 -> 选 li',
    browser: '**禁止硬写**：可信 chrome.click 点放大镜 -> 等弹框及其行 -> chrome.click 真实行（见 wf-interactive.js）',
    browser_readonly: '系统字段，一般跳过；确需赋值同 browser（禁止 changeFieldValue）',
    radio: 'changeFieldValue(fid,{value:"<radioValue>"})（对象形式）或点选',
    checkbox: 'changeFieldValue(fid,{value:"1"})（对象形式）',
    date: 'changeFieldValue(fid,{value:"YYYY-MM-DD"})',
    rich_text: 'CKEDITOR.instances[name].setData(html)（getFieldValue 对它永远为空）',
    file: 'CDP DOM.setFileInputFiles',
    detail_table: 'WfForm.addDetailRow(symbol,"1") + 子字段按各自组件填'
  };

  // 顺序 = 优先级。wea-browser 必须在 ant-select 之前。
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
    // span_display 需要 span + hidden 同时成立
    if (out.indexOf('span_display') >= 0 && !cell.querySelector('input[type=hidden]')) {
      out = out.filter(function (k) { return k !== 'span_display'; });
    }
    return out;
  }

  function box(el) {
    if (!el) return { w: 0, h: 0 };
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }

  var W = window.WfForm;
  var bi = (W.getLayoutStore().browserInfo) || {};
  var pickerTypes = {};
  Object.keys(bi).forEach(function (k) { pickerTypes[k] = bi[k].title || bi[k].type || ''; });

  var out = [];
  var cells = Array.prototype.slice.call(document.querySelectorAll('td[class*=mainTd_]'))
    .filter(function (td) { return /_0(\b|$)/.test(td.className); });

  cells.forEach(function (td) {
    var val = td.parentElement.children[1];
    if (!val) return;
    var fm = val.querySelector('[data-fieldmark]');
    var fid = fm ? fm.getAttribute('data-fieldmark') : val.getAttribute('data-fieldmark');
    if (!fid) return;
    var cell = td.parentElement.children[0] === val ? td : val; // 标签格 / 值格兜底
    var kinds = kindsOf(val);
    var trigger = val.querySelector('button.ant-btn-icon-only');
    var v = null;
    try { v = W.getFieldValue(fid); } catch (e) { v = null; }
    var vb = box(val);
    out.push({
      label: (td.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      fieldmark: fid,
      fieldname: fm ? fm.getAttribute('data-fieldname') : null,
      component: kinds[0] || 'unknown',
      kinds: kinds,
      ambiguous: kinds.length > 1,
      readonly: !!val.querySelector('.wea-field-readonly'),
      rendered: (vb.w > 0 && vb.h > 0),
      triggerBox: trigger ? box(trigger) : null,
      value: (v == null ? '' : String(v)).slice(0, 24),
      strategy: STRATEGY[kinds[0]] || '?'
    });
  });

  var counts = {};
  out.forEach(function (o) { counts[o.component] = (counts[o.component] || 0) + 1; });

  return {
    href: location.href,
    total: out.length,
    componentCounts: counts,
    unknown: (counts.unknown || 0),
    ambiguousCount: out.filter(function (o) { return o.ambiguous; }).length,
    notRenderedCount: out.filter(function (o) { return !o.rendered; }).length,
    browserPickerTypeCount: Object.keys(pickerTypes).length,
    browserPickerTypes: pickerTypes,
    manifest: out
  };
})()
