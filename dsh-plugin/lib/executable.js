import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DeskPilotError } from './client.js'

/** Reject only an identifiable portable bundle's internal apphost, not arbitrary developer builds. */
export function requirePublicExecutable(executable) {
  if (!isAbsolute(executable)) throw new DeskPilotError('DESKPILOT_EXECUTABLE_NOT_ABSOLUTE', 'command must be an absolute path')
  if (!existsSync(executable)) throw new DeskPilotError('DESKPILOT_EXECUTABLE_MISSING', 'win-agent.exe was not found at ' + executable + '; configure the portable bundle public bin/win-agent.exe')
  const actual = realpathSync(executable)
  const app = dirname(actual)
  const bin = dirname(app)
  if (basename(actual).toLowerCase() === 'win-agent.exe' && basename(app).toLowerCase() === 'app'
    && basename(bin).toLowerCase() === 'bin'
    && ['win-agent.exe', 'ensure-runtime.ps1', 'runtime-download.json'].every(file => existsSync(join(bin, file)))) {
    const publicEntry = join(bin, 'win-agent.exe')
    throw new DeskPilotError('DESKPILOT_INTERNAL_ENTRYPOINT', 'command points to the bundled internal apphost and bypasses runtime preparation; use ' + publicEntry, { executable, public_entry: publicEntry })
  }
  return executable
}
