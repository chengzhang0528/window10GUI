// Development smoke through the actual host subprocess service; no desktop actions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
function argument(name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error('Required: --command <public candidate exe> --dsh <host installation directory>')
  return resolve(args[index + 1])
}
const executable = argument('--command'), dsh = argument('--dsh')
const require = createRequire(pathToFileURL(resolve(dsh, 'package.json')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const provider = (await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local')))).default
const plugin = await import(args.includes('--plugin') ? pathToFileURL(join(argument('--plugin'), 'lib/index.js')) : '../lib/index.js')
const root = new Context(), registered = [], skills = [], commands = []
const subprocess = root.plugin(provider)
await subprocess
root.provide('tools', { register(tool) { registered.push(tool); return () => {} } })
root.provide('skills', { register(skill) { skills.push(skill); return () => {} } })
root.provide('commands', { register(command) { commands.push(command); return () => {} } })
let fiber
let server, cacheRoot
try {
  let config = { command: executable, cwd: dirname(dirname(executable)) }
  if (args.includes('--archive')) {
    const bytes = await readFile(argument('--archive'))
    server = createServer((_, response) => { response.writeHead(200); response.end(bytes) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    cacheRoot = await mkdtemp(join(tmpdir(), 'deskpilot-host-assets-'))
    config = { cacheRoot, asset: { version: 'candidate-smoke', platform: 'win-x64', url: 'http://127.0.0.1:' + server.address().port + '/candidate.zip', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  }
  fiber = root.plugin(plugin, plugin.Config(config))
  await fiber
  assert.equal(registered.length, 4)
  assert.equal(skills.length, server ? 0 : 6)
  assert.equal(commands.length, 2)
  const service = root.get('deskpilot')
  assert.equal(service.sessions.size, 0)
  const exec = { agent: { session: { id: 'candidate-smoke' } }, signal: new AbortController().signal }
  const doctor = await registered.find(tool => tool.name === 'deskpilot_doctor').execute({}, exec)
  assert.equal(doctor.reply.response?.ok, true, JSON.stringify(doctor.reply.error))
  assert.equal(skills.length, 6)
  assert.equal(service.sessions.size, 0)
  const run = registered.find(tool => tool.name === 'deskpilot_run')
  const first = await run.execute({ method: 'capabilities', params: {} }, exec)
  assert.equal(first.reply.ok, true)
  const client = service.sessions.get('candidate-smoke')
  const second = await run.execute({ method: 'capabilities', params: {} }, exec)
  assert.equal(second.reply.ok, true)
  assert.equal(service.sessions.get('candidate-smoke'), client)
  await assert.rejects(run.execute({ method: 'input.click', params: {} }, exec), { code: 'DESKPILOT_MUTATING_METHOD' })
  const batch = registered.find(tool => tool.name === 'deskpilot_batch')
  for (const method of ['actions.batch', 'workflow.run', 'close']) {
    await assert.rejects(batch.execute({ steps: [{ step_id: 'invalid', method }], reason: 'invalid nesting check' }, exec), { code: 'DESKPILOT_INVALID_BATCH' })
  }
  await service.drop('candidate-smoke')
  assert.equal(client.handle, null)
  assert.equal(service.sessions.size, 0)
  console.log('PASS real host: 4 tools, 6 skills, 2 commands; ' + (server ? 'downloaded exact ZIP; ' : '') + 'candidate doctor; persistent reuse; mutation guard; clean close')
} finally {
  await fiber?.dispose()
  await subprocess.dispose()
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  if (cacheRoot) { assert.equal(dirname(cacheRoot), tmpdir()); assert.ok(basename(cacheRoot).startsWith('deskpilot-host-assets-')); await rm(cacheRoot, { recursive: true, force: true }) }
}
