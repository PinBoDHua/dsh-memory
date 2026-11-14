/**
 * dsh-memory 原子写重试回归（第九轮审计）：Windows 上杀软/索引器/同步盘会短暂
 * 占用 rename 目标（EPERM/EACCES/EBUSY，实测全套测试并发负载下 1/120 触发），
 * 无重试时 best-effort 路径（命中账本 touchAccess）会把那次更新静默丢掉
 * （「双进程并发账本测试」偶发丢一条），写路径则误报 io。
 * 运行 Run: node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-atomic-'))
}

// fs 是 CJS 模块对象：属性补丁对 lib/store.js 生效（同一对象引用，运行时查表）。
// 只让「目标路径匹配 dest」的前 failures 次 rename 抛瞬时错误，其余照常。
function patchRenameFor(dest, failures, code = 'EPERM') {
  const orig = fs.renameSync
  let calls = 0
  fs.renameSync = function (from, to) {
    if (String(to) === String(dest) && calls < failures) {
      calls += 1
      const err = new Error(`patched ${code} #${calls}`)
      err.code = code
      throw err
    }
    return orig.call(fs, from, to)
  }
  return () => { fs.renameSync = orig }
}

// 注入所有 rename（saveEntry 的条目 id 是随机生成的，无法按目标路径精确匹配）。
function patchRenameAll(failures, code = 'EPERM') {
  const orig = fs.renameSync
  let calls = 0
  fs.renameSync = function (from, to) {
    if (calls < failures) {
      calls += 1
      const err = new Error(`patched ${code} #${calls}`)
      err.code = code
      throw err
    }
    return orig.call(fs, from, to)
  }
  return () => { fs.renameSync = orig }
}

test('atomicWrite retries transient EPERM on rename and succeeds', () => {
  const root = tmpRoot()
  const file = path.join(root, 'x.json')
  const restore = patchRenameFor(file, 2)
  try {
    store.atomicWrite(file, 'ok')
    assert.equal(fs.readFileSync(file, 'utf8'), 'ok')
  } finally { restore() }
})

test('atomicWrite does not retry non-transient errors and cleans up tmp', () => {
  const root = tmpRoot()
  const file = path.join(root, 'y.json')
  const restore = patchRenameFor(file, 99, 'ENOENT')
  try {
    assert.throws(() => store.atomicWrite(file, 'x'), (err) => err.code === 'io')
  } finally { restore() }
  // 失败路径清理临时文件：不在数据目录留 .tmp-* 垃圾（原子写契约）。
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('y.json.tmp-')), [])
})

test('atomicWrite failures are sanitized: no local absolute path in message (H2)', () => {
  const root = tmpRoot()
  const file = path.join(root, 'z.json')
  // 重试耗尽（4 次 EPERM）后仍失败：错误必须脱敏（code=io、固定文案），
  // 原始错误挂 cause——宿主工具路径会把 error.message 原样发给模型。
  const restore = patchRenameFor(file, 99)
  try {
    assert.throws(() => store.atomicWrite(file, 'x'), (err) => {
      assert.equal(err.code, 'io')
      assert.ok(!String(err.message).includes(root), `message must not leak local path: ${err.message}`)
      assert.equal(err.cause?.code, 'EPERM', 'original error preserved on cause')
      return true
    })
  } finally { restore() }
})

test('saveEntry write failure surfaces a sanitized io error (tool path, H2)', () => {
  const root = tmpRoot()
  // saveEntry 的条目 id 是随机生成的，无法按目标路径精确匹配：注入所有 rename。
  // 重试耗尽后仍失败：错误必须脱敏（code=io、固定文案、不含本机路径）——
  // 宿主工具路径会把 error.message 原样发给模型（原始 SystemError 含绝对路径）。
  const restore = patchRenameAll(99)
  try {
    assert.throws(() => store.saveEntry(root, { content: '写入失败脱敏', scope: 'global', origin: 'manual' }), (err) => {
      assert.equal(err.code, 'io')
      assert.ok(!String(err.message).includes(root), `message must not leak local path: ${err.message}`)
      return true
    })
  } finally { restore() }
  // 失败零残留：条目未落盘。
  assert.deepEqual(fs.readdirSync(path.join(root, 'global')), [])
})

test('touchAccess loses no ledger record when rename fails transiently', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const saved = service.save({ content: '瞬时失败记账', scope: 'global' })
  const restore = patchRenameFor(path.join(root, 'access.json'), 2)
  try {
    store.touchAccess(root, [{ id: saved.entry.id, last_access: '2000-01-01T00:00:00.000Z' }], undefined, Date.parse('2026-11-14T12:00:00.000Z'))
  } finally { restore() }
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8'))
  assert.ok(ledger[saved.entry.id], 'ledger record persisted despite transient EPERM')
  assert.equal(ledger[saved.entry.id].count, 1)
})

test('import survives a transient EPERM during batch commit', () => {
  const root = tmpRoot()
  const target = path.join(root, 'global', 'm-import-ep-1.md')
  const restore = patchRenameFor(target, 1)
  let result
  try {
    result = createMemoryService({ root }).import({ entries: [{ content: '导入瞬时失败', scope: 'global', id: 'm-import-ep-1' }] })
  } finally { restore() }
  assert.equal(result.imported, 1)
  assert.ok(fs.existsSync(target))
  assert.equal(store.findEntry(root, 'm-import-ep-1', undefined).content, '导入瞬时失败')
})

test('saveEntry survives a transient EPERM on the entry file', () => {
  const root = tmpRoot()
  // 首次 save 先写 meta.json（ensureMeta，失败被 best-effort 吞掉）再写条目：
  // 第 1 次失败落在 meta、第 2 次落在条目 rename，重试后成功。
  const restore = patchRenameAll(2)
  let out
  try {
    out = store.saveEntry(root, { content: '保存瞬时失败', scope: 'global', origin: 'manual' })
  } finally { restore() }
  assert.equal(out.deduplicated, false)
  assert.ok(fs.existsSync(path.join(root, 'global', `${out.entry.id}.md`)))
})
