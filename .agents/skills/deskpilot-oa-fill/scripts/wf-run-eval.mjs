/*
 * wf-run-eval.mjs —— 在本机可靠地执行 deskpilot-oa-fill 的注入式脚本
 *
 * 为什么需要这个脚本（2026-10-08 实测，不是推测）：
 *   1) 这些脚本是**注入页面**执行的，所以内容必须原样到达浏览器。把它手工塞进工具参数要转义，
 *      极易改坏（ledger #117：一次 shell 文本手术把脚本搞成乱码且无从回退）。
 *      这里用 readFileSync 读磁盘上的真文件、JSON.stringify 负责转义 —— 跑的就是资产本身。
 *   2) PowerShell 侧不适合干这件事：`return` 后直接换行会触发 **ASI**（`return (IIFE)` 被拆成
 *      `return;` + 表达式 → 编译期 SyntaxError，页面里的 try/catch 也抓不到，CLI 只回
 *      `CHROME_SCRIPT_EXCEPTION`）；`Invoke-Expression` 里函数内还取不到脚本级变量。
 *   3) 顺带提供"频闪复测"：在字段所在 **tr**（不是单元格 —— OA 会整体替换单元格节点，
 *      挂在单元格上会数到 0 而误判安静）上挂 MutationObserver，并**同测一个对照字段**。
 *
 * 用法：
 *   node wf-run-eval.mjs --script <path> [--setup "<js>"] [--endpoint http://127.0.0.1:PORT] [--target <target_id>]
 *   node wf-run-eval.mjs --flick <fieldmark> [--ms 3000] [--control field68058] [--endpoint ...] [--target ...]
 *   node wf-run-eval.mjs --targets [--endpoint ...]        # 列页面目标（拿 target_id）
 *   node wf-run-eval.mjs --eval "<js>"                     # 任意只读/写入表达式
 *   node wf-run-eval.mjs --click "<css-selector>"          # **可信** chrome.click（wea-associative 只认它）
 *   node wf-run-eval.mjs --wait <ms>                       # 纯等待（下拉/弹框异步渲染之间用）
 *   node wf-run-eval.mjs --shot <png>                      # 用 attach 返回的 window_id 截图
 *   node wf-run-eval.mjs --seq <steps.json>                # **一条流水线**：一个进程跑多步，省掉每次约 1.5s 的 CLI 启动
 *
 * `--seq` 的步骤是数据（JSON 数组），支持：
 *   {op:'find',    url_contains, need_fields?}  按**页内 location.href** 找到"真在那一页且已渲染"的目标并 attach
 *   {op:'attach',  target_id}
 *   {op:'openform',name, portal?}               **内建开单**：目录页 → 点目录条目 → 复核 targets 找新 static4form 并 attach
 *   {op:'script',  path, setup?}                跑 skill 里的真脚本文件（readFileSync，不经手工转义）
 *   {op:'eval',    expression, print?}
 *   {op:'click',   selector}                    **可信**点击
 *   {op:'wait',    ms}
 *   {op:'flick',   fid, ms?, control?}
 *   {op:'shot',    path}
 *
 * 典型一次 pass（"等异步渲染"必须由宿主插入，脚本内部等不了）：
 *   openform → script wf-fill-by-component.js → [click 放大镜 → wait → script wf-interactive.js(dialog-mark)
 *   → click 行 → wait → script wf-interactive.js(dialog-verify)] → script wf-fill-detail.js(add) → wait
 *   → script wf-fill-detail.js(fill) → flick → shot
 *
 * 依赖：只依赖 Node 内置模块；通过公开 CLI `win-agent.exe exec --stdin --format ndjson` 通信，
 * 不使用任何私有 HTTP/CDP 客户端。
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DEFAULT_EXE = 'C:\\Users\\cheng.zhang\\AppData\\Local\\DeskPilot\\releases\\6947fa5-6f0a3949ca155bb5106bbe2f18e6cb777e8c8ff2c1eebeb063e662585a1c21ba\\bin\\win-agent.exe';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:49406';

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[k] = v;
    } else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const EXE = args.exe || process.env.DESKPILOT_EXE || DEFAULT_EXE;
const EP = args.endpoint || process.env.DESKPILOT_ENDPOINT || DEFAULT_ENDPOINT;

const child = spawn(EXE, ['exec', '--stdin', '--format', 'ndjson'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const r = pending.get(o.request_id);
    if (r) { pending.delete(o.request_id); r(o); }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[cli-stderr] ' + d));

let seq = 0;
function req(method, params, timeoutMs = 30000) {
  const id = 'r' + (++seq);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('TIMEOUT ' + method)); }, timeoutMs);
    pending.set(id, (o) => { clearTimeout(t); resolve(o); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (expression, timeoutMs = 30000) =>
  req('chrome.evaluate', { endpoint: EP, expression, timeout_ms: timeoutMs }, timeoutMs + 8000);

/** 选目标：优先显式 --target；否则挑页内 location.href 含 static4form 且已渲染的那个（元数据会陈旧）。 */
async function resolveTarget(explicit) {
  if (explicit) return explicit;
  const list = await req('chrome.targets', { endpoint: EP }, 15000);
  const pages = (list.result?.targets || []).filter((t) => t.type === 'page' && (t.url || '').includes('static4form'));
  for (const t of pages.reverse()) {
    const probe = await ev(`(function(){ return { href: location.href, fields: document.querySelectorAll('[data-fieldmark]').length }; })()`, 15000)
      .then((r) => r.result?.value).catch(() => null);
    if (probe && String(probe.href || '').includes('static4form') && probe.fields > 0) return t.target_id;
  }
  return pages[0]?.target_id || null;
}

try {
  if (args.targets) {
    const list = await req('chrome.targets', { endpoint: EP }, 15000);
    for (const t of (list.result?.targets || [])) console.log([t.type, t.target_id, (t.title || '').slice(0, 40), (t.url || '').slice(0, 80)].join(' | '));
    process.exit(0);
  }

  const target = await resolveTarget(args.target);
  if (!target) { console.log('NO_TARGET: 没有已渲染的 static4form 页面'); process.exit(2); }

  // ---------------- --seq：一条流水线，一个进程跑完 ----------------
  if (args.seq) {
    const steps = JSON.parse(readFileSync(String(args.seq), 'utf8'));
    console.log('seq steps=' + steps.length);
    let windowId = null;

    const listPages = async () => (await req('chrome.targets', { endpoint: EP }, 15000)).result?.targets?.filter((t) => t.type === 'page') || [];
    const attachTo = async (tid) => {
      const a = await req('chrome.attach', { endpoint: EP, target_id: tid }, 15000);
      if (a.result?.window?.window_id) windowId = a.result.window.window_id;
      return a.ok;
    };
    const liveInfo = async (tid) => {
      const a = await req('chrome.attach', { endpoint: EP, target_id: tid }, 15000).catch(() => null);
      if (!a || !a.ok) return null;
      const p = await ev("(function(){ return { href: location.href, fields: document.querySelectorAll('[data-fieldmark]').length }; })()", 10000).catch(() => null);
      return p && p.ok ? p.result.value : null;
    };

    for (const st of steps) {
      const tag = st.label || st.op;
      try {
        if (st.op === 'wait') { await sleep(Number(st.ms || 500)); console.log(`[${tag}] waited ${st.ms || 500}ms`); }
        else if (st.op === 'click') {
          const r = await req('chrome.click', { endpoint: EP, selector: st.selector, timeout_ms: st.timeout_ms || 15000 }, 25000);
          console.log(`[${tag}] click ok=${r.ok}` + (r.ok ? '' : ' err=' + String(r.error?.code)));
        } else if (st.op === 'shot') {
          if (!windowId) console.log(`[${tag}] SHOT_SKIPPED(no window_id)`);
          else {
            const s = await req('screen.capture_window', { endpoint: EP, window_id: windowId, path: st.path }, 30000);
            console.log(`[${tag}] shot ok=${s.ok}` + (s.ok ? '' : ' err=' + String(s.error?.code)));
          }
        } else if (st.op === 'attach') { await attachTo(st.target_id); console.log(`[${tag}] attached ${st.target_id}`); }
        else if (st.op === 'find') {
          let hit = null; const cand = [];
          for (const t of await listPages()) {
            const info = await liveInfo(t.target_id);
            if (!info) continue;
            cand.push(String(info.href).slice(0, 46) + '#f' + info.fields);
            if (!hit && String(info.href).includes(st.url_contains) && (!st.need_fields || info.fields >= st.need_fields)) hit = t;
          }
          if (!hit) console.log(`[${tag}] NOT_FOUND 候选: ${cand.join(' ; ').slice(0, 360)}`);
          else { await attachTo(hit.target_id); console.log(`[${tag}] attached ${hit.target_id}`); }
        } else if (st.op === 'eval') {
          const r = await ev(String(st.expression), st.timeout_ms || 30000);
          console.log(`[${tag}] ` + (r.ok ? JSON.stringify(r.result?.value).slice(0, st.print || 900) : 'ERR ' + String(r.error?.code)));
        } else if (st.op === 'script') {
          if (st.setup) { const s = await ev(String(st.setup), 15000); if (!s.ok) console.log(`[${tag}] setup ERR ` + String(s.error?.code)); }
          const r = await ev(readFileSync(st.path, 'utf8'), st.timeout_ms || 60000);
          if (!r.ok) console.log(`[${tag}] ERR ` + String(r.error?.code));
          else {
            const v = r.result?.value;
            if (v && v.results) {
              console.log(`[${tag}] summary=` + JSON.stringify(v.summary));
              for (const x of v.results) if (st.verbose || x.ok === false) console.log('    ' + [x.fieldmark, x.component, x.action, 'ok=' + x.ok, x.refused ? 'refused=' + x.refused : ''].join(' '));
            } else if (v && v.writes) {
              console.log(`[${tag}] ok=${v.okCount} fail=${v.failCount} rows=${v.rowCount} derived=` + JSON.stringify(v.derived));
              for (const x of v.writes) if (!x.ok && x.action !== 'no-fieldmark') console.log('    FAIL r' + x.row + ' ' + x.fieldname + ' want=' + x.want + ' after=' + x.after);
            } else {
              console.log(`[${tag}] ` + JSON.stringify(v).slice(0, st.print || 800));
            }
          }
        } else if (st.op === 'openmodal') {
          // 点放大镜 -> 等 -> **复核弹框真的开了**，没开就重试。
          // 为什么必须有这一步：刚写完某行的列时该行会重渲染，第一次可信点击可能落在被替换的节点上
          // （实测 click 报 ok=true，但 2.8s 后仍无可见弹框，弹框标记直接 no-visible-modal）。
          let opened = 0;
          const tries = st.tries || 3;
          const probe = "(function(){ function vis(e){var r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';} var w=Array.prototype.slice.call(document.querySelectorAll('.ant-modal-wrap,.wea-browser-modal')).filter(vis); if(!w.length) return {open:false}; var m=w[w.length-1]; var t=m.querySelector('.ant-modal-title'); return {open:true, rows:m.querySelectorAll('.ant-table-body tbody tr').length, title:t?(t.innerText||'').trim().slice(0,20):null}; })()";
          // 先看有没有**上一轮迟到才开出来**的弹框 —— 实测遇到过：点击报 ok=true 而 2.8s 后无弹框，
          // 再过一会儿它才出现；若此时直接开新弹框，就会出现"标题对不上"的错位（虽然行点击写回各自绑定字段，最终值仍对）。
          const pre = await ev(probe, 15000).catch(() => null);
          const pv = pre && pre.ok ? pre.result.value : null;
          if (pv && pv.open) console.log(`[${tag}] 注意：进入本步时**已有弹框**开着 title=${pv.title} rows=${pv.rows}（可能是上一步迟到开出来的）`);
          for (let attempt = 1; attempt <= tries; attempt++) {
            const r = await req('chrome.click', { endpoint: EP, selector: st.selector, timeout_ms: st.timeout_ms || 15000 }, 25000).catch(() => null);
            let v = null;
            // 轮询等弹框：不要只等一个固定时长（实测存在开得比 2.8s 更慢的情况）
            for (let p = 0; p < (attempt === 1 ? 6 : 4); p++) {
              await sleep(attempt === 1 && p === 0 ? (st.wait_ms || 1500) : 700);
              const chk = await ev(probe, 15000).catch(() => null);
              v = chk && chk.ok ? chk.result.value : null;
              if (v && v.open && (v.rows > 0 || st.allow_empty)) break;
            }
            console.log(`[${tag}] try${attempt} click=${r ? r.ok : 'ERR'} modal_open=${v ? v.open : '?'} rows=${v ? v.rows : '?'}` + (v && v.title ? ' title=' + v.title : ''));
            if (v && v.open && (v.rows > 0 || st.allow_empty)) { opened = attempt; break; }
          }
          if (!opened) console.log(`[${tag}] MODAL_NOT_OPEN（已重试 ${tries} 次）`);
        } else if (st.op === 'flick') {
          const fid = st.fid, control = st.control || 'field68058', ms = st.ms || 3000;
          await ev(`(function(){ window.__M__={start:Date.now()}; ['${fid}','${control}'].forEach(function(f){ window.__M__[f]={total:0}; var e=document.querySelector('[data-fieldmark="'+f+'"]'); var tr=e?e.closest('tr'):null; if(!tr){window.__M__[f].noTr=true;return;} var mo=new MutationObserver(function(ms){ window.__M__[f].total+=ms.length; }); mo.observe(tr,{childList:true,subtree:true,attributes:true,characterData:true}); window.__M__[f].stop=function(){mo.disconnect();}; }); return 1; })()`, 15000);
          await sleep(ms);
          const r = await ev(`(function(){ var W=window.WfForm; var o={}; ['${fid}','${control}'].forEach(function(f){ var s=window.__M__&&window.__M__[f]; if(s&&s.stop)s.stop(); var v=null; try{v=W.getFieldValue(f);}catch(e){} o[f]={mutations:s?s.total:null,noTr:!!(s&&s.noTr),model:(v==null?'':String(v))}; }); return o; })()`, 15000);
          console.log(`[${tag}] ` + JSON.stringify(r.result?.value));
        } else if (st.op === 'openform') {
          let catalog = null; const cand = [];
          for (const t of await listPages()) {
            const info = await liveInfo(t.target_id);
            if (!info) continue;
            cand.push(String(info.href).slice(0, 46));
            if (!catalog && String(info.href).includes('main/workflow/add')) catalog = t;
          }
          if (!catalog) {
            for (const t of await listPages()) {
              const info = await liveInfo(t.target_id);
              if (info && String(info.href).includes('/wui/index.html')) { catalog = t; break; }
            }
            if (!catalog) throw new Error('没有可用的 wui 页做目录页');
            const portal = st.portal || 'https://oa.united-imaging.com/wui/index.html';
            await req('chrome.navigate', { endpoint: EP, url: portal + '#/main/workflow/add?menuIds=1,12&menuPathIds=1,12', timeout_ms: 20000 }, 30000);
            await sleep(3000);
          }
          await attachTo(catalog.target_id);
          const want = JSON.stringify(st.name);
          // 点之前先记下已存在的 target —— 否则会把**旧表单**当成"刚开的"，在脏实例上重填（实测踩过）
          const before = new Set((await listPages()).map((t) => t.target_id));
          try {
            await req('chrome.wait', { endpoint: EP, selector: 'a', expression: `Array.from(document.querySelectorAll('a')).some(function(a){ return (a.innerText||'').replace(/\\s+/g,' ').trim() === ${want}; })`, stable_ms: 400, timeout_ms: 20000 }, 30000);
          } catch (e) { console.log(`[${tag}] 等目录条目超时，仍尝试点击`); }
          const c = await ev(`(function(){ var want=${want}; var el=Array.from(document.querySelectorAll('a')).filter(function(a){ return (a.innerText||'').replace(/\\s+/g,' ').trim()===want; })[0]; if(!el) return {clicked:false}; el.scrollIntoView({block:'center'}); el.click(); return {clicked:true}; })()`, 15000);
          console.log(`[${tag}] entry click=` + JSON.stringify(c.result?.value));
          // 等新标签页真正渲染出表单（"没打开"很可能只是探测太早，所以以行数/字段数为准）
          let fresh = null, any = null; const c2 = [];
          for (let attempt = 0; attempt < 10 && !fresh; attempt++) {
            await sleep(attempt === 0 ? 2500 : 800);
            for (const t of await listPages()) {
              const info = await liveInfo(t.target_id);
              if (!info) continue;
              if (!String(info.href).includes('static4form') || !(info.fields > 0)) continue;
              if (!before.has(t.target_id)) { fresh = t; break; }
              if (!any) any = t;
            }
          }
          if (!fresh) {
            for (const t of await listPages()) {
              const info = await liveInfo(t.target_id);
              if (info) c2.push(String(info.href).slice(0, 46) + '#f' + info.fields);
            }
            console.log(`[${tag}] NO_FRESH_FORM —— 没有新开的表单实例。候选: ${c2.join(' ; ').slice(0, 300)}`);
            if (any) { await attachTo(any.target_id); console.log(`[${tag}] WARN 退回复用已在的表单 ${any.target_id}（**可能不是干净实例，填之前先自行确认**）`); }
          } else { await attachTo(fresh.target_id); console.log(`[${tag}] form=${fresh.target_id} (fresh)`); }
        } else console.log(`[${tag}] unknown op ${st.op}`);
      } catch (e) {
        console.log(`[${tag}] THREW: ${e.message}`);
      }
    }
    process.exit(0);
  }
  console.log('target=' + target + ' endpoint=' + EP);
  const attached = await req('chrome.attach', { endpoint: EP, target_id: target }, 15000);

  // 截图：用 attach 返回的 window_id（**不要**按进程名去猜窗口）
  if (args.shot) {
    const wid = attached.result?.window?.window_id;
    if (!wid) { console.log('SHOT_SKIPPED: attach 未返回 window_id'); }
    else {
      const s = await req('screen.capture_window', { endpoint: EP, window_id: wid, path: String(args.shot) }, 30000);
      console.log('shot ok=' + s.ok + ' ' + JSON.stringify(s.result?.screenshot ? { path: s.result.screenshot.path, w: s.result.screenshot.width, h: s.result.screenshot.height, trusted: s.result.screenshot.trusted } : s.error));
    }
  }

  if (args.wait) {
    const ms = Number(args.wait);
    await sleep(Number.isFinite(ms) ? ms : 500);
    console.log('waited ' + ms + 'ms');
  } else if (args.click) {
    const sel = String(args.click);
    const r = await req('chrome.click', { endpoint: EP, selector: sel, timeout_ms: 15000 }, 25000);
    console.log('click ok=' + r.ok + ' selector=' + sel + (r.ok ? '' : ' err=' + JSON.stringify(r.error)));
    if (r.result?.result) console.log('  hit=' + JSON.stringify(r.result.result).slice(0, 240));
  } else if (args.eval) {
    const r = await ev(String(args.eval), 30000);
    if (!r.ok) console.log('EVAL_ERROR ' + JSON.stringify(r.error).slice(0, 400));
    else console.log(JSON.stringify(r.result?.value, null, 1).slice(0, 6000));
  } else if (args.flick) {    const fid = String(args.flick);
    const ms = Number(args.ms || 3000);
    const control = String(args.control || 'field68058');
    const inst = await ev(`(function(){ window.__M__={start:Date.now()}; ['${fid}','${control}'].forEach(function(f){ window.__M__[f]={total:0,byType:{}}; var e=document.querySelector('[data-fieldmark="'+f+'"]'); var tr=e?e.closest('tr'):null; if(!tr){window.__M__[f].noTr=true;return;} var mo=new MutationObserver(function(ms){ var st=window.__M__[f]; st.total+=ms.length; ms.forEach(function(x){ var k=x.type+(x.attributeName?':'+x.attributeName:''); st.byType[k]=(st.byType[k]||0)+1; }); }); mo.observe(tr,{childList:true,subtree:true,attributes:true,characterData:true}); window.__M__[f].stop=function(){mo.disconnect();}; }); return { installed:true }; })()`);
    console.log('install=' + JSON.stringify(inst.result?.value));
    await sleep(ms);
    const read = await ev(`(function(){ var W=window.WfForm; var out={ elapsed_ms: Date.now()-(window.__M__?window.__M__.start:Date.now()) }; ['${fid}','${control}'].forEach(function(f){ var s=window.__M__&&window.__M__[f]; if(s&&s.stop)s.stop(); var v=null; try{v=W.getFieldValue(f);}catch(e){} out[f]={mutations:s?s.total:null, byType:s?s.byType:null, noTr:!!(s&&s.noTr), model:(v==null?'':String(v))}; }); return out; })()`);
    console.log('FLICK ' + JSON.stringify(read.result?.value, null, 1));
  } else {
    const scriptPath = args.script;
    if (!scriptPath) {
      // 只给了 --shot 时不该报"用法错误"：工具成功却退非零，本身就是一种假失败
      if (!args.shot) { console.log('usage: --script <path> | --flick <fid> | --targets | --eval <js> | --click <css> | --wait <ms> | --shot <png>'); process.exit(2); }
      process.exit(0);
    }
    if (args.setup) {
      const s = await ev(String(args.setup), 15000);
      console.log('setup ok=' + s.ok);
    }
    const src = readFileSync(scriptPath, 'utf8');
    console.log('script=' + scriptPath + ' bytes=' + src.length);
    const res = await ev(src, 60000);
    if (!res.ok) { console.log('EVAL_ERROR ' + JSON.stringify(res.error).slice(0, 500)); }
    else {
      const v = res.result.value;
      if (v && v.results) {
        console.log('summary=' + JSON.stringify(v.summary));
        for (const r of v.results) {
          const tags = [r.ambiguous ? 'AMB' : '', r.rendered === false ? 'hidden' : '', (r.refused !== undefined && r.refused !== null) ? 'refused=' + r.refused : '', r.existing ? 'existing=' + r.existing : ''].filter(Boolean).join(',');
          console.log('  ' + [String(r.fieldmark).padEnd(12), String(r.component || '').padEnd(16), String(r.action || '').padEnd(20), 'ok=' + r.ok, tags].join(' '));
        }
      } else {
        console.log(JSON.stringify(v, null, 1).slice(0, 6000));
      }
    }
  }
} catch (e) {
  console.log('FAILED: ' + e.message);
} finally {
  try { child.kill(); } catch { /* ignore */ }
}
