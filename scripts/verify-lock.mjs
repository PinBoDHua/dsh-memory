/**
 * 验证脚本互斥锁（live-check / gui-check 共用，可单测）。
 *
 * 两个验证脚本都会对同一个真实数据根做破坏性写入（临时记忆、settings overlay、
 * backups）。并发运行会互相删对方新增的备份/竞态恢复设置，甚至连到同一个 CDP 页面。
 * 用数据根下的 `.lock-verify` 目录互斥；进程崩溃留下的陈旧锁按 mtime 自愈。
 * 该目录被 data-snapshot 的 junk 检测显式忽略。
 */

import fs from 'node:fs'
import path from 'node:path'

export const VERIFY_LOCK_NAME = '.lock-verify'

/** 锁持有进程是否仍存活（Windows 强杀脚本会留下锁；owner pid 已死可立即自愈）。 */
function ownerAlive(lockPath) {
  try {
    const pid = Number(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return true
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 获取验证锁。返回 { path, release() }。
 * 已有新鲜锁时抛 code=busy（调用方应快速退出并提示稍后重试）。
 * 自愈条件：mtime 超过 staleMs，或 owner 进程已不存在。
 */
export function acquireVerifyLock(root, { staleMs = 10 * 60 * 1000, owner = process.pid } = {}) {
  if (!root) throw new Error('verify lock requires a data root')
  const lockPath = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(root, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner'), String(owner), 'utf8')
      return {
        path: lockPath,
        release() {
          try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch { /* ignore */ }
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      let stale = !ownerAlive(lockPath)
      if (!stale) {
        try {
          stale = Math.abs(Date.now() - fs.statSync(lockPath).mtimeMs) > staleMs
        } catch { /* 锁刚好消失，重试 */ }
      }
      if (!stale) {
        throw Object.assign(new Error(`另一个验证脚本正在运行 / another verification script is running (${lockPath})`), { code: 'busy' })
      }
      try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  throw Object.assign(new Error('无法获取验证锁 / cannot acquire verification lock'), { code: 'busy' })
}