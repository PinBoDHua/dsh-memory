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