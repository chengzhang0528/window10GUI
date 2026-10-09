/*
 * DeskPilot Flow 前置清理：关闭残留的 OA 表单标签页。
 *
 * 为什么需要它：
 *   OA 的 UIH-01 采购申请单入口每次点击都会新开一个 static4form 标签页，
 *   而场景的 attach 动作只支持静态条件（target_id / url_contains / title_contains），
 *   无法引用"本次刚创建的那个"标签页。残留标签页会让 attach 命中多个目标，
 *   以 AMBIGUOUS_CHROME_TARGET 主动交接。
 *
 * 做法：
 *   用公开的 chrome.* 方法（ensure / targets / attach / evaluate）清理，
 *   不新增 CLI 命令，也不改任何源码。页面内 window.close() 即可关闭自身标签页；
 *   关闭后该标签页的 CDP 连接会断开，因此每次关闭都重新 ensure 一次。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeskPilotTransport } from './transport.mjs';
import { TIMEOUTS } from './timeouts.mjs';

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';

export async function closeStaleFormTabs({
  executable = DEFAULT_EXECUTABLE,
  urlContains = 'static4form',
  // `urlAny` 命中即算残留（用于一次清掉多种模式）。
  // 为什么要它：实测（2026-09-23）只清 static4form 时，浏览器里**累积了 44 个页面** ——
  // 每跑一张表单都会多留一个 `联影协同` 门户页与若干 `新标签页`。残留一多，
  // chrome.attach 要在几十个标签里挑目标，整轮就开始随机失败（同一场景单跑 4/4 通过，
  // 全套件跑却时好时坏）。清干净后 attach 的目标是确定的。
  urlAny = null,
  keep = 0,
  // 门户页的**额外**保留数（在 keep 之外单独计）。
  // 实测（2026-09-24）门户页会无限累积到 **40+ 个**：每次 `oa-open-form` 都新开一个
  // `#/main/workflow/add` 页并永不回收。危害不是 attach 歧义，而是
  // **`chrome.evaluate`/`chrome.attach` 不带 target_id 时附着到"最近使用的页面"** ——
  // 40 多个门户页抢这个位置时，探针与引擎会随机落到门户页上，于是
  // `#weaSelect_1` 时有时无、页面 `rows:0`，被误读成"下拉渲染时序/竞态"。
  // 门户页同样关不掉，但导航到 about:blank 即可让它不再参与竞争。
  keepPortals = 1,
  // 每轮最多处理几个门户页，防止"清 40 个关不掉的页"把单次清理拖到超时
  // （早前把门户页纳入清理时，单次清理从 ~5s 涨到 14s，8 场景套件直接超时）。
  portalBudget = 24,
  endpoint,
  onEvent = () => {}
} = {}) {
  const transport = new DeskPilotTransport({ executable });
  const closed = [];
  const errors = [];
  const patterns = Array.isArray(urlAny) && urlAny.length ? urlAny : [urlContains];
  // 表单页最多保留 `keep` 个；其它模式（门户/空白页）一律清空
  const isStale = (t) => patterns.some((p) => typeof t.url === 'string' && t.url.includes(p));
  // **保护正在使用的门户页**：它是后续"登录/打开表单"的落脚点。
  // 上面把它一起清掉会导致登录脚本落在一个空白/陌生标签上，报 password_not_found。
  // 这里只在"确有门户页"时保护一个，绝不误保护表单页。
  let protectedTargetId = null;
  try {
    // 必须显式给出 endpoint。不带 endpoint 时 chrome.targets 会连到"第一个可用的调试实例"，
    // 可能是完全无关的浏览器（本机上就有一个占着 9229 的 ChatGPT 桌面应用）。
    // 那样扫描到的页面集是空的，脚本会误报 clean —— 静默漏掉真正的残留标签页。
    const resolvedEndpoint = await resolveEndpoint(transport, endpoint);

    // 记录"上一轮到底还剩几个"。若连续多轮数量不降，说明有页面**关不掉又立刻重现**
    // （实测 2026-09-23：`#/main/workflow/add` 这个标签被浏览器反复重建），
    // 此时继续循环只是空转。必须在**无进展**时退出并如实报 incomplete，
    // 而不是耗满轮次上限后仍报"clean"或让上层误以为清干净了。
    let lastCount = null;
    let stagnant = 0;
    // 本轮已经试过的目标（见下方 victim 选择逻辑：必须轮换，否则会反复操作同一个标签）
    const attempted = new Set();

    // ---- 门户页扫尾：把多余门户页导航到 about:blank ----
    //
    // 为什么必须做：门户页（`/wui/index.html`）每次开单都会新增一个，且**永不回收**，
    // 实测累积到 40+ 个。它们不影响 attach 歧义（引擎按 static4form 绑定），所以
    // 早前被判定为"良性残留"而放过；但真正的危害在别处：
    // **不带 target_id 的 chrome.evaluate / chrome.attach 会附着到"最近使用的页面"**，
    // 40 多个门户页参与竞争时，探针与引擎会随机落到门户页上 ——
    // 现象就是 `#weaSelect_1` 时而存在时而 missing、页面 `rows:0`，
    // 极易被误判为"下拉渲染时序/竞态"。
    // 关不掉没关系：**导航到 about:blank** 就能让它退出竞争（与表单页同一手法）。
    const sweepPortals = async () => {
      let swept = 0;
      try {
        const tt = await transport.request('chrome.targets', { endpoint: resolvedEndpoint }, { timeoutMs: TIMEOUTS.request });
        const portals = (tt?.targets ?? []).filter((x) =>
          x.type === 'page' && typeof x.url === 'string' && x.url.includes('/wui/index.html'));
        // 保留 keepPortals 个（默认 1）供后续登录/开单落脚，其余全部导航走。
        const victims = portals.slice(0, Math.max(0, portals.length - keepPortals)).slice(0, portalBudget);
        for (const v of victims) {
          try {
            await transport.request('chrome.attach', { target_id: v.target_id, endpoint: resolvedEndpoint }, { timeoutMs: TIMEOUTS.requestUi });
            await transport.request('chrome.navigate', { url: 'about:blank', timeout_ms: TIMEOUTS.request }, { timeoutMs: TIMEOUTS.request });
            swept++;
          } catch (error) {
            errors.push({ target_id: v.target_id, phase: 'portal_sweep', code: error?.code ?? String(error) });
          }
        }
        onEvent({ event: 'cleanup.portals', total: portals.length, swept, kept: Math.min(portals.length, keepPortals) });
      } catch (error) {
        errors.push({ phase: 'portal_sweep', code: error?.code ?? String(error) });
      }
      return swept;
    };
    // 所有 clean 出口都先扫门户，再返回。
    const sweepAndReturn = async (payload) => ({ ...payload, portalSwept: await sweepPortals() });

    for (let round = 0; round < 40; round++) {
      const targets = await transport.request('chrome.targets', { endpoint: resolvedEndpoint }, { timeoutMs: TIMEOUTS.request });
      if (targets?.endpoint && targets.endpoint !== resolvedEndpoint) {
        return await sweepAndReturn({ status: 'endpoint_mismatch', endpoint: resolvedEndpoint, actual: targets.endpoint, closed, errors, remaining: -1 });
      }
      const allPages = (targets?.targets ?? []).filter((t) => t.type === 'page');
      // 首次进入时选定一个**门户页**作为保护对象（后续所有轮次都跳过它）。
      // 必须优先选门户而不是随便留一个：留到空白页的话，后续 `oa-login`/`oa-open-form`
      // 会 attach 到一个没有门户菜单的页面上，报 `OPEN_MENU_NOT_FOUND: []`。
      if (protectedTargetId === null) {
        const portal = allPages.find((t) => typeof t.url === 'string' && t.url.includes('/wui/index.html'));
        protectedTargetId = portal?.target_id ?? '';
      }
      const metaMatches = allPages.filter((t) => isStale(t) && t.target_id !== protectedTargetId);
      // **用页内 location.href 复核每一个候选**。
      //
      // 为什么必须：OA 是 hash 路由 SPA，切页走 pushState，不产生真实导航。
      // chrome.targets 的 url 于是会**停在最后一次真实导航**的地址上。实测（2026-09-24）：
      // 5 个 target 报着 `static4form`，页内实际全是 `wui/index.html#/main/workflow/add`
      // （门户页，rows/inputs/selects 全为 0）。这些"披着表单元数据的门户页"每跑一轮
      // 就多一个，越攒越多；而**它们会赢下"最近使用的页面"**，把不带 target_id 的
      // chrome.evaluate/attach 引到门户页上 —— 表现为 `#weaSelect_1` 时而 missing、
      // 页面 rows:0，极易误判成"下拉渲染竞态"。
      // 所以：按**页内真实地址**判定是否残留，而不是按元数据。
      const liveStale = [];
      for (const t of metaMatches) {
        const live = await transport.request('chrome.evaluate', {
          endpoint: resolvedEndpoint, target_id: t.target_id,
          expression: '(() => ({ href: location.href }))()',
          timeout_ms: TIMEOUTS.requestUi
        }, { timeoutMs: TIMEOUTS.requestUi }).then(r => r?.value?.href ?? null).catch(() => null);
        // 读不到（页已消失/CDP 断）→ 当作残留交给下面的关闭流程处理。
        const effective = typeof live === 'string' ? live : (t.url ?? '');
        if (patterns.some((p) => effective.includes(p))) liveStale.push({ ...t, liveUrl: effective });
        else onEvent({ event: 'cleanup.meta_stale', target_id: t.target_id,
                       meta: String(t.url ?? '').slice(0, 80), live: String(effective).slice(0, 80) });
      }
      const matches = liveStale;
      if (matches.length <= keep) {
        return await sweepAndReturn({ status: 'clean', endpoint: resolvedEndpoint, closed, errors, remaining: matches.length });
      }      if (lastCount !== null && matches.length >= lastCount) {
        stagnant++;
        if (stagnant >= 3) {
          // 连续 3 轮数量不降 → 停止空转，并**按真正重要的判据**决定成败：
          //
          //   关键不是"还剩几个页面"，而是"**还有没有多个会命中表单模式的目标**"。
          //   引擎 attach 用的是 `url_contains: static4form`；只要这一个模式的匹配数 ≤1，
          //   就不存在 AMBIGUOUS_CHROME_TARGET，整轮就是确定的。
          //   余下的门户页/空白页是浏览器拒绝关闭的用户标签（`window.close()` 对非脚本
          //   打开的标签无效，实测 126 次尝试零效果），它们**不影响**引擎，属可接受残留。
          //
          // 早期两种写法都踩过：一律 clean → 放过真残留导致 AMBIGUOUS；
          // 一律 incomplete → 前置失败、整轮 0/8。必须按"是否还会造成歧义"判。
          const formPattern = urlContains;
          const stillAmbiguous = (targets?.targets ?? [])
            .filter((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(formPattern)).length;
          if (stillAmbiguous <= 1) {
            return await sweepAndReturn({ status: 'clean', endpoint: resolvedEndpoint, closed, errors, remaining: matches.length,
                     note: '表单页已 <=1（无 attach 歧义）；余下 ' + matches.length + ' 个为用户标签，浏览器拒绝关闭' });
          }
          return { status: 'incomplete', endpoint: resolvedEndpoint, closed, errors, remaining: matches.length,
                   note: '仍有 ' + stillAmbiguous + ' 个表单页清不掉，attach 会歧义' };
        }
      } else {
        stagnant = 0;
      }
      lastCount = matches.length;

      // **逐轮处理不同目标**：早前固定取 `matches[matches.length - 1]`，而该数组顺序稳定，
      // 于是每轮都对着**同一个**标签反复操作 —— `closed` 里出现同一个 id 三次，
      // 其余残留一个都没碰。改成：每轮处理"还没试过的"第一个目标。
      const victim = matches.find((m) => !attempted.has(m.target_id)) ?? matches[matches.length - 1];
      attempted.add(victim.target_id);
      onEvent({ event: 'cleanup.closing', target_id: victim.target_id, title: victim.title, remaining: matches.length - 1 });
      try {
        await transport.request('chrome.attach', { target_id: victim.target_id, endpoint: resolvedEndpoint }, { timeoutMs: TIMEOUTS.requestUi });
      } catch (error) {
        // 标签页可能在挑选与 attach 之间自行消失；这已经是目标状态。
        errors.push({ target_id: victim.target_id, phase: 'attach', code: error?.code ?? String(error) });
        continue;
      }
      try {
        await transport.request('chrome.evaluate', {
          expression: '(() => { window.close(); return { closed: true }; })()'
        }, { timeoutMs: TIMEOUTS.request });
      } catch (error) {
        // 标签页关闭会断开其 CDP 连接，报错属预期。
        errors.push({ target_id: victim.target_id, phase: 'close', code: error?.code ?? String(error) });
      }
      // **补充：把页面导航到 about:blank**。
      // 为什么需要：`window.close()` 只对**脚本打开**的标签有效；用户/浏览器自己开的标签
      // 会被拒绝关闭（实测 126 次尝试，页面数一动不动）。而那些残留会继续匹配
      // `url_contains: static4form`，使后续 `chrome.attach` 报
      //   AMBIGUOUS_CHROME_TARGET: More than one Chrome page target matched
      // —— 这才是套件"时好时坏"的真正原因。导航走后，残留页不再命中该条件，
      // 歧义即消除（即使标签仍在，也只是空白页，不影响 attach 的确定性）。
      try {
        await transport.request('chrome.navigate', {
          url: 'about:blank', timeout_ms: TIMEOUTS.request
        }, { timeoutMs: TIMEOUTS.request });
      } catch { /* 已消失或不可导航都不影响结论 */ }
      closed.push(victim.target_id);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    // 表单页循环跑满仍不干净 → 先扫门户，再如实报 incomplete。
    return await sweepAndReturn({ status: 'incomplete', endpoint: resolvedEndpoint, closed, errors, remaining: -1 });
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

/**
 * 选定要清理的浏览器端点。
 * 显式传入则直接用；否则**先读受控 profile 记录的端点文件**，再退回 chrome.ensure。
 *
 * 为什么先读文件：`chrome.ensure({auto_start:true})` 会尝试**启动一个新的托管 Chrome**；
 * 而本机已经有一个托管实例占着同一个 profile 时，新进程会立刻退出，于是报
 *   "The managed Chrome process exited before DevTools became ready."
 * —— 实测（2026-09-23）该报错把「清理残留标签页」卡死，进而让整条 oa-run 无法开始，
 * 但此时**现有 Chrome 其实完全健康**（/json/version 返回 200、页面都在）。
 * 端点文件里记的就是那个正在跑的实例，读它最稳，且不会误启动第二个浏览器。
 */
async function resolveEndpoint(transport, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().replace(/\/$/, '');

  const probeAlive = async (ep) =>
    !!(await transport.request('chrome.evaluate',
      { endpoint: ep, expression: '(() => ({ url: location.href }))()' },
      { timeoutMs: TIMEOUTS.requestUi }).catch(() => null));

  // 1) 读 profile 目录下记录的端点（与 oa-fill-engine 的 discoverEndpoint 同一来源）
  try {
    const local = process.env.LOCALAPPDATA ?? '';
    const f = join(local, 'WindowsAgent', 'ChromeProfile', 'DeskPilotDevToolsEndpoint');
    if (existsSync(f)) {
      const raw = readFileSync(f, 'utf8').trim().replace(/\/$/, '');
      if (raw && await probeAlive(raw)) return raw;
    }
  } catch { /* 落到下面 */ }

  // 2) 端点文件可能**被托管 Chrome 重写时删掉**（实测 2026-09-23：Chrome 重启后该文件一度消失，
  //    但实例仍在旧端口上健康运行）。此时**不要**直接 auto_start —— 旧实例占着 profile，
  //    新进程会立刻退出并报 "The managed Chrome process exited before DevTools became ready"。
  //    改为**扫一遍已知端口**，谁活着就用谁。
  const candidates = [];
  if (process.env.DESKPILOT_ENDPOINT) candidates.push(process.env.DESKPILOT_ENDPOINT.replace(/\/$/, ''));
  for (let p = 54952; p <= 54962; p++) candidates.push('http://127.0.0.1:' + p);
  for (let p = 58210; p <= 58220; p++) candidates.push('http://127.0.0.1:' + p);
  for (const ep of [...new Set(candidates)]) {
    if (await probeAlive(ep)) return ep;
  }

  // 3) 最后才让 CLI 自己去找/启动（仅在确实没有活实例时）
  const discovered = await transport.request('chrome.ensure', { profile_mode: 'managed', auto_start: true }, { timeoutMs: TIMEOUTS.ensure });
  const endpoint = discovered?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    throw new Error('unable to resolve a managed Chrome endpoint');
  }
  return endpoint.replace(/\/$/, '');
}

if (process.argv[1] && process.argv[1].endsWith('close-stale-tabs.mjs')) {
  const flag = name => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  try {
    // 默认清三类页面：表单页、门户页、空白新标签页。
    // 只清表单页会让门户页/新标签页持续累积（实测累积到 44 个），
    // 进而让后续 chrome.attach 的目标不确定、整轮随机失败。
    const defaultPatterns = ['static4form', '/wui/index.html', 'about:blank', 'chrome://newtab', 'new-tab-page'];
    const custom = flag('--url-contains');
    const result = await closeStaleFormTabs({
      executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
      urlContains: custom ?? 'static4form',
      // **只清表单页**。理由：
      //   · 造成 attach 歧义的唯一来源就是 `static4form` 多开（引擎按这个条件绑定）；
      //   · 门户页/空白页关不掉（`window.close()` 对非脚本打开的标签无效，实测 126 次零效果），
      //     而且**不影响**引擎绑定，属良性残留；
      //   · 早前把门户/空白页也纳入清理，每轮要 attach + evaluate + navigate 二十多个
      //     关不掉的标签，单次清理从 ~5s 涨到 **14s**，8 个场景的套件直接超时。
      // 结论：**按"是否真会造成歧义"来决定清什么**，不要顺手清无关的。
      urlAny: custom ? null : defaultPatterns.slice(0, 1),
      // 保留 1 个页面：浏览器不允许关闭非脚本打开的标签，保留 1 个即可达成稳定终态
      keep: custom ? 0 : 1,
      endpoint: flag('--endpoint'),
      onEvent: value => process.stdout.write(`${JSON.stringify(value)}\n`)
    });
    process.stdout.write(`${JSON.stringify({ event: 'cleanup.done', ...result })}\n`);
    // 只有确实干净才算成功；endpoint_mismatch 与 incomplete 都必须是非零，
    // 否则调用方会把"扫错了浏览器"当成清理完成。
    process.exitCode = result.status === 'clean' ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ event: 'cleanup.failed', status: 'failed', reason: error?.message ?? String(error) })}\n`);
    process.exitCode = 2;
  }
}
