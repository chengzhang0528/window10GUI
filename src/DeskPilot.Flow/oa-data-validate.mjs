/*
 * 纯数据校验器：填单前检查「纯数据 JSON」是否满足「模板 JSON」的必填要求。
 *
 * 目的：OA 会因空闲超时清空整张未保存表单（deskpilot-oa-fill 坑 #3），
 * 所以必须在真正填单前先把「纯数据」校验齐全，否则填到一半因缺必填失败、
 * 又得整单重来。本脚本不连浏览器，纯离线校验。
 *
 * 规则（与 template-format.md 对齐）：
 *   - 模板 field_map 中 required=true 的字段，纯数据 values 里必须存在且非空。
 *   - 明细行：模板 detail_columns 里标 required 的列，每行都必须有值。
 *     （当前模板把「必填明细列」记在 notes.detail_required_columns，以该声明为准。）
 *   - 纯数据泄露检查：values/detail_rows 里不得出现 '#' 开头的 selector 或 'widget' 字样。
 *
 * 用法：node oa-data-validate.mjs --template <模板> --data <纯数据>
 * 退出码：0=通过；2=校验失败（打印缺失清单）。
 */
import { readFileSync } from 'node:fs';

function normalize(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function validate(template, data) {
  const errors = [];
  const missing = [];   // 结构化缺口：{scope, name, why, howToFix}

  // 1) 必填字段
  const values = data?.values ?? {};
  const deferred = [];   // 非申请人职责的必填项（如财务凭证区块），不计为缺口但如实列出
  for (const [name, spec] of Object.entries(template?.field_map ?? {})) {
    // derived 字段由页面/系统带出，不要求用户提供
    if (spec?.derived === true || spec?.type === 'derived') continue;
    // 财务凭证区块等"不由申请人填写"的字段：必填但要人工/财务补，
    // 不该拦住填单，也绝不能凭空编造（如凭证号）。单列出来交用户判断。
    if (spec?.finance_section === true) {
      const has = Object.prototype.hasOwnProperty.call(values, name);
      const v = normalize(values[name]);
      if (!has || v === '') {
        deferred.push({ scope: '表头', name, why: '属财务凭证区块，申请人不填', action: `如确需预填，在 values 里补 "${name}"；否则留给财务环节` });
        continue;
      }
    }
    if (!spec?.required) continue;
    const has = Object.prototype.hasOwnProperty.call(values, name);
    const val = normalize(values[name]);
    if (!has) {
      errors.push(`缺必填字段: ${name}（模板标记 required）`);
      missing.push({ scope: '表头', name, why: '必填字段缺失', action: `在纯数据的 values 里补 "${name}"` });
    } else if (val === '' || /^\(待|^示例：|^示例/.test(val)) {
      errors.push(`必填字段未填真实值: ${name} = ${JSON.stringify(val)}`);
      missing.push({ scope: '表头', name, why: `仍是占位值（${val}）`, action: `把 values."${name}" 换成真实值` });
    }
  }

  // 2) 明细行必填列：读 detail_columns.columns 里 required=true 且非 derived 的列
  //    （derived = 由页面联动带出的列，不该由用户/引擎填，也不计入必填校验）
  const detailCols = template?.detail_columns?.columns ?? {};
  const detailRequired = Object.entries(detailCols)
    .filter(([, spec]) => typeof spec === 'object' && spec !== null && spec.required === true && spec.derived !== true)
    .map(([name]) => name);
  const rows = data?.detail_rows ?? [];
  if (detailRequired.length && rows.length === 0) {
    errors.push('明细行为空，但存在必填明细列：' + detailRequired.join('、'));
    missing.push({ scope: '明细行', name: '(整行)', why: '没有任何明细行', action: '在纯数据 detail_rows 里至少加一行，并填齐：' + detailRequired.join('、') });
  } else {
    rows.forEach((row, i) => {
      for (const col of detailRequired) {
        const val = normalize(row?.[col]);
        if (val === '' || /^示例|^待填/.test(val)) {
          errors.push(`明细行 #${i} 缺必填列: ${col}`);
          missing.push({ scope: `明细行 #${i}`, name: col, why: val === '' ? '为空' : `仍是占位值（${val}）`, action: `补 detail_rows[${i}]."${col}"` });
        }
      }
    });
  }

  // 3) 纯数据泄露检查（不得含 selector/widget）
  const raw = JSON.stringify(data ?? {});
  if (raw.includes('#') || /"selector"|"widget"/.test(raw)) {
    errors.push('纯数据泄露页面选择器：纯数据 JSON 不得含 # / selector / widget，这些属于模板');
    missing.push({ scope: '纯数据', name: '(格式)', why: '含页面选择器字样', action: '移除所有 # / selector / widget —— 这些属于模板，用户只填业务值' });
  }

  // 4) 提示：模板里标 required 但用户没给的字段之外的"可选但未填"项（不影响通过，只提示）
  const optionalGaps = [];
  for (const [name, spec] of Object.entries(template?.field_map ?? {})) {
    if (spec?.required || spec?.derived === true || spec?.type === 'derived') continue;
    if (!(name in values)) optionalGaps.push({ scope: '表头', name });
  }

  // 4) 待用户确认项（预检不通过 = 需要人确认，而不是硬填）
  //
  // 设计意图（用户要求）：用户给的值如果本系统**无法核实**（不在已探查到的候选里、
  // 或该字段的弹窗/下拉尚未查清值域），不能装作没问题直接填，也不能直接判失败 ——
  // 应当列为「待确认」，让用户明确拍板。填单前把它打印出来。
  const needsConfirm = [];
  const verified = data?.verified_values ?? {};     // { 字段名: true } 表示用户已确认
  const catalog = template?.value_catalog ?? {};    // 探查阶段沉淀的"字段→已知候选值"
  for (const [name, spec] of Object.entries(template?.field_map ?? {})) {
    if (spec?.derived === true || spec?.type === 'derived' || spec?.readonly === true) continue;
    const raw = values[name];
    if (raw === undefined || normalize(raw) === '') continue;
    if (verified[name] === true) continue;          // 用户已明确确认过
    const known = catalog[name];
    if (Array.isArray(known) && known.length && !known.some(k => normalize(k) === normalize(raw))) {
      needsConfirm.push({
        scope: '表头', name, value: normalize(raw),
        why: '该值不在已探查到的候选范围内',
        known: known.slice(0, 20),
        action: `确认 "${name}" = "${normalize(raw)}" 是否正确；若正确请在纯数据 verified_values 里写 "${name}": true，否则改值`
      });
    }
  }

  errors.missing = missing;
  errors.optionalGaps = optionalGaps;
  errors.needsConfirm = needsConfirm;
  errors.deferred = deferred;
  return errors;
}

/**
 * 把校验结果渲染成给用户看的总结：缺什么 + 下一步怎么做。
 * 返回字符串（多行），供 skill 在填单结束时原样输出。
 */
function renderReport(template, data, errors) {
  const biz = template?.biz_name ?? template?.form_key ?? '(未命名表单)';
  const lines = [];
  const nc = errors.needsConfirm ?? [];
  lines.push(`【OA 填单数据检查】${biz}`);

  // 待用户确认项单独成段：预检"不通过"的语义是"要人来拍板"，不是"直接判失败"。
  if (nc.length) {
    lines.push(`状态：有 ${nc.length} 个值需要你确认后才填单。`);
    lines.push('');
    lines.push('需要你确认的值（系统无法核实，不敢硬填）：');
    for (const c of nc) {
      lines.push(`  - [${c.scope}] ${c.name} = "${c.value}" —— ${c.why}`);
      if (c.known?.length) lines.push(`      已知可选值：${c.known.join('、')}`);
      lines.push(`      怎么做：${c.action}`);
    }
    lines.push('');
  }

  if (!errors.length && !nc.length) {
    lines.push('状态：数据齐全，可以填单。');
    const og = errors.optionalGaps ?? [];
    if (og.length) {
      lines.push(`提示：以下非必填项未提供，将留空 —— ${og.map(g => g.name).join('、')}`);
    }
    lines.push('下一步：运行 oa-fill-engine.mjs（模板 + 本数据）执行填写；提交前请人工核对。');
    return lines.join('\n');
  }
  if (errors.length) {
    lines.push(`状态：数据不全，共 ${errors.length} 处需要你补充。`);
    lines.push('');
    lines.push('需要你补充的内容：');
    for (const m of errors.missing ?? []) {
      lines.push(`  - [${m.scope}] ${m.name}：${m.why}`);
      lines.push(`      怎么做：${m.action}`);
    }
  }
  const og = errors.optionalGaps ?? [];
  if (og.length) {
    lines.push('');
    lines.push(`可选（不填则留空）：${og.map(g => g.name).join('、')}`);
  }
  const df = errors.deferred ?? [];
  if (df.length) {
    lines.push('');
    lines.push(`不由申请人填写（留待财务/后续环节，未编造）：`);
    for (const d of df) lines.push(`  - [${d.scope}] ${d.name}：${d.why} → ${d.action}`);
  }
  lines.push('');
  lines.push('下一步：');
  lines.push('  1) 打开你的纯数据 JSON（values / detail_rows），按上面逐条补齐真实值；');
  lines.push('  2) 对上面"需要你确认"的值：正确则在纯数据 verified_values 里写 "<字段名>": true，不正确则改值；');
  lines.push('  3) 重新运行本校验，直到通过；');
  lines.push('  4) 通过后再执行填单引擎。不要带着缺口去填单 —— OA 空闲超时会清空整张未保存表单，中途失败要整单重来。');
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('oa-data-validate.mjs')) {
  const flag = n => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined; };
  const tPath = flag('--template');
  const dPath = flag('--data');
  if (!tPath || !dPath) { console.error('usage: --template <模板> --data <纯数据>'); process.exit(2); }
  const template = JSON.parse(readFileSync(tPath, 'utf8'));
  const data = JSON.parse(readFileSync(dPath, 'utf8'));
  const errors = validate(template, data);
  const report = renderReport(template, data, errors);
  // 报告输出到 stdout，便于宿主原样转给用户；失败时同时给非零退出码。
  // needsConfirm 也走非零退出码：预检"不通过"= 先要用户确认，不能默默往下填。
  process.stdout.write(report + '\n');
  const nc = errors.needsConfirm ?? [];
  if (errors.length || nc.length) {
    process.stdout.write(JSON.stringify({ event: 'data.incomplete', gaps: errors.missing, optional: errors.optionalGaps, needsConfirm: nc, deferred: errors.deferred ?? [] }) + '\n');
    process.exit(2);
  }
  process.exit(0);
}

export { validate, renderReport };
