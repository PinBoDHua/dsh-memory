/**
 * dsh-memory 设置层 Settings layer.
 *
 * 数据目录下 settings.json 覆盖层：profile 插件行配置为基线，settings.json
 * 覆盖其上，服务实时读取、改完即生效，可手工编辑（与记忆 Markdown 同一哲学）。
 * 「恢复默认」即删除 settings.json。所有值在此集中校验/夹取，未知键丢弃。
 * Overlay file in the data dir: profile row config is the base, settings.json
 * overrides it, read live by the service, hand-editable. Reset deletes the file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './store.js'

export const SETTINGS_DEFAULTS = Object.freeze({
  autoInject: true,
  injectionBudgetChars: 6000,
  autoBackup: false,
  backupRetention: 7,
  defaultView: 'all',
  pageSize: 50,
  animations: true,
  relativeTime: true,
})

export const BUDGET_MAX = 20000
export const PAGE_SIZES = Object.freeze([20, 50, 100])
export const VIEWS = Object.freeze(['all', 'global', 'workspace'])
export const RETENTION_MIN = 1
export const RETENTION_MAX = 30

function settingsFile(root) {
  return path.join(root, 'settings.json')
}

/** 校验＋夹取：布尔须为布尔，数值夹取范围，枚举须合法；未知/非法键丢弃。 */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  if (typeof src.autoInject === 'boolean') out.autoInject = src.autoInject
  if (src.injectionBudgetChars !== undefined) {
    const n = Number(src.injectionBudgetChars)
    if (Number.isFinite(n)) out.injectionBudgetChars = Math.min(BUDGET_MAX, Math.max(0, Math.round(n)))
  }
  if (typeof src.autoBackup === 'boolean') out.autoBackup = src.autoBackup
  if (src.backupRetention !== undefined) {
    const n = Number(src.backupRetention)
    if (Number.isFinite(n)) out.backupRetention = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.round(n)))
  }
  if (VIEWS.includes(src.defaultView)) out.defaultView = src.defaultView
  if (PAGE_SIZES.includes(Number(src.pageSize))) out.pageSize = Number(src.pageSize)
  if (typeof src.animations === 'boolean') out.animations = src.animations
  if (typeof src.relativeTime === 'boolean') out.relativeTime = src.relativeTime
  return out
}

/** 读取覆盖层（仅合法键）；缺失/损坏返回空对象。容忍 UTF-8 BOM（Windows 记事本默认带 BOM）。 */
export function readOverlay(root) {
  try {
    const text = fs.readFileSync(settingsFile(root), 'utf8').replace(/^﻿/, '')
    return sanitizeSettings(JSON.parse(text))
  } catch {
    return {}
  }
}

/** 有效设置 = 默认 ← profile 基线（仅注入相关）← settings.json 覆盖。 */
export function effectiveSettings(base, root) {
  const b = base && typeof base === 'object' ? base : {}
  const baseLayer = sanitizeSettings({ autoInject: b.autoInject, injectionBudgetChars: b.injectionBudgetChars })
  return { ...SETTINGS_DEFAULTS, ...baseLayer, ...readOverlay(root) }
}

/** 合并写入覆盖层（原子写），返回写入后的覆盖层。 */
export function writeOverlay(root, patch) {
  const next = { ...readOverlay(root), ...sanitizeSettings(patch) }
  atomicWrite(settingsFile(root), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** 恢复默认：删除覆盖层文件。 */
export function resetOverlay(root) {
  try {
    fs.rmSync(settingsFile(root), { force: true })
  } catch { /* best-effort */ }
}
