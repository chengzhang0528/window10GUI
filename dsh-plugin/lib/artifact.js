import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DeskPilotError } from './client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REQUIRED = ['AGENTS.md', 'README.md', 'docs/PRODUCT_CONTRACT.md', 'docs/CURRENT_DESIGN.md',
  'bin/win-agent.exe', 'bin/app/win-agent.exe', 'bin/ensure-runtime.ps1', 'bin/runtime-download.json',
  'bin/app/licenses/SimdPaddleOCR-LICENSE.txt', 'bin/app/licenses/THIRD-PARTY-NOTICES.txt',
  '.agents/skills/deskpilot-core/SKILL.md']
const fail = (code, message) => new DeskPilotError(code, message)

export function validateAsset(asset) {
  if (!asset || asset.platform !== 'win-x64' || typeof asset.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(asset.version)
    || typeof asset.url !== 'string' || !asset.url || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 536870912
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw fail('DESKPILOT_ASSET_INVALID', 'asset requires version, platform win-x64, exact URL, byte count (at most 512 MiB), and SHA-256')
  }
  // Endpoint/transport is deployment configuration, not an application allowlist.
  return asset
}

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function entries(root, base = root) {
  const result = []
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await lstat(path)
    if (info.isSymbolicLink()) throw fail('DESKPILOT_ASSET_INVALID', 'bundle must not contain links')
    if (info.isDirectory()) result.push(...await entries(path, base))
    else if (info.isFile()) result.push(relative(base, path).replaceAll('\\', '/'))
    else throw fail('DESKPILOT_ASSET_INVALID', 'bundle must contain regular files only')
  }
  return result
}

/** Verify the complete candidate before cache activation, including licenses and skills. */
export async function verifyBundle(root) {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('DESKPILOT_ASSET_INVALID', 'bundle root must be a real directory')
  const manifestPath = join(root, 'PACKAGE_MANIFEST.json')
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 2 * 1024 * 1024) throw fail('DESKPILOT_ASSET_INVALID', 'invalid or oversized package manifest')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { throw fail('DESKPILOT_ASSET_INVALID', 'package manifest is not valid JSON') }
  if (manifest.platform !== 'win-x64' || manifest.self_contained !== false || !Array.isArray(manifest.files) || manifest.files.length > 10000) {
    throw fail('DESKPILOT_ASSET_INVALID', 'unsupported portable package manifest')
  }
  const names = new Set()
  const actual = await entries(root)
  let total = 0
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':') || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw fail('DESKPILOT_ASSET_INVALID', 'invalid package manifest entry')
    total += file.bytes
    if (total > 536870912) throw fail('DESKPILOT_ASSET_INVALID', 'expanded bundle exceeds 512 MiB')
    const path = resolve(root, file.path), rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel) || names.has(file.path.toLowerCase())) throw fail('DESKPILOT_ASSET_INVALID', 'duplicate or escaping package path')
    names.add(file.path.toLowerCase())
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await digest(path) !== file.sha256.toLowerCase()) {
      throw fail('DESKPILOT_ASSET_INTEGRITY', 'portable package file failed integrity verification: ' + file.path)
    }
  }
  for (const name of REQUIRED) if (!names.has(name.toLowerCase())) throw fail('DESKPILOT_ASSET_INVALID', 'incomplete portable bundle: ' + name)
  if (actual.length !== names.size + 1 || actual.some(name => name !== 'PACKAGE_MANIFEST.json' && !names.has(name.toLowerCase()))) {
    throw fail('DESKPILOT_ASSET_INVALID', 'portable bundle contains undeclared files')
  }
  return join(root, 'bin', 'win-agent.exe')
}

async function unpack(subprocess, archive, destination, signal) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const handle = subprocess.spawn({ argv: [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'unpack.ps1'), '-Archive', archive, '-Destination', destination],
    cwd: destination, graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
  handle.stdin?.end()
  let stderr = '', timer, onAbort
  handle.stdout?.resume()
  handle.stderr?.setEncoding('utf8')
  handle.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
  try {
    const stopped = new Promise((_, reject) => {
      const stop = code => { handle.terminate(); reject(fail(code, 'portable bundle extraction did not complete')) }
      timer = setTimeout(() => stop('DESKPILOT_ASSET_TIMEOUT'), 120000)
      onAbort = () => stop('DESKPILOT_ABORTED')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    const outcome = await Promise.race([handle.done, stopped])
    if (outcome.exitCode !== 0) throw fail('DESKPILOT_ASSET_INVALID', 'portable bundle extraction failed: ' + stderr)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // This helper never starts an installer. It is safe to wait for its own tree.
    await handle.waitForExit()
  }
}

/** Exact immutable asset only. Never searches releases, guesses URLs, or falls back. */
export async function prepareAsset({ asset, cacheRoot, subprocess, signal, fetchImpl = fetch }) {
  validateAsset(asset)
  if (signal?.aborted) throw fail('DESKPILOT_ABORTED', 'cancelled before preparing the portable bundle')
  const root = resolve(cacheRoot)
  await mkdir(root, { recursive: true })
  const target = join(root, asset.version + '-' + asset.sha256.toLowerCase())
  let cached = false
  try { await lstat(target); cached = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (cached) return await verifyBundle(target)
  const temporary = await mkdtemp(join(root, '.prepare-'))
  try {
    const archive = join(temporary, 'payload.zip'), stage = join(temporary, 'bundle')
    const timeout = AbortSignal.timeout(180000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try { response = await fetchImpl(asset.url, { signal: combined }) }
    catch { throw fail(signal?.aborted ? 'DESKPILOT_ABORTED' : 'DESKPILOT_ASSET_DOWNLOAD_FAILED', 'configured portable asset could not be downloaded; no fallback was attempted') }
    if (!response.ok || !response.body) throw fail('DESKPILOT_ASSET_DOWNLOAD_FAILED', 'portable asset returned HTTP ' + response.status)
    let count = 0
    const hash = createHash('sha256')
    const meter = new Transform({ transform(chunk, _, callback) {
      count += chunk.length
      if (count > asset.bytes) return callback(fail('DESKPILOT_ASSET_INTEGRITY', 'download exceeds declared asset size'))
      hash.update(chunk); callback(null, chunk)
    } })
    try { await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { flags: 'wx' }), { signal: combined }) }
    catch (error) {
      if (error instanceof DeskPilotError) throw error
      throw fail(signal?.aborted ? 'DESKPILOT_ABORTED' : 'DESKPILOT_ASSET_DOWNLOAD_FAILED', 'portable download was interrupted; no fallback was attempted')
    }
    if (count !== asset.bytes || hash.digest('hex') !== asset.sha256.toLowerCase()) throw fail('DESKPILOT_ASSET_INTEGRITY', 'portable asset byte count or SHA-256 mismatch')
    await mkdir(stage)
    await unpack(subprocess, archive, stage, signal)
    await verifyBundle(stage)
    if (signal?.aborted) throw fail('DESKPILOT_ABORTED', 'cancelled before activating the portable bundle')
    try { await rename(stage, target) }
    catch (error) {
      // Another process may have atomically installed identical content.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      await verifyBundle(target)
    }
    return join(target, 'bin', 'win-agent.exe')
  } finally {
    // Only the exact unique directory created above is ours to remove.
    if (dirname(temporary) !== root || !relative(root, temporary).startsWith('.prepare-')) throw new Error('invalid temporary cleanup target')
    await rm(temporary, { recursive: true, force: true })
  }
}
