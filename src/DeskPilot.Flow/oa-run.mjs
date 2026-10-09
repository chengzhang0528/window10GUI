/*
 * OA 填单「单一入口」：一条命令跑完四阶段，并把关卡结论 + 计时一起给出。
 *
 * 为什么需要它：
 *   四阶段机制此前散在 5 个脚本里，靠人记得按顺序调用 —— 一旦漏掉某步
 *   （比如忘了预检、或没跑 gate 就宣称通过），机制就形同虚设。
 *   本脚本把顺序**固化成代码**，任何人/任何轮次跑都走同一条路径：
 *
 *     0) 解析模板与纯数据
 *     1) 离线预检（不通过就停 —— 缺值/待确认一律先问用户，不进浏览器）
 *     2) 清理残留标签页 → 登录 → 打开表单（每步计时）
 *     3) 运行填单引擎（引擎自己停在提交前）
 *     4) 解析引擎结果 → 跑 gate 1–4 → 输出结论 + 计时
 *
 * 退出码：0 = 四阶段全通过；2 = 被关卡拦住（会说明回到哪一阶段）；1 = 运行错误。
 *
 * 用法：
 *   node oa-run.mjs --data data/uih01-A-normal-rd.data.json [--template templates/xxx.json]
 *                   [--scenario-name "场景A"] [--skip-precheck] [--out .run-report.json]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

const DATA = flag('--data') ? resolve(flag('--data')) : null;
const SCENARIO = flag('--scenario-name') ?? (DATA ? DATA.split(/[\\/]/).pop().replace(/\.data\.json$/, '') : '(未命名)');

// 场景名形如 uih03-A-material，模板名形如 uih03-erp-material.template.json。
// 用场景名前缀（uihNN）自动选模板，避免漏传 --template 时**静默填错表单**。
const scenarioPrefix = (SCENARIO.match(/^(uih\d+)/i) || [])[1]?.toLowerCase() ?? null;

// 更可靠的一招：纯数据里带 `form_key`（如 uih03-erp-material-application），
// 直接用它去认领模板，比解析文件名健壮 —— 文件名可能带 `.tmp-` 之类前缀，
// 那时前缀匹配会落空并**静默回落到 UIH-01 默认模板**（实测踩到，等于填错表单）。
const dataFormKey = (() => {
  if (!DATA) return null;
  try { return JSON.parse(readFileSync(DATA, 'utf8')).form_key ?? null; } catch { return null; }
})();

const autoTemplate = () => {
  const dir = join(HERE, 'templates');
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir).filter((f) => f.endsWith('.template.json'));
  // 1) 优先按纯数据的 form_key 认领：模板 form_key 与之相等，或以它开头（模板常带 -application 后缀）
  if (dataFormKey) {
    const exact = all.find((f) => {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return t.form_key === dataFormKey;
      } catch { return false; }
    });
    if (exact) return join(dir, exact);
    const prefixed = all.filter((f) => dataFormKey.startsWith(f.replace('.template.json', ''))).sort()[0];
    if (prefixed) return join(dir, prefixed);
  }
  // 2) 再按场景名前缀
  if (scenarioPrefix) {
    const hit = all.filter((f) => f.startsWith(scenarioPrefix)).sort()[0];
    if (hit) return join(dir, hit);
  }
  return null;
};
// 报告路径：优先 `<stem>-<前缀>.json`（如 .explore-uih02.json），
// 不存在则回落到历史无前缀名（UIH-01 的 .explore-report.json）。
// 不能只按前缀推导 —— 否则老场景找不到报告，gate 1 会以"未普查"直接拦下。
//
// **必须校验报告属于同一张表单**：实测踩过 —— 临时生成的 `.explore-uih01.json`
// 内容其实是 UIH-03（workflowid=2226）的普查；因为它名字带 uih01 前缀而被优先选中，
// 覆盖了正确的 `.explore-report.json`，导致 UIH-01 的 gate 2 突然报一堆假失败。
// 这里按 workflowid 核对：不一致就**跳过该候选**，继续找下一个。
const wfidOf = (u) => { const m = String(u ?? '').match(/workflowid=(\d+)/); return m ? m[1] : null; };
// 注意：templateWfid 依赖 TEMPLATE，而 TEMPLATE 在本文件更靠后定义。
// 所以这里改成**惰性求值**（函数），否则会在 TEMPLATE 之前读到空值、让守卫静默失效 —— 实测踩过。
const templateWfid = () => {
  try { return wfidOf(JSON.parse(readFileSync(TEMPLATE, 'utf8')).notes?.form_id); } catch { return null; }
};
const reportMatchesForm = (p) => {
  if (!existsSync(p)) return false;
  const tw = templateWfid();
  if (!tw) return true;                            // 模板没记 workflowid → 无从核对，放行
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const w = wfidOf(j.url) ?? wfidOf(j.entry?.url);
    if (!w) return true;                           // 报告没记 workflowid → 放行（但优先级低于"确证匹配"）
    return w === tw;
  } catch { return false; }
};
// 把候选分成"确证匹配"和"无法核对"两档。**必须先取确证匹配的那个**：
// 实测老报告（.options-report.json 等）因为没记 url 而一律"无法核对"，
// 若按文件名顺序取第一个"可接受"的，会拿到 UIH-01 的穷尽报告去判差旅表单 ——
// gate 2 于是报"9/9 个字段没有观察到弹窗"，而其实那份 travel 报告里 9 个弹窗都在。
const reportConfidence = (p) => {
  const tw = templateWfid();
  if (!existsSync(p) || !tw) return 0;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const w = wfidOf(j.url) ?? wfidOf(j.entry?.url);
    if (!w) return 1;                              // 无法核对：可用但不优先
    return w === tw ? 2 : -1;                      // 2=确证匹配, -1=确证不匹配
  } catch { return -1; }
};
const autoReport = (stem) => {
  const exact = scenarioPrefix ? join(HERE, `${stem}-${scenarioPrefix}.json`) : null;
  const legacy = join(HERE, `${stem}-report.json`);

  // 1) 收集所有 `<stem>-*.json` 候选（含精确命名与历史无前缀命名）
  let all = [];
  try { all = readdirSync(HERE).filter((f) => f.startsWith(`${stem}-`) && f.endsWith('.json')); } catch { /* ignore */ }
  const cands = all.map((f) => join(HERE, f));
  for (const c of [exact, legacy]) if (c && !cands.includes(c)) cands.push(c);

  // 2) **优先取确证匹配（confidence=2）**；没有再退到"无法核对"（1）；确证不匹配（-1）永不取。
  const scored = cands.map((c) => ({ c, s: reportConfidence(c) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  if (scored.length && scored[0].s === 2) return scored[0].c;

  // 2b) 全是"无法核对"（历史报告没记 url）时，按**同一场景的另一个报告**的命名来对齐。
  //     实测：`.options-*.json` 老报告全都没有 url，于是按文件名排序会取到 `.options-report.json`
  //     （UIH-01 的），拿去判 UIH-02 → gate 2 报"9/9 个字段没有观察到弹窗"。
  //     而 `.explore-*` 那侧是有 url 的，已经能定位到正确场景；用它来选同名 options 最稳。
  if (scored.length) {
    const other = stem === '.options' ? '.explore' : '.options';
    const otherChosen = (() => {
      const os = readdirSync(HERE).filter((f) => f.startsWith(`${other}-`) && f.endsWith('.json'))
        .map((f) => ({ p: join(HERE, f), s: reportConfidence(join(HERE, f)) }))
        .filter((x) => x.s === 2).sort((a, b) => b.s - a.s);
      return os[0]?.p ?? null;
    })();
    if (otherChosen) {
      const suffix = otherChosen.split(/[\\/]/).pop().replace(other, '');   // 如 "-uih02.json"
      const sameName = join(HERE, `${stem}${suffix}`);
      if (cands.includes(sameName) && reportConfidence(sameName) > 0) {
        return sameName;
      }
    }
    return scored[0].c;
  }

  // 3) 都不匹配：如实报出来（让下游看到"没有可用普查"，而不是静默换文件）
  const firstExisting = [exact, legacy].find((c) => c && existsSync(c)) ?? cands[0];
  const tw = templateWfid();
  if (firstExisting && tw) {
    const j = (() => { try { return JSON.parse(readFileSync(firstExisting, 'utf8')); } catch { return null; } })();
    const w = j ? (wfidOf(j.url) ?? wfidOf(j.entry?.url)) : null;
    if (w && w !== tw) {
      process.stderr.write(
        `WARN: 报告 ${firstExisting.split(/[\\/]/).pop()} 属于 workflowid=${w}，` +
        `但模板是 workflowid=${tw} —— 不是同一张表单，已忽略。\n` +
        `      请重新跑阶段 1 普查（oa-explore-form.mjs）生成该表单的报告。\n`
      );
    }
  }
  return firstExisting ?? exact ?? legacy ?? cands[0];
};
// 认不到模板时**必须报错退出**，不能静默回落到某张默认模板 ——
// 那会让"数据是 A 单、模板是 B 单"这种情况一路填下去且不报错（早前踩过）。
const TEMPLATE = resolve(flag('--template') ?? autoTemplate() ?? (() => {
  process.stderr.write(
    'ERROR: 无法自动确定模板。\n' +
    '  纯数据 form_key = ' + (dataFormKey ?? '(缺失)') + '\n' +
    '  场景前缀 = ' + (scenarioPrefix ?? '(无法从文件名解析)') + '\n' +
    '  请显式指定：--template templates/<xxx>.template.json\n'
  );
  process.exit(2);
})());
const EXPLORE = resolve(flag('--explore') ?? autoReport('.explore'));
const OPTIONS = resolve(flag('--options') ?? autoReport('.options'));
const OUT = flag('--out') ?? join(HERE, '.run-report.json');
const SKIP_PRECHECK = has('--skip-precheck');
// 表单名优先取模板里的 biz_name（模板实际使用的键名；formName 作为兼容别名），
// 避免漏传 --form 时打开**另一个表单**却一路填下去。
const FORM_NAME = flag('--form') ?? (() => {
  try {
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    return t.formName ?? t.biz_name ?? null;
  } catch { return null; }
})() ?? 'UIH-01 采购申请单(上海联影)-SAP';

if (!DATA) { console.error('usage: --data <纯数据 JSON> [--template ...] [--form "<表单名>"]'); process.exit(1); }

const log = [];
const say = (s) => { log.push(s); process.stdout.write(s + '\n'); };
const steps = [];
/** 跑一个 node 子进程，返回 {ok, out, ms}；stdout/stderr 都收进来供解析 */
function runNode(script, args = [], label = '') {
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    out = String((e.stdout ?? '') + (e.stderr ?? ''));
    return { ok: false, out, ms: Date.now() - t0, code: e.status };
  }
}
/** 从引擎/脚本输出里抠出最后一个含 marker 的 JSON 行 */
function lastJson(text, marker) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s.includes(marker)) continue;
    const at = s.indexOf(marker);
    try { return JSON.parse(s.slice(at)); } catch { /* 继续往前找 */ }
  }
  return null;
}

say(`==== OA 填单（四阶段单一入口） ====`);
say(`场景: ${SCENARIO}`);
say(`模板: ${TEMPLATE}`);
say(`数据: ${DATA}`);
say('');

// ---------- 0) 内联脚本运行时自检 ----------
// 「文件语法通过」不等于「发给浏览器的脚本是对的」：模板字面量里的单反斜杠
// (\s) 会被吃掉变成裸字母 s，正则静默失效，甚至报 SyntaxError——而错误信息指不到位置。
// 这类问题只能在**运行时字符串**上查（见 universal-pitfalls #17），所以每次跑之前先自检。
if (!has('--skip-inline-check')) {
  const r = runNode('oa-check-inline.mjs', [HERE]);
  const summary = (r.out.trim().split(/\r?\n/).pop() ?? '').trim();
  say(`[0/5] 内联脚本自检  ${(r.ms / 1000).toFixed(1)}s  ${summary}`);
  if (/bad [1-9]/.test(summary)) {
    for (const line of r.out.trim().split(/\r?\n/).filter(l => l.includes('[BAD]'))) say(`      ${line.trim()}`);
    say('');
    say('结论：内联脚本自检未通过 —— 先修脚本，不要去跑浏览器。');
    writeFileSync(OUT, JSON.stringify({ scenario: SCENARIO, blockedAt: 'inline-check', log }, null, 2), 'utf8');
    process.exit(1);
  }
}

// ---------- 1) 离线预检 ----------
if (!SKIP_PRECHECK) {
  const r = runNode('oa-data-validate.mjs', ['--template', TEMPLATE, '--data', DATA]);
  const statusLine = (r.out.split(/\r?\n/).find(l => l.includes('状态：')) ?? '').trim();
  const inc = lastJson(r.out, '{"event":"data.incomplete"');
  steps.push({ step: '预检', ok: r.ok, ms: r.ms, detail: statusLine });
  say(`[1/5] 数据预检  ${(r.ms / 1000).toFixed(1)}s  ${r.ok ? '通过' : '未通过'}`);
  if (statusLine) say(`      ${statusLine}`);
  if (inc?.needsConfirm?.length) {
    say(`      ⚠ 有 ${inc.needsConfirm.length} 个值需要用户确认：`);
    for (const c of inc.needsConfirm) say(`        · ${c.name} = "${c.value}" —— ${c.why}`);
  }
  if (inc?.gaps?.length) {
    say(`      ⚠ 缺 ${inc.gaps.length} 项必填：`);
    for (const g of inc.gaps) say(`        · [${g.scope}] ${g.name}：${g.why} → ${g.action}`);
  }
  if (!r.ok) {
    say('');
    say('结论：预检未通过 —— 按机制**不进浏览器**，先把上面几项给用户确认/补齐。');
    writeFileSync(OUT, JSON.stringify({ scenario: SCENARIO, blockedAt: 'precheck', steps, log }, null, 2), 'utf8');
    process.exit(2);
  }
} else {
  steps.push({ step: '预检', ok: true, ms: 0, detail: '(skipped)' });
  say('[1/5] 数据预检  (已跳过)');
}

// ---------- 2) 前置：清理 / 登录 / 开表单 ----------
// **前置步骤失败就重试一次**。理由：这三个步骤都会新建 CDP 连接，而前一个脚本的连接
// 还没完全释放时，新连接偶发被取消（实测 `CHROME_CDP_UNAVAILABLE: TaskCanceledException`
// 与 `The managed Chrome process exited before DevTools became ready`）。
// 这些脚本**单独跑都稳定**（清理 6/6、登录 6/6、开单 8/8），只有紧挨着跑时才偶发 ——
// 属于"环境切换抖动"，不是业务失败。重试一次即可吸收，避免把抖动记成回归。
const pre = [];
for (const [label, script, args] of [
  ['清理残留标签页', 'close-stale-tabs.mjs', []],
  ['登录/门户', 'oa-login.mjs', []],
  ['打开表单', 'oa-open-form.mjs', ['--name', FORM_NAME]],
]) {
  let r = runNode(script, args);
  if (!r.ok) {
    say(`      ${label} 首次失败，2s 后重试一次…`);
    await new Promise((res) => setTimeout(res, 2000));
    const r2 = runNode(script, args);
    if (r2.ok) {
      r = { ...r2, ms: r.ms + r2.ms, retried: true };
      say(`      ${label} 重试后成功`);
    } else {
      r = r2;   // 两次都失败 → 用第二次的结果上报
    }
  }
  pre.push({ step: label, ok: r.ok, ms: r.ms, retried: r.retried === true });
  say(`[2/5] ${label.padEnd(14)} ${(r.ms / 1000).toFixed(1)}s  ${r.ok ? 'OK' : 'FAIL'}`);
  if (!r.ok) {
    say(`      ${r.out.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`);
    say('');
    say(`结论：前置步骤「${label}」失败，无法继续。`);
    writeFileSync(OUT, JSON.stringify({ scenario: SCENARIO, blockedAt: label, steps: [...steps, ...pre], log }, null, 2), 'utf8');
    process.exit(1);
  }
}
steps.push(...pre);

// ---------- 3) 填单引擎 ----------
const fill = runNode('oa-fill-engine.mjs', ['--template', TEMPLATE, '--data', DATA]);
const done = lastJson(fill.out, '{"event":"fill.done"');
steps.push({ step: '填单引擎', ok: Boolean(done), ms: fill.ms });
say(`[3/5] 填单引擎        ${(fill.ms / 1000).toFixed(1)}s  ${done ? '已返回结果' : 'FAIL'}`);
if (!done) {
  const errLine = fill.out.split(/\r?\n/).find(l => /TransportError|Error:/.test(l)) ?? '(无错误摘要)';
  say(`      ${errLine.trim().slice(0, 200)}`);
  say('');
  say('结论：引擎未产出结果，无法做门检查。');
  writeFileSync(OUT, JSON.stringify({ scenario: SCENARIO, blockedAt: 'engine', steps, log }, null, 2), 'utf8');
  process.exit(1);
}

// ---------- 4) 写引擎结果 + 跑 gate ----------
const enginePath = join(HERE, '.engine-last.json');
writeFileSync(enginePath, JSON.stringify(done, null, 2), 'utf8');

const gate = runNode('oa-gate.mjs', [
  '--report', EXPLORE, '--options', OPTIONS, '--template', TEMPLATE,
  '--data', DATA, '--engine', enginePath, '--phase', '4'
]);
steps.push({ step: '关卡检查', ok: gate.ok, ms: gate.ms, detail: gate.out.trim().split(/\r?\n/).slice(0, 8) });
say(`[4/5] 关卡检查        ${(gate.ms / 1000).toFixed(1)}s  ${gate.ok ? '全部通过' : '未通过'}`);
for (const line of gate.out.trim().split(/\r?\n/)) say(`      ${line}`);

// ---------- 5) 汇总 ----------
const totalMs = steps.reduce((a, s) => a + (s.ms || 0), 0);
say('');
say(`[5/5] 耗时汇总（合计 ${(totalMs / 1000).toFixed(1)}s）`);
for (const s of steps) say(`      ${String(s.step).padEnd(16)} ${(s.ms / 1000).toFixed(1)}s`);

// 回读摘要：让"哪些字段最终有值"一眼可见
const mv = (done.results ?? []).find(x => x.label === 'main:verify')?.value ?? {};
const filled = Object.entries(mv).filter(([, v]) => v && !/^\(/.test(String(v)));
const blanks = Object.entries(mv).filter(([, v]) => !v || /^\(/.test(String(v)));
say('');
say(`回读：有值 ${filled.length} 个，未填/不适用 ${blanks.length} 个`);
for (const [k, v] of blanks) say(`      · ${k} = ${JSON.stringify(v)}`);

const verdict = gate.ok ? '四阶段通过' : '未通过';
say('');
say(`结论：${verdict}${gate.ok ? ' —— 表单已学会，可进入下一更大阶段' : ' —— 见上方"回到阶段 N"'}`);

writeFileSync(OUT, JSON.stringify({
  scenario: SCENARIO, template: TEMPLATE, data: DATA,
  passed: gate.ok, totalMs, steps, readback: mv, log
}, null, 2), 'utf8');

process.exit(gate.ok ? 0 : 2);
