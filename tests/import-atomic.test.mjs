/**
 * dsh-memory 0.24.16：导入落盘原子性（全成或零变更）。
 * - 中途 IO 失败（目标目录被同名文件占用）→ 不留下部分写入、已覆盖内容可回滚；
 * - 错误结构化（code=io，文案不含本机绝对路径），锁被释放；
 * - 修复阻塞后可正常重新导入。
 * 运行 Run: node --test tests/import-atomic.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

const WS = 'D:\\proj\\import-atomic'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-atomic-'))
  return { root, service: createMemoryService({ root }) }
}

/** 放一个「同名文件」阻塞 workspaces/<key> 目录创建，制造落盘阶段 IO 失败。 */
function blockWorkspaceDir(root, key) {
  const base = path.join(root, 'workspaces')
  fs.mkdirSync(base, { recursive: true })
  const blocker = path.join(base, key)
  assert.equal(fs.existsSync(blocker), false, 'blocker path must be free')
  fs.writeFileSync(blocker, 'blocker', 'utf8')
  return blocker
}

function findFiles(dir, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) findFiles(full, out)
    else out.push(full)
  }
  return out
}

test('failed import is all-or-nothing: no partial writes, structured io error, lock released', () => {
  const { root, service } = tmpService()
  const key = store.workspaceKey(WS)
  const blocker = blockWorkspaceDir(root, key)
  let err = null
  try {
    service.import({
      entries: [
        { content: '原子导入全局', scope: 'global' },
        { content: '原子导入工作区', scope: 'workspace', workspaceKey: key },
      ],
    })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'import must fail')
  assert.equal(err.code, 'io')
  assert.ok(!String(err.message).includes(root), 'error message must not leak absolute path')
  // 零变更：全局条目一个都没落盘（旧实现会留下第一条）。
  const globals = fs.existsSync(path.join(root, 'global')) ? fs.readdirSync(path.join(root, 'global')).filter((n) => n.endsWith('.md')) : []
  assert.deepEqual(globals, [])
  // 无临时文件残留。
  const leftovers = findFiles(root).filter((f) => f.includes('.tmp-imp-'))
  assert.deepEqual(leftovers, [])
  // 修复阻塞后可正常导入（说明导入锁已释放）。
  fs.rmSync(blocker, { force: true })
  const res = service.import({ entries: [{ content: '重试导入', scope: 'global' }] })
  assert.equal(res.imported, 1)
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('failed import leaves merge-update target content unchanged', () => {
  const { root, service } = tmpService()
  const { entry } = service.save({ content: '原始内容', scope: 'global' })
  const key = store.workspaceKey(WS)
  blockWorkspaceDir(root, key)
  assert.throws(() => service.import({
    mode: 'merge',
    entries: [
      { id: entry.id, content: '合并改写', scope: 'global' },
      { content: '工作区失败条目', scope: 'workspace', workspaceKey: key },
    ],
  }), (e) => e.code === 'io')
  const after = service.list({ scope: 'global' })
  assert.equal(after.length, 1)
  assert.equal(after[0].content, '原始内容', 'merge target must not be overwritten by a failed batch')
})

test('import repairs dangling supersede pointers; in-batch forward refs are kept', () => {
  const { root, service } = tmpService()
  const res = service.import({ entries: [
    { id: 'm-dangle-a', content: '悬垂指针甲', scope: 'global', supersedes: 'm-missing-1' },
    { id: 'm-dangle-b', content: '悬垂指针乙', scope: 'global', superseded_by: 'm-missing-2' },
    { id: 'm-dangle-c', content: '前向引用丙', scope: 'global', superseded_by: 'm-dangle-d' },
    { id: 'm-dangle-d', content: '前向引用丁', scope: 'global' },
  ] })
  assert.equal(res.repaired, 2)
  assert.equal(res.imported, 4)
  const visible = service.search({ scope: 'global' }).map((e) => e.id).sort()
  assert.deepEqual(visible, ['m-dangle-a', 'm-dangle-b', 'm-dangle-d'], 'dangling pointers repaired, forward ref hidden')
  // 批内前向引用保留（目标在同批，导入后可见）。
  const all = store.listScope(root, 'global', undefined)
  const c = all.find((e) => e.id === 'm-dangle-c')
  assert.equal(c.superseded_by, 'm-dangle-d')
})

test('import rejects self/cycle/unreachable supersede pointers (never permanently hidden)', () => {
  const { root, service } = tmpService()
  // 先落盘一个无关 global 目标（没有反向 supersedes）与一个工作区目标。
  const seed = service.import({ entries: [
    { id: 'm-bad-unrelated', content: '无关目标', scope: 'global' },
    { id: 'm-bad-ws-target', content: '其它工作区目标', scope: 'workspace', workspace: WS },
  ] })
  assert.equal(seed.repaired, 0)
  const res = service.import({ entries: [
    { id: 'm-bad-self', content: '自指条目', scope: 'global', superseded_by: 'm-bad-self' },
    { id: 'm-bad-cycle-a', content: '环甲', scope: 'global', superseded_by: 'm-bad-cycle-b' },
    { id: 'm-bad-cycle-b', content: '环乙', scope: 'global', superseded_by: 'm-bad-cycle-a' },
    { id: 'm-bad-scope', content: 'global 指向别的工作区', scope: 'global', superseded_by: 'm-bad-ws-target' },
    { id: 'm-bad-unrelated-succ', content: '指向无关既有目标', scope: 'global', superseded_by: 'm-bad-unrelated' },
  ] })
  assert.equal(res.repaired, 5, JSON.stringify({ repaired: res.repaired, entries: res.entries?.map((e) => [e.id, e.superseded_by]) }))
  const all = store.listScope(root, 'global', undefined)
  for (const id of ['m-bad-self', 'm-bad-cycle-a', 'm-bad-cycle-b', 'm-bad-scope', 'm-bad-unrelated-succ']) {
    assert.equal(all.find((e) => e.id === id).superseded_by, undefined, `${id} must not stay hidden`)
  }
  const visibleIds = service.search({ scope: 'global', limit: 50 }).map((e) => e.id)
  for (const id of ['m-bad-self', 'm-bad-cycle-a', 'm-bad-cycle-b', 'm-bad-scope', 'm-bad-unrelated-succ']) {
    assert.ok(visibleIds.includes(id), `${id} visible`)
  }
})

test('import sanitizes newline-bearing frontmatter fields (no field injection)', () => {
  const { root, service } = tmpService()
  service.import({ entries: [{
    id: 'm-inject-src',
    content: '换行注入测试',
    scope: 'global',
    source: 'sess-1\narchived: true\npinned: true',
    superseded_at: '2026-01-01T00:00:00.000Z\narchived: true',
  }] })
  const file = path.join(root, 'global', 'm-inject-src.md')
  const text = fs.readFileSync(file, 'utf8')
  const fmLines = text.split('\n').filter((line) => /^(archived|pinned):/.test(line))
  assert.deepEqual(fmLines, [], 'no injected frontmatter fields')
  const parsed = store.findEntry(root, 'm-inject-src', undefined)
  assert.equal(parsed.archived, undefined)
  assert.equal(parsed.pinned, undefined)
  assert.equal(service.search({ scope: 'global' }).some((e) => e.id === 'm-inject-src'), true, 'entry remains visible')
})

test('import materializes cross-scope chains (workspace successor hides global predecessor)', () => {
  const { root, service } = tmpService()
  const cwd = 'D:\\proj\\alpha'
  const p = service.save({ content: '全局旧结论', scope: 'global' })
  // 部分视图导出：工作区条目 S 声称取代全局 P；导入时 P 已在盘上、且未声明反向。
  const res = service.import({ entries: [{ id: 'm-cross-s', content: '工作区新结论', scope: 'workspace', workspace: cwd, supersedes: p.entry.id }] })
  assert.equal(res.repaired, 0)
  const diskP = service.search({ scope: 'global', includeSuperseded: true, limit: 10 }).find((e) => e.id === p.entry.id)
  assert.equal(diskP.superseded_by, 'm-cross-s')
  assert.ok(!service.search({ scope: 'all', workspace: cwd, limit: 50 }).some((e) => e.id === p.entry.id), 'global predecessor hidden after workspace import')
})

test('import treats case-variant ids as the same file (Windows case-insensitive FS)', () => {
  const { root, service } = tmpService()
  const res = service.import({ entries: [
    { id: 'm-case-AAAAAA', content: '大小写甲', scope: 'global' },
    { id: 'm-case-aaaaaa', content: '大小写乙', scope: 'global' },
  ] })
  assert.equal(res.imported, 2, 'both entries imported')
  const files = fs.readdirSync(path.join(root, 'global')).filter((n) => n.endsWith('.md'))
  assert.equal(files.length, 2, 'two distinct files (no silent overwrite)')
  assert.equal(new Set(files.map((n) => n.toLowerCase())).size, 2)
  const contents = service.list({ scope: 'global' }).map((e) => e.content).sort()
  assert.deepEqual(contents, ['大小写乙', '大小写甲'])
})

test('merge import with a case-variant id updates the on-disk file instead of duplicating', () => {
  const { root, service } = tmpService()
  const saved = service.save({ content: '大小写合并初版', scope: 'global' })
  const variantId = saved.entry.id.toUpperCase()
  const res = service.import({ mode: 'merge', entries: [{ id: variantId, content: '大小写合并新版', scope: 'global' }] })
  assert.equal(res.updated, 1)
  const files = fs.readdirSync(path.join(root, 'global')).filter((n) => n.endsWith('.md'))
  assert.equal(files.length, 1, 'no duplicate file for case-variant id')
  const entries = service.list({ scope: 'global' }).filter((e) => e.id.toLowerCase() === saved.entry.id.toLowerCase())
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, '大小写合并新版')
})

test('import enforces per-request entry cap (1000)', () => {
  const { service } = tmpService()
  const entries = Array.from({ length: 1001 }, (_, i) => ({ id: `m-cap-${i}`, content: `上限 ${i}`, scope: 'global' }))
  assert.throws(() => service.import({ entries, dryRun: true }), (err) => err.code === 'invalid' && /1000/.test(err.message))
})

test('import with importId requires a valid integer chunkIndex (no silent receipt collision)', () => {
  const { root, service } = tmpService()
  const first = service.import({ entries: [{ id: 'm-chk-0', content: '片零', scope: 'global' }], importId: 'run-chk', chunkIndex: 0 })
  assert.equal(first.imported, 1)
  // 字符串/缺省 chunkIndex 不得被归零后撞上第 0 片回执而静默跳过写盘。
  assert.throws(() => service.import({ entries: [{ id: 'm-chk-1', content: '片一字符串', scope: 'global' }], importId: 'run-chk', chunkIndex: '1' }), (err) => err.code === 'invalid')
  assert.throws(() => service.import({ entries: [{ id: 'm-chk-2', content: '片二缺省', scope: 'global' }], importId: 'run-chk' }), (err) => err.code === 'invalid')
  assert.ok(!store.findEntry(root, 'm-chk-1'), 'string chunkIndex entry must not be silently skipped')
  assert.ok(!store.findEntry(root, 'm-chk-2'), 'missing chunkIndex entry must not be silently skipped')
  const replay = service.import({ entries: [{ id: 'm-chk-0', content: '片零', scope: 'global' }], importId: 'run-chk', chunkIndex: 0 })
  assert.equal(replay.cached, true)
  // 无 importId 时 chunkIndex 缺省仍向后兼容。
  const plain = service.import({ entries: [{ id: 'm-chk-3', content: '无回执', scope: 'global' }] })
  assert.equal(plain.imported, 1)
})

test('import normalizes impossible created/updated timestamps instead of persisting them', () => {
  const { root, service } = tmpService()
  const bad = '2026-13-99T99:99:00Z'
  const result = service.import({ entries: [{ id: 'm-baddate', content: '坏日期导入', scope: 'global', created: bad, updated: bad }] })
  assert.equal(result.imported, 1)
  const entry = store.findEntry(root, 'm-baddate')
  assert.ok(entry, 'entry should be imported')
  assert.notEqual(entry.created, bad)
  assert.notEqual(entry.updated, bad)
  assert.ok(Number.isFinite(Date.parse(entry.created)), 'created must be a real date')
  assert.ok(Number.isFinite(Date.parse(entry.updated)), 'updated must be a real date')
})

test('search and entries clamp absurd limits (tool 200 / route 1000)', () => {
  const { service } = tmpService()
  const batch = (n, offset) => Array.from({ length: n }, (_, i) => ({ id: `m-lim-${offset + i}`, content: `限额条目 ${offset + i}`, scope: 'global' }))
  service.import({ entries: batch(1000, 0) })
  service.import({ entries: batch(50, 1000) })
  const tool = service.search({ query: '', limit: 1e6 })
  assert.equal(tool.length, 200, 'tool search must clamp to 200')
  const route = service.searchDetailed({ query: '', limit: 1e6 })
  assert.equal(route.entries.length, 1000, 'route entries must clamp to 1000')
})

test('H5: import receipts survive a service restart (cross-instance merge replay safety)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-receipt-'))
  const a = createMemoryService({ root })
  const entries = [{ id: 'm-restart-1', content: '重启回执', scope: 'global' }]
  const first = a.import({ entries, importId: 'run-restart', chunkIndex: 0, mode: 'merge' })
  assert.equal(first.imported, 1)
  // 模拟宿主重启/插件重载：新 service 实例必须仍能命中回执。
  const b = createMemoryService({ root })
  b.update({ id: 'm-restart-1', content: '用户新编辑' })
  const replay = b.import({ entries, importId: 'run-restart', chunkIndex: 0, mode: 'merge' })
  assert.equal(replay.cached, true, 'replay after restart must hit the persisted receipt')
  assert.equal(store.findEntry(root, 'm-restart-1').content, '用户新编辑', 'merge replay must not roll back user edits')
})

test('H13: import cycle repair clears both superseded_by and mutual supersedes', () => {
  const { root, service } = tmpService()
  const result = service.import({
    entries: [
      { id: 'm-cyc-a', content: '环甲', scope: 'global', supersedes: 'm-cyc-b' },
      { id: 'm-cyc-b', content: '环乙', scope: 'global', supersedes: 'm-cyc-a' },
    ],
  })
  assert.equal(result.imported, 2)
  assert.ok(result.repaired >= 2)
  const a = store.findEntry(root, 'm-cyc-a')
  const b = store.findEntry(root, 'm-cyc-b')
  assert.ok(!a.superseded_by && !a.supersedes, 'A pointers must both be cleared')
  assert.ok(!b.superseded_by && !b.supersedes, 'B pointers must both be cleared (no mutual supersedes residue)')
})

test('importId replay returns the first receipt and never re-writes (merge retry safety)', () => {
  const { service } = tmpService()
  const entries = [{ id: 'm-idem-a', content: '幂等初始内容', scope: 'global' }]
  const first = service.import({ entries, importId: 'run-idem-1', chunkIndex: 0 })
  assert.equal(first.imported, 1)
  service.update({ id: 'm-idem-a', content: '用户重试窗口内新写入的内容' })
  const replay = service.import({ entries, importId: 'run-idem-1', chunkIndex: 0 })
  assert.equal(replay.cached, true)
  assert.equal(replay.imported, 1, 'receipt reports original result')
  const current = service.list({ scope: 'global' }).find((e) => e.id === 'm-idem-a')
  assert.equal(current.content, '用户重试窗口内新写入的内容', 'user edit must not be rolled back by replay')
})

test('import receipts are LRU-bounded', () => {
  const { service } = tmpService()
  for (let i = 0; i < 205; i++) {
    service.import({ entries: [{ id: `m-recout-${i}`, content: `回执 ${i}`, scope: 'global' }], importId: `run-out-${i}`, chunkIndex: 0 })
  }
  const replay = service.import({ entries: [{ id: 'm-recout-0', content: '回执 0', scope: 'global' }], importId: 'run-out-0', chunkIndex: 0 })
  assert.notEqual(replay.cached, true, 'oldest receipt evicted, replay re-executes')
})

test('import materializes supersede relations in the same atomic batch', () => {
  const { service } = tmpService()
  // 批内前向：新条目 supersedes 旧条目，旧条目自动补 superseded_by。
  const forward = service.import({ entries: [
    { id: 'm-mat-p', content: '批内前驱', scope: 'global' },
    { id: 'm-mat-s', content: '批内后继', scope: 'global', supersedes: 'm-mat-p' },
  ] })
  assert.equal(forward.repaired, 0)
  const p = service.search({ scope: 'global', includeSuperseded: true, limit: 50 }).find((e) => e.id === 'm-mat-p')
  assert.equal(p.superseded_by, 'm-mat-s')
  assert.ok(!service.search({ scope: 'global', limit: 50 }).some((e) => e.id === 'm-mat-p'), 'predecessor hidden')
  // 磁盘既有目标：导入的后继取代它时，目标文件补写反向指针（同批原子写）。
  service.import({ entries: [{ id: 'm-mat-disk-p', content: '磁盘前驱', scope: 'global' }] })
  const diskSucc = service.import({ entries: [{ id: 'm-mat-disk-s', content: '磁盘后继', scope: 'global', supersedes: 'm-mat-disk-p' }] })
  assert.equal(diskSucc.repaired, 0)
  const diskP = service.search({ scope: 'global', includeSuperseded: true, limit: 50 }).find((e) => e.id === 'm-mat-disk-p')
  assert.equal(diskP.superseded_by, 'm-mat-disk-s')
  assert.ok(!service.search({ scope: 'global', limit: 50 }).some((e) => e.id === 'm-mat-disk-p'))
})

test('import drops a supersede claim when the disk target already has a different successor', () => {
  const { service } = tmpService()
  const p = service.save({ content: '已被取代的磁盘目标', scope: 'global' })
  service.save({ content: '已有后继', scope: 'global', supersedes: p.entry.id })
  const res = service.import({ entries: [{ id: 'm-mat-conflict', content: '冲突后继', scope: 'global', supersedes: p.entry.id }] })
  assert.equal(res.repaired, 1)
  const imported = service.search({ scope: 'global', includeSuperseded: true, limit: 50 }).find((e) => e.id === 'm-mat-conflict')
  assert.equal(imported.supersedes, undefined, 'conflicting claim dropped instead of overwriting chain')
})

test('merge import cannot create duplicate content in the same scope', () => {
  const { service } = tmpService()
  const a = service.save({ content: '内容 X', scope: 'global' })
  service.save({ content: '内容 Y', scope: 'global' })
  const res = service.import({ mode: 'merge', entries: [{ id: a.entry.id, content: '内容 Y', scope: 'global' }] })
  assert.equal(res.updated, 0)
  assert.equal(res.deduplicated, 1)
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.content === '内容 Y').length, 1)
})

test('successful batch import writes all entries and refreshes workspace index', () => {
  const { root, service } = tmpService()
  const res = service.import({
    entries: [
      { content: '批量甲', scope: 'global' },
      { content: '批量乙', scope: 'workspace', workspace: WS },
    ],
  })
  assert.equal(res.imported, 2)
  assert.equal(service.list({ scope: 'global' }).length, 1)
  assert.equal(store.listScope(root, 'workspace', WS).length, 1)
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'index.json')))
})