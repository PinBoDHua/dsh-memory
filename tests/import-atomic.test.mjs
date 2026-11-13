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

test('import enforces per-request entry cap (1000)', () => {
  const { service } = tmpService()
  const entries = Array.from({ length: 1001 }, (_, i) => ({ id: `m-cap-${i}`, content: `上限 ${i}`, scope: 'global' }))
  assert.throws(() => service.import({ entries, dryRun: true }), (err) => err.code === 'invalid' && /1000/.test(err.message))
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