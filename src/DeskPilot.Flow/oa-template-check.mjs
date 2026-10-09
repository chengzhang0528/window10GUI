/* 模板自检：核对模板里**写死的 `#fieldNNNNN` 选择器**是否真的存在于目标表单的普查报告里。
 *
 * 为什么需要：实测踩过一次 —— 武汉变体的「币种」`selector` 抄了上海的 `#field68004`，
 * 而该 id 在武汉变体**根本不存在**（真实是 `#field68134`）。后果极其隐蔽：
 * 弹窗选行**其实成功了**，但引擎用 `spec.selector` 回读，读不到元素 → 报 `NOT_FILLED(空)`，
 * 看起来像"选行失败"，实际是"回读选择器错"。
 *
 * 判据来源（普查报告里同一个字段可能把 id 放在不同键上）：
 *   · inputId      —— 普通 input 的 id
 *   · assocId      —— 关联/弹窗类字段，形如 `field68134span`（去掉 span 后缀即 input id）
 *   · selectorHint —— 结构选择器（形如 [data-fieldname=bz] ...）
 *
 * 用法：
 *   node oa-template-check.mjs --template templates/xxx.template.json --census .explore-xxx.json
 * 退出码：全部命中 = 0；有硬编码 id 在普查里找不到 = 1。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };

const tplPath = flag('--template');
const censusPath = flag('--census');
if (!tplPath || !censusPath) {
  console.error('usage: --template <template.json> --census <explore.json>');
  process.exit(2);
}

let tpl, census;
try { tpl = JSON.parse(readFileSync(tplPath, 'utf8')); }
catch (e) { console.error(`读不到/解析失败 模板 ${tplPath}: ${e.message}`); process.exit(2); }
try { census = JSON.parse(readFileSync(censusPath, 'utf8')); }
catch (e) { console.error(`读不到/解析失败 普查 ${censusPath}: ${e.message}`); process.exit(2); }

// 收集普查里所有"被认可的 id"
const known = new Set();
const addId = (s) => {
  if (typeof s !== 'string' || !s) return;
  known.add(s);
  // assocId 形如 field68134span / field84777span → 同时也接受去掉 span 的主体
  const m = s.match(/^(field\d+)span$/);
  if (m) known.add(m[1]);
};
for (const f of (census.fields ?? [])) {
  addId(f.inputId);
  addId(f.assocId);
  if (typeof f.selectorHint === 'string') known.add(f.selectorHint);
}
// 明细列的 id 形如 field67932_0（`_N` 是行号占位）。普查里出现的是**某一行**的实例，
// 所以比对时要按"前缀 + 下划线"归一化，不能拿 field67932_N 字面量去查。
const knownDetailPrefix = new Set();
for (const s of known) {
  const m = String(s).match(/^(field\d+)_\d+$/);
  if (m) knownDetailPrefix.add(m[1]);
}
const hasId = (id) => {
  if (known.has(id)) return true;
  const m = id.match(/^(field\d+)_N$/);            // 明细列占位
  if (m && knownDetailPrefix.has(m[1])) return true;
  return false;
};

// 扫模板里写死的 #fieldNNNNN
const hits = [];
const scan = (obj, where) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const s = (typeof v === 'string') ? v : (v && typeof v === 'object' ? v.selector : null);
    if (typeof s === 'string' && /#field\d+/.test(s)) hits.push({ where: `${where}:${k}`, sel: s, id: s.replace('#', '') });
  }
};
scan(tpl.field_map, 'field_map');
scan(tpl.detail_columns?.columns, 'detail_columns');

// 只读/展示型字段本就可能是 span（没有 input id），不参与"硬编码 id 是否存在"的核对。
// 它们的风险不同：写错了也不会被写值，只会回读为"(不在 DOM)"并被 gate 4 报出来。
const readonlyNames = new Set(tpl.readonly_fields ?? []);
const bad = hits.filter((h) => {
  if (hasId(h.id)) return false;
  // 只读字段放宽：其 selector 常指向 span/展示节点，普查里记的是 assocId
  const nm = h.where.split(':').pop();
  if (readonlyNames.has(nm)) return false;
  return true;
});
const skippedReadonly = hits.filter((h) => !hasId(h.id) && readonlyNames.has(h.where.split(':').pop()));

// **首要前提**：普查报告必须来自**同一张表单**。实测踩过 —— 生成普查时 `oa-open-form`
// 并没有真的切到目标表单，于是普查拿到的是**上一张表单**的字段（workflowid 不同），
// 结果几十个 id "找不到"，看起来像模板全错，其实是普查张冠李戴。
// 用 workflowid 比对最直接：从两份文件的 URL 里各抽一个。
const wfidOf = (u) => { const m = String(u ?? '').match(/workflowid=(\d+)/); return m ? m[1] : null; };
const tplWfid = wfidOf(tpl.entry?.url) ?? wfidOf(tpl.notes?.form_id) ?? wfidOf(tpl.entry?.attach?.url_contains);
const censusWfid = wfidOf(census.url) ?? wfidOf(census.entry?.url);
// 模板的 entry.url 常是通用入口（不含 workflowid），此时以 notes.form_id 为准
const tplWfid2 = wfidOf(tpl.notes?.form_id) ?? tplWfid;
const sameForm = (tplWfid2 && censusWfid) ? (tplWfid2 === censusWfid) : null;

console.log(`模板：${tplPath}`);
console.log(`普查：${censusPath}（字段 ${(census.fields ?? []).length}）`);
if (tplWfid2 || censusWfid) {
  console.log(`表单核对：模板 workflowid=${tplWfid2 ?? '(未记)'}  普查 workflowid=${censusWfid ?? '(未记)'}  ${sameForm === false ? '❌ 不是同一张表单' : sameForm === true ? '✓ 一致' : '(无法判定)'}`);
}
console.log('');
if (sameForm === false) {
  console.log('不通过（前提性错误）：**普查报告与模板不是同一张表单**。');
  console.log('  这种情况下所有 id 核对都没有意义 —— 先重新生成普查，确认它来自目标表单。');
  console.log('  常见原因：`oa-open-form` 之后普查脚本 attach 到了残留的旧表单标签页（见 universal-pitfalls #1）。');
  process.exit(2);
}
if (!hits.length) {
  console.log('模板里没有写死 #fieldNNNNN 的选择器（全部使用结构选择器）—— 无需核对。');
  process.exit(0);
}
console.log('写死的 #fieldNNNNN 核对结果：');
for (const h of hits) {
  const ok = hasId(h.id);                               // 与判定用同一函数，避免"列表说✗、结论说通过"
  const ro = readonlyNames.has(h.where.split(':').pop());
  const isDetail = /_N$/.test(h.id);
  const mark = ok ? (isDetail ? '✓ 普查中存在（按明细行前缀匹配）' : '✓ 普查中存在')
                  : (ro ? '– 只读字段（跳过）' : '✗ 普查中找不到');
  console.log(`  ${h.where.padEnd(24)} ${h.sel.padEnd(16)} ${mark}`);
}
console.log('');
if (skippedReadonly.length) {
  console.log(`（${skippedReadonly.length} 个只读字段的 id 未在普查中找到 —— 只读字段多为展示 span，属正常；如回读报"(不在 DOM)"再来查。）`);
  console.log('');
}
// 重要前提校验：普查报告若连**任何**明细行 id 都没记录，说明它是在"明细行尚未实例化"时导出的
// （或导出的表单与该模板不是同一张）。此时明细列的 `_N` 必然全部"找不到" ——
// 这是**普查报告不够新**，不是模板有 19 个 bug。必须把这两种情况分开报，否则会误导。
const censusHasAnyDetail = knownDetailPrefix.size > 0;
const detailHits = hits.filter((h) => /_N$/.test(h.id));
if (detailHits.length && !censusHasAnyDetail) {
  console.log(`注意：普查报告里**没有任何明细行 id**（形如 fieldNNNNN_0），但有 ${detailHits.length} 个明细列待核对。`);
  console.log('      这说明该普查是在"明细行尚未渲染"时导出的 —— 请重新跑阶段 1 普查后再核对；');
  console.log('      在拿到新普查之前，明细列的结论不可信（不等于模板有错）。');
  console.log('');
}

if (bad.length) {
  console.log(`不通过：${bad.length} 个硬编码 id 在普查里不存在。`);
  console.log('这会导致"实际写入了、但回读读错元素"的假失败。请改用当前表单实测的 id，');
  console.log('或优先使用 [data-fieldname=xxx] 这类结构选择器（跨变体稳定）。');
  process.exit(1);
}
console.log('通过：所有硬编码 id 都能在普查里找到（只读字段按规则跳过）。');

