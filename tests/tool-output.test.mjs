/**
 * dsh-memory 0.24.1：工具输出 lossless JSON 契约回归。
 * 旧 v1 文件/手工编辑/旧导出导入的条目可能没有 origin：工具返回值若直接带
 * `origin: undefined`，宿主 JSON 快照会丢弃该键并判定 INVALID_TOOL_OUTPUT
 * （写盘已生效却报失败）。所有工具返回边界必须无 undefined 自有属性。
 * 运行 Run: node --test tests/tool-output.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { savePendingResultValue, saveResultValue, updateResultValue, sanitizeToolError, withSanitizedToolErrors } from '../index.js'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-tool-output-'))
  return { root, service: createMemoryService({ root }) }
}

/** 等价宿主 lossless 判定：任何自有属性值不得为 undefined，JSON 往返键集不变。 */
function assertLossless(value) {
  const walk = (v, at) => {
    assert.notEqual(v, undefined, `undefined value at ${at}`)
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${at}[${i}]`))
      return
    }
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) walk(v[key], `${at}.${key}`)
    }
  }
  walk(value, '$')
  const roundTrip = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip, value)
  assert.deepEqual(Object.keys(roundTrip).sort(), Object.keys(value).sort())
}

function writeLegacyEntry(root, { id, scope = 'global', content = '旧版内容' }) {
  const now = new Date().toISOString()
  store.writeEntry(root, {
    id,
    category: 'fact',
    scope,
    tags: [],
    created: now,
    updated: now,
    source: '',
    content,
  })
}

test('updateResultValue wraps a legacy entry without origin losslessly (manual fallback)', () => {
  const { root, service } = tmpService()
  writeLegacyEntry(root, { id: 'm-legacy-aaaaaa' })
  const entry = service.update({ id: 'm-legacy-aaaaaa', content: '旧版内容更新' })
  assert.equal(entry.origin, undefined)
  const value = updateResultValue(entry)
  assert.equal(value.origin, 'manual')
  assert.equal(value.id, 'm-legacy-aaaaaa')
  assertLossless(value)
})

test('saveResultValue wraps a legacy dedupe hit without origin losslessly', () => {
  const { root, service } = tmpService()
  writeLegacyEntry(root, { id: 'm-legacy-bbbbbb', content: '旧版内容乙' })
  const { entry, deduplicated } = service.save({ content: '旧版内容乙', scope: 'global' })
  assert.equal(deduplicated, true)
  assert.equal(entry.origin, undefined)
  const value = saveResultValue(entry, deduplicated, [], false)
  assert.equal(value.origin, 'manual')
  assert.equal(value.deduplicated, true)
  assert.equal('revived' in value, false, 'revived 为稀疏字段，非复活时不出现')
  assertLossless(value)
})

test('saveResultValue keeps origin, similar and sparse revived flag lossless', () => {
  const normal = saveResultValue({ id: 'm-1', scope: 'global', category: 'fact', origin: 'auto' }, false, [{ id: 'm-old', content: '相似', score: 0.8 }], false)
  assert.equal(normal.origin, 'auto')
  assert.equal(normal.status, 'active', 'v3 save result reports status=active for lossless consumers')
  assert.equal('revived' in normal, false)
  assertLossless(normal)
  const revived = saveResultValue({ id: 'm-2', scope: 'global', category: 'fact', origin: 'manual' }, true, [], true)
  assert.equal(revived.revived, true)
  assert.equal(revived.deduplicated, true)
  assertLossless(revived)
})

test('savePendingResultValue is lossless and carries no entry id', () => {
  const value = savePendingResultValue({ pendingId: 'p-1', scope: 'global', category: 'preference', origin: 'auto', risk: 'R2', reason: 'repeat' })
  assert.equal(value.status, 'pending')
  assert.equal(value.pendingId, 'p-1')
  assert.equal('id' in value, false, 'pending candidates have no entry id yet')
  assertLossless(value)
})

test('normal entries keep their origin unchanged (no behavior drift)', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '普通条目', scope: 'global', origin: 'auto' })
  const updated = service.update({ id: entry.id, content: '普通条目更新' })
  assert.equal(updateResultValue(updated).origin, 'auto')
  const dup = service.save({ content: '普通条目更新', scope: 'global' })
  assert.equal(saveResultValue(dup.entry, dup.deduplicated, [], false).origin, 'auto')
})

test('H1: tool errors sanitize infrastructure codes (no local paths reach the model)', () => {
  const leaked = Object.assign(new Error('lock timeout: C:\\Users\\someone\\.dsh\\.dsh-memory\\.lock-write'), { code: 'busy' })
  const busy = sanitizeToolError(leaked)
  assert.equal(busy.code, 'busy')
  assert.ok(!busy.message.includes('Users') && !busy.message.includes('.lock'), 'busy message must not leak paths')
  const ioErr = sanitizeToolError(Object.assign(new Error('ENOENT: C:\\secret\\dir'), { code: 'io' }))
  assert.ok(!ioErr.message.includes('secret'), 'io message must not leak paths')
  // 业务错误（invalid/secret）保留原始文案，方便模型自我纠正。
  const invalid = Object.assign(new Error('未知分类 unknown category: xx'), { code: 'invalid' })
  assert.equal(sanitizeToolError(invalid), invalid)
  const plain = new Error('boom')
  assert.equal(sanitizeToolError(plain), plain)
  // 包装器只改 execute 的错误面，其余字段与成功返回值不变。
  const tool = { name: 't', isConcurrencySafe: () => false, execute: () => ({ ok: true }) }
  const wrapped = withSanitizedToolErrors(tool)
  assert.equal(wrapped.name, 't')
  assert.equal(wrapped.isConcurrencySafe(), false)
  assert.deepEqual(wrapped.execute({}, {}), { ok: true })
  assert.throws(
    () => withSanitizedToolErrors({ name: 't2', execute: () => { throw Object.assign(new Error('x'), { code: 'io' }) } }).execute({}, {}),
    (err) => err.code === 'io' && !/x$/u.test(err.message),
  )
})