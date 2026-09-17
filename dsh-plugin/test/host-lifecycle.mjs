// Focused plugin-unload cancellation check; requires the host's Cordis peer.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { DeskPilotService } from '../lib/service.js'

const cacheRoot = await mkdtemp(join(tmpdir(), 'deskpilot-unload-'))
let requested
const requestSeen = new Promise(resolve => { requested = resolve })
const server = createServer(() => requested()) // Deliberately hold the response open.
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const root = new Context()
let service, spawns = 0, timer
const fiber = root.plugin({ name: 'lifecycle-fixture', apply(ctx) {
  service = new DeskPilotService(ctx, {
    command: join(cacheRoot, 'missing.exe'), explicitCommand: false, cacheRoot,
    asset: { version: 'unload', platform: 'win-x64', url: 'http://127.0.0.1:' + server.address().port + '/fixed.zip', bytes: 1, sha256: 'a'.repeat(64) },
    subprocess: { spawn() { spawns++; throw new Error('must not execute an incomplete download') } },
  })
} })
try {
  await fiber
  const outcome = service.doctor().then(() => { throw new Error('interrupted download unexpectedly succeeded') }, error => error)
  await Promise.race([requestSeen, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('download did not start')), 3000) })])
  clearTimeout(timer)
  assert.equal(service.describe().preparing_asset, true)
  await fiber.dispose()
  assert.equal((await outcome).code, 'DESKPILOT_ABORTED')
  assert.equal(spawns, 0)
  assert.deepEqual(await readdir(cacheRoot), [])
  console.log('PASS host unload: in-flight download cancelled, staging removed, no executable started')
} finally {
  clearTimeout(timer)
  await fiber.dispose()
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  assert.equal(dirname(cacheRoot), tmpdir())
  assert.ok(basename(cacheRoot).startsWith('deskpilot-unload-'))
  await rm(cacheRoot, { recursive: true, force: true })
}
