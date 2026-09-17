import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const executable = process.env.DESKPILOT_TEST_EXE ?? resolve('src/WindowsAgent.Cli/bin/Debug/net10.0-windows10.0.19041.0/win-x64/win-agent.exe');
function session() {
  const child = spawn(executable, ['exec', '--stdin', '--format', 'ndjson'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '', counter = 0;
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const cut = buffer.indexOf('\n'), line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      pending.get(value.request_id)?.(value);
      pending.delete(value.request_id);
    }
  });
  const exited = once(child, 'exit');
  return {
    child,
    async request(method, params = {}) {
      const id = String(++counter);
      let timer;
      try {
        return await Promise.race([
          new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Request timed out: ${method}`)), 30000); })
        ]);
      } finally { clearTimeout(timer); }
    },
    async close() {
      child.stdin.end();
      let timer;
      try {
        const [code] = await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit')); }, 6000);
        })]);
        assert.equal(code, 0);
      } finally { clearTimeout(timer); }
    }
  };
}

for (const fixture of [
  { name: 'HTTP failure', version: null, stage: 'version', code: 'HttpRequestException' },
  { name: 'invalid version', version: {}, stage: 'version', code: 'CDP_VERSION_INVALID' },
  { name: 'no page target', version: { webSocketDebuggerUrl: 'ws://unused' }, stage: 'targets', code: 'CDP_PAGE_TARGET_MISSING' },
  { name: 'WebSocket failure', version: { webSocketDebuggerUrl: 'ws://unused' }, targets: [{ id: 'bad', type: 'page', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:1' }], stage: 'websocket_or_initialization', code: 'WebSocketException' }
]) {
  test(`explicit endpoint: ${fixture.name} returns structured diagnostics without fallback`, async () => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (fixture.version === null) { res.writeHead(503); res.end('{}'); return; }
      res.end(JSON.stringify(req.url === '/json/version' ? fixture.version : fixture.targets ?? []));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const host = session();
    try {
      const reply = await host.request('chrome.ensure', { endpoint, auto_start: true });
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, 'CHROME_CDP_UNAVAILABLE');
      assert.deepEqual(reply.error.details.attempts, [{ endpoint, stage: fixture.stage, error_code: fixture.code }]);
    } finally { await host.close(); await new Promise(resolve => server.close(resolve)); }
  });
}

test('managed browser survives CLI EOF and can be reused from a new session', { skip: process.env.DESKPILOT_BROWSER_SMOKE !== '1', timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'deskpilot-lifecycle-'));
  let endpoint;
  const first = session();
  try {
    const reply = await first.request('chrome.ensure', { profile_mode: 'managed', user_data_dir: profile, url: 'about:blank', restore_original_window: true });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    endpoint = reply.result.endpoint;
    assert.ok(endpoint);
    await first.close();
    assert.equal((await fetch(endpoint + '/json/version')).ok, true, 'browser must outlive helper');
    const second = session();
    try {
      const attached = await second.request('chrome.ensure', { endpoint, auto_start: false, restore_original_window: true });
      assert.equal(attached.ok, true, JSON.stringify(attached));
      assert.equal(attached.result.endpoint, endpoint);
      const evaluated = await second.request('chrome.evaluate', { expression: '1 + 1', restore_original_window: true });
      assert.equal(evaluated.ok, true, JSON.stringify(evaluated));
      const wrongEndpoint = await second.request('chrome.ensure', { endpoint: 'http://127.0.0.1:1', auto_start: false });
      assert.equal(wrongEndpoint.ok, false, 'an existing connection must not hide a different explicit endpoint');
      assert.equal(wrongEndpoint.error.code, 'CHROME_CDP_UNAVAILABLE');
      const reattached = await second.request('chrome.ensure', { endpoint, auto_start: false, restore_original_window: true });
      assert.equal(reattached.ok, true, JSON.stringify(reattached));
    } finally { await second.close(); }
    assert.equal((await fetch(endpoint + '/json/version')).ok, true);
  } finally {
    if (first.child.exitCode === null) await first.close();
    if (endpoint) {
      // Close only the browser we started with this test's unique profile.
      const version = await (await fetch(endpoint + '/json/version')).json();
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await new Promise(resolve => { socket.onclose = resolve; setTimeout(() => { socket.close(); resolve(); }, 3000).unref(); });
    }
    assert.ok(profile.startsWith(join(tmpdir(), 'deskpilot-lifecycle-')));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
