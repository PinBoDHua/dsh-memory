/**
 * 真实数据根快照/差异工具（live-check / gui-check 共用，可单测）。
 *
 * 目的：验证脚本运行前后用户数据零差异。快照覆盖「用户数据」：
 * - global/ 与 workspaces/<key>/ 下的 .md 条目（路径 → 内容 sha256）
 * - backups/ 下插件备份文件名 → 内容 sha256（内容被改写也能发现）
 * - settings.json / meta.json 内容 sha256
 * - junk 清单：`.tmp-*` 残留、`.lock-*`（验证脚本自身的 .lock-verify 除外）、
 *   条目目录里的非 .md 文件、backups/ 里的非 .json 文件
 *
 * 刻意排除 access.json（命中簿记是允许变化的派生数据；脚本只清理自己新增的测试 id）、
 * workspaces/index.json（cwd 索引的 lastSeen 会因测试条目刷新而合法变化）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

const VERIFY_LOCK_NAME = '.lock-verify'

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function collectEntries(dir, prefix, out) {
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of names) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectEntries(full, `${prefix}${ent.name}/`, out)
      continue
    }
    if (!ent.name.endsWith('.md')) continue
    // 读失败记特殊标记参与 diff（O12）：前后都不可读的文件不再隐形。
    out[`${prefix}${ent.name}`] = sha256File(full) ?? '<unreadable>'
  }
}

function collectJunk(root) {
  const junk = new Set()
  // mode 决定该目录里「合法文件」扩展名：root/workspaces/backups 允许 .json（元数据/备份），
  // 条目目录只允许 .md；other（根级意外子目录）什么都不允许；其余一律视为垃圾。
  const allowedExt = { root: '.json', workspaces: '.json', entries: '.md', backups: '.json', other: null }
  const rootJsonAllowed = new Set(['settings.json', 'meta.json', 'access.json'])
  const visit = (dir, relative, mode) => {
    let names = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of names) {
      const rel = relative ? `${relative}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (ent.name === VERIFY_LOCK_NAME) continue
        // .cache 是大库的派生解析索引（可随时删除/重建），不属于用户数据。
        if (ent.name === '.cache') continue
        if (ent.name.startsWith('.lock')) { junk.add(rel); continue }
        const childMode = ent.name === 'workspaces' ? 'workspaces'
          : ent.name === 'backups' ? 'backups'
            : ent.name === 'global' ? 'entries'
              : mode === 'workspaces' ? 'entries'
                : 'other'
        visit(path.join(dir, ent.name), rel, childMode)
        continue
      }
      if (ent.name.startsWith('.lock') || ent.name.includes('.tmp-')) {
        junk.add(rel)
        continue
      }
      // 根级除文档化排除外的 .json 一律列 junk（O12）：脚本误写 root/foo.json 必须可见。
      if (mode === 'root' && ent.name.endsWith('.json') && !rootJsonAllowed.has(ent.name)) {
        junk.add(rel)
        continue
      }
      const ext = allowedExt[mode]
      if (!ext || !ent.name.endsWith(ext)) junk.add(rel)
    }
  }
  visit(root, '', 'root')
  return [...junk].sort()
}

/** 生成数据根快照；root 缺失时返回 null（调用方应跳过 diff 检查）。 */
export function snapshotDataRoot(root) {
  if (!root) return null
  const entries = {}
  collectEntries(path.join(root, 'global'), 'global/', entries)
  collectEntries(path.join(root, 'workspaces'), 'workspaces/', entries)
  const backups = {}
  try {
    for (const name of readdirSync(path.join(root, 'backups')).filter((n) => n.endsWith('.json'))) {
      backups[name] = sha256File(path.join(root, 'backups', name)) ?? '<unreadable>'
    }
  } catch { /* 无备份目录 */ }
  return {
    entries,
    backups,
    junk: collectJunk(root),
    settings: sha256File(path.join(root, 'settings.json')),
    meta: sha256File(path.join(root, 'meta.json')),
  }
}

function diffMap(before, after) {
  const changes = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (before[key] === after[key]) continue
    if (before[key] === undefined) changes.push(`新增 ${key}`)
    else if (after[key] === undefined) changes.push(`删除 ${key}`)
    else changes.push(`修改 ${key}`)
  }
  return changes
}

function diffList(before, after, label) {
  const changes = []
  const b = new Set(before || [])
  const a = new Set(after || [])
  for (const item of a) if (!b.has(item)) changes.push(`${label}新增 ${item}`)
  for (const item of b) if (!a.has(item)) changes.push(`${label}消失 ${item}`)
  return changes
}

/** 比对两个快照，返回人类可读差异列表；空数组表示完全一致。 */
export function diffSnapshots(before, after) {
  if (!before || !after) return ['快照不可用']
  const changes = []
  changes.push(...diffMap(before.entries || {}, after.entries || {}))
  changes.push(...diffMap(before.backups || {}, after.backups || {}))
  changes.push(...diffList(before.junk || [], after.junk || [], '垃圾文件'))
  if (before.settings !== after.settings) changes.push('settings.json 变更')
  if (before.meta !== after.meta) changes.push('meta.json 变更')
  return changes
}

// ===== 备份疏散/恢复（第七轮审计 O3）=====
// 保留份数被 RETENTION_MAX=30 夹取：用户已有 30 份插件备份时，验证脚本触发的备份
// 会轮转删掉最旧一份，按文件名恢复无法重建。破坏性备份用例前先把最旧备份复制到
// 临时目录，结束后（含 watchdog 中断路径）若原文件已不在则复制回。
export const PLUGIN_BACKUP_PATTERN = /^dsh-memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{1,3})?\.json$/

/** 触发一次备份前，按「实际生效保留份数」疏散将被轮转删除的最旧插件备份。
 *  触发备份后共 count+1 份、保留 retention 份 → 轮转删除 (count+1-retention) 份最旧。
 *  旧实现只在 count ≥ 30 时且只救 1 份：count 在 (retention, 30) 区间时用户备份
 *  仍会被轮转删掉（第九轮审计 O6）。返回 [{name, tempPath}]。 */
export function evacuateOldestBackup(root, tmpDir, retentionLimit = 30) {
  const dir = path.join(root, 'backups')
  let names = []
  try { names = readdirSync(dir).filter((n) => PLUGIN_BACKUP_PATTERN.test(n)) } catch { return [] }
  const limit = Math.max(1, Math.floor(Number(retentionLimit) || 30))
  const rotations = names.length + 1 - limit
  if (rotations <= 0) return []
  const byAge = []
  for (const name of names) {
    try { byAge.push({ name, m: statSync(path.join(dir, name)).mtimeMs }) } catch { /* ignore */ }
  }
  byAge.sort((a, b) => a.m - b.m || a.name.localeCompare(b.name))
  const victims = byAge.slice(0, rotations)
  if (victims.length === 0) return []
  mkdirSync(tmpDir, { recursive: true })
  const out = []
  for (const victim of victims) {
    const tempPath = path.join(tmpDir, `evacuated-${victim.name}`)
    copyFileSync(path.join(dir, victim.name), tempPath)
    out.push({ name: victim.name, tempPath })
  }
  return out
}

/** 恢复被轮转删除的疏散备份（原文件仍在则只清理临时副本）。 */
export function restoreEvacuatedBackups(root, list) {
  if (!Array.isArray(list)) return []
  const dir = path.join(root, 'backups')
  const restored = []
  for (const item of list) {
    if (!item || !item.name || !item.tempPath) continue
    try {
      if (!existsSync(path.join(dir, item.name)) && existsSync(item.tempPath)) {
        mkdirSync(dir, { recursive: true })
        copyFileSync(item.tempPath, path.join(dir, item.name))
        restored.push(item.name)
      }
      rmSync(item.tempPath, { force: true })
    } catch { /* ignore */ }
  }
  return restored
}