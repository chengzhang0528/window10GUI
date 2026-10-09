/* wf-interactive.js — 联影 OA 两个"一次同步 evaluate 做不完"的交互，拆成分步模式
 *
 * 为什么必须拆：开下拉 / 开弹框之后，候选项是**异步渲染**的；一次 chrome.evaluate 里
 * 点完立刻读，只能读到空。所以每个动作拆成"动作 → 宿主 chrome.wait → 读取/点选"三步。
 * 另外 wea-associative（browser 字段）**忽略页内合成点击**，打开弹框必须是可信的 chrome.click
 * —— 那只能由宿主发，脚本发不了。
 *
 * 用法：先设 window.__OA_IT__ = { mode, fid, ... }，再以本文件为 chrome.evaluate 的 expression 执行。
 *
 *   mode=select-open      { fid }                        → 页内点开该字段的 .ant-select
 *   mode=select-options   { fid }                        → 读最后一个**可见**下拉的 li 文本（须在 select-open + 等待之后）
 *   mode=select-pick      { fid, pickText? }             → 点选匹配项（不给 pickText 则取第一个非空项）并回读
 *   mode=dialog-locate    { fid }                        → 滚动放大镜并做命中测试，返回 rect / inViewport / occluded
 *                                                          （宿主随后用 chrome.click 点 magnifierSelector）
 *   mode=dialog-mark      { fid, match?:[...] }          → 在最后一个可见弹框里标出目标行（data-oa-pick="1"）
 *   mode=dialog-verify    { fid }                        → 去掉标记，回读模型值与弹框是否已关
 *
 * 关键实测（2026-10-08，UIH-01 workflowid=2562）：
 *  - 判断弹框/下拉是否可见**不能**用 offsetParent（antd 固定定位元素恒为 null），用 getBoundingClientRect 尺寸 + computed display。
 *  - 弹框**容器**远早于**数据行**出现（实测正文 713 vs 1563 字符），等待条件必须包含"行数 > 0"，
 *    否则会拿到 rows:0 并误判"该弹框没有数据"。
 *  - 弹框行的第一个单元格可能是占位行（值为 '0'，如「无项目」），选它等于没选；默认跳过。
 */
(function () {
  var cfg = window.__OA_IT__ || {};
  var mode = cfg.mode;
  var fid = cfg.fid;
  var W = window.WfForm;

  function vis(e) {
    if (!e) return false;
    var r = e.getBoundingClientRect();
    var s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function cellOf(f) {
    var fm = document.querySelector('[data-fieldmark="' + f + '"]');
    return fm ? (fm.closest('td') || fm.parentElement) : null;
  }
  function lastVisibleDropdown() {
    var ds = Array.prototype.slice.call(document.querySelectorAll('.ant-select-dropdown')).filter(vis);
    return ds[ds.length - 1] || null;
  }
  function visibleModals() {
    return Array.prototype.slice.call(document.querySelectorAll('.ant-modal-wrap, .wea-browser-modal')).filter(vis);
  }
  function modalRows(w) {
    if (!w) return [];
    return Array.prototype.slice.call(w.querySelectorAll('.ant-table-body tbody tr'));
  }
  function modelOf(f) {
    try { var v = W.getFieldValue(f); return (v == null ? '' : String(v)); } catch (e) { return 'ERR'; }
  }
  function cellsOf(tr) {
    return Array.prototype.slice.call(tr.querySelectorAll('td'))
      .map(function (td) { return (td.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24); });
  }

  if (mode === 'select-open') {
    var cell = cellOf(fid);
    var sel = cell ? cell.querySelector('.ant-select') : null;
    if (!sel) return { mode: mode, ok: false, why: 'no-ant-select', fid: fid };
    sel.scrollIntoView({ block: 'center' });
    sel.click();
    return { mode: mode, ok: true, fid: fid, note: '宿主请 chrome.wait ~450ms 后再调 select-options / select-pick' };
  }

  if (mode === 'select-options') {
    var d = lastVisibleDropdown();
    if (!d) return { mode: mode, ok: false, why: 'no-visible-dropdown', fid: fid };
    var lis = Array.prototype.slice.call(d.querySelectorAll('li'));
    return {
      mode: mode, ok: true, fid: fid, count: lis.length,
      options: lis.map(function (li) {
        return {
          text: (li.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 28),
          dataValue: li.getAttribute('data-value')
        };
      })
    };
  }

  if (mode === 'select-pick') {
    var dd = lastVisibleDropdown();
    if (!dd) return { mode: mode, ok: false, why: 'no-visible-dropdown', fid: fid };
    var items = Array.prototype.slice.call(dd.querySelectorAll('li'));
    var want = cfg.pickText;
    var li = null;
    if (want == null) {
      li = items.filter(function (x) { return (x.innerText || '').trim() !== ''; })[0] || null;
    } else {
      li = items.filter(function (x) { return (x.innerText || '').replace(/\s+/g, ' ').trim() === want; })[0] || null;
    }
    if (!li) return { mode: mode, ok: false, why: 'option-not-found', fid: fid, want: want, seen: items.map(function (x) { return (x.innerText || '').trim(); }) };
    li.scrollIntoView({ block: 'center' });
    li.click();
    return { mode: mode, ok: true, fid: fid, picked: (li.innerText || '').trim(), after: modelOf(fid) };
  }

  if (mode === 'dialog-locate') {
    var c2 = cellOf(fid);
    if (!c2) return { mode: mode, ok: false, why: 'no-cell', fid: fid };
    var btn = c2.querySelector('button.ant-btn-icon-only');
    if (!btn) return { mode: mode, ok: false, why: 'no-magnifier', fid: fid };
    btn.scrollIntoView({ block: 'center' });
    var r = btn.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      mode: mode, ok: true, fid: fid,
      magnifierSelector: '[data-fieldmark="' + fid + '"] button.ant-btn-icon-only',
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rendered: (r.width > 0 && r.height > 0),
      inViewport: (r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth),
      hitIsButton: hit === btn,
      hitDesc: hit ? (hit.tagName + '.' + String(hit.className).slice(0, 40)) : null,
      note: r.width === 0
        ? '**未渲染**（0×0）→ 该字段在当前状态下条件隐藏，登记为 excused，不要重试点击'
        : '未在视口内或命中不是该按钮 → 先解决遮挡/滚动，再发可信 click'
    };
  }

  if (mode === 'dialog-mark') {
    var ws = visibleModals();
    var w = ws[ws.length - 1];
    if (!w) return { mode: mode, ok: false, why: 'no-visible-modal', fid: fid, hint: '弹框可能还没开或已关闭' };
    var t = w.querySelector('.ant-modal-title, .wea-browser-modal-title');
    var ths = Array.prototype.slice.call(w.querySelectorAll('th'))
      .map(function (x) { return (x.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 14); }).filter(Boolean);
    var rows = modalRows(w);
    var match = cfg.match || [];
    var pick = null;
    rows.forEach(function (tr) {
      if (pick) return;
      var cs = cellsOf(tr);
      var all = match.every(function (m) { return cs.join('|').indexOf(m) >= 0; });
      if (match.length && all) pick = tr;
    });
    if (!pick) {
      rows.forEach(function (tr) {
        if (pick) return;
        var first = (tr.querySelector('td') && (tr.querySelector('td').innerText || '').trim()) || '';
        if (first && first !== '0') pick = tr;   // 跳过「无项目」这类占位行
      });
    }
    if (!pick) return { mode: mode, ok: false, why: 'no-usable-row', fid: fid, rows: rows.length, headers: ths, sample: rows.slice(0, 3).map(cellsOf) };
    pick.setAttribute('data-oa-pick', '1');
    return {
      mode: mode, ok: true, fid: fid,
      title: t ? (t.innerText || '').trim().slice(0, 24) : null,
      headers: ths, rows: rows.length,
      rowSelector: '[data-oa-pick="1"]',
      cells: cellsOf(pick),
      note: '宿主请 chrome.click 该 rowSelector（可信输入），再 chrome.wait 弹框关闭，最后调 dialog-verify'
    };
  }

  if (mode === 'dialog-verify') {
    var mk = document.querySelector('[data-oa-pick="1"]');
    if (mk) mk.removeAttribute('data-oa-pick');
    return {
      mode: mode, ok: true, fid: fid,
      after: modelOf(fid),
      modalOpen: visibleModals().length > 0
    };
  }

  return { mode: mode, ok: false, why: 'unknown-mode', allowed: ['select-open', 'select-options', 'select-pick', 'dialog-locate', 'dialog-mark', 'dialog-verify'] };
})()
