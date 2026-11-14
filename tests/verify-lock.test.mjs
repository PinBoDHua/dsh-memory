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

// O13①：不假定某个真实 pid 必死（Windows 已退出进程仍可能响应 kill(0)，Linux 高
// pid_max 可能复用）。用哨兵 pid + process.kill mock 确定性地模拟「owner 已死」。
const DEAD_PID = 999999
const realKill = process.kill
process.kill = function (pid, sig) {
  if (pid === DEAD_PID && (sig === 0 || sig === undefined)) {
    const e = new Error('ESRCH: no such process'); e.code = 'ESRCH'; throw e
  }
  return realKill.call(process, pid, sig)
}

test('acquire/release creates and removes the lock directory', () => {
  const root = tmpRoot()
  const lock = acquireVerifyLock(root)
  assert.ok(fs.existsSync(path.join(root, VERIFY_LOCK_NAME)))
  // owner 第一行 pid，第二行 nonce（release 只删自己的锁）。
  assert.equal(fs.readFileSync(path.join(lock.path, 'owner'), 'utf8').split('\n')[0], String(process.pid))
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

test('stale lock from a dead owner self-heals after staleMs', () => {
  const root = tmpRoot()
  const stale = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(stale)
  fs.writeFileSync(path.join(stale, 'owner'), String(DEAD_PID), 'utf8')
  const old = Date.now() - 60_000
  fs.utimesSync(stale, new Date(old), new Date(old))
  const lock = acquireVerifyLock(root, { staleMs: 1000 })
  assert.ok(fs.existsSync(stale))
  lock.release()
})

test('O4: live owner with stale mtime is NOT stolen (heartbeat keeps it alive)', () => {
  const root = tmpRoot()
  const stale = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(stale)
  // 活 owner（本进程）但 mtime 陈旧：不得抢锁（心跳失败也不剥夺运行中的脚本）。
  fs.writeFileSync(path.join(stale, 'owner'), `${process.pid}\nsome-nonce`, 'utf8')
  const old = Date.now() - 60_000
  fs.utimesSync(stale, new Date(old), new Date(old))
  assert.throws(() => acquireVerifyLock(root, { staleMs: 1000 }), (err) => err.code === 'busy')
  assert.ok(fs.existsSync(stale), 'live-owner lock must remain')
  fs.rmSync(stale, { recursive: true, force: true })
})

test('lock from a dead owner process self-heals immediately', () => {
  const root = tmpRoot()
  const stale = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(stale)
  fs.writeFileSync(path.join(stale, 'owner'), String(DEAD_PID), 'utf8')
  const lock = acquireVerifyLock(root, { staleMs: 10 * 60 * 1000 })
  assert.ok(lock)
  lock.release()
})

test('missing root is created before locking', () => {
  const root = path.join(tmpRoot(), 'nested', 'data')
  const lock = acquireVerifyLock(root)
  assert.ok(fs.existsSync(path.join(root, VERIFY_LOCK_NAME)))
  lock.release()
})