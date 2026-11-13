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
import { readFileSync, readdirSync } from 'node:fs'
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
    const hash = sha256File(full)
    if (hash !== null) out[`${prefix}${ent.name}`] = hash
  }
}

function collectJunk(root) {
  const junk = new Set()
  // mode 决定该目录里「合法文件」扩展名：root/workspaces/backups 允许 .json（元数据/备份），
  // 条目目录只允许 .md；其余一律视为垃圾（临时文件、手放杂项、非预期子目录内容）。
  const allowedExt = { root: '.json', workspaces: '.json', entries: '.md', backups: '.json' }
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
        if (ent.name.startsWith('.lock')) { junk.add(rel); continue }
        const childMode = ent.name === 'workspaces' ? 'workspaces'
          : ent.name === 'backups' ? 'backups'
            : mode === 'workspaces' ? 'entries'
              : 'entries'
        visit(path.join(dir, ent.name), rel, childMode)
        continue
      }
      if (ent.name.startsWith('.lock') || ent.name.includes('.tmp-')) {
        junk.add(rel)
        continue
      }
      if (!ent.name.endsWith(allowedExt[mode])) junk.add(rel)
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
      backups[name] = sha256File(path.join(root, 'backups', name))
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