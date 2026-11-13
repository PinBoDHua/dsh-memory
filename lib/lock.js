/**
 * dsh-memory 跨进程写锁 Cross-process write lock.
 *
 * 记忆按 home 共享：同一台机器上多个 DSH profile/进程可能同时写
 * index.json 这类「读-改-写」文件。mkdir 的原子性提供互斥；
 * 持锁进程崩溃留下的陈旧锁按 mtime 判定并自愈；获取超时抛错而不是死等。
 * Memory is shared per home: several DSH processes may read-modify-write
 * index.json concurrently. Atomic mkdir gives mutual exclusion; stale locks
 * from crashed holders self-heal by mtime; acquisition times out loudly.
 *
 * 只依赖 Node 内置模块，可独立单测。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = { timeoutMs: 5000, staleMs: 10000, retryMs: 25 }

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 独占执行 fn（同步）。锁目录在 fn 返回/抛出后释放。
 * 超时抛 Error('lock timeout: …')；不删除他人持有的新鲜锁。
 */
export function withLock(lockPath, fn, opts = {}) {
  const { timeoutMs, staleMs, retryMs } = { ...DEFAULTS, ...opts }
  const deadline = Date.now() + timeoutMs
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
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
      } catch { /* 锁刚好消失，直接重试 mkdir lock vanished; retry mkdir */ }
      if (stale) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch { /* 竞争自愈 race self-heal */ }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`)
      sleep(retryMs)
    }
  }
  try {
    return fn()
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch { /* 释放失败不影响结果 release best-effort */ }
  }
}
