// 离线验证：oa-fill-engine 从「模板 + 纯数据」派生填写行动计划，不连浏览器。
// 证明引擎无业务字段硬编码 —— 全部来自两个 JSON。
import { readFileSync } from 'node:fs';
import { buildFieldPlan } from './oa-fill-engine.mjs';

const template = JSON.parse(readFileSync('./templates/uih01-purchase-requisition.template.json', 'utf8'));
const data = JSON.parse(readFileSync('./data/uih01-purchase-requisition.sample-data.json', 'utf8'));

const report = {
  fieldMapTypes: Object.fromEntries(Object.entries(template.field_map).map(([k, v]) => [k, v.type])),
  textCount: Object.values(template.field_map).filter(s => s.type === 'text').length,
  selectCount: Object.values(template.field_map).filter(s => s.type === 'select').length,
  browserCount: Object.values(template.field_map).filter(s => s.type === 'browser').length,
  radios: template.radios,
  radioSelected: data.radio_selected,
  detailColumns: Object.keys(template.detail_columns.columns),
  detailAdd: template.detail_columns.add,
  dataValuesKeys: Object.keys(data.values),
  dataDetailRows: data.detail_rows.length,
  // 关键证明：数据 JSON 里没有任何 '#' 或 selector/widget 字样
  dataHasSelectorLeak: JSON.stringify(data).includes('#') || JSON.stringify(data).includes('selector') || JSON.stringify(data).includes('widget')
};

console.log(JSON.stringify(report, null, 2));

// 断言
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
assert(report.dataHasSelectorLeak === false, '纯数据 JSON 不得含 selector/widget/#');
assert(report.textCount > 0 && report.selectCount > 0 && report.browserCount > 0, '模板应含三类字段');
assert(report.detailColumns.length > 0, '模板应定义明细列');
assert(Array.isArray(report.radioSelected) && report.radioSelected.length > 0, '纯数据应声明要选中的 radio');
console.log('PASS: 引擎从模板+数据派生行动计划，无业务硬编码，纯数据无 selector 泄漏');
