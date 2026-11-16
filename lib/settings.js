/**
 * dsh-memory 设置层 Settings layer.
 *
 * 数据目录下 settings.json 覆盖层：profile 插件行配置为基线，settings.json
 * 覆盖其上，服务实时读取、改完即生效，可手工编辑（与记忆 Markdown 同一哲学）。
 * 「恢复默认」即删除 settings.json。所有值在此集中校验/夹取，未知键丢弃。
 * Overlay file in the data dir: profile row config is the base, settings.json
 * overrides it, read live by the service, hand-editable. Reset deletes the file.
 *
 * v3（学习主线）新增：
 * - autoLearn.maxWritesPerSession（0–5，会话自动落盘候选上限；0=关闭自动候选）
 * - conflictAlert（疑似冲突/待确认提醒，I4 使用）
 * - digest.enabled / digest.weekday（确定性周报，I4 使用）
 * - injectionBudgetChars 默认值 6000 → 8000（已有用户覆盖值保持不变）
 */
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from './lock.js'
import { atomicWrite } from './store.js'

export const AUTO_WRITES_MIN = 0
export const AUTO_WRITES_MAX = 5
export const DIGEST_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7])

export const SETTINGS_DEFAULTS = Object.freeze({
  autoInject: true,
  injectionBudgetChars: 8000,
  autoExtractHint: true,
  decayEnabled: true,
  autoBackup: false,
  backupRetention: 7,
  defaultView: 'all',
  pageSize: 50,
  viewMode: 'comfortable',
  animations: true,
  relativeTime: true,
  autoLearn: Object.freeze({ maxWritesPerSession: AUTO_WRITES_MAX }),
  conflictAlert: true,
  digest: Object.freeze({ enabled: true, weekday: 1 }),
})

export const BUDGET_MAX = 20000
export const PAGE_SIZES = Object.freeze([20, 50, 100])
export const VIEWS = Object.freeze(['all', 'global', 'workspace'])
/** 面板列表密度：舒适＝索引行（分类 pill/标签/metadata 全量），紧凑＝单行高密度表格。 */
export const VIEW_MODES = Object.freeze(['comfortable', 'compact'])
export const RETENTION_MIN = 1
export const RETENTION_MAX = 30

/** 允许在 settings.json 中出现的嵌套命名空间（浅层对象，按子键合并）。 */
const NESTED_KEYS = Object.freeze(['autoLearn', 'digest'])

function settingsFile(root) {
  return path.join(root, 'settings.json')
}

/** 分组合并：顶层浅合并；嵌套命名空间逐子键合并。
 *  seedDefaults=true（有效值计算）以代码默认打底；false（覆盖层写入）只保留
 *  已存在/显式提交的子键——未触碰的默认子键（如 digest.weekday）不得物化进 settings.json。 */
function mergeLayers(layers, { seedDefaults = true } = {}) {
  const out = {}
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [key, value] of Object.entries(layer)) {
      if (NESTED_KEYS.includes(key)) continue
      out[key] = value
    }
  }
  for (const key of NESTED_KEYS) {
    out[key] = seedDefaults ? { ...SETTINGS_DEFAULTS[key] } : {}
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue
      const value = layer[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out[key], value)
    }
  }
  return out
}

/** 校验＋夹取：布尔须为布尔，数值夹取范围，枚举须合法；未知/非法键丢弃。 */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  if (typeof src.autoInject === 'boolean') out.autoInject = src.autoInject
  if (typeof src.autoExtractHint === 'boolean') out.autoExtractHint = src.autoExtractHint
  if (typeof src.decayEnabled === 'boolean') out.decayEnabled = src.decayEnabled
  if (typeof src.conflictAlert === 'boolean') out.conflictAlert = src.conflictAlert
  if (src.injectionBudgetChars !== undefined) {
    const n = Number(src.injectionBudgetChars)
    if (Number.isFinite(n)) out.injectionBudgetChars = Math.min(BUDGET_MAX, Math.max(0, Math.round(n)))
  }
  if (src.autoLearn !== undefined && src.autoLearn && typeof src.autoLearn === 'object' && !Array.isArray(src.autoLearn)) {
    const n = Number(src.autoLearn.maxWritesPerSession)
    if (Number.isFinite(n)) {
      out.autoLearn = { maxWritesPerSession: Math.min(AUTO_WRITES_MAX, Math.max(AUTO_WRITES_MIN, Math.round(n))) }
    }
  }
  if (src.digest !== undefined && src.digest && typeof src.digest === 'object' && !Array.isArray(src.digest)) {
    const digest = {}
    if (typeof src.digest.enabled === 'boolean') digest.enabled = src.digest.enabled
    const weekday = Number(src.digest.weekday)
    if (DIGEST_WEEKDAYS.includes(weekday)) digest.weekday = weekday
    if (Object.keys(digest).length > 0) out.digest = digest
  }
  if (typeof src.autoBackup === 'boolean') out.autoBackup = src.autoBackup
  if (src.backupRetention !== undefined) {
    const n = Number(src.backupRetention)
    if (Number.isFinite(n)) out.backupRetention = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.round(n)))
  }
  if (VIEWS.includes(src.defaultView)) out.defaultView = src.defaultView
  if (PAGE_SIZES.includes(Number(src.pageSize))) out.pageSize = Number(src.pageSize)
  if (VIEW_MODES.includes(src.viewMode)) out.viewMode = src.viewMode
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

/** 有效设置 = 默认 ← profile 基线（仅注入相关）← settings.json 覆盖（嵌套键按子键合并）。 */
export function effectiveSettings(base, root) {
  const b = base && typeof base === 'object' ? base : {}
  const baseLayer = sanitizeSettings({ autoInject: b.autoInject, injectionBudgetChars: b.injectionBudgetChars })
  return mergeLayers([SETTINGS_DEFAULTS, baseLayer, readOverlay(root)])
}

/** 合并写入覆盖层（原子写），返回写入后的覆盖层。
 *  读-改-写跨进程加锁：多窗口/多进程同时改不同键时不会互相覆盖丢失。
 *  嵌套命名空间只合并「当前已存在或本次显式提交」的子键——默认值由代码收敛，
 *  不把未触碰的默认设置物化进 settings.json（迁移/普通保存不得扩写 overlay）。 */
export function writeOverlay(root, patch) {
  return withLock(path.join(root, '.lock-settings'), () => {
    const current = readOverlay(root)
    const clean = sanitizeSettings(patch)
    const next = mergeLayers([current, clean], { seedDefaults: false })
    for (const key of NESTED_KEYS) {
      const touched = (current[key] && typeof current[key] === 'object') || (clean[key] && typeof clean[key] === 'object')
      if (!touched) delete next[key]
    }
    atomicWrite(settingsFile(root), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }, { timeoutMs: 1000, staleMs: 5000 })
}

/** 恢复默认：删除覆盖层文件（同样持锁，避免与并发合并写交错）。锁争用抛 code=busy。 */
export function resetOverlay(root) {
  withLock(path.join(root, '.lock-settings'), () => {
    fs.rmSync(settingsFile(root), { force: true })
  }, { timeoutMs: 1000, staleMs: 5000 })
}
