/**
 * dsh-memory 0.24.3：读盘性能回归。
 * - 解析缓存：冷读一次、热读零文件 IO；外部编辑/删除按 mtime/ctime/size 失效；
 * - 批量导入：每个作用域只全量读一次建去重映射，避免 O(N×M) 读放大。
 * 运行 Run: node --test tests/cache.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import { createMemoryService } from '../lib/service.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-cache-'))
}

/** 统计 root 下 .md 文件的 readFileSync 次数（临时替换 fs 方法，finally 还原）。 */
function countMdReads(root) {
  const original = fs.readFileSync
  let count = 0
  fs.readFileSync = function (file, ...args) {
    const p = typeof file === 'string' ? file : String(file)
    if (p.startsWith(root) && p.endsWith('.md')) count += 1
    return original.call(this, file, ...args)
  }
  return {
    count: () => count,
    restore: () => { fs.readFileSync = original },
  }
}

test('parsed-entry cache: cold read once, warm reads do no file IO, edits invalidate', () => {
  const root = tmpRoot()
  const ws = path.join(os.tmpdir(), 'dsh-memory-cache-ws')
  store.clearEntryCache()
  const service = createMemoryService({ root })
  for (let i = 0; i < 8; i += 1) service.save({ content: `缓存条目 ${i}`, scope: 'global' })
  for (let i = 0; i < 4; i += 1) service.save({ content: `工作区缓存 ${i}`, scope: 'workspace', workspace: ws })

  // 记录一个将要在测试中手工编辑/删除的文件（避免测试自身读被计入）。
  const globalDir = path.join(root, 'global')
  const names = fs.readdirSync(globalDir)
  const editFile = path.join(globalDir, names[0])
  const originalText = fs.readFileSync(editFile, 'utf8')
  const deleteFile = path.join(globalDir, names[1])
  // save 期间的列表读取已经预热了缓存：先清空，从真正的冷路径开始测。
  store.clearEntryCache()

  const counter = countMdReads(root)
  try {
    const first = store.listAll(root, ws)
    assert.equal(first.length, 12)
    assert.equal(counter.count(), 12, 'cold read: one file read per entry')
    assert.equal(store.listAll(root, ws).length, 12)
    assert.equal(counter.count(), 12, 'warm read: stat-only, no file IO')

    // 模拟编辑器/其它进程手工编辑：签名变化，只重读该文件。
    fs.writeFileSync(editFile, originalText.replace(/缓存条目 \d/, '缓存条目 已编辑'), 'utf8')
    const edited = store.listAll(root, ws)
    assert.equal(counter.count(), 13, 'only the edited file is re-read')
    assert.ok(edited.some((e) => e.content === '缓存条目 已编辑'))

    // 删除文件：缓存同步清理，不再重读。
    fs.rmSync(deleteFile)
    assert.equal(store.listAll(root, ws).length, 11)
    assert.equal(counter.count(), 13, 'deleted file does not cause a read')
  } finally {
    counter.restore()
  }
})

test('search/stats hot path share the cache (no double full read)', () => {
  const root = tmpRoot()
  store.clearEntryCache()
  const service = createMemoryService({ root })
  for (let i = 0; i < 10; i += 1) service.save({ content: `检索缓存 ${i}`, scope: 'global' })
  store.clearEntryCache()
  const counter = countMdReads(root)
  try {
    // stats/searchDetailed 内部会对同一批条目做「可见集＋全量集」两次过滤：
    // 缓存让第二次过滤只 stat 不读文件（旧实现是 2×N 次读）。
    const stats = service.stats({ scope: 'global' })
    assert.equal(stats.total, 10)
    const afterStats = counter.count()
    assert.ok(afterStats <= 10, `stats reads=${afterStats} (was 2×N before cache)`)
    const detailed = service.searchDetailed({ query: '检索缓存', scope: 'global' })
    assert.ok(detailed.entries.length === 10)
    // searchDetailed 会写命中簿记（touchAccess 直读最新文件，N 次）＋缓存命中，不再重复解析。
    assert.ok(counter.count() <= afterStats + 10, `searchDetailed added=${counter.count() - afterStats}`)
  } finally {
    counter.restore()
  }
})

test('batch import reads each scope once instead of O(N×M)', () => {
  const root = tmpRoot()
  store.clearEntryCache()
  const service = createMemoryService({ root })
  for (let i = 0; i < 60; i += 1) service.save({ content: `既有记忆 ${i}`, scope: 'global' })
  store.clearEntryCache()
  const counter = countMdReads(root)
  try {
    const res = service.import({ entries: Array.from({ length: 60 }, (_, i) => ({ content: `导入记忆 ${i}`, scope: 'global' })) })
    assert.equal(res.imported, 60)
    const reads = counter.count()
    // 旧实现每条导入都 listScope 全量读：约 60×60=3600 次；单次预读为 ~60 次。
    assert.ok(reads <= 150, `reads=${reads}, expected about 60 (not quadratic)`)
  } finally {
    counter.restore()
  }
})

test('batch import across two scopes still reads each scope only once', () => {
  const root = tmpRoot()
  const ws = path.join(os.tmpdir(), 'dsh-memory-cache-import-ws')
  store.clearEntryCache()
  const service = createMemoryService({ root })
  for (let i = 0; i < 40; i += 1) service.save({ content: `全局既有 ${i}`, scope: 'global' })
  for (let i = 0; i < 40; i += 1) service.save({ content: `工作区既有 ${i}`, scope: 'workspace', workspace: ws })
  store.clearEntryCache()
  const counter = countMdReads(root)
  try {
    const res = service.import({ entries: [
      ...Array.from({ length: 40 }, (_, i) => ({ content: `全局导入 ${i}`, scope: 'global' })),
      ...Array.from({ length: 40 }, (_, i) => ({ content: `工作区导入 ${i}`, scope: 'workspace', workspace: ws })),
    ] })
    assert.equal(res.imported, 80)
    const reads = counter.count()
    assert.ok(reads <= 200, `reads=${reads}, expected about 80 (not quadratic)`)
  } finally {
    counter.restore()
  }
})

test('import dedupe still detects existing and in-batch duplicates after map refactor', () => {
  const root = tmpRoot()
  store.clearEntryCache()
  const service = createMemoryService({ root })
  service.save({ content: '已有内容甲', scope: 'global', origin: 'manual' })
  const res = service.import({ entries: [
    { content: '已有内容甲', scope: 'global' }, // 与既有重复
    { content: '批内内容乙', scope: 'global' },
    { content: ' 批内内容乙 ', scope: 'global' }, // 批内重复
  ] })
  assert.equal(res.imported, 1)
  assert.equal(res.deduplicated, 2)
  assert.equal(service.list({ scope: 'global' }).length, 2)
})