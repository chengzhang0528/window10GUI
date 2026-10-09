/*
 * OA 开单导航：冷启动 → 门户 →「流程」→「新建流程」→ 点目标表单条目。
 *
 * 为什么需要它（已实测沉淀）：
 *   引擎只会 attach 到已存在的 static4form 标签页。冷启动的 Chrome 可能停在
 *   about:blank 或残留标签页，此时引擎报 CHROME_TARGET_NOT_FOUND —— 开单步骤走不通。
 *   此前全靠手工，导致"会话一丢就得重新推理"。本脚本把这条路径固定下来。
 *
 * 实测路径（2026-09-23，oa.united-imaging.com）：
 *   1. chrome.navigate → https://oa.united-imaging.com/wui/index.html
 *   2. 顶部主菜单：div.e8header-top-menu-item 中 innerText === '流程'（第 2 项，index 1）
 *      —— 注意 chrome.click 的 text 参数不过滤，故必须在页面内按 innerText 精确选中，
 *         否则会点到「门户」（第一条同构元素）。
 *   3. 左侧菜单：li.ant-menu-item 中 innerText === '新建流程'
 *      → URL 变为 ...#/main/workflow/add
 *   4. 目录条目：a[innerText === 目标表单名]，父元素为 div.fontItem
 *      → 新开 static4form 标签页（workflowid 由 OA 决定）
 *
 * 用法：
 *   node oa-open-form.mjs --name "UIH-01 采购申请单(上海联影)-SAP"
 */
import { DeskPilotTransport } from './transport.mjs';
import { discoverLiveEndpoint } from './endpoint.mjs';
import { TIMEOUTS } from './timeouts.mjs';

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';
const DEFAULT_PORTAL = 'https://oa.united-imaging.com/wui/index.html';

/** 页面内公共原语（每段 evaluate 不共享作用域，故内联） */
const PRELUDE = `
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const clickByText = (selector, want) => {
    const el = Array.from(document.querySelectorAll(selector))
      .find(e => norm(e.innerText) === want);
    if (!el) return { clicked: false, seen: Array.from(document.querySelectorAll(selector)).map(e => norm(e.innerText)).slice(0, 20) };
    el.click();
    return { clicked: true, text: norm(el.innerText) };
  };
`;

export async function openOaForm({
  name,
  executable = DEFAULT_EXECUTABLE,
  endpoint,
  portal = DEFAULT_PORTAL,
  onEvent = () => {}
} = {}) {
  if (!name) throw new Error('openOaForm: name is required (目标表单名，如 "UIH-01 采购申请单(上海联影)-SAP")');
  const transport = new DeskPilotTransport({ executable });
  const t0 = Date.now();
  const step = (s, extra = {}) => onEvent({ event: 'open.step', step: s, elapsed_ms: Date.now() - t0, ...extra });

  // **CDP 断连重试**：点「流程」会触发 OA 的 SPA 路由切换，页面/框架被替换，
  // 正在飞行的 CDP 连接随之断开 —— 实测报
  //   CHROME_CDP_DISCONNECTED: The Chrome DevTools connection is no longer open.
  // 打在 `menu.begin` 这一步上，导致「打开表单」整步失败（占全部偶发失败的大部分）。
  // 这是**瞬态**的：重新 attach + 重发 evaluate 即可。故对 evaluate 类调用做有界重试。
  const evalWithRetry = async (params, tries = 4) => {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await transport.request('chrome.evaluate', params, { timeoutMs: TIMEOUTS.requestUi });
      } catch (e) {
        lastErr = e;
        const transient = e?.code === 'CHROME_CDP_DISCONNECTED'
          || e?.code === 'CHROME_CDP_UNAVAILABLE'
          || e?.code === 'CHROME_ELEMENT_NOT_FOUND'
          || e?.retryable === true;
        if (!transient || i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 500 + i * 400));
        // **必须重新 attach**：断连后原连接已死，不重连就只是对同一根死连接重发
        // （实测报 `CHROME_CDP_DISCONNECTED: No Chrome page target is attached`）。
        //
        // 重连策略要**按优先级依次尝试**，不能只试一个条件：
        //   · `wui/index.html` 在点「流程」之后会变成 `#/main/workflow/add`，此时不再匹配；
        //   · 所以再补一个 `oa.united-imaging.com`（门户与开单页都在这个域下）。
        // 需要自己列 targets 挑，因为 attach 的 url_contains 只是一个子串条件。
        try {
          const tl = await transport.request('chrome.targets', at({}), { timeoutMs: TIMEOUTS.request }).catch(() => null);
          const pages = (tl?.targets ?? []).filter((t) => t.type === 'page' && typeof t.url === 'string');
          // 优先：当前正在跑 OA 的那个页面（门户或开单页都算）
          const oa = pages.filter((t) => t.url.includes('oa.united-imaging.com'));
          const pick = oa[oa.length - 1] ?? pages[pages.length - 1];
          if (pick) {
            await transport.request('chrome.attach', at({ target_id: pick.target_id }), { timeoutMs: TIMEOUTS.requestUi }).catch(() => {});
          }
        } catch { /* 重连失败也继续重试 evaluate */ }
        onEvent({ event: 'open.step', step: 'evaluate.retry', attempt: i + 1, code: e?.code });
      }
    }
    throw lastErr;
  };
  const closed = [];
  const errors = [];
  try {
    step('ensure.begin');
    // 先找活着的实例再决定是否启动：直接 auto_start 会在"已有实例占着 profile"时
    // 报 CHROME_LAUNCH_FAILED（新进程立刻退出），而那个实例其实健康。详见 endpoint.mjs。
    //
    // **发现要重试**：`discoverLiveEndpoint` 的探测带短超时，浏览器正忙于 SPA 路由切换时
    // 可能**瞬时探不到**那个健康实例，于是落入 `auto_start` 分支 —— 旧实例占着 profile，
    // 新进程立刻退出 → `CHROME_LAUNCH_FAILED`（实测第 12 轮就是这样失败的）。
    // 因此先重试几次发现，确实找不到才允许启动。
    let live = null;
    for (let i = 0; i < 3 && !live; i++) {
      live = await discoverLiveEndpoint(
        (m, p, o) => transport.request(m, p, o),
        { timeoutMs: TIMEOUTS.requestUi, explicit: endpoint }
      ).catch(() => null);
      if (!live) await new Promise((r) => setTimeout(r, 800));
    }
    const ensured = await transport.request('chrome.ensure',
      live ? { endpoint: live, profile_mode: 'managed', auto_start: false }
           : { profile_mode: 'managed', auto_start: true },
      { timeoutMs: TIMEOUTS.ensure });
    const ep = ensured?.endpoint ?? live ?? endpoint;
    step('ensure.done', { endpoint: ep, page_state: ensured?.page_state });

    // 后续所有 chrome.* 都必须带上解析出来的 ep。
    // 实测（2026-09-23）：若漏了 endpoint，CLI 会自行挑目标，
    // 表现为点不到「流程」菜单（拿到的是门户里其它标签的文本）。
    const at = params => (ep ? { ...params, endpoint: ep } : params);

    // 判断"是不是可用的门户页"，不能只看域名。
    // 实测（2026-09-23）：`#/main/workflow/add` 也在 `united-imaging.com` 域下，
    // 但它**没有**门户顶部菜单，此时点「流程」会得到 `OPEN_MENU_NOT_FOUND: []`。
    // 所以判据改为：**页面里真的有门户菜单**（`.e8header-top-menu-item`）。
    const probe = await transport.request('chrome.evaluate', at({
      expression: `(() => ({
        url: location.href,
        hasPortalMenu: !!document.querySelector('.e8header-top-menu-item'),
      }))();`,
      timeout_ms: TIMEOUTS.request,
    }), { timeoutMs: TIMEOUTS.request });
    const here = probe?.value?.url ?? '';
    const hasPortalMenu = probe?.value?.hasPortalMenu === true;
    if (!hasPortalMenu) {
      step('navigate.begin', { from: here, reason: hasPortalMenu ? 'ok' : 'no_portal_menu' });
      await transport.request('chrome.navigate', at({ url: portal, timeout_ms: TIMEOUTS.requestUi }), { timeoutMs: TIMEOUTS.requestUi });
      step('navigate.done');
      // 导航后等门户菜单真正渲染出来再继续，否则紧接着的点击仍会落空
      await transport.request('chrome.wait', at({
        condition: 'element', selector: '.e8header-top-menu-item', timeout_ms: TIMEOUTS.requestUi,
      }), { timeoutMs: TIMEOUTS.requestUi + 2000 }).catch(() => {});
    }

    step('menu.begin');
    // 点「流程」会触发 SPA 路由切换。**先给页面一点时间稳定**，再点；
    // 并且点击后**不要立刻发下一条 evaluate** —— 路由切换期间连接会断，
    // 立刻发就会撞上 `CHROME_CDP_DISCONNECTED`。
    await new Promise((r) => setTimeout(r, 600));
    const menu = await evalWithRetry(at({
      expression: `(() => { ${PRELUDE} return clickByText('.e8header-top-menu-item', '流程'); })()`,
      timeout_ms: TIMEOUTS.requestUi
    }));
    if (!menu?.value?.clicked) throw new Error(`OPEN_MENU_NOT_FOUND: ${JSON.stringify(menu?.value?.seen ?? [])}`);
    step('menu.done');
    await new Promise((r) => setTimeout(r, 1200));   // 等路由切换完成

    step('newflow.begin');
    const nf = await evalWithRetry(at({
      expression: `(() => { ${PRELUDE} return clickByText('li.ant-menu-item', '新建流程'); })()`,
      timeout_ms: TIMEOUTS.requestUi
    }));
    if (!nf?.value?.clicked) throw new Error(`OPEN_NEWFLOW_NOT_FOUND: ${JSON.stringify(nf?.value?.seen ?? [])}`);
    step('newflow.done');
    await new Promise((r) => setTimeout(r, 1200));   // 等目录渲染

    // 目录是异步渲染的：等目标条目出现再点，避免拿到空列表。
    step('catalog.begin');
    await transport.request('chrome.wait', at({
      condition: 'element', selector: 'a', text: name, timeout_ms: TIMEOUTS.requestUi
    }), { timeoutMs: TIMEOUTS.requestUi + TIMEOUTS.request }).catch(() => {});
    const open = await evalWithRetry(at({
      expression: `(() => { ${PRELUDE} return clickByText('a', ${JSON.stringify(name)}); })()`,
      timeout_ms: TIMEOUTS.requestUi
    }));
    if (!open?.value?.clicked) throw new Error(`OPEN_FORM_NOT_FOUND: ${JSON.stringify(open?.value?.seen ?? [])}`);
    step('catalog.done');

    // 开单会新开 static4form 标签页；等它出现，确认导航真的落地，而不是只"点了按钮"。
    step('verify.begin');
    // 必须在点击**之前**记录已有的 static4form 标签，之后只认"新增的那一张"。
    // 实测踩过：这里原先用 find() 取**第一个** static4form，结果一直返回上一轮残留的
    // 旧标签页（wfid=2211），并把它当作本次开单结果上报 form_opened:true —— 而真正
    // 新开的 2562 根本没被检查。假阳性一路传导：引擎 attach 到那张陈旧/未渲染的页，
    // 三个 select 全部 open_timeout（下拉打不开），排查方向被彻底带偏。
    const before = await transport.request('chrome.targets', at({}), { timeoutMs: TIMEOUTS.request })
      .then(r => new Set((r?.targets ?? []).filter(t => (t.url ?? '').includes('static4form')).map(t => t.target_id)))
      .catch(() => new Set());
    let formTarget = null;
    for (let i = 0; i < 15 && !formTarget; i++) {
      const targets = await transport.request('chrome.targets', at({}), { timeoutMs: TIMEOUTS.request });
      // 候选先按 target 元数据里的 static4form 粗筛；**但必须再用页内 location.href 复核**。
      //
      // 为什么：OA 是 hash 路由 SPA，切页靠 history.pushState，不产生真实导航。
      // chrome.targets 返回的 url 因此会**停留在上一次真实导航的地址**（陈旧元数据）。
      // 实测（2026-09-24）：一个 target 明明报着 `static4form?...workflowid=2211`，
      // 页内 location.href 实际是 `wui/index.html#/main/workflow/add`（门户页），
      // 行数/输入框全为 0。于是脚本把它当"表单页"选中 → 一路 rows:0 →
      // 上层报 not_rendered，而真正的原因与"渲染慢"毫无关系。
      const forms = (targets?.targets ?? []).filter(t => (t.url ?? '').includes('static4form'));
      const fresh = forms.filter(t => !before.has(t.target_id));
      const ordered = (fresh.length ? fresh : forms).slice().reverse();
      for (const cand of ordered) {
        const live = await transport.request('chrome.evaluate', at({
          target_id: cand.target_id,
          expression: `(() => ({ href: location.href,
                                rows: document.querySelectorAll('tr').length,
                                inputs: document.querySelectorAll('input[id^=field]').length,
                                selects: document.querySelectorAll('.ant-select').length }))()`,
          timeout_ms: TIMEOUTS.requestUi
        }), { timeoutMs: TIMEOUTS.requestUi }).then(r => r?.value ?? null).catch(() => null);
        // 两条都要满足：**页内真实地址**是 static4form，且字段确实渲染出来了。
        const liveIsForm = typeof live?.href === 'string' && live.href.includes('static4form');
        const rendered = Boolean(live && (live.rows > 0 || live.inputs > 0 || live.selects > 0));
        if (liveIsForm && rendered) {
          formTarget = cand;
          step('verify.rendered', { ...live, target_id: cand.target_id });
          break;
        }
        step('verify.skip', { target_id: cand.target_id, liveIsForm, rendered,
                              href: (live?.href ?? cand.url ?? '').slice(0, 90) });
      }
      if (!formTarget && i === 14) step('verify.not_rendered', { reason: 'no_static4form_tab_rendered_form' });
      if (!formTarget) await new Promise(r => setTimeout(r, 500));
    }
    step('verify.done', { form_opened: Boolean(formTarget), target_id: formTarget?.target_id ?? null });
    return {
      status: formTarget ? 'form_opened' : 'form_not_opened',
      endpoint: ep,
      name,
      target_id: formTarget?.target_id ?? null,
      url: formTarget?.url ?? null,
      closed, errors, elapsed_ms: Date.now() - t0
    };
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('oa-open-form.mjs')) {
  const flag = n => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const name = flag('--name');
  if (!name) { process.stderr.write('usage: --name "<目标表单名>"\n'); process.exit(2); }
  const result = await openOaForm({
    name,
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    portal: flag('--portal') ?? DEFAULT_PORTAL,
    onEvent: v => process.stderr.write(`${JSON.stringify(v)}\n`)
  });
  process.stdout.write(`${JSON.stringify({ event: 'open.done', ...result })}\n`);
  process.exitCode = result.status === 'form_opened' ? 0 : 2;
}
