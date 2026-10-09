/* 解析 oa-fill-engine 的 fill.done 输出，摘要打印关键步骤与回读。
 * 用法：node show-fill-result.mjs <.fill-line.txt>
 * 单独成文件是为了避免在 PowerShell 里内联 JS 时引号被吃掉。 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: show-fill-result.mjs <file>'); process.exit(2); }
const text = readFileSync(path, 'utf8');
const marker = '{"event":"fill.done"';
const i = text.indexOf(marker);
if (i < 0) { console.log('没有 fill.done（引擎未跑完）'); process.exit(1); }
const obj = JSON.parse(text.slice(i));
// 同时落一份纯 JSON 供 oa-gate.mjs --engine 使用（从整行里剥出对象）
const { writeFileSync } = await import('node:fs');
const engineOut = process.argv[3];
if (engineOut) writeFileSync(engineOut, JSON.stringify(obj, null, 2), 'utf8');

const show = v => JSON.stringify(v ?? null).slice(0, 78);
let fails = 0;
console.log('--- 关键步骤 ---');
for (const x of obj.results) {
  if (!/pick|dialog|leftover|fallback|searchbox-how|:open$/.test(x.label)) continue;
  if (x.ok === false) fails++;
  console.log((x.ok === false ? 'FAIL' : 'OK  ') + '  ' + x.label.padEnd(24) + ' ' + show(x.value));
}
const mv = obj.results.find(x => x.label === 'main:verify');
if (mv) {
  console.log('');
  console.log('--- 回读（main:verify） ---');
  for (const [k, v] of Object.entries(mv.value)) {
    const mark = (v === '' || v === null) ? '  <-- 空' : '';
    console.log('  ' + k.padEnd(14) + ' = ' + JSON.stringify(v) + mark);
  }
}
const dv = obj.results.find(x => x.label === 'detail:verify#0');
if (dv) {
  console.log('');
  console.log('--- 明细行 #0 ---');
  for (const [k, v] of Object.entries(dv.value)) console.log('  ' + k.padEnd(16) + ' = ' + JSON.stringify(v));
}
console.log('');
console.log('失败步骤数=' + fails);
process.exit(fails ? 1 : 0);
