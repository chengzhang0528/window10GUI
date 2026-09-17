import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

export const OSS_HOST = 'shared-public-assets.oss-cn-beijing.aliyuncs.com'
export const OSS_BUCKET = 'shared-public-assets'

function fail(message) { throw new Error(message) }

export function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--file', '--key', '--bytes', '--sha256'].includes(key) || value === undefined || result[key.slice(2)] !== undefined) fail('required: --file --key --bytes --sha256')
    result[key.slice(2)] = value
  }
  if (!isAbsolute(result.file || '')) fail('--file must be absolute')
  if (!/^deskpilot\/[A-Za-z0-9._/-]+$/.test(result.key || '') || result.key.includes('//') || result.key.split('/').includes('..')) fail('--key must be a safe immutable key below deskpilot/')
  if (!/^[1-9]\d*$/.test(result.bytes || '')) fail('--bytes must be a positive integer')
  result.bytes = Number(result.bytes)
  if (!Number.isSafeInteger(result.bytes)) fail('--bytes is too large')
  if (!/^[a-f0-9]{64}$/.test(result.sha256 || '')) fail('--sha256 must be lowercase hexadecimal')
  result.file = resolve(result.file)
  return result
}

export function canonicalResource(key) { return `/${OSS_BUCKET}/${key}` }

export function authorization({ method, key, date, contentMd5 = '', contentType = '', accessId, accessSecret, ossHeaders = {} }) {
  const canonicalHeaders = Object.entries(ossHeaders)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`).join('')
  const stringToSign = `${method}\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource(key)}`
  const signature = createHmac('sha1', accessSecret).update(stringToSign).digest('base64')
  return `OSS ${accessId}:${signature}`
}

function encodedPath(key) { return '/' + key.split('/').map(encodeURIComponent).join('/') }

function request({ method, key, headers = {}, body, signed = false, accessId, accessSecret }) {
  const date = new Date().toUTCString()
  const finalHeaders = { Date: date, ...headers }
  if (signed) {
    const ossHeaders = Object.fromEntries(Object.entries(finalHeaders).filter(([name]) => name.toLowerCase().startsWith('x-oss-')))
    finalHeaders.Authorization = authorization({ method, key, date, contentMd5: finalHeaders['Content-MD5'] || '', contentType: finalHeaders['Content-Type'] || '', accessId, accessSecret, ossHeaders })
  }
  return new Promise((resolveRequest, reject) => {
    const req = https.request({ hostname: OSS_HOST, method, path: encodedPath(key), headers: finalHeaders, timeout: 120000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('OSS request timed out')))
    req.on('error', reject)
    if (body) req.end(body); else req.end()
  })
}

async function publicRead(key, expectedBytes, expectedSha256) {
  const response = await request({ method: 'GET', key })
  if (response.status === 404) return { exists: false }
  if (response.status !== 200) fail(`anonymous read failed with HTTP ${response.status}`)
  const actualSha256 = createHash('sha256').update(response.bytes).digest('hex')
  if (response.bytes.length !== expectedBytes || actualSha256 !== expectedSha256) fail('existing OSS object conflicts with the fixed artifact identity')
  return { exists: true, bytes: response.bytes.length, sha256: actualSha256 }
}

export async function publish(options, environment = process.env) {
  const info = statSync(options.file)
  if (!info.isFile() || info.size !== options.bytes) fail('local file byte count does not match --bytes')
  const body = readFileSync(options.file)
  const localSha256 = createHash('sha256').update(body).digest('hex')
  if (localSha256 !== options.sha256) fail('local file SHA-256 does not match --sha256')
  const before = await publicRead(options.key, options.bytes, options.sha256)
  let disposition = 'existing'
  if (!before.exists) {
    const accessId = environment.ALIYUN_ACCESSID
    const accessSecret = environment.ALYUN_ACCESS_SECRET
    if (!accessId || !accessSecret) fail('ALIYUN_ACCESSID and ALYUN_ACCESS_SECRET are required')
    const contentMd5 = createHash('md5').update(body).digest('base64')
    const response = await request({
      method: 'PUT', key: options.key, body, signed: true, accessId, accessSecret,
      headers: { 'Content-Length': body.length, 'Content-MD5': contentMd5, 'Content-Type': 'application/octet-stream', 'x-oss-forbid-overwrite': 'true' },
    })
    if (![200, 201].includes(response.status)) fail(`immutable OSS upload failed with HTTP ${response.status}`)
    disposition = 'uploaded'
  }
  const verified = await publicRead(options.key, options.bytes, options.sha256)
  if (!verified.exists) fail('OSS object was not publicly readable after upload')
  return { status: 'published', disposition, url: `https://${OSS_HOST}/${options.key}`, key: options.key, bytes: verified.bytes, sha256: verified.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish(parseArgs(process.argv.slice(2))).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
