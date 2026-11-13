/**
 * dsh-memory 0.13.0：检索完整性（offset 分页＋隐藏态匹配计数）。
 * 缝 1（service.searchDetailed）。工具面形状变更经 live 调用验证。
 * 运行 Run: node --test tests/search.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { searchResultEntry } from '../index.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-search-'))
  return { root, service: createMemoryService({ root }) }
}

test('searchDetailed returns {entries, hidden}; hidden counts superseded/expired/archived by priority', () => {
  const { service } = tmpService()
  service.save({ content: '检索测试 活跃条目', scope: 'global', origin: 'manual' })
  const sup = service.save({ content: '检索测试 被取代条目', scope: 'global', origin: 'manual' })
  service.save({ content: '检索测试 取代者', scope: 'global', origin: 'manual', supersedes: sup.entry.id })
  service.save({ content: '检索测试 过期条目', scope: 'global', origin: 'manual', expires: '2020-01-01' })
  const arch = service.save({ content: '检索测试 归档条目', scope: 'global', origin: 'manual' })
  service.update({ id: arch.entry.id, archived: true })
  const res = service.searchDetailed({ query: '检索测试', scope: 'global' })
  assert.ok(Array.isArray(res.entries))
  assert.equal(res.entries.length, 2, 'active + 取代者 visible')
  assert.deepEqual(res.hidden, { superseded: 1, expired: 1, archived: 1, total: 3 })
})

test('searchDetailed include_* recovers hidden and reduces hidden counts', () => {
  const { service } = tmpService()
  service.save({ content: '检索测试 活跃条目', scope: 'global', origin: 'manual' })
  const sup = service.save({ content: '检索测试 被取代条目', scope: 'global', origin: 'manual' })
  service.save({ content: '检索测试 取代者', scope: 'global', origin: 'manual', supersedes: sup.entry.id })
  service.save({ content: '检索测试 过期条目', scope: 'global', origin: 'manual', expires: '2020-01-01' })
  const arch = service.save({ content: '检索测试 归档条目', scope: 'global', origin: 'manual' })
  service.update({ id: arch.entry.id, archived: true })
  const part = service.searchDetailed({ query: '检索测试', scope: 'global', includeSuperseded: true })
  assert.equal(part.entries.length, 3)
  assert.deepEqual(part.hidden, { superseded: 0, expired: 1, archived: 1, total: 2 })
  const all = service.searchDetailed({ query: '检索测试', scope: 'global', includeSuperseded: true, includeExpired: true, includeArchived: true })
  assert.equal(all.entries.length, 5)
  assert.equal(all.hidden.total, 0)
})

test('searchDetailed counts a superseded+archived entry under superseded (first exclusion reason)', () => {
  const { service } = tmpService()
  const e = service.save({ content: '优先级测试 条目', scope: 'global', origin: 'manual' })
  service.update({ id: e.entry.id, archived: true })
  service.save({ content: '优先级测试 取代者', scope: 'global', origin: 'manual', supersedes: e.entry.id })
  const res = service.searchDetailed({ query: '优先级测试', scope: 'global' })
  assert.equal(res.entries.length, 1)
  assert.deepEqual(res.hidden, { superseded: 1, expired: 0, archived: 0, total: 1 })
})

test('searchDetailed offset paginates disjoint pages; hidden independent of pagination', () => {
  const { service } = tmpService()
  for (let i = 0; i < 5; i++) service.save({ content: `分页测试 条目${i}`, scope: 'global', origin: 'manual' })
  const p0 = service.searchDetailed({ query: '分页测试', scope: 'global', limit: 2, offset: 0 })
  const p2 = service.searchDetailed({ query: '分页测试', scope: 'global', limit: 2, offset: 2 })
  const p4 = service.searchDetailed({ query: '分页测试', scope: 'global', limit: 2, offset: 4 })
  assert.equal(p0.entries.length, 2)
  assert.equal(p2.entries.length, 2)
  assert.equal(p4.entries.length, 1)
  const ids0 = p0.entries.map((e) => e.id)
  assert.ok(!p2.entries.some((e) => ids0.includes(e.id)), 'pages must be disjoint')
  assert.equal(p0.hidden.total, 0)
})

test('searchDetailed empty query lists all and counts all hidden', () => {
  const { service } = tmpService()
  service.save({ content: '空查询 活跃', scope: 'global', origin: 'manual' })
  const a = service.save({ content: '空查询 归档', scope: 'global', origin: 'manual' })
  service.update({ id: a.entry.id, archived: true })
  const res = service.searchDetailed({ query: '', scope: 'global' })
  assert.equal(res.entries.length, 1)
  assert.deepEqual(res.hidden, { superseded: 0, expired: 0, archived: 1, total: 1 })
})

test('searchResultEntry omits undefined sparse fields so output is lossless JSON', () => {
  const base = { id: 'm-x', scope: 'global', category: 'fact', content: 'c', tags: [], updated: '2026-01-01T00:00:00.000Z' }
  const sparse = searchResultEntry(base)
  assert.ok(!('pinned' in sparse) && !('expires' in sparse) && !('archived' in sparse) && !('superseded_by' in sparse))
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(sparse))), JSON.stringify(sparse), 'sparse output must round-trip losslessly')
  const full = searchResultEntry({ ...base, origin: 'auto', pinned: true, expires: '2026-12-31', archived: true, superseded_by: 'm-y' })
  assert.equal(full.pinned, true)
  assert.equal(full.superseded_by, 'm-y')
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(full))), JSON.stringify(full), 'full output must round-trip losslessly')
})
