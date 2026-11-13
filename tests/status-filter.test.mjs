/**
 * dsh-memory 0.24.0：状态服务端过滤＋口径对齐。
 * 缝 1（store.entryStatus/filterEntries）＋缝 1（service.searchDetailed/stats）＋缝 3（GET /entries）。
 * 状态优先级统一：被取代 > 已过期 > 已归档 > 活跃（pinned 正交）。
 * 运行 Run: node --test tests/status-filter.test.mjs
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-status-filter-'))
}
const ALL = { includeSuperseded: true, includeExpired: true, includeArchived: true }

test('entryStatus priority: superseded > expired > archived > active; pinned orthogonal', () => {
  const now = Date.parse('2026-11-13T00:00:00Z')
  assert.equal(store.entryStatus({ superseded_by: 'x', archived: true, expires: '2020-01-01' }, now), 'superseded')
  assert.equal(store.entryStatus({ archived: true, expires: '2020-01-01' }, now), 'expired')
  assert.equal(store.entryStatus({ archived: true }, now), 'archived')
  assert.equal(store.entryStatus({ pinned: true }, now), 'active')
  assert.equal(store.entryStatus({}, now), 'active')
})

test('filterEntries status post-filter selects each status (with include-all loading)', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '活跃', scope: 'global' })
  const sup = store.saveEntry(root, { content: '被取代', scope: 'global' })
  store.saveEntry(root, { content: '取代者', scope: 'global', supersedes: sup.entry.id })
  store.saveEntry(root, { content: '过期', scope: 'global', expires: '2020-01-01' })
  const arch = store.saveEntry(root, { content: '归档', scope: 'global' })
  store.updateEntry(root, arch.entry.id, { archived: true })
  assert.equal(store.filterEntries(root, { scope: 'global', status: 'active', ...ALL }).length, 2)
  assert.equal(store.filterEntries(root, { scope: 'global', status: 'superseded', ...ALL }).length, 1)
  assert.equal(store.filterEntries(root, { scope: 'global', status: 'expired', ...ALL }).length, 1)
  assert.equal(store.filterEntries(root, { scope: 'global', status: 'archived', ...ALL }).length, 1)
  assert.equal(store.filterEntries(root, { scope: 'global', status: 'all', ...ALL }).length, 5)
})

test('filterEntries status=pinned includes hidden pinned entries (include-all)', () => {
  const root = tmpRoot()
  const a = store.saveEntry(root, { content: '钉选归档', scope: 'global', pinned: true })
  store.updateEntry(root, a.entry.id, { archived: true })
  store.saveEntry(root, { content: '普通活跃', scope: 'global' })
  const pinned = store.filterEntries(root, { scope: 'global', status: 'pinned', ...ALL })
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].content, '钉选归档')
})

test('service.searchDetailed applies status filter', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '活跃甲', scope: 'global', origin: 'manual' })
  const old = service.save({ content: '被取代乙', scope: 'global', origin: 'manual' })
  service.save({ content: '取代者丙', scope: 'global', origin: 'manual', supersedes: old.entry.id })
  const res = service.searchDetailed({ scope: 'global', status: 'superseded', includeSuperseded: true })
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].content, '被取代乙')
})

test('service.stats byStatus uses unified priority (expired before archived)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const e = service.save({ content: '过期且归档', scope: 'global', origin: 'manual', expires: '2020-01-01' })
  service.update({ id: e.entry.id, archived: true })
  const stats = service.stats({ scope: 'global' })
  assert.equal(stats.byStatus.expired, 1, 'expired+archived counts as expired')
  assert.equal(stats.byStatus.archived, 0)
})

test('GET /entries honors status param', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '活跃甲', scope: 'global', origin: 'manual' })
  const arch = service.save({ content: '归档乙', scope: 'global', origin: 'manual' })
  service.update({ id: arch.entry.id, archived: true })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.24.0-test' })
  const req = {
    method: 'GET',
    url: '/plugins/dsh-memory/entries?status=archived&include_archived=true',
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers.entries(req, res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].content, '归档乙')
})
