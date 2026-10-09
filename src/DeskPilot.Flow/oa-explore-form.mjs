/*
 * OA 表单探查器：一次导出「这张表单到底有什么」。
 *
 * 为什么需要它（正确机制的第一步）：
 *   之前是"跑到哪失败就改哪" —— 改模板→跑→失败→再改，把探查和验证混在一起，
 *   每次都只看到失败的那个字段。正确顺序是**先穷尽探查、再造数据、最后跑一次计时**。
 *   本脚本负责第一步：把每个字段的控件类型、当前值、可点元素、以及关联弹窗的
 *   候选值一次性摸清楚，产出机器可读的探查报告。
 *
 * 用法：
 *   node oa-explore-form.mjs [--endpoint http://127.0.0.1:58212] [--out report.json]
 *   node oa-explore-form.mjs --open-dialogs     # 额外逐个打开 browser 字段的弹窗并读候选
 */
import { DeskPilotTransport } from './transport.mjs';
import { TIMEOUTS } from './timeouts.mjs';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';

function readRecordedEndpoint() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const file = join(local, 'WindowsAgent', 'ChromeProfile', 'DeskPilotDevToolsEndpoint');
  try { return existsSync(file) ? (readFileSync(file, 'utf8').trim() || undefined) : undefined; } catch { return undefined; }
}

/**
 * 页面内：给每个字段判定控件类型。
 *
 * 判定依据是**实测结构**，不是猜：
 *   - readonly : 外层带 wea-field-readonly（如 jffzr/xmjl），或内部是 hidden input
 *   - browser  : 内部有 .wea-associative-search（关联搜索控件）
 *                 · 带 wea-associative-click  → 可直接点开
 *                 · 不带                      → 需要点内层 .ant-select 展开
 *   - select   : 内部有 .ant-select 但没有 associative
 *   - radio    : 内部有 input[type=radio]
 *   - text     : 内部是 input/textarea
 */
const INVENTORY = `(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const out = [];
  const seen = {};
  document.querySelectorAll('[data-fieldname]').forEach(el => {
    const fn = el.getAttribute('data-fieldname');
    // **同一个 fieldname 会出现多次**（实测第三张表单：wllx 同时存在于明细行与主表）。
    // 两处状态可能完全相反：明细行那个 w=334 是真交互的 .ant-select，主表那个 w=0 且
    // tr display:none。若后者覆盖前者，普查会把"可交互的下拉"记成"隐藏的文本框"，
    // 后续阶段就会当成不存在的字段跳过。
    // 判据：优先保留**已渲染**（尺寸非零）的那个；都渲染或无渲染时保留第一个。
    const r = el.getBoundingClientRect();
    const rendered = r.width > 0 && r.height > 0;
    const prev = seen[fn];
    if (prev && (prev.rendered || !rendered)) return;   // 已有更好或同等的一个，跳过
    seen[fn] = { el, rendered };
  });
  Array.from(Object.values(seen)).forEach(({ el }) => {
    const fn = el.getAttribute('data-fieldname');
    // readonly 判定要同时看：字段自身/祖先的 wea-field-readonly，**以及字段内部**的同类名。
    // 实测坑：sqr/jffzr/xmjl 的 readonly 类名带在**自身内部的 div** 上
    //   <div data-fieldname=sqr><div class="wea-browser wea-field wea-field-readonly">
    // 只看祖先会漏判，于是这些只读字段被当成"可交互但没弹出弹窗"，gate 2 永远过不了。
    const outer = el.closest('.wea-field') || el;
    const roAncestor = /wea-field-readonly/.test((outer.className || '').toString())
      || /wea-field-readonly/.test((el.className || '').toString());
    const roInner = !!el.querySelector('.wea-field-readonly, .wea-associative-search.wea-field-readonly');
    const readonly = roAncestor || roInner;
    const assoc = el.querySelector('.wea-associative-search');
    const hasClick = !!el.querySelector('.wea-associative-click');
    const sel = el.querySelector('.ant-select');
    const radios = el.querySelectorAll('input[type=radio]');
    const inp = el.querySelector('input:not([type=hidden]), textarea');
    let kind = 'other';
    if (readonly) kind = 'readonly';
    else if (assoc) kind = hasClick ? 'browser-clickable' : 'browser-select';
    else if (radios.length) kind = 'radio';
    else if (sel) kind = 'select';
    else if (inp) kind = 'text';
    const td = el.closest('td');
    const tr = el.closest('tr');
    // 该字段所在行里、紧邻左侧的标签文本（同排前一格），用于把 data-fieldname 对上人读的名字
    let label = null;
    if (tr) {
      const cells = Array.from(tr.querySelectorAll('td'));
      const idx = cells.indexOf(td);
      for (let i = idx - 1; i >= 0 && i >= idx - 3; i--) {
        const t = (cells[i].innerText || '').trim();
        if (t && t.length < 30) { label = t; break; }
      }
    }
    const b = box(el);
    out.push({
      fieldname: fn,
      label,
      kind,
      visible: visible(el),
      ...b,
      value: inp ? String(inp.value || '').trim().slice(0, 60) : (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      required: /required/.test((el.className || '').toString()) || !!el.querySelector('.required'),
      // hasButton：关联搜索字段的**触发元素是放大镜按钮**，不是输入区。
      // 没有这个按钮的 browser 字段是只读展示字段，不该被当成"未穷尽的交互控件"。
      hasButton: !!el.querySelector('button.ant-btn-icon-only') || !!el.querySelector('button'),
      assocId: assoc ? (assoc.id || null) : null,
      inputId: inp ? (inp.id || null) : null,
      inputTag: inp ? inp.tagName : null,
      selectorHint: el.querySelector('button.ant-btn-icon-only')
        ? ('[data-fieldname=' + fn + '] button.ant-btn-icon-only')
        : (assoc && assoc.id ? ('#' + assoc.id) : (inp && inp.id ? ('#' + inp.id) : null))
    });
  });   // forEach over deduped entries
  return out;
})();`;

/** 页面内：列出当前所有可见弹窗及其候选行/可选项 */
const DIALOGS = `(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
  return modals.map(m => {
    const rows = [];
    m.querySelectorAll('table.ant-table-body tbody tr, table.ant-table-fixed tbody tr').forEach(tr => {
      if (!visible(tr)) return;
      const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()).filter(Boolean);
      if (cells.length) rows.push(cells.slice(0, 6));
    });
    const inputs = Array.from(m.querySelectorAll('input.ant-input')).filter(visible)
      .map(i => ({ id: i.id || null, placeholder: i.placeholder || null }));
    const btns = Array.from(m.querySelectorAll('button')).filter(visible)
      .map(b => (b.innerText || '').trim()).filter(Boolean);
    const title = m.querySelector('.ant-modal-title');
    return {
      title: title ? (title.innerText || '').trim() : null,
      rowCount: rows.length,
      rows: rows.slice(0, 12),
      searchInputs: inputs,
      buttons: btns,
      hasConfirm: btns.some(b => /确定|确认|提交/.test(b))
    };
  });
})();`;

export async function exploreForm({ executable = DEFAULT_EXECUTABLE, endpoint, openDialogs = false, onEvent = () => {} } = {}) {
  const transport = new DeskPilotTransport({ executable });
  const ep = endpoint ?? readRecordedEndpoint();
  const withEndpoint = p => (ep ? { ...p, endpoint: ep } : p);
  const t0 = Date.now();
  try {
    const attached = await transport.request('chrome.attach', withEndpoint({ url_contains: 'static4form' }), { timeoutMs: TIMEOUTS.requestUi });
    onEvent({ event: 'explore.attached', target_id: attached?.target_id });

    // 等表单渲染完：attach 成功 ≠ 表单已挂载。刚开的标签页 Vue 还是空的，
    // 立刻查询会得到"0 个字段"这种看起来像选择器写错、其实是没渲染的结果。
    await transport.request('chrome.wait', withEndpoint({
      selector: '#requestname', condition: 'element', timeout_ms: TIMEOUTS.requestUi
    }), { timeoutMs: TIMEOUTS.requestUi + TIMEOUTS.request }).catch(() => null);
    // 再等到字段真正出现（最多约 8s），以 [data-fieldname] 数量稳定为准
    for (let i = 0; i < 20; i++) {
      const n = await transport.request('chrome.evaluate', withEndpoint({
        expression: 'document.querySelectorAll("[data-fieldname]").length', timeout_ms: TIMEOUTS.request
      }), { timeoutMs: TIMEOUTS.request }).then(r => r?.value).catch(() => 0);
      if (n > 0) { onEvent({ event: 'explore.rendered', fieldNodes: n }); break; }
      await new Promise(r => setTimeout(r, 400));
    }

    const run = async (expression, label) => {
      const r = await transport.request('chrome.evaluate', withEndpoint({ expression, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi });
      onEvent({ event: 'explore.step', step: label });
      return r?.value;
    };

    const fields = await run(INVENTORY, 'inventory');
    const report = { url: attached?.url, target_id: attached?.target_id, fields, dialogs: {}, exploredAt: new Date().toISOString() };

    if (openDialogs) {
      // 逐个打开可点的 browser 字段，读它的弹窗候选，然后关掉。
      // 这是"穷尽"的关键：先知道每个弹窗里有什么，才知道数据该怎么造。
      const targets = (fields ?? []).filter(f => f.kind === 'browser-clickable' || f.kind === 'browser-select');
      for (const f of targets) {
        try {
          if (f.selectorHint) {
            await run(`(() => { const el = document.querySelector(${JSON.stringify(f.selectorHint)}); if (el) el.scrollIntoView({block:'center'}); return true; })()`, f.fieldname + ':scroll');
          }
          const clickSel = f.kind === 'browser-clickable' ? f.selectorHint : null;
          if (clickSel) {
            await transport.request('chrome.click', withEndpoint({ selector: clickSel, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi });
          } else {
            // browser-select：点内层 ant-select 展开
            await run(`(() => { const el = document.querySelector('[data-fieldname=${f.fieldname}] .ant-select'); if (el) el.click(); return !!el; })()`, f.fieldname + ':open');
          }
          await new Promise(r => setTimeout(r, 1500));
          const dialogs = await run(DIALOGS, f.fieldname + ':dialogs');
          report.dialogs[f.fieldname] = dialogs;
          // 关掉所有弹窗，避免影响下一个字段
          await run(`(() => { document.querySelectorAll('.wea-browser-modal .ant-modal-close, .wea-browser-modal button').forEach(b => { if ((b.innerText||'').trim() === '取 消') b.click(); }); return true; })()`, f.fieldname + ':close');
          await new Promise(r => setTimeout(r, 600));
        } catch (e) {
          report.dialogs[f.fieldname] = { error: String(e?.message ?? e) };
        }
      }
    }
    report.elapsed_ms = Date.now() - t0;
    return report;
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('oa-explore-form.mjs')) {
  const flag = n => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const report = await exploreForm({
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    openDialogs: process.argv.includes('--open-dialogs'),
    onEvent: v => process.stderr.write(`${JSON.stringify(v)}\n`)
  });
  const out = flag('--out') ?? 'D:/github.com/window10GUI/src/DeskPilot.Flow/.explore-report.json';
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify({ event: 'explore.done', out, fields: report.fields?.length, dialogs: Object.keys(report.dialogs), elapsed_ms: report.elapsed_ms })}\n`);
}
