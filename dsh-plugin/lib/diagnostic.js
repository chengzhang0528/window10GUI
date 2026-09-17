/**
 * Startup diagnostic for one mounted DeskPilot row.
 *
 * Why this exists: a plugin's contribution includes surfaces a test cannot
 * exercise from outside the host — the tools land in another service's registry,
 * the skills in another, and a slash command only proves itself once a human
 * types it into a composer. Writing what the row actually contributed to a file
 * the deployment chooses makes "did the row do its job?" answerable by
 * inspection, in the exact process that is serving the session.
 *
 * It is off unless the row configures `startupDiagnostic`, so a normal install
 * writes nothing.
 * @module dsh-plugin-deskpilot/diagnostic
 */
import { writeFileSync } from 'node:fs'

/**
 * Write the startup diagnostic, never failing the row for a diagnostic.
 * @param {string} path - absolute target path.
 * @param {object} report - what the row contributed.
 * @param {object} options - the resolved plugin options.
 */
export function writeStartupDiagnostic(path, report, options) {
  const payload = {
    plugin: 'dsh-plugin-deskpilot',
    time: new Date().toISOString(),
    pid: process.pid,
    ...report,
    launch: {
      executable: options.command,
      cwd: options.cwd,
      skillRoots: options.skillRoots,
    },
  }
  try {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // A diagnostic path the host cannot write must not cost the capability
    // itself; the row's own return value reports the same numbers.
  }
}

