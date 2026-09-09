import { resolveInputs, validateFlow } from './flow.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z][\w-]*$/.test(value);
const positive = value => Number.isInteger(value) && value > 0;
const nonnegative = value => Number.isInteger(value) && value >= 0;
const ACTION_TYPES = new Set(['ensure', 'attach', 'navigate', 'fill', 'select', 'click', 'query', 'wait']);
const PREDICATE_TYPES = new Set(['all', 'any', 'page', 'element']);
const FORBIDDEN_KEYS = new Set(['handler', 'expression', 'script', 'function', 'code', 'eval', 'evaluate', 'javascript']);

function invalid(reason) {
  const error = new Error(`FLOW_INVALID: ${reason}`);
  error.code = 'FLOW_INVALID';
  error.reason = reason;
  throw error;
}

function keys(value, allowed, name) {
  if (!object(value)) invalid(`${name}: expected object`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) invalid(`${name}: unsupported field ${unknown}`);
}

function nonemptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name}: expected non-empty string`);
}

function uniqueList(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) {
    invalid(`${name}: expected unique string list`);
  }
}

function rejectCodeFields(value, path = 'scenario') {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectCodeFields(item, `${path}[${index}]`));
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    // Input values are opaque data. Structural schemas below reject hooks in
    // all executable positions while still allowing a business input named
    // e.g. `code`.
    if (path !== 'scenario.inputs' && !path.startsWith('scenario.inputs.') && FORBIDDEN_KEYS.has(key.toLowerCase())) invalid(`${path}.${key}: code fields are not supported`);
    rejectCodeFields(child, `${path}.${key}`);
  }
}

function checkInputRefs(value, inputs, path) {
  if (Array.isArray(value)) return value.forEach((item, index) => checkInputRefs(item, inputs, `${path}[${index}]`));
  if (!object(value)) return;
  if (own(value, 'input')) {
    if (Object.keys(value).length !== 1 || typeof value.input !== 'string' || !own(inputs, value.input)) {
      invalid(`${path}: unresolved input reference`);
    }
    return;
  }
  Object.entries(value).forEach(([key, child]) => checkInputRefs(child, inputs, `${path}.${key}`));
}

function isInputRef(value) {
  return object(value) && Object.keys(value).length === 1 && typeof value.input === 'string';
}

function rejectJavascriptUrl(value, inputs, path) {
  const resolved = isInputRef(value) ? inputs[value.input] : value;
  if (typeof resolved === 'string' && /^\s*javascript\s*:/i.test(resolved)) invalid(`${path}: javascript URLs are not supported`);
}

function validateTarget(target, name, inputs = {}) {
  keys(target, ['selector', 'text'], `target ${name}`);
  nonemptyString(target.selector, `target ${name}.selector`);
  if (own(target, 'text')) {
    validateRule(target.text, `target ${name}`, 'text', inputs);
    if (own(target.text, 'equals') || own(target.text, 'not_contains')) invalid(`target ${name}.text: only contains is supported`);
    checkInputRefs(target.text.contains, inputs, `target ${name}.text.contains`);
    nonemptyString(resolveInputs(target.text.contains, inputs), `target ${name}.text.contains`);
  }
}

function validateRule(rule, name, kind = 'text', inputs = {}) {
  keys(rule, ['equals', 'contains', 'not_contains'], `${name}.${kind}`);
  if (!own(rule, 'equals') && !own(rule, 'contains') && !own(rule, 'not_contains')) invalid(`${name}.${kind}: empty matcher`);
  for (const key of ['equals', 'contains', 'not_contains']) {
    if (!own(rule, key)) continue;
    if (key === 'equals') {
      if (typeof rule[key] !== 'string' && typeof rule[key] !== 'number' && typeof rule[key] !== 'boolean' && !isInputRef(rule[key])) invalid(`${name}.${kind}.${key}: expected scalar or input reference`);
    } else if (!isInputRef(rule[key]) && typeof rule[key] !== 'string' && (!Array.isArray(rule[key]) || rule[key].some(item => typeof item !== 'string'))) {
      invalid(`${name}.${kind}.${key}: expected string or string list`);
    }
    if (isInputRef(rule[key])) {
      const resolved = inputs[rule[key].input];
      if (resolved === undefined || (typeof resolved !== 'string' && typeof resolved !== 'number' && typeof resolved !== 'boolean')) invalid(`${name}.${kind}.${key}: input must resolve to scalar`);
    }
  }
}

function validatePredicate(predicate, inputs, targets, name = 'predicate') {
  if (!object(predicate)) invalid(`${name}: expected object`);
  if (!PREDICATE_TYPES.has(predicate.type)) invalid(`${name}: unsupported predicate type`);
  if (predicate.type === 'all' || predicate.type === 'any') {
    keys(predicate, ['type', 'conditions'], name);
    if (!Array.isArray(predicate.conditions) || !predicate.conditions.length) invalid(`${name}.conditions: expected non-empty list`);
    predicate.conditions.forEach((child, index) => validatePredicate(child, inputs, targets, `${name}.conditions[${index}]`));
    return;
  }
  if (predicate.type === 'page') {
    keys(predicate, ['type', 'url', 'text', 'not_text'], name);
    if (!own(predicate, 'url') && !own(predicate, 'text') && !own(predicate, 'not_text')) invalid(`${name}: page predicate has no condition`);
    if (own(predicate, 'url')) {
      validateRule(predicate.url, name, 'url', inputs);
      checkInputRefs(predicate.url, inputs, `${name}.url`);
    }
    for (const key of ['text', 'not_text']) {
      if (own(predicate, key)) {
        validateRule(predicate[key], name, key, inputs);
        checkInputRefs(predicate[key], inputs, `${name}.${key}`);
      }
    }
    return;
  }
  if (predicate.type === 'element') {
    keys(predicate, ['type', 'target', 'count', 'visible', 'enabled', 'editable', 'value', 'text', 'attribute'], name);
    nonemptyString(predicate.target, `${name}.target`);
    if (!own(targets, predicate.target)) invalid(`${name}: unknown target ${predicate.target}`);
    if (!own(predicate, 'count') && !own(predicate, 'visible') && !own(predicate, 'enabled') && !own(predicate, 'editable') && !own(predicate, 'value') && !own(predicate, 'text') && !own(predicate, 'attribute')) invalid(`${name}: element predicate has no condition`);
    if (own(predicate, 'count')) {
      keys(predicate.count, ['equals'], `${name}.count`);
      if (!Number.isInteger(predicate.count.equals) || predicate.count.equals < 0) invalid(`${name}.count.equals: expected non-negative integer`);
    }
    for (const key of ['visible', 'enabled', 'editable']) if (own(predicate, key) && typeof predicate[key] !== 'boolean') invalid(`${name}.${key}: expected boolean`);
    const singleElement = ['visible', 'enabled', 'editable', 'value', 'text', 'attribute'].some(key => own(predicate, key));
    if (singleElement && own(predicate, 'count') && predicate.count.equals !== 1) invalid(`${name}: single-element properties require count.equals=1`);
    for (const key of ['value', 'text']) {
      if (own(predicate, key)) {
        validateRule(predicate[key], name, key, inputs);
        checkInputRefs(predicate[key], inputs, `${name}.${key}`);
      }
    }
    if (own(predicate, 'attribute')) {
      keys(predicate.attribute, ['name', 'equals', 'contains', 'not_contains'], `${name}.attribute`);
      nonemptyString(predicate.attribute.name, `${name}.attribute.name`);
      const rule = { ...predicate.attribute };
      delete rule.name;
      validateRule(rule, name, 'attribute', inputs);
      checkInputRefs(rule, inputs, `${name}.attribute`);
    }
  }
}

function targetSelector(targets, target, name) {
  nonemptyString(target, `${name}.target`);
  if (!own(targets, target)) invalid(`${name}: unknown target ${target}`);
  return targets[target].selector;
}

function targetClickExpression(target) {
  const encoded = json(target);
  return `(() => { const target=${encoded}; const normalize=value=>String(value ?? '').replace(/\\s+/g,' ').trim(); const nodes=Array.from(document.querySelectorAll(target.selector)).filter(node=>{ const text=normalize(node.innerText||node.textContent||''); const wanted=Array.isArray(target.text?.contains)?target.text.contains:[target.text?.contains]; return !target.text || wanted.every(item=>text.includes(normalize(item))); }); if(nodes.length!==1) throw new Error('target must resolve to exactly one element'); const el=nodes[0], r=el.getBoundingClientRect(), style=getComputedStyle(el); if(r.width<=0||r.height<=0||style.display==='none'||style.visibility==='hidden'||el.disabled) throw new Error('target is not actionable'); el.click(); return {clicked:true, match_count:nodes.length}; })()`;
}

function compileAction(action, targets, inputs, name) {
  keys(action, ['type', 'target', 'url', 'value', 'label', 'wait_until', 'timeout_ms', 'auto_start', 'profile_mode', 'user_data_dir', 'target_id', 'url_contains', 'title_contains', 'limit', 'stable_ms'], `action ${name}`);
  if (!ACTION_TYPES.has(action.type)) invalid(`${name}: unsupported action type`);
  const timeout = action.timeout_ms === undefined ? {} : { timeout_ms: action.timeout_ms };
  if (action.timeout_ms !== undefined && !positive(action.timeout_ms)) invalid(`${name}.timeout_ms: expected positive integer`);
  switch (action.type) {
    case 'ensure':
      keys(action, ['type', 'url', 'timeout_ms', 'auto_start', 'profile_mode', 'user_data_dir'], `action ${name}`);
      if (own(action, 'auto_start') && typeof action.auto_start !== 'boolean') invalid(`${name}.auto_start: expected boolean`);
      for (const field of ['url', 'profile_mode', 'user_data_dir']) if (own(action, field)) {
        checkInputRefs(action[field], inputs, `${name}.${field}`);
        nonemptyString(resolveInputs(action[field], inputs), `${name}.${field}`);
      }
      if (own(action, 'url')) { checkInputRefs(action.url, inputs, `${name}.url`); rejectJavascriptUrl(action.url, inputs, `${name}.url`); }
      return { method: 'chrome.ensure', params: { ...timeout, ...(own(action, 'auto_start') ? { auto_start: action.auto_start } : {}), ...(own(action, 'profile_mode') ? { profile_mode: action.profile_mode } : {}), ...(own(action, 'url') ? { url: action.url } : {}), ...(own(action, 'user_data_dir') ? { user_data_dir: action.user_data_dir } : {}) } };
    case 'attach': {
      keys(action, ['type', 'timeout_ms', 'target_id', 'url_contains', 'title_contains'], `action ${name}`);
      const params = { ...timeout };
      for (const key of ['target_id', 'url_contains', 'title_contains']) if (own(action, key)) params[key] = action[key];
      if (!['target_id', 'url_contains', 'title_contains'].some(key => typeof params[key] === 'string' && params[key].trim())) invalid(`${name}: attach criteria required`);
      return { method: 'chrome.attach', params };
    }
    case 'navigate':
      keys(action, ['type', 'url', 'wait_until', 'timeout_ms'], `action ${name}`);
      if (!own(action, 'url')) invalid(`${name}.url: required`);
      checkInputRefs(action.url, inputs, `${name}.url`); rejectJavascriptUrl(action.url, inputs, `${name}.url`);
      if (typeof action.wait_until !== 'string' || !['domcontentloaded', 'load', 'complete', 'network_idle', 'network-idle'].includes(action.wait_until)) invalid(`${name}.wait_until: unsupported wait mode`);
      return { method: 'chrome.navigate', params: { url: action.url, wait_until: action.wait_until, ...timeout } };
    case 'fill':
      keys(action, ['type', 'target', 'value', 'timeout_ms'], `action ${name}`);
      if (!own(action, 'target') || !own(action, 'value')) invalid(`${name}: target and value required`);
      checkInputRefs(action.value, inputs, `${name}.value`);
      if (targets[action.target]?.text) invalid(`${name}: text-filtered targets are only supported by click and element predicates`);
      return { method: 'chrome.fill', params: { selector: targetSelector(targets, action.target, name), value: action.value, ...timeout } };
    case 'select':
      keys(action, ['type', 'target', 'value', 'label', 'timeout_ms'], `action ${name}`);
      if (!own(action, 'target') || (!own(action, 'value') && !own(action, 'label'))) invalid(`${name}: target and value or label required`);
      if (own(action, 'value')) checkInputRefs(action.value, inputs, `${name}.value`);
      if (own(action, 'label')) checkInputRefs(action.label, inputs, `${name}.label`);
      if (targets[action.target]?.text) invalid(`${name}: text-filtered targets are only supported by click and element predicates`);
      return { method: 'chrome.select', params: { selector: targetSelector(targets, action.target, name), ...(own(action, 'value') ? { value: action.value } : { label: action.label }), ...timeout } };
    case 'click':
      keys(action, ['type', 'target', 'timeout_ms'], `action ${name}`);
      if (!own(action, 'target')) invalid(`${name}.target: required`);
      { const selector = targetSelector(targets, action.target, name); if (targets[action.target].text) return { method: 'chrome.evaluate', params: { expression: targetClickExpression(resolveInputs(targets[action.target], inputs)), ...timeout } }; return { method: 'chrome.click', params: { selector, ...timeout } }; }
    case 'query':
      keys(action, ['type', 'target', 'limit', 'timeout_ms'], `action ${name}`);
      if (!own(action, 'target')) invalid(`${name}.target: required`);
      if (targets[action.target]?.text) invalid(`${name}: text-filtered targets are only supported by click and element predicates`);
      if (action.limit !== undefined && (!Number.isInteger(action.limit) || action.limit <= 0)) invalid(`${name}.limit: expected positive integer`);
      return { method: 'chrome.query', params: { selector: targetSelector(targets, action.target, name), ...(action.limit === undefined ? {} : { limit: action.limit }), ...timeout } };
    case 'wait':
      keys(action, ['type', 'target', 'timeout_ms', 'stable_ms'], `action ${name}`);
      if (!own(action, 'target')) invalid(`${name}.target: required`);
      if (targets[action.target]?.text) invalid(`${name}: text-filtered targets are only supported by click and element predicates`);
      if (action.stable_ms !== undefined && !nonnegative(action.stable_ms)) invalid(`${name}.stable_ms: expected non-negative integer`);
      return { method: 'chrome.wait', params: { selector: targetSelector(targets, action.target, name), ...(action.stable_ms === undefined ? {} : { stable_ms: action.stable_ms }), ...timeout } };
    default: invalid(`${name}: unsupported action type`);
  }
}

function validateFlowData(flow, scenario, caseName) {
  keys(flow, ['flow_id', 'revision', 'timeout_ms', 'checks', 'steps', 'final_checks'], `flow ${caseName}`);
  if (!id(flow.flow_id) || !positive(flow.revision) || !positive(flow.timeout_ms)) invalid(`flow ${caseName}: identity/budget`);
  if (!object(flow.checks) || !Array.isArray(flow.steps) || !flow.steps.length) invalid(`flow ${caseName}: checks/steps`);
  for (const [checkId, check] of Object.entries(flow.checks)) {
    if (!id(checkId)) invalid(`flow ${caseName}: check id`);
    keys(check, ['predicate', 'timeout_ms', 'poll_ms', 'stable_ms'], `check ${caseName}.${checkId}`);
    if (!positive(check.timeout_ms) || !positive(check.poll_ms) || !nonnegative(check.stable_ms) || check.stable_ms >= check.timeout_ms) invalid(`check ${caseName}.${checkId}: budget`);
    validatePredicate(check.predicate, scenario.inputs, scenario.targets, `check ${caseName}.${checkId}.predicate`);
  }
  flow.steps.forEach((step, index) => {
    keys(step, ['id', 'label', 'action', 'timeout_ms', 'min_delay_ms', 'requires', 'consumes', 'expect', 'releases'], `step ${caseName}[${index}]`);
    if (!id(step.id) || typeof step.label !== 'string' || !step.label.trim()) invalid(`step ${caseName}[${index}]: identity`);
    if (!positive(step.timeout_ms) || !nonnegative(step.min_delay_ms ?? 0) || (step.min_delay_ms ?? 0) >= step.timeout_ms) invalid(`step ${step.id}: budget`);
    compileAction(step.action, scenario.targets, scenario.inputs, `step ${step.id}.action`);
    for (const name of ['requires', 'consumes', 'expect', 'releases']) uniqueList(step[name] ?? [], `step ${step.id}.${name}`);
    if (!step.expect?.length) invalid(`step ${step.id}: missing success predicate`);
    for (const checkId of [...(step.requires ?? []), ...step.expect]) if (!own(flow.checks, checkId)) invalid(`step ${step.id}: unknown check ${checkId}`);
  });
  uniqueList(flow.final_checks, `flow ${caseName}.final_checks`);
  if (!flow.final_checks.length) invalid(`flow ${caseName}: missing final checks`);
}

export function validateDeclarativeScenario(scenario) {
  rejectCodeFields(scenario);
  keys(scenario, ['schema_version', 'scenario_id', 'inputs', 'targets', 'flows'], 'scenario');
  if (scenario.schema_version !== 1 || !id(scenario.scenario_id) || !object(scenario.inputs) || !object(scenario.targets) || !object(scenario.flows) || !Object.keys(scenario.flows).length) invalid('scenario identity/schema/collections');
  for (const [name, target] of Object.entries(scenario.targets)) { if (!id(name)) invalid('target id'); validateTarget(target, name, scenario.inputs); }
  for (const [caseName, flow] of Object.entries(scenario.flows)) {
    if (!id(caseName)) invalid('case id');
    validateFlowData(flow, scenario, caseName);
    // Validate dependency ordering and released facts for every case before
    // the worker creates a transport, including cases not selected to run.
    compileFlow(flow, scenario);
  }
  return scenario;
}

function json(value) {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function predicateExpression(predicate) {
  return `(() => { const spec=${json(predicate)};
    const norm=value=>String(value ?? '').replace(/\\s+/g,' ').trim();
    const scalar=(actual,rule,normalize=false)=>{ if(actual===null||actual===undefined) return false; const value=normalize?norm(actual):String(actual);
      if (rule.equals !== undefined && value !== (normalize?norm(rule.equals):String(rule.equals ?? ''))) return false;
      const includes=Array.isArray(rule.contains)?rule.contains:(rule.contains===undefined?[]:[rule.contains]);
      if (includes.some(item=>!value.includes(normalize?norm(item):String(item)))) return false;
      const excludes=Array.isArray(rule.not_contains)?rule.not_contains:(rule.not_contains===undefined?[]:[rule.not_contains]);
      return !excludes.some(item=>value.includes(normalize?norm(item):String(item))); };
    const visible=el=>{ const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const shape=s=>s.type==='element'?{type:s.type,target:s.target}:s.type==='page'?{type:s.type}:({type:s.type,conditions:s.conditions.map(shape)});
    const evaluate=s=>{ if(s.type==='all'||s.type==='any'){ const parts=s.conditions.map(evaluate),ok=s.type==='all'?parts.every(x=>x.ok):parts.some(x=>x.ok); return {ok,actual:{conditions:parts.map((x,index)=>({index,ok:x.ok,actual:x.actual}))}}; }
      if(s.type==='page'){ const pageText=norm(document.body?.innerText||''); const actual={url_matches:true,text_length:pageText.length}; let ok=true;
        if(s.url) { actual.url_matches=scalar(location.href,s.url,false); ok=ok&&actual.url_matches; } if(s.text) { actual.text_matches=scalar(pageText,s.text,true); ok=ok&&actual.text_matches; } if(s.not_text) { actual.not_text_absent=!scalar(pageText,s.not_text,true); ok=ok&&actual.not_text_absent; } return {ok,actual}; }
      let nodes=Array.from(document.querySelectorAll(s.__selector || s.selector));
      if(s.__targetText) nodes=nodes.filter(node=>scalar(norm(node.innerText||node.textContent||''),s.__targetText,true));
      const el=nodes[0]; const actual={target:s.target,count:nodes.length}; let ok=true; const single=['visible','enabled','editable','value','text','attribute'].some(key=>s[key]!==undefined);
      if(s.count) ok=ok&&nodes.length===s.count.equals; if(single) { actual.ambiguous=nodes.length!==1; ok=ok&&nodes.length===1; }
      if(s.visible!==undefined) { actual.visible=Boolean(el)&&visible(el); ok=ok&&actual.visible===s.visible; } if(s.enabled!==undefined) { actual.enabled=Boolean(el)&&!Boolean(el.disabled); ok=ok&&actual.enabled===s.enabled; } if(s.editable!==undefined) { actual.editable=Boolean(el)&&!Boolean(el.readOnly)&&!Boolean(el.disabled); ok=ok&&actual.editable===s.editable; }
      if(s.value) { const value=el&&'value' in el?String(el.value??''):null; actual.value_present=value!==null; actual.value_length=value?.length??0; actual.value_matches=scalar(value,s.value,false); ok=ok&&actual.value_matches; }
      if(s.text) { const value=el?norm(el.innerText||el.textContent||''):null; actual.text_length=value?.length??0; actual.text_matches=scalar(value,s.text,true); ok=ok&&actual.text_matches; }
      if(s.attribute) { const value=el?el.getAttribute(s.attribute.name):null; const rule={...s.attribute}; delete rule.name; actual.attribute_present=value!==null; actual.attribute_matches=scalar(value,rule,false); ok=ok&&actual.attribute_matches; }
      return {ok,actual}; };
    const result=evaluate(spec); return {verdict:result.ok?'pass':'fail',expected:shape(spec),actual:result.actual}; })()`;
}

function makeHandler(predicate, targets) {
  return async ({ inputs, evaluate }) => {
    const resolved = resolveInputs(predicate, inputs);
    if (resolved.type === 'element') { resolved.__selector = targets[resolved.target].selector; if (targets[resolved.target].text) resolved.__targetText = resolveInputs(targets[resolved.target].text, inputs); }
    if (resolved.type === 'all' || resolved.type === 'any') {
      const addSelectors = node => { if (node.type === 'element') { node.__selector = targets[node.target].selector; if (targets[node.target].text) node.__targetText = resolveInputs(targets[node.target].text, inputs); } else if (node.conditions) node.conditions.forEach(addSelectors); };
      addSelectors(resolved);
    }
    const value = await evaluate(predicateExpression(resolved));
    return value;
  };
}

function compileFlow(flow, scenario) {
  const handlers = {};
  const checks = Object.fromEntries(Object.entries(flow.checks).map(([checkId, check]) => {
    const handler = `declarative.${checkId}`;
    handlers[handler] = makeHandler(check.predicate, scenario.targets);
    return [checkId, { handler, args: {}, timeout_ms: check.timeout_ms, poll_ms: check.poll_ms, stable_ms: check.stable_ms }];
  }));
  const compiled = {
    schema_version: 1, flow_id: flow.flow_id, revision: flow.revision, inputs: structuredClone(scenario.inputs), timeout_ms: flow.timeout_ms,
    checks, steps: flow.steps.map(step => ({ ...step, action: compileAction(step.action, scenario.targets, scenario.inputs, `step ${step.id}.action`) })), final_checks: flow.final_checks
  };
  validateFlow(compiled, handlers);
  return { flow: compiled, handlers };
}

export function compileDeclarativeScenario(scenario, caseName = 'simple') {
  validateDeclarativeScenario(scenario);
  if (!own(scenario.flows, caseName)) invalid(`unknown case ${caseName}`);
  return compileFlow(scenario.flows[caseName], scenario);
}
