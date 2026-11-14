/**
 * v0.5.0 缝 5：跨进程写锁 —— mkdir 互斥、超时、陈旧锁自愈。
 * 集成测试用两个真实子进程并发写同一数据根，验证 index.json 不丢键、
 * 条目不丢失。运行 Run: node --test tests/lock.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withLock, touchLock } from '../lib/lock.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-lock-'))
}

test('lock timeout carries code=busy (routes map to 503)', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-busy')
  fs.mkdirSync(lockPath)
  assert.throws(() => withLock(lockPath, () => {}, { timeoutMs: 30, staleMs: 60_000 }), (err) => err.code === 'busy')
})

test('stale heal leaves no claim directory behind', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-heal-cleanup')
  fs.mkdirSync(lockPath)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, old, old)
  const result = withLock(lockPath, () => 'ok', { timeoutMs: 500, staleMs: 1000 })
  assert.equal(result, 'ok')
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.heal-')), [])
})

test('release does not delete a lock taken over by another owner (no double release)', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-owner')
  withLock(lockPath, () => {
    // 模拟临界区超时被另一进程抢占：锁目录被替换为别人 owner。
    fs.rmSync(lockPath, { recursive: true, force: true })
    fs.mkdirSync(lockPath)
    fs.writeFileSync(path.join(lockPath, 'owner'), 'someone-else', 'utf8')
  }, { timeoutMs: 500 })
  assert.ok(fs.existsSync(lockPath), 'withLock must not delete another owner lock')
})

test('touchLock refreshes mtime so long critical sections are not stolen', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-heartbeat')
  fs.mkdirSync(lockPath)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, old, old)
  const before = fs.statSync(lockPath).mtimeMs
  assert.equal(touchLock(lockPath), true)
  const after = fs.statSync(lockPath).mtimeMs
  assert.ok(after > before, `${after} should be newer than ${before}`)
  assert.equal(touchLock(path.join(root, '.missing-lock')), false)
})

test('future-mtime stale lock self-heals (clock skew)', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-future')
  fs.mkdirSync(lockPath)
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(lockPath, future, future)
  const result = withLock(lockPath, () => 42, { staleMs: 1000, timeoutMs: 500 })
  assert.equal(result, 42)
  assert.equal(fs.existsSync(lockPath), false)
})

test('withLock runs the body and releases the lock', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock')
  const result = withLock(lockPath, () => {
    assert.ok(fs.existsSync(lockPath), 'lock held during body')
    return 42
  })
  assert.equal(result, 42)
  assert.ok(!fs.existsSync(lockPath), 'lock released after body')
})

test('withLock releases the lock when the body throws', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock')
  assert.throws(() => withLock(lockPath, () => { throw new Error('boom') }), /boom/)
  assert.ok(!fs.existsSync(lockPath))
})

test('withLock rejects async callbacks and still releases the lock', () => {
  const lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-lock-')), '.lock')
  assert.throws(() => withLock(lockPath, async () => 'late'), /不支持异步|async callbacks/)
  assert.equal(fs.existsSync(lockPath), false, 'lock released after rejecting async body')
  // 锁仍可正常获取。
  assert.equal(withLock(lockPath, () => 'ok'), 'ok')
  assert.equal(fs.existsSync(lockPath), false)
})

test('withLock creates a missing parent directory (fresh data root)', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, 'workspaces', '.lock')
  assert.ok(!fs.existsSync(path.dirname(lockPath)))
  const result = withLock(lockPath, () => 'ok')
  assert.equal(result, 'ok')
  assert.ok(fs.existsSync(path.dirname(lockPath)), 'parent directory created')
  assert.ok(!fs.existsSync(lockPath), 'lock released')
})

test('withLock breaks a stale lock', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock')
  fs.mkdirSync(lockPath)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, old, old)
  const result = withLock(lockPath, () => 'acquired', { staleMs: 10_000 })
  assert.equal(result, 'acquired')
  assert.ok(!fs.existsSync(lockPath))
})

test('withLock times out while a fresh lock is held', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock')
  fs.mkdirSync(lockPath)
  assert.throws(
    () => withLock(lockPath, () => 'never', { timeoutMs: 120, retryMs: 20 }),
    /lock timeout/,
  )
  assert.ok(fs.existsSync(lockPath), 'foreign lock untouched')
  fs.rmSync(lockPath, { recursive: true, force: true })
})

test('H9: failed put-back of a claimed fresh lock cleans the orphan .heal-* directory', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-test')
  fs.mkdirSync(lockPath)
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, past, past)
  const realRename = fs.renameSync
  let renames = 0
  fs.renameSync = function (src, dst) {
    renames += 1
    if (renames === 1) {
      // 认领成功；随后刷新 mtime，使认领到的锁看起来是新鲜锁（走放回路径）。
      const r = realRename.call(fs, src, dst)
      const now = new Date()
      fs.utimesSync(dst, now, now)
      return r
    }
    // 放回瞬间第三进程已抢先重建 lockPath → rename 必失败。
    fs.mkdirSync(lockPath, { recursive: true })
    return realRename.call(fs, src, dst)
  }
  try {
    assert.throws(
      () => withLock(lockPath, () => 'never', { timeoutMs: 200, staleMs: 10_000, retryMs: 20 }),
      (err) => err.code === 'busy',
    )
  } finally {
    fs.renameSync = realRename
  }
  const residue = fs.readdirSync(root).filter((n) => n.includes('.heal-'))
  assert.deepEqual(residue, [], 'orphan claim directory must be cleaned up, not left forever')
  fs.rmSync(root, { recursive: true, force: true })
})

function runWorker(root, cwd, count, prefix) {
  const worker = fileURLToPath(new URL('./fixtures/save-worker.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, cwd, String(count), prefix], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

test('two concurrent processes: no lost entries, index keeps both workspaces', async () => {
  const root = tmpRoot()
  const cwdA = 'D:\\proj\\lock-alpha'
  const cwdB = 'D:\\proj\\lock-beta'
  const [codeA, codeB] = await Promise.all([
    runWorker(root, cwdA, 25, 'alpha'),
    runWorker(root, cwdB, 25, 'beta'),
  ])
  assert.equal(codeA, 0)
  assert.equal(codeB, 0)
  const { createMemoryService } = await import('../lib/service.js')
  const service = createMemoryService({ root })
  assert.equal(service.list({ scope: 'workspace', workspace: cwdA }).length, 25)
  assert.equal(service.list({ scope: 'workspace', workspace: cwdB }).length, 25)
  const workspaces = service.workspaces()
  assert.equal(workspaces.length, 2, 'index must keep both workspace keys')
  const cwds = workspaces.map((w) => w.cwd).sort()
  assert.deepEqual(cwds, [cwdA.toLowerCase(), cwdB.toLowerCase()].sort())
  const index = JSON.parse(fs.readFileSync(path.join(root, 'workspaces', 'index.json'), 'utf8'))
  assert.equal(Object.keys(index).length, 2)
})

test('two concurrent processes importing into one root: all entries land', async () => {
  const root = tmpRoot()
  const worker = fileURLToPath(new URL('./fixtures/import-worker.mjs', import.meta.url))
  const run = (prefix) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, prefix, '20'], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
  const [a, b] = await Promise.all([run('impA'), run('impB')])
  assert.equal(a, 0)
  assert.equal(b, 0)
  const { createMemoryService } = await import('../lib/service.js')
  const service = createMemoryService({ root })
  assert.equal(service.list({ scope: 'global' }).length, 40)
})
