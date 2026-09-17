/**
 * DeskPilot as a dsh profile bundle.
 *
 * The host-plane side owns one thing: a persistent `win-agent.exe exec --stdin
 * --format ndjson` process per agent session, and the request plumbing around
 * it. On top of that session this row publishes three surfaces:
 *
 *  - model-facing tools (`registerTools`), the agent's half of the loop;
 *  - human slash commands (`registerCommands`), which run against the same
 *    session with no model turn;
 *  - the DeskPilot Agent Skills (`registerSkills`), which carry the operating
 *    method the protocol alone cannot.
 *
 * @module dsh-plugin-deskpilot
 */
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { registerCommands } from './commands.js'
import { writeStartupDiagnostic } from './diagnostic.js'
import { bundledExecutable, defaultCwd, DeskPilotService, skillRoots } from './service.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'

export const name = 'deskpilot'

/**
 * Services this plugin consumes; it waits until all of them exist.
 *
 * `commands` is deliberately absent: slash commands are a UI-surface extra, so a
 * deployment without a command registry keeps the tools instead of the whole row
 * staying pending. Registering them reads `ctx.get('commands')` and steps aside
 * when it is absent.
 */
export const inject = ['tools', 'subprocess']

/** Deployment-facing configuration for the DeskPilot bundle. */
export const Config = z.object({
  /**
   * Absolute path of the DeskPilot CLI. Left unset, the plugin resolves the
   * executable that ships beside it in the DeskPilot package.
   */
  command: z.string(),
  /** Optional published immutable portable ZIP, selected by the deployment owner. */
  asset: z.object({ version: z.string(), platform: z.string(), url: z.string(), bytes: z.number(), sha256: z.string() }).default(undefined),
  /** Private versioned payload cache, never a workspace or live install directory. */
  cacheRoot: z.string(),
  /** Working directory of the spawned CLI. Defaults to the DeskPilot package root. */
  cwd: z.string(),
  /** Per-request budget handed to the CLI transport. */
  timeoutMs: z.number().step(1).min(1000).default(130000),
  /** Budget for the `doctor` diagnostic, which starts a throwaway process. */
  doctorTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** Only a native bootstrap PREPARING event activates this separate budget. */
  setupTimeoutMs: z.number().step(1).min(1000).default(900000),
  /** Cap on one response line, so a runaway observation cannot exhaust memory. */
  maxLineBytes: z.number().step(1).min(4096).default(8 * 1024 * 1024),
  /**
   * Absolute skill roots to add to the deployment's skill catalog. Left unset
   * (the `undefined` default matters: an empty array would mean "contribute
   * nothing"), the plugin uses the DeskPilot package's own `.agents/skills`.
   */
  skillRoots: z.array(z.string()).default(undefined),
  /** Publish DeskPilot's skills into the skill catalog. */
  registerSkills: z.boolean().default(true),
  /** Register the `/deskpilot` and `/dp` slash commands when a command registry exists. */
  registerCommands: z.boolean().default(true),
  /**
   * Absolute path of a JSON file to write one startup diagnostic to, describing
   * what this row actually contributed (tools, skills, commands, and any surface
   * it had to step aside from). Unset by default: it exists so a deployment can
   * verify the row from outside the host process, which is the only way to check
   * a UI surface a test cannot type into.
   */
  startupDiagnostic: z.string(),
})

/**
 * Mount the DeskPilot service and the surfaces built on it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated plugin config.
 * @returns {{tools: number, skills: number, commands: number}} what this row contributed.
 */
export function apply(ctx, config) {
  const executable = config.command ?? bundledExecutable()
  const cwd = config.cwd ?? defaultCwd(executable)
  const roots = config.skillRoots ?? (existsSync(executable) ? skillRoots(cwd) : [])
  const options = {
    subprocess: ctx.subprocess,
    command: executable,
    explicitCommand: config.command !== undefined,
    explicitCwd: config.cwd !== undefined,
    asset: config.asset,
    cacheRoot: config.cacheRoot ?? join(process.env.LOCALAPPDATA ?? homedir(), 'DeskPilot', 'releases'),
    cwd,
    timeoutMs: config.timeoutMs,
    doctorTimeoutMs: config.doctorTimeoutMs,
    setupTimeoutMs: config.setupTimeoutMs,
    maxLineBytes: config.maxLineBytes,
    skillRoots: roots,
    /** Filled in by each surface below with what it actually contributed. */
    report: {},
  }
  new DeskPilotService(ctx, options)
  const tools = registerTools(ctx, options)
  const skills = config.registerSkills === false ? 0 : registerSkills(ctx, roots, options)
  options.onPrepared = base => {
    if (config.skillRoots !== undefined || config.registerSkills === false) return
    options.skillRoots = skillRoots(base)
    registerSkills(ctx, options.skillRoots, options)
  }
  const commands = config.registerCommands === false ? 0 : registerCommands(ctx, options)
  const report = { tools, skills, commands, ...options.report }
  if (config.startupDiagnostic !== undefined) {
    writeStartupDiagnostic(config.startupDiagnostic, report, options)
  }
  return report
}
