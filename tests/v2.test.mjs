/**
 * dsh-memory 0.9.0（schema v2）新增行为测试。
 * 缝 1（store 纯逻辑）＋缝 1（service 公共 API）。
 * 运行 Run: node --test tests/v2.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import { createMemoryService } from '../lib/service.js'
import { detectSecret } from '../lib/guard.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v2-'))
}
function tmpService() {
  const root = tmpRoot()
  return { root, service: createMemoryService({ root }) }
}

// ---------- store：序列化与字段 ----------

test('v2 serialize/parse roundtrip preserves all optional fields', () => {
  const entry = {
    id: 'm-v2-abcdef', category: 'fact', scope: 'global', tags: ['t'],
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z', source: 's',
    content: 'v2 内容', origin: 'auto', supersedes: 'm-old-aaaaaa', superseded_by: 'm-new-bbbbbb',
    superseded_at: '2026-01-03T00:00:00.000Z', expires: '2026-12-31', pinned: true, archived: true,
    last_access: '2026-01-04T00:00:00.000Z', hit_count: 5,
  }
  assert.deepEqual(store.parseEntry(store.serializeEntry(entry), {}), entry)
})

test('normalizeExpires validates format and real calendar dates', () => {
  assert.equal(store.normalizeExpires(''), '')
  assert.equal(store.normalizeExpires(undefined), '')
  assert.equal(store.normalizeExpires('2026-12-31'), '2026-12-31')
  assert.throws(() => store.normalizeExpires('2026-02-30'), (e) => e.code === 'invalid')
  assert.throws(() => store.normalizeExpires('2026-13-01'), (e) => e.code === 'invalid')
  assert.throws(() => store.normalizeExpires('abc'), (e) => e.code === 'invalid')
})

// ---------- store：取代链 ----------

test('saveEntry supersedes marks old hidden, keeps history, includeSuperseded finds both', () => {
  const root = tmpRoot()
  const { entry: old } = store.saveEntry(root, { content: '旧事实', scope: 'global' })
  const { entry: neu } = store.saveEntry(root, { content: '新事实', scope: 'global', supersedes: old.id })
  assert.equal(neu.supersedes, old.id)
  const oldReloaded = store.findEntry(root, old.id, undefined)
  assert.equal(oldReloaded.superseded_by, neu.id)
  assert.ok(oldReloaded.superseded_at)
  assert.equal(store.searchEntries(root, { query: '事实', cwd: undefined }).length, 1)
  assert.equal(store.searchEntries(root, { query: '事实', cwd: undefined, includeSuperseded: true }).length, 2)
})

test('saveEntry supersedes unknown id throws invalid', () => {
  const root = tmpRoot()
  assert.throws(() => store.saveEntry(root, { content: 'x', scope: 'global', supersedes: 'm-nope-000000' }), (e) => e.code === 'invalid')
})

test('saveEntry dedup skips superseded entries (correction flow)', () => {
  const root = tmpRoot()
  const { entry: old } = store.saveEntry(root, { content: '相同内容', scope: 'global' })
  store.saveEntry(root, { content: '相同内容 补充', scope: 'global', supersedes: old.id })
  const { entry: again, deduplicated } = store.saveEntry(root, { content: '相同内容', scope: 'global' })
  assert.equal(deduplicated, false)
  assert.notEqual(again.id, old.id)
})

test('updateEntry supersedes another entry; cannot supersede itself', () => {
  const root = tmpRoot()
  const { entry: a } = store.saveEntry(root, { content: '甲事实', scope: 'global' })
  const { entry: b } = store.saveEntry(root, { content: '乙事实', scope: 'global' })
  store.updateEntry(root, b.id, { supersedes: a.id }, undefined)
  assert.equal(store.findEntry(root, a.id, undefined).superseded_by, b.id)
  assert.equal(store.findEntry(root, b.id, undefined).supersedes, a.id)
  assert.throws(() => store.updateEntry(root, b.id, { supersedes: b.id }, undefined), (e) => e.code === 'invalid')
})

// ---------- store：过期与归档 ----------

test('expiration hides expired by default; bad date fail-open; includeExpired finds all', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '过期事实', scope: 'global', expires: '2020-01-01' })
  store.saveEntry(root, { content: '未来事实', scope: 'global', expires: '2099-01-01' })
  store.writeEntry(root, {
    id: 'm-bad-aaaaaa', category: 'fact', scope: 'global', tags: [],
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', source: '',
    content: '坏日期事实', expires: 'not-a-date',
  }, undefined)
  assert.equal(store.searchEntries(root, { query: '事实', cwd: undefined }).length, 2)
  assert.equal(store.searchEntries(root, { query: '事实', cwd: undefined, includeExpired: true }).length, 3)
})

test('archived hidden by default, includeArchived restores, unarchive works', () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '归档事实', scope: 'global' })
  store.updateEntry(root, entry.id, { archived: true }, undefined)
  assert.equal(store.searchEntries(root, { query: '归档', cwd: undefined }).length, 0)
  assert.equal(store.searchEntries(root, { query: '归档', cwd: undefined, includeArchived: true }).length, 1)
  store.updateEntry(root, entry.id, { archived: false }, undefined)
  assert.equal(store.searchEntries(root, { query: '归档', cwd: undefined }).length, 1)
})

// ---------- store：衰减 ----------

test('decayMultiplier: fresh 1.5, idle weeks reduce, floor 0.3, pinned/disabled exempt', () => {
  const now = Date.parse('2026-11-13T00:00:00.000Z')
  assert.equal(store.decayMultiplier({ updated: '2026-11-13T00:00:00.000Z' }, now, true), 1.5)
  const twoWeeks = store.decayMultiplier({ last_access: '2026-10-30T00:00:00.000Z' }, now, true)
  assert.ok(Math.abs(twoWeeks - 1.2) < 1e-9, `expected ~1.2, got ${twoWeeks}`)
  const old = { last_access: '2026-01-01T00:00:00.000Z' }
  assert.equal(store.decayMultiplier(old, now, true), 0.3)
  assert.equal(store.decayMultiplier(old, now, false), 1)
  assert.equal(store.decayMultiplier({ ...old, pinned: true }, now, true), 1)
})

test('search ranking applies decay: recently-used outranks idle with equal text', () => {
  const root = tmpRoot()
  const now = Date.now()
  store.writeEntry(root, {
    id: 'm-idle-aaaaaa', category: 'fact', scope: 'global', tags: [],
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', source: '',
    content: 'pnpm 构建', last_access: '2026-01-01T00:00:00.000Z',
  }, undefined)
  store.writeEntry(root, {
    id: 'm-fresh-aaaaaa', category: 'fact', scope: 'global', tags: [],
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', source: '',
    content: 'pnpm 构建', last_access: new Date(now).toISOString(),
  }, undefined)
  const hits = store.searchEntries(root, { query: 'pnpm', cwd: undefined, now })
  assert.equal(hits[0].id, 'm-fresh-aaaaaa')
  // disabled decay falls back to updated-desc tiebreak (stable, both equal updated)
  const off = store.searchEntries(root, { query: 'pnpm', cwd: undefined, now, decayEnabled: false })
  assert.equal(off.length, 2)
})

// ---------- store：CJK 检索 ----------

test('CJK bigram fuzzy matching improves recall beyond exact substring', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '记忆插件升级计划', scope: 'global' })
  assert.equal(store.searchEntries(root, { query: '插件升级', cwd: undefined }).length, 1)
  // '记忆升级' is NOT an exact substring, but bigrams 记忆/升级 cover 2/3 ≥ 0.6
  assert.equal(store.searchEntries(root, { query: '记忆升级', cwd: undefined }).length, 1)
  // unrelated CJK query still misses
  assert.equal(store.searchEntries(root, { query: '数据库索引', cwd: undefined }).length, 0)
})

// ---------- store：迁移与命中簿记 ----------

test('migrateSchema bumps v1 meta to v2 without rewriting entry files (idempotent)', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '旧记忆', scope: 'global' })
  const id = store.listScope(root, 'global', undefined)[0].id
  const file = path.join(root, 'global', `${id}.md`)
  const before = fs.readFileSync(file, 'utf8')
  const metaFile = path.join(root, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.schemaVersion = 1
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8')
  assert.equal(store.migrateSchema(root), true)
  assert.equal(store.readMeta(root).schemaVersion, 2)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'entry file untouched (lazy defaults)')
  assert.equal(store.migrateSchema(root), false)
})

test('touchAccess throttles writes to once per hour per entry', () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '命中测试', scope: 'global' })
  const now = Date.parse('2026-11-13T12:00:00.000Z')
  const e1 = store.findEntry(root, entry.id, undefined)
  store.touchAccess(root, [e1], undefined, now)
  assert.equal(e1.hit_count, 1)
  const e2 = store.findEntry(root, entry.id, undefined)
  store.touchAccess(root, [e2], undefined, now + 30 * 60 * 1000)
  assert.equal(e2.hit_count, 1, 'within an hour: no increment')
  const e3 = store.findEntry(root, entry.id, undefined)
  store.touchAccess(root, [e3], undefined, now + 61 * 60 * 1000)
  assert.equal(e3.hit_count, 2, 'after an hour: increment')
})

// ---------- service：公共 API ----------

test('service.save origin=auto + supersedes; search hides superseded by default', () => {
  const { service } = tmpService()
  const { entry: old } = service.save({ content: '旧约定', scope: 'global' })
  const { entry: neu } = service.save({ content: '新约定', scope: 'global', origin: 'auto', supersedes: old.id })
  assert.equal(neu.origin, 'auto')
  assert.equal(neu.supersedes, old.id)
  assert.equal(service.search({ query: '约定' }).length, 1)
  assert.equal(service.search({ query: '约定', includeSuperseded: true }).length, 2)
})

test('service.update archives/restores; save rejects invalid expires', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '可归档', scope: 'global' })
  service.update({ id: entry.id, archived: true })
  assert.equal(service.search({ query: '可归档' }).length, 0)
  assert.equal(service.search({ query: '可归档', includeArchived: true }).length, 1)
  service.update({ id: entry.id, archived: false })
  assert.equal(service.search({ query: '可归档' }).length, 1)
  assert.throws(() => service.save({ content: 'x', scope: 'global', expires: '2026-02-30' }), (e) => e.code === 'invalid')
})

test('service.stats reports byStatus breakdown', () => {
  const { service } = tmpService()
  service.save({ content: '活跃', scope: 'global' })
  service.save({ content: '钉选', scope: 'global', pinned: true })
  const { entry: c } = service.save({ content: '将被归档', scope: 'global' })
  service.update({ id: c.id, archived: true })
  const s = service.stats({})
  assert.equal(s.byStatus.archived, 1)
  assert.equal(s.byStatus.pinned, 1)
  assert.equal(s.byStatus.active, 2)
})

test('service.import preserves v2 optional fields (lossless)', () => {
  const { service } = tmpService()
  service.save({ content: '自动记忆', scope: 'global', origin: 'auto', pinned: true, expires: '2099-01-01' })
  const doc = service.export()
  const fresh = tmpService().service
  fresh.import({ entries: doc.entries })
  const e = fresh.list({ scope: 'global' })[0]
  assert.equal(e.origin, 'auto')
  assert.equal(e.pinned, true)
  assert.equal(e.expires, '2099-01-01')
})

test('service migration forces a backup even when autoBackup is off, zero loss', () => {
  const root = tmpRoot()
  const svc1 = createMemoryService({ root })
  svc1.save({ content: '迁移前记忆', scope: 'global' })
  const metaFile = path.join(root, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.schemaVersion = 1
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8')
  const svc2 = createMemoryService({ root })
  assert.equal(svc2.status().schemaVersion, 2)
  assert.ok(fs.readdirSync(path.join(root, 'backups')).filter((n) => n.endsWith('.json')).length >= 1)
  assert.equal(svc2.list({ scope: 'global' })[0].content, '迁移前记忆')
})

test('service.recallConfig exposes decayEnabled; settings toggle reflects live', () => {
  const { service } = tmpService()
  assert.equal(service.recallConfig().decayEnabled, true)
  service.updateSettings({ decayEnabled: false, autoExtractHint: false })
  assert.equal(service.recallConfig().decayEnabled, false)
  assert.equal(service.settings().effective.autoExtractHint, false)
  service.resetSettings()
  assert.equal(service.recallConfig().decayEnabled, true)
  assert.equal(service.settings().effective.autoExtractHint, true)
})

test('guard: new patterns reject bearer tokens and connection strings with password', () => {
  assert.ok(detectSecret('Authorization: Bearer abcdef1234567890abcdef'))
  assert.ok(detectSecret('postgres://user:supersecretpw@db.example.com:5432/app'))
  assert.ok(detectSecret('mongodb://admin:password123@localhost:27017'))
  assert.equal(detectSecret('使用 Bearer 认证方式调用接口'), null)
  assert.equal(detectSecret('postgres 连接配置见文档'), null)
})
