import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_ARGS = ['exec', '--stdin', '--format', 'ndjson'];
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_RECENT = 100;

/** An error returned by the DeskPilot protocol or by its process boundary. */
export class TransportError extends Error {
  constructor(code, message, details, options = {}) {
    super(message || code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.code = code || 'TRANSPORT_ERROR';
    if (details !== undefined) this.details = details;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryable !== undefined) this.retryable = options.retryable;
  }
}

function errorFromUnknown(error, fallbackCode, fallbackMessage, requestId) {
  if (error instanceof TransportError) return error;
  return new TransportError(fallbackCode, `${fallbackMessage}: ${error?.message || String(error)}`, undefined, {
    requestId,
    cause: error
  });
}

function deadlineError(requestId, timeoutMs) {
  return new TransportError(
    'DEADLINE_EXCEEDED',
    `Request exceeded its ${timeoutMs} ms deadline.`,
    undefined,
    { requestId }
  );
}

/**
 * Small NDJSON transport for a single owned win-agent process.
 *
 * The process is deliberately kept behind a narrow request/result API. The
 * metadata getters are snapshots and contain method/id/timing only; params
 * and stderr never leave this object.
 */
export class DeskPilotTransport {
  constructor({ executable, args = DEFAULT_ARGS, spawnImpl = nodeSpawn, execFileImpl = nodeExecFile, onSpawn } = {}) {
    if (typeof executable !== 'string' || executable.length === 0) {
      throw new TypeError('executable is required');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('args must be an array of strings');
    }
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    if (typeof execFileImpl !== 'function') throw new TypeError('execFileImpl must be a function');
    if (onSpawn !== undefined && typeof onSpawn !== 'function') throw new TypeError('onSpawn must be a function');

    this._closed = false;
    this._closing = false;
    this._sequence = 0;
    this._pending = new Map();
    this._recent = [];
    this._completed = new Set();
    this._writeQueue = [];
    this._writing = false;
    this._lineBuffer = '';
    this._stderr = '';
    this._processEnded = false;
    this._treeTerminated = false;
    this._treeKillPromise = null;
    this._processEndError = null;
    this._fatalError = null;
    this._closeAcknowledged = false;
    this._closeResult = null;
    this._closePromise = null;
    this._lifecycleErrors = [];
    this._exitResolve = null;
    this._exitPromise = new Promise((resolve) => { this._exitResolve = resolve; });

    try {
      this._child = spawnImpl(executable, [...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      throw errorFromUnknown(error, 'EXECUTOR_LOST', 'Unable to start executor');
    }
    if (!this._child || !this._child.stdin || !this._child.stdout) {
      throw new TransportError('EXECUTOR_LOST', 'Executor did not provide piped stdin/stdout.');
    }

    this._pid = Number.isInteger(this._child.pid) ? this._child.pid : undefined;
    this._execFile = execFileImpl;
    try { onSpawn?.({ pid: this._pid, child: this._child }); } catch { /* supervisor hooks cannot break transport setup */ }
    this._setEncoding(this._child.stdout);
    this._setEncoding(this._child.stderr);
    this._child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._child.stdout.on('end', () => this._onStdoutEnd());
    if (this._child.stderr?.on) {
      this._child.stderr.on('data', (chunk) => this._onStderr(chunk));
      this._child.stderr.on('end', () => {});
    }
    if (this._child.on) {
      this._child.on('error', (error) => this._onProcessError(error));
      this._child.on('exit', (code, signal) => this._onProcessExit(code, signal));
      this._child.on('close', (code, signal) => this._onProcessClose(code, signal));
    }
  }

  _setEncoding(stream) {
    try { stream?.setEncoding?.('utf8'); } catch { /* fake streams may omit encoding */ }
  }

  get closed() { return this._closed; }

  get pid() { return this._pid; }

  /** Snapshot of in-flight request metadata. */
  get pending() {
    return new Map([...this._pending].map(([id, entry]) => [id, this._metadata(entry)]));
  }

  /** Snapshot of the bounded request history. */
  get recent() { return this._recent.map((entry) => ({ ...entry })); }

  get pendingCount() { return this._pending.size; }

  _metadata(entry) {
    return {
      requestId: entry.id,
      method: entry.method,
      startedAt: entry.startedAt,
      dispatched: entry.dispatched,
      timedOut: entry.timedOut,
      status: entry.status
    };
  }

  _remember(entry, status, error) {
    entry.status = status;
    entry.finishedAt = Date.now();
    if (entry.timer) clearTimeout(entry.timer);
    const metadata = {
      requestId: entry.id,
      method: entry.method,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      status
    };
    if (error?.code) metadata.errorCode = error.code;
    this._recent.push(metadata);
    if (this._recent.length > MAX_RECENT) this._recent.splice(0, this._recent.length - MAX_RECENT);
  }

  _newId() {
    try { return `dp-${randomUUID()}`; } catch { return `dp-${++this._sequence}`; }
  }

  _markCompleted(id) {
    this._completed.add(id);
    if (this._completed.size > MAX_RECENT) {
      const oldest = this._completed.values().next().value;
      if (oldest !== undefined) this._completed.delete(oldest);
    }
  }

  request(method, params = {}, { timeoutMs = 10_000 } = {}) {
    if (typeof method !== 'string' || method.trim() === '') {
      return Promise.reject(new TransportError('INVALID_REQUEST', 'method must be a non-empty string.'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new TransportError('INVALID_REQUEST', 'timeoutMs must be a non-negative number.'));
    }
    if (this._fatalError) return Promise.reject(this._fatalError);
    if (this._processEndError) return Promise.reject(this._processEndError);
    if (this._closed || this._closing) {
      return Promise.reject(new TransportError('TRANSPORT_CLOSED', 'The DeskPilot transport is closed.'));
    }

    const id = this._newId();
    let line;
    try {
      line = JSON.stringify({ id, method, params: params === undefined ? {} : params });
    } catch (error) {
      return Promise.reject(errorFromUnknown(error, 'INVALID_REQUEST', 'Unable to encode request', id));
    }
    if (line === undefined) return Promise.reject(new TransportError('INVALID_REQUEST', 'Request is not JSON-serializable.', undefined, { requestId: id }));

    const entry = {
      id, method, startedAt: Date.now(), dispatched: false, writeStarted: false, timedOut: false, status: 'pending',
      resolve: null, reject: null, timer: null
    };
    const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    this._pending.set(id, entry);
    entry.timer = setTimeout(() => {
      if (!this._pending.has(id) || entry.timedOut) return;
      entry.timedOut = true;
      this._remember(entry, 'timed_out');
      entry.reject(deadlineError(id, timeoutMs));
      if (!entry.writeStarted && !entry.dispatched) {
        const queued = this._writeQueue.findIndex((item) => item.entry === entry);
        if (queued >= 0) {
          this._writeQueue.splice(queued, 1);
          this._pending.delete(id);
          this._markCompleted(id);
        }
      }
      // Keep an entry only while a write may already be in flight; a queued
      // request that never reached stdin cannot produce a valid response.
    }, timeoutMs);
    this._writeQueue.push({ entry, line: `${line}\n` });
    this._pumpWrites();
    return promise;
  }

  _pumpWrites() {
    if (this._writing || this._writeQueue.length === 0) return;
    const item = this._writeQueue.shift();
    if (!item) return;
    this._writing = true;
    item.entry.writeStarted = true;
    const finish = (error) => {
      if (!this._writing) return;
      this._writing = false;
      const { entry } = item;
      if (error) {
        this._writeQueue.length = 0;
        this._failTransport(errorFromUnknown(error, 'EXECUTOR_LOST', 'Unable to write request', entry.id));
      } else {
        entry.dispatched = true;
        if (entry.status === 'pending') entry.status = 'dispatched';
        this._pumpWrites();
      }
    };
    try {
      const callback = (error) => finish(error || null);
      const result = this._child.stdin.write(item.line, 'utf8', callback);
      // A few test doubles do not invoke the Writable callback. Native
      // Writable streams always do, but accepting a true return keeps the
      // seam useful for tiny fakes without changing real stream semantics.
      if (result === undefined && this._child.stdin.write.length < 3) queueMicrotask(() => finish(null));
    } catch (error) {
      finish(error);
    }
  }

  _onStdout(chunk) {
    if (this._processEnded) return;
    this._lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(this._lineBuffer, 'utf8') > MAX_LINE_BYTES) {
      this._failTransport(new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Executor response exceeds the maximum line size.'));
      return;
    }
    let newline;
    while ((newline = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, newline).replace(/\r$/, '');
      this._lineBuffer = this._lineBuffer.slice(newline + 1);
      if (line.trim() !== '') this._handleLine(line);
    }
  }

  _onStdoutEnd() {
    if (this._lineBuffer.trim() !== '') {
      this._failTransport(new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Executor ended with an incomplete NDJSON response.'));
    }
  }

  _onStderr(chunk) {
    this._stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(this._stderr, 'utf8') > MAX_STDERR_BYTES) {
      this._stderr = this._stderr.slice(-MAX_STDERR_BYTES);
    }
  }

  _handleLine(line) {
    let envelope;
    try { envelope = JSON.parse(line); } catch (error) {
      this._failTransport(errorFromUnknown(error, 'EXECUTOR_PROTOCOL_ERROR', 'Executor returned malformed JSON'));
      return;
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.ok !== 'boolean') {
      this._failTransport(new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Executor returned an invalid response envelope.'));
      return;
    }
    const rawId = envelope.request_id;
    const id = typeof rawId === 'string' ? rawId : (typeof rawId === 'number' ? String(rawId) : null);
    if (!id) {
      this._failTransport(new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Executor response is missing request_id.'));
      return;
    }
    const entry = this._pending.get(id);
    if (!entry) {
      const reason = this._completed.has(id) || this._recent.some((item) => item.requestId === id)
        ? 'Executor returned a duplicate result.'
        : 'Executor returned a result for an unknown request.';
      this._failTransport(new TransportError('EXECUTOR_PROTOCOL_ERROR', reason, { requestId: id }));
      return;
    }
    this._pending.delete(id);
    this._markCompleted(id);
    if (entry.timedOut) {
      this._remember(entry, 'late_result');
      return;
    }
    if (envelope.ok) {
      if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
        const error = new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Successful response is missing result.', undefined, { requestId: id });
        this._remember(entry, 'failed', error);
        entry.reject(error);
      } else {
        if (entry.method === 'close') this._closeAcknowledged = true;
        this._remember(entry, 'succeeded');
        entry.resolve(envelope.result);
      }
      return;
    }
    const body = envelope.error;
    if (!body || typeof body !== 'object' || typeof body.code !== 'string' || body.code.length === 0) {
      const error = new TransportError('EXECUTOR_PROTOCOL_ERROR', 'Failed response is missing error.code.', undefined, { requestId: id });
      this._remember(entry, 'failed', error);
      entry.reject(error);
      return;
    }
    const error = new TransportError(body.code, typeof body.message === 'string' ? body.message : body.code,
      body.details, { requestId: id, retryable: body.retryable });
    this._remember(entry, 'failed', error);
    entry.reject(error);
  }

  _onProcessError(error) {
    const transportError = errorFromUnknown(error, 'EXECUTOR_LOST', 'Executor process failed');
    this._processEndError = transportError;
    this._failTransport(transportError);
    this._beginTreeKill();
  }

  _onProcessExit(code, signal) {
    if (this._processEnded) return;
    this._processEnded = true;
    const graceful = this._closing && (code === 0 || code === null);
    if (graceful) this._treeTerminated = true;
    if (!this._processEndError && !graceful) {
      this._processEndError = new TransportError('EXECUTOR_LOST', `Executor exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
      this._failTransport(this._processEndError);
      this._beginTreeKill();
    }
    // Even a graceful close must settle requests that never received a
    // response; otherwise callers can retain a promise forever after EOF.
    if (this._pending.size > 0) {
      const error = this._processEndError || new TransportError('EXECUTOR_LOST', 'Executor closed before responding.');
      this._lifecycleErrors.push(error.code);
      this._failTransport(error);
    }
    this._exitResolve?.();
  }

  _onProcessClose(code, signal) {
    this._onProcessExit(code, signal);
  }

  _failTransport(error) {
    if (!(error instanceof TransportError)) error = errorFromUnknown(error, 'EXECUTOR_LOST', 'Executor transport failed');
    if (error.code === 'EXECUTOR_PROTOCOL_ERROR') this._fatalError = error;
    if (!this._processEndError && error.code === 'EXECUTOR_LOST') this._processEndError = error;
    for (const entry of [...this._pending.values()]) {
      this._pending.delete(entry.id);
      if (entry.status !== 'timed_out') this._remember(entry, 'failed', error);
      entry.reject(error);
    }
  }

  async _sendInternal(method, params, timeoutMs) {
    const wasClosing = this._closing;
    this._closing = false;
    try { return await this.request(method, params, { timeoutMs }); }
    finally { this._closing = wasClosing; }
  }

  async close({ cancel = true, timeoutMs = 3000 } = {}) {
    if (this._closePromise) return this._closePromise;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a non-negative number');
    }
    this._closing = true;
    this._closePromise = this._performClose(Boolean(cancel), timeoutMs);
    return this._closePromise;
  }

  async _performClose(cancel, timeoutMs) {
    const errors = [...this._lifecycleErrors];
    if (this._processEndError) errors.push(this._processEndError.code);
    if (this._fatalError) errors.push(this._fatalError.code);
    const started = Date.now();
    const left = () => Math.max(0, timeoutMs - (Date.now() - started));
    // Keep a bounded force-termination window inside the caller's total
    // deadline; graceful cancel/close must not consume all of it.
    const killReserve = Math.min(1000, Math.floor(timeoutMs / 2));
    const gracefulDeadline = started + timeoutMs - killReserve;
    const gracefulLeft = () => Math.max(0, gracefulDeadline - Date.now());
    const record = (error) => { if (error) errors.push(error.code || error.message || String(error)); };
    if (cancel && gracefulLeft() > 0) {
      try { await this._sendInternal('interaction.cancel', {}, gracefulLeft()); }
      catch (error) { record(error); }
    }
    if (!this._processEnded && gracefulLeft() > 0) {
      try { await this._sendInternal('close', {}, gracefulLeft()); }
      catch (error) { record(error); }
    }
    let quiescent = await this._waitForExit(gracefulLeft());
    if (!quiescent || !this._treeTerminated) {
      const killed = await this._killOwnedTree(left());
      if (!killed) record(new TransportError('EXECUTOR_LOST', 'Unable to confirm executor process-tree termination.'));
      quiescent = await this._waitForExit(left());
    }
    quiescent = quiescent && this._treeTerminated;
    if (!quiescent) record(new TransportError('DEADLINE_EXCEEDED', 'Executor did not become quiescent before close deadline.'));
    this._closed = true;
    this._closing = false;
    const result = { quiescent, errors: [...new Set(errors)] };
    this._closeResult = result;
    if (!quiescent) this._failTransport(new TransportError('EXECUTOR_LOST', 'Executor remains active after close.'));
    return result;
  }

  async _waitForExit(ms) {
    if (this._processEnded) return true;
    if (ms <= 0) return false;
    let timer;
    try {
      await Promise.race([this._exitPromise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this._processEnded;
  }

  async _killOwnedTree(ms) {
    if (!this._treeKillPromise) {
      // Defer invocation one microtask so synchronous test doubles and child
      // exit callbacks cannot re-enter tree termination before the promise is
      // visible to _beginTreeKill().
      this._treeKillPromise = Promise.resolve().then(() => this._killOwnedTreeNow(ms)).catch(() => false);
    }
    if (ms <= 0) return false;
    let timer;
    try {
      return await Promise.race([
        this._treeKillPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _beginTreeKill() {
    if (this._treeKillPromise || this._treeTerminated) return;
    // Do not wait for close() to begin this cleanup: an executor can emit an
    // unexpected exit while its child helper is still alive.
    this._treeKillPromise = Promise.resolve().then(() => this._killOwnedTreeNow(3000)).catch(() => false);
  }

  async _killOwnedTreeNow(ms) {
    if (this._treeTerminated) return true;
    if (process.platform === 'win32' && this._pid) {
      // Once the parent has exited, taskkill cannot prove that descendants
      // belonging to this transport have exited too.
      if (this._processEnded) return false;
      let finished = false;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, ms));
        this._execFile('taskkill', ['/PID', String(this._pid), '/T', '/F'], { windowsHide: true, shell: false }, (error) => {
          finished = !error;
          clearTimeout(timer);
          resolve();
        });
      });
      if (finished) this._treeTerminated = true;
      return finished && this._processEnded;
    }
    try { this._child.kill?.(); } catch { return false; }
    const exited = await this._waitForExit(ms);
    if (exited) this._treeTerminated = true;
    return exited;
  }
}
