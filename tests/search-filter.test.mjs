/**
 * dsh-memory 0.21.0：检索精确过滤（origin 来源 / tag 标签）。
 * 缝 1（store.filterEntries）＋缝 1（service.searchDetailed）＋缝 3（GET /entries）。
 * 运行 Run: node --test tests/search-filter.test.mjs
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-search-filter-'))
}

test('filterEntries filters by origin (manual/auto, lazy default manual)', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '手动甲', scope: 'global', origin: 'manual' })
  store.saveEntry(root, { content: '自动乙', scope: 'global', origin: 'auto' })
  store.saveEntry(root, { content: '缺省丙', scope: 'global' })
  const auto = store.filterEntries(root, { scope: 'global', origin: 'auto' })
  assert.equal(auto.length, 1)
  assert.equal(auto[0].content, '自动乙')
  assert.equal(store.filterEntries(root, { scope: 'global', origin: 'manual' }).length, 2)
  assert.equal(store.filterEntries(root, { scope: 'global' }).length, 3, 'no origin filter keeps all')
})

test('filterEntries filters by tag (case-insensitive exact match)', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '甲', scope: 'global', tags: ['Git', 'proxy'] })
  store.saveEntry(root, { content: '乙', scope: 'global', tags: ['pnpm'] })
  const git = store.filterEntries(root, { scope: 'global', tag: 'git' })
  assert.equal(git.length, 1)
  assert.equal(git[0].content, '甲')
  assert.equal(store.filterEntries(root, { scope: 'global', tag: 'PROXY' }).length, 1)
  assert.equal(store.filterEntries(root, { scope: 'global', tag: 'nonexistent' }).length, 0)
})

test('filterEntries combines origin and tag filters', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '自动git', scope: 'global', origin: 'auto', tags: ['git'] })
  store.saveEntry(root, { content: '手动git', scope: 'global', origin: 'manual', tags: ['git'] })
  store.saveEntry(root, { content: '自动pnpm', scope: 'global', origin: 'auto', tags: ['pnpm'] })
  const res = store.filterEntries(root, { scope: 'global', origin: 'auto', tag: 'git' })
  assert.equal(res.length, 1)
  assert.equal(res[0].content, '自动git')
})

test('service.searchDetailed applies origin and tag filters', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '自动 Git 甲', scope: 'global', origin: 'auto', tags: ['git'] })
  service.save({ content: '手动 Git 乙', scope: 'global', origin: 'manual', tags: ['git'] })
  const res = service.searchDetailed({ scope: 'global', origin: 'auto', tag: 'git' })
  assert.equal(res.entries.length, 1)
  assert.equal(res.entries[0].content, '自动 Git 甲')
})

test('GET /entries honors origin and tag params', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '自动甲', scope: 'global', origin: 'auto', tags: ['git'] })
  service.save({ content: '手动乙', scope: 'global', origin: 'manual', tags: ['git'] })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.21.0-test' })
  const req = {
    method: 'GET',
    url: '/plugins/dsh-memory/entries?origin=auto&tag=git',
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers.entries(req, res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].content, '自动甲')
})
