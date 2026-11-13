/**
 * 大目录列表缓存（30k 库热路径）：缓存构建后读路径不再逐文件 stat，
 * 本进程写入/删除即时生效，外部手工编辑由 fs.watch 增量同步。
 * 运行 Run: node --test tests/directory-cache.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { serializeEntry, clearEntryCache, flushSnapshotIndex } from '../lib/store.js'

const THRESHOLD = 1024

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-dircache-'))
}

function seedLarge(root, count = THRESHOLD + 60) {
  const dir = path.join(root, 'global')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  for (let i = 0; i < count; i += 1) {
    const entry = { id: `m-cache-${i}`, category: 'fact', scope: 'global', tags: [], created: now, updated: now, source: '', content: `大目录缓存条目 ${i}` }
    fs.writeFileSync(path.join(dir, `${entry.id}.md`), serializeEntry(entry), 'utf8')
  }
  return count
}

function countStats(fn) {
  const real = fs.statSync
  let calls = 0
  fs.statSync = function (...args) {
    calls += 1
    return real.apply(fs, args)
  }
  try {
    const result = fn()
    return { result, calls }
  } finally {
    fs.statSync = real
  }
}

test('large directory: cached list skips per-file stat and stays correct', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root)
  const service = createMemoryService({ root })
  const first = service.list({ scope: 'global' })
  assert.equal(first.length, total, 'cold build sees every file')
  const { result: second, calls } = countStats(() => service.list({ scope: 'global' }))
  assert.equal(second.length, total)
  assert.ok(calls < 50, `warm list must not stat every file (stats=${calls} for ${total} files)`)
})

test('large directory: in-process writes/deletes patch the cache without a full rescan', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  seedLarge(root)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' }) // build cache
  const created = service.save({ content: '缓存增量写入', scope: 'global' })
  const { result: afterSave, calls } = countStats(() => service.list({ scope: 'global' }))
  assert.ok(afterSave.some((e) => e.id === created.entry.id), 'read-own-write visible immediately')
  assert.ok(calls < 50, `save must patch cache (stats=${calls})`)
  service.forget({ id: created.entry.id })
  const { result: afterForget } = countStats(() => service.list({ scope: 'global' }))
  assert.ok(!afterForget.some((e) => e.id === created.entry.id), 'delete visible immediately')
})

test('large directory: external manual edit is picked up by the watcher', async (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  seedLarge(root)
  const service = createMemoryService({ root })
  const before = service.list({ scope: 'global' })
  assert.ok(before.length >= THRESHOLD)
  const target = path.join(root, 'global', 'm-cache-0.md')
  const entry = before.find((e) => e.id === 'm-cache-0')
  fs.writeFileSync(target, serializeEntry({ ...entry, content: '外部手工编辑后的内容' }), 'utf8')
  let seen = false
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const list = service.list({ scope: 'global' })
    if (list.some((e) => e.id === 'm-cache-0' && e.content === '外部手工编辑后的内容')) { seen = true; break }
  }
  assert.equal(seen, true, 'watcher must refresh a single edited file')
})

function countMdReads(fn) {
  const real = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (target, ...args) {
    if (String(target).endsWith('.md')) reads += 1
    return real.call(fs, target, ...args)
  }
  try {
    const result = fn()
    return { result, reads }
  } finally {
    fs.readFileSync = real
  }
}

test('persistent index: cold start reuses parsed entries without reading markdown files', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  assert.equal(service.list({ scope: 'global' }).length, total)
  const flushed = flushSnapshotIndex(root)
  assert.equal(flushed, total, 'index written with all cached entries')
  const indexFile = path.join(root, '.cache', 'entries-v1.json')
  assert.ok(fs.existsSync(indexFile), 'persistent index file exists')
  // 模拟新进程冷启动：清空进程内缓存，只剩磁盘索引。
  clearEntryCache()
  const { result, reads } = countMdReads(() => service.list({ scope: 'global' }))
  assert.equal(result.length, total)
  assert.equal(reads, 0, `cold start from index must not read markdown (reads=${reads})`)
})

test('persistent index: changed/deleted/new files are detected by signature check', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  const target = path.join(root, 'global', 'm-cache-0.md')
  const now = new Date().toISOString()
  fs.writeFileSync(target, serializeEntry({ id: 'm-cache-0', category: 'fact', scope: 'global', tags: [], created: now, updated: now, source: '', content: '冷启动索引后的外部修改' }), 'utf8')
  clearEntryCache()
  const { result: changed } = countMdReads(() => service.list({ scope: 'global' }))
  assert.equal(changed.find((e) => e.id === 'm-cache-0').content, '冷启动索引后的外部修改')
  flushSnapshotIndex(root) // 写入更新后的签名，模拟索引随写入刷新
  // 删除一个文件：索引加载时按 readdir 集合判断，不应再出现。
  fs.rmSync(path.join(root, 'global', 'm-cache-1.md'), { force: true })
  clearEntryCache()
  const { result: afterDelete } = countMdReads(() => service.list({ scope: 'global' }))
  assert.equal(afterDelete.length, total - 1)
  assert.ok(!afterDelete.some((e) => e.id === 'm-cache-1'))
  flushSnapshotIndex(root)
  // 新增一个文件：索引没有记录，按签名缺失读取解析。
  fs.writeFileSync(path.join(root, 'global', 'm-cache-new.md'), serializeEntry({ id: 'm-cache-new', category: 'fact', scope: 'global', tags: [], created: now, updated: now, source: '', content: '索引后新增' }), 'utf8')
  clearEntryCache()
  const { result: afterAdd, reads: addReads } = countMdReads(() => service.list({ scope: 'global' }))
  assert.equal(afterAdd.length, total)
  assert.ok(afterAdd.some((e) => e.id === 'm-cache-new'))
  assert.equal(addReads, 1, 'only the new file is parsed')
})

test('persistent index: corrupt index falls back to a full verification parse', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  fs.writeFileSync(path.join(root, '.cache', 'entries-v1.json'), '{not json', 'utf8')
  clearEntryCache()
  const { result, reads } = countMdReads(() => service.list({ scope: 'global' }))
  assert.equal(result.length, total)
  assert.ok(reads >= total, `corrupt index must fall back (reads=${reads})`)
})

test('persistent index: cold start installs the watcher so later external changes stay visible', async (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  clearEntryCache()
  assert.equal(service.list({ scope: 'global' }).length, total) // 冷启动从索引加载
  const editFile = path.join(root, 'global', 'm-cache-2.md')
  fs.writeFileSync(editFile, serializeEntry({ id: 'm-cache-2', category: 'fact', scope: 'global', tags: [], created: new Date().toISOString(), updated: new Date().toISOString(), source: '', content: '冷启动后的外部编辑' }), 'utf8')
  let edited = false
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (service.list({ scope: 'global' }).some((e) => e.id === 'm-cache-2' && e.content === '冷启动后的外部编辑')) { edited = true; break }
  }
  assert.equal(edited, true, 'watcher must be installed when the cold start reuses the index')
  fs.rmSync(path.join(root, 'global', 'm-cache-3.md'), { force: true })
  let deleted = false
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (!service.list({ scope: 'global' }).some((e) => e.id === 'm-cache-3')) { deleted = true; break }
  }
  assert.equal(deleted, true, 'external deletion must be visible after cold start')
})

test('persistent index: unavailable watcher disables index reuse (strict fallback)', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  clearEntryCache()
  const realWatch = fs.watch
  fs.watch = () => { throw new Error('watch unavailable') }
  try {
    const { result, calls } = countStats(() => service.list({ scope: 'global' }))
    assert.equal(result.length, total)
    assert.ok(calls >= total, `strict path must stat every markdown when watcher is unavailable (stats=${calls})`)
    // 严格路径每文件 stat 校验签名：外部编辑仍然可见（无 watcher 也能正确）。
    const editFile = path.join(root, 'global', 'm-cache-4.md')
    fs.writeFileSync(editFile, serializeEntry({ id: 'm-cache-4', category: 'fact', scope: 'global', tags: [], created: new Date().toISOString(), updated: new Date().toISOString(), source: '', content: '无 watcher 时的外部编辑' }), 'utf8')
    assert.ok(service.list({ scope: 'global' }).some((e) => e.id === 'm-cache-4' && e.content === '无 watcher 时的外部编辑'))
  } finally {
    fs.watch = realWatch
  }
})

test('persistent index: unchanged cold start does not rewrite the index; forget scrubs deleted content', async (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const total = seedLarge(root, 1100)
  const service = createMemoryService({ root })
  const list = service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  const indexFile = path.join(root, '.cache', 'entries-v1.json')
  const before = fs.statSync(indexFile).mtimeMs
  clearEntryCache()
  assert.equal(service.list({ scope: 'global' }).length, total)
  await new Promise((resolve) => setTimeout(resolve, 5600))
  assert.equal(fs.statSync(indexFile).mtimeMs, before, 'no-change cold start must not rewrite the index')
  // forget 后立即重写索引：被删除条目的正文不得留在 .cache 里。
  const target = list[0]
  service.forget({ id: target.id })
  const doc = fs.readFileSync(indexFile, 'utf8')
  assert.ok(!doc.includes(target.id), 'deleted id must be gone from the index')
  assert.ok(!doc.includes(target.content), 'deleted content must be gone from the index')
})

test('persistent index: invalid cached entry shape falls back to markdown', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  seedLarge(root, 1100)
  const service = createMemoryService({ root })
  service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  const indexFile = path.join(root, '.cache', 'entries-v1.json')
  const doc = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const records = doc.dirs.global
  records[0].entry = { ...records[0].entry, id: 'm-wrong-id', content: '' }
  fs.writeFileSync(indexFile, JSON.stringify(doc), 'utf8')
  clearEntryCache()
  const list = service.list({ scope: 'global' })
  assert.equal(list.length, 1100)
  assert.ok(list.every((e) => typeof e.content === 'string' && e.content !== ''))
  assert.ok(!list.some((e) => e.id === 'm-wrong-id'), 'bad index record must not leak into results')
})

test('persistent index is deleted when the library drops below the cache threshold (no forgotten content residue)', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  seedLarge(root, 1100)
  const service = createMemoryService({ root })
  const list = service.list({ scope: 'global' })
  flushSnapshotIndex(root)
  const indexFile = path.join(root, '.cache', 'entries-v1.json')
  assert.ok(fs.existsSync(indexFile))
  assert.ok(fs.readFileSync(indexFile, 'utf8').includes(list[0].content))
  const ids = list.map((e) => e.id)
  service.forgetMany({ ids })
  assert.equal(fs.existsSync(indexFile), false, 'index must be removed once the library shrinks below the cache threshold')
  assert.ok(!fs.existsSync(path.join(root, '.cache')) || fs.readdirSync(path.join(root, '.cache')).length === 0)
})

test('small libraries keep the strict stat-verified path (no caching)', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const service = createMemoryService({ root })
  for (let i = 0; i < 12; i += 1) service.save({ content: `小库条目 ${i}`, scope: 'global' })
  const { result, calls } = countStats(() => service.list({ scope: 'global' }))
  assert.equal(result.length, 12)
  assert.ok(calls >= 12, `small dirs must verify each file (stats=${calls})`)
})