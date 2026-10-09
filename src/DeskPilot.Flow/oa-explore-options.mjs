/*
 * OA 表单「穷尽探查」：把每个控件能选什么、选了之后页面怎么变，全部记录下来。
 *
 * 这是正确机制的核心一步。之前的问题是把探查和验证混在一起：
 * 跑到某个字段失败 → 改模板 → 重跑 → 再失败，每次只看到当前那一个字段。
 * 正确做法是先**一次性穷尽**所有控件的行为，产出一份机器可读的"表单行为字典"，
 * 再据此造数据、最后跑一次计时。
 *
 * 记录内容：
 *   - select        : 展开后可见下拉的全部选项文本
 *   - browser-*     : 打开弹窗后的全部候选行、搜索框数量、按钮、是否有确认按钮
 *   - radio         : 每组的全部标签
 *   - 联动          : 选择某值后，字段集合/必填标记/可见性的变化（before/after diff）
 *
 * 用法：
 *   node oa-explore-options.mjs [--endpoint ...] [--out options-report.json]
 *   node oa-explore-options.mjs --probe-linkage   # 额外做"选值→看变化"的联动探查
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

/** 页面内：表单"指纹" —— 用来比较选择前后的差异（哪些字段在/不在、是否必填） */
const FINGERPRINT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const set = {};
  document.querySelectorAll('[data-fieldname]').forEach(el => {
    const fn = el.getAttribute('data-fieldname');
    const outer = el.closest('.wea-field') || el;
    set[fn] = {
      visible: vis(el),
      readonly: /wea-field-readonly/.test((outer.className || '').toString()),
      required: /required/.test((el.className || '').toString()) || !!el.querySelector('.required')
    };
  });
  return set;
})();`;

/** 页面内：当前可见的下拉选项 */
const DROPDOWN_OPTIONS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const dds = Array.from(document.querySelectorAll('.ant-select-dropdown')).filter(vis);
  const out = [];
  dds.forEach(d => {
    const items = Array.from(d.querySelectorAll('.ant-select-dropdown-menu-item, .ant-select-item-option'))
      .filter(vis).map(i => (i.innerText || '').trim()).filter(Boolean);
    if (items.length) out.push(items);
  });
  return out;
})();`;

/** 页面内：当前可见弹窗的候选与结构 */
const MODAL_CONTENT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const modals = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
  return modals.map(m => {
    const rows = [];
    m.querySelectorAll('table.ant-table-body tbody tr, table.ant-table-fixed tbody tr').forEach(tr => {
      if (!vis(tr)) return;
      const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()).filter(Boolean);
      if (cells.length) rows.push(cells.slice(0, 8));
    });
    const inputs = Array.from(m.querySelectorAll('input')).filter(vis)
      .map(i => {
        // 记录搜索框的**标签**，而不只是 id。
        // 实测教训：币种弹窗的搜索框标签顺序（币种名称|币种编码）与表头顺序
        // （币种编码|币种名称）**相反**，只按序号/表头推断会必错。标签只能从 DOM 里读。
        const r = i.getBoundingClientRect();
        let label = null;
        let p = i.parentElement;
        for (let k = 0; k < 5 && p; k++) {
          const t = (p.innerText || '').replace(/\\s+/g, '').trim();
          if (t && t.length < 14 && t !== (i.value || '').trim()) { label = t; break; }
          p = p.parentElement;
        }
        // 同级搜索框按 x 排序可判断左右顺序
        return { id: i.id || null, cls: (i.className || '').toString().slice(0, 40), ph: i.placeholder || null, label, x: Math.round(r.x) };
      });
    const btns = Array.from(m.querySelectorAll('button')).filter(vis)
      .map(b => ({ t: (b.innerText || '').trim(), cls: (b.className || '').toString().slice(0, 50) })).filter(b => b.t);
    const title = m.querySelector('.ant-modal-title');
    const headers = Array.from(m.querySelectorAll('thead th')).map(th => (th.innerText || '').trim()).filter(Boolean);
    // 分页/排序信息：币种弹窗按编码倒序分页，首页没有 CNY —— 不记录这个，
    // 就会误以为"搜不到 = 数据不存在"，实际是"没搜对列 + 目标不在首页"。
    const pager = (() => {
      const t = (m.innerText || '');
      const total = (t.match(/共\\s*(\\d+)\\s*条/) || [])[1] ?? null;
      const page = (t.match(/(\\d+)\\s*\\/\\s*(\\d+)/) || []).slice(1);
      const size = (t.match(/(\\d+)\\s*条\\/页/) || [])[1] ?? null;
      return { total, page: page[0] ?? null, pages: page[1] ?? null, pageSize: size };
    })();
    return {
      title: title ? (title.innerText || '').trim() : null,
      rowCount: rows.length,
      rows: rows.slice(0, 15),
      headers,
      searchInputs: inputs,
      buttons: btns,
      pager,
      hasConfirm: btns.some(b => /确定|确认|提交|保存/.test(b.t))
    };
  });
})();`;

/** 页面内：关闭所有弹窗/下拉。
 *  实测：弹窗上有 .ant-modal-close（X），但页面内 el.click() 关不掉它 ——
 *  和"打开"一样，必须用 chrome.click 可信输入。这里返回待关闭元素并打标，
 *  由调用方用 chrome.click 点。 */
const MARK_CLOSE = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  let n = 0;
  document.querySelectorAll('.wea-browser-modal .ant-modal-close').forEach(x => {
    if (vis(x)) { x.setAttribute('data-dp-close', '1'); n++; }
  });
  // 下拉用 Esc/body 点击收起即可
  return n;
})();`;

export async function exploreOptions({ executable = DEFAULT_EXECUTABLE, endpoint, probeLinkage = false, censusPath, onEvent = () => {} } = {}) {
  const transport = new DeskPilotTransport({ executable });
  const ep = endpoint ?? readRecordedEndpoint();
  const withEndpoint = p => (ep ? { ...p, endpoint: ep } : p);
  const t0 = Date.now();
  const run = async (expression, label) => {
    try {
      const r = await transport.request('chrome.evaluate', withEndpoint({ expression, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi });
      if (label) onEvent({ event: 'opt.step', step: label });
      return r?.value;
    } catch (e) {
      // 把出错的表达式与调用标签一并带出来 —— 只留一句 SyntaxError 根本无从定位
      e.expressionSent = String(expression).slice(0, 400);
      e.expressionLabel = label ?? '(no-label)';
      e.expressionLen = String(expression).length;
      e.expressionHead = String(expression).slice(0, 60);
      e.expressionTail = String(expression).slice(-60);
      throw e;
    }
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /** 关闭所有可见弹窗。
   *
   *  必须用**可信点击**，且关闭方式要按可靠性逐个尝试并回读确认：
   *    ① Esc（先收掉原生自动填充浮层 —— 它会盖住底部按钮吃掉点击）
   *    ② 「取消」按钮（实测最可靠）
   *    ③ 右上角 X（.ant-modal-close，个别弹窗无效或不存在）
   *
   *  实测教训：探查器原来只点 X，在 UIH-02 上关不掉 → 残留弹窗让"等弹窗出现"
   *  立刻被旧弹窗满足 → 每个字段都记成"未开"，整份报告 0 个弹窗。这与引擎里踩过的
   *  "逐字段错位"是同一个坑：**离开时要确认真的离开了**。 */
  const closeModals = async (label) => {
    const countVisible = () => run(`(() => {
      const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis).length;
    })()`, null);
    const clickMarked = async (attr, markExpr, unmarkExpr) => {
      const marked = await run(markExpr, null).catch(() => 0);
      if (!marked) return false;
      await run(`(() => { const e = document.querySelector('[${attr}="1"]'); if (e) e.scrollIntoView({block:'center'}); return true; })()`, null).catch(() => {});
      await wait(150);
      await transport.request('chrome.click', withEndpoint({
        selector: `[${attr}="1"]`, timeout_ms: TIMEOUTS.requestUi
      }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
      await run(unmarkExpr, null).catch(() => {});
      await wait(350);
      return true;
    };
    for (let round = 0; round < 4; round++) {
      if ((await countVisible().catch(() => 0)) === 0) break;
      // ① Esc 收掉原生浮层
      await transport.request('input.key', { key: 'Escape' }, { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
      await wait(200);
      if ((await countVisible().catch(() => 0)) === 0) break;
      // ② 取消
      const okCancel = await clickMarked('data-dp-cancel',
        `(() => { const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
             return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
           const ms = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
           const m = ms[ms.length - 1]; if (!m) return 0;
           const b = Array.from(m.querySelectorAll('button')).find(x => /取\\s*消/.test(x.innerText || ''));
           if (!b) return 0; b.setAttribute('data-dp-cancel', '1'); return 1; })()`,
        `(() => { document.querySelectorAll('[data-dp-cancel]').forEach(e => e.removeAttribute('data-dp-cancel')); return true; })()`);
      if (okCancel) continue;
      // ③ X
      const okX = await clickMarked('data-dp-close', MARK_CLOSE,
        `(() => { document.querySelectorAll('[data-dp-close]').forEach(e => e.removeAttribute('data-dp-close')); return true; })()`);
      if (okX) continue;
    }
    const left = await countVisible().catch(() => -1);
    if (label) onEvent({ event: 'opt.closed', step: label, left });
    return left;
  };

  try {
    await transport.request('chrome.attach', withEndpoint({ url_contains: 'static4form' }), { timeoutMs: TIMEOUTS.requestUi });
    await transport.request('chrome.wait', withEndpoint({ selector: '#requestname', condition: 'element', timeout_ms: TIMEOUTS.requestUi }),
      { timeoutMs: TIMEOUTS.requestUi + TIMEOUTS.request }).catch(() => null);
    // 开工前先清掉**上一个表单遗留的弹窗**。
    //
    // 实测（2026-09-23，切到 UIH-02 时）：上一个表单的弹窗还开着（甚至内容还指着
    // UIH-01 的 SAP_币种），此时读弹窗内容的表达式会直接抛 SyntaxError —— 而那些
    // 表达式本身是合法的。遗留状态会让后面的每一次探测都失去意义。
    // 先把环境清干净，再开始穷尽。
    await closeModals('startup-clean').catch(() => {});
    for (let i = 0; i < 20; i++) {
      const n = await transport.request('chrome.evaluate', withEndpoint({
        expression: 'document.querySelectorAll("[data-fieldname]").length', timeout_ms: TIMEOUTS.request
      }), { timeoutMs: TIMEOUTS.request }).then(r => r?.value).catch(() => 0);
      if (n > 0) break;
      await wait(400);
    }

    const baseFingerprint = await run(FINGERPRINT, 'fingerprint');
    // **必须记录当前页面的 URL**：它是判断"这份穷尽报告属于哪张表单"的唯一依据。
    // 早前这里硬编码 `url: null`，导致下游（oa-gate / oa-run）无法核对报告与模板是否同一张表单 ——
    // 实测 UIH-02 有两张表单都以 uih02 开头（借款 2254 / 差旅 2211），
    // 一旦拿"借款"的穷尽报告去判"差旅"的表单，gate 2 会报"9/9 个字段没有观察到弹窗"，
    // 而其实那 9 个弹窗都被正常打开过。记录 url 后即可按 workflowid 认领。
    const hereUrl = await run(`(() => ({ url: location.href }))();`, 'url').then(r => r?.url ?? null).catch(() => null);
    const report = { url: hereUrl, base: baseFingerprint, selects: {}, browsers: {}, radios: {}, linkage: {}, exploredAt: new Date().toISOString() };

    // ---- 1) select：逐个展开，读全部选项 ----
    //
    // 分类**直接复用普查报告**（oa-explore-form.mjs 的 fields），不要再自己扫一遍 DOM。
    // 实测（第三张表单）：这里独立扫 DOM 时，wllx(物料类型) 被判成了别的类型，
    // 于是整张表单项"0 个下拉"，而普查报告明明写着 kind=select、w=334。
    // 两处各扫一遍 = 两套判据漂移；以普查为准，单一事实来源。
    const kindsFromCensus = censusPath ? (() => {
      try {
        const rep = JSON.parse(readFileSync(censusPath, 'utf8'));
        const m = {};
        for (const f of rep.fields ?? []) m[f.fieldname] = f.kind;
        return Object.keys(m).length ? m : null;
      } catch { return null; }
    })() : null;
    const kindOf = kindsFromCensus ?? await run(`(() => {
      const out = {};
      document.querySelectorAll('[data-fieldname]').forEach(el => {
        const fn = el.getAttribute('data-fieldname');
        if (el.querySelector('.wea-associative-search')) out[fn] = 'browser';
        else if (el.querySelector('input[type=radio]')) out[fn] = 'radio';
        else if (el.querySelector('.ant-select')) out[fn] = 'select';
        else if (el.querySelector('input:not([type=hidden]), textarea')) out[fn] = 'text';
        else out[fn] = 'other';
      });
      return out;
    })()`, 'kinds');
    // 普查里的 browser 有 browser-clickable / browser-select 两种写法，统一成 browser
    for (const [k, v] of Object.entries(kindOf)) {
      if (v === 'browser-clickable' || v === 'browser-select') kindOf[k] = 'browser';
    }

    for (const [fn, kind] of Object.entries(kindOf ?? {})) {
      if (kind !== 'select') continue;
      // 与 browser 分支同理：用**实时几何**判断，不要依赖 baseFingerprint。
      // 实测（第三张表单）：明细行里的 select（如 wllx 物料类型）在 fingerprint 里
      // 判不出可见，整批被跳过 → `selectsWithOptions: 0`，看起来像"这张表单没有下拉"。
      const liveSel = await run(`(() => {
        const el = document.querySelector('[data-fieldname=${fn}]');
        if (!el) return { present: false };
        const outer = el.closest('.wea-field') || el;
        const readonly = /wea-field-readonly/.test((outer.className || '').toString()) || !!el.querySelector('.wea-field-readonly');
        const s = el.querySelector('.ant-select');
        const sr = s ? s.getBoundingClientRect() : null;
        return { present: true, readonly, hasSelect: !!s,
                 w: sr ? Math.round(sr.width) : 0, h: sr ? Math.round(sr.height) : 0,
                 widgetId: (el.querySelector('.wea-select') || {}).id || null };
      })()`, fn + ':live');
      if (!liveSel?.present || liveSel.readonly || !liveSel.hasSelect || liveSel.w === 0) {
        report.selects[fn] = { options: [], note: !liveSel?.present ? 'not_in_dom'
          : liveSel.readonly ? 'readonly' : !liveSel.hasSelect ? 'no_ant_select' : 'zero_size' };
        continue;
      }
      try {
        // 用 chrome.click 点 .ant-select 本体。页面内 el.click() 对这类组件不可靠
        // （见 universal-pitfalls #10：没报错不等于生效）。
        await run(`(() => { const el = document.querySelector('[data-fieldname=${fn}] .ant-select'); if (el) el.scrollIntoView({block:'center'}); return !!el; })()`, fn + ':scroll');
        await wait(250);
        const clicked = await transport.request('chrome.click', withEndpoint({
          selector: `[data-fieldname=${fn}] .ant-select`, timeout_ms: TIMEOUTS.requestUi
        }), { timeoutMs: TIMEOUTS.requestUi }).then(r => r?.clicked === true).catch(() => false);
        await wait(1000);
        const opts = await run(DROPDOWN_OPTIONS, fn + ':read');
        const list = (opts ?? []).flat();
        // 记录"点了但没选项"的字段，而不是静默跳过 —— gate 2 靠这个判断是否穷尽。
        report.selects[fn] = { clicked, options: list, note: list.length ? undefined : '展开后没有可见选项（可能不可点/被联动禁用）' };
        await closeModals(fn + ':close');
        await wait(300);
      } catch (e) { report.selects[fn] = { error: String(e?.message ?? e), options: [] }; }
    }

    // ---- 2) browser：逐个打开，读候选 ----
    let lastModalTitle = null;
    let sameTitleStreak = 0;
    for (const [fn, kind] of Object.entries(kindOf ?? {})) {
      if (kind !== 'browser') continue;
      // 可见性判断改用**实时几何**，不要依赖 baseFingerprint。
      //
      // 实测（2026-09-23，换到 UIH-02 时踩到）：fingerprint 是按 wea-field 祖先建的，
      // 不同表单的 DOM 结构不一样，于是它在 UIH-02 上把 13 个**完全正常**的
      // browser 字段全判成不可见 —— 探查器一个弹窗都没打开，报告却是"0 个弹窗"，
      // 看起来像"这些字段没有弹窗"，实际是守卫条件把整批字段挡掉了。
      // 判据应当直接问 DOM：有尺寸、且真的存在放大镜按钮。
      // （注意：这段注释里不要出现反引号，会截断上面的模板字符串。）
      const live = await run(`(() => {
        const el = document.querySelector('[data-fieldname=${fn}]');
        if (!el) return { present: false };
        const r = el.getBoundingClientRect();
        const outer = el.closest('.wea-field') || el;
        const readonly = /wea-field-readonly/.test((outer.className || '').toString()) || !!el.querySelector('.wea-field-readonly');
        const btn = el.querySelector('button.ant-btn-icon-only');
        const br = btn ? btn.getBoundingClientRect() : null;
        return { present: true, w: Math.round(r.width), h: Math.round(r.height), readonly,
                 hasBtn: !!btn, btnW: br ? Math.round(br.width) : 0, btnH: br ? Math.round(br.height) : 0 };
      })()`, fn + ':live');
      if (!live?.present || live.readonly || !live.hasBtn || live.w === 0) {
        report.browsers[fn] = { via: 'skipped', modals: [], skipReason:
          !live?.present ? 'not_in_dom' : live.readonly ? 'readonly' : !live.hasBtn ? 'no_magnifier_button' : 'zero_size' };
        continue;
      }
      try {
        // **先确保没有任何弹窗残留**，再去点下一个字段。
        //
        // 实测（UIH-02）：上一个字段的弹窗没关干净时，"等弹窗出现"的循环会被旧弹窗
        // 立即满足 → 本字段其实没开成，却记成"已开"，读到的内容还是上一个弹窗的。
        // 这与引擎里踩过的"逐字段错位"是同一个坑，探查器也要防。
        await closeModals(fn + ':pre-close');
        await wait(300);
        // 滚进视口，再用 chrome.click（CDP 可信输入）打开。
        // 实测：页面内 el.click() 对 wea-associative 无效 —— 返回成功但弹窗不出现，
        // 会误报成"这个字段没有弹窗"。必须走可信输入。
        await run(`(() => { const el = document.querySelector('[data-fieldname=${fn}]'); if (el) el.scrollIntoView({block:'center'}); return true; })()`, fn + ':scroll');
        await wait(300);
        // 触发元素：**放大镜按钮** button.ant-btn-icon-only。
        // 实测：点输入区（#fieldNNNNNspan / .wea-associative-click / 内层 input）都不会开弹窗，
        // 只有这个按钮会 —— 这是连续三次猜错后靠截图才看出来的。见 universal-pitfalls #12。
        let via = null;
        const clickRes = await transport.request('chrome.click', withEndpoint({
          selector: `[data-fieldname=${fn}] button.ant-btn-icon-only`, timeout_ms: TIMEOUTS.requestUi
        }), { timeoutMs: TIMEOUTS.requestUi })
          .then(r => ({ clicked: r?.clicked === true, raw: r }))
          .catch((e) => ({ clicked: false, err: String(e?.message ?? e), code: e?.code }));
        via = 'chrome.click:button.ant-btn-icon-only';
        const clickedOk = clickRes?.clicked === true;
        // 等弹窗真的出现（最多约 8s），别固定 sleep —— 弹窗晚一帧会让本字段读到"无弹窗"，
        // 而它的弹窗留给下一个字段，造成逐字段错位。见 universal-pitfalls #15。
        //
        // 判据必须是"**弹窗元素存在**"，不能是"弹窗里有行"。
        // 实测（UIH-02）：MODAL_CONTENT 只返回有候选行的弹窗，于是「弹窗已开但行数为 0」
        // 被读成"没有弹窗"，整份报告写成 0 个弹窗 —— 实际弹窗开得好好的。
        // 等待条件写错的第 N 次：条件必须在"我真正要的东西还没出现"时为假。
        const modalOpen = () => run(`(() => {
          const vis = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
          const ms = Array.from(document.querySelectorAll('.wea-browser-modal')).filter(vis);
          return ms.length;
        })()`, null);
        let openCount = 0;
        for (let w = 0; w < 18; w++) {
          openCount = (await modalOpen()) ?? 0;
          if (openCount > 0) break;
          await wait(400);
        }
        // 弹窗开后再给它一点时间渲染表格内容
        if (openCount > 0) await wait(1200);
        const modalsRead = (await run(MODAL_CONTENT, null)) ?? [];
        // 弹窗身份校验：读到的标题必须是**这一次点击**开出来的。
        //
        // 实测（UIH-02）：末尾 4 个字段全部读到同一个 [SAP_会计科目] —— 因为前一个
        // 字段的弹窗没关掉，"等弹窗出现"被旧弹窗立即满足，于是每个字段都记成"已开"
        // 却都在读旧内容。这是引擎里踩过的"逐字段错位"，探查器同样会中招。
        // 判据：若上一字段的弹窗标题与本字段相同，极可能是没关干净 —— 记为可疑。
        const thisTitle = modalsRead?.[0]?.title ?? null;
        const prevTitle = lastModalTitle;
        lastModalTitle = thisTitle;
        if (thisTitle && prevTitle && thisTitle === prevTitle) {
          sameTitleStreak++;
        } else {
          sameTitleStreak = 0;
        }
        const suspicious = sameTitleStreak >= 2;   // 连续 3 个同标题 → 基本可判定为复用旧弹窗
        // 记录"字段当前值"，因为弹窗身份随上游状态变化（同一 jf 按钮先后开出过
        // 「经费号_SAP采购」和「关联采购订单」）。没有状态快照，这份穷尽就是不可复现的。
        const stateSnap = await run(`(() => {
          const out = {};
          document.querySelectorAll('[data-fieldname]').forEach(el => {
            const k = el.getAttribute('data-fieldname');
            const inp = el.querySelector('input:not([type=hidden]), textarea');
            const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
            const v = inp ? String(inp.value || '').trim() : '';
            if (t || v) out[k] = (v || t).slice(0, 40);
          });
          return out;
        })()`, fn + ':state');
        report.browsers[fn] = { via, clicked: clickedOk, clickErr: clickedOk ? undefined : clickRes?.err,
                                modalOpened: openCount > 0, suspiciousReuse: suspicious || undefined,
                                modals: modalsRead ?? [], stateAtObservation: stateSnap ?? {} };
        await closeModals(fn + ':close');
        await wait(400);
      } catch (e) {
        report.browsers[fn] = { error: String(e?.message ?? e), code: e?.code,
                                len: e?.expressionLen, head: e?.expressionHead, tail: e?.expressionTail };
      }
    }

    // ---- 3) radio：读每组的全部标签 ----
    report.radios = await run(`(() => {
      const out = {};
      document.querySelectorAll('[data-fieldname]').forEach(el => {
        const fn = el.getAttribute('data-fieldname');
        const labels = Array.from(el.querySelectorAll('label.ant-radio-wrapper'))
          .map(l => (l.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
        if (labels.length) out[fn] = labels;
      });
      return out;
    })()`, 'radios');

    // ---- 4) 联动：选一个值，看字段集合怎么变 ----
    if (probeLinkage) {
      const selectFns = Object.keys(report.selects).filter(f => (report.selects[f]?.options ?? []).length);
      for (const fn of selectFns.slice(0, 6)) {
        const opts = report.selects[fn].options;
        const changes = [];
        for (const opt of opts.slice(0, 4)) {
          try {
            const r = await run(`(() => {
              const el = document.querySelector('[data-fieldname=${fn}] .ant-select');
              if (!el) return { err: 'no_select' };
              el.scrollIntoView({block:'center'});
              el.click();
              const dd = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(d => {
                const rr = d.getBoundingClientRect(); return rr.width > 0 && rr.height > 0;
              });
              if (!dd) return { err: 'no_dropdown' };
              const item = Array.from(dd.querySelectorAll('.ant-select-dropdown-menu-item, .ant-select-item-option'))
                .find(i => (i.innerText || '').trim() === ${JSON.stringify(opt)});
              if (!item) return { err: 'no_item' };
              item.click();
              return { ok: true };
            })()`, fn + '=' + opt);
            if (!r?.ok) { changes.push({ value: opt, err: r?.err }); continue; }
            await wait(1200);
            const after = await run(FINGERPRINT, fn + '=after');
            const diff = { value: opt, appeared: [], disappeared: [], becameRequired: [], becameOptional: [] };
            for (const k of Object.keys(after ?? {})) {
              const b = baseFingerprint[k], a = after[k];
              if (!b) { diff.appeared.push(k); continue; }
              if (b.visible && !a.visible) diff.disappeared.push(k);
              if (!b.visible && a.visible) diff.appeared.push(k);
              if (!b.required && a.required) diff.becameRequired.push(k);
              if (b.required && !a.required) diff.becameOptional.push(k);
            }
            changes.push(diff);
          } catch (e) { changes.push({ value: opt, error: String(e?.message ?? e) }); }
        }
        report.linkage[fn] = changes;
      }
    }

    report.elapsed_ms = Date.now() - t0;
    // observed_states：本次观察发生在哪些表单状态下。
    // gate 2 用它判断"弹窗身份随状态变化"的控件是否被真正覆盖过 ——
    // 单状态快照不算穷尽（实测同一 jf 按钮在不同状态下开出不同弹窗）。
    report.observed_states = [{
      at: report.exploredAt,
      label: 'initial',
      values: Object.fromEntries(Object.entries(baseFingerprint ?? {})
        .filter(([k]) => ['cglx', 'xmh', 'jf', 'ck', 'jqr', 'zhglfl', 'xmjd'].includes(k)))
    }];
    return report;
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('oa-explore-options.mjs')) {
  const flag = n => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const report = await exploreOptions({
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    probeLinkage: process.argv.includes('--probe-linkage'),
    censusPath: flag('--report') ?? 'D:/github.com/window10GUI/src/DeskPilot.Flow/.explore-report.json',
    onEvent: v => process.stderr.write(`${JSON.stringify(v)}\n`)
  });
  const out = flag('--out') ?? 'D:/github.com/window10GUI/src/DeskPilot.Flow/.options-report.json';
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  const s = Object.values(report.selects).filter(x => (x.options ?? []).length).length;
  const b = Object.values(report.browsers).filter(x => (x.modals ?? []).length).length;
  process.stdout.write(`${JSON.stringify({ event: 'options.done', out, selectsWithOptions: s, browsersWithRows: b, elapsed_ms: report.elapsed_ms })}\n`);
}
