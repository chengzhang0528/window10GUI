/** Stable transport failure, separate from a CLI business response. */
export class DeskPilotError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'DeskPilotError'
    this.code = code
    Object.assign(this, extra)
  }
}

const PREFIX = 'DESKPILOT_BOOTSTRAP '
const STDERR_LIMIT = 4096

function drain(stream) {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); stream.off('end', finish); stream.off('close', finish); resolve() }
    const timer = setTimeout(finish, 50)
    stream.once('end', finish)
    stream.once('close', finish)
  })
}

/** Bounded decoded line stream; oversized diagnostic lines cannot become events. */
class Lines {
  constructor(limit, onLine, onOverflow) {
    Object.assign(this, { limit, onLine, onOverflow })
    this.buffer = ''
    this.dropping = false
  }
  push(chunk) {
    for (const [index, part] of chunk.split('\n').entries()) {
      if (index) {
        if (!this.dropping && this.buffer.trim()) this.onLine(this.buffer.replace(/\r$/, ''))
        this.buffer = ''
        this.dropping = false
      }
      if (this.dropping) continue
      if (Buffer.byteLength(this.buffer) + Buffer.byteLength(part) > this.limit) {
        this.buffer = ''
        this.dropping = true
        this.onOverflow?.()
      } else this.buffer += part
    }
  }
  flush() {
    if (!this.dropping && this.buffer.trim()) this.onLine(this.buffer.replace(/\r$/, ''))
    this.buffer = ''
  }
}

/** One process per host session. Only a harmless probe is queued during setup. */
export class DeskPilotClient {
  constructor({ subprocess, executable, cwd, timeoutMs = 130000, setupTimeoutMs = 900000,
    maxLineBytes = 8 * 1024 * 1024, onProgress }) {
    Object.assign(this, { subprocess, executable, cwd, timeoutMs, setupTimeoutMs, maxLineBytes, onProgress })
    this.handle = null
    this.pending = new Map()
    this.counter = 0
    this.dead = false
    this.closing = false
    this.exit = null
    this.runtimeStatus = null
    this.stderr = ''
    this.stderrTruncated = false
    this.preparing = false
    this.ready = null
    this.wasReady = false
  }
  get alive() { return this.handle !== null && !this.dead && !this.closing }
  diagnostics() { return { stderr: this.stderr, stderr_truncated: this.stderrTruncated, runtime_status: this.runtimeStatus } }
  stderrText() { return this.stderr }
  failure(code, message, extra = {}) {
    const detail = this.stderr ? '\n' + (this.stderrTruncated ? '[stderr tail; truncated]\n' : '') + this.stderr : ''
    return new DeskPilotError(code, message + detail, { ...this.diagnostics(), ...extra })
  }
  ensureStarted() {
    if (this.closing || this.dead) throw this.failure('DESKPILOT_SESSION_ENDED', 'session discarded; observe again in a new session')
    if (this.handle) return
    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [this.executable, 'exec', '--stdin', '--format', 'ndjson'], cwd: this.cwd,
        graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      })
    } catch (error) {
      this.dead = true
      throw this.failure('DESKPILOT_SPAWN_FAILED', 'could not start ' + this.executable + ': ' + String(error?.message ?? error))
    }
    this.handle = handle
    handle.stdout?.setEncoding('utf8')
    handle.stderr?.setEncoding('utf8')
    const out = new Lines(this.maxLineBytes, line => this.onLine(line), () => {
      this.rejectAll(this.failure('DESKPILOT_RESPONSE_TOO_LARGE', 'response line exceeded maxLineBytes; narrow the observation'))
      this.abandon()
    })
    const err = new Lines(STDERR_LIMIT, line => this.onRuntimeLine(line))
    handle.stdout?.on('data', chunk => out.push(chunk))
    handle.stdout?.on('end', () => out.flush())
    handle.stderr?.on('data', chunk => {
      const bytes = Buffer.from(this.stderr + chunk)
      if (bytes.length > STDERR_LIMIT) this.stderrTruncated = true
      let start = Math.max(0, bytes.length - STDERR_LIMIT)
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
      this.stderr = bytes.subarray(start).toString('utf8')
      err.push(chunk)
    })
    handle.stderr?.on('end', () => err.flush())
    handle.stdin?.on?.('error', error => {
      this.rejectAll(this.failure('DESKPILOT_WRITE_FAILED', String(error?.message ?? error)))
      this.abandon()
    })
    const exited = async outcome => {
      await Promise.all([drain(handle.stdout), drain(handle.stderr)])
      out.flush(); err.flush(); this.onExit(outcome)
    }
    this.exited = handle.done.then(exited, error => exited({ exitCode: null, signal: null, error }))
  }
  onRuntimeLine(line) {
    if (!line.startsWith(PREFIX)) return
    let event
    try { event = JSON.parse(line.slice(PREFIX.length)) } catch { return }
    if (event.version !== 1 || !Number.isInteger(event.exit_code)) return
    if (event.code === 'DESKPILOT_RUNTIME_PREPARING' && !this.wasReady && !this.runtimeStatus) {
      this.preparing = true
      this.runtimeStatus = event
      this.startupBudget?.setup()
    } else if (event.code === 'DESKPILOT_RUNTIME_READY' && this.preparing) {
      this.preparing = false
      this.runtimeStatus = event
      this.startupBudget?.resume()
    } else if (event.code === 'DESKPILOT_RUNTIME_SETUP_FAILED' && this.preparing) {
      this.preparing = false
      this.runtimeStatus = event
      this.rejectAll(this.failure(event.code, 'runtime preparation failed (exit ' + event.exit_code + '); no business request was sent'))
      this.abandon()
    } else return
    try { this.onProgress?.(event) } catch { /* presentation must not change execution */ }
  }
  onLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    const entry = this.pending.get(message?.request_id)
    if (!entry) return
    this.pending.delete(message.request_id)
    entry.resolve(message)
  }
  rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
  onExit(outcome) {
    this.handle = null
    this.dead = true
    this.exit = { exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null, ...this.diagnostics() }
    this.rejectAll(this.failure(this.wasReady ? 'DESKPILOT_SESSION_ENDED' : 'DESKPILOT_NO_RESPONSE',
      'session exited without the expected response (exit ' + (outcome.exitCode ?? 'unknown') + ')', { exit: this.exit }))
  }
  ensureReady() {
    if (!this.ready) {
      this.ensureStarted()
      this.ready = this.exchange('capabilities', {}, { startup: true }).then(reply => {
        if (reply.ok !== true) {
          this.abandon()
          throw this.failure('DESKPILOT_STARTUP_FAILED', 'capabilities probe failed; no business request was sent')
        }
        this.wasReady = true
      })
    }
    return this.ready
  }
  async request(method, params, options = {}) {
    if (options.signal?.aborted) throw this.failure('DESKPILOT_ABORTED', 'cancelled before any request was sent')
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        const error = this.failure('DESKPILOT_ABORTED', 'cancelled during startup; no business request was sent; an OS installer may still be running')
        this.abandon()
        reject(error)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    try { await Promise.race([this.ensureReady(), aborted]) }
    finally { options.signal?.removeEventListener('abort', onAbort) }
    if (options.signal?.aborted || !this.alive) throw this.failure('DESKPILOT_ABORTED', 'cancelled before the business request was sent')
    return this.exchange(method, params, options)
  }
  exchange(method, params, { signal, timeoutMs = this.timeoutMs, startup = false } = {}) {
    const handle = this.handle
    if (!handle?.stdin) return Promise.reject(this.failure('DESKPILOT_STDIN_UNAVAILABLE', 'session exposes no writable stdin'))
    const id = 'dsh-' + ++this.counter
    return new Promise((resolve, reject) => {
      let timer, onAbort, remaining = timeoutMs, started = Date.now(), settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        if (startup) this.startupBudget = null
        fn(value)
      }
      const entry = { resolve: value => finish(resolve, value), reject: error => finish(reject, error) }
      const arm = (ms, setup) => {
        clearTimeout(timer)
        started = Date.now()
        timer = setTimeout(() => {
          entry.reject(this.failure(setup ? 'DESKPILOT_RUNTIME_SETUP_TIMEOUT' : 'DESKPILOT_TIMEOUT',
            setup ? 'runtime preparation exceeded ' + this.setupTimeoutMs + ' ms; no business request was sent; inspect Windows installation before retrying'
              : 'no response to ' + method + ' within ' + timeoutMs + ' ms; session discarded',
            { method, timeout_ms: setup ? this.setupTimeoutMs : timeoutMs }))
          this.abandon()
        }, Math.max(1, ms))
      }
      if (startup) this.startupBudget = {
        setup: () => { remaining = Math.max(1, remaining - (Date.now() - started)); arm(this.setupTimeoutMs, true) },
        resume: () => arm(remaining, false),
      }
      this.pending.set(id, entry)
      arm(timeoutMs, false)
      if (startup && this.preparing) this.startupBudget.setup()
      onAbort = () => {
        void this.cancelCurrent().catch(() => {})
        entry.reject(this.failure('DESKPILOT_ABORTED', method + ' cancelled; effects already sent are not rolled back', { method }))
        this.abandon()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      try { handle.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n') }
      catch (error) {
        entry.reject(this.failure('DESKPILOT_WRITE_FAILED', String(error?.message ?? error)))
        this.abandon()
      }
    })
  }
  async cancelCurrent() {
    if (this.wasReady && this.alive) this.handle.stdin.write(JSON.stringify({ id: 'dsh-cancel-' + ++this.counter, method: 'interaction.cancel', params: {} }) + '\n')
  }
  abandon() {
    this.closing = true
    this.rejectAll(this.failure('DESKPILOT_SESSION_ENDED', 'session discarded; existing observation references are invalid'))
    if (!this.handle) return
    if (this.preparing) {
      // Do not taskkill the installer's tree. EOF allows bounded setup and the
      // harmless probe to finish. Keep the process tracked until it exits.
      try { this.handle.stdin.end() } catch { /* host owns final teardown */ }
      return
    }
    try { this.handle.terminate() } catch { /* host owns final teardown */ }
  }
  async close() {
    const handle = this.handle
    if (!handle) return
    if (this.preparing) { this.abandon(); return }
    this.closing = true
    this.rejectAll(this.failure('DESKPILOT_SESSION_ENDED', 'session closed'))
    try {
      if (this.wasReady) handle.stdin.write(JSON.stringify({ id: 'dsh-close-' + ++this.counter, method: 'close', params: {} }) + '\n')
      handle.stdin.end()
    } catch { /* fall through to bounded teardown */ }
    let timer
    try {
      const exited = await Promise.race([this.exited.then(() => true, () => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000) })])
      if (!exited) handle.terminate()
    } finally { clearTimeout(timer) }
  }
}

/** Same startup contract for diagnostics, without consuming the agent session. */
export async function runOnce({ method, params, signal, ...options }) {
  const client = new DeskPilotClient(options)
  try { return await client.request(method, params, { signal }) }
  finally { await client.close() }
}
