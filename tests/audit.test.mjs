/**
 * dsh-memory 0.12.0：相似记忆查重（duplicate audit）。
 * 缝 1（store.findSimilarPairs）＋缝 1（service.similarPairs）＋缝 3（GET /similar）。
 * 运行 Run: node --test tests/audit.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-audit-'))
}
function mkEntry(id, content, updated, scope = 'global') {
  return { id, category: 'fact', scope, tags: [], created: updated, updated, source: '', content, origin: 'manual' }
}

const NEAR_A = '用户要求所有回复一律使用简体中文'
const NEAR_B = '用户要求所有回复使用简体中文'
const UNRELATED = '本项目使用 pnpm 管理依赖'

// ---------- store：findSimilarPairs ----------

test('findSimilarPairs finds near-duplicate pair, older/newer ordered by updated, score>=threshold', () => {
  const root = tmpRoot()
  store.writeEntry(root, mkEntry('m-old-aaaaaa', NEAR_A, '2026-01-01T00:00:00.000Z'))
  store.writeEntry(root, mkEntry('m-new-bbbbbb', NEAR_B, '2026-02-01T00:00:00.000Z'))
  const pairs = store.findSimilarPairs(root, { scope: 'global' })
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].older.id, 'm-old-aaaaaa')
  assert.equal(pairs[0].newer.id, 'm-new-bbbbbb')
  assert.equal(pairs[0].older.content, NEAR_A)
  assert.ok(pairs[0].score >= 0.5 && pairs[0].score <= 1)
})

test('findSimilarPairs excludes hidden entries (archived / superseded / expired)', () => {
  const root = tmpRoot()
  store.writeEntry(root, mkEntry('m-a-aaaaaa', NEAR_A, '2026-01-01T00:00:00.000Z'))
  store.writeEntry(root, mkEntry('m-b-bbbbbb', NEAR_B, '2026-02-01T00:00:00.000Z'))
  store.updateEntry(root, 'm-a-aaaaaa', { archived: true })
  assert.deepEqual(store.findSimilarPairs(root, { scope: 'global' }), [])
  store.updateEntry(root, 'm-a-aaaaaa', { archived: false, expires: '2020-01-01' })
  assert.deepEqual(store.findSimilarPairs(root, { scope: 'global' }), [])
})

test('findSimilarPairs is scope-local: no cross-scope pairs under scope=all', () => {
  const root = tmpRoot()
  const cwd = path.join(os.tmpdir(), 'dsh-memory-audit-ws')
  store.writeEntry(root, mkEntry('m-g-aaaaaa', NEAR_A, '2026-01-01T00:00:00.000Z', 'global'))
  store.writeEntry(root, mkEntry('m-w-bbbbbb', NEAR_B, '2026-02-01T00:00:00.000Z', 'workspace'), cwd)
  assert.deepEqual(store.findSimilarPairs(root, { scope: 'all', cwd }), [])
  // 同作用域内仍能查到。
  store.writeEntry(root, mkEntry('m-g-cccccc', NEAR_B, '2026-03-01T00:00:00.000Z', 'global'))
  const pairs = store.findSimilarPairs(root, { scope: 'global' })
  assert.equal(pairs.length, 1)
})

test('findSimilarPairs sorted by score desc and capped by limit; empty when none', () => {
  const root = tmpRoot()
  assert.deepEqual(store.findSimilarPairs(root, { scope: 'global' }), [])
  store.writeEntry(root, mkEntry('m-1-aaaaaa', NEAR_A, '2026-01-01T00:00:00.000Z'))
  store.writeEntry(root, mkEntry('m-2-bbbbbb', NEAR_B, '2026-02-01T00:00:00.000Z'))
  store.writeEntry(root, mkEntry('m-3-cccccc', '用户要求所有回复都使用简体中文', '2026-03-01T00:00:00.000Z'))
  store.writeEntry(root, mkEntry('m-4-dddddd', UNRELATED, '2026-04-01T00:00:00.000Z'))
  const all = store.findSimilarPairs(root, { scope: 'global' })
  assert.ok(all.length >= 2, `expected multiple pairs, got ${all.length}`)
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].score >= all[i].score)
  assert.ok(!all.some((p) => p.older.id === 'm-4-dddddd' || p.newer.id === 'm-4-dddddd'), 'unrelated must not pair')
  const capped = store.findSimilarPairs(root, { scope: 'global', limit: 1 })
  assert.equal(capped.length, 1)
  assert.equal(capped[0].score, all[0].score)
})

// ---------- service：公共 API 贯通 ----------

test('service.similarPairs surfaces store pairs (one operation, two callers)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: NEAR_A, scope: 'global', origin: 'manual' })
  service.save({ content: NEAR_B, scope: 'global', origin: 'auto' })
  const pairs = service.similarPairs({ scope: 'global' })
  assert.equal(pairs.length, 1)
  assert.ok(pairs[0].score >= 0.5)
})

// ---------- routes：GET /similar 形状 ----------

test('GET /similar returns { pairs } from loopback', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: NEAR_A, scope: 'global', origin: 'manual' })
  service.save({ content: NEAR_B, scope: 'global', origin: 'auto' })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.12.0-test' })
  const req = {
    method: 'GET',
    url: '/plugins/dsh-memory/similar?scope=global',
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers.similar(req, res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.ok(Array.isArray(doc.pairs))
  assert.equal(doc.pairs.length, 1)
  assert.ok(typeof doc.pairs[0].older.id === 'string' && typeof doc.pairs[0].newer.id === 'string')
})
