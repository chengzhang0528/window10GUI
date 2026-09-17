import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createServer } from 'node:http'
import { prepareAsset, validateAsset, verifyBundle } from '../lib/artifact.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const required = ['AGENTS.md', 'README.md', 'docs/PRODUCT_CONTRACT.md', 'docs/CURRENT_DESIGN.md',
  'bin/win-agent.exe', 'bin/app/win-agent.exe', 'bin/ensure-runtime.ps1', 'bin/runtime-download.json',
  'bin/app/licenses/SimdPaddleOCR-LICENSE.txt', 'bin/app/licenses/THIRD-PARTY-NOTICES.txt', '.agents/skills/deskpilot-core/SKILL.md']

// Minimal stored ZIP fixture writer. No product executable is run by these tests.
function zip(entries) {
  const locals = [], directory = []
  let offset = 0
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(value)
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26)
    locals.push(header, filename, bytes)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    directory.push(central, filename)
    offset += header.length + filename.length + bytes.length
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function bundle(extra = []) {
  const files = required.map(path => [path, 'fixture ' + path])
  const manifest = { platform: 'win-x64', self_contained: false, files: files.map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })) }
  return zip([...files, ['PACKAGE_MANIFEST.json', JSON.stringify(manifest)], ...extra])
}

async function fixture(t, bytes = bundle()) {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'deskpilot-assets-'))
  t.after(() => { assert.equal(dirname(cacheRoot), tmpdir()); assert.ok(basename(cacheRoot).startsWith('deskpilot-assets-')); return rm(cacheRoot, { recursive: true, force: true }) })
  let downloads = 0, spawned = 0
  const server = createServer((_, response) => { downloads++; response.writeHead(200, { 'Content-Type': 'application/zip' }); response.end(bytes) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const children = new Set()
  t.after(async () => { for (const child of children) child.kill(); await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve)))) })
  const subprocess = { spawn(spec) {
    spawned++
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true, stdio: 'pipe' })
    children.add(child)
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { children.delete(child); resolve({ exitCode, signal }) }) })
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => child.kill(), waitForExit: () => done.then(() => true) }
  } }
  const asset = { version: 'fixture-1', platform: 'win-x64', url: 'http://127.0.0.1:' + server.address().port + '/fixed.zip', bytes: bytes.length, sha256: hash(bytes) }
  return { cacheRoot, subprocess, asset, get downloads() { return downloads }, get spawned() { return spawned } }
}

test('configured immutable asset downloads once, validates full closure, and is reused', async t => {
  const f = await fixture(t)
  const executable = await prepareAsset(f)
  assert.equal(await readFile(executable, 'utf8'), 'fixture bin/win-agent.exe')
  assert.equal(await prepareAsset(f), executable)
  assert.equal(f.downloads, 1); assert.equal(f.spawned, 1)
  assert.deepEqual(await readdir(f.cacheRoot), ['fixture-1-' + f.asset.sha256])
})

test('corrupt cached file is refused without replacing it or downloading a fallback', async t => {
  const f = await fixture(t)
  const executable = await prepareAsset(f)
  await writeFile(executable, 'corrupted')
  await assert.rejects(prepareAsset(f), { code: 'DESKPILOT_ASSET_INTEGRITY' })
  assert.equal(f.downloads, 1)
  assert.equal(await readFile(executable, 'utf8'), 'corrupted')
})

test('bad download digest or size never extracts or activates', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareAsset({ ...f, asset: { ...f.asset, sha256: '0'.repeat(64) } }), { code: 'DESKPILOT_ASSET_INTEGRITY' })
  await assert.rejects(prepareAsset({ ...f, asset: { ...f.asset, bytes: 1 } }), { code: 'DESKPILOT_ASSET_INTEGRITY' })
  assert.equal(f.spawned, 0)
  assert.deepEqual(await readdir(f.cacheRoot), [])
})

for (const path of ['../escape.exe', '/absolute.exe', 'bin/evil.exe:stream', 'bin/CON.txt', 'bin/win-agent.exe']) {
  test('unsafe or duplicate archive entry rejected: ' + path, async t => {
    const f = await fixture(t, bundle([[path, 'not executable']]))
    await assert.rejects(prepareAsset(f), { code: 'DESKPILOT_ASSET_INVALID' })
    assert.deepEqual(await readdir(f.cacheRoot), [])
  })
}

test('undeclared archive files are rejected before activation', async t => {
  const f = await fixture(t, bundle([['extra.exe', 'not executable']]))
  await assert.rejects(prepareAsset(f), { code: 'DESKPILOT_ASSET_INVALID' })
  assert.deepEqual(await readdir(f.cacheRoot), [])
})

test('offline source has no fallback; cancellation does not start extraction', async t => {
  const f = await fixture(t)
  let attempts = 0
  await assert.rejects(prepareAsset({ ...f, fetchImpl: async () => { attempts++; throw new Error('offline') } }), { code: 'DESKPILOT_ASSET_DOWNLOAD_FAILED' })
  await assert.rejects(prepareAsset({ ...f, signal: AbortSignal.abort() }), { code: 'DESKPILOT_ABORTED' })
  assert.equal(attempts, 1); assert.equal(f.spawned, 0)
  assert.deepEqual(await readdir(f.cacheRoot), [])
})

test('asset metadata is explicit; no latest lookup or transport allowlist', () => {
  assert.throws(() => validateAsset({}), { code: 'DESKPILOT_ASSET_INVALID' })
  assert.equal(validateAsset({ version: 'v1', platform: 'win-x64', url: 'http://configured-source/fixed.zip', bytes: 1, sha256: 'a'.repeat(64) }).version, 'v1')
})
