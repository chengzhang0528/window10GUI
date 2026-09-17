/**
 * Human-facing slash commands over the same DeskPilot session the tools use.
 *
 * A command runs directly against the receiving agent and its settled result is
 * rendered by the dispatching UI — it never becomes a model message and costs no
 * model turn. That makes these the right surface for the questions a human asks
 * repeatedly: is this machine drivable, is the session still alive, what is on
 * screen, and give me a clean session.
 *
 * The grammar is deliberately tiny and every failure is a plain sentence, because
 * the text is what the user reads in the composer.
 * @module dsh-plugin-deskpilot/commands
 */

/** Subcommands shared by every name this module registers. */
export const SUBCOMMANDS = ['status', 'doctor', 'windows', 'reset', 'help']

/** Longest a command result may be before it is clipped. */
const TEXT_LIMIT = 3500

/**
 * Wrap one settled outcome.
 * @param {string} text - what the user reads.
 * @returns {{kind: 'success', text: string}} a success result.
 */
function ok(text) {
  return { kind: 'success', text: clip(text) }
}

/**
 * Wrap one failure.
 * @param {string} text - what the user reads.
 * @returns {{kind: 'error', text: string}} an error result.
 */
function fail(text) {
  return { kind: 'error', text: clip(text) }
}

/**
 * Keep a result readable inside the composer.
 * @param {string} text - rendered text.
 * @returns {string} the same text, clipped when it is very long.
 */
function clip(text) {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… [clipped ${text.length - TEXT_LIMIT} characters]` : text
}

/**
 * Render aligned `name: value` lines.
 * @param {Array<[string, unknown]>} rows - label/value pairs.
 * @returns {string} one line per row.
 */
function lines(rows) {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0)
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value === undefined ? '-' : String(value)}`).join('\n')
}

/**
 * Turn a CLI failure into one sentence a human can act on.
 * @param {object} response - the CLI response.
 * @returns {string} the message.
 */
function errorText(response) {
  const error = response?.error
  if (error === undefined || error === null) return 'the request failed without a structured error'
  return `${error.code ?? 'ERROR'}${error.retryable === true ? ' (retryable)' : ''}: ${error.message ?? 'no message'}`
}

/**
 * The environment section, shared by `status` and `doctor`.
 * @param {object} launch - `ctx.deskpilot.describe()`.
 * @returns {Array<[string, unknown]>} label/value rows.
 */
function environmentRows(launch) {
  return [
    ['CLI', launch.executable],
    ['working dir', launch.cwd],
    ['installed', launch.installed ? 'yes' : 'NO — set the row\'s `command` to bin\\win-agent.exe'],
    ['preparing', launch.preparing_asset ? 'portable asset' : launch.preparing_runtime ? 'Microsoft runtime (UAC may need attention)' : 'no'],
    ['skills', launch.skill_roots.length === 0 ? 'none contributed' : launch.skill_roots.join(', ')],
  ]
}

/**
 * Render the driver session's current state.
 * @param {object} deskpilot - the DeskPilot service.
 * @param {string} key - the calling session id.
 * @returns {string} rendered text.
 */
function renderStatus(deskpilot, key) {
  const state = deskpilot.state(key)
  const exit = state.last_exit
  return [
    'DeskPilot session',
    '',
    lines([
      ...environmentRows(state),
      ['process', state.closing ? 'closing (runtime installation may still be finishing)' : state.running ? `running (${state.pending_requests} outstanding)` : 'not started (starts on the next request)'],
      ['runtime', state.runtime_status?.code ?? 'no bootstrap requested'],
      ['last exit', exit === null ? '-' : `code ${exit.exitCode ?? 'null'}${exit.signal ? `, signal ${exit.signal}` : ''}`],
    ]),
    '',
    'The process starts on the first request and is reused until it ends. Every window_id,',
    'observation_id, element_id and screenshot_id is valid only inside it — after a restart,',
    're-observe instead of reusing them.',
  ].join('\n')
}

/**
 * Run `doctor` and render the readiness facts.
 * @param {object} deskpilot - the DeskPilot service.
 * @returns {Promise<string>} rendered text.
 */
async function renderDoctor(deskpilot, signal) {
  const response = await deskpilot.doctor({ signal })
  if (response?.ok !== true) {
    return `DeskPilot environment\n\n${errorText(response)}`
  }
  const result = response.result
  const chrome = result.chrome ?? {}
  const reachable = (chrome.probes ?? []).filter((probe) => probe.available)
  return [
    'DeskPilot environment',
    '',
    lines([
      ['OS', `${result.os} (${result.architecture})`],
      ['interactive desktop', result.interactive_desktop ? 'yes' : 'NO'],
      ['UI Automation', result.ui_automation?.available ? 'available' : 'UNAVAILABLE'],
      ['SendInput', result.input?.available ? 'available' : 'UNAVAILABLE'],
      ['trusted capture', result.capture?.available ? 'available' : 'UNAVAILABLE'],
      ['offline OCR', result.desktop_text?.available ? `${result.desktop_text.language}` : 'UNAVAILABLE'],
      ['visible windows', result.visible_windows],
      ['DPI', `${result.dpi?.default_dpi} (virtual screen ${result.virtual_screen?.width}x${result.virtual_screen?.height})`],
      ['Chrome', chrome.connected === true ? `connected via CDP` : `${chrome.status}${reachable.length === 0 ? ' — no endpoint; chrome.ensure will start the controlled profile' : ''}`],
    ]),
    '',
    'Run /deskpilot windows to list what is on the desktop right now.',
  ].join('\n')
}

/**
 * List the visible top-level windows.
 * @param {object} deskpilot - the DeskPilot service.
 * @param {string} key - the calling session id.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<string>} rendered text.
 */
async function renderWindows(deskpilot, key, signal) {
  const response = await deskpilot.request(key, 'windows.list', {}, { signal })
  if (response?.ok !== true) return `DeskPilot windows\n\n${errorText(response)}`
  const windows = response.result?.windows ?? []
  if (windows.length === 0) return 'DeskPilot windows\n\nNo top-level windows were returned.'
  const rows = windows.map((window) => {
    const flags = [window.foreground ? 'foreground' : undefined, window.minimized ? 'minimized' : undefined].filter(Boolean).join(', ')
    return `  ${window.window_id}  ${window.process_name}${flags ? ` (${flags})` : ''}\n      ${window.title}`
  })
  return [
    `DeskPilot windows (${windows.length})`,
    '',
    rows.join('\n'),
    '',
    'These window_id values belong to this session. Use the deskpilot_run tool to observe one.',
  ].join('\n')
}

/**
 * Build the `{ commands }` contribution this plugin registers.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options - resolved plugin config.
 * @returns {number} how many command names were registered.
 */
export function registerCommands(ctx, options) {
  const commands = ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') return 0

  /** One handler serves every registered name, so their grammar cannot drift. */
  const handler = async ({ agent, rawInput, signal }) => {
    const deskpilot = ctx.get('deskpilot')
    if (deskpilot === undefined) {
      return fail('DeskPilot is not mounted in this profile: the `deskpilot` row is missing or disabled.')
    }
    const key = agent?.session?.id
    if (key === undefined) return fail('This command needs a live agent session.')
    const [head = '', ...rest] = rawInput.trim().split(/\s+/)
    const sub = head.toLowerCase() || 'status'
    try {
      switch (sub) {
        case 'status':
          return ok(renderStatus(deskpilot, key))
        case 'doctor':
          return ok(await renderDoctor(deskpilot, signal))
        case 'windows':
          return ok(await renderWindows(deskpilot, key, signal))
        case 'reset': {
          if (rest.length > 0 && rest.join(' ').toLowerCase() !== 'confirm') {
            return fail('Refusing to reset: pass `/deskpilot reset confirm`.')
          }
          const before = deskpilot.state(key)
          if (rest.length === 0 && before.running) {
            return fail('This ends the session and invalidates every window_id/observation_id it holds.\nPass `/deskpilot reset confirm` to go ahead.')
          }
          await deskpilot.drop(key)
          const after = deskpilot.state(key)
          return ok([after.closing ? 'DeskPilot session is closing; Windows runtime preparation may still be running.' : 'DeskPilot session reset.', '', lines([
            ['previous process', after.closing ? 'waiting for exit' : before.running ? 'closed' : 'was not running'],
            ['next request', after.closing ? 'wait for the previous process to exit' : 'starts a clean session'],
          ])].join('\n'))
        }
        case 'help':
          return ok(usage())
        default:
          return fail(`Unknown subcommand \`${head}\`.\n\n${usage()}`)
      }
    } catch (error) {
      return fail(`DeskPilot \`${sub}\` failed: ${String(error?.message ?? error)}`)
    }
  }

  let registered = 0
  const refused = []
  for (const [name, description] of [
    ['deskpilot', 'Inspect, diagnose, or reset the DeskPilot desktop session'],
    ['dp', 'DeskPilot 桌面会话：status / doctor / windows / reset'],
  ]) {
    try {
      commands.register({
        name,
        description,
        input: { hint: SUBCOMMANDS.join('|') },
        handler,
      })
      registered += 1
    } catch (error) {
      // A name collision with another plugin must not fail the whole row, but
      // the refusal is real information and belongs in the startup diagnostic.
      refused.push(`${name}: ${String(error?.message ?? error)}`)
    }
  }
  if (options?.report !== undefined) options.report.commands = { registered, refused }
  return registered
}

/**
 * Usage text shared by `help` and an unknown subcommand.
 * @returns {string} the usage block.
 */
function usage() {
  return [
    'DeskPilot slash commands',
    '',
    '  /deskpilot            session and environment status (default)',
    '  /deskpilot doctor     can this machine be driven right now',
    '  /deskpilot windows    list the visible top-level windows',
    '  /deskpilot reset confirm',
    '                        end the session and drop its window/observation ids',
    '  /deskpilot help       this text',
    '',
    '/dp is an alias of /deskpilot. These run without a model turn; for actual',
    'desktop work ask the agent, which drives the same session through its tools.',
  ].join('\n')
}
