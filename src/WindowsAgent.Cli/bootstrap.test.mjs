import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'deskpilot-bootstrap-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'deskpilot-bootstrap-'))); rmSync(root, { recursive: true, force: true }); });
  const bin = join(root, '工具 with spaces', 'bin');
  mkdirSync(join(bin, 'app'), { recursive: true });
  for (const [file, output] of [['launcher.c', 'win-agent.exe'], ['launcher-fixture.c', 'app/win-agent.exe']]) {
    const compiled = join(root, file + '.exe');
    const built = spawnSync('gcc', ['-municode', '-Os', '-static', join(source, 'portable', file), '-o', compiled], { encoding: 'utf8', windowsHide: true });
    assert.equal(built.status, 0, built.stderr);
    copyFileSync(compiled, join(bin, output));
  }
  const env = { ...process.env, DESKPILOT_TEST_MARKER: join(root, 'installed'), DESKPILOT_TEST_COUNTER: join(root, 'calls'), DESKPILOT_TEST_SETUP_COUNT: join(root, 'setups') };
  // Tests replace only the bundled script in an isolated fixture, never live installation.
  writeFileSync(join(bin, 'ensure-runtime.ps1'), `Add-Content -LiteralPath $env:DESKPILOT_TEST_SETUP_COUNT -Value 'setup'\nWrite-Output 'setup output must go to stderr'\nif($env:DESKPILOT_TEST_SETUP_FAIL -eq '1'){exit 20}\nSet-Content -LiteralPath $env:DESKPILOT_TEST_MARKER -Value 'installed'\nexit 0\n`);
  return { root, env, run(args = [], extra = {}) {
    return spawnSync(join(bin, 'win-agent.exe'), args, { cwd: tmpdir(), env: { ...env, ...extra }, input: 'queued request\n', encoding: 'utf8', windowsHide: true, timeout: 20000 });
  }, calls() { return readFileSync(env.DESKPILOT_TEST_COUNTER, 'utf8').length; } };
}

for (const missing of ['80008096', '80008083']) {
  test(`missing runtime ${missing}: setup once, preserve arguments and stdin, direct second launch`, t => {
    const f = fixture(t);
    const args = ['exec', 'Chinese 中文', 'trailing\\', 'embedded"quote', '', 'space and slash\\'];
    const first = f.run(args, { DESKPILOT_TEST_MISSING_CODE: missing });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.replaceAll('\r\n', '\n'), args.map(arg => 'arg:' + arg + '\n').join('') + 'queued request\n');
    assert.match(first.stderr, /setup output must go to stderr/);
    const events = first.stderr.split(/\r?\n/).filter(line => line.startsWith('DESKPILOT_BOOTSTRAP ')).map(line => JSON.parse(line.slice('DESKPILOT_BOOTSTRAP '.length)));
    assert.deepEqual(events, [
      { version: 1, code: 'DESKPILOT_RUNTIME_PREPARING', exit_code: 0 },
      { version: 1, code: 'DESKPILOT_RUNTIME_READY', exit_code: 0 },
    ]);
    assert.equal(f.calls(), 2);
    const second = f.run(args);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, '');
    assert.equal(f.calls(), 3);
    assert.equal(readFileSync(f.env.DESKPILOT_TEST_SETUP_COUNT, 'utf8').trim().split(/\r?\n/).length, 1);
    // No portable cache: uninstalling the runtime triggers setup again.
    rmSync(f.env.DESKPILOT_TEST_MARKER);
    assert.equal(f.run().status, 0);
    assert.equal(f.calls(), 5);
  });
}
test('application failure never invokes setup or replays an action', t => {
  const f = fixture(t);
  const result = f.run(['--business-failure']);
  assert.equal(result.status, 7);
  assert.doesNotMatch(result.stderr, /DESKPILOT_BOOTSTRAP/);
  assert.equal(f.calls(), 1);
  assert.equal(existsSync(f.env.DESKPILOT_TEST_SETUP_COUNT), false);
});
test('failed or declined setup does not start the application again', t => {
  const f = fixture(t);
  const result = f.run([], { DESKPILOT_TEST_SETUP_FAIL: '1' });
  assert.equal(result.status, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /"code":"DESKPILOT_RUNTIME_SETUP_FAILED","exit_code":20/);
  assert.doesNotMatch(result.stderr, /DESKPILOT_RUNTIME_READY/);
  assert.equal(f.calls(), 1);
  assert.equal(existsSync(f.env.DESKPILOT_TEST_MARKER), false);
});

test('Windows PowerShell setup success and failure decisions', () => {
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'portable/runtime-setup.test.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /7 setup decisions passed/);
});
