import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { DeskPilotClient, runOnce } from '../lib/client.js'
import { requirePublicExecutable } from '../lib/executable.js'

function fixture(t, onRequest = (req, io) => io.reply(req)) {
  const requests = [], timers = new Set()
  let finish, terminated = 0, spawns = 0, inputEnded = false
  const stdout = new PassThrough(), stderr = new PassThrough()
  const done = new Promise(resolve => { finish = resolve })
  const io = {
    stdout, stderr,
    reply(req, result = { method: req.method }) { stdout.write(JSON.stringify({ ok: true, request_id: req.id, result }) + '\n') },
    event(code, exit_code = 0) { stderr.write('DESKPILOT_BOOTSTRAP ' + JSON.stringify({ version: 1, code, exit_code }) + '\n') },
    later(ms, fn) { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer) },
    exit(exitCode = 0) { stdout.end(); stderr.end(); finish({ exitCode, signal: null }) },
  }
  const stdin = new Writable({ write(chunk, _, cb) {
    for (const line of chunk.toString().trim().split('\n')) {
      const req = JSON.parse(line)
      requests.push(req)
      queueMicrotask(() => {
        if (req.method === 'close') io.exit()
        else if (req.method !== 'interaction.cancel') onRequest(req, io)
      })
    }
    cb()
  } })
  stdin.on('finish', () => { inputEnded = true })
  const handle = { stdin, stdout, stderr, done, waitForExit: () => done.then(() => true), terminate() { terminated++; io.exit() } }
  const subprocess = { spawn(options) {
    spawns++
    assert.deepEqual(options.argv.slice(1), ['exec', '--stdin', '--format', 'ndjson'])
    assert.equal(options.cwd, 'test-cwd')
    return handle
  } }
  t.after(() => { for (const timer of timers) clearTimeout(timer); io.exit() })
  return { requests, io, handle, subprocess, get terminated() { return terminated }, get spawns() { return spawns }, get inputEnded() { return inputEnded },
    options: { subprocess, executable: 'fixture.exe', cwd: 'test-cwd', timeoutMs: 80, setupTimeoutMs: 300, maxLineBytes: 4096 } }
}

test('old launcher without events: probe once, pair out-of-order replies, reuse session', async t => {
  const f = fixture(t, (req, io) => io.later(req.method === 'first' ? 25 : 1, () => io.reply(req)))
  const c = new DeskPilotClient(f.options)
  const [a, b] = await Promise.all([c.request('first', {}), c.request('second', {})])
  assert.equal(a.result.method, 'first'); assert.equal(b.result.method, 'second')
  assert.equal(f.spawns, 1)
  assert.equal(f.requests.filter(req => req.method === 'capabilities').length, 1)
  await c.close()
  assert.equal(c.handle, null)
})

test('confirmed setup gets its own budget; no business bytes before ready', async t => {
  const progress = []
  const f = fixture(t, (req, io) => {
    if (req.method !== 'capabilities') return io.reply(req)
    io.event('DESKPILOT_RUNTIME_PREPARING')
    io.later(140, () => {
      assert.deepEqual(f.requests.map(req => req.method), ['capabilities'])
      io.event('DESKPILOT_RUNTIME_READY'); io.reply(req)
    })
  })
  const c = new DeskPilotClient({ ...f.options, onProgress: event => progress.push(event.code) })
  assert.equal((await c.request('input.click', { x: 1 })).ok, true)
  assert.deepEqual(progress, ['DESKPILOT_RUNTIME_PREPARING', 'DESKPILOT_RUNTIME_READY'])
  assert.equal(f.requests.filter(req => req.method === 'input.click').length, 1)
  await c.close()
})

test('split events and UTF-8 diagnostics survive stream chunk boundaries', async t => {
  const f = fixture(t, (req, io) => {
    if (req.method !== 'capabilities') return io.reply(req)
    const bytes = Buffer.from('诊断\nDESKPILOT_BOOTSTRAP {"version":1,"code":"DESKPILOT_RUNTIME_PREPARING","exit_code":0}\n')
    for (const byte of bytes) io.stderr.write(Buffer.from([byte]))
    io.event('DESKPILOT_RUNTIME_SETUP_FAILED', 20)
  })
  const c = new DeskPilotClient(f.options)
  await assert.rejects(c.request('input.click'), error => error.code === 'DESKPILOT_RUNTIME_SETUP_FAILED' && error.stderr.includes('诊断'))
  assert.deepEqual(f.requests.map(req => req.method), ['capabilities'])
})

test('setup failure reports bounded original stderr and does not send or retry business', async t => {
  const f = fixture(t, (req, io) => {
    io.event('DESKPILOT_RUNTIME_PREPARING')
    io.stderr.write('x'.repeat(6000) + '\nWindows installer declined by user\n')
    io.event('DESKPILOT_RUNTIME_SETUP_FAILED', 20)
  })
  await assert.rejects(runOnce({ ...f.options, method: 'doctor' }), error => {
    assert.equal(error.code, 'DESKPILOT_RUNTIME_SETUP_FAILED')
    assert.equal(error.stderr_truncated, true)
    assert.ok(Buffer.byteLength(error.stderr) <= 4096)
    assert.match(error.message, /Windows installer declined by user/)
    return true
  })
  assert.deepEqual(f.requests.map(req => req.method), ['capabilities'])
})

test('preparation timeout ends waiting without taskkilling the installer tree', async t => {
  const f = fixture(t, (_, io) => io.event('DESKPILOT_RUNTIME_PREPARING'))
  const c = new DeskPilotClient({ ...f.options, setupTimeoutMs: 30 })
  await assert.rejects(c.request('input.click'), { code: 'DESKPILOT_RUNTIME_SETUP_TIMEOUT' })
  assert.equal(f.terminated, 0)
  assert.equal(f.inputEnded, true)
  assert.equal(c.closing, true)
  assert.equal(c.handle, f.handle)
  assert.deepEqual(f.requests.map(req => req.method), ['capabilities'])
})

test('cancel while preparing sends no business or interaction.cancel and closes stdin', async t => {
  const controller = new AbortController()
  const f = fixture(t, (_, io) => { io.event('DESKPILOT_RUNTIME_PREPARING'); io.later(5, () => controller.abort()) })
  const c = new DeskPilotClient(f.options)
  await assert.rejects(c.request('input.click', {}, { signal: controller.signal }), { code: 'DESKPILOT_ABORTED' })
  assert.equal(f.terminated, 0)
  assert.deepEqual(f.requests.map(req => req.method), ['capabilities'])
  assert.equal(f.inputEnded, true)
})

test('business timeout stays short after setup; no automatic replay', async t => {
  const f = fixture(t, (req, io) => { if (req.method === 'capabilities') { io.event('DESKPILOT_RUNTIME_PREPARING'); io.event('DESKPILOT_RUNTIME_READY'); io.reply(req) } })
  const c = new DeskPilotClient(f.options)
  await assert.rejects(c.request('input.click', {}, { timeoutMs: 20 }), { code: 'DESKPILOT_TIMEOUT', method: 'input.click', timeout_ms: 20 })
  assert.equal(f.requests.filter(req => req.method === 'input.click').length, 1)
  assert.equal(f.terminated, 1)
})

test('English setup prose or unknown event versions cannot extend the startup budget', async t => {
  const f = fixture(t, (_, io) => io.stderr.write('preparing runtime\nDESKPILOT_BOOTSTRAP {"version":2,"code":"DESKPILOT_RUNTIME_PREPARING","exit_code":0}\n'))
  await assert.rejects(runOnce({ ...f.options, timeoutMs: 20, method: 'doctor' }), { code: 'DESKPILOT_TIMEOUT' })
})

test('exit without a response is NO_RESPONSE, not a timeout', async t => {
  const f = fixture(t, (_, io) => { io.stderr.write('loader failure\n'); io.exit(7) })
  await assert.rejects(runOnce({ ...f.options, method: 'doctor' }), error => error.code === 'DESKPILOT_NO_RESPONSE' && error.message.includes('loader failure'))
})

test('oversized or unterminated response is bounded and rejected', async t => {
  const f = fixture(t, (_, io) => io.stdout.write('x'.repeat(5000)))
  await assert.rejects(runOnce({ ...f.options, method: 'doctor' }), { code: 'DESKPILOT_RESPONSE_TOO_LARGE' })
})

test('pre-cancelled request never spawns', async t => {
  const f = fixture(t)
  await assert.rejects(runOnce({ ...f.options, method: 'doctor', signal: AbortSignal.abort() }), { code: 'DESKPILOT_ABORTED' })
  assert.equal(f.spawns, 0)
})

test('known internal bundle entry rejected; unrelated custom executable retained', t => {
  const root = mkdtempSync(join(tmpdir(), 'deskpilot-entry-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith('deskpilot-entry-')); rmSync(root, { recursive: true, force: true }) })
  const bin = join(root, 'bin'), app = join(bin, 'app'), inner = join(app, 'win-agent.exe')
  mkdirSync(app, { recursive: true }); writeFileSync(inner, '')
  assert.equal(requirePublicExecutable(inner), inner)
  for (const file of ['win-agent.exe', 'ensure-runtime.ps1', 'runtime-download.json']) writeFileSync(join(bin, file), '')
  assert.throws(() => requirePublicExecutable(inner), { code: 'DESKPILOT_INTERNAL_ENTRYPOINT' })
  assert.equal(requirePublicExecutable(join(bin, 'win-agent.exe')), join(bin, 'win-agent.exe'))
  assert.throws(() => requirePublicExecutable('relative.exe'), { code: 'DESKPILOT_EXECUTABLE_NOT_ABSOLUTE' })
})
