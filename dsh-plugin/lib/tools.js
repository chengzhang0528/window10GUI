/**
 * Model-facing DeskPilot tools.
 *
 * Four tools, one contract: the model speaks DeskPilot's own public NDJSON
 * protocol (`{ method, params }`) and reads the CLI's own structured response.
 * Nothing here reinterprets a business result, retries a mutating batch, or
 * guesses a selector — that is exactly the split the DeskPilot product
 * contract draws between its execution base and the calling agent.
 * @module dsh-plugin-deskpilot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DeskPilotError } from './client.js'
import { READ_ONLY_METHODS, BATCH_FORBIDDEN_METHODS } from './service.js'

/** How many steps one `deskpilot_batch` call forwards. Mirrors the CLI's own cap. */
export const MAX_STEPS = 32

/** Rendered result text budget, so one huge observation cannot flood the turn. */
const TEXT_LIMIT = 60000

/** @type {import('@deepseek-ai/dsh-tools').ValueSchemaSpec} */
const RESPONSE_SCHEMA = { type: 'json' }

/**
 * Build the canonical value every DeskPilot tool answers with.
 * @param {string} kind - which call produced the value.
 * @param {object} response - the raw CLI response.
 * @returns {object} a bounded, JSON-safe value.
 */
function responseValue(kind, response) {
  const value = response === null || typeof response !== 'object' ? { raw: response } : response
  return { kind, reply: value }
}

/**
 * Render one canonical value, truncating only the *text* projection.
 * @param {object} value - the canonical value.
 * @returns {Array<{type: 'text', text: string}>} model content.
 */
function renderValue(_args, value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch (error) {
    text = JSON.stringify({ kind: value?.kind ?? 'deskpilot', error: `response was not serializable: ${String(error?.message ?? error)}` })
  }
  if (typeof text !== 'string') text = JSON.stringify({ kind: value?.kind ?? 'deskpilot' })
  if (text.length > TEXT_LIMIT) {
    text = `${text.slice(0, TEXT_LIMIT)}\n… [truncated ${text.length - TEXT_LIMIT} characters; re-read the specific field with a narrower request]`
  }
  return [{ type: 'text', text }]
}

const OUTPUT = { schema: RESPONSE_SCHEMA, render: renderValue }

/**
 * Generic pending presentation shared by every DeskPilot tool.
 * @param {string} title - card header.
 * @param {string} kind - presentation category.
 * @param {unknown} [rawInput] - salient input for the expanded view.
 * @returns {object} a `generic` call view.
 */
function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/**
 * Refuse a mutating request on the read-only tool, so the two tools keep
 * different privileges instead of the same tool with different prose.
 * @param {string} method - requested CLI method.
 */
function assertReadOnly(method) {
  if (READ_ONLY_METHODS.has(method)) return
  throw new DeskPilotError(
    'DESKPILOT_MUTATING_METHOD',
    `${method} is not on deskpilot_run's read-only method list; send it with deskpilot_batch (which requires a stated reason and the user's approval when the session asks)`,
    { method },
  )
}

/**
 * @param {object} ctx - the plugin context.
 * @param {object} config - resolved plugin config.
 * @param {number} config.timeoutMs - per-request budget.
 * @returns {number} how many tools were registered.
 */
export function registerTools(ctx, config) {
  const service = () => ctx.deskpilot
  const keyOf = (exec) => exec.agent?.session?.id
  const requireAgent = (exec) => {
    const key = keyOf(exec)
    if (key === undefined) throw new DeskPilotError('DESKPILOT_AGENT_REQUIRED', 'DeskPilot tools drive one desktop session, so they need a calling agent')
    return key
  }

  ctx.tools.register(defineTool({
    name: 'deskpilot_doctor',
    description: [
      'Report whether this machine can be automated by DeskPilot right now: Windows build, interactive desktop, UI Automation, SendInput, trusted screen capture, the offline OCR backend and its language, Chrome executable plus any reachable CDP endpoint, DPI, and virtual-screen bounds.',
      'Run it before the first desktop operation of a task, or when an operation fails in a way that suggests the environment changed. It does not touch the driver session or operate desktop applications. First use may download the configured portable bundle and prepare the Microsoft runtime, requiring network and Windows UAC.',
    ].join(' '),
    parameters: {},
    output: OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: () => present('Check DeskPilot environment', 'read'),
    async execute(_args, exec) {
      const launch = service().describe()
      if (!launch.installed && !launch.asset_configured) {
        return responseValue('doctor', {
          ok: false,
          error: {
            code: 'DESKPILOT_EXECUTABLE_MISSING',
            message: `win-agent.exe was not found at ${launch.executable}`,
            retryable: false,
          },
          launch,
        })
      }
      try {
        const response = await service().doctor({ signal: exec.signal })
        return responseValue('doctor', { launch: service().describe(), response })
      } catch (error) {
        return responseValue('doctor', {
          ok: false,
          launch,
          error: { code: error?.code ?? 'DESKPILOT_DOCTOR_FAILED', message: String(error?.message ?? error), retryable: true,
            stderr: error?.stderr, stderr_truncated: error?.stderr_truncated, runtime_status: error?.runtime_status },
        })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deskpilot_run',
    description: [
      'Send ONE read-only DeskPilot request to this agent\'s persistent win-agent session and return the CLI\'s own structured response.',
      `Read-only methods only: ${[...READ_ONLY_METHODS].join(', ')}.`,
      'This is the observation half of the loop: activate and observe a window or the Chrome page, wait for a control or a page condition, read a control\'s value, capture a screenshot with an explicit absolute `path` when it must outlive the call, or read visible message candidates with `messages.observe`.',
      'The session is a process, not a transaction: `window_id`, `observation_id`, `element_id` and `screenshot_id` from a response stay valid only while this same session keeps running, and a new observation invalidates earlier element references. For anything that types, clicks, submits, navigates or selects, use deskpilot_batch instead.',
    ].join(' '),
    parameters: {
      method: { type: 'string', required: true, description: 'Exact public DeskPilot method, e.g. `observe`, `ui.find`, `wait.element`, `chrome.ensure`, `chrome.wait`, `chrome.query`, `screen.capture`, `messages.observe`.' },
      params: { type: 'json', description: 'Parameters for that method, exactly as DeskPilot documents them. Defaults to `{}`.' },
      timeout_ms: { type: 'integer', description: `Budget for this request. Defaults to the plugin's configured ${Math.round(config.timeoutMs / 1000)} s.` },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: (args) => present(`DeskPilot ${args.method}`, 'read', args.method),
    async execute(args, exec) {
      const key = requireAgent(exec)
      assertReadOnly(args.method)
      const response = await service().request(key, args.method, args.params ?? {}, {
        signal: exec.signal,
        timeoutMs: args.timeout_ms,
      })
      return responseValue('run', response)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deskpilot_batch',
    description: [
      'Run the desktop-changing half of a DeskPilot task: send one `actions.batch` (or one `workflow.run`) carrying up to 32 ordered steps, so a known sequence — fill several fields, select, click, then read the result back — costs one model round trip and one activity lease instead of many.',
      'Each step is `{ step_id, method, params }` and may reach any public DeskPilot method except `actions.batch`, `workflow.run` and `close`; earlier steps are referenced with `{"$ref": "<step_id>.result.<field>"}`. `reason` is required and is shown to the user when the session asks for approval.',
      'Steps are NOT a transaction: the first error stops the batch, and a `BATCH_OUTCOME_UNKNOWN` result means a change may already have reached Windows, so re-observe instead of replaying the batch. An input event is never proof of business success — end the batch with a read or wait step that checks the actual result.',
    ].join(' '),
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: `Ordered steps, at most ${MAX_STEPS}. Each is \`{ step_id, method, params }\`; \`step_id\` must be unique and \`params\` is optional.`,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            step_id: { type: 'string', required: true, description: 'Stable id used by later `$ref` references.' },
            method: { type: 'string', required: true, description: 'Public DeskPilot method for this step.' },
            params: { type: 'json', description: 'Parameters for this step.' },
          },
        },
      },
      reason: { type: 'string', required: true, description: 'What this batch does on the desktop and what its result is checked against; shown to the user on approval.' },
      activity_label: { type: 'string', description: 'Short label shown in the on-screen DeskPilot status panel while the batch runs.' },
      show_action_trace: { type: 'boolean', description: 'Draw the synthetic pointer and target highlight so the user can watch the steps. It never moves the real cursor.' },
      restore_original_window: { type: 'boolean', description: 'Restore the window that was in front before the batch. Defaults to DeskPilot\'s own behaviour.' },
      timeout_ms: { type: 'integer', description: `Budget for the whole batch. Defaults to the plugin's configured ${Math.round(config.timeoutMs / 1000)} s.` },
    },
    output: OUTPUT,
    presentCall: (args) => present(`DeskPilot batch (${Array.isArray(args.steps) ? args.steps.length : 0} steps)`, 'other', args.reason),
    async execute(args, exec) {
      const key = requireAgent(exec)
      const steps = args.steps
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new DeskPilotError('DESKPILOT_INVALID_BATCH', 'deskpilot_batch needs at least one step')
      }
      if (steps.length > MAX_STEPS) {
        throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `a DeskPilot batch accepts at most ${MAX_STEPS} steps, got ${steps.length}`)
      }
      const seen = new Set()
      for (const [index, step] of steps.entries()) {
        const label = `step ${index + 1}`
        if (step === null || typeof step !== 'object') throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `${label} is not an object`)
        if (typeof step.step_id !== 'string' || step.step_id.length === 0) throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `${label} needs a non-empty step_id`)
        if (seen.has(step.step_id)) throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `${label} reuses step_id ${JSON.stringify(step.step_id)}`)
        seen.add(step.step_id)
        if (typeof step.method !== 'string' || step.method.length === 0) throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `${label} needs a non-empty method`)
        if (BATCH_FORBIDDEN_METHODS.has(step.method)) {
          throw new DeskPilotError('DESKPILOT_INVALID_BATCH', `${step.method} cannot be nested in a batch`)
        }
      }
      const params = { actions: steps }
      if (args.activity_label !== undefined) params.activity_label = args.activity_label
      if (args.show_action_trace !== undefined) params.show_action_trace = args.show_action_trace
      if (args.restore_original_window !== undefined) params.restore_original_window = args.restore_original_window
      const response = await service().request(key, 'actions.batch', params, {
        signal: exec.signal,
        timeoutMs: args.timeout_ms,
      })
      return responseValue('batch', response)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deskpilot_session',
    description: [
      'Inspect or end the driver session the DeskPilot tools use, and see whether it is still holding live `window_id`/`observation_id`/`element_id` references.',
      '`status` reports the executable, working directory, whether the process is running, how many requests are outstanding, and how the previous process exited — use it after an operation failed unexpectedly, because a restarted process means every earlier reference must be reacquired.',
      '`reset` ends the process and discards those references; the next call starts a clean session once teardown completes. It does not request Chrome shutdown, but the host may reclaim descendant processes. Use `interaction.end` to release an activity lease and `close` to end the CLI session.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'reset'], description: '`status` reads the session, `reset` ends it.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: (args) => present(args.action === 'reset' ? 'Reset DeskPilot session' : 'DeskPilot session status', args.action === 'reset' ? 'other' : 'read'),
    async execute(args, exec) {
      const key = requireAgent(exec)
      if (args.action === 'status') {
        return responseValue('session', { action: 'status', ...service().state(key) })
      }
      await service().drop(key)
      const state = service().state(key)
      return responseValue('session', { action: 'reset', ...state, closed: !state.closing && !state.running })
    },
  }))

  const names = ['deskpilot_doctor', 'deskpilot_run', 'deskpilot_batch', 'deskpilot_session']
  if (config.report !== undefined) config.report.tools = { registered: names.length, names }
  return names.length
}
