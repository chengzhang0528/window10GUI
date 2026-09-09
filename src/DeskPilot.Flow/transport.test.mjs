import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { DeskPilotTransport, TransportError } from './transport.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.lines = [];
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        const line = chunk.toString('utf8');
        this.lines.push(JSON.parse(line));
        this.onRequest?.(this.lines.at(-1));
        callback();
      }
    });
  }

  respond(envelope) { this.stdout.write(`${JSON.stringify(envelope)}\n`); }

  stop(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill() { this.stop(1, 'SIGTERM'); return true; }
}

function startFake(onRequest) {
  const child = new FakeChild();
  child.onRequest = onRequest;
  let options;
  const transport = new DeskPilotTransport({
    executable: 'win-agent.exe',
    // Keep forced-close tests safe if the suite itself runs on Windows: no
    // real PID is ever passed to taskkill.
    execFileImpl: (_file, _args, _options, callback) => callback(new Error('fake taskkill')),
    spawnImpl: (executable, args, spawnOptions) => {
      options = { executable, args, spawnOptions };
      return child;
    }
  });
  return { child, transport, get options() { return options; } };
}

test('spawns a hidden UTF-8 piped executor and resolves the raw result', async () => {
  const fake = startFake((request) => fake.child.respond({
    ok: true, request_id: request.id, result: { accepted: true }
  }));
  const result = await fake.transport.request('observe', { include_text: true });

  assert.deepEqual(result, { accepted: true });
  assert.equal(fake.options.executable, 'win-agent.exe');
  assert.deepEqual(fake.options.args, ['exec', '--stdin', '--format', 'ndjson']);
  assert.equal(fake.options.spawnOptions.windowsHide, true);
  assert.deepEqual(fake.options.spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(fake.transport.pendingCount, 0);
  assert.equal(fake.transport.recent.at(-1).status, 'succeeded');
  await fake.transport.close({ cancel: false, timeoutMs: 20 });
});

test('preserves executor error code and details without exposing stderr', async () => {
  const fake = startFake((request) => fake.child.respond({
    ok: false,
    request_id: request.id,
    error: { code: 'CHECK_UNAVAILABLE', message: 'context changed', details: { target: 'chrome' }, retryable: true }
  }));
  fake.child.stderr.write('page body that must stay internal');

  await assert.rejects(fake.transport.request('observe'), (error) => {
    assert(error instanceof TransportError);
    assert.equal(error.code, 'CHECK_UNAVAILABLE');
    assert.deepEqual(error.details, { target: 'chrome' });
    assert.equal(error.message, 'context changed');
    assert.equal('page' in error, false);
    return true;
  });
  await fake.transport.close({ cancel: false, timeoutMs: 20 });
});

test('allows cancellation to complete independently of a long request', async () => {
  const fake = startFake((request) => {
    if (request.method === 'interaction.cancel') {
      fake.child.respond({ ok: true, request_id: request.id, result: { status: 'cancellation_requested' } });
    }
  });
  const longRequest = fake.transport.request('workflow.run', {}, { timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = fake.transport.request('interaction.cancel', {});
  assert.deepEqual(await cancel, { status: 'cancellation_requested' });
  assert.equal(fake.transport.pendingCount, 1);
  await assert.rejects(longRequest, { code: 'DEADLINE_EXCEEDED' });
  await fake.transport.close({ cancel: false, timeoutMs: 20 });
});

test('rejects malformed, missing-id, missing-result, and duplicate responses', async () => {
  const cases = [
    (fake) => fake.child.stdout.write('{not-json}\n'),
    (fake) => fake.child.respond({ ok: true, result: {} }),
    (fake) => fake.child.respond({ ok: true, request_id: fake.child.lines[0].id })
  ];
  for (const sendBadResponse of cases) {
    const fake = startFake((request) => sendBadResponse(fake));
    const request = fake.transport.request('observe', {}, { timeoutMs: 100 });
    await assert.rejects(request, (error) => error instanceof TransportError && error.code === 'EXECUTOR_PROTOCOL_ERROR');
    await fake.transport.close({ cancel: false, timeoutMs: 20 });
  }

  const duplicate = startFake((request) => {
    duplicate.child.respond({ ok: true, request_id: request.id, result: 1 });
    duplicate.child.respond({ ok: true, request_id: request.id, result: 2 });
  });
  assert.equal(await duplicate.transport.request('observe'), 1);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(duplicate.transport.request('observe'), { code: 'EXECUTOR_PROTOCOL_ERROR' });
  await duplicate.transport.close({ cancel: false, timeoutMs: 20 });
});

test('timeout keeps the request metadata until its late response arrives', async () => {
  const fake = startFake(() => {});
  const request = fake.transport.request('click', { confirmed: true }, { timeoutMs: 5 });
  await assert.rejects(request, { code: 'DEADLINE_EXCEEDED' });
  assert.equal(fake.transport.pendingCount, 1);
  const id = fake.child.lines[0].id;
  fake.child.respond({ ok: true, request_id: id, result: { sent: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.transport.pendingCount, 0);
  assert.equal(fake.transport.recent.at(-1).status, 'late_result');
  await fake.transport.close({ cancel: false, timeoutMs: 20 });
});

test('normal close sends cancel then close and reports quiescence', async () => {
  const fake = startFake((request) => {
    fake.child.respond({ ok: true, request_id: request.id, result: { status: request.method } });
    if (request.method === 'close') queueMicrotask(() => fake.child.stop());
  });
  const result = await fake.transport.close({ cancel: true, timeoutMs: 500 });
  assert.equal(result.quiescent, true);
  assert.deepEqual(fake.child.lines.map((line) => line.method), ['interaction.cancel', 'close']);
  assert.equal(fake.transport.closed, true);
  await assert.rejects(fake.transport.request('observe'), { code: 'TRANSPORT_CLOSED' });
});

test('forced close uses only the owned PID tree and settles before its deadline', async () => {
  const child = new FakeChild();
  const calls = [];
  const transport = new DeskPilotTransport({
    executable: 'win-agent.exe',
    spawnImpl: () => child,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      queueMicrotask(() => { child.stop(1); callback(null); });
    }
  });
  const result = await transport.close({ cancel: false, timeoutMs: 100 });
  assert.equal(result.quiescent, true);
  if (process.platform === 'win32') {
    assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.shell, false);
  } else {
    assert.equal(calls.length, 0);
  }
});
