/*
 * OA UIH-01 采购申请单 — 完整填写（不提交）。
 *
 * 为什么不是 Flow 场景 JSON：
 *   场景词汇表只有 8 个动作（ensure/attach/navigate/fill/select/click/query/wait），
 *   无法表达本表单需要的：自定义下拉的展开-选值、关联搜索弹窗的"输入→搜索→选行"、
 *   以及"直接改 value 会被框架还原、必须走原生输入路径"这一类页面适配。
 *   这些只能通过 chrome.evaluate 的页面内脚本完成，所以本文件是宿主脚本，不是场景。
 *
 * 已实测的选择器与坑（全部来自真实页面观察，非推测）：
 *   - 文本字段：#requestname #field68003 #field68031 #field84777 #field68006
 *               #field68028 #field68021 #field68022
 *   - 自定义下拉：采购类型=weaSelect_1  项目节点=weaSelect_3  组合管理分类=weaSelect_4
 *     坑：多个下拉的选项会累积在 DOM 里，必须限定到"当前可见"的那个 .ant-select-dropdown，
 *         否则会点到别的 select 的选项。
 *   - 关联搜索弹窗：工厂=#field68033span  项目号=#field68007span
 *     坑：弹窗异步渲染，必须等 .wea-browser-modal 出现；点按钮要命中 .ant-btn 本身。
 *   - 明细行新增：**#addbutton0**（点外层 div 无效 —— div 上挂的 handler 是 i 元素自己的）
 *   - 文本赋值：直接 set value 会被 OA 框架还原，必须逐字符走 execCommand('insertText')。
 *
 * 必填字段（页面 .wf-input-required / .wea-required-e9 实测）：
 *   标题、联系电话、采购类型、工厂、项目号、经费属性、加签人、申请原因、field84777
 */
import { DeskPilotTransport } from './transport.mjs';

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';

// ---- 页面内公共工具（每个脚本片段都会内联，因为 evaluate 之间不共享作用域）----
const PRELUDE = `
  const norm = s => (s || '').replace(/\\s+/g, '').trim();
  const log = [];
  // 逐字符路径用 execCommand('insertText') 会插到"当前焦点元素"上，而不是我们以为的那个。
  // 实测后果：给供应商字段打字时，字符落进了采购需求说明 textarea；
  // 项目号搜索的文字也串进了 field84777。改用 setter + 完整事件序列，
  // 每次写完立刻回读确认，不依赖焦点。
  const typeInto = (el, text) => {
    if (!el) return 'missing';
    const t = String(text);
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    const setRaw = v => { if (d && d.set) d.set.call(el, v); else el.value = v; };
    setRaw(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: t, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
    if (el.value === t) return 'ok';
    // 有些字段（实测 field68021/68022）会被框架还原。逐字符补齐：
    // 每次只追加一个字符并立即回读，因此不需要依赖焦点，也不会串到别的字段。
    setRaw('');
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    let built = '';
    for (const ch of t) {
      built += ch;
      setRaw(built);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
      if (el.value !== built) { built = el.value; }
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
    return el.value === t ? 'ok' : ('mismatch:' + el.value);
  };
  const pickFromVisibleDropdown = (label) => {
    const drops = Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(d => {
      const r = d.getBoundingClientRect();
      const s = getComputedStyle(d);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    for (const d of drops) {
      const el = Array.from(d.querySelectorAll('.ant-select-dropdown-menu-item, .ant-select-item-option'))
        .find(li => norm(li.innerText) === norm(label));
      if (el) { el.click(); return 'ok'; }
    }
    return 'not_found(' + drops.length + ' dropdowns)';
  };
`;

function script(body) {
  return `(() => {${PRELUDE}${body}\n})()`;
}

// ---- 各步骤的页面内脚本 ----
const STEPS = {
  text: script(`
    const targets = {
      requestname: 'UIH-01 采购申请单(上海联影)-SAP-DeskPilot功能验证',
      field68003: '18800107100',
      field68031: '张成',
      field68006: 'DeskPilot 功能验证 - 采购申请单自动填写',
      field68028: 'DeskPilot 功能验证，不用于真实采购。'
    };
    for (const id of Object.keys(targets)) log.push(id + '=' + typeInto(document.getElementById(id), targets[id]));
    return log;
  `),

  // 供应商两字段只有在"指定供应商"选中后才可写，所以必须排在 radio 之后。
  supplier: script(`
    const targets = {
      field68021: '上海逸赫自动化设备有限公司',
      field68022: '复购特殊设备。'
    };
    for (const id of Object.keys(targets)) log.push(id + '=' + typeInto(document.getElementById(id), targets[id]));
    return log;
  `),

  radio: script(`
    const wanted = ['指定供应商','无IT类采购','非化学品','用于型式检测样机或临床样机',
                    '有固定资产/无形资产/在建工程','固资存放公司内部'];
    const wrappers = Array.from(document.querySelectorAll('label.ant-radio-wrapper'));
    for (const text of wanted) {
      const w = wrappers.find(l => norm(l.innerText) === norm(text));
      if (!w) { log.push('radio:' + norm(text).slice(0,6) + '=not_found'); continue; }
      const r = w.querySelector('input[type=radio]');
      if (!r) { log.push('radio:' + norm(text).slice(0,6) + '=no_input'); continue; }
      if (r.disabled) { log.push('radio:' + norm(text).slice(0,6) + '=disabled'); continue; }
      r.click();
      log.push('radio:' + norm(text).slice(0,6) + '=' + (r.checked ? 'ok' : 'unchecked'));
    }
    return log;
  `),

  openSelect1: script(`
    const w = document.getElementById('weaSelect_1');
    const s = w && w.querySelector('.ant-select');
    if (!s) return ['no_select'];
    s.click();
    return ['opened'];
  `),

  pickCommon: script(`return [pickFromVisibleDropdown('普通')];`),
  pickNode: script(`return [pickFromVisibleDropdown('G1之前')];`),
  openSelect3: script(`
    const w = document.getElementById('weaSelect_3');
    const s = w && w.querySelector('.ant-select');
    if (!s) return ['no_select'];
    s.click();
    return ['opened'];
  `),
  openSelect4: script(`
    const w = document.getElementById('weaSelect_4');
    const s = w && w.querySelector('.ant-select');
    if (!s) return ['no_select'];
    s.click();
    return ['opened'];
  `),
  pickCategory: script(`return [pickFromVisibleDropdown('产品开发')];`),

  openFactory: script(`
    const span = document.getElementById('field68033span');
    const btn = span && span.querySelector('.ant-btn, button');
    if (!btn) return ['no_button'];
    btn.click();
    return ['opened'];
  `),
  pickFactoryRow: script(`
    const modal = document.querySelector('.wea-browser-modal');
    if (!modal) return ['no_modal'];
    const rows = Array.from(modal.querySelectorAll('tbody tr'));
    const row = rows.find(tr => { const t = (tr.innerText||'').replace(/\\s+/g,' '); return t.indexOf('-CO') >= 0 && t.indexOf('1206') >= 0; });
    if (!row) return ['row_not_found:' + rows.length];
    const radio = row.querySelector('input[type=radio], input[type=checkbox]');
    (radio || row).click();
    return ['picked'];
  `),

  openProject: script(`
    // 该字段可能已有值（重放时）。先清空隐藏值，确保弹窗按预期打开。
    const hid = document.getElementById('field68007');
    const span = document.getElementById('field68007span');
    const clear = span && span.querySelector('.anticon-close-circle, .ant-select-clear, .anticon-close');
    if (clear) clear.click();
    else if (hid) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hid), 'value'); if (d && d.set) d.set.call(hid, ''); else hid.value = ''; }
    const btn = span && span.querySelector('.ant-btn, button');
    if (!btn) return ['no_button'];
    btn.click();
    return ['opened'];
  `),
  searchProject: script(`
    const modal = document.querySelector('.wea-browser-modal');
    if (!modal) return ['no_modal'];
    const inputs = Array.from(modal.querySelectorAll('input.ant-input'));
    const vis = inputs.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!vis.length) return ['no_input'];
    typeInto(vis[0], '100167003201');
    const btns = Array.from(modal.querySelectorAll('button.ant-btn-primary'));
    const search = btns.find(b => norm(b.innerText) === '搜索');
    if (!search) return ['no_search_btn'];
    search.click();
    return ['searched'];
  `),
  pickProjectRow: script(`
    const modal = document.querySelector('.wea-browser-modal');
    if (!modal) return ['no_modal'];
    const rows = Array.from(modal.querySelectorAll('tbody tr'));
    const row = rows.find(tr => (tr.innerText||'').indexOf('100167003201') >= 0);
    if (!row) return ['row_not_found:' + rows.length];
    const radio = row.querySelector('input[type=radio], input[type=checkbox]');
    (radio || row).click();
    return ['picked'];
  `),

  addRow: script(`
    const btn = document.getElementById('addbutton0');
    if (!btn) return ['no_add_button'];
    btn.click();
    return ['clicked'];
  `),

  verify: script(`
    const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
    const sh = id => { const el = document.getElementById(id); return el ? (el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,28) : null; };
    const cnt = Array.from(document.querySelectorAll('div,td,span')).map(el => norm(el.innerText)).find(t => /^共\\d+条/.test(t));
    return {
      title: g('requestname'), phone: g('field68003'), signer: g('field68031'), f84777: g('field84777'),
      reason: g('field68006'), demand: g('field68028'), sup: g('field68021'), supReason: g('field68022'),
      ptype: sh('weaSelect_1'), pnode: sh('weaSelect_3'), pcat: sh('weaSelect_4'),
      factory: sh('field68033span'), sublib: sh('field68049span'), projno: sh('field68007span'),
      detailCount: cnt || null
    };
  `)
};

export { STEPS };

export async function fillPurchaseRequisition({ executable = DEFAULT_EXECUTABLE, endpoint, onEvent = () => {} } = {}) {
  const transport = new DeskPilotTransport({ executable });
  const results = [];
  // 端点必须显式固定。不固定时 CLI 会连到"第一个可用的调试实例"——
  // 本机上就有一个占着 9229 的 ChatGPT；那样 attach 找不到表单页，
  // 每个字段都读成 missing，看起来像选择器写错。
  const withEndpoint = params => (endpoint ? { ...params, endpoint } : params);
  const run = async (name, expression, opts = {}) => {
    onEvent({ event: 'fill.step', step: name });
    try {
      const r = await transport.request('chrome.evaluate', withEndpoint({ expression, timeout_ms: opts.timeoutMs ?? 25000 }), { timeoutMs: (opts.timeoutMs ?? 25000) + 5000 });
      const value = r?.value;
      results.push({ step: name, ok: true, value });
      return value;
    } catch (error) {
      results.push({ step: name, ok: false, code: error?.code ?? String(error) });
      return null;
    }
  };
  try {
    const attached = await transport.request('chrome.attach', withEndpoint({ url_contains: 'static4form' }), { timeoutMs: 30000 });
    onEvent({ event: 'fill.attached', target_id: attached?.target_id, url: attached?.url });

    await run('text', STEPS.text);
    await run('radio', STEPS.radio);
    await run('supplier', STEPS.supplier);
    await run('openSelect1', STEPS.openSelect1);
    await new Promise(r => setTimeout(r, 900));
    await run('pickCommon', STEPS.pickCommon);
    await run('openSelect3', STEPS.openSelect3);
    await new Promise(r => setTimeout(r, 900));
    await run('pickNode', STEPS.pickNode);
    await run('openSelect4', STEPS.openSelect4);
    await new Promise(r => setTimeout(r, 900));
    await run('pickCategory', STEPS.pickCategory);
    await run('openFactory', STEPS.openFactory);
    await new Promise(r => setTimeout(r, 2500));
    await run('pickFactoryRow', STEPS.pickFactoryRow);
    await run('openProject', STEPS.openProject);
    await new Promise(r => setTimeout(r, 2500));
    await run('searchProject', STEPS.searchProject);
    await new Promise(r => setTimeout(r, 2500));
    await run('pickProjectRow', STEPS.pickProjectRow);
    await run('addRow', STEPS.addRow);
    await new Promise(r => setTimeout(r, 2000));
    const snapshot = await run('verify', STEPS.verify);
    return { results, snapshot };
  } finally {
    await transport.close({ cancel: true, timeoutMs: 3000 }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('fill-purchase-requisition.mjs')) {
  const flag = name => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const out = await fillPurchaseRequisition({
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    onEvent: v => process.stdout.write(`${JSON.stringify(v)}\n`)
  });
  process.stdout.write(`${JSON.stringify({ event: 'fill.done', results: out.results, snapshot: out.snapshot })}\n`);
  process.exitCode = out.results.some(r => !r.ok) ? 2 : 0;
}
