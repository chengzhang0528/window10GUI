/**
 * Contribute DeskPilot's Agent Skills to the deployment's skill catalog.
 *
 * DeskPilot ships its operating method as skills next to its executable — the
 * protocol lives in the tool schemas, but the *loop* (observe, act in a short
 * batch, verify, recover) and the failure vocabulary live in these files. A
 * deployment whose workspace is elsewhere would not find them through its own
 * project-root scan, so the bundle registers them itself.
 *
 * The scanning is deliberately small: DeskPilot's own layout, `<root>/<name>/SKILL.md`
 * plus `<root>/<name>.md`, parsed just far enough to take the catalog's `name`
 * and `description` out of the frontmatter.
 * @module dsh-plugin-deskpilot/skills
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Read one frontmatter scalar, as a plain, single- or double-quoted value.
 * @param {string} block - frontmatter text.
 * @param {string} key - key to read.
 * @returns {string | undefined} the value.
 */
function scalar(block, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(block)
  if (match === null) return undefined
  let value = match[1]
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Split one skill file into its frontmatter metadata and instruction body.
 * @param {string} text - file contents.
 * @returns {{name?: string, description?: string, body: string}} parsed parts.
 */
export function parseSkill(text) {
  const match = FRONTMATTER.exec(text)
  if (match === null) return { body: text }
  const block = match[1]
  const lines = block.split(/\r?\n/)
  const folded = []
  for (const line of lines) {
    if (/^[a-z][a-z0-9_-]*:/.test(line)) continue
    folded.push(line.trim())
  }
  return {
    name: scalar(block, 'name'),
    description: scalar(block, 'description') ?? folded.filter(Boolean).join(' '),
    body: text.slice(match[0].length),
  }
}

/**
 * Discover the skill files under the configured roots.
 * @param {string[]} roots - absolute skill directories.
 * @returns {Array<{path: string, name: string, description: string, content: string}>} registrations.
 */
export function discoverSkills(roots) {
  const found = []
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = entry.isDirectory() ? join(root, entry.name, 'SKILL.md') : join(root, entry.name)
      if (!entry.isDirectory() && !entry.name.endsWith('.md')) continue
      let text
      try {
        if (!statSync(candidate).isFile()) continue
        text = readFileSync(candidate, 'utf8')
      } catch {
        continue
      }
      const parsed = parseSkill(text)
      const name = parsed.name ?? basename(entry.isDirectory() ? entry.name : entry.name, '.md')
      if (!SKILL_NAME.test(name)) continue
      const description = (parsed.description ?? '').trim()
      if (description.length === 0) continue
      found.push({ path: candidate, name, description, content: parsed.body })
    }
  }
  return found
}

/**
 * Register the discovered skills into this deployment's catalog.
 *
 * Best-effort and reversible: a deployment without a skill registry simply
 * gains nothing here, and the tools stay usable through their descriptions.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string[]} roots - absolute skill directories.
 * @returns {number} how many skills were contributed.
 */
export function registerSkills(ctx, roots, options = {}) {
  if (roots.length === 0) return 0
  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') return 0
  let registered = 0
  const refused = []
  const found = discoverSkills(roots)
  for (const skill of found) {
    try {
      const dispose = skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        provider: 'deskpilot',
        source: 'bundled',
        metadata: { deskpilot_skill_path: skill.path },
      })
      ctx.effect(() => dispose, `deskpilot skill ${skill.name}`)
      registered += 1
    } catch (error) {
      // A duplicate or rejected name must not fail the bundle row, but it is
      // real information and belongs in the startup diagnostic.
      refused.push(`${skill.name}: ${String(error?.message ?? error)}`)
    }
  }
  if (options?.report !== undefined) options.report.skills = { found: found.length, registered, refused }
  return registered
}

