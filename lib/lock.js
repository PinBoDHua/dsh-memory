/**
 * dsh-memory 跨进程写锁 Cross-process write lock.
 *
 * 记忆按 home 共享：同一台机器上多个 DSH profile/进程可能同时写
 * index.json 这类「读-改-写」文件。mkdir 的原子性提供互斥；
 * 持锁进程崩溃留下的陈旧锁按 mtime 判定并自愈；获取超时抛错而不是死等。
 * 锁目录写入 owner nonce：释放只删自己的锁（临界区超时被抢占时不误删他人锁），
 * 长临界区可用 touchLock 刷新 mtime 防止被判陈旧。
 * Memory is shared per home: several DSH processes may read-modify-write
 * index.json concurrently. Atomic mkdir gives mutual exclusion; stale locks
 * from crashed holders self-heal by mtime; acquisition times out loudly.
 *
 * 只依赖 Node 内置模块，可独立单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const DEFAULTS = { timeoutMs: 5000, staleMs: 10000, retryMs: 25 }
const OWNER_FILE = 'owner'

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 刷新锁目录 mtime：长临界区（大导入）定期调用，避免被另一进程判为陈旧抢占。 */
export function touchLock(lockPath) {
  try {
    const now = new Date()
    fs.utimesSync(lockPath, now, now)
    return true
  } catch {
    return false
  }
}

/** 读取锁 owner nonce；锁不存在/无 owner 返回空串。 */
function readOwner(lockPath) {
  try {
    return fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 独占执行 fn（同步）。锁目录在 fn 返回/抛出后释放。
 * 超时抛 Error('lock timeout: …')；不删除他人持有的新鲜锁。
 */
export function withLock(lockPath, fn, opts = {}) {
  const { timeoutMs, staleMs, retryMs } = { ...DEFAULTS, ...opts }
  const deadline = Date.now() + timeoutMs
  const nonce = randomBytes(8).toString('hex')
  // 父目录可能尚不存在（全新数据根首次导入、workspaces/ 未创建）：先建父目录，
  // 否则 mkdirSync(lockPath, {recursive:false}) 抛 ENOENT，写路径全部失败。
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let stale = false
      try {
        // 用绝对时间差：未来 mtime 的锁（时钟漂移/手工改时间）也应按陈旧自愈，
        // 否则会让后续写操作永久 busy。
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        stale = Math.abs(age) > staleMs
      } catch { /* 锁刚好消失，直接重试 mkdir lock vanished; retry mkdir */ }
      if (stale) {
        // 原子认领：rename 只有一个进程能成功，避免「两个等待者同时判定陈旧 →
        // 各自 rmSync」把对方刚建立的新锁删掉（check-then-rm 双持有）。
        const claimPath = `${lockPath}.heal-${nonce}`
        let claimed = false
        try { fs.renameSync(lockPath, claimPath); claimed = true } catch { /* 他人先认领或锁已消失 */ }
        if (claimed) {
          let stillStale = true
          try {
            const age = Date.now() - fs.statSync(claimPath).mtimeMs
            stillStale = Math.abs(age) > staleMs
          } catch { /* claim 已被清理 */ }
          if (!stillStale) {
            // 认领到的其实是另一进程刚建立的新锁：放回并继续等待，绝不删除。
            try {
              fs.renameSync(claimPath, lockPath)
            } catch {
              // 放回失败（第三进程已抢先 mkdir lockPath）：claimPath 已是孤儿——
              // 原持有者只引用 lockPath，释放时 nonce 不匹配不会删它；不清理会永久
              // 残留 .heal-* 垃圾目录（第七轮审计 H9）。删除安全。
              try { fs.rmSync(claimPath, { recursive: true, force: true }) } catch { /* ignore */ }
            }
          } else {
            try { fs.rmSync(claimPath, { recursive: true, force: true }) } catch { /* ignore */ }
          }
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`lock timeout: ${lockPath}`), { code: 'busy' })
      }
      sleep(retryMs)
    }
  }
  let result
  try {
    fs.writeFileSync(path.join(lockPath, OWNER_FILE), nonce, 'utf8')
  } catch { /* owner 只是防双释放的增强，写失败不影响互斥本身 */ }
  try {
    result = fn()
  } finally {
    // 只删自己的锁：临界区超时被他人抢占后，无条件 rmSync 会删掉新持有者的锁，
    // 导致第三人趁虚而入（双释放）。nonce 不匹配就放弃释放。
    try {
      if (readOwner(lockPath) === nonce) fs.rmSync(lockPath, { recursive: true, force: true })
    } catch { /* 释放失败不影响结果 release best-effort */ }
  }
  // 锁是同步临界区：async 回调会在第一个 await 处提前放锁，等于没有互斥。
  // 显式报错，避免后来者无声引入并发写。
  if (result && typeof result.then === 'function') {
    throw new Error('withLock 不支持异步回调 / withLock does not support async callbacks (the lock would be released before completion)')
  }
  return result
}
