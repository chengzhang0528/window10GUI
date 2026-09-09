import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileDeclarativeScenario } from './data-compiler.mjs';

function scenario(predicate = { type: 'page', text: { contains: 'Ready' } }) {
  return { schema_version: 1, scenario_id: 'contract', inputs: {}, targets: { field: { selector: '#field' } }, flows: {
    simple: { flow_id: 'contract-simple', revision: 1, timeout_ms: 1000,
      checks: { ready: { predicate, timeout_ms: 200, poll_ms: 10, stable_ms: 0 } },
      steps: [{ id: 'open', label: 'Open', timeout_ms: 500, action: { type: 'ensure', auto_start: false }, expect: ['ready'] }],
      final_checks: ['open.ready'] }
  } };
}

async function observe(predicate, nodes = [], text = 'Ready PRIVATE_PAGE_MARKER') {
  const { flow, handlers } = compileDeclarativeScenario(scenario(predicate));
  return handlers[flow.checks.ready.handler]({ inputs: {}, args: {}, evaluate: expression => vm.runInNewContext(expression, {
    location: { href: 'https://example.test/' },
    document: { body: { innerText: text }, querySelectorAll: () => nodes },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  }) });
}

const element = (attributes = {}) => ({ value: 'PRIVATE_VALUE_MARKER', innerText: 'PRIVATE_TEXT_MARKER',
  textContent: 'PRIVATE_TEXT_MARKER', disabled: false, readOnly: false,
  getAttribute: name => attributes[name] ?? null,
  getBoundingClientRect: () => ({ width: 10, height: 10 }) });

test('predicate variant fields cannot silently discard an assertion', () => {
  for (const predicate of [
    { type: 'page', text: { contains: 'Ready' }, count: { equals: 0 } },
    { type: 'all', conditions: [{ type: 'page', text: { contains: 'Ready' } }], value: { equals: 'wrong' } },
    { type: 'element', target: 'field', value: { equals: 'x' }, url: { equals: 'wrong' } }
  ]) assert.throws(() => compileDeclarativeScenario(scenario(predicate)), { code: 'FLOW_INVALID' });
});

test('action variant fields cannot silently discard an intended parameter', () => {
  const data = scenario();
  data.flows.simple.steps[0].action = { type: 'ensure', value: 'must-not-be-ignored' };
  assert.throws(() => compileDeclarativeScenario(data), { code: 'FLOW_INVALID' });
});

test('a property check never selects the first ambiguous element', async () => {
  const result = await observe({ type: 'element', target: 'field', value: { equals: 'PRIVATE_VALUE_MARKER' } }, [element(), element()]);
  assert.notEqual(result.verdict, 'pass');
});

test('page and element feedback contain comparisons, not captured page content', async () => {
  const page = await observe({ type: 'page', text: { contains: 'Ready' } });
  assert.equal(page.verdict, 'pass');
  assert.ok(!JSON.stringify(page).includes('PRIVATE_PAGE_MARKER'));
  const field = await observe({ type: 'element', target: 'field', value: { equals: 'expected' }, text: { contains: 'expected' } }, [element()]);
  assert.equal(field.verdict, 'fail');
  assert.ok(!JSON.stringify(field).includes('PRIVATE_VALUE_MARKER'));
  assert.ok(!JSON.stringify(field).includes('PRIVATE_TEXT_MARKER'));
});

test('a missing attribute is not equal to an existing empty attribute', async () => {
  const predicate = { type: 'element', target: 'field', attribute: { name: 'aria-label', equals: '' } };
  assert.notEqual((await observe(predicate, [element()])).verdict, 'pass');
  assert.equal((await observe(predicate, [element({ 'aria-label': '' })])).verdict, 'pass');
});

test('scalar input expectations reject unsupported object values', () => {
  const data = scenario({ type: 'element', target: 'field', value: { equals: { input: 'expected' } } });
  data.inputs.expected = { nested: 'not a scalar' };
  assert.throws(() => compileDeclarativeScenario(data), { code: 'FLOW_INVALID' });
});

test('input names and strings remain data rather than script hooks', async () => {
  const literal = '"}); globalThis.injected = true; //';
  const data = scenario({ type: 'element', target: 'field', value: { equals: { input: 'code' } } });
  data.inputs.code = literal;
  const { flow, handlers } = compileDeclarativeScenario(data);
  const context = { document: { querySelectorAll: () => [{ ...element(), value: literal }] }, injected: false };
  const result = await handlers[flow.checks.ready.handler]({ inputs: data.inputs, args: {},
    evaluate: expression => vm.runInNewContext(expression, context) });
  assert.equal(result.verdict, 'pass');
  assert.equal(context.injected, false);
});

test('a parameterized text target selects the same element for checking and clicking', async () => {
  const data = scenario({ type: 'element', target: 'field', count: { equals: 1 }, visible: true });
  data.inputs.objectName = 'wanted-object';
  data.targets.field.text = { contains: { input: 'objectName' } };
  data.flows.simple.steps[0].action = { type: 'click', target: 'field' };
  const { flow, handlers } = compileDeclarativeScenario(data);
  const clicked = [];
  const context = { document: { querySelectorAll: () => ['other-object', 'wanted-object'].map(name => ({
    ...element(), innerText: name, textContent: name, click: () => clicked.push(name)
  })) }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const result = await handlers[flow.checks.ready.handler]({ inputs: data.inputs,
    evaluate: expression => vm.runInNewContext(expression, context) });
  assert.equal(result.verdict, 'pass');
  vm.runInNewContext(flow.steps[0].action.params.expression, context);
  assert.deepEqual(clicked, ['wanted-object']);
});

test('non-object predicates and mistyped connection settings fail preflight', () => {
  assert.throws(() => compileDeclarativeScenario(scenario(null)), { code: 'FLOW_INVALID' });
  for (const action of [{ type: 'ensure', auto_start: 'false' }, { type: 'ensure', url: 123 }]) {
    const data = scenario();
    data.flows.simple.steps[0].action = action;
    assert.throws(() => compileDeclarativeScenario(data), { code: 'FLOW_INVALID' });
  }
});

test('public entry never imports a scene module and rejects invalid data before CLI startup', async () => {
  const parent = resolve(tmpdir());
  const folder = await mkdtemp(join(parent, 'deskpilot-data-contract-'));
  const marker = join(folder, 'imported.txt');
  try {
    const modulePath = join(folder, 'scene.mjs');
    await writeFile(modulePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export const flows = {};`);
    const dataPath = join(folder, 'scene.json');
    const data = scenario();
    data.flows.simple.steps[0].action.expression = 'must not execute';
    await writeFile(dataPath, JSON.stringify(data));
    for (const path of [modulePath, dataPath]) {
      let output;
      try {
        await promisify(execFile)(process.execPath, [resolve('src/DeskPilot.Flow/run.mjs'), '--scenario', path,
          '--executable', join(folder, 'executor-must-not-start.exe')], { windowsHide: true, timeout: 5000 });
        assert.fail('invalid entry should exit with handoff');
      } catch (error) {
        assert.equal(error.code, 2);
        output = JSON.parse(error.stdout.trim());
      }
      assert.equal(output.status, 'handoff');
      assert.equal(output.fault.code, 'FLOW_INVALID');
      assert.equal(output.fault.phase, 'initialization');
      assert.equal(output.quiescent, true);
    }
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    assert.equal(dirname(resolve(folder)), parent);
    await rm(folder, { recursive: true, force: true });
  }
});
