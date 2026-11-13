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
import { serializeEntry, clearEntryCache } from '../lib/store.js'

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

test('small libraries keep the strict stat-verified path (no caching)', (t) => {
  const root = tmpRoot()
  t.after(() => { clearEntryCache(); fs.rmSync(root, { recursive: true, force: true }) })
  const service = createMemoryService({ root })
  for (let i = 0; i < 12; i += 1) service.save({ content: `小库条目 ${i}`, scope: 'global' })
  const { result, calls } = countStats(() => service.list({ scope: 'global' }))
  assert.equal(result.length, 12)
  assert.ok(calls >= 12, `small dirs must verify each file (stats=${calls})`)
})