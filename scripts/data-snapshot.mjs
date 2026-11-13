/**
 * 真实数据根快照/差异工具（live-check / gui-check 共用，可单测）。
 *
 * 目的：验证脚本运行前后用户数据零差异。快照覆盖「用户数据」：
 * - global/ 与 workspaces/<key>/ 下的 .md 条目（路径 → 内容 sha256）
 * - backups/ 下插件备份文件名集合
 * - settings.json / meta.json 内容 sha256
 *
 * 刻意排除 access.json（命中簿记是允许变化的派生数据；脚本只清理自己新增的测试 id）、
 * workspaces/index.json（cwd 索引的 lastSeen 会因测试条目刷新而合法变化）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

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
    const hash = sha256File(full)
    if (hash !== null) out[`${prefix}${ent.name}`] = hash
  }
}

/** 生成数据根快照；root 缺失时返回 null（调用方应跳过 diff 检查）。 */
export function snapshotDataRoot(root) {
  if (!root) return null
  const entries = {}
  collectEntries(path.join(root, 'global'), 'global/', entries)
  collectEntries(path.join(root, 'workspaces'), 'workspaces/', entries)
  let backups = []
  try {
    backups = readdirSync(path.join(root, 'backups')).filter((n) => n.endsWith('.json')).sort()
  } catch { /* 无备份目录 */ }
  return {
    entries,
    backups,
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

/** 比对两个快照，返回人类可读差异列表；空数组表示完全一致。 */
export function diffSnapshots(before, after) {
  if (!before || !after) return ['快照不可用']
  const changes = []
  changes.push(...diffMap(before.entries || {}, after.entries || {}))
  const backupsBefore = (before.backups || []).join(',')
  const backupsAfter = (after.backups || []).join(',')
  if (backupsBefore !== backupsAfter) changes.push(`backups 变更: [${backupsBefore}] -> [${backupsAfter}]`)
  if (before.settings !== after.settings) changes.push('settings.json 变更')
  if (before.meta !== after.meta) changes.push('meta.json 变更')
  return changes
}