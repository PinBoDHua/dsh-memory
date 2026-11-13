/**
 * dsh-memory 存储层 Storage layer.
 *
 * Markdown + frontmatter，一事一条目，一条目一文件。每次操作实时重读磁盘，
 * 因此用户手工编辑文件后立即生效。写入走「临时文件 + 改名」的原子路径。
 * One fact per entry, one file per entry, Markdown with frontmatter. Every
 * operation re-reads from disk so hand edits take effect immediately. Writes
 * are atomic (temp file + rename).
 *
 * 布局 Layout（root 默认 ~/.dsh/.dsh-memory）:
 *   root/global/<id>.md
 *   root/workspaces/<cwd-hash>/<id>.md
 *   root/workspaces/index.json        （哈希 → cwd 对照，仅供排查 best-effort）
 *
 * schema v2：新增可选 frontmatter 字段（origin/supersedes/superseded_by/
 * superseded_at/expires/pinned/archived/last_access/hit_count）。新字段稀疏
 * 存储——仅在显式设置时写入文件，旧文件无需改写，读取时懒缺省（缺 origin
 * 视为 manual、缺 pinned/archived 视为 false）。v1→v2 迁移只升级 meta 锚点。
 *
 * 本模块只依赖 Node 内置模块，可独立单测。
 * This module only uses Node built-ins and is unit-testable standalone.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from './lock.js'

export const CATEGORIES = Object.freeze(['preference', 'fact', 'decision'])
export const SCOPES = Object.freeze(['global', 'workspace'])
export const ORIGINS = Object.freeze(['manual', 'auto'])
/** 存储布局版本：v2 引入取代链/过期/钉选/归档/衰减簿记（均可选字段）。 */
export const SCHEMA_VERSION = 2
const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKSPACE_KEY_PATTERN = /^[a-f0-9]{16}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** 命中簿记节流：同条目 ≤1 次/小时，避免每步装配高频写盘。 */
const ACCESS_THROTTLE_MS = 3600 * 1000
/** 相似提示（advisory）：Jaccard 阈值、最多条数、最小特征数（过短内容不参与，避免巧合噪音）。 */
const SIMILARITY_THRESHOLD = 0.5
const SIMILAR_LIMIT = 3
const SIMILAR_MIN_FEATURES = 3

/** 规范化工作区路径：绝对化、去尾部分隔符、Windows 下忽略大小写。 */
export function normalizeCwd(cwd) {
  const resolved = path.resolve(String(cwd))
  const trimmed = resolved.replace(/[\\/]+$/, '')
  const base = trimmed === '' ? resolved : trimmed
  return process.platform === 'win32' ? base.toLowerCase() : base
}

/** 工作区目录名：规范化 cwd 的 sha256 前 16 位。 */
export function workspaceKey(cwd) {
  return createHash('sha256').update(normalizeCwd(cwd)).digest('hex').slice(0, 16)
}

export function scopeDir(root, scope, cwd) {
  if (scope === 'global') return path.join(root, 'global')
  if (scope === 'workspace') {
    if (!cwd) throw new Error('workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
    return path.join(root, 'workspaces', workspaceKey(cwd))
  }
  throw new Error(`未知作用域 unknown scope: ${scope}`)
}

export function entryFile(root, entry, cwd) {
  return path.join(scopeDir(root, entry.scope, cwd), `${entry.id}.md`)
}

export function newId() {
  return `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** id 必须文件名安全（防路径穿越）。 */
export function isValidId(id) {
  return ID_PATTERN.test(String(id ?? ''))
}

export function cleanTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim().slice(0, 64)
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= 12) break
  }
  return out
}

/** expires 是否已过期（UTC、当日含；坏日期 fail-open 视为未过期）。 */
export function isExpired(entry, now = Date.now()) {
  const exp = entry?.expires
  if (typeof exp !== 'string' || !DATE_PATTERN.test(exp)) return false
  const today = new Date(now).toISOString().slice(0, 10)
  return exp < today
}

/** 是否被取代（superseded_by 非空）。 */
export function isSuperseded(entry) {
  return Boolean(entry?.superseded_by)
}

/** 默认隐藏态：被取代 / 已归档 / 已过期。可经 include_* 找回，可逆。 */
export function isHidden(entry, now = Date.now()) {
  return isSuperseded(entry) || Boolean(entry?.archived) || isExpired(entry, now)
}

/** 单一状态标签优先级：被取代 > 已过期 > 已归档 > 活跃（pinned 与状态正交）。与面板 statusOf 同口径。 */
export function entryStatus(entry, now = Date.now()) {
  if (isSuperseded(entry)) return 'superseded'
  if (isExpired(entry, now)) return 'expired'
  if (entry?.archived) return 'archived'
  return 'active'
}

/**
 * 软衰减乘子：clamp(1.5 − 0.15×闲置周数, 0.3, 1.5)。
 * 闲置周数＝floor(距 last_access 天数/7)，从未访问回退 updated。
 * pinned 或 decayEnabled=false 时恒 1（免衰减/回退现状）。永不过滤。
 */
export function decayMultiplier(entry, now = Date.now(), enabled = true) {
  if (!enabled || entry?.pinned) return 1
  const stamp = Date.parse(entry?.last_access || entry?.updated || '')
  if (!Number.isFinite(stamp)) return 1
  const days = Math.max(0, (now - stamp) / 86400000)
  const weeks = Math.floor(days / 7)
  const m = 1.5 - 0.15 * weeks
  return Math.min(1.5, Math.max(0.3, m))
}

/** 校验 expires 输入：空串清除；非空须为合法 YYYY-MM-DD（真实日期）。 */
export function normalizeExpires(value) {
  if (value === undefined || value === null || value === '') return ''
  const s = String(value).trim()
  if (!DATE_PATTERN.test(s)) {
    throw Object.assign(new Error(`过期日格式须为 YYYY-MM-DD / expires must be YYYY-MM-DD: ${s}`), { code: 'invalid' })
  }
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw Object.assign(new Error(`无效日期 / invalid date: ${s}`), { code: 'invalid' })
  }
  return s
}

export function serializeEntry(entry) {
  const lines = [
    '---',
    `id: ${entry.id}`,
    `category: ${entry.category}`,
    `scope: ${entry.scope}`,
    `tags: ${JSON.stringify(entry.tags ?? [])}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    `source: ${entry.source ?? ''}`,
  ]
  // v2 可选字段：稀疏写入（仅显式设置时落盘），保持旧文件形状不变。
  if (entry.origin) lines.push(`origin: ${entry.origin}`)
  if (entry.supersedes) lines.push(`supersedes: ${entry.supersedes}`)
  if (entry.superseded_by) lines.push(`superseded_by: ${entry.superseded_by}`)
  if (entry.superseded_at) lines.push(`superseded_at: ${entry.superseded_at}`)
  if (entry.expires) lines.push(`expires: ${entry.expires}`)
  if (entry.pinned) lines.push('pinned: true')
  if (entry.archived) lines.push('archived: true')
  if (entry.last_access) lines.push(`last_access: ${entry.last_access}`)
  if (entry.hit_count) lines.push(`hit_count: ${entry.hit_count}`)
  lines.push('---', '', String(entry.content).trim(), '')
  return lines.join('\n')
}

/** 宽容解析：坏文件返回 null 由调用方跳过，绝不抛出。 */
export function parseEntry(text, { expectedScope, fallbackId } = {}) {
  const normalized = String(text).replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) return null
  const header = normalized.slice(4, end)
  const content = normalized.slice(end + 5).trim()
  if (content === '') return null
  const fields = {}
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  let tags = []
  try {
    const parsed = JSON.parse(fields.tags ?? '[]')
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === 'string')
  } catch { /* 标签损坏时忽略 tags stay empty on malformed JSON */ }
  const id = ID_PATTERN.test(fields.id ?? '') ? fields.id : fallbackId
  if (!id || !ID_PATTERN.test(id)) return null
  const category = CATEGORIES.includes(fields.category) ? fields.category : 'fact'
  const scope = SCOPES.includes(fields.scope) ? fields.scope : expectedScope
  if (!scope) return null
  const entry = {
    id,
    category,
    scope,
    tags,
    created: fields.created ?? '',
    updated: fields.updated ?? fields.created ?? '',
    source: fields.source ?? '',
    content,
  }
  // v2 可选字段：仅在文件中出现时附加（懒缺省，旧文件保持原形状）。
  if (ORIGINS.includes(fields.origin)) entry.origin = fields.origin
  if (fields.supersedes && ID_PATTERN.test(fields.supersedes)) entry.supersedes = fields.supersedes
  if (fields.superseded_by && ID_PATTERN.test(fields.superseded_by)) entry.superseded_by = fields.superseded_by
  if (fields.superseded_at) entry.superseded_at = fields.superseded_at
  if (fields.expires) entry.expires = fields.expires
  if (fields.pinned === 'true') entry.pinned = true
  if (fields.archived === 'true') entry.archived = true
  if (fields.last_access) entry.last_access = fields.last_access
  const hits = Number.parseInt(fields.hit_count ?? '', 10)
  if (Number.isFinite(hits) && hits > 0) entry.hit_count = hits
  return entry
}

function readDirEntries(dir, scope) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!ID_PATTERN.test(id)) continue
    try {
      const entry = parseEntry(fs.readFileSync(path.join(dir, name), 'utf8'), { expectedScope: scope, fallbackId: id })
      if (entry) entries.push(entry)
    } catch { /* 跳过不可读文件 skip unreadable files */ }
  }
  return entries
}

function byUpdatedDesc(a, b) {
  return String(b.updated).localeCompare(String(a.updated))
}

export function listScope(root, scope, cwd) {
  if (scope === 'workspace' && !cwd) return []
  return readDirEntries(scopeDir(root, scope, cwd), scope).sort(byUpdatedDesc)
}

export function listAll(root, cwd) {
  return [...listScope(root, 'global', cwd), ...listScope(root, 'workspace', cwd)].sort(byUpdatedDesc)
}

/** 按目录键列出工作区记忆（索引损坏、cwd 未知时仍可用）。 */
export function listWorkspaceKey(root, key) {
  if (!WORKSPACE_KEY_PATTERN.test(String(key ?? ''))) return []
  return readDirEntries(path.join(root, 'workspaces', key), 'workspace').sort(byUpdatedDesc)
}

/** 读取存储元数据；缺失/损坏返回 null（只读，不写盘）。 */
export function readMeta(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.schemaVersion)) return parsed
  } catch { /* 缺失或损坏 missing or corrupt */ }
  return null
}

/** 首次写入时落 meta.json；损坏时重建。createdAt 一旦存在即保持稳定。 */
export function ensureMeta(root) {
  const existing = readMeta(root)
  if (existing) return existing
  const meta = { plugin: 'dsh-memory', schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() }
  try {
    atomicWrite(path.join(root, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  } catch { /* best-effort：元数据缺失不影响记忆读写 */ }
  return meta
}

/**
 * schema 迁移：v1→v2 仅升级 meta 锚点（新字段懒缺省，不逐文件改写）。
 * 返回是否发生了迁移。强制备份由服务层在调用前完成。
 */
export function migrateSchema(root) {
  const meta = readMeta(root)
  if (!meta) { ensureMeta(root); return false }
  if (meta.schemaVersion >= SCHEMA_VERSION) return false
  const next = { ...meta, schemaVersion: SCHEMA_VERSION }
  try {
    atomicWrite(path.join(root, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`)
  } catch { /* best-effort */ }
  return true
}

/** 目标作用域是否已占用该 id（文件存在即占用，含损坏文件）。 */
export function hasEntry(root, id, scope, cwd) {
  if (!isValidId(id)) return false
  try {
    return fs.existsSync(path.join(scopeDir(root, scope, cwd), `${id}.md`))
  } catch {
    return false
  }
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 哈希 → cwd 对照表，仅供人工排查；失败不影响记忆写入。跨进程加锁防丢键。 */
function touchWorkspaceIndex(root, cwd) {
  try {
    withLock(path.join(root, 'workspaces', '.lock'), () => {
      const key = workspaceKey(cwd)
      const file = path.join(root, 'workspaces', 'index.json')
      let index = {}
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed
      } catch { /* 首次写入或损坏 first write or corrupt */ }
      const now = new Date().toISOString()
      const prev = index[key]
      index[key] = {
        cwd: normalizeCwd(cwd),
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
      }
      atomicWrite(file, `${JSON.stringify(index, null, 2)}\n`)
    })
  } catch { /* best-effort */ }
}

/** 去重用的内容规范化：折叠空白、忽略大小写。 */
export function normalizeContent(text) {
  return String(text).replace(/\s+/g, ' ').toLowerCase()
}

/** 内容特征集：拉丁/数字词（≥2 字符）＋CJK bigram（单字保留），用于相似度。 */
function contentFeatures(text) {
  const s = String(text).toLowerCase()
  const feats = new Set()
  for (const w of s.match(/[a-z0-9]+/g) || []) if (w.length >= 2) feats.add(w)
  for (const g of cjkBigrams(s)) feats.add(g)
  return feats
}

/** 特征集 Jaccard（交/并）。过短内容（特征 <3）恒 0，避免巧合噪音。 */
function jaccardFeatures(A, B) {
  if (A.size < SIMILAR_MIN_FEATURES || B.size < SIMILAR_MIN_FEATURES) return 0
  let inter = 0
  for (const f of A) if (B.has(f)) inter += 1
  return inter / (A.size + B.size - inter)
}

/**
 * 内容相似度（Jaccard：交/并）。过短内容（特征 <3）恒 0，避免巧合噪音。
 * 仅用于写入时的相似提示与查重（advisory），不参与去重判定与检索过滤。
 */
export function contentSimilarity(a, b) {
  return jaccardFeatures(contentFeatures(a), contentFeatures(b))
}

/**
 * 写入一条记忆。同作用域内容完全相同（忽略空白与大小写）时去重，
 * 返回既有条目并标记 deduplicated。去重只针对未取代条目（允许「save 新＋
 * supersedes 旧」的修正流）。可选 supersedes 标记旧条目被取代（失效不删除）。
 */
export function saveEntry(root, { content, category = 'fact', scope = 'workspace', tags = [], cwd, source, origin, supersedes, expires, pinned } = {}) {
  const text = String(content ?? '').trim()
  if (text === '') throw new Error('记忆内容不能为空 / memory content must not be empty')
  if (!CATEGORIES.includes(category)) throw new Error(`未知分类 unknown category: ${category}`)
  if (!SCOPES.includes(scope)) throw new Error(`未知作用域 unknown scope: ${scope}`)
  if (scope === 'workspace' && !cwd) {
    throw new Error('workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
  }
  if (origin !== undefined && !ORIGINS.includes(origin)) {
    throw Object.assign(new Error(`未知来源 unknown origin: ${origin}`), { code: 'invalid' })
  }
  const exp = normalizeExpires(expires)
  const normalized = normalizeContent(text)
  const candidates = listScope(root, scope, cwd)
  const existing = candidates.find(
    (e) => normalizeContent(e.content) === normalized && !e.superseded_by,
  )
  if (existing) return { entry: existing, deduplicated: true }
  let target
  if (supersedes !== undefined && supersedes !== '') {
    if (!isValidId(supersedes)) throw Object.assign(new Error(`非法取代 id / invalid supersede id: ${supersedes}`), { code: 'invalid' })
    target = findEntry(root, supersedes, cwd)
    if (!target) throw Object.assign(new Error(`未找到要取代的记忆 / memory to supersede not found: ${supersedes}`), { code: 'invalid' })
  }
  const now = new Date().toISOString()
  const entry = {
    id: newId(),
    category,
    scope,
    tags: cleanTags(tags),
    created: now,
    updated: now,
    source: typeof source === 'string' ? source : '',
    content: text,
    origin: ORIGINS.includes(origin) ? origin : 'manual',
  }
  if (exp) entry.expires = exp
  if (pinned) entry.pinned = true
  if (target) entry.supersedes = target.id
  ensureMeta(root)
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  if (scope === 'workspace') touchWorkspaceIndex(root, cwd)
  if (target) {
    target.superseded_by = entry.id
    target.superseded_at = now
    try { atomicWrite(entryFile(root, target, cwd), serializeEntry(target)) } catch { /* best-effort */ }
  }
  // 相似提示：同作用域活跃条目中找近似内容（排除显式取代目标），按分数倒序取前 N。
  // 仅提示不阻断——是否取代/更新由调用方决定。
  const similar = []
  for (const e of candidates) {
    if (e.superseded_by || e.archived || isExpired(e)) continue
    if (target && e.id === target.id) continue
    const score = contentSimilarity(text, e.content)
    if (score >= SIMILARITY_THRESHOLD) similar.push({ id: e.id, content: e.content, score: Math.round(score * 100) / 100 })
  }
  similar.sort((a, b) => b.score - a.score)
  if (similar.length > SIMILAR_LIMIT) similar.length = SIMILAR_LIMIT
  return { entry, deduplicated: false, similar }
}

/** 按 id 在 global 与当前工作区中查找；id 必须文件名安全（防路径穿越）。 */
export function findEntry(root, id, cwd) {
  if (!ID_PATTERN.test(String(id ?? ''))) return undefined
  for (const scope of SCOPES) {
    if (scope === 'workspace' && !cwd) continue
    try {
      const entry = parseEntry(fs.readFileSync(path.join(scopeDir(root, scope, cwd), `${id}.md`), 'utf8'), {
        expectedScope: scope,
        fallbackId: id,
      })
      if (entry) return entry
    } catch { /* 该作用域没有此条目 not in this scope */ }
  }
  return undefined
}

/** 新覆旧：原地更新内容/分类/标签并刷新 updated 时间；可选取代另一条记忆。 */
export function updateEntry(root, id, patch = {}, cwd) {
  const entry = findEntry(root, id, cwd)
  if (!entry) throw new Error(`未找到记忆 / memory not found: ${id}`)
  let target
  if (patch.supersedes !== undefined && patch.supersedes !== '') {
    if (!isValidId(patch.supersedes)) throw Object.assign(new Error(`非法取代 id / invalid supersede id: ${patch.supersedes}`), { code: 'invalid' })
    target = findEntry(root, patch.supersedes, cwd)
    if (!target) throw Object.assign(new Error(`未找到要取代的记忆 / memory to supersede not found: ${patch.supersedes}`), { code: 'invalid' })
    if (target.id === entry.id) throw Object.assign(new Error('不能取代自身 / cannot supersede itself'), { code: 'invalid' })
  }
  applyPatch(entry, patch)
  if (target) entry.supersedes = target.id
  entry.updated = new Date().toISOString()
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  if (target) {
    target.superseded_by = entry.id
    target.superseded_at = entry.updated
    try { atomicWrite(entryFile(root, target, cwd), serializeEntry(target)) } catch { /* best-effort */ }
  }
  return entry
}

export function forgetEntry(root, id, cwd) {
  const entry = findEntry(root, id, cwd)
  if (!entry) return false
  fs.rmSync(entryFile(root, entry, cwd), { force: true })
  return true
}

function applyPatch(entry, patch) {
  if (patch.content !== undefined) {
    const text = String(patch.content).trim()
    if (text === '') throw Object.assign(new Error('记忆内容不能为空 / memory content must not be empty'), { code: 'invalid' })
    entry.content = text
  }
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category)) throw Object.assign(new Error(`未知分类 unknown category: ${patch.category}`), { code: 'invalid' })
    entry.category = patch.category
  }
  if (patch.tags !== undefined) entry.tags = cleanTags(patch.tags)
  if (patch.origin !== undefined) {
    if (!ORIGINS.includes(patch.origin)) throw Object.assign(new Error(`未知来源 unknown origin: ${patch.origin}`), { code: 'invalid' })
    entry.origin = patch.origin
  }
  if (patch.expires !== undefined) {
    const exp = normalizeExpires(patch.expires)
    if (exp) entry.expires = exp
    else delete entry.expires
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned) entry.pinned = true
    else delete entry.pinned
  }
  if (patch.archived !== undefined) {
    if (patch.archived) entry.archived = true
    else delete entry.archived
  }
}

/**
 * 跨作用域移动（global ↔ 当前工作区），可同时应用内容/分类/标签补丁。
 * 目标作用域已有相同内容时抛 code=duplicate；先写新文件再删旧文件。
 * 同作用域为纯 no-op（不刷新时间戳、不落盘）。
 */
export function moveEntry(root, id, targetScope, cwd, patch = {}) {
  const entry = findEntry(root, id, cwd)
  if (!entry) throw new Error(`未找到记忆 / memory not found: ${id}`)
  if (!SCOPES.includes(targetScope)) throw Object.assign(new Error(`未知作用域 unknown scope: ${targetScope}`), { code: 'invalid' })
  if (targetScope === 'workspace' && !cwd) {
    throw Object.assign(new Error('workspace 记忆需要会话工作目录 / workspace memory requires a session working directory'), { code: 'no-workspace' })
  }
  if (entry.scope === targetScope) return entry
  applyPatch(entry, patch)
  entry.updated = new Date().toISOString()
  const normalized = normalizeContent(entry.content)
  const dup = listScope(root, targetScope, cwd).find((e) => normalizeContent(e.content) === normalized)
  if (dup) {
    throw Object.assign(new Error('目标作用域已有相同内容的记忆 / identical memory already exists in the target scope'), { code: 'duplicate' })
  }
  const oldFile = entryFile(root, entry, cwd)
  entry.scope = targetScope
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  fs.rmSync(oldFile, { force: true })
  if (targetScope === 'workspace') touchWorkspaceIndex(root, cwd)
  return entry
}

/** 写入一条完整成形的记忆（导入用）：保留 id 与时间戳，不做去重。 */
export function writeEntry(root, entry, cwd) {
  ensureMeta(root)
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  if (entry.scope === 'workspace') touchWorkspaceIndex(root, cwd)
  return entry
}

/**
 * 命中簿记：被检索返回或被注入即一次命中。节流 ≤1 次/小时/条目，
 * 更新 last_access/hit_count 并原子落盘（不刷新 updated）。best-effort。
 */
export function touchAccess(root, entries, cwd, now = Date.now()) {
  for (const entry of entries) {
    const prev = Date.parse(entry.last_access || '')
    if (Number.isFinite(prev) && now - prev < ACCESS_THROTTLE_MS) continue
    entry.last_access = new Date(now).toISOString()
    entry.hit_count = (Number(entry.hit_count) || 0) + 1
    try { atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry)) } catch { /* best-effort */ }
  }
}

function countOccurrences(haystack, needle) {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** 提取 CJK 连续段的 bigram（单字保留 unigram），用于中文模糊匹配。 */
function cjkBigrams(token) {
  const grams = []
  const runs = token.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || []
  for (const run of runs) {
    if (run.length === 1) grams.push(run)
    else for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2))
  }
  return grams
}

/** 词匹配：精确子串命中，或 CJK bigram 覆盖率 ≥0.6（提升中文召回）。 */
function tokenMatches(haystack, token) {
  if (haystack.includes(token)) return true
  const grams = cjkBigrams(token)
  if (grams.length === 0) return false
  const hit = grams.filter((g) => haystack.includes(g)).length
  return hit / grams.length >= 0.6
}

/**
 * 相关度打分：内容命中×3、标签命中×2、分类/id 命中×1，逐词累加；
 * 内容含紧凑短语（词间无空格，CJK 相邻）+4，含空格短语 +2。
 * 分数相同按更新时间倒序。
 */
function relevance(entry, tokens, phraseCompact, phraseJoined) {
  const content = entry.content.toLowerCase()
  const tags = entry.tags.join(' ').toLowerCase()
  const meta = `${entry.category}\n${entry.id}`.toLowerCase()
  let score = 0
  for (const t of tokens) {
    score += 3 * countOccurrences(content, t)
    score += 2 * countOccurrences(tags, t)
    if (meta.includes(t)) score += 1
  }
  if (content.includes(phraseCompact)) score += 4
  else if (tokens.length > 1 && content.includes(phraseJoined)) score += 2
  return score
}

/**
 * 过滤＋排序后的完整结果（不分页）：stats 与 search 共用同一语义。
 * 默认隐藏被取代/已过期/已归档条目（include_* 可找回）；非空查询按
 * 相关度×衰减乘子＋钉选小幅 boost 排序（boost 不扩召回集合）；
 * 空查询按更新时间倒序。
 */
export function filterEntries(root, {
  query = '', scope = 'all', category, cwd, origin, tag, status,
  includeSuperseded = false, includeExpired = false, includeArchived = false,
  decayEnabled = true, now = Date.now(),
} = {}) {
  let entries = scope === 'all' ? listAll(root, cwd) : listScope(root, scope, cwd)
  if (category) entries = entries.filter((e) => e.category === category)
  if (origin) entries = entries.filter((e) => (e.origin || 'manual') === origin)
  if (tag) {
    const needle = String(tag).toLowerCase()
    entries = entries.filter((e) => (e.tags || []).some((t) => String(t).toLowerCase() === needle))
  }
  entries = entries.filter((e) => {
    if (isSuperseded(e) && !includeSuperseded) return false
    if (e.archived && !includeArchived) return false
    if (isExpired(e, now) && !includeExpired) return false
    return true
  })
  if (status === 'pinned') entries = entries.filter((e) => e.pinned)
  else if (status && status !== 'all') entries = entries.filter((e) => entryStatus(e, now) === status)
  const trimmed = String(query).trim().toLowerCase()
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length > 0) {
    entries = entries.filter((e) => {
      const haystack = `${e.content}\n${e.tags.join(' ')}\n${e.category}\n${e.id}`.toLowerCase()
      return tokens.every((t) => tokenMatches(haystack, t))
    })
    const phraseCompact = tokens.join('')
    const phraseJoined = tokens.join(' ')
    entries = entries
      .map((e) => ({ e, score: relevance(e, tokens, phraseCompact, phraseJoined) * decayMultiplier(e, now, decayEnabled) + (e.pinned ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || byUpdatedDesc(a.e, b.e))
      .map(({ e }) => e)
  }
  return entries
}

/**
 * 关键词检索：查询分词后要求全部命中（AND），匹配内容/标签/分类/id，
 * 大小写不敏感，CJK 支持 bigram 模糊。非空查询按相关度排序（同分按更新
 * 时间倒序）；空查询＝按更新时间倒序列出。offset/limit 用于分页。
 */
export function searchEntries(root, {
  query = '', scope = 'all', category, cwd, origin, tag, status, limit = 20, offset = 0,
  includeSuperseded = false, includeExpired = false, includeArchived = false,
  decayEnabled = true, now = Date.now(),
} = {}) {
  const entries = filterEntries(root, {
    query, scope, category, cwd, origin, tag, status,
    includeSuperseded, includeExpired, includeArchived, decayEnabled, now,
  })
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  return entries.slice(start, start + max)
}

/**
 * 相似记忆查重：同作用域活跃条目两两 Jaccard 相似度，返回 ≥threshold 的相似对
 * （按分数倒序、limit 截断）。每对含 older/newer（按 updated 升序，旧在前）与 score。
 * 排除被取代/已归档/已过期条目；跨作用域不配对。按需调用（面板查重），非装配热路径。
 */
export function findSimilarPairs(root, { scope = 'all', cwd, threshold = SIMILARITY_THRESHOLD, limit = 50, now = Date.now() } = {}) {
  const groups = scope === 'all'
    ? [listScope(root, 'global', cwd), listScope(root, 'workspace', cwd)]
    : [listScope(root, scope, cwd)]
  const pairs = []
  for (const list of groups) {
    const active = list.filter((e) => !isHidden(e, now))
    const feats = active.map((e) => contentFeatures(e.content))
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const score = jaccardFeatures(feats[i], feats[j])
        if (score < threshold) continue
        const a = active[i]
        const b = active[j]
        const [older, newer] = String(a.updated) <= String(b.updated) ? [a, b] : [b, a]
        pairs.push({
          score: Math.round(score * 100) / 100,
          older: { id: older.id, content: older.content, scope: older.scope, updated: older.updated },
          newer: { id: newer.id, content: newer.content, scope: newer.scope, updated: newer.updated },
        })
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score || String(x.older.id).localeCompare(String(y.older.id)))
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50
  return pairs.slice(0, max)
}
