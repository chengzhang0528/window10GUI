/* wf-fill-detail.js — 联影 OA 明细表：加行 / 按 data-fieldname 填列（单次注入，可回读）
 *
 * 用法：先设 window.__OA_DETAIL__，再以本文件为 chrome.evaluate 的 expression 执行。
 *   mode:'add'  { symbol?, rows? }                      → 加行并回读行数/行号（行**异步渲染**，填列要另起一次调用）
 *   mode:'fill' { symbol?, rows:{ <rowIndex>: { <fieldname>: <value> } } } → 按 fieldname 逐列写 + 回读
 *
 * 为什么这么设计（均为实测，2026-10-08）：
 *  - symbol 从 getLayoutStore().tableInfo 取（本表 detail_1），不要猜；
 *  - 本表有 **83 个列位**、绝大多数隐藏 ⇒ 必须按 data-fieldname 定位，按视觉列序必然错位；
 *  - addDetailRow 之后行是**异步渲染**的，同一次 evaluate 里摸不到新行的 fieldmark，所以要分两次调用；
 *  - **派生列绝不手写**（wszj 预估总价 = 数量 x 单价；pmms 品名描述 / dw 单位 / wlzl 物料中类 由物料号带出），
 *    只回读它们作为"联动算出来了"的证据；
 *  - 数值判等必须按数值：OA 把 '2' 规范化成 '2.000'，字符串比较会把成功报成失败。
 */
(function () {
  var cfg = window.__OA_DETAIL__ || {};
  var W = window.WfForm;
  var symbol = cfg.symbol || 'detail_1';
  var mode = cfg.mode || 'fill';

  function count() { try { return W.getDetailRowCount(symbol); } catch (e) { return 'ERR'; } }
  function indexStr() { try { return W.getDetailAllRowIndexStr(symbol); } catch (e) { return 'ERR'; } }
  function same(a, b) {
    if (a === null || a === undefined) return false;
    if (String(a) === String(b)) return true;
    var sa = String(a).trim(), sb = String(b).trim();
    if (sa === '' || sb === '') return false;
    var na = Number(sa), nb = Number(sb);
    return isFinite(na) && isFinite(nb) && na === nb;
  }
  function byFieldname() {
    var map = {};
    Array.prototype.slice.call(document.querySelectorAll('[data-fieldmark]')).forEach(function (e) {
      var f = e.getAttribute('data-fieldmark') || '';
      var n = e.getAttribute('data-fieldname');
      var m = /_(\d+)$/.exec(f);
      if (!n || !m) return;
      var r = Number(m[1]);
      if (!map[n]) map[n] = {};
      map[n][r] = f;
    });
    return map;
  }

  if (mode === 'add') {
    var out = { symbol: symbol, mode: mode, countBefore: count() };
    out.addErr = null;
    out.added = 0;
    // until：**幂等地补到 N 行**。实测干净实例的明细起始行数是 **0**（不是 1），
    // 所以"固定加一行"在 0 行和 1 行两种起点上会得到 1 行和 2 行两种结果 —— 用 until 才可复现。
    var want = Number(cfg.until || 0);
    if (want > out.countBefore) {
      for (var i = 0; i < want - out.countBefore; i++) {
        try { W.addDetailRow(symbol, '1'); out.added++; } catch (e) { out.addErr = String(e).slice(0, 120); break; }
      }
    } else if (!want) {
      try { W.addDetailRow(symbol, cfg.rows || '1'); out.added = 1; } catch (e) { out.addErr = String(e).slice(0, 120); }
    }
    out.countAfter = count();
    out.indexStr = indexStr();
    out.note = '行异步渲染：填列请另起一次 evaluate（宿主等约 1s）';
    return out;
  }

  var map = byFieldname();
  var rows = cfg.rows || {};
  var res = { symbol: symbol, mode: mode, rowCount: count(), indexStr: indexStr(), writes: [], derived: [] };
  Object.keys(rows).forEach(function (rk) {
    var row = Number(rk);
    var want = rows[rk];
    Object.keys(want).forEach(function (nm) {
      var f = map[nm] && map[nm][row];
      if (!f) { res.writes.push({ row: row, fieldname: nm, action: 'no-fieldmark' }); return; }
      var err = null, after = null;
      try { W.changeFieldValue(f, { value: want[nm] }); } catch (e) { err = String(e).slice(0, 70); }
      try { after = W.getFieldValue(f); } catch (e) { }
      res.writes.push({
        row: row, fieldname: nm, fid: f, want: String(want[nm]),
        after: (after == null ? '' : String(after)).slice(0, 24),
        ok: same(after, want[nm]), err: err
      });
    });
  });
  // 派生列只读回读（不写）
  (cfg.readDerived || ['wszj', 'pmms', 'dw', 'wlzl']).forEach(function (nm) {
    Object.keys(rows).forEach(function (rk) {
      var row = Number(rk);
      var f = map[nm] && map[nm][row];
      if (!f) return;
      var v = null; try { v = W.getFieldValue(f); } catch (e) { }
      res.derived.push({ row: row, fieldname: nm, fid: f, value: (v == null ? '' : String(v)).slice(0, 24) });
    });
  });
  res.okCount = res.writes.filter(function (x) { return x.ok; }).length;
  res.failCount = res.writes.filter(function (x) { return x.action !== 'no-fieldmark' && !x.ok; }).length;
  return res;
})()
