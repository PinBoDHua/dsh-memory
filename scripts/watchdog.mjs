#!/usr/bin/env node
/**
 * 验证脚本的「强杀看门狗」：live-check / gui-check 启动时把清理基线写成 manifest，
 * 再由本进程 detached 监控父进程。父进程被任务管理器/taskkill/CI 超时强杀时，
 * 看门狗接管清理：
 *   ① 删除本脚本创建的测试记忆（内容以 __gui_ / __livecheck_ 开头）；
 *   ② settings.json 恢复为基线（不存在则删除）；
 *   ③ 删除基线之外的备份文件（测试期间新增）；
 *   ④ 删除残留的 .lock-verify/.lock-settings/.lock-import。
 * 正常结束由父进程先停掉看门狗，避免与正常清理路径竞争。
 *
 * 用法：
 *   node scripts/watchdog.mjs --manifest=<path> --loop   # 父进程存活时每 1.5s 轮询
 *   node scripts/watchdog.mjs --manifest=<path> --once   # 立即执行一次（测试用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listEverywhere, forgetEntries, pruneAccessLedger } from '../lib/store.js'
import { restoreEvacuatedBackups, PLUGIN_BACKUP_PATTERN } from './data-snapshot.mjs'

export const MARKER_PREFIXES = ['__gui_', '__livecheck_']
export const VERIFY_LOCK_NAMES = ['.lock-verify', '.lock-settings', '.lock-import']
const WATCHDOG_FILE = fileURLToPath(import.meta.url)

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function parentAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** 读锁 owner 第一行 pid（verify-lock 新格式 pid\nnonce；旧格式仅 pid）。 */
function lockOwnerPid(target) {
  try {
    const raw = fs.readFileSync(path.join(target, 'owner'), 'utf8').trim()
    const pid = Number(raw.split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 删锁前校验归属（第七轮审计 O5）：活 owner 的锁绝不删（宿主可能正持锁导入/写设置）。 */
function removeLockDirs(root) {
  const removed = []
  for (const name of VERIFY_LOCK_NAMES) {
    const target = path.join(root, name)
    try {
      if (!fs.existsSync(target)) continue
      if (name === '.lock-verify') {
        const pid = lockOwnerPid(target)
        if (pid !== null && parentAlive(pid)) continue // 活 owner：不删
        if (pid === null) {
          // 无 owner 文件：按 mtime 陈旧判据（10min），新鲜锁不动。
          let stale = false
          try { stale = Math.abs(Date.now() - fs.statSync(target).mtimeMs) > 10 * 60_000 } catch { continue }
          if (!stale) continue
        }
        // pid 已死：崩溃残留，删除。
      } else {
        // lib 锁（.lock-settings/.lock-import）owner 是 nonce：仅陈旧（>10s）才删，
        // 新鲜锁可能正被宿主持有。
        let stale = false
        try { stale = Math.abs(Date.now() - fs.statSync(target).mtimeMs) > 10_000 } catch { continue }
        if (!stale) continue
      }
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    } catch { /* ignore */ }
  }
  return removed
}

function restoreSettings(root, settingsBefore) {
  const file = path.join(root, 'settings.json')
  if (!settingsBefore) return 'skipped'
  try {
    if (settingsBefore.exists) {
      fs.writeFileSync(file, String(settingsBefore.content ?? ''), 'utf8')
      return 'restored'
    }
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      return 'removed'
    }
    return 'absent'
  } catch {
    return 'failed'
  }
}

function pruneNewBackups(root, backupsBefore, startedAt) {
  const baseline = new Set(Array.isArray(backupsBefore) ? backupsBefore : [])
  const dir = path.join(root, 'backups')
  const removed = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return removed }
  const windowStart = Number(startedAt) > 0 ? Number(startedAt) - 1000 : null
  for (const name of names) {
    if (!name.endsWith('.json') || baseline.has(name)) continue
    // O7（第九轮审计）：只删本次运行窗口内新生成的插件格式备份——按运行前基线整根
    // 回滚会把用户中途手动放的 .json / 中途触发的历史备份一并删掉（diff 还失明）。
    if (!PLUGIN_BACKUP_PATTERN.test(name)) continue
    if (windowStart !== null) {
      let fresh = false
      try { fresh = fs.statSync(path.join(dir, name)).mtimeMs >= windowStart } catch { fresh = true }
      if (!fresh) continue
    }
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch { /* ignore */ }
  }
  return removed
}

/**
 * 执行一次清理（幂等）。返回统计对象，便于测试与排障。
 * @param {{root:string, markers?:string[], settingsBefore?:{exists:boolean,content?:string}, backupsBefore?:string[]}} manifest
 */
export function runWatchdogOnce(manifest) {
  const root = manifest?.root
  if (!root) throw new Error('watchdog manifest missing root')
  if (!fs.existsSync(root)) return { skipped: true, reason: 'root-missing' }
  const markers = Array.isArray(manifest.markers) && manifest.markers.length > 0 ? manifest.markers : MARKER_PREFIXES
  const locks = removeLockDirs(root)
  const ids = []
  for (const { entry } of listEverywhere(root)) {
    const content = String(entry?.content ?? '')
    if (markers.some((prefix) => content.startsWith(prefix))) ids.push(entry.id)
  }
  let forgotten = { deleted: [], notFound: [], failed: [] }
  if (ids.length > 0) {
    try {
      forgotten = forgetEntries(root, ids)
    } catch {
      // O3（第九轮审计）：整批抛错（写锁 busy/IO 失败）不得静默当作「已清理」——
      // 旧实现吞掉异常后 failed=0，runLoop 判定成功、删 manifest 退出，强杀残留
      // 从此无人再清。记为失败条目，交给 runLoop 退避重试。
      forgotten = { deleted: [], notFound: [], failed: ids }
    }
    try { pruneAccessLedger(root) } catch { /* ignore */ }
  }
  const settings = restoreSettings(root, manifest.settingsBefore)
  const backups = pruneNewBackups(root, manifest.backupsBefore, manifest.startedAt)
  // O3：恢复被轮转删除的疏散备份（备份用例前复制到临时目录的最旧一份）。
  const evacuated = restoreEvacuatedBackups(root, manifest.evacuatedBackups)
  // O10：删除登记的非标记磁盘工件（损坏文件/阻塞文件等，内容标记扫不到）。
  const artifacts = []
  let artifactFailures = 0
  for (const p of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    try { fs.rmSync(p, { force: true }); artifacts.push(p) } catch { artifactFailures += 1 }
  }
  return {
    entries: { matched: ids.length, deleted: forgotten.deleted?.length ?? 0, failed: forgotten.failed?.length ?? 0 },
    settings,
    backups,
    evacuated,
    artifacts,
    artifactFailures,
    locks,
  }
}

export function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  // O4（第九轮审计）：原子替换——非原子 truncate+write 窗口会让轮询的看门狗读到
  // 半截 JSON 并误判「父进程已收尾」而退出。
  const tmp = `${manifestPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8')
  fs.renameSync(tmp, manifestPath)
  return manifestPath
}

/**
 * 启动 detached 看门狗。父进程需在正常收尾时调用 stop()（会先杀看门狗再删 manifest）。
 * @param {object} manifest
 * @param {{manifestPath?: string, logPath?: string}} [opts]
 */
export function startCleanupWatchdog(manifest, opts = {}) {
  if (!manifest?.root) throw new Error('watchdog requires a data root')
  const dir = opts.manifestPath ? path.dirname(opts.manifestPath) : path.join(process.env.TEMP || process.env.TMP || '.', 'dsh-memory-watchdog')
  const manifestPath = opts.manifestPath || path.join(dir, `watchdog-${process.pid}-${Date.now().toString(36)}.json`)
  writeManifest(manifestPath, { ...manifest, parentPid: process.pid, logPath: opts.logPath ?? manifest.logPath ?? null })
  const child = spawnWatchdog(manifestPath)
  return {
    manifestPath,
    child,
    stop() {
      try { child.kill() } catch { /* ignore */ }
      try { fs.rmSync(manifestPath, { force: true }) } catch { /* ignore */ }
      // O14：日志一并清理，不在 TEMP 永久累积。
      try { if (opts.logPath) fs.rmSync(opts.logPath, { force: true }) } catch { /* ignore */ }
    },
  }
}

function spawnWatchdog(manifestPath) {
  // 延迟引入避免测试直接 import runWatchdogOnce 时也载入 child_process 逻辑。
  const { spawn } = childProcess
  const child = spawn(process.execPath, [WATCHDOG_FILE, `--manifest=${manifestPath}`, '--loop'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child
}

async function runLoop(manifestPath) {
  const { setTimeout: delay } = await import('node:timers/promises')
  let attempts = 0
  let manifestMisses = 0
  for (;;) {
    const manifest = readJson(manifestPath)
    if (!manifest) {
      // O4（第九轮审计）：父进程收尾会「先杀看门狗再删 manifest」。单次读不到可能
      // 落在 manifest 更新窗口（现父进程已改原子写，这里是双保险）：连续 3 次
      // （约 4.5s）读不到才判定收尾退出；读到即重置计数。
      manifestMisses += 1
      if (manifestMisses >= 3) return
      await delay(1500)
      continue
    }
    manifestMisses = 0
    if (manifest.parentPid && !parentAlive(manifest.parentPid)) {
      // O6：清理失败（抛错 / 条目 failed / settings 恢复失败 / 工件删除失败）保留
      // manifest 退避重试，不再「失败一次即永久放弃」；成功或达上限才删 manifest。
      let result = null
      let failed = false
      try {
        result = runWatchdogOnce(manifest)
        failed = (result?.entries?.failed ?? 0) > 0 || result?.settings === 'failed' || (result?.artifactFailures ?? 0) > 0
      } catch {
        failed = true
      }
      if (manifest.logPath) {
        try { fs.writeFileSync(manifest.logPath, JSON.stringify({ at: new Date().toISOString(), attempts, failed, ...result }, null, 2), 'utf8') } catch { /* ignore */ }
      }
      if (!failed || attempts >= 5) {
        try { fs.rmSync(manifestPath, { force: true }) } catch { /* ignore */ }
        return
      }
      attempts += 1
      await delay(Math.min(1500 * 2 ** attempts, 15_000))
      continue
    }
    await delay(1500)
  }
}

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const idx = arg.indexOf('=')
    return idx === -1 ? [arg.replace(/^--/, ''), 'true'] : [arg.slice(2, idx), arg.slice(idx + 1)]
  }))
  const manifestPath = args.get('manifest')
  if (!manifestPath) {
    console.error('用法：node scripts/watchdog.mjs --manifest=<path> (--loop|--once)')
    process.exitCode = 2
    return
  }
  if (args.has('once')) {
    const manifest = readJson(manifestPath)
    if (!manifest) throw new Error(`manifest 不存在：${manifestPath}`)
    const result = runWatchdogOnce(manifest)
    console.log(JSON.stringify(result))
    return
  }
  await runLoop(manifestPath)
}

// child_process 需要延迟引入（ESM 顶层引入也可以，但保持 spawn 仅真实运行时使用）。
import * as childProcess from 'node:child_process'

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(WATCHDOG_FILE)
if (isDirect) {
  main().catch((err) => {
    console.error('看门狗失败：', err)
    process.exitCode = 1
  })
}