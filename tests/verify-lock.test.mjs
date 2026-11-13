/**
 * dsh-memory：验证脚本互斥锁（scripts/verify-lock.mjs）单测。
 * 运行 Run: node --test tests/verify-lock.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireVerifyLock, VERIFY_LOCK_NAME } from '../scripts/verify-lock.mjs'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-vlock-'))
}

test('acquire/release creates and removes the lock directory', () => {
  const root = tmpRoot()
  const lock = acquireVerifyLock(root)
  assert.ok(fs.existsSync(path.join(root, VERIFY_LOCK_NAME)))
  assert.equal(fs.readFileSync(path.join(lock.path, 'owner'), 'utf8'), String(process.pid))
  lock.release()
  assert.equal(fs.existsSync(path.join(root, VERIFY_LOCK_NAME)), false)
})

test('second concurrent acquire fails fast with code=busy', () => {
  const root = tmpRoot()
  const first = acquireVerifyLock(root)
  try {
    assert.throws(() => acquireVerifyLock(root), (err) => err.code === 'busy')
  } finally {
    first.release()
  }
  // 释放后可再次获取。
  const again = acquireVerifyLock(root)
  again.release()
})

test('stale lock self-heals after staleMs', () => {
  const root = tmpRoot()
  const stale = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(stale)
  const old = Date.now() - 60_000
  fs.utimesSync(stale, new Date(old), new Date(old))
  const lock = acquireVerifyLock(root, { staleMs: 1000 })
  assert.ok(fs.existsSync(stale))
  lock.release()
})

test('missing root is created before locking', () => {
  const root = path.join(tmpRoot(), 'nested', 'data')
  const lock = acquireVerifyLock(root)
  assert.ok(fs.existsSync(path.join(root, VERIFY_LOCK_NAME)))
  lock.release()
})