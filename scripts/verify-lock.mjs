/**
 * 验证脚本互斥锁（live-check / gui-check 共用，可单测）。
 *
 * 两个验证脚本都会对同一个真实数据根做破坏性写入（临时记忆、settings overlay、
 * backups）。并发运行会互相删对方新增的备份/竞态恢复设置，甚至连到同一个 CDP 页面。
 * 用数据根下的 `.lock-verify` 目录互斥；进程崩溃留下的陈旧锁自愈。
 * 该目录被 data-snapshot 的 junk 检测显式忽略。
 *
 * 第七轮审计 O4：复用 lib/lock.js 的 rename 认领 + owner nonce 算法，消除
 * 「判陈旧→rmSync→重试 mkdir」的 check-then-rm 双持有；活 owner 即使 mtime 陈旧
 * 也不抢（运行期心跳保活）；mkdir 与写 owner 的窗口内保守视为活 owner，不误删。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const VERIFY_LOCK_NAME = '.lock-verify'

/**
 * 获取验证锁。返回 { path, release() }。
 * 已有活 owner 的新鲜锁时抛 code=busy（调用方应快速退出并提示稍后重试）。
 * 自愈条件：owner 进程已不存在，或（无 owner 时）mtime 超过 staleMs。
 * 认领用原子 rename（只有一个进程能成功），认领后复核，误认新鲜锁则放回。
 */
export function acquireVerifyLock(root, { staleMs = 10 * 60 * 1000, owner = process.pid } = {}) {
  if (!root) throw new Error('verify lock requires a data root')
  const lockPath = path.join(root, VERIFY_LOCK_NAME)
  fs.mkdirSync(root, { recursive: true })
  const nonce = randomBytes(8).toString('hex')
  // 循环上限：理论上每次认领都会删除或放回，必然收敛；上限只作防御，避免任何
  // 未预期路径把调用方（同步循环）永久卡住。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { recursive: false })
      // owner 第一行 pid（看门狗据此判存活），第二行 nonce（release 只删自己的锁）。
      try { fs.writeFileSync(path.join(lockPath, 'owner'), `${owner}\n${nonce}`, 'utf8') } catch { /* ignore */ }
      // 心跳：长验证运行（>staleMs）不被第二个脚本判陈旧抢锁。
      const heartbeat = setInterval(() => {
        try { const now = new Date(); fs.utimesSync(lockPath, now, now) } catch { /* ignore */ }
      }, 60_000)
      try { heartbeat.unref?.() } catch { /* ignore */ }
      return {
        path: lockPath,
        release() {
          clearInterval(heartbeat)
          try {
            const content = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')
            if (content.split('\n')[1] === nonce) fs.rmSync(lockPath, { recursive: true, force: true })
          } catch { /* ignore */ }
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      // 三态判定（O4）：
      //  - 活 pid owner：绝不抢（即使 mtime 陈旧——心跳失败也不剥夺运行中的脚本）；
      //  - 死 pid owner：崩溃残留，立即自愈；
      //  - 无/非法 owner（mkdir→write 窗口或写 owner 前崩溃）：保守按 mtime 陈旧自愈。
      let pid = null
      try { pid = Number(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim().split('\n')[0]) } catch { pid = null }
      if (pid !== null && Number.isInteger(pid) && pid > 0) {
        if (pidAlive(pid)) throw busyLock(lockPath)
        // 死 owner：落入下方认领自愈（不看 mtime —— 崩溃可发生在任何时刻）。
      } else {
        let stale = false
        try { stale = Math.abs(Date.now() - fs.statSync(lockPath).mtimeMs) > staleMs } catch { continue }
        if (!stale) throw busyLock(lockPath)
      }
      // 原子认领：rename 只有一个进程能成功，避免两个等待者各自 rmSync 删掉对方新锁。
      const claimPath = `${lockPath}.heal-${nonce}`
      let claimed = false
      try { fs.renameSync(lockPath, claimPath); claimed = true } catch { /* 他人先认领或锁已消失 */ }
      if (claimed) {
        // 复核用 owner 而非 mtime：认领到的可能是另一进程刚建立的新锁（活 owner）→
        // 放回绝不删除；owner 仍是死 pid / 无 owner → 确认为崩溃残留，删除。
        // （此前用 mtime 复核，死 owner＋新鲜 mtime 会「放回→再撞 EEXIST」无限循环。）
        let claimedPid = null
        try { claimedPid = Number(fs.readFileSync(path.join(claimPath, 'owner'), 'utf8').trim().split('\n')[0]) } catch { claimedPid = null }
        const newOwnerAlive = Number.isInteger(claimedPid) && claimedPid > 0 && pidAlive(claimedPid)
        if (newOwnerAlive) {
          try { fs.renameSync(claimPath, lockPath) } catch {
            try { fs.rmSync(claimPath, { recursive: true, force: true }) } catch { /* ignore */ }
          }
          throw busyLock(lockPath)
        }
        try { fs.rmSync(claimPath, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      // 继续循环重试 mkdir。
    }
  }
  throw busyLock(lockPath)
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

function busyLock(lockPath) {
  return Object.assign(new Error(`另一个验证脚本正在运行 / another verification script is running (${lockPath})`), { code: 'busy' })
}