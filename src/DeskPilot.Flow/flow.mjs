import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ACTIONS = new Set(['chrome.ensure', 'chrome.attach', 'chrome.navigate', 'chrome.fill', 'chrome.select', 'chrome.click', 'chrome.evaluate', 'chrome.query', 'chrome.wait']);
const READ_ACTIONS = new Set(['chrome.query', 'chrome.wait']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = v => Number.isInteger(v) && v > 0;
const nonnegative = v => Number.isInteger(v) && v >= 0;
const id = v => typeof v === 'string' && /^[a-zA-Z][\w-]*$/.test(v);

export class StepFault extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function invalid(reason) { throw new StepFault('FLOW_INVALID', { reason }); }
function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid(`${name}: unknown field or non-object`);
}
function list(value, name) {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string') || new Set(value).size !== value.length) invalid(`${name}: expected unique string list`);
}
function refs(value, inputs) {
  if (Array.isArray(value)) return value.forEach(x => refs(x, inputs));
  if (!object(value)) return;
  if (own(value, 'input')) {
    if (Object.keys(value).length !== 1 || typeof value.input !== 'string' || !own(inputs, value.input)) invalid('unresolved input reference');
  } else {
    if (own(value, '$ref')) invalid('CLI $ref cannot cross host steps; use a fresh observation');
    Object.values(value).forEach(x => refs(x, inputs));
  }
}
export function resolveInputs(value, inputs) {
  if (Array.isArray(value)) return value.map(x => resolveInputs(x, inputs));
  if (!object(value)) return value;
  if (own(value, 'input')) return structuredClone(inputs[value.input]);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveInputs(v, inputs)]));
}

export function validateFlow(flow, handlers, inputs = flow?.inputs) {
  keys(flow, ['schema_version', 'flow_id', 'revision', 'inputs', 'timeout_ms', 'checks', 'steps', 'final_checks'], 'flow');
  if (flow.schema_version !== 1 || !id(flow.flow_id) || !positive(flow.revision) || !positive(flow.timeout_ms)) invalid('flow identity/version/budget');
  if (!object(inputs) || !object(flow.checks) || !object(handlers) || !Array.isArray(flow.steps) || !flow.steps.length) invalid('inputs/checks/steps');
  for (const [name, check] of Object.entries(flow.checks)) {
    if (!id(name)) invalid('check id');
    keys(check, ['handler', 'args', 'timeout_ms', 'poll_ms', 'stable_ms'], `check ${name}`);
    if (!own(handlers, check.handler) || typeof handlers[check.handler] !== 'function') invalid(`missing handler: ${name}`);
    if (!positive(check.timeout_ms) || !positive(check.poll_ms) || !nonnegative(check.stable_ms) || check.stable_ms >= check.timeout_ms) invalid(`check budget: ${name}`);
    refs(check.args, inputs);
  }
  const steps = new Set(), facts = new Set(), released = new Set();
  for (const step of flow.steps) {
    keys(step, ['id', 'label', 'action', 'timeout_ms', 'min_delay_ms', 'requires', 'consumes', 'expect', 'releases'], 'step');
    if (!id(step.id) || steps.has(step.id) || typeof step.label !== 'string' || !step.label.trim()) invalid('step identity');
    if (!positive(step.timeout_ms) || !nonnegative(step.min_delay_ms ?? 0) || (step.min_delay_ms ?? 0) >= step.timeout_ms) invalid(`step budget: ${step.id}`);
    keys(step.action, ['method', 'params'], 'action');
    if (!ACTIONS.has(step.action.method) || !object(step.action.params)) invalid(`unsupported action: ${step.id}`);
    refs(step.action.params, inputs);
    const params = resolveInputs(step.action.params, inputs);
    const required = {
      'chrome.navigate': ['url'], 'chrome.fill': ['selector', 'value'],
      'chrome.select': ['selector'], 'chrome.click': ['selector'], 'chrome.evaluate': ['expression'], 'chrome.query': ['selector']
    }[step.action.method] ?? [];
    for (const field of required) if (typeof params[field] !== 'string' || (field !== 'value' && !params[field].trim())) invalid(`action ${step.id}: missing ${field}`);
    if (step.action.method === 'chrome.attach' && !['target_id', 'target-id', 'id', 'url_contains', 'url-contains', 'title_contains', 'title-contains'].some(k => typeof params[k] === 'string' && params[k].trim())) invalid(`action ${step.id}: attach criteria`);
    if (step.action.method === 'chrome.select' && typeof params.value !== 'string' && typeof params.label !== 'string') invalid(`action ${step.id}: selection value/label`);
    if (step.action.method === 'chrome.wait' && typeof params.expression !== 'string' && typeof params.selector !== 'string') invalid(`action ${step.id}: wait predicate`);
    if (params.timeout_ms !== undefined && !positive(params.timeout_ms)) invalid(`action ${step.id}: timeout`);
    for (const name of ['requires', 'consumes', 'expect', 'releases']) list(step[name] ?? [], name);
    if (!step.expect?.length) invalid(`missing success predicate: ${step.id}`);
    for (const check of [...step.requires ?? [], ...step.expect]) if (!own(flow.checks, check)) invalid(`missing check: ${check}`);
    for (const fact of [...step.consumes ?? [], ...step.releases ?? []]) if (!facts.has(fact) || released.has(fact)) invalid(`unavailable prior fact: ${fact}`);
    for (const fact of step.releases ?? []) released.add(fact);
    for (const check of step.expect) facts.add(`${step.id}.${check}`);
    steps.add(step.id);
  }
  list(flow.final_checks, 'final_checks');
  if (!flow.final_checks.length) invalid('missing final checks');
  for (const fact of flow.final_checks) if (!facts.has(fact) || released.has(fact)) invalid(`invalid final fact: ${fact}`);
  return flow;
}

function summary(value) {
  // Handlers explicitly choose evidence; never put complete CLI responses in events.
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text.length <= 1200 ? value : { truncated: true, summary: text.slice(0, 1000) };
}
function pause(result) {
  return ['login_required', 'risk_challenge'].includes(result?.page_state) || result?.status === 'paused';
}
const cancellableDelay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new StepFault('CANCELLED'));
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new StepFault('CANCELLED')); }
  signal?.addEventListener('abort', abort, { once: true });
});
async function bounded(fn, ms, signal) {
  if (signal?.aborted) throw new StepFault('CANCELLED');
  if (ms <= 0) throw new StepFault('DEADLINE_EXCEEDED');
  let timer, abort;
  const end = performance.now() + ms;
  try {
    const result = await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepFault('DEADLINE_EXCEEDED')), ms);
      abort = () => reject(new StepFault('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
    if (signal?.aborted) throw new StepFault('CANCELLED');
    if (performance.now() > end) throw new StepFault('DEADLINE_EXCEEDED');
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Trusted host-language adapter, not a sandbox or a business assertion language. */
export async function runFlow({ flow: supplied, inputs: overrides, handlers, transport, onEvent = () => {}, signal, runId = randomUUID() }) {
  let flow, inputs, seq = 0, phase = 'validation', current = null, deadline = Infinity;
  let targetId = null, accepting = true, fault = null, runStatus = 'running';
  const started = performance.now(), steps = [], facts = new Map();
  const base = () => ({ run_id: runId, flow_id: flow?.flow_id ?? supplied?.flow_id ?? null, revision: flow?.revision ?? supplied?.revision ?? null, generation: 1 });
  const emit = (event, payload = {}) => {
    const message = { ...base(), event, seq: ++seq, ...payload };
    try { onEvent(message); } catch { /* A broken progress consumer cannot bypass checks. */ }
    return message;
  };
  const remaining = limit => Math.max(0, Math.floor(Math.min(deadline, limit) - performance.now()));
  const context = () => ({ detected_at: current?.id ?? (phase === 'final_check' ? 'final_check' : phase), phase });
  async function request(method, params, limit) {
    if (!accepting) throw new StepFault('EXECUTOR_LOST');
    const budget = remaining(limit);
    const result = await bounded(() => transport.request(method, { ...params, timeout_ms: Math.min(params.timeout_ms ?? budget, budget) }, { timeoutMs: budget }), budget, signal);
    if (pause(result)) throw new StepFault('USER_ATTENTION_REQUIRED');
    if (result?.target_id) {
      if (targetId && targetId !== result.target_id && method !== 'chrome.attach') throw new StepFault('CHECK_UNAVAILABLE', { reason: 'target_changed' });
      targetId = result.target_id;
    }
    return result;
  }
  async function check(checkId, limit, prior) {
    const spec = flow.checks[checkId], checkEnd = Math.min(limit, deadline, performance.now() + spec.timeout_ms);
    let stableSince = null, last = { verdict: 'unknown', actual: null }, probeContext = null;
    while (remaining(checkEnd) > 0) {
      let active = true;
      try {
        const value = await bounded(() => handlers[spec.handler]({
          inputs, args: resolveInputs(spec.args ?? {}, inputs),
          evaluate: async expression => {
            if (!active || !accepting) throw new StepFault('CHECK_UNAVAILABLE');
            const response = await request('chrome.evaluate', { expression }, checkEnd);
            probeContext = response.target_id ?? null;
            return response.value;
          }
        }), remaining(checkEnd), signal);
        if (!object(value) || !['pass', 'fail', 'unknown'].includes(value.verdict)) throw new StepFault('CHECK_UNAVAILABLE', { reason: 'invalid_check_result' });
        last = value;
      } catch (error) {
        if (['CANCELLED', 'USER_ATTENTION_REQUIRED', 'EXECUTOR_LOST'].includes(error.code)) throw error;
        last = { verdict: 'unknown', actual: { code: error.code ?? 'CHECK_EXCEPTION' } };
      } finally { active = false; }
      if (prior?.target_id && prior.target_id !== probeContext) last = { verdict: 'unknown', actual: { code: 'FACT_CONTEXT_CHANGED' } };
      if (last.verdict === 'pass') {
        stableSince ??= performance.now();
        if (performance.now() - stableSince >= spec.stable_ms) return {
          check_id: checkId, target_id: probeContext, observed_at: new Date().toISOString(),
          expected: summary(last.expected), actual: summary(last.actual)
        };
      } else stableSince = null;
      if ((last.terminal === true && last.verdict !== 'pass') || remaining(checkEnd) <= 0) break;
      await cancellableDelay(Math.min(spec.poll_ms, remaining(checkEnd)), signal);
    }
    const code = last.verdict === 'unknown' ? 'CHECK_UNAVAILABLE' : prior ? 'PRIOR_RESULT_INVALIDATED' : phase === 'precondition' ? 'PRECONDITION_FAILED' : 'POSTCONDITION_FAILED';
    throw new StepFault(code, { ...context(), check_id: checkId, ...(prior ? { fact_id: prior.fact_id, producer_step_id: prior.producer_step_id } : {}),
      verdict: last.verdict === 'pass' ? 'fail' : last.verdict, expected: summary(last.expected), actual: summary(last.actual), root_cause: null });
  }
  async function consume(factId, limit) {
    const fact = facts.get(factId);
    if (!fact || fact.released) throw new StepFault('CHECK_UNAVAILABLE', { fact_id: factId, reason: 'fact_not_live', ...context() });
    return check(fact.check_id, limit, fact);
  }
  try {
    flow = structuredClone(supplied);
    inputs = structuredClone(overrides ?? flow.inputs);
    validateFlow(flow, handlers, inputs);
    deadline = performance.now() + flow.timeout_ms;
    emit('run.started');
    phase = 'initialization';
    await request('interaction.begin', { label: flow.flow_id, show_overlay: true, restore_original_window: false }, deadline);
    for (const step of flow.steps) {
      const stepStart = performance.now(), stepEnd = Math.min(deadline, stepStart + step.timeout_ms);
      current = { id: step.id, label: step.label, status: 'running', effect: 'not_dispatched', action_dispatched: false };
      steps.push(current);
      emit('step.started', { step: { ...current } });
      phase = 'dependency_check';
      for (const fact of step.consumes ?? []) await consume(fact, stepEnd);
      phase = 'precondition';
      for (const checkId of step.requires ?? []) await check(checkId, stepEnd);
      phase = 'action';
      if (!remaining(stepEnd)) throw new StepFault('DEADLINE_EXCEEDED');
      if (signal?.aborted) throw new StepFault('CANCELLED');
      current.action_dispatched = true;
      current.effect = READ_ACTIONS.has(step.action.method) ? 'not_dispatched' : 'dispatched';
      emit('step.dispatched', { step: { ...current } });
      await request(step.action.method, { ...resolveInputs(step.action.params, inputs), action_label: step.label }, stepEnd);
      phase = 'postcondition';
      if (step.min_delay_ms) await bounded(() => cancellableDelay(step.min_delay_ms, signal), remaining(stepEnd), signal);
      for (const checkId of step.expect) {
        const evidence = await check(checkId, stepEnd);
        const factId = `${step.id}.${checkId}`;
        facts.set(factId, { ...evidence, fact_id: factId, producer_step_id: step.id, ...base() });
      }
      current.status = 'succeeded';
      current.checks = step.expect.map(check_id => ({ check_id, verdict: 'pass' }));
      current.effect = current.action_dispatched ? 'confirmed' : 'not_dispatched';
      current.elapsed_ms = Math.round(performance.now() - stepStart);
      for (const fact of step.releases ?? []) facts.get(fact).released = true;
      emit('step.succeeded', { step: { ...current } });
    }
    phase = 'final_check';
    current = null;
    for (const factId of flow.final_checks) await consume(factId, deadline);
    runStatus = 'completed';
  } catch (error) {
    const mapped = phase === 'validation' ? 'FLOW_INVALID' : error instanceof StepFault ? error.code : error.code === 'CHROME_USER_ATTENTION_REQUIRED' ? 'USER_ATTENTION_REQUIRED' :
      ['EXECUTOR_LOST', 'DEADLINE_EXCEEDED'].includes(error.code) ? error.code : 'ACTION_FAILED';
    fault = { ...context(), code: mapped, ...(error instanceof StepFault ? error.details : { cause_code: error.code ?? 'HOST_EXCEPTION' }) };
    runStatus = mapped === 'CANCELLED' ? 'cancelled' : 'handoff';
    if (current) {
      current.status = mapped === 'CANCELLED' ? 'cancelled' : current.action_dispatched ? 'failed' : 'blocked';
      if (current.effect === 'dispatched') current.effect = 'unknown';
    }
  } finally {
    accepting = false;
  }
  let cleanup;
  try { cleanup = await bounded(() => transport.close({ cancel: runStatus !== 'completed', timeoutMs: 3000 }), 4000); }
  catch (error) { cleanup = { quiescent: false, errors: [error.code ?? 'CLEANUP_FAILED'] }; }
  if (!cleanup?.quiescent && runStatus === 'completed') {
    runStatus = 'handoff';
    fault = { code: 'EXECUTOR_LOST', phase: 'cleanup', detected_at: 'cleanup' };
  }
  const affected = [];
  if (fault?.producer_step_id && flow) {
    const impacted = new Set([fault.producer_step_id]);
    for (const step of flow.steps) if ((step.consumes ?? []).some(f => impacted.has(f.split('.')[0]))) {
      impacted.add(step.id);
      affected.push({ step_id: step.id, validity: steps.some(s => s.id === step.id && s.status === 'succeeded') ? 'needs_revalidation' : 'blocked' });
    }
  }
  const terminal = emit(`run.${runStatus}`, {
    status: runStatus, elapsed_ms: Math.round(performance.now() - started), quiescent: cleanup?.quiescent === true,
    ...(fault ? { fault } : {}), steps, affected, cleanup_errors: cleanup?.errors ?? [],
    ...(runStatus === 'handoff' ? { resume: { automatic: false, requires: ['fresh_context', 'dependency_recheck', 'reconcile_unknown_effects'], mode: 'new_run_after_agent_decision' } } : {}),
    metrics: { steps_succeeded: steps.filter(s => s.status === 'succeeded').length, handoffs: runStatus === 'handoff' ? 1 : 0, intermediate_model_calls: 0 }
  });
  return terminal;
}
