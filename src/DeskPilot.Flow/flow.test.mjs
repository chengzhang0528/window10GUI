import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runFlow } from './flow.mjs';

class FakeTransport {
  constructor({ onRequest, closeResult = { quiescent: true, errors: [] } } = {}) {
    this.requests = [];
    this.closeCalls = [];
    this.onRequest = onRequest;
    this.closeResult = closeResult;
  }

  request(method, params, options) {
    const request = { method, params, options };
    this.requests.push(request);
    if (this.onRequest) return this.onRequest(request);
    return Promise.resolve({ target_id: 'target-1' });
  }

  async close(options) {
    this.closeCalls.push(options);
    return typeof this.closeResult === 'function' ? this.closeResult(options) : this.closeResult;
  }
}

const pass = (expected = 'ready', actual = expected) => ({
  verdict: 'pass', expected, actual, terminal: true
});

function oneStepFlow({
  check = 'ready',
  handler = 'pass',
  method = 'chrome.navigate',
  params = { url: 'https://fixture.test/' },
  timeout_ms = 80,
  checkSpec = {},
  final_checks = [`open.${check}`],
  inputs = {}
} = {}) {
  return {
    schema_version: 1,
    flow_id: 'flow-test',
    revision: 1,
    inputs,
    timeout_ms: 200,
    checks: {
      [check]: {
        handler,
        args: {},
        timeout_ms: 40,
        poll_ms: 1,
        stable_ms: 0,
        ...checkSpec
      }
    },
    steps: [{
      id: 'open',
      label: 'Open fixture',
      action: { method, params },
      timeout_ms,
      min_delay_ms: 0,
      requires: [],
      consumes: [],
      expect: [check],
      releases: []
    }],
    final_checks
  };
}

function passHandlers() {
  return { pass: () => pass() };
}

async function run(flow, handlers = passHandlers(), options = {}) {
  const transport = options.transport ?? new FakeTransport(options.transportOptions);
  const result = await runFlow({ flow, handlers, transport, ...options });
  return { result, transport };
}

test('executes a normal sequence and rechecks the final fact', async () => {
  const flow = {
    ...oneStepFlow({ check: 'ready', params: { url: 'https://fixture.test/' } }),
    checks: {
      ready: { handler: 'pass', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 },
      filled: { handler: 'pass', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 }
    },
    steps: [
      {
        id: 'open', label: 'Open fixture', action: { method: 'chrome.navigate', params: { url: 'https://fixture.test/' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: [], expect: ['ready'], releases: []
      },
      {
        id: 'fill', label: 'Fill query', action: { method: 'chrome.fill', params: { selector: '#query', value: 'Smoke' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['open.ready'], expect: ['filled'], releases: []
      }
    ],
    final_checks: ['fill.filled']
  };
  const { result, transport } = await run(flow);

  assert.equal(result.event, 'run.completed');
  assert.equal(result.status, 'completed');
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    'interaction.begin', 'chrome.navigate', 'chrome.fill'
  ]);
  assert.deepEqual(result.steps.map(({ id, status, effect }) => ({ id, status, effect })), [
    { id: 'open', status: 'succeeded', effect: 'confirmed' },
    { id: 'fill', status: 'succeeded', effect: 'confirmed' }
  ]);
  assert.equal(result.metrics.steps_succeeded, 2);
});

test('rejects malformed flows before sending any executor request', async (t) => {
  const cases = {
    'unknown field': (flow) => { flow.unexpected = true; },
    'missing handler': (flow) => { flow.checks.ready.handler = 'missing'; },
    'forward released fact': (flow) => {
      flow.checks.done = { handler: 'pass', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 };
      flow.steps.push({
        id: 'submit', label: 'Submit', action: { method: 'chrome.click', params: { selector: '#submit' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['open.ready'], expect: ['done'], releases: ['open.ready']
      });
      flow.steps.push({
        id: 'after', label: 'After submit', action: { method: 'chrome.query', params: { selector: '#result' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['open.ready'], expect: ['done'], releases: []
      });
      flow.final_checks = ['submit.done'];
    },
    'missing input': (flow) => { flow.steps[0].action.params = { url: { input: 'missing' } }; },
    'missing required action parameter': (flow) => {
      flow.steps[0].action = { method: 'chrome.fill', params: { selector: '#query' } };
    },
    'unsupported method': (flow) => { flow.steps[0].action.method = 'chrome.notAnAction'; }
  };

  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => {
      const flow = oneStepFlow();
      mutate(flow);
      const { result, transport } = await run(flow);

      assert.equal(result.event, 'run.handoff');
      assert.equal(result.fault.code, 'FLOW_INVALID');
      assert.deepEqual(transport.requests, [], 'validation must precede interaction.begin and actions');
      assert.equal(transport.closeCalls.length, 1, 'cleanup remains bounded even after validation failure');
    });
  }
});

test('does not treat an action response as success when its postcondition fails', async () => {
  const flow = oneStepFlow({ check: 'post', handler: 'bad' });
  const handlers = {
    bad: () => ({ verdict: 'fail', expected: 'result=ok', actual: 'result=wrong', terminal: true })
  };
  const { result, transport } = await run(flow, handlers);

  assert.equal(result.event, 'run.handoff');
  assert.equal(result.fault.code, 'POSTCONDITION_FAILED');
  assert.equal(result.fault.detected_at, 'open');
  assert.equal(result.steps[0].action_dispatched, true);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].effect, 'unknown');
  assert.equal(transport.requests.some(({ method }) => method === 'chrome.navigate'), true);
});

test('accepts chrome.attach criteria supported by the CLI without a target_id', async () => {
  const flow = oneStepFlow({ method: 'chrome.attach', params: { url_contains: 'fixture.test' } });
  const transport = new FakeTransport({
    onRequest: ({ method }) => method === 'interaction.begin'
      ? { target_id: 'target-1' }
      : { target_id: method === 'chrome.attach' ? 'target-2' : 'target-2' }
  });
  const { result, transport: used } = await run(flow, passHandlers(), { transport });

  assert.equal(result.status, 'completed');
  assert.ok(used.requests.some(({ method }) => method === 'chrome.attach'));
});

test('rejects an implicit target change returned by a normal action', async () => {
  const flow = oneStepFlow();
  const transport = new FakeTransport({
    onRequest: ({ method }) => method === 'interaction.begin'
      ? { target_id: 'target-1' }
      : { target_id: 'target-2' }
  });
  const { result } = await run(flow, passHandlers(), { transport });

  assert.equal(result.status, 'handoff');
  assert.equal(result.fault.code, 'CHECK_UNAVAILABLE');
  assert.equal(result.fault.reason, 'target_changed');
  assert.equal(result.steps[0].action_dispatched, true);
  assert.equal(result.steps[0].effect, 'unknown');
});

test('reports a changed prior fact at submit and marks only declared descendants', async () => {
  let fieldChecks = 0;
  const flow = {
    ...oneStepFlow(),
    checks: {
      ready: { handler: 'ready', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 },
      field: { handler: 'field', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 },
      result: { handler: 'result', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 },
      after: { handler: 'after', args: {}, timeout_ms: 30, poll_ms: 1, stable_ms: 0 }
    },
    steps: [
      {
        id: 'open', label: 'Open', action: { method: 'chrome.navigate', params: { url: 'fixture://' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: [], expect: ['ready'], releases: []
      },
      {
        id: 'fill', label: 'Fill', action: { method: 'chrome.fill', params: { selector: '#query', value: 'Smoke' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['open.ready'], expect: ['field'], releases: []
      },
      {
        id: 'submit', label: 'Submit', action: { method: 'chrome.click', params: { selector: '#submit' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['fill.field'], expect: ['result'], releases: []
      },
      {
        id: 'after', label: 'After', action: { method: 'chrome.query', params: { selector: '#result' } },
        timeout_ms: 80, min_delay_ms: 0, requires: [], consumes: ['submit.result'], expect: ['after'], releases: []
      }
    ],
    final_checks: ['after.after']
  };
  const handlers = {
    ready: async ({ evaluate }) => { await evaluate('ready'); return pass('ready', 'ready'); },
    field: async ({ evaluate }) => {
      const value = await evaluate('field');
      fieldChecks += 1;
      return fieldChecks === 1
        ? pass('query=Smoke', value)
        : { verdict: 'fail', expected: 'query=Smoke', actual: value, terminal: true };
    },
    result: () => pass('result=ok'),
    after: () => pass('after=ok')
  };
  const transport = new FakeTransport({
    onRequest: ({ method, params }) => {
      if (method === 'chrome.evaluate') return Promise.resolve({ target_id: 'target-1', value: params.expression === 'field' ? '' : 'ready' });
      return Promise.resolve({ target_id: 'target-1' });
    }
  });
  const { result } = await run(flow, handlers, { transport });

  assert.equal(result.fault.code, 'PRIOR_RESULT_INVALIDATED');
  assert.equal(result.fault.detected_at, 'submit');
  assert.equal(result.fault.producer_step_id, 'fill');
  assert.equal(result.fault.fact_id, 'fill.field');
  assert.equal(result.steps.find((step) => step.id === 'submit').action_dispatched, false);
  assert.deepEqual(result.affected, [
    { step_id: 'submit', validity: 'blocked' },
    { step_id: 'after', validity: 'blocked' }
  ]);
  assert.equal(transport.requests.some(({ method }) => method === 'chrome.click'), false, 'submit was gated by dependency revalidation');
});

test('waits for a delayed pass to remain stable before succeeding', async () => {
  let checks = 0;
  const flow = oneStepFlow({ checkSpec: { timeout_ms: 80, poll_ms: 2, stable_ms: 12 } });
  const handlers = {
    pass: () => {
      checks += 1;
      return checks === 1 ? { verdict: 'fail', actual: 'loading' } : { verdict: 'pass', expected: 'ready', actual: 'ready' };
    }
  };
  const { result } = await run(flow, handlers);

  assert.equal(result.status, 'completed');
  assert.ok(checks >= 4, `expected polling through the stable window, got ${checks} checks`);
});

test('maps a throwing check to unknown and hands off', async () => {
  const flow = oneStepFlow({ checkSpec: { timeout_ms: 8, poll_ms: 1 } });
  const handlers = { pass: () => { throw new Error('probe exploded'); } };
  const { result } = await run(flow, handlers);

  assert.equal(result.fault.code, 'CHECK_UNAVAILABLE');
  assert.equal(result.fault.verdict, 'unknown');
  assert.equal(result.fault.actual.code, 'CHECK_EXCEPTION');
  assert.equal(result.fault.detected_at, 'open');
});

test('does not accept a synchronous check result produced after its budget', async () => {
  const flow = oneStepFlow({ checkSpec: { timeout_ms: 5, poll_ms: 1 } });
  const handlers = {
    pass: () => {
      const end = performance.now() + 15;
      while (performance.now() < end) { /* deliberately block the event loop */ }
      return pass();
    }
  };
  const { result } = await run(flow, handlers);

  assert.equal(result.status, 'handoff');
  assert.equal(result.fault.code, 'CHECK_UNAVAILABLE');
  assert.equal(result.fault.actual.code, 'DEADLINE_EXCEEDED');
  assert.equal(result.steps[0].status, 'failed');
});

test('prevents a timed-out check handler from issuing a late evaluate request', async () => {
  let finishHandler;
  const handlerFinished = new Promise((resolve) => { finishHandler = resolve; });
  let lateError;
  const flow = oneStepFlow({ checkSpec: { timeout_ms: 6, poll_ms: 1 } });
  const handlers = {
    pass: async ({ evaluate }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { await evaluate('late-check'); }
      catch (error) { lateError = error; }
      finishHandler();
      return pass();
    }
  };
  const transport = new FakeTransport();
  const { result } = await run(flow, handlers, { transport });
  const handlerSettled = await Promise.race([
    handlerFinished.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100))
  ]);

  assert.equal(result.status, 'handoff');
  assert.equal(result.fault.code, 'CHECK_UNAVAILABLE');
  assert.equal(handlerSettled, true);
  assert.equal(lateError?.code, 'CHECK_UNAVAILABLE');
  assert.equal(transport.requests.some(({ method }) => method === 'chrome.evaluate'), false);
});

test('marks a dispatched write as unknown when its request times out', async () => {
  const flow = oneStepFlow({ method: 'chrome.click', params: { selector: '#submit' }, timeout_ms: 12 });
  const transport = new FakeTransport({
    onRequest: ({ method }) => method === 'chrome.click' ? new Promise(() => {}) : Promise.resolve({ target_id: 'target-1' })
  });
  const { result, transport: used } = await run(flow, passHandlers(), { transport });

  assert.equal(result.fault.code, 'DEADLINE_EXCEEDED');
  assert.equal(result.steps[0].action_dispatched, true);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].effect, 'unknown');
  assert.equal(used.requests.filter(({ method }) => method === 'chrome.click').length, 1);
});

test('cancels a step during its bounded delay and preserves unknown write effect', async () => {
  const controller = new AbortController();
  const flow = oneStepFlow({ method: 'chrome.click', params: { selector: '#submit' }, timeout_ms: 100 });
  flow.steps[0].min_delay_ms = 60;
  const transport = new FakeTransport({
    onRequest: ({ method }) => {
      if (method === 'chrome.click') queueMicrotask(() => controller.abort());
      return Promise.resolve({ target_id: 'target-1' });
    }
  });
  const { result } = await run(flow, passHandlers(), { transport, signal: controller.signal });

  assert.equal(result.event, 'run.cancelled');
  assert.equal(result.fault.code, 'CANCELLED');
  assert.equal(result.steps[0].status, 'cancelled');
  assert.equal(result.steps[0].effect, 'unknown');
  assert.equal(result.quiescent, true);
});

test('honors cancellation before initialization without dispatching a request', async () => {
  const controller = new AbortController();
  controller.abort();
  const flow = oneStepFlow();
  const { result, transport } = await run(flow, passHandlers(), { signal: controller.signal });

  assert.equal(result.event, 'run.cancelled');
  assert.equal(result.fault.code, 'CANCELLED');
  assert.deepEqual(transport.requests, []);
  assert.deepEqual(result.steps, []);
});

test('revalidates final facts and refuses completion after the result changes', async () => {
  let checks = 0;
  const flow = oneStepFlow({ check: 'result', handler: 'result' });
  const handlers = {
    result: async ({ evaluate }) => {
      checks += 1;
      const value = await evaluate('result');
      return checks === 1 ? pass('result=ok', value) : { verdict: 'fail', expected: 'result=ok', actual: 'changed', terminal: true };
    }
  };
  const transport = new FakeTransport({
    onRequest: ({ method }) => method === 'chrome.evaluate'
      ? Promise.resolve({ target_id: 'target-1', value: 'result=ok' })
      : Promise.resolve({ target_id: 'target-1' })
  });
  const { result } = await run(flow, handlers, { transport });

  assert.equal(result.event, 'run.handoff');
  assert.equal(result.fault.code, 'PRIOR_RESULT_INVALIDATED');
  assert.equal(result.fault.detected_at, 'final_check');
  assert.equal(result.fault.producer_step_id, 'open');
  assert.equal(result.fault.fact_id, 'open.result');
  assert.equal(result.steps[0].status, 'succeeded');
});

test('turns a non-quiescent cleanup into an executor handoff', async () => {
  const flow = oneStepFlow();
  const transport = new FakeTransport({ closeResult: { quiescent: false, errors: ['CLEANUP_TIMEOUT'] } });
  const { result } = await run(flow, passHandlers(), { transport });

  assert.equal(result.event, 'run.handoff');
  assert.equal(result.status, 'handoff');
  assert.equal(result.fault.code, 'EXECUTOR_LOST');
  assert.equal(result.fault.phase, 'cleanup');
  assert.equal(result.quiescent, false);
  assert.deepEqual(result.cleanup_errors, ['CLEANUP_TIMEOUT']);
});

test('progress callback errors cannot skip checks or change completion', async () => {
  let checks = 0;
  const flow = oneStepFlow();
  const handlers = {
    pass: () => { checks += 1; return pass(); }
  };
  const { result } = await run(flow, handlers, { onEvent: () => { throw new Error('progress sink failed'); } });

  assert.equal(result.event, 'run.completed');
  assert.equal(result.status, 'completed');
  assert.equal(checks, 2, 'expect and final checks both ran despite progress callback failure');
});

test('resolves host input references in action params and check args', async () => {
  const seen = { inputs: null, args: null };
  const flow = oneStepFlow({
    check: 'ready',
    handler: 'ready',
    method: 'chrome.fill',
    inputs: {
      selector: '#query',
      query: 'Smoke',
      options: { exact: true }
    },
    params: {
      selector: { input: 'selector' },
      value: { input: 'query' },
      options: { input: 'options' }
    }
  });
  flow.checks.ready.args = {
    expected: { input: 'query' },
    options: { input: 'options' }
  };
  const handlers = {
    ready: ({ inputs, args }) => {
      seen.inputs = inputs;
      seen.args = args;
      return pass('query=Smoke');
    }
  };
  const { result, transport } = await run(flow, handlers);
  const action = transport.requests.find(({ method }) => method === 'chrome.fill');

  assert.equal(result.status, 'completed');
  assert.deepEqual(seen.inputs, flow.inputs);
  assert.deepEqual(seen.args, { expected: 'Smoke', options: { exact: true } });
  assert.equal(action.params.selector, '#query');
  assert.equal(action.params.value, 'Smoke');
  assert.deepEqual(action.params.options, { exact: true });
  assert.equal(action.params.action_label, 'Open fixture');
});
