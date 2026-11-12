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
import { withLock } from '../lib/lock.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-lock-'))
}

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
