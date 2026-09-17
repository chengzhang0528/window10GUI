import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { resolve } from 'node:path'
import test from 'node:test'

import { authorization, canonicalResource, parseArgs } from './oss-publish.mjs'

test('publication arguments bind an absolute file to one safe DeskPilot key and identity', () => {
  const options = parseArgs(['--file', resolve('fixed.zip'), '--key', 'deskpilot/cli/releases/abc/fixed.zip', '--bytes', '42', '--sha256', 'a'.repeat(64)])
  assert.equal(options.bytes, 42)
  assert.throws(() => parseArgs(['--file', resolve('fixed.zip'), '--key', 'other/fixed.zip', '--bytes', '42', '--sha256', 'a'.repeat(64)]), /deskpilot/)
  assert.throws(() => parseArgs(['--file', resolve('fixed.zip'), '--key', 'deskpilot/../fixed.zip', '--bytes', '42', '--sha256', 'a'.repeat(64)]), /safe immutable/)
})

test('OSS V1 authorization signs the canonical bucket resource and sorted OSS headers', () => {
  const input = { method: 'PUT', key: 'deskpilot/a.zip', date: 'Thu, 17 Nov 2005 18:49:58 GMT', contentMd5: 'md5=', contentType: 'application/octet-stream', accessId: 'id', accessSecret: 'secret', ossHeaders: { 'x-oss-forbid-overwrite': 'true' } }
  const expectedText = 'PUT\nmd5=\napplication/octet-stream\nThu, 17 Nov 2005 18:49:58 GMT\nx-oss-forbid-overwrite:true\n/shared-public-assets/deskpilot/a.zip'
  assert.equal(authorization(input), `OSS id:${createHmac('sha1', 'secret').update(expectedText).digest('base64')}`)
  assert.equal(canonicalResource(input.key), '/shared-public-assets/deskpilot/a.zip')
})
