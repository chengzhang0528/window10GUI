import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import { DeskPilotClient, DeskPilotError } from './client.js'
import { requirePublicExecutable } from './executable.js'
import { prepareAsset } from './artifact.js'

/** Name this service is provided under on `ctx`. */
export const DESKPILOT_SERVICE = 'deskpilot'

/** Methods that must not change the desktop, safe for `deskpilot_run` without approval. */
export const READ_ONLY_METHODS = new Set([
  'capabilities',
  'schema',
  'doctor',
  'windows.list',
  'windows.find',
  'windows.info',
  'observe',
  'ui.tree',
  'ui.find',
  'ui.find_all',
  'ui.get',
  'wait.window',
  'wait.element',
  'screen.capture',
  'screen.capture_window',
  'messages.observe',
  'chrome.ensure',
  'chrome.targets',
  'chrome.query',
  'interaction.status',
])

/** Methods the CLI only accepts as a top-level request. */
export const BATCH_FORBIDDEN_METHODS = new Set(['actions.batch', 'workflow.run', 'close'])

/** Methods whose name alone does not say whether they mutate the desktop. */
export const CONDITIONAL_METHODS = new Set(['chrome.evaluate', 'chrome.wait', 'chrome.attach', 'chrome.navigate'])

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = resolve(HERE, '..')

/**
 * Locate the bundled CLI without being told: the plugin lives inside the
 * DeskPilot package, so the executable is a fixed relative path from here.
 * @returns {string | undefined} absolute path of `win-agent.exe` when present.
 */
export function bundledExecutable() {
  return resolve(CLIENT_DIR, '..', 'bin', 'win-agent.exe')
}

/** The directory a spawned CLI should treat as its working directory. */
export function defaultCwd(executable) {
  const root = dirname(dirname(executable))
  return existsSync(join(root, 'AGENTS.md')) ? root : process.cwd()
}

/**
 * Skill roots this plugin contributes to the deployment's skill catalog.
 *
 * DeskPilot ships its operating method as Agent Skills beside the executable;
 * registering those roots is what makes the model-facing tools usable, because
 * the tools carry the protocol but the skills carry the loop, the failure
 * vocabulary, and the browser recovery sequence.
 * @param {string} base - the DeskPilot package root.
 * @returns {string[]} existing skill directories.
 */
export function skillRoots(base) {
  const roots = [join(base, '.agents', 'skills')]
  return roots.filter((root) => {
    try {
      return statSync(root).isDirectory() && readdirSync(root).length > 0
    } catch {
      return false
    }
  })
}

/**
 * `ctx.deskpilot`: one persistent `win-agent.exe` NDJSON process per agent
 * session, plus the request plumbing the model-facing tools share.
 *
 * The service owns processes, not policy: every method returns the CLI's own
 * structured response (or raises a transport failure), and business meaning
 * stays with the caller.
 */
export class DeskPilotService extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   * @param {object} options - resolved configuration.
   */
  constructor(ctx, options) {
    super(ctx, DESKPILOT_SERVICE)
    this.config = options
    /** @type {Map<string, DeskPilotClient>} */
    this.sessions = new Map()
    this.preparation = null
    this.preparationController = null
    this.diagnostics = new Set()
    this.stopping = false
    this.ctx.effect(() => () => this.disposeAll(), 'deskpilot session teardown')
    ctx.on('session/disposed', (session) => {
      return this.drop(session.id)
    })
  }

  /** @returns {string} the executable every session spawns. */
  get executable() {
    return this.config.command ?? bundledExecutable()
  }

  /** @returns {string} the CLI working directory. */
  get cwd() {
    return this.config.cwd ?? defaultCwd(this.executable)
  }

  /**
   * Describe the resolved launch facts without starting anything.
   * @returns {{executable: string, cwd: string, installed: boolean, skill_roots: string[]}} launch facts.
   */
  describe() {
    const executable = this.executable
    return {
      executable,
      cwd: this.cwd,
      installed: existsSync(executable),
      skill_roots: this.config.skillRoots ?? skillRoots(this.cwd),
      asset_configured: this.config.asset !== undefined,
      preparing_asset: this.preparation !== null,
      preparing_runtime: [...this.sessions.values(), ...this.diagnostics].some(client => client.preparing),
    }
  }

  /**
   * Fail loud before spawning when the executable cannot be resolved.
   * @returns {string} the verified executable path.
   */
  requireExecutable() {
    return requirePublicExecutable(this.executable)
  }

  /** Reuse a configured installation. Download only on explicit use with a pinned asset. */
  async prepare(signal) {
    if (this.stopping) throw new DeskPilotError('DESKPILOT_SESSION_ENDED', 'the plugin is unloading')
    if (signal?.aborted) throw new DeskPilotError('DESKPILOT_ABORTED', 'cancelled before preparing or starting the CLI')
    if (existsSync(this.executable) || !this.config.asset) return this.requireExecutable()
    // An explicit command is an operator choice, not permission to replace it.
    if (this.config.explicitCommand) return this.requireExecutable()
    if (!this.preparation) {
      this.preparationController = new AbortController()
      const preparingSignal = signal ? AbortSignal.any([signal, this.preparationController.signal]) : this.preparationController.signal
      this.preparation = prepareAsset({ asset: this.config.asset, cacheRoot: this.config.cacheRoot,
        subprocess: this.config.subprocess, signal: preparingSignal }).then(executable => {
        if (preparingSignal.aborted || this.stopping) throw new DeskPilotError('DESKPILOT_ABORTED', 'plugin unloaded before the prepared CLI was selected')
        this.config.command = executable
        if (!this.config.explicitCwd) this.config.cwd = defaultCwd(executable)
        this.config.onPrepared?.(dirname(dirname(executable)))
        return executable
      }).finally(() => { this.preparation = null; this.preparationController = null })
    }
    await this.preparation
    if (signal?.aborted) throw new DeskPilotError('DESKPILOT_ABORTED', 'cancelled before starting the CLI')
    return this.requireExecutable()
  }

  /**
   * Resolve (and start) the client owned by one agent session.
   * @param {string} key - owning session id.
   * @returns {DeskPilotClient} the live client.
   */
  client(key) {
    const existing = this.sessions.get(key)
    if (existing?.closing && existing.handle) {
      throw new DeskPilotError('DESKPILOT_SESSION_CLOSING', 'the previous session is still finishing runtime setup or teardown; no new process was started', existing.diagnostics())
    }
    if (existing !== undefined && existing.alive) return existing
    existing?.abandon()
    const client = new DeskPilotClient({
      subprocess: this.config.subprocess,
      executable: this.requireExecutable(),
      cwd: this.cwd,
      timeoutMs: this.config.timeoutMs,
      setupTimeoutMs: this.config.setupTimeoutMs,
      maxLineBytes: this.config.maxLineBytes,
    })
    this.sessions.set(key, client)
    return client
  }

  /**
   * Send one request on one agent session's persistent process.
   * @param {string} key - owning session id.
   * @param {string} method - public CLI method.
   * @param {object} params - method parameters.
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cancellation and budget override.
   * @returns {Promise<object>} the CLI's raw response.
   */
  async request(key, method, params, options = {}) {
    await this.prepare(options.signal)
    return this.client(key).request(method, params, options)
  }

  /**
   * Report one session's process state without starting one.
   * @param {string} key - owning session id.
   * @returns {object} a snapshot safe to hand to a model.
   */
  state(key) {
    const client = this.sessions.get(key)
    return {
      session: key,
      running: client !== undefined && client.alive,
      pending_requests: client === undefined ? 0 : client.pending.size,
      last_exit: client?.exit ?? null,
      runtime_status: client?.runtimeStatus ?? [...this.diagnostics].find(diagnostic => diagnostic.preparing)?.runtimeStatus ?? null,
      closing: client?.closing ?? false,
      ...this.describe(),
    }
  }

  /**
   * Drop one session's process.
   * @param {string} key - owning session id.
   * @returns {Promise<boolean>} whether a process was closed.
   */
  async drop(key) {
    const client = this.sessions.get(key)
    if (client === undefined) return false
    await client.close()
    if (!client.handle) this.sessions.delete(key)
    return true
  }

  /** Close every owned process; called when the plugin fiber unloads. */
  async disposeAll() {
    this.stopping = true
    this.preparationController?.abort()
    await this.preparation?.catch(() => {})
    const clients = [...this.sessions.values(), ...this.diagnostics]
    this.sessions.clear()
    await Promise.allSettled(clients.map((client) => client.close()))
  }

  /**
   * Run `doctor` on a throwaway process, so a diagnostic never disturbs the ids
   * a live session holds.
   * @param {{signal?: AbortSignal}} [options] - cancellation.
   * @returns {Promise<object>} the doctor response.
   */
  async doctor(options = {}) {
    await this.prepare(options.signal)
    const client = new DeskPilotClient({
      subprocess: this.config.subprocess,
      executable: this.requireExecutable(),
      cwd: this.cwd,
      timeoutMs: this.config.doctorTimeoutMs,
      setupTimeoutMs: this.config.setupTimeoutMs,
      maxLineBytes: this.config.maxLineBytes,
    })
    this.diagnostics.add(client)
    try { return await client.request('doctor', {}, { signal: options.signal }) }
    finally {
      await client.close()
      if (!client.handle) this.diagnostics.delete(client)
      else void client.exited.then(() => this.diagnostics.delete(client), () => this.diagnostics.delete(client))
    }
  }
}
