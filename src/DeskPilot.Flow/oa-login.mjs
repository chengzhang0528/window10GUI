/*
 * OA 自动登录（走 CDP，不依赖 GUI）。
 *
 * 为什么要单独一个脚本：
 *   OA 有两种登录界面，提交控件的形态不同：
 *     - e7/e9 门户登录页：账号 #loginid、密码 #userpassword、提交 div.loginBtn（是 DIV，不是 <button>）
 *     - 会话超时重登弹层：账号/密码无固定 id，提交是 <button> 或表单 requestSubmit
 *   只按 <button>/input[type=submit] 找提交控件会在 e7/e9 页面上漏掉，表现为
 *   AutoLoginService 返回 submit_not_found。这里按元素形态分两路处理。
 *
 * 凭据来源与 GUI 完全一致：用户级环境变量
 *   DESKPILOT_DOMAIN_ACCOUNT / DESKPILOT_DOMAIN_PASSWORD / DESKPILOT_AUTO_LOGIN_HOSTS
 * 密码只经 stdin 传给本地 win-agent，不写入任何文件，也不打印。
 */
import { execFileSync } from 'node:child_process';
import { DeskPilotTransport } from './transport.mjs';
import { discoverLiveEndpoint } from './endpoint.mjs';
import { TIMEOUTS } from './timeouts.mjs';

const DEFAULT_EXECUTABLE = 'D:/github.com/window10GUI/src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe';

// OA 门户入口。冷启动时 Chrome 可能停在 about:blank，此时登录表达式找不到任何
// 登录控件（表现为 password_not_found）。必须先把浏览器导航到门户，再登录。
// 该地址不是密钥，可明文；如需换环境用 --portal 覆盖。
const DEFAULT_PORTAL = 'https://oa.united-imaging.com/wui/index.html';

// 只在「当前页还不是门户」时才导航，避免每次重跑都刷掉已登录的会话。
const PORTAL_PROBE_EXPRESSION = `(() => ({ url: location.href, host: location.host, title: document.title }))();`;

// 页面内执行：填表并提交。整段保持 ASCII，避免中文经 JSON/命令行传递时被截断。
// 提交控件按三种形态依次尝试，覆盖 e7/e9 页与超时弹层。
const LOGIN_EXPRESSION = `(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
  };
  const pw = document.querySelector('#userpassword') ||
             Array.from(document.querySelectorAll('input[type=password]')).find(visible);
  if (!pw) {
    // **没有登录表单**有两种截然不同的原因，必须分开报：
    //   ① 已经登录（门户已渲染）→ 这是**成功**，不是失败。实测（2026-09-23）：
    //      Chrome 重启后会话仍在 cookie 里，页面直接进了 main/portal 路由，
    //      旧代码却把它当成 password_not_found 失败，导致整条 oa-run 卡在「登录/门户」。
    //   ② 真没到登录页（还在 about:blank / 被跳转到别处）→ 那才是失败。
    //   注意：本段位于模板字面量内部，注释中不可出现反引号或美元花括号插值，
    //   否则会提前结束字符串（见 universal-pitfalls #17，同类事故已发生过两次）。
    const portalReady = !!(document.querySelector('.e8header-top-menu-item') ||
                           /\\/main\\/portal|\\/main\\/workflow/.test(location.hash || '') ||
                           document.querySelector('li.ant-menu-item'));
    return portalReady ? { status: 'already_logged_in' } : { status: 'password_not_found' };
  }
  const acct = document.querySelector('#loginid') ||
    Array.from(document.querySelectorAll('input')).filter(el =>
      el !== pw && visible(el) &&
      ['hidden','password','checkbox','radio','submit','button'].indexOf((el.type || '').toLowerCase()) < 0)
      .map((el, i) => {
        const meta = [el.name, el.id, el.placeholder, el.autocomplete].filter(Boolean).join(' ').toLowerCase();
        const t = el.getBoundingClientRect().top;
        let s = (el.autocomplete === 'username' ? 100 : 0) +
                (['user','account','login','name'].some(k => meta.indexOf(k) >= 0) ? 60 : 0) +
                ((el.type || '') === 'text' ? 10 : 0);
        return { el: el, s: s, i: i };
      }).sort((a, b) => (b.s - a.s) || (a.i - b.i))[0]?.el;
  if (!acct) return { status: 'account_not_found' };
  const setV = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.focus();
    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true, composed: true }));
  };
  setV(acct, ACCOUNT_VALUE);
  setV(pw, PASSWORD_VALUE);
  const btn = document.querySelector('div.loginBtn');
  if (btn && visible(btn)) { btn.click(); return { status: 'submitted', via: 'div.loginBtn' }; }
  const plain = Array.from(document.querySelectorAll('button,input[type=submit]')).find(visible);
  if (plain) { plain.click(); return { status: 'submitted', via: 'button' }; }
  const form = pw.form;
  if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return { status: 'submitted', via: 'requestSubmit' }; }
  return { status: 'submit_not_found' };
})()`;

export function loginExpression(account, password) {
  return LOGIN_EXPRESSION
    .replace('ACCOUNT_VALUE', JSON.stringify(account))
    .replace('PASSWORD_VALUE', JSON.stringify(password));
}

/**
 * 读取托管凭据。
 *
 * 不能只依赖 process.env：凭据由 GUI 的设置对话框写入「用户级」环境变量
 * （HKCU\Environment）。已经在运行的进程不会自动获得新的用户级变量，因此
 * 从当前 shell 启动的 node 子进程可能只看到其中一部分 —— 实测 ACCOUNT 可见、
 * PASSWORD 不可见，表现为 not_configured，而 GUI 里一切正常。
 * 所以这里先看 process.env，再回落到用户级注册表。
 */
function readUserScopeVariable(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    const line = out.split(/\r?\n/).find(l => l.includes(name));
    if (!line) return undefined;
    // 形如: "    NAME    REG_SZ    value"
    const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+([\s\S]*)$/);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

export function loadCredentials() {
  const account = readUserScopeVariable('DESKPILOT_DOMAIN_ACCOUNT');
  const password = readUserScopeVariable('DESKPILOT_DOMAIN_PASSWORD');
  const hosts = readUserScopeVariable('DESKPILOT_AUTO_LOGIN_HOSTS');
  if (!account || !password) return null;
  return { account, password, hosts: hosts ?? '' };
}

export async function ensureLoggedIn({ executable = DEFAULT_EXECUTABLE, timeoutMs = TIMEOUTS.requestUi, endpoint, portal = DEFAULT_PORTAL, onEvent = () => {} } = {}) {
  const credentials = loadCredentials();
  if (!credentials) return { status: 'not_configured' };

  const transport = new DeskPilotTransport({ executable });
  const t0 = Date.now();
  const step = (name, extra = {}) => onEvent({ event: 'login.step', step: name, elapsed_ms: Date.now() - t0, ...extra });
  try {
    // 端点解析：**先找已经活着的实例**，找不到才让 CLI 启动。
    //
    // 为什么不能直接 `auto_start: true`：本机已有一个托管 Chrome 占着同一 profile 时，
    // 新进程会立刻退出并报 `CHROME_LAUNCH_FAILED: The managed Chrome process exited before
    // DevTools became ready` —— 而那个**已存在的实例其实完全健康**。
    // 实测（2026-09-23）：Chrome 重启后 `DeskPilotDevToolsEndpoint` 文件一度丢失，
    // 于是这里的 auto_start 必然失败，整条 oa-run 卡在「登录/门户」。
    const resolved = endpoint ?? await discoverLiveEndpointLocal(transport, endpoint);
    const params = { auto_start: true, profile_mode: 'managed' };
    if (resolved) { params.endpoint = resolved; params.auto_start = false; }
    step('ensure.begin', { endpoint: resolved ?? null });
    // 超时用实测基线：冷启动 managed Chrome 实测 3.5s。原为 60s，是实测值的 17 倍 ——
    // 过大超时会把"失败"变成"长等待"，白耗时间并掩盖问题。
    const status = await transport.request('chrome.ensure', params, { timeoutMs: TIMEOUTS.ensure });
    step('ensure.done', { page_state: status?.page_state, endpoint: status?.endpoint });

    // 若当前不在 OA 门户（例如冷启动的 about:blank，或残留的无关标签页），先导航过去。
    // 只有确实需要时才导航：已登录会话直接重跑时不该被刷掉。
    let navigated = false;
    const probe = await transport.request('chrome.evaluate', withEndpoint(status?.endpoint, {
      expression: PORTAL_PROBE_EXPRESSION, timeout_ms: TIMEOUTS.request
    }), { timeoutMs: TIMEOUTS.request });
    const probeValue = probe?.value ?? {};
    const onPortal = typeof probeValue.url === 'string' && probeValue.url.includes('united-imaging.com');
    if (!onPortal) {
      step('navigate.begin', { from: probeValue.url, portal });
      await transport.request('chrome.navigate', withEndpoint(status?.endpoint, {
        url: portal, timeout_ms: TIMEOUTS.requestUi
      }), { timeoutMs: TIMEOUTS.requestUi });
      navigated = true;
      step('navigate.done', { to: portal });
    }

    if (status?.page_state === 'usable' && !navigated) {
      return { status: 'already_usable', endpoint: status.endpoint, elapsed_ms: Date.now() - t0 };
    }
    step('submit.begin');
    // **必须带 endpoint**：漏了它就不是发往我们刚解析出的那个实例/目标页，
    // 而 CLI 会自行挑一个可用目标 —— 实测（2026-09-23）这会让提交落到别的标签页上，
    // 于是返回 `password_not_found`（因为那个页面没有登录表单），整条 oa-run 卡在「登录/门户」。
    const result = await transport.request('chrome.evaluate', withEndpoint(status?.endpoint, {
      expression: loginExpression(credentials.account, credentials.password), timeout_ms: timeoutMs
    }), { timeoutMs: timeoutMs + TIMEOUTS.request });
    step('submit.done', { result: result?.value?.status });
    return { status: result?.value?.status ?? 'unknown', endpoint: status?.endpoint, navigated, elapsed_ms: Date.now() - t0 };
  } finally {
    await transport.close({ cancel: true, timeoutMs: TIMEOUTS.close }).catch(() => {});
  }
}

function withEndpoint(endpoint, params) {
  return endpoint ? { ...params, endpoint } : params;
}

/**
 * 找出当前活着的托管 Chrome 端点（统一走 endpoint.mjs 的共用实现）。
 * 全部探不到才返回 null（此时调用方会退回 auto_start 真启动一个）。
 */
async function discoverLiveEndpointLocal(transport, explicit) {
  return discoverLiveEndpoint(
    (m, p, o) => transport.request(m, p, o),
    { timeoutMs: TIMEOUTS.requestUi, explicit }
  );
}

if (process.argv[1] && process.argv[1].endsWith('oa-login.mjs')) {
  const flag = name => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const result = await ensureLoggedIn({
    executable: flag('--executable') ?? DEFAULT_EXECUTABLE,
    endpoint: flag('--endpoint'),
    portal: flag('--portal') ?? DEFAULT_PORTAL,
    // 分段进度写到 stderr：卡住时能立刻看出卡在哪一步，而不是只能等超时
    onEvent: v => process.stderr.write(`${JSON.stringify(v)}\n`)
  });
  process.stdout.write(`${JSON.stringify({ event: 'login.done', ...result })}\n`);
  // `already_logged_in` 也算成功：页面已是门户，没有登录表单（会话还在 cookie 里）。
  // 把它当失败会误伤"已登录直接重跑"这一最常用的路径。
  process.exitCode = ['already_usable', 'already_logged_in', 'submitted'].includes(result.status) ? 0 : 2;
}
