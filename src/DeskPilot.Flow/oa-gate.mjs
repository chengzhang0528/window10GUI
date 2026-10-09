/*
 * OA 填单四阶段「关卡检查器」。
 *
 * 为什么需要它（实测教训）：
 *   SKILL.md 里写了"阶段 2 未穷尽不得进阶段 3"，但那一轮**照样违反了** ——
 *   直接跑去阶段 4，在验证时才发现三个字段填不上，才回头意识到阶段 2 从没覆盖过弹窗。
 *   规则只是文字时，没有任何东西会拦住你。
 *
 * 所以把"关卡"做成**可执行的检查**：每个阶段产出的探查/数据文件都在这里被机械校验，
 * 未过就明确说出"回到第几阶段"，而不是让人凭感觉往前走。
 *
 * 用法：
 *   node oa-gate.mjs --report <explore-report.json> [--options <options-report.json>]
 *                    [--template <template.json>] [--data <data.json>...] [--phase 2]
 * 退出码：0=通过；2=未通过（打印卡在哪、回到哪一阶段）
 */
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
const flags = n => argv.reduce((acc, a, i) => (a === n && argv[i + 1] ? (acc.push(argv[i + 1]), acc) : acc), []);

function readJson(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; }
}

const INTERACTIVE = new Set(['select', 'browser', 'browser-clickable', 'browser-select', 'radio']);

/** 关卡 1：普查完整性 */
function gate1(explore) {
  const failures = [];
  if (!explore?.fields?.length) {
    failures.push({ why: '探查报告里没有任何字段', back: 1, fix: '先跑 oa-explore-form.mjs（并确认表单已渲染：字段数为 0 通常是 attach 后 Vue 还没挂载）' });
    return failures;
  }
  const kinds = {};
  for (const f of explore.fields) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  // "other" 允许存在，但必须已经看过原始 HTML；这里只用它提示需要人确认
  if (!kinds['browser-clickable'] && !kinds['browser-select'] && !kinds['select'] && !kinds['radio']) {
    failures.push({ why: '一个交互控件都没识别出来（全是 text/other），分类逻辑可能失效', back: 1, fix: '检查 INVENTORY 的分类条件' });
  }
  return failures;
}

/** 关卡 2：穷尽完整性 —— 这是之前被跳过的关卡 */
function gate2(explore, options, template) {
  const failures = [];
  if (!explore?.fields?.length) return [{ why: '没有普查结果，无法判定穷尽', back: 1, fix: '先过 gate 1' }];

  // 只有"真正可交互"的字段才需要穷尽。判定要看**尺寸**和**是否有点击目标**，
  // 不能只看类型 —— 实测同一页里：
  //   · w=0 的字段（cgy/gys/gysdd/jfh/gs/...）当前表单状态下根本没渲染，不适用
  //   · w>0 但没有放大镜按钮的字段（sqr/zxzz/zk/ck/jffzr/xmjl）是只读展示字段，
  //     外层没有 wea-field-readonly 标记，但确实没有触发元素
  // 把这两类当成"未穷尽"会永远卡住；当成"已穷尽"又会漏掉真正的缺口。
  const rendered = explore.fields.filter(f => (f.w ?? 0) > 0);
  const unrendered = explore.fields.filter(f => (f.w ?? 0) === 0);

  const isInteractive = f => {
    if (!rendered.includes(f)) return false;
    if (f.kind === 'select' || f.kind === 'radio') return true;
    if (f.kind === 'browser-clickable' || f.kind === 'browser-select') {
      // browser 字段必须真有可点触发元素才算可交互
      return f.hasButton === true || f.kind === 'browser-clickable';
    }
    return false;
  };

  const interactive = explore.fields.filter(isInteractive);
  if (!options) {
    failures.push({ why: `有 ${interactive.length} 个可交互控件，但没有 options 探查报告`, back: 2, fix: '跑 oa-explore-options.mjs' });
    return failures;
  }

  const selects = interactive.filter(f => f.kind === 'select');
  const brows = interactive.filter(f => f.kind === 'browser-clickable' || f.kind === 'browser-select');
  const radios = interactive.filter(f => f.kind === 'radio');

  // select：每个都要有完整选项表
  const missingSelects = selects.filter(f => {
    const s = options.selects?.[f.fieldname];
    return !s || !(s.options?.length) || s.clicked !== true;
  });
  if (missingSelects.length) {
    failures.push({
      why: `${missingSelects.length}/${selects.length} 个 select 没有记录到选项`,
      fields: missingSelects.map(f => f.fieldname + '(' + (options.selects?.[f.fieldname]?.note ?? '未展开') + ')'),
      back: 2, fix: '用 chrome.click 点 [data-fieldname=X] .ant-select 展开；页面内 .click() 不可靠'
    });
  }

  // radio：每组都要有全部标签
  const missingRadios = radios.filter(f => !(options.radios?.[f.fieldname]?.length));
  if (missingRadios.length) {
    failures.push({
      why: `${missingRadios.length}/${radios.length} 个 radio 组没有记录到标签`,
      fields: missingRadios.map(f => f.fieldname), back: 2, fix: '读 label.ant-radio-wrapper 的文本'
    });
  }

  // browser：每个都要有"弹窗身份 + 行数"
  const browsMissing = [];
  const browsNoTitle = [];
  for (const f of brows) {
    const b = options.browsers?.[f.fieldname];
    const modal = b?.modals?.[0];
    if (!modal) { browsMissing.push(f.fieldname); continue; }
    if (!modal.title) browsNoTitle.push(f.fieldname);
  }
  if (browsMissing.length) {
    failures.push({
      why: `${browsMissing.length}/${brows.length} 个可交互 browser 字段没有观察到弹窗`,
      fields: browsMissing, back: 2,
      fix: '触发元素是 [data-fieldname=X] button.ant-btn-icon-only（用 chrome.click）；点输入区不会开弹窗'
    });
  }
  if (browsNoTitle.length) {
    failures.push({
      why: `${browsNoTitle.length} 个 browser 弹窗没记录到标题，无法确认弹窗身份`,
      fields: browsNoTitle, back: 2, fix: '读 .ant-modal-title —— 弹窗身份会随上游值变化，必须记录'
    });
  }

  // 状态相关：弹窗身份依赖上游值时，单状态快照不算穷尽
  const stateDependent = template?.state_dependent_controls ?? [];
  const observedStates = options.observed_states ?? [];
  if (stateDependent.length && observedStates.length < 2) {
    failures.push({
      why: `模板声明了 ${stateDependent.length} 个"随状态变化"的控件，但只在 ${observedStates.length} 种状态下观察过`,
      fields: stateDependent, back: 2,
      fix: '对每种会产生不同弹窗的状态各观察一次，把状态记进 options 报告'
    });
  }

  return { failures, stats: { rendered: rendered.length, unrendered: unrendered.length, interactive: interactive.length, selects: selects.length, brows: brows.length, radios: radios.length } };
}

/** 关卡 3：数据完整性（调用离线校验器的结论） */
function gate3(template, dataPaths) {
  const failures = [];
  if (!dataPaths.length) {
    failures.push({ why: '没有任何纯数据文件', back: 3, fix: '按阶段 1-2 的结果造数据（每个有意义的分支一份）' });
    return failures;
  }
  if (!template) {
    failures.push({ why: '没给模板，无法校验数据', back: 3, fix: '传 --template' });
    return failures;
  }
  const catalog = template.value_catalog ?? {};
  const catalogsAvailable = Object.keys(catalog).filter(k => !k.startsWith('_')).length;
  if (catalogsAvailable === 0) {
    failures.push({
      why: '模板没有 value_catalog，校验器无法判断值是否在已知范围内（预检会形同虚设）',
      back: 2, fix: '把阶段 2 探查到的选项写进模板 value_catalog'
    });
  }
  for (const p of dataPaths) {
    const d = readJson(p);
    if (!d) { failures.push({ why: `数据文件无法解析: ${p}`, back: 3, fix: '修 JSON' }); continue; }
    // 必填齐不齐、有没有待确认项，交给 oa-data-validate.mjs 判定；
    // 这里只做结构性检查，避免两处规则漂移。
    if (!d.values || typeof d.values !== 'object') {
      failures.push({ why: `${p} 缺 values 对象`, back: 3, fix: '补 values' });
    }
  }
  return failures;
}

/** 关卡 4：验证完整性（需要 engine 的运行结果） */
function gate4(engineResult, template) {
  const failures = [];
  if (!engineResult) {
    failures.push({ why: '没有引擎运行结果', back: 4, fix: '跑 oa-fill-engine.mjs' });
    return failures;
  }
  const results = engineResult.results ?? [];
  const byLabel = new Map(results.map(r => [r.label, r]));

  // 模板里每个非 readonly / 非 derived / 非条件隐藏 的字段，都必须有回读值
  const mustRead = [];
  for (const [name, spec] of Object.entries(template?.field_map ?? {})) {
    if (spec?.readonly === true) continue;
    if (spec?.derived === true || spec?.type === 'derived') continue;
    mustRead.push(name);
  }
  const readback = byLabel.get('main:verify')?.value ?? {};
  // 空值判定：'' / null / 明确的"未渲染/条件未显示"都不算已填。
  // 实测教训：曾把 (不可见) 记成失败、又曾把空字符串当通过，两头都会误报。
  const EMPTY = v => v === undefined || v === null || v === '' ||
    (typeof v === 'string' && /^\((未渲染|不在 DOM|条件未显示)\)$/.test(v));

  // 例外规则：**有据可依的"未填"不算失败**，但必须留下理由，不能静默放过。
  //   · conditional-detail（如工厂）在当前状态下不渲染 → 依设计不填
  //   · optional 字段（如加签人）拿不到候选 → 允许留空，但要如实上报
  // 除此之外的空值都算真缺口。
  const excused = [];
  const emptyVals = [];
  for (const n of mustRead) {
    if (!(n in readback)) continue;
    if (!EMPTY(readback[n])) continue;
    const spec = template?.field_map?.[n] ?? {};
    if (spec.type === 'conditional-detail') { excused.push({ name: n, reason: '条件字段，当前状态下不渲染' }); continue; }
    if (spec.type === 'datepicker') { excused.push({ name: n, reason: '日期选择器：数据未提供或目标日期不可选 —— 已如实上报' }); continue; }
    if (spec.type === 'upload') { excused.push({ name: n, reason: '附件字段（内容为页面内构造，非磁盘真实文件；仅验证上传链路）—— 已如实上报' }); continue; }
    if (spec.finance_section === true) { excused.push({ name: n, reason: '财务凭证区块，不由申请人填写（未编造）' }); continue; }
    if (spec.optional === true) { excused.push({ name: n, reason: '可选字段，未取得候选（已如实上报）' }); continue; }
    emptyVals.push(n + '=' + JSON.stringify(readback[n]));
  }

  const unanswered = mustRead.filter(n => !(n in readback));
  if (unanswered.length) {
    failures.push({ why: `${unanswered.length} 个字段没有回读记录`, fields: unanswered, back: 4, fix: '在 main:verify 里包含它们' });
  }
  if (emptyVals.length) {
    failures.push({
      why: `${emptyVals.length} 个字段回读为空（数据没进表单）`,
      fields: emptyVals,
      back: 3, fix: '先确认该字段在当前状态下是否真的渲染；若渲染了却为空，多半是写入被联动清掉（调整填写顺序）或需要弹窗选择'
    });
  }
  // 例外项作为提示输出（不阻断），确保"没填"永远是可见的
  if (excused.length) {
    failures.excused = excused;
  }

  // 失败的步骤要知道回到哪一阶段
  const formRejections = [];
  for (const r of results) {
    if (r.ok !== false) continue;
    const label = r.label ?? '';
    const valStr = JSON.stringify(r.value ?? '');
    // OA 主动改写为别的非空值 = 业务规则拒绝，不是脚本缺陷。
    // 这类要交给用户判断，不回到任何阶段去"修"。
    if (/REJECTED_BY_FORM/.test(valStr)) {
      formRejections.push({ field: label, detail: r.value });
      continue;
    }
    let back = 4, hint = '运行/交互问题';
    if (/:pick$/.test(label) && /no_modal|row_not_found|NOT_FILLED/.test(valStr)) {
      back = 2; hint = '弹窗没开/没行/没回填 —— 该控件的弹窗还没被穷尽（阶段 2）';
    } else if (/:open$/.test(label) || /NOT_IN_VIEW/.test(valStr)) {
      back = 1; hint = '打不开控件/滚不到 —— 普查里的可点元素或可见性判断不对（阶段 1）';
    } else if (r.code === 'no_value' || r.code === 'no_search_value') {
      back = 3; hint = '缺数据 —— 阶段 3 没覆盖这个分支';
    }
    failures.push({ why: `步骤失败: ${label}`, detail: r.value ?? r.code, back, fix: hint });
  }
  if (formRejections.length) failures.formRejections = formRejections;
  return failures;
}

const phase = Number(flag('--phase') ?? 4);
const explore = readJson(flag('--report') ?? '');
const options = readJson(flag('--options') ?? '');
const template = readJson(flag('--template') ?? '');
const dataPaths = flags('--data');
const engineResult = readJson(flag('--engine') ?? '');

const gates = { 1: () => gate1(explore), 2: () => gate2(explore, options, template), 3: () => gate3(template, dataPaths), 4: () => gate4(engineResult, template) };

const PHASE_NAME = { 1: '普查', 2: '穷尽', 3: '造数', 4: '验证' };
const out = [];
let failed = false;
// 关卡必须顺序检查：任何前序未过，后面都不算数（这就是"未穷尽不得进下一阶段"的机械化）
for (let p = 1; p <= phase; p++) {
  const raw = gates[p]();
  const f = Array.isArray(raw) ? raw : (raw.failures ?? []);
  // excused 可能挂在数组上（gate4 返回的是数组 + 附加属性），也可能在对象里
  const excused = (Array.isArray(raw) ? raw.excused : raw.excused) ?? [];
  const rejections = (Array.isArray(raw) ? raw.formRejections : raw.formRejections) ?? [];
  const stats = Array.isArray(raw) ? null : raw.stats;
  const ok = f.length === 0;
  out.push(`gate ${p} (${PHASE_NAME[p]}): ${ok ? '通过' : '未通过'}`);
  if (stats) out.push(`    规模: 已渲染=${stats.rendered} 未渲染=${stats.unrendered} 可交互=${stats.interactive} (select ${stats.selects} / browser ${stats.brows} / radio ${stats.radios})`);
  if (excused.length) {
    // 有理由的未填：不阻断，但必须显示出来 —— 让"没填"永远可见
    out.push(`    有据可依未填 ${excused.length} 项（不阻断，但已记录）:`);
    for (const e of excused) out.push(`      · ${e.name} —— ${e.reason}`);
  }
  if (rejections.length) {
    // OA 主动改写 = 业务规则拒绝。不回到任何阶段去"修"，交用户判断。
    out.push(`    OA 业务规则拒绝 ${rejections.length} 项（非脚本缺陷，需用户确认）:`);
    for (const r of rejections) out.push(`      · ${r.field} —— ${JSON.stringify(r.detail).slice(0, 120)}`);
  }
  if (!ok) {
    failed = true;
    for (const x of f) {
      out.push(`    - ${x.why}`);
      if (x.fields?.length) out.push(`      涉及字段: ${x.fields.join(', ')}`);
      if (x.detail) out.push(`      详情: ${JSON.stringify(x.detail).slice(0, 200)}`);
      out.push(`      → 回到阶段 ${x.back}：${x.fix}`);
    }
    break;   // 停在第一个未过的关卡，不继续评估后面
  }
}
process.stdout.write(out.join('\n') + '\n');
if (failed) {
  process.stdout.write(JSON.stringify({ event: 'gate.blocked', lastGate: out[0] }) + '\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  event: 'gate.passed', phases: phase,
  next: phase >= 4 ? '四阶段完成 → 进入下一更大阶段：用真实业务数据填单 / 扩展到第二张表单 / 固化为例行能力' : `可进入阶段 ${phase + 1}`
}) + '\n');
