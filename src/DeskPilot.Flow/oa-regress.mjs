/* 回归跑批：把 data/*.data.json 里所有场景依次跑一遍，汇总结果。
 *
 * 为什么需要它：实测 data/ 下曾有一个长期没跑过的 `uih01-e2e-verify.data.json`，
 * 里面 `经费` 写成项目号、`radio_selected` 含表单已锁定的选项 —— 与已沉淀的事实冲突，
 * 但因为从没进过回归，一直没人发现。**未被回归覆盖的数据文件会悄悄腐化**，
 * 所以把"跑全部场景"固化成一条命令。
 *
 * 用法：
 *   node oa-regress.mjs                # 跑 data/ 下全部 *.data.json
 *   node oa-regress.mjs --only uih01   # 只跑文件名含 uih01 的
 *   node oa-regress.mjs --repeat 2     # 每个场景连跑 2 轮（用于排查偶发）
 *
 * 退出码：全部通过 = 0；有任一场景失败 = 1。
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };

const only = flag('--only');
const repeat = Math.max(1, Number(flag('--repeat') ?? 1) || 1);

const dir = join(HERE, 'data');
let files = readdirSync(dir).filter((f) => f.endsWith('.data.json') && !f.startsWith('.'));
if (only) files = files.filter((f) => f.includes(only));
files.sort();

// 已知未完成的场景：文件名前缀加 `wip-` 表示"在途"，默认跳过（用 --include-wip 才跑）。
// 这样回归套件保持"全绿即可信"的门禁语义，不会因为一个还在阶段 2 的场景长期飘红，
// 让人逐渐忽略红色 —— 那正是最危险的状态。
const includeWip = argv.includes('--include-wip');
const wip = [];
if (!includeWip) {
  const before = files.length;
  files = files.filter((f) => !f.startsWith('wip-'));
  if (files.length !== before) wip.push(...['(wip- 前缀场景已跳过，加 --include-wip 可跑)']);
}

if (!files.length) {
  console.error(`没有匹配的场景${only ? `（--only ${only}）` : ''}：${dir}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const summary = [];

for (let round = 1; round <= repeat; round++) {
  if (repeat > 1) console.log(`\n########## 第 ${round}/${repeat} 轮 ##########`);
  for (const f of files) {
    const name = f.replace(/\.data\.json$/, '');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [join(HERE, 'oa-run.mjs'), '--data', join(dir, f)],
        { encoding: 'utf8', timeout: 15 * 60 * 1000 });
    } catch (e) {
      code = typeof e.status === 'number' ? e.status : 1;
      out = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    // 回读行与结论行（oa-run 的输出格式稳定，直接抓）
    const rb = (out.match(/回读：.*/) || [''])[0].trim();
    const verdict = (out.match(/结论：.*/) || [''])[0].trim();
    console.log(`${pad(name, 24)} exit=${code}  ${rb}`);
    if (code !== 0 && verdict) console.log(`${' '.repeat(24)} ${verdict}`);
    summary.push({ name, code, rb });
  }
}

const failed = summary.filter((s) => s.code !== 0);
console.log('');
console.log(`${'场景'.padEnd(24)} 结果`);
for (const s of summary) console.log(`${pad(s.name, 24)} ${s.code === 0 ? '通过' : '未通过 (exit ' + s.code + ')'}`);
console.log('');
console.log(`合计：${summary.length - failed.length} / ${summary.length} 通过`);
process.exit(failed.length ? 1 : 0);
