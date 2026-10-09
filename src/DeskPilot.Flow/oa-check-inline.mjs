/* 运行时自检：对所有脚本里"可能发给浏览器"的模板字面量做 vm 求值 + 语法检查。
   这正是 pitfalls #17 要求的做法 —— 检查生成结果，而不是源码文本。

   除语法外还查一类**静默**错误：内层代码里的 ${...} 被外层模板先吃掉。
   源码看起来完全正常，跑起来才 ReferenceError（实测踩到 `id is not defined`）。 */
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';

const dir = process.argv[2];
const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('.'));
let totalBad = 0, totalChecked = 0, totalSuspect = 0;

// 外层模板里出现的 ${标识符} 应为脚本自身作用域里的变量；否则多半是"内层代码被误插值"。
// 只对**明显属于内层**的名字报警，避免误伤（白名单为脚本里真实使用的外层变量）。
const OUTER_VARS = new Set(['fn', 'name', 'spec', 'sel', 'value', 'key', 'want', 'searchValue',
  'JSON', 'k', 'w', 'probe', 'boxHow', 'searchIndex', 'detail', 'i', 'col', 'n', 'l', 'idx']);

for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8');
  const re = /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*`/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const from = m.index + m[0].length - 1;
    let i = from + 1, end = -1;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { end = i; break; }
      i++;
    }
    if (end < 0) continue;
    const body = src.slice(from + 1, end);
    // 内层 ${...}：若标识符不在外层白名单里，很可能是内层代码被误插值
    for (const mm of body.matchAll(/\$\{([A-Za-z_$][\w$]*)\s*\}/g)) {
      const id = mm[1];
      if (!OUTER_VARS.has(id)) {
        totalSuspect++;
        console.log(`  [SUSPECT] ${f} :: ${name}  \${${id}} —— 若它不是外层变量，运行时会 ReferenceError`);
      }
    }
    const declSrc = src.slice(m.index, end + 1);
    let value;
    try {
      const ctx = vm.createContext({});
      value = vm.runInContext(`${declSrc}\n; ${name}`, ctx);
    } catch { continue; }
    if (typeof value !== 'string' || value.length < 20) continue;
    totalChecked++;
    try { new Function(value); }
    catch (e) {
      totalBad++;
      console.log(`  [BAD] ${f} :: ${name}  ${e.message}`);
      const lines = value.split('\n');
      for (const [n, l] of lines.entries()) {
        if (/\/[^/\n]*\b(s|d|w)\b/.test(l) && !/\\/.test(l)) console.log(`        L${n + 1}: ${l.trim().slice(0, 100)}`);
      }
    }
  }
}
console.log(`checked ${totalChecked} template literals, bad ${totalBad}, suspect-interpolation ${totalSuspect}`);
