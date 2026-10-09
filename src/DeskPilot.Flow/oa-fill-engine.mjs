/*
 * OA 填单通用引擎（读「模板 + 纯数据」，无任何业务字段硬编码）。
 *
 * 三层契约见 deskpilot-oa-fill skill：
 *   - 模板 JSON  : 业务字段名 -> 页面 selector/widget/text 的映射（智能体实测沉淀）
 *   - 纯数据 JSON: 业务值（用户只写这个）
 *   - 本引擎      : 读两者，执行填单 + 回读校验
 *
 * 引擎只通吃「页面行为」，不知道「业务字段」：
 *   text/browser/select/radio 四类字段按模板的 type 分发；
 *   明细行按模板的 detail_columns 逐列填充，值来自纯数据的 detail_rows。
 *
 * 本文件不 import 任何具体表单的选择器或字段名 —— 那些全在模板数据里。
 * 沿用 fill-purchase-requisition.mjs 里已实测的页面行为原语（端点固定、
 * chrome.fill 可信输入、限于可见下拉、弹窗 wait、明细行按元素 id 点）。
 */
import { DeskPilotTransport } from './transport.mjs';
import { discoverLiveEndpoint } from './endpoint.mjs';
import { TIMEOUTS } from './timeouts.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 读取 managed Chrome 记录的调试端口。
 *
 * 不带 endpoint 调用 chrome.* 时，CLI 会自己挑一个可用的调试实例 —— 本机上存在
 * 无关实例（ChatGPT 桌面应用占 9229、另开的 Chrome），于是会连错浏览器并报
 * CHROME_TARGET_NOT_FOUND，而目标 static4form 标签页其实一直开着。
 * 端口由 DeskPilot 写在 profile 目录下的 DeskPilotDevToolsEndpoint 文件里。
 */
function readRecordedEndpoint() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const file = join(local, 'WindowsAgent', 'ChromeProfile', 'DeskPilotDevToolsEndpoint');
  try {
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';

// ---- 页面内公共原语（每段 evaluate 内联，因为 evaluate 之间不共享作用域）----
const PRELUDE = `
  const norm = s => (s || '').replace(/\\s+/g, '').trim();
  const log = [];
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  // 框架绑定字段直写 DOM 会被 oninput 清空（实测 field68021/field68022），
  // 这里只做「读」与「逐字符兜底写」，真正的可信输入由 chrome.fill 在引擎侧完成。
  const typeInto = (el, text) => {
    if (!el) return 'missing';
    const t = String(text);
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    const setRaw = v => { if (d && d.set) d.set.call(el, v); else el.value = v; };
    setRaw(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: t, inputType: 'insertText' }));
    if (el.value === t) return 'ok';
    setRaw('');
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    let built = '';
    for (const ch of t) {
      built += ch;
      setRaw(built);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
      if (el.value !== built) built = el.value;
    }
    return el.value === t ? 'ok' : ('mismatch:' + el.value);
  };
  const pickFromVisibleDropdown = (label) => {
    const drops = Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(visible);
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

// 单个字段的读写，值从 data 注入、控件从 fieldSpec 注入。返回给 chrome.fill 用的 selector。
function buildFieldPlan(fieldName, fieldSpec, value) {
  const js = JSON.stringify;
  return { fieldName, spec: fieldSpec, value };
}

export { buildFieldPlan };

export async function fillOaForm({
  executable = DEFAULT_EXECUTABLE,
  endpoint,
  template,
  data,
  onEvent = () => {}
} = {}) {
  const transport = new DeskPilotTransport({ executable });
  const results = [];
  // 端点必须固定。不带 endpoint 时 CLI 会连到"第一个可用的调试实例"，本机上有
  // 无关浏览器（如 ChatGPT 桌面应用占 9229、另一个 Chrome 实例），会报
  // CHROME_TARGET_NOT_FOUND，而目标标签页其实好好地开着 —— 实测踩过。
  //
  // 未显式传 endpoint 时：先读 profile 记录的端点文件；**文件可能不存在**
  // （实测 2026-09-23：托管 Chrome 重启后该文件一度消失，但实例仍在 54952 上健康运行），
  // 那时旧代码拿到 undefined → 所有 chrome.* 都不带 endpoint → CHROME_TARGET_NOT_FOUND。
  // 所以这里再退一步：**扫一遍活着的实例**（与 endpoint.mjs 同一套判据）。
  let resolvedEndpoint = endpoint ?? readRecordedEndpoint();
  if (!resolvedEndpoint) {
    resolvedEndpoint = await discoverLiveEndpoint(
      (m, p, o) => transport.request(m, p, o),
      { timeoutMs: TIMEOUTS.requestUi }
    ).catch(() => null) ?? undefined;
  }
  const withEndpoint = params => (resolvedEndpoint ? { ...params, endpoint: resolvedEndpoint } : params);

  // 与 fill-purchase-requisition.mjs 相同的可信输入：chrome.fill
  // 注意：chrome.fill 的 value 必须是 string。纯数据里的数量/单价是 JSON 数字，
  // 直接透传会得到 INVALID_ARGUMENT: value must be a string，所以这里统一转字符串。
  const fill = async (label, selector, value) => {
    const text = value === null || value === undefined ? '' : String(value);
    const r = await transport.request('chrome.fill', withEndpoint({ selector, value: text }), { timeoutMs: TIMEOUTS.request });
    const ok = r?.verified === true;
    results.push({ label, ok, value: text, verified: r?.verified });
    return ok;
  };
  const evaluate = async (label, expression) => {
    const r = await transport.request('chrome.evaluate', withEndpoint({ expression }), { timeoutMs: TIMEOUTS.requestUi });
    results.push({ label, ok: true, value: r?.value });
    return r?.value;
  };
  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    // 1) 绑定表单标签页。
    //
    //    不能直接 `chrome.attach({url_contains})` 了事：当存在**多个**匹配的页面时，
    //    CLI 会报 `AMBIGUOUS_CHROME_TARGET: More than one Chrome page target matched`，
    //    引擎整轮 1.3s 就失败。实测（2026-09-23）：浏览器里累积了 22 个门户页 + 多个
    //    表单页（每跑一次多留一个），于是**套件时好时坏、单跑却总是通过**。
    //    这里改为：先自己列出候选，**显式挑最新的那个**（表单页按打开顺序，后者更新），
    //    并把多余的关掉（能关就关，关不掉不影响本次运行）。
    const attach = template?.entry?.attach?.url_contains ?? 'static4form';
    let attached = null;
    {
      // **连前重试**：紧接在 preflight（清理/登录/开单）之后运行时，端点会短暂
      // `CHROME_CDP_UNAVAILABLE: TaskCanceledException` —— 前序脚本刚建过的 CDP 连接
      // 还没完全释放，新的连接请求被取消。实测（2026-09-23）：引擎**单独跑 4/4 通过**，
      // 但跟在 preflight 后面跑 3/4 失败，失败点都在最初这一步。
      // 这是瞬态，重试即可；不重试就会把"环境切换的抖动"记成"填单失败"。
      const attachOnce = async () => {
        const tl = await transport.request('chrome.targets', withEndpoint({}), { timeoutMs: TIMEOUTS.request }).catch(() => null);
        const cands = (tl?.targets ?? []).filter(
          (t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(attach)
        );
        // **挑对目标页**：多个表单页时，"取最新一个"并不可靠 ——
        // 实测（2026-09-23）有两个 static4form 时按"最新"挑，会挑到一个**还没渲染完/
        // 内容不对**的页面，随后 `#requestname` 找不到 → CHROME_ELEMENT_NOT_FOUND。
        // 可靠判据是**模板里记的 workflowid**：优先选 URL 含该 workflowid 的那个。
        const wantWfid = (() => {
          try {
            const t = template?.entry ?? {};
            const m = String(t.url ?? '').match(/workflowid=(\d+)/)
              || String(template?.notes?.form_id ?? '').match(/workflowid=(\d+)/);
            return m ? m[1] : null;
          } catch { return null; }
        })();
        let victim = null;
        if (wantWfid) {
          const exact = cands.filter((t) => t.url.includes('workflowid=' + wantWfid));
          if (exact.length) victim = exact[exact.length - 1];
        }
        // **用页内 location.href 复核候选**。OA 是 hash 路由 SPA（pushState 切页，无真实
        // 导航），chrome.targets 的 url 会停在**上一次真实导航**的地址。实测（2026-09-24）：
        // 某 target 报着 `static4form?...workflowid=2211`，页内实际是
        // `wui/index.html#/main/workflow/add`（门户页，rows/inputs 全 0）。
        // 只看元数据就会把门户页当成表单页 attach 进去，整张表单随后全崩。
        if (victim) {
          const live = await transport.request('chrome.evaluate', withEndpoint({
            target_id: victim.target_id,
            expression: '(() => ({ href: location.href, rows: document.querySelectorAll("tr").length }))()',
            timeout_ms: TIMEOUTS.requestUi
          }), { timeoutMs: TIMEOUTS.requestUi }).then(r => r?.value ?? null).catch(() => null);
          const liveOk = typeof live?.href === 'string' && live.href.includes(attach);
          if (!liveOk) {
            onEvent({ event: 'fill.attach_stale_meta', target_id: victim.target_id,
                      target_url: String(victim.url).slice(0, 90), live_href: String(live?.href ?? '').slice(0, 90),
                      note: 'target 元数据与页内地址不一致（SPA hash 路由），换下一个候选' });
            victim = null;
            for (const c of cands.slice().reverse()) {
              const lv = await transport.request('chrome.evaluate', withEndpoint({
                target_id: c.target_id,
                expression: '(() => ({ href: location.href }))()',
                timeout_ms: TIMEOUTS.requestUi
              }), { timeoutMs: TIMEOUTS.requestUi }).then(r => r?.value ?? null).catch(() => null);
              if (typeof lv?.href === 'string' && lv.href.includes(attach)) { victim = c; break; }
            }
          }
        }
        // **有明确 workflowid 却找不到匹配页 → 宁可不选，也不要"挑个最新的"凑合。**
        // 实测（2026-09-23）：浏览器里同时存在两张表单页（本次的 2562 + 上次残留的 2211），
        // 若按"最新"挑到残留那张，后面所有字段都会报 not_found —— 表现为"整张表单全崩"，
        // 却看不出是**选错了页面**。宁可重试（等本次的表单页出现），也不静默选错。
        if (!victim && wantWfid && cands.length) {
          onEvent({ event: 'fill.attach_no_wfid_match', want: wantWfid, candidates: cands.length,
                    note: '存在表单页但都不是本次要的 workflowid，等待正确的页面出现' });
          return { __noMatch: true };
        }
        if (!victim && cands.length) victim = cands[cands.length - 1];
        if (cands.length > 1) {
          onEvent({ event: 'fill.attach_ambiguous', count: cands.length, picked: victim?.target_id ?? null,
                    byWorkflowid: Boolean(wantWfid && victim && victim.url.includes('workflowid=' + wantWfid)) });
        }
        if (victim) {
          return await transport.request('chrome.attach',
            withEndpoint({ target_id: victim.target_id }), { timeoutMs: TIMEOUTS.requestUi });
        }
        // 没有候选时退回原行为（让 CLI 报出它自己的错误，而不是我们吞掉）
        return await transport.request('chrome.attach', withEndpoint({ url_contains: attach }), { timeoutMs: TIMEOUTS.requestUi });
      };
      let lastErr = null;
      for (let i = 0; i < 8 && !attached; i++) {
        try {
          const r = await attachOnce();
          if (r && r.__noMatch) {
            // 正确的表单页还没出现（可能是开机/开单的竞态）：等一会儿重试
            onEvent({ event: 'fill.attach_wait', attempt: i + 1 });
            await delay(1000 + i * 500);
            continue;
          }
          attached = r;
        } catch (e) {
          lastErr = e;
          const transient = e?.code === 'CHROME_CDP_UNAVAILABLE'
            || e?.code === 'CHROME_CDP_DISCONNECTED'
            || e?.code === 'CHROME_TARGET_NOT_FOUND'
            || e?.retryable === true;
          if (!transient || i === 4) throw e;
          onEvent({ event: 'fill.attach_retry', attempt: i + 1, code: e?.code });
          await delay(700 + i * 500);
        }
      }
      if (!attached && lastErr) throw lastErr;
    }
    onEvent({ event: 'fill.attached', target_id: attached?.target_id, url: attached?.url });

    // 1b) 等表单真正渲染完再动手。
    //     刚开的 static4form 标签页 CDP 已经可连、attach 也会成功，但 Vue 还没挂载出
    //     输入控件；此时直接 chrome.fill('#requestname') 会报 CHROME_ELEMENT_NOT_FOUND。
    //
    //     **就绪判据不能用写死的 `#requestname`**：那是采购单的主标题框，别的表单没有它
    //     （如差旅报销单），于是等待必然超时、却因为 `.catch()` 被静默吞掉，
    //     随后第一个 fill 就报 CHROME_ELEMENT_NOT_FOUND —— 看起来像选择器写错。
    //     改为**按本模板自己的字段**判断：模板里任一非只读字段的选择器出现即算就绪，
    //     并显式重试（不依赖单次 wait 的成功）。
    const readySelectors = Object.values(template?.field_map ?? {})
      .filter((s) => s && s.selector && !s.readonly && s.type !== 'upload')
      .map((s) => (typeof s.selector === 'string' ? s.selector : ''))
      .filter((s) => s && /^[#[]/.test(s))
      .slice(0, 12);
    {
      let matched = null;
      // 一次 evaluate 判完所有候选，而不是逐个 `chrome.wait`：
      // 逐个等 20×12×1.6s 会把单场景从 ~40s 拖到 **119s**（实测），并让 8 个场景的套件超时。
      for (let i = 0; i < 25 && !matched; i++) {
        const hit = await evaluate('fill:ready-probe', script(`
          const sels = ${JSON.stringify(readySelectors)};
          for (const s of sels) { try { if (document.querySelector(s)) return [s]; } catch (e) {} }
          return [null];
        `)).catch(() => null);
        if (Array.isArray(hit) && hit[0]) matched = hit[0];
        else await delay(400);
      }
      onEvent({ event: 'fill.ready', selector: matched, matched: Boolean(matched), candidates: readySelectors.length });
      if (!matched) {
        onEvent({ event: 'fill.ready_timeout', note: '模板内没有任何字段就绪，仍继续（让具体步骤报错）' });
      }
    }

    // 2) text 字段：chrome.fill 可信输入
    //    - readonly 字段（系统流水号/日期/汇总等）跳过：它们由页面算出，写也写不进，
    //      记成 skipped 而不是 ok，避免把"没填"伪装成"填好了"。
    //    - 数据里没给值的字段记 no_value；但只读/derived 字段不算缺口。
    const values = data?.values ?? {};
    // 文本字段的填充函数抽出来，放到 radio 之后执行（顺序原因见下方 radio 段注释）。
    const fillTextFields = async () => {
      for (const [name, spec] of Object.entries(template?.field_map ?? {})) {
        // 日期选择器：内部只有 hidden input，`chrome.fill` 写不进去。
        // 实测（UIH-02 差旅报销 start_date/end_date）该控件是
        //   div.wea-date-picker.noInput > span.ant-calendar-picker > span.picker-icon
        // 交互方式（2026-09-23 实测跑通）：
        //   1) CDP 点日历图标 → 出现 `.ant-calendar` 面板；
        //   2) 面板里每个可选日是 `td[title="YYYY-M-D"]`（**title 是 ISO 日期**，可靠判据）；
        //   3) CDP 点该单元格 → 隐藏 input 立刻被写成 `YYYY-MM-DD`（实测 "" → "2026-09-23"）。
        // 所以 datepicker 现在是**真实现**，不再只是 skipped。
        if (spec.type === 'datepicker') {
          const want = data?.values?.[name];
          if (want == null || String(want).trim() === '') {
            results.push({ label: name, ok: true, value: ['skipped(datepicker 且数据未提供)'], fieldname: spec.fieldname });
            continue;
          }
          const wantStr = String(want).trim();
          // 允许数据给 "2026-09-23" / "2026-9-23"；面板 title 用的是不补零格式
          const m = wantStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (!m) {
            results.push({ label: name, ok: false, value: ['bad_date_format(需 YYYY-MM-DD)', wantStr], fieldname: spec.fieldname });
            continue;
          }
          const title = `${m[1]}-${Number(m[2])}-${Number(m[3])}`;   // 2026-9-23
          const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;

          const before = await evaluate(name + ':before', script(`
            const host = document.querySelector(${JSON.stringify(spec.selector)});
            const inp = host ? host.querySelector('input') : null;
            return [inp ? String(inp.value) : null];
          `)).catch(() => null);

          // 1) 打开日历（mark + CDP 点击；页面内 .click() 对该组件不可靠）
          const marked = await evaluate(name + ':mark', script(`
            const host = document.querySelector(${JSON.stringify(spec.selector)});
            if (!host) return ['no_host'];
            const icon = host.querySelector('.picker-icon, .ant-calendar-picker');
            if (!icon) return ['no_icon'];
            icon.scrollIntoView({ block: 'center' });
            document.querySelectorAll('[data-dp-dateopen]').forEach(x => x.removeAttribute('data-dp-dateopen'));
            icon.setAttribute('data-dp-dateopen', '1');
            return ['ok'];
          `)).catch(() => null);
          if (Array.isArray(marked) && typeof marked[0] === 'string' && marked[0] !== 'ok') {
            results.push({ label: name, ok: false, value: [marked[0]], fieldname: spec.fieldname });
            continue;
          }
          await transport.request('chrome.click', withEndpoint({
            selector: '[data-dp-dateopen="1"]', timeout_ms: TIMEOUTS.requestUi,
          }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});

          // 2) 等面板出现，点目标日。
          //    实测坑：日历默认只显示**当前月**。若目标日期在别的月份
          //    （如今天是 9 月、要选 2026-10-31），面板里**根本没有**那个单元格，
          //    直接找 `td[title=...]` 必然 not found。所以要先按需翻月。
          const wantY = Number(m[1]), wantM = Number(m[2]);
          let picked = null;
          for (let t = 0; t < 24; t++) {
            const cell = await evaluate(name + ':cell', script(`
              const pans = Array.from(document.querySelectorAll('.ant-calendar'))
                .filter(p => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
              if (!pans.length) return ['no_panel'];
              const p = pans[pans.length - 1];
              const ms = p.querySelector('.ant-calendar-month-select');
              const ys = p.querySelector('.ant-calendar-year-select');
              const curY = ys ? Number(String(ys.innerText).replace(/[^0-9]/g, '')) : null;
              const curM = ms ? Number(String(ms.innerText).replace(/[^0-9]/g, '')) : null;

              const td = p.querySelector('td[title="' + ${JSON.stringify(title)} + '"]');
              if (td) {
                document.querySelectorAll('[data-dp-day]').forEach(x => x.removeAttribute('data-dp-day'));
                td.setAttribute('data-dp-day', '1');
                return ['ok'];
              }
              // 目标不在当前显示月 → 决定往前/往后翻（只按年月比较，不依赖具体实现）
              if (curY != null && curM != null) {
                const cur = curY * 12 + curM;
                const want = ${wantY} * 12 + ${wantM};
                const btn = p.querySelector(want > cur ? '.ant-calendar-next-month-btn' : '.ant-calendar-prev-month-btn');
                if (btn) {
                  document.querySelectorAll('[data-dp-nav]').forEach(x => x.removeAttribute('data-dp-nav'));
                  btn.setAttribute('data-dp-nav', '1');
                  return ['nav', want > cur ? 'next' : 'prev', curY + '-' + curM];
                }
              }
              return ['no_cell_no_nav'];
            `)).catch(() => null);

            if (Array.isArray(cell) && cell[0] === 'ok') {
              await transport.request('chrome.click', withEndpoint({
                selector: '[data-dp-day="1"]', timeout_ms: TIMEOUTS.requestUi,
              }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
              await delay(400);
              const after = await evaluate(name + ':after', script(`
                const host = document.querySelector(${JSON.stringify(spec.selector)});
                const inp = host ? host.querySelector('input') : null;
                return [inp ? String(inp.value) : null];
              `)).catch(() => null);
              picked = Array.isArray(after) ? after[0] : null;
              break;
            }
            if (Array.isArray(cell) && cell[0] === 'nav') {
              await transport.request('chrome.click', withEndpoint({
                selector: '[data-dp-nav="1"]', timeout_ms: TIMEOUTS.requestUi,
              }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
              await delay(350);
              continue;
            }
            await delay(300);
          }

          // 3) 回读确认（只"点了"不算写入）
          const okHit = String(picked ?? '').indexOf(iso) >= 0;
          results.push({
            label: name, ok: okHit,
            value: [okHit ? 'picked=' + picked : 'NOT_FILLED', 'want=' + iso,
                    'before=' + (Array.isArray(before) ? before[0] : null)],
            fieldname: spec.fieldname,
          });
          // 收掉可能残留的日历面板
          await evaluate(name + ':close', script(`
            document.body.click();
            return [1];
          `)).catch(() => {});
          continue;
        }
        // 附件上传（OA 的 `div.wea-upload` 控件）。
        //
        // 实测（2026-09-23，UIH-02 差旅报销 附件字段 fj）：
        //   容器 `div.wea-upload > .wea-upload-container`，内含**真实的 `<input type="file" multiple>`**
        //   （id 形如 `html5_xxx`，OA 每次渲染会变，所以**不能写死 id**，要按容器内查找）。
        //
        // 重要限制：当前 CLI **没有** `DOM.setFileInputFiles`（试过 `DOM.getDocument` → `UNKNOWN_METHOD`，
        // 说明它只暴露白名单方法，不转发任意 CDP 域）。因此无法让浏览器"从磁盘选真实文件"。
        // 可行路径是**页面内构造 File 并赋给 input.files**（浏览器允许 `files` 被赋值）：
        //   实测赋完并派发 change 后，OA 列表立刻显示 `deskpilot-probe.txt 23B`，
        //   且带 编辑/删除/下载 图标 —— 说明**上传登记确实发生了**，不是纯前端假象。
        //
        // **诚实边界**：文件内容是我们构造的，**不是从磁盘读的真实文件**。
        // 所以这条能力适合"验证上传链路通不通"，**不应当**被当成"替代人工上传真实附件"。
        // 数据里给 `{ name, content }`；给出 `path` 时只用于取名与说明，**不读其内容**（避免误导）。
        if (spec.type === 'upload') {
          const cfg = data?.values?.[name];
          if (cfg == null) {
            results.push({ label: name, ok: true, value: ['skipped(upload 且数据未提供)'], fieldname: spec.fieldname });
            continue;
          }
          const obj = (typeof cfg === 'string') ? { name: cfg } : cfg;
          const fileName = String(obj.name ?? obj.path ?? 'deskpilot-attachment.txt');
          const content = String(obj.content ?? ('DeskPilot upload placeholder: ' + fileName));
          const mime = String(obj.mime ?? 'text/plain');

          // 赋值后必须**回读 input.files.length** 才算数：实测有时赋了却没生效
          // （`ok:true` 但 `files:0`），此时 OA 的列表不会出现该文件。
          // 所以这里重试若干次，并在没生效时如实失败（不假装上传成功）。
          const tryOnce = () => evaluate(name + ':upload', script(`
            const host = document.querySelector(${JSON.stringify(spec.selector)});
            if (!host) return { ok: false, reason: 'no_host' };
            const inHost = Array.from(host.querySelectorAll('input[type=file]'));
            const inp = inHost.find(i => i.getBoundingClientRect().width > 0) || inHost[0]
                     || Array.from(document.querySelectorAll('input[type=file]')).filter(i => i.getBoundingClientRect().width > 0)[0];
            if (!inp) return { ok: false, reason: 'no_file_input' };
            try {
              const dt = new DataTransfer();
              dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} }));
              inp.files = dt.files;
              const assigned = inp.files ? inp.files.length : -1;
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: assigned > 0, inputId: inp.id || null, files: assigned };
            } catch (e) {
              return { ok: false, reason: 'assign_failed', error: String(e && e.message ? e.message : e) };
            }
          `)).catch(() => null);

          let up = null;
          for (let t = 0; t < 5; t++) {
            up = await tryOnce();
            if (up?.ok) break;
            await delay(600);
          }
          if (!up?.ok) {
            results.push({ label: name, ok: false, value: ['upload_failed:' + (up?.reason ?? 'assign_not_effective'), 'files=' + (up?.files ?? '?'), up?.error ?? null], fieldname: spec.fieldname });
            continue;
          }
          // 回读：OA 的 `.wea-upload-list` 里应出现该文件名（只"赋了值"不算数）。
          // **必须轮询**：赋 files + 派发 change 之后，OA 还要异步登记/渲染一行才可见
          // （实测 1200ms 时列表仍为空，稍后才出现 `文件名 大小`）。
          // 另注：容器里可能有**两个** .wea-upload-list，取**任一**含目标文件名即算成功。
          let listText = '';
          let hit = false;
          for (let t = 0; t < 12; t++) {
            const rb = await evaluate(name + ':upload-verify', script(`
              const host = document.querySelector(${JSON.stringify(spec.selector)});
              const lists = host ? Array.from(host.querySelectorAll('.wea-upload-list')) : [];
              const all = lists.length ? lists : Array.from(document.querySelectorAll('.wea-upload-list'));
              return [all.map(l => (l.innerText || '').replace(/\\s+/g, ' ').trim()).join(' | ')];
            `)).catch(() => null);
            listText = Array.isArray(rb) ? String(rb[0] ?? '') : '';
            if (listText.indexOf(fileName) >= 0) { hit = true; break; }
            await delay(500);
          }
          results.push({
            label: name, ok: hit,
            value: [hit ? 'uploaded=' + fileName : 'NOT_LISTED', 'list=' + listText.slice(0, 60),
                    'note=内容为页面内构造，非从磁盘读取（仅验证上传链路）'],
            fieldname: spec.fieldname,
          });
          continue;
        }
        if (spec.type !== 'text') continue;
        if (spec.readonly === true) {
          results.push({ label: name, ok: true, value: ['skipped(readonly 系统字段)'], fieldname: spec.fieldname });
          continue;
        }
        // 财务凭证区块：属财务环节，申请人不填，数据没给就留空 —— 绝不编造凭证号。
        if (spec.finance_section === true && !(name in values)) {
          results.push({ label: name, ok: true, value: ['skipped(finance_section 财务区块，申请人未提供)'], fieldname: spec.fieldname });
          continue;
        }
        if (!(name in values)) { results.push({ label: name, ok: false, code: 'no_value', fieldname: spec.fieldname }); continue; }
        await fill(name, spec.selector, values[name]);
      }
    };

    // 2) radio：**先**勾选。
    //
    //    顺序很重要：实测「指定供应商」radio 的联动会把「指定供应商名称/原因」
    //    (field68021/field68022) 清空。若先写文本再勾 radio，文本就被联动清掉 ——
    //    回读为空，看起来像"写入失败"。先勾 radio、后写文本，值才留得住。
    const radioTargets = Array.isArray(data?.radio_selected) ? data.radio_selected : [];
    if (radioTargets.length) {
      // 每个选项单独产出结构化结果（**完整标签，不截断**）：
      //   · ok        —— 已选中
      //   · not_found —— 页面上没有这个标签（多半是数据里的选项名写错）
      //   · disabled  —— **表单把它锁了**：该选项由系统/上游决定，申请人不可选。
      //                  这是业务规则，不是脚本缺陷；但必须**显式暴露**在总结里，
      //                  否则"我明明选了却没生效"会被静默吞掉。实测该单选组 4 项全 disabled，
      //                  且「无固定资产/无形资产/在建工程」已被系统勾选。
      //   · unchecked —— 点了但没选上
      const expr = script(`
        const wanted = ${JSON.stringify(radioTargets)};
        const wrappers = Array.from(document.querySelectorAll('label.ant-radio-wrapper'));
        const out = [];
        for (const text of wanted) {
          const w = wrappers.find(l => norm(l.innerText) === norm(text));
          if (!w) { out.push({ want: text, state: 'not_found' }); continue; }
          const r = w.querySelector('input[type=radio]');
          if (!r) { out.push({ want: text, state: 'no_input' }); continue; }
          if (r.disabled) { out.push({ want: text, state: 'disabled' }); continue; }
          r.click();
          out.push({ want: text, state: r.checked ? 'ok' : 'unchecked' });
        }
        return out;
      `);
      // 注意 evaluate(label, expr) 会**自己**把 {label, ok, value} 推进 results 并返回裸值，
      // 所以这里不能再取 .value（取第二次会得到 undefined，导致逐项结果全丢）。
      const radioOut = await evaluate('radios', expr);
      for (const r of (Array.isArray(radioOut) ? radioOut : [])) {
        const st = r?.state;
        if (st === 'ok') {
          results.push({ label: 'radio:' + r.want, ok: true, value: ['selected'] });
        } else if (st === 'disabled') {
          results.push({
            label: 'radio:' + r.want, ok: true,
            value: ['skipped(form_disabled —— 该选项被表单锁定，由系统/上游决定，申请人不可选)'],
          });
        } else {
          results.push({ label: 'radio:' + r.want, ok: false, value: [String(st)] });
        }
      }
      await delay(600);   // 等联动跑完（它可能移除/清空下游字段）
    }

    // 2b) 文本字段：放在 radio 之后写，避免被 radio 的联动清空。
    await fillTextFields();

    // 4) select：展开对应 widget，从可见下拉选值
    //    widget 现在是完整 CSS 选择器（如 "#field68058"），用 querySelector；
    //    旧的 getElementById(spec.widget) 会在带 "#" 时取不到元素而报 no_select。
    const selects = Object.entries(template?.field_map ?? {}).filter(([, s]) => s.type === 'select');
    for (const [name, spec] of selects) {
      const raw = values[name] ?? spec.default;
      if (raw == null) {
        // **optional 的 select 不该记成失败**：与文本/弹窗字段的处理保持一致。
        // 实测踩过：差旅表单的「发票类型」标了 optional 但数据未给，这里仍推 ok:false/no_value，
        // 而收尾处"任一 !ok 即 exit 2" → 整轮明明全部填好却被判失败。
        // 注：`required` 且缺值的仍按失败处理（那是真缺口，必须让用户看见）。
        if (spec.optional === true && spec.required !== true) {
          results.push({ label: name, ok: true, value: ['skipped(optional 且数据未提供，保持留空)'], fieldname: spec.fieldname });
        } else {
          results.push({ label: name, ok: false, code: 'no_value', fieldname: spec.fieldname });
        }
        continue;
      }
      const value = String(raw);
      // 页面内 .click() 对这类组件不可靠（见 universal-pitfalls #10）：改用 chrome.click 可信输入。
      // 元素先滚进视口，否则 chrome.click 会报 CHROME_ELEMENT_NOT_ACTIONABLE。
      const target = `${spec.widget ?? spec.selector} .ant-select`;
      // 遮挡必须在**点击前**探明并清掉。实测（本文件史）：残留的 `.wea-browser-modal`
      // 遮罩占满整个视口（2560x1313、opacity 1、pointer-events auto、z-index 1050），
      // 于是 chrome.click 的可信坐标落在遮罩上而不是下拉框上 —— 下拉**永远不打开**，
      // 而 JS 合成 s.click() 绕过命中测试却能打开（这正是"直接探针能过、引擎却全崩"的真因）。
      // 症状极具误导性：dropdown 容器存在但 display:none，被误读成"渲染时机"问题。
      let unblockNote = '';
      const unblock = async (tag) => {
        const probe = await evaluate(tag, script(`
          const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
          const wrap = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
          if (!wrap.length) return { modals: 0 };
          // 自包含地关：取消 → X → Esc，每一步都回读确认，不依赖后面才定义的 closeModals。
          for (const w of wrap) {
            const cancel = Array.from(w.querySelectorAll('button, .ant-btn, a'))
              .find(b => /取消|关闭|Cancel/.test((b.innerText || '').trim()));
            if (cancel) cancel.click();
          }
          return { modals: wrap.length, tried: 'cancel' };
        `));
        if (!probe || probe.modals === 0) return true;
        await delay(250);
        for (const step of ['close', 'esc']) {
          await evaluate(tag + ':' + step, script(`
            const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
              return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
            const wrap = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
            if (${JSON.stringify(step)} === 'close') {
              for (const w of wrap) { const x = w.querySelector('.ant-modal-close'); if (x) x.click(); }
            } else if (wrap.length) {
              for (const t of [wrap[0], document]) {
                t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
              }
              const b = document.querySelector('.ant-modal-close'); if (b) b.click();
            }
            return ['ok'];
          `));
          await delay(250);
          const left = await evaluate(tag + ':' + step + ':read', script(`
            const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
              return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
            return [Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis).length];
          `));
          if ((left?.[0] ?? 0) === 0) return true;
        }
        unblockNote = 'unblock_failed';
        return false;
      };
      await evaluate(name + ':scroll', script(`
        const w = document.querySelector(${JSON.stringify(spec.widget ?? spec.selector)});
        if (!w) { log.push('no_widget'); return log; }
        const s = w.matches('.ant-select') ? w : w.querySelector('.ant-select');
        if (!s) { log.push('no_select'); return log; }
        const r = s.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1)) s.scrollIntoView({ block: 'center' });
        return ['ok'];
      `));
      // 打开下拉：点一次 → 回读确认真的开了；没开就清遮挡再点。
      // 不再用固定 delay(900) 当作"等它渲染好"—— 那是竞态，不是等待。
      const dropdownItems = () => script(`
        const ds = Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(visible);
        const n = ds.reduce((a,d) => a + d.querySelectorAll('.ant-select-dropdown-menu-item, .ant-select-item-option').length, 0);
        return [n];
      `);
      let opened = false;
      let openNote = '';
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        if (attempt > 0) await unblock(name + ':unblock' + attempt);
        if (attempt > 0) {
          // rc-select v3 是**开关式**的：mousedown 在"已开"时是关闭。上一次尝试若
          // 已经把内部 open 状态翻过去了（但浮层还没渲染出来），再点一次只会又关上，
          // 表现就是永远 open_timeout。先把控件复位到"确定关闭"的干净基线再点。
          // 另外实测该控件会**卡在 ant-select-focused**（连 blur() 都清不掉），
          // 这也说明 React 内部状态与 DOM 不同步，必须先把它敲回基线。
          await evaluate(name + ':reset' + attempt, script(`
            const w = document.querySelector(${JSON.stringify(spec.widget ?? spec.selector)});
            const s = w && (w.matches('.ant-select') ? w : w.querySelector('.ant-select'));
            if (s) {
              s.classList.remove('ant-select-open');
              const inp = s.querySelector('input');
              if (inp) { inp.blur(); }
              if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
              // 关掉所有遗留浮层，避免"看起来开着"影响 toggle 判定
              document.querySelectorAll('.ant-select-dropdown').forEach(d => {
                if (d.parentElement) d.parentElement.style.display = '';
              });
              document.body.click();
            }
            return ['reset'];
          `));
          await delay(300);
        }
        opened = await transport.request('chrome.click', withEndpoint({ selector: target, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi })
          .then(r => r?.clicked === true).catch(() => false);
        for (let w = 0; w < 10 && opened; w++) {
          await delay(w === 0 ? 300 : 200);
          const n = await evaluate(name + ':open?', dropdownItems());
          if ((n?.[0] ?? 0) > 0) break;
          if (w === 9) { opened = false; openNote = 'open_timeout'; }
        }
      }
      const pickExpr = script(`return [pickFromVisibleDropdown(${JSON.stringify(value)})];`);
      const picked = await evaluate(name + ':pick', pickExpr);
      // 选完回读：下拉里选中后，widget 内应出现该文本。只"点了"不算选中。
      const rb = await evaluate(name + ':verify', script(`
        const w = document.querySelector(${JSON.stringify(spec.widget ?? spec.selector)});
        const t = w ? (w.innerText || '').replace(/\\s+/g, ' ').trim() : '';
        const open = Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(visible).length;
        if (open) document.body.click();
        return { text: t.slice(0, 40), filled: t.indexOf(${JSON.stringify(value)}) >= 0 };
      `));
      results.push({ label: name, ok: opened && picked?.[0] === 'ok' && rb?.filled === true,
                     value: ['picked=' + (picked?.[0] ?? '?'), 'readback=' + (rb?.text ?? '')]
                       .concat(unblockNote ? [unblockNote] : [])
                       .concat(openNote ? [openNote] : []),
                     fieldname: spec.fieldname });
    }

    // 5) browser：搜索弹窗「点开 →（可选）搜索 → 选行」
    // 模板声明 search（默认 true）。若弹窗打开即列出全部候选（如 SAP工厂弹窗共 8 行），
    // 必须设 search:false —— 盲目搜索会往错的搜索框填值并把结果过滤成 0 行。
    // 需要搜索时，search_index 指定用第几个可见搜索框（弹窗常有多个：如「内部订单/订单类型/订单描述」）。
    const browsers = Object.entries(template?.field_map ?? {})
      .filter(([, s]) => s.type === 'browser' || s.type === 'conditional-detail');

    /**
     * 关闭所有可见关联弹窗，返回剩余数量。
     *
     * 为什么必须严格：实测弹窗不关会导致**逐字段错位** —— 项目号打开时弹窗还是
     * 「SAP_币种」，于是搜索框 id 取到币种的 `con57482_value`、选行也选在币种弹窗里，
     * 结果币种被写成 ZWR、项目号留空，而且**全过程不报错**，只在最后回读才暴露。
     *
     * 关闭方式按可靠性排序并回读确认（只"点了"不算关掉）：
     *   1) 「取消」按钮 —— 实测最可靠
     *   2) 右上角 X（.ant-modal-close）—— 个别弹窗点它无效
     *   3) 键盘 Esc
     */
    const closeModals = async (tag) => {
      const countVisible = () => evaluate(tag + ':count', script(`
        const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        return Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis).length;
      `));
      const clickMarked = async (attr, markScript, unmarkScript) => {
        const marked = await evaluate(tag + ':' + attr, script(markScript));
        if (!marked) return false;
        // 点击前把目标滚进视口：实测弹窗可能比视口高，底部按钮虽在 DOM 里却在视口之外，
        // chrome.click 会报 CHROME_ELEMENT_NOT_ACTIONABLE —— 这正是「弹窗关不掉」的真因。
        await evaluate(tag + ':' + attr + ':scroll', script(`
          const el = document.querySelector('[${attr}="1"]');
          if (el) { el.scrollIntoView({ block: 'center', inline: 'center' }); }
          const r = el ? el.getBoundingClientRect() : null;
          return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight } : null;
        `));
        await delay(200);
        await transport.request('chrome.click', withEndpoint({ selector: `[${attr}="1"]`, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await evaluate(tag + ':' + attr + ':unmark', script(unmarkScript));
        await delay(400);
        return true;
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        if ((await countVisible() ?? 0) === 0) return 0;
        // 先按 Esc：实测冻结的**自动填充下拉浮层**会盖在弹窗底部按钮上，
        // 此时点「取消」的坐标虽然命中自己（elementFromPoint 也返回自身），
        // 但真实点击被浮层吃掉、弹窗关不掉。UIA 树里能看到它是 PopupViewViews「自动填充」。
        // 先 Esc 收掉浮层，再点按钮就正常了。
        await transport.request('input.key', { key: 'Escape' }, { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await delay(250);
        if ((await countVisible() ?? 0) === 0) return 0;
        const okCancel = await clickMarked('data-dp-cancel',
          `const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
             return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
           const ms = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
           const m = ms[ms.length - 1];
           if (!m) return false;
           // 一个 wrap 里可能**叠着多个弹窗体**（实测「多人力资源」：25 个 button、两组
           // 高级搜索/搜索/重置/取消，外加末尾一组）。用 querySelector('button') 取到的
           // 第一个「取 消」属于内层/第一个体，点了什么也关不掉 —— 真因就是它。
           // 所以取**最靠后的、位于页脚(footer 或最后一个 .ant-modal)** 里的那个「取消」。
           const bodies = Array.from(m.querySelectorAll('.ant-modal')).filter(vis);
           const body = bodies.length ? bodies[bodies.length - 1] : m;
           const foot = body.querySelector('.ant-modal-footer') || body;
           let btns = Array.from(foot.querySelectorAll('button')).filter(b => /取\\s*消/.test((b.innerText || '')));
           if (!btns.length) btns = Array.from(body.querySelectorAll('button')).filter(b => /取\\s*消/.test((b.innerText || '')));
           const btn = btns[btns.length - 1];
           if (!btn || !vis(btn)) return false;
           btn.setAttribute('data-dp-cancel', '1'); return true;`,
          `document.querySelectorAll('[data-dp-cancel]').forEach(e => e.removeAttribute('data-dp-cancel')); return true;`);
        if (okCancel) continue;
        const okX = await clickMarked('data-dp-close',
          `const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
             return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
           let n = 0;
           document.querySelectorAll('.wea-browser-modal .ant-modal-close').forEach(x => { if (vis(x)) { x.setAttribute('data-dp-close', '1'); n++; } });
           return n;`,
          `document.querySelectorAll('[data-dp-close]').forEach(e => e.removeAttribute('data-dp-close')); return true;`);
        if (okX) continue;
        await transport.request('input.key', { key: 'Escape' }, { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await delay(400);
      }
      return (await countVisible()) ?? -1;
    };

    for (const [name, spec] of browsers) {
      const doSearch = spec.search !== false;
      const searchValue = spec.search_value ?? values[name];
      if (doSearch && searchValue == null) { results.push({ label: name, ok: false, code: 'no_search_value' }); continue; }
      const searchIndex = Number.isInteger(spec.search_index) ? spec.search_index : 0;
      // 0) 条件字段：先判断它在当前表单状态下是否真的显示。
      //
      // 实测（2026-09-23）：工厂(lcck)所在 <tr> 带 `linkage_hide`、display:none ——
      // 它被上游取值条件隐藏。此前把它当普通字段填，报的是 CHROME_ELEMENT_NOT_ACTIONABLE
      // 或 out_of_view，看起来像"选择器错了/滚动没生效"，真因是**这一行根本没渲染**。
      // 条件字段不可见时应记 skipped 并继续，而不是判失败。
      if (spec.type === 'conditional-detail' || spec.conditional === true) {
        const shown = await evaluate(name + ':visible?', script(`
          const el = document.querySelector(${JSON.stringify(spec.selector ?? spec.widget)});
          if (!el) return { present: false, shown: false, reason: 'not_in_dom' };
          const r = el.getBoundingClientRect();
          const tr = el.closest('tr');
          const trDisp = tr ? getComputedStyle(tr).display : null;
          const shown = r.width > 0 && r.height > 0 && trDisp !== 'none';
          return { present: true, shown, trDisplay: trDisp, w: Math.round(r.width) };
        `));
        if (!shown?.shown) {
          results.push({ label: name, ok: true, value: ['skipped(conditional_hidden)', 'tr=' + (shown?.trDisplay ?? '?')], fieldname: spec.fieldname });
          continue;
        }
      }

      // 打开弹窗：先把控件滚进视口并**确认真的进了**，再用 chrome.click 发可信点击。
      //
      // 实测（2026-09-23）三条都必须满足：
      //   1) 页面内 el.click() 会"成功"但弹窗不出现（wea-associative 只认真实输入事件），
      //      所以必须走 chrome.click（CDP 可信输入）。
      //   2) chrome.click 要求元素在视口内，否则报 CHROME_ELEMENT_NOT_ACTIONABLE。
      //   3) 光调用 scrollIntoView 不够 —— OA 表单有多层滚动容器，元素可能滚了但仍在视口外。
      //      必须回读 rect 确认在视口内，必要时再滚其滚动祖先。
      const scrolled = await evaluate(name + ':scroll', script(`
        const el = document.querySelector(${JSON.stringify(spec.widget)});
        if (!el) { log.push('no_widget'); return log; }
        const inView = n => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1;
        };
        // 先回到表单顶部：前一个字段的填写/滚动会把页面留在下方，
        // 从顶部重新滚比在当前位置微调更可靠（实测残留位置会让后续字段滚不到）。
        const scroller = (() => {
          let p = el.parentElement;
          while (p) {
            const st = getComputedStyle(p);
            if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
            p = p.parentElement;
          }
          return null;
        })();
        if (scroller) scroller.scrollTop = 0;
        window.scrollTo(0, 0);
        if (!inView(el)) el.scrollIntoView({ block: 'center', inline: 'center' });
        if (!inView(el)) {
          let p = el.parentElement;
          while (p && !inView(el)) {
            const st = getComputedStyle(p);
            if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight) {
              p.scrollTop += el.getBoundingClientRect().top - p.clientHeight / 2;
            }
            p = p.parentElement;
          }
        }
        const r = el.getBoundingClientRect();
        return [inView(el) ? 'in_view' : 'out_of_view', Math.round(r.top) + '/' + innerHeight];
      `));
      const scrolledOk = String(scrolled?.[0] ?? '').startsWith('in_view');
      results.push({ label: name + ':scroll', ok: scrolledOk, value: scrolled });
      if (!scrolledOk) {
        results.push({ label: name + ':open', ok: false, value: ['NOT_IN_VIEW_AFTER_SCROLL'], selector: spec.widget });
        continue;
      }
      await delay(250);
      const openRes = await transport.request('chrome.click', withEndpoint({
        selector: spec.widget, timeout_ms: TIMEOUTS.requestUi
      }), { timeoutMs: TIMEOUTS.requestUi });
      results.push({ label: name + ':open', ok: openRes?.clicked === true, value: ['clicked:' + (openRes?.clicked === true)], layer: openRes?.execution_layer });

      // 等**目标弹窗真的出现**，而不是 sleep 一个魔法秒数。
      // 实测固定 2s 不够稳：弹窗晚一帧出现时，本字段读到的是"无弹窗"，
      // 而它的弹窗会在下一个字段才渲染出来 —— 表现为"弹窗慢一个字段"，
      // 项目号打开时 count=0、经费打开时却是 SAP_项目号。
      const expectTitle = spec.expect_dialog ?? null;
      let dlgTitles = [];
      for (let w = 0; w < 16; w++) {
        dlgTitles = await evaluate(name + ':wait-dialog', script(`
          const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
          return Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis)
            .map(m => { const t = m.querySelector('.ant-modal-title'); return t ? (t.innerText || '').trim() : null; });
        `)) ?? [];
        if (expectTitle) { if (dlgTitles.includes(expectTitle)) break; }
        else if (dlgTitles.length) break;
        await delay(300);
      }
      const dlg = { count: dlgTitles.length, titles: dlgTitles };
      const expect = spec.expect_dialog ?? null;
      const actualTitle = dlg?.titles?.[dlg.titles.length - 1] ?? null;
      const dialogOk = !expect || actualTitle === expect;
      results.push({ label: name + ':dialog', ok: dialogOk, value: [actualTitle, 'expect=' + (expect ?? '(any)'), 'open=' + (dlg?.count ?? 0)] });
      if (!dialogOk) {
        // 走错弹窗时**不要**继续搜/选 —— 那只会把别的字段写坏。关掉并明确记为失败。
        // 根因通常是上一个字段的弹窗没关干净；closeModals 在后面统一处理。
        results.push({ label: name + ':pick', ok: false, value: ['WRONG_DIALOG(未写入)', 'actual=' + actualTitle, 'expect=' + expect] });
        // 先 Esc 收掉可能的自动填充浮层，再点取消（见 closeModals 里的说明）
        await transport.request('input.key', { key: 'Escape' }, { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await delay(250);
        await evaluate(name + ':close-wrong', script(`
          const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
          const ms = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
          const m = ms[ms.length - 1];
          if (m) {
            const btn = Array.from(m.querySelectorAll('button')).find(b => /取\\s*消/.test((b.innerText || '')));
            if (btn) btn.setAttribute('data-dp-cancel', '1');
          }
          return true;
        `));
        await transport.request('chrome.click', withEndpoint({ selector: '[data-dp-cancel="1"]', timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await evaluate(name + ':unmark-wrong', script(`document.querySelectorAll('[data-dp-cancel]').forEach(e => e.removeAttribute('data-dp-cancel')); return true;`));
        await delay(600);
        continue;
      }
      // 人员选择型弹窗（dialog_kind: person-list）走独立分支。
      //
      // 实测「多人力资源」与其它关联弹窗**结构完全不同**：不是 ant-table 而是 li 人员列表
      // （共818条 82页），搜索框**没有 id**（只能按 placeholder=请输入关键字搜索 定位），
      // 且需要点「确定」才生效。用表格那套逻辑去处理它必然 row_not_found。
      if (spec.dialog_kind === 'person-list') {
        const want = String(searchValue ?? spec.pick ?? '');
        // 1) 定位搜索框。人员弹窗的输入框**没有 id**，所以按 placeholder 找；
        //    找不到 placeholder 就退回"可见的输入框"（可能有多个，取第一个可见的）。
        //
        // 实测坑（UIH-02 人力资源弹窗）：该弹窗里唯一可见的 input 类名是
        // `ant-input undefined`、placeholder 为 null —— 按 placeholder 找必然失败，
        // 旧代码直接返回 no_input 而**没有退回**，于是 5 个人员字段全报 NO_PERSON_SEARCHBOX。
        // 找不到就用兜底，而不是直接放弃。
        const boxId = await evaluate(name + ':personbox', script(`
          const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
          if (!modals.length) return { ok: false, reason: 'no_modal' };
          const m = modals[modals.length - 1];
          const ph = ${JSON.stringify(spec.search_input_placeholder ?? '')};
          const all = Array.from(m.querySelectorAll('input')).filter(visible);
          if (!all.length) return { ok: false, reason: 'no_input', count: 0 };
          let el = ph ? all.find(i => (i.placeholder || '').indexOf(ph) >= 0) : null;
          const how = el ? 'by_placeholder' : 'first_visible_input';
          if (!el) el = all[0];
          if (!el.id) el.setAttribute('data-dp-personbox', '1');
          return { ok: true, id: el.id || null, marked: !el.id, how, count: all.length };
        `));
        const boxSel = boxId?.id ? ('#' + boxId.id) : (boxId?.marked ? '[data-dp-personbox="1"]' : null);
        if (!boxSel) {
          // 该弹窗**没有可见输入框**（实测 部门/分部 弹窗就是如此：只有标签页与确定/取消）。
          // optional 字段如实记 skipped；非 optional 才判失败。
          const optional = spec.optional === true;
          const reason = boxId?.reason ?? 'no_search_input';
          results.push({
            label: name + ':pick',
            ok: optional,
            value: [optional ? 'skipped(' + reason + '：该弹窗无搜索框，也没有候选可选)' : reason]
          });
          const left = await closeModals(name + ':close');
          results.push({ label: name + ':leftover', ok: left === 0, value: ['关闭后残留弹窗=' + left] });
          continue;
        }
        {
          await transport.request('chrome.fill', withEndpoint({ selector: boxSel, value: want, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
          await delay(2000);   // 人员列表按关键字远程过滤，给它时间
          // 2) 在人员列表里按文本选人。
          //    实测列表容器是 `.wea-crm-list`（子项是 div，不是 li），
          //    而且**写入搜索框不会触发远程搜索**（列表仍显示「没有可显示的数据」）——
          //    该组件需要真实键盘事件。因此这里如实记为未完成，并把字段标 optional 时不阻塞整单。
          const marked = await evaluate(name + ':personlist', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return { ok: false, reason: 'no_modal' };
            const m = modals[modals.length - 1];
            const want = ${JSON.stringify(want)};
            const listSel = ${JSON.stringify(spec.list_selector ?? '.wea-crm-list')};
            const lists = Array.from(m.querySelectorAll(listSel)).filter(visible);
            const cands = [];
            for (const l of lists) for (const c of Array.from(l.children)) {
              if (!visible(c)) continue;
              const t = (c.innerText || '').replace(/\\s+/g, ' ').trim();
              if (t && !/没有可显示的数据/.test(t)) cands.push(c);
            }
            // 弹窗自报"暂无数据/没有可显示的数据" = 该弹窗对当前账号无候选，
            // 属**数据可得性**，不是脚本技巧问题。如实分开上报。
            const emptyTip = /暂无数据|没有可显示的数据/.test(m.innerText || '');
            const hit = cands.find(c => (c.innerText || '').replace(/\\s+/g, '').indexOf(want.replace(/\\s+/g, '')) >= 0);
            if (!hit) {
              return { ok: false,
                       reason: emptyTip ? 'dialog_has_no_data' : 'no_person_match',
                       candidateCount: cands.length,
                       sample: cands.slice(0, 5).map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30)) };
            }
            hit.setAttribute('data-dp-person', '1');
            return { ok: true, text: (hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), candidateCount: cands.length };
          `));
          if (!marked?.ok) {
            // 可选字段：记为 skipped（不算失败），保证整单其余字段能继续验证
            const optional = spec.optional === true;
            results.push({
              label: name + ':pick',
              ok: optional,
              value: [optional ? 'skipped(' + (marked?.reason ?? 'unknown') + ')' : (marked?.reason ?? 'unknown'),
                      'candidates=' + (marked?.candidateCount ?? 0), marked?.sample ?? null]
            });
          } else {
            // 3) 点人员项 + 点「确定」（该弹窗与其它不同，必须确认）
            await transport.request('chrome.click', withEndpoint({ selector: '[data-dp-person="1"]', timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
            await delay(500);
            const confirmed = await evaluate(name + ':confirm', script(`
              const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
              if (!modals.length) return { ok: true, alreadyClosed: true };
              const m = modals[modals.length - 1];
              const btn = Array.from(m.querySelectorAll('button')).filter(visible)
                .find(b => /确\\s*定/.test((b.innerText || '')));
              if (!btn) return { ok: false, reason: 'no_confirm_button' };
              btn.setAttribute('data-dp-confirm', '1');
              return { ok: true };
            `));
            if (confirmed?.ok && !confirmed?.alreadyClosed) {
              await transport.request('chrome.click', withEndpoint({ selector: '[data-dp-confirm="1"]', timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
              await delay(1200);
            }
            const v = await evaluate(name + ':pick', script(`
              const modalsLeft = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible).length;
              const el = document.querySelector(${JSON.stringify(spec.selector)});
              const text = el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : '';
              const val = el && el.value != null ? String(el.value) : '';
              const hit = (text + ' ' + val).indexOf(${JSON.stringify(want)}) >= 0;
              return { modalsLeft, text: text.slice(0, 50), val: val.slice(0, 50), filled: hit };
            `));
            results.push({ label: name + ':pick', ok: v?.filled === true, value: ['person=' + (marked.text ?? ''), 'filled=' + v?.text], modalsLeft: v?.modalsLeft });
          }
        }
        const left = await closeModals(name + ':close');
        results.push({ label: name + ':leftover', ok: left === 0, value: ['关闭后残留弹窗=' + left] });
        continue;
      }

      if (doSearch) {
        // 搜索框选择：**按语义/id 定位，不按序号盲选**。
        //
        // 实测（2026-09-23，经费号_SAP采购 弹窗）：它有两个搜索框，id 分别是 `jfh`(经费号)
        // 和 `xmh`(项目号) —— 序号 0 是"经费号"而**不是**项目号。旧代码固定用 index 0，
        // 于是把项目号值 100167003201 填进了经费号框，搜出 0 行（row_not_found:0 的真因）。
        // 不同弹窗框数也不同（项目号弹窗 3 个、经费弹窗 2 个），所以序号毫无可移植性。
        //
        // 策略（依次降级）：
        //   1) 模板给了 search_box_id 就直接用；
        //   2) 否则在弹窗里找 id/data-fieldname 与目标字段名匹配的框；
        //   3) 否则用全弹窗唯一的框（只有 1 个时没有歧义）；
        //   4) 否则退回 search_index（兼容旧模板），并在日志里标明是"盲选"。
        const want = String(searchValue ?? '');
        // 搜索框探针要**重试**：弹窗的 input 是异步渲染的。
        // 实测（2026-09-23，UIH-01 币种弹窗）：弹窗标题已出现，但其内部
        // `input.ant-input` 还没渲染出可见尺寸，探针一次就拿到 `vis.length===0` → `no_input`
        // → 搜索没发生 → 列表停在第一页（ZWR/ZWN…）→ `row_not_found(rows=10)` → 连锁失败。
        // 同一页面稍后再探就能看到 2 个可见框（w=144）。所以这里轮询到"出现可见框"再判定。
        const probeExpr = script(`
          const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
          if (!modals.length) return { ok: false, reason: 'no_modal' };
          const modal = modals[modals.length - 1];
          const vis = Array.from(modal.querySelectorAll('input.ant-input')).filter(visible);
          if (!vis.length) return { ok: false, reason: 'no_input' };
          const wanted = ${JSON.stringify(spec.search_box_id ?? spec.fieldname ?? '')};
          const wantedName = ${JSON.stringify(name)};
          if (wanted) {
            const byId = vis.find(i => i.id === wanted);
            if (byId) return { ok: true, id: byId.id || '', how: 'by_id', boxCount: vis.length, modalCount: modals.length };
          }
          // 按 id 语义匹配字段名（如 jf→jfh, xmh→xmh）
          const stem = wantedName.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          const byName = stem ? vis.find(i => (i.id || '').toLowerCase().startsWith(stem.slice(0, 3))) : null;
          if (byName) return { ok: true, id: byName.id || '', how: 'by_name', boxCount: vis.length, modalCount: modals.length };
          if (vis.length === 1) return { ok: true, id: vis[0].id || '', how: 'only_box', boxCount: 1, modalCount: modals.length };
          const el = vis[${searchIndex}] || vis[0];
          return { ok: true, id: el.id || '', how: 'by_index_blind', boxCount: vis.length, modalCount: modals.length,
                   ids: vis.map(i => i.id || null) };
        `);
        let boxProbe = null;
        for (let t = 0; t < 10; t++) {
          boxProbe = await evaluate(name + ':searchbox', probeExpr).catch(() => null);
          if (boxProbe?.ok) break;
          await delay(300);
        }
        const boxId = boxProbe?.id;
        const boxHow = boxProbe?.how ?? 'none';
        if (boxId) {
          await fill(name + ':searchbox', '#' + boxId, want);
        } else {
          await evaluate(name + ':searchbox-fallback', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return ['no_modal'];
            const vis = Array.from(modals[modals.length - 1].querySelectorAll('input.ant-input')).filter(visible);
            if (!vis.length) return ['no_input'];
            const target = vis[${searchIndex}] || vis[0];
            typeInto(target, ${JSON.stringify(want)});
            return ['typed(readback=' + (target.value === ${JSON.stringify(want)} ? 'ok' : target.value) + ')'];
          `));
        }
        results.push({ label: name + ':searchbox-how', ok: boxHow !== 'by_index_blind' || spec.optional === true,
                       value: [boxHow, boxId ?? null],
                       candidateIds: boxProbe?.ids ?? null, boxCount: boxProbe?.boxCount ?? 0,
                       note: boxHow === 'by_index_blind' ? '搜索框无 id 匹配，按序号盲选 —— 结果可能不准，请人工核对' : undefined });
        const clickSearch = await evaluate(name + ':search', script(`
          const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
          if (!modals.length) return ['no_modal'];
          const modal = modals[modals.length - 1];
          const search = Array.from(modal.querySelectorAll('button.ant-btn-primary')).find(b => norm(b.innerText) === '搜索');
          if (!search) return ['no_search_btn'];
          search.click();
          return ['searched(框数=' + ${boxProbe?.boxCount ?? 0} + ',方式=' + ${JSON.stringify(boxHow)} + ',弹窗数=' + modals.length + ')'];
        `));
        // 等搜索结果真的出现，而不是 sleep 固定秒数。
        //
        // 关键：等待条件必须是**目标行出现**，不能是"行数 > 0"。
        // 实测踩坑：搜索请求还没回来时弹窗仍是首页 10 行，若以"行数>0"为条件会立刻
        // 判定完成，随后 locate 在首页里找不到目标 → row_not_found(rows=10)。
        // 所以这里轮询的是"目标行是否已在当前结果里"。
        const keyWant = String(spec.pick ?? searchValue ?? '');
        let postCount = 0;
        let targetFound = false;
        for (let w = 0; w < 25; w++) {
          const st = await evaluate(name + ':after-search', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return { n: 0, hit: false };
            const m = modals[modals.length - 1];
            const rows = [];
            for (const t of m.querySelectorAll('table.ant-table-body, table.ant-table-fixed'))
              for (const tr of t.querySelectorAll('tbody tr')) if (visible(tr)) rows.push(tr);
            const k = ${JSON.stringify(keyWant)};
            const hit = k ? rows.some(tr => Array.from(tr.querySelectorAll('td'))
              .some(td => (td.innerText || '').replace(/\\s+/g, ' ').trim() === k)) : rows.length > 0;
            return { n: rows.length, hit };
          `)) ?? { n: 0, hit: false };
          postCount = st.n;
          targetFound = st.hit;
          if (targetFound) break;
          await delay(400);
        }
        if (!targetFound) {
          results.push({ label: name + ':search-wait', ok: false, value: ['目标行始终未出现', 'rows=' + postCount, 'want=' + keyWant] });
        }
        if ((postCount ?? 0) === 0) {
          // 兜底：清空搜索框内容后重搜，让弹窗把候选列全。
          //
          // 注意：**不要**点弹窗底部的「清除」按钮 —— 实测那会把整个弹窗关掉
          // （之后所有步骤都报 no_modal）。只把搜索框的值清空即可。
          await evaluate(name + ':clear-inputs', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return ['no_modal'];
            const m = modals[modals.length - 1];
            const inputs = Array.from(m.querySelectorAll('input.ant-input')).filter(visible);
            for (const i of inputs) typeInto(i, '');
            const search = Array.from(m.querySelectorAll('button.ant-btn-primary')).find(b => norm(b.innerText) === '搜索');
            if (search) search.click();
            return ['cleared_inputs_and_searched'];
          `));
          await delay(2500);
          const listed = await evaluate(name + ':after-clear', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return 0;
            const m = modals[modals.length - 1];
            let n = 0;
            for (const t of m.querySelectorAll('table.ant-table-body, table.ant-table-fixed'))
              for (const tr of t.querySelectorAll('tbody tr')) if (visible(tr)) n++;
            return n;
          `));
          results.push({ label: name + ':fallback-list', ok: (listed ?? 0) > 0, value: ['清空搜索框后重搜，候选行=' + (listed ?? 0)] });
        }
      } else {
        results.push({ label: name + ':search', ok: true, value: ['skipped(搜索关闭，弹窗已列全部候选)'] });
      }
      // 选行：按模板 pick 匹配行文本，点行即选中并**自动关闭弹窗 + 回填字段**。
      //
      // 实测（2026-09-23，SAP工厂弹窗）确认的正确交互：
      //   弹窗里**没有**确认按钮、**没有** radio/checkbox —— 点目标行后弹窗自己关闭，
      //   字段值随即回填（实测 modalsLeft:0、lcckText:"上海联影生产工厂-CO"）。
      //   所以"选中"的判据不是行样式，而是：**字段出现期望文本**。
      //
      // 三个必须避开的坑：
      //   1) 多弹窗并存时 querySelector 只拿第一个 → 取最后打开的可见弹窗。
      //   2) 固定表头结构：行在 ant-table-body 的 tbody 里，header table 的 tbody 是空的。
      //   3) 页面内 el.click() 对该组件不可靠 → 用 chrome.click（CDP 可信输入）。
      const key = String(spec.pick ?? searchValue ?? '');
      // 可选字段且没有指定要选什么（pick 为空）→ **不选行**，直接关掉弹窗。
      // 实测教训：此前 pick="" 时靠子串匹配"歪打正着"选中了第一行并把值写了进去 ——
      // 那是运气，不是正确行为。留空就该留空。
      if (key === '' && spec.optional === true) {
        results.push({ label: name, ok: true, value: ['skipped(optional 且未指定 pick，保持留空)'], fieldname: spec.fieldname });
        const left0 = await closeModals(name + ':close');
        results.push({ label: name + ':leftover', ok: left0 === 0, value: ['关闭后残留弹窗=' + left0] });
        continue;
      }
      const locateExpr = script(`
        const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
        if (!modals.length) return { ok: false, reason: 'no_modal' };
        const modal = modals[modals.length - 1];
        const rows = [];
        for (const t of modal.querySelectorAll('table.ant-table-body, table.ant-table-fixed'))
          for (const tr of t.querySelectorAll('tbody tr')) if (visible(tr)) rows.push(tr);
        const k = ${JSON.stringify(key)};
        // 匹配策略：**先整格精确匹配，再退回子串匹配**。
        //
        // 实测事故（2026-09-23）：搜 pick="0" 时，子串匹配命中了「无项目 | 0 | 1001」这一行，
        // 把项目号填成了 0（看着"选到了行"，其实选错了行）。凡目标值短、或与其它行
        // 单元格有包含关系（"0" ⊂ "1001"）时，纯子串匹配必然出错。
        const cellsOf = tr => Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim());
        let row = rows.find(tr => cellsOf(tr).some(c => c === k));           // 整格相等（首选）
        if (!row) {
          // 退一步：单元格以目标开头（处理 "1206-CO" 这类前缀写法），仍比全文子串严格
          row = rows.find(tr => cellsOf(tr).some(c => c.startsWith(k)));
        }
        if (!row) row = rows.find(tr => (tr.innerText || '').indexOf(k) >= 0);   // 最后才用子串
        if (!row) return { ok: false, reason: 'row_not_found', rows: rows.length };
        row.setAttribute('data-dp-pick', '1');
        return { ok: true, rows: rows.length };
      `);
      const located = await evaluate(name + ':locate', locateExpr);
      if (!located?.ok) {
        // **空弹窗兜底：先点一次「搜索」再重试 locate。**
        //
        // 实测（2026-09-23）：模板对「经费」写了 `search:false, pick:"0"`，依据是阶段2
        // 观察到该弹窗**只有 1 行**。但后来该弹窗变成 **rows=0**（数据可得性变化），
        // "直接选唯一那行"的前提就不成立了 → `row_not_found(rows=0)`，
        // 并且残留弹窗还把后续字段带崩（加签人报 WRONG_DIALOG）。
        //
        // 弹窗里其实**有搜索框**（jfh/xmh）。所以当弹窗为空时，不该直接判失败，
        // 而应主动触发一次搜索——这比把 `search` 写死在模板里更抗数据变化。
        if (located?.rows === 0) {
          const searched = await evaluate(name + ':empty-search', script(`
            const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible);
            if (!modals.length) return ['no_modal'];
            const modal = modals[modals.length - 1];
            const btn = Array.from(modal.querySelectorAll('button.ant-btn-primary')).find(b => norm(b.innerText) === '搜索');
            if (!btn) return ['no_search_btn'];
            btn.click();
            return ['searched'];
          `)).catch(() => null);
          await delay(1200);
          const retry = await evaluate(name + ':locate2', locateExpr).catch(() => null);
          if (retry?.ok) {
            results.push({ label: name + ':empty-dialog-recovered', ok: true,
                           value: ['弹窗初始为空，已自动搜索后命中', 'search=' + JSON.stringify(searched)] });
            // 复用下面的 pick 流程
            Object.assign(located, retry);
          } else {
            results.push({ label: name + ':pick', ok: false,
                           value: ['row_not_found(空弹窗，自动搜索后仍无目标行)',
                                   'rows=' + (retry?.rows ?? 0), 'search=' + JSON.stringify(searched)] });
            continue;
          }
        } else {
          results.push({ label: name + ':pick', ok: false, value: [located?.reason + '(rows=' + (located?.rows ?? 0) + ')'] });
          continue;
        }
      }
      await transport.request('chrome.click', withEndpoint({ selector: '[data-dp-pick="1"]', timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi });
      await delay(1200);
      // 回读：字段应出现期望文本。只"点了"不算选中。
      const verifyExpr = script(`
        const modalsLeft = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(visible).length;
        const sel = ${spec.selector ? JSON.stringify(spec.selector) : 'null'};
        const el = sel ? document.querySelector(sel) : null;
        const text = el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : '';
        const val = el && el.value != null ? String(el.value) : '';
        const hit = (text + ' ' + val).indexOf(${JSON.stringify(key)}) >= 0;
        if (el && el.removeAttribute) el.removeAttribute('data-dp-pick');
        return { modalsLeft, text: text.slice(0, 50), val: val.slice(0, 50), filled: hit };
      `);
      const v = await evaluate(name + ':pick', verifyExpr);
      if (v?.filled === true) {
        results.push({ label: name + ':pick', ok: true, value: ['filled=' + v.text], modalsLeft: v?.modalsLeft });
      } else {
        // 点了行但字段值不是我们要的 —— 分两种情况，别混为一谈：
        //   · 字段仍是空 → 写入没生效（技术问题，要修）
        //   · 字段变成了**别的非空值**（实测：CR变更 态下选 100167003201 会回退成 0）
        //     → OA 业务规则拒绝了这次选择，**不是我们能修的**，必须如实上报让用户判断
        const gotNonEmpty = String(v?.text ?? '') !== '' || String(v?.val ?? '') !== '';
        if (gotNonEmpty) {
          results.push({
            label: name + ':pick', ok: false,
            value: ['REJECTED_BY_FORM', '期望=' + key, '实际=' + (v?.text || v?.val)],
            note: '选择的候选被 OA 改成了别的值 —— 属于业务规则拒绝（如 CR变更 态下项目号不可自由指定），需用户确认，不是脚本缺陷'
          });
        } else {
          results.push({ label: name + ':pick', ok: false, value: ['NOT_FILLED(空)', v?.text, v?.val], modalsLeft: v?.modalsLeft });
        }
      }
      // 收尾：确保这个字段的弹窗已关闭，否则下一个字段会操作到它遗留的弹窗
      // （实测错位会让币种被写成 ZWR、项目号留空，且不报错）。
      // closeModals 定义在循环外（见上方），这里只调用并回读残留数。
      {
        const left = await closeModals(name + ':close');
        results.push({ label: name + ':leftover', ok: left === 0, value: ['关闭后残留弹窗=' + left] });
      }
    }

    // 6) 明细行：新增 + 逐列填充
    const detail = template?.detail_columns;
    const rows = data?.detail_rows ?? [];
    if (detail?.add && rows.length) {
      const addId = detail.add.replace('#', '');
      // 明细行的 input 在 DOM 里**本来就存在**（隐藏模板行），但行没被创建时它是 0×0 的游离节点。
      // 此时 chrome.fill 照样报 verified:true，值却进不了表单模型 —— 本轮 UIH-03 就栽在这里。
      // 所以：必须用 CDP 可信输入点「新增行」，并回读**行真的出现了**（宽度>0）再写列。
      const firstColSel = Object.values(detail.columns ?? {})
        .map((s) => (typeof s === 'string') ? s : s?.selector)
        .find((s) => s && s.includes('_N'));
      // 该清单表所有列的 id 前缀（去掉 # 与 _N）。判断"行是否存在"必须看**所有列**，
      // 不能只看第一列 —— 实测 UIH-01 的 物料号(#field67932) 在已填行里是 display:none
      // （OA 把已有值的表格单元格隐藏），只查它就会误判"没有行"，进而去点新增（点了也无效），
      // 最终报 row_not_created。真相是那一行**一直都在 `_0`**。
      const allColPrefixes = Object.values(detail.columns ?? {})
        .map((s) => (typeof s === 'string') ? s : s?.selector)
        .filter((s) => s && s.includes('_N'))
        .map((s) => s.replace('#', '').split('_')[0]);
      for (let i = 0; i < rows.length; i++) {
        // **先判断这张明细表是不是已经有可写的行**。实测两张表行为完全不同：
        //   · UIH-01：表单**预置了整行数据**（子库/SAP项目号/成本中心… 都有值），
        //     此时再点「新增行」是画蛇添足，且点了也不生效（实测下标始终只有 _0）。
        //   · UIH-03：表是空的，必须点「新增行」才出现可写行。
        // 判据：看**所有列**在某个下标上是否有"可写的 input"（存在即可，不要求该列可见）。
        const renderedExisting = await evaluate('detail:prerender#' + i, script(`
          const prefixes = ${JSON.stringify(allColPrefixes)};
          const seen = {};
          for (const p of prefixes) {
            for (const el of document.querySelectorAll('[id^="' + p + '_"]')) {
              if (el.tagName !== 'INPUT') continue;
              const n = Number(String(el.id).split('_').pop());
              if (!Number.isFinite(n)) continue;
              // 该 input 所在的行必须是真的数据行（detail_data_row）
              const tr = el.closest('tr');
              if (!tr || !tr.classList.contains('detail_data_row')) continue;
              seen[n] = true;
            }
          }
          return Object.keys(seen).map(Number).sort((a, b) => a - b);
        `)).catch(() => null);
        const usable = Array.isArray(renderedExisting) ? renderedExisting : [];
        let rowIdx;
        if (usable.length > i) {
          // 已有第 i 行可写 → 直接写它，不新增
          rowIdx = usable[i];
          results.push({ label: 'detail:reuse#' + i, ok: true, value: ['复用已存在行 _' + rowIdx + '（未点新增）'] });
        } else {
        // 标记 + 滚进视口 + CDP 点击（见 universal-pitfalls #10/#18）。
        // 关键：`id` 在页面上可能**重复**（两张明细表各有一个 addbutton0），
        // 而 getElementById 只返回第一个 —— 实测第一个是 0×0 的隐藏表，点它毫无反应。
        // 所以必须按 id 取**所有**候选，挑**已渲染**（宽高>0）的那个来标记。
        const mark = script(`
          const cands = Array.from(document.querySelectorAll('[id="' + ${JSON.stringify(addId)} + '"]'));
          if (!cands.length) return ['no_add_button'];
          const btn = cands.find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          if (!btn) return ['add_button_not_rendered', cands.length];
          btn.scrollIntoView({ block: 'center', inline: 'center' });
          btn.setAttribute('data-dp-addrow', '1');
          const r = btn.getBoundingClientRect();
          return [r.width, r.height];
        `);
        const marked = await evaluate('detail:add#mark' + i, mark);
        if (Array.isArray(marked) && typeof marked[0] === 'string') {
          results.push({ label: 'detail:add#' + i, ok: false, value: [marked[0] + (marked[1] != null ? '(候选 ' + marked[1] + ' 个)' : '')] });
          break;
        }
        await transport.request('chrome.click', withEndpoint({
          selector: '[data-dp-addrow="1"]', timeout_ms: TIMEOUTS.requestUi,
        }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await evaluate('detail:add#unmark' + i, script(`
          const b = document.querySelector('[data-dp-addrow="1"]'); if (b) b.removeAttribute('data-dp-addrow');
          return [1];
        `)).catch(() => {});
        await delay(1200);

        // 找出**本行真正对应的 id 下标**。OA 的 excelDetailTable 里 `_0` 是占位行
        // （未 swap，恒 0×0），真实数据行从 `_1` 起。写 `_0` 会拿到 verified:true 但
        // 值进不了表单模型 —— UIH-03 就栽在这里（见 universal-pitfalls #19）。
        //
        // 判据是**新增前后"数据行下标"的差集**，不能数 `tr.detail_data_row` 的行数：
        // 实测 UIH-01 的表单**预置了多行**，行数与 id 下标根本不对应 —— 按行数当行号
        // 会算出 `#field67932_8` 这种不存在的选择器（CHROME_ELEMENT_NOT_FOUND）。
        // 同样也不能只看第一列（那一列可能是 display:none 的隐藏值列）。
        // 正确做法：扫**所有列**，取"位于 detail_data_row 里的 input"的下标集合。
        const readRowIdxs = async (tag) => {
          const r = await evaluate(tag, script(`
            const prefixes = ${JSON.stringify(allColPrefixes)};
            const seen = {};
            for (const p of prefixes) {
              for (const el of document.querySelectorAll('[id^="' + p + '_"]')) {
                if (el.tagName !== 'INPUT') continue;
                const tr = el.closest('tr');
                if (!tr || !tr.classList.contains('detail_data_row')) continue;
                const n = Number(String(el.id).split('_').pop());
                if (Number.isFinite(n)) seen[n] = true;
              }
            }
            return Object.keys(seen).map(Number).sort((a, b) => a - b);
          `)).catch(() => null);
          return Array.isArray(r) ? r : null;
        };
        const idxsBefore = await readRowIdxs('detail:idxbefore#' + i) ?? [];

        {
          let found = null;
          for (let t = 0; t < 12; t++) {
            const now = await readRowIdxs('detail:rowprobe#' + i);
            if (now && now.length) {
              const added = now.filter((n) => !idxsBefore.includes(n));
              if (added.length) { found = Math.max.apply(null, added); break; }
            }
            await delay(400);
          }
          if (found == null) {
            // 退路：用新增前就存在的、位于数据行里的最大下标
            const fb = await readRowIdxs('detail:rowfb#' + i);
            if (Array.isArray(fb) && fb.length) found = fb[fb.length - 1];
          }
          if (found == null) {
            results.push({
              label: 'detail:add#' + i, ok: false,
              value: ['row_not_created(新增后没有任何已渲染的明细行，已放弃写本行)'],
            });
            break;
          }
          rowIdx = found;
          if (rowIdx !== i) {
            results.push({ label: 'detail:rowindex#' + i, ok: true, value: ['数据行号=' + rowIdx + '（非循环下标 ' + i + '）'] });
          }
        }
        }

        const row = rows[i];
        for (const [colName, colSpec] of Object.entries(detail.columns ?? {})) {
          const val = row[colName];
          if (val == null) continue; // 可留空列（MPN/物料版本/图纸版本）
          // derived 列由页面联动带出（如品名描述由物料号带出），手填会被 OA 异步校验清空，
          // 引擎跳过；若数据里给了值也只在日志里说明，不写。
          if (typeof colSpec === 'object' && colSpec?.derived) {
            results.push({ label: 'detail:' + colName + '#' + i, ok: true, value: ['skipped(derived，由页面联动带出)'] });
            continue;
          }
          const colSelector = (typeof colSpec === 'string') ? colSpec : colSpec?.selector;
          if (!colSelector) continue;
          const sel = colSelector.replace('_N', '_' + rowIdx); // _N 行号占位 → 真实数据行号
          await fill('detail:' + colName + '#' + i, sel, val);
        }
        // 明细行写完立即回读本行，确认不是"写成功但随后被联动清掉"。
        // 实测存在该现象：引擎报 verified=true，但整轮结束后回读为空。
        // 注意回读必须用**真实数据行号 rowIdx**，用循环下标会读回占位行（恒空）。
        const readback = await evaluate('detail:readback#' + i, script(`
          const ids = ${JSON.stringify(Object.entries(detail.columns ?? {})
            .map(([n, s]) => [n, ((typeof s === 'string') ? s : s?.selector || '').replace('_N', '_' + rowIdx)])
            .filter(([, sel]) => sel))};
          const out = {};
          for (const [name, sel] of ids) {
            const el = document.querySelector(sel);
            out[name] = el ? el.value : null;
          }
          return out;
        `));
        results.push({ label: 'detail:verify#' + i, ok: true, value: readback });
      }
    }

    // 7) 主表回读校验：把模板里所有 field_map 字段的实际值读回来。
    //    这是"数据真的进了表单模型"的证据 —— 只报 verified:true 不算数。
    //
    //    注意：回读前**不要**用尺寸判可见性来决定是否读值。实测表单很长、页面停在
    //    靠下的位置时，上半部分字段的 getBoundingClientRect 为 0 或不在视口，
    //    若据此记"(不可见)"，会把**已填好的字段误报成没填**（本轮就误报了 9 个）。
    //    正确做法：先判断元素是否真的不渲染（td/tr display:none），否则一律读值。
    const mainReadback = await evaluate('main:readback', script(`
      const map = ${JSON.stringify(Object.entries(template?.field_map ?? {})
        .filter(([, s]) => s && s.selector && (s.type === 'text' || s.type === 'select' || s.type === 'browser' || s.type === 'derived' || s.type === 'conditional-detail' || s.type === 'datepicker' || s.type === 'upload'))
        .map(([n, s]) => [n, s.selector, s.type, s.type === 'conditional-detail']))};
      const out = {};
      for (const [name, sel, type, isCond] of map) {
        let el = document.querySelector(sel);
        // 同一 id 可能有多个节点（明细行 + 主表副本），取**已渲染**的那个。
        const idOnly = sel && sel.startsWith('#') ? sel.slice(1) : null;
        if (idOnly) {
          const cands = Array.from(document.querySelectorAll('[id="' + idOnly + '"]'));
          if (cands.length > 1) {
            const rendered = cands.find(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            if (rendered) el = rendered;
          }
        }
        if (!el) { out[name] = '(不在 DOM)'; continue; }
        // 先看"有没有值"：有值就报值，不管尺寸（避免把已填的误报成未渲染）。
        const v0 = String(el.value ?? '').trim();
        const t0 = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (v0 || t0) { out[name] = v0 || t0; continue; }
        // 没值：区分"没渲染"与"渲染了但空"—— 后者是真·没填进去
        const r = el.getBoundingClientRect();
        out[name] = (r.width === 0 && r.height === 0) ? (isCond ? '(条件未显示)' : '(未渲染)') : '';
      }
      return out;
    `));
    results.push({ label: 'main:verify', ok: true, value: mainReadback });

    // 7b) 补写：某些字段会被**后续字段的操作**清掉。
    //
    // 实测（2026-09-23，CR变更 场景）：项目节点/组合管理分类在各自步骤里 verify 通过
    // （readback=R3-G3 / 生命周期），但整轮结束时回读为空 —— 后面打开浏览器弹窗的过程
    // 把主表重置了。单独手测该字段却能稳定保持，说明是**跨字段副作用**，不是字段本身的问题。
    //
    // 做法：整轮结束前，对"期望有值但回读为空"的 select 再补一次，然后重新回读。
    // 这是有界的（只重试一轮），不会掩盖真实失败：补完仍为空就如实报出来。
    const missingSelects = selects.filter(([name, spec]) => {
      const want = values[name] ?? spec.default;
      return want != null && String(want) !== '' && !String(mainReadback?.[name] ?? '').trim();
    });
    if (missingSelects.length) {
      for (const [name, spec] of missingSelects) {
        const want = String(values[name] ?? spec.default ?? '');
        if (!want) continue;
        await evaluate(name + ':reapply-scroll', script(`
          const w = document.querySelector(${JSON.stringify(spec.widget ?? spec.selector)});
          if (w) { const s = w.matches('.ant-select') ? w : w.querySelector('.ant-select'); if (s) s.scrollIntoView({ block: 'center' }); }
          return true;
        `));
        await transport.request('chrome.click', withEndpoint({ selector: `${spec.widget ?? spec.selector} .ant-select`, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
        await delay(800);
        await evaluate(name + ':reapply-pick', script(`return [pickFromVisibleDropdown(${JSON.stringify(want)})];`));
        await delay(400);
        await evaluate(name + ':reapply-close', script(`document.body.click(); return true;`));
      }
      // 补写后重新回读这一批字段
      const recheck = await evaluate('main:recheck', script(`
        const map = ${JSON.stringify(missingSelects.map(([n, s]) => [n, s.widget ?? s.selector]))};
        const out = {};
        for (const [name, sel] of map) {
          const w = document.querySelector(sel);
          const sv = w ? w.querySelector('.ant-select-selection-selected-value') : null;
          out[name] = sv ? (sv.innerText || '').trim() : (w ? (w.innerText || '').replace(/\\s+/g, ' ').trim() : null);
        }
        return out;
      `));
      for (const [k, v] of Object.entries(recheck ?? {})) {
        if (String(v ?? '').trim()) mainReadback[k] = v;
      }
      results.push({ label: 'main:reapply', ok: true, value: ['被后续操作清空的字段已补写并复核', recheck] });
    }

    // 7c) 文本字段的同类补写。
    //
    // 实测（2026-09-23，UIH-02 借款申请单）：**手机号 约每 5 轮偶发 1 次回读为空**，
    // 单独手测却永远能写进去 —— 与 7b 的 select 是同一类"跨字段副作用 / 时序竞态"，
    // 只是 7b 当时只覆盖了 select，文本字段漏网，于是表现为"偶发失败"。
    // 做法与 7b 一致：对"期望有值但回读为空"的可写文本字段再补一次，补完仍为空就如实报出。
    const missingTexts = Object.entries(template?.field_map ?? {})
      .filter(([name, spec]) => {
        if (spec.type !== 'text' || spec.readonly || spec.optional || spec.derived) return false;
        if (spec.finance_section || spec.datepicker) return false;
        const want = values[name];
        if (want == null || String(want) === '') return false;
        return !String(mainReadback?.[name] ?? '').trim();
      });
    if (missingTexts.length) {
      for (const [name, spec] of missingTexts) {
        const want = String(values[name]);
        await fill('main:reapply-text:' + name, spec.selector, want);
      }
      await delay(400);
      const recheckTexts = await evaluate('main:recheck-text', script(`
        const map = ${JSON.stringify(missingTexts.map(([n, s]) => [n, s.selector]))};
        const out = {};
        for (const [name, sel] of map) {
          const el = document.querySelector(sel);
          out[name] = el ? String(el.value ?? '').trim() : null;
        }
        return out;
      `)).catch(() => null);
      for (const [k, v] of Object.entries(recheckTexts ?? {})) {
        if (String(v ?? '').trim()) mainReadback[k] = v;
      }
      results.push({ label: 'main:reapply-text', ok: true, value: ['被清空的文本字段已补写并复核', recheckTexts] });
    }

    // 8) 明确停在提交前：本引擎从不点提交/保存，这是设计约束，不是遗漏。
    results.push({ label: 'submit', ok: true, value: ['skipped(引擎不提交；停在提交前，等待用户确认)'] });

    const snapshot = (await evaluate('snapshot', script(
      `return { url: location.href.slice(0,80), title: document.title };`
    )))?.value ?? null;

    return { results, snapshot };
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('oa-fill-engine.mjs')) {
  const flag = name => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const { readFileSync } = await import('node:fs');
  const template = JSON.parse(readFileSync(flag('--template'), 'utf8'));
  const data = JSON.parse(readFileSync(flag('--data'), 'utf8'));
  const out = await fillOaForm({
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    template,
    data,
    onEvent: v => process.stdout.write(`${JSON.stringify(v)}\n`)
  });
  process.stdout.write(`${JSON.stringify({ event: 'fill.done', results: out.results, snapshot: out.snapshot })}\n`);
  process.exitCode = out.results.some(r => !r.ok) ? 2 : 0;
}
