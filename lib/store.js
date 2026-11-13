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

/** 宽容解析：坏文件返回 null 由调用方跳过，绝不抛出。
 *  BOM 容忍（Windows 记事本保存会带 BOM）；id 以文件名为权威——frontmatter 的 id
 *  可能是复制/改名/手改后的残留，若以它为准则会出现「forget 删掉另一条文件」
 *  「update 覆盖另一条正文」「同一条记忆出现两个 id」等数据事故。 */
export function parseEntry(text, { expectedScope, fallbackId } = {}) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
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
  const id = ID_PATTERN.test(String(fallbackId ?? '')) ? fallbackId : (ID_PATTERN.test(fields.id ?? '') ? fields.id : undefined)
  if (!id) return null
  const category = CATEGORIES.includes(fields.category) ? fields.category : 'fact'
  // 目录才是作用域权威：frontmatter 的 scope 可能被手工改错/文件放错目录，
  // 若以它为准则会出现「forget 报成功但文件仍在」「update 写到另一目录」。
  const scope = SCOPES.includes(expectedScope)
    ? expectedScope
    : (SCOPES.includes(fields.scope) ? fields.scope : undefined)
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

/**
 * 解析缓存：文件路径 → { sig, entry }。签名含 mtime/ctime/size——本进程与其它
 * 进程都用「临时文件＋改名」原子写，改名后的新文件 ctime 必变；手工编辑同样
 * 改变 mtime/ctime，因此缓存不会破坏「改完立即生效」契约，只是把命中路径从
 * 「读文件＋解析」降到一次 statSync（热路径 N 个文件时收益显著）。
 * 返回给调用方的始终是浅拷贝，避免调用方原地修改污染缓存。
 */
const entryCache = new Map()
/** 目录 → 该目录上次列出的文件集合，用于 O(目录内文件数) 清理已删除文件的缓存。 */
const entryDirIndex = new Map()
const ENTRY_CACHE_LIMIT = 4096

function entrySignature(st) {
  // Windows 文件时间取自 ~15.6ms 系统 tick，同 tick 内的多次写可能 mtime/ctime/size
  // 完全不变；追加 ino/birthtimeMs（stat 已在手，零额外 IO）让原子写（改名新建 inode）
  // 与删除重建必然可辨，避免热路径长期返回陈旧内容。
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}:${st.birthtimeMs}`
}

function cloneEntry(entry) {
  if (!entry) return entry
  const copy = { ...entry }
  if (Array.isArray(entry.tags)) copy.tags = [...entry.tags]
  return copy
}

function readEntryFileCached(file, scope, fallbackId) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    entryCache.delete(file)
    return null
  }
  const sig = entrySignature(st)
  const hit = entryCache.get(file)
  if (hit && hit.sig === sig) return cloneEntry(hit.entry)
  let entry = null
  try {
    entry = parseEntry(fs.readFileSync(file, 'utf8'), { expectedScope: scope, fallbackId })
  } catch { /* 损坏/不可读文件按 null 缓存发现失败，签名变化时会重试 corrupt => null */ }
  if (entryCache.size >= ENTRY_CACHE_LIMIT) {
    const oldest = entryCache.keys().next().value
    if (oldest !== undefined) entryCache.delete(oldest)
  }
  entryCache.set(file, { sig, entry })
  return cloneEntry(entry)
}

/** 清空解析缓存（测试/运维用；正常读写靠文件签名自动失效，无需调用）。 */
export function clearEntryCache() {
  entryCache.clear()
  entryDirIndex.clear()
  accessCache.clear()
}

// ===== 命中簿记账本 access.json =====
// 命中（检索返回/系统提示注入）只更新账本，不再改写条目 Markdown——消除单条文件
// 读-改-写窗口（并发时可能回滚正文）与每次检索的写放大。账本读取带签名缓存。
const accessCache = new Map() // root -> { sig, map }
const ACCESS_CACHE_LIMIT = 16

function accessFilePath(root) {
  return path.join(root, 'access.json')
}

function accessSignature(st) {
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}:${st.birthtimeMs}`
}

function sanitizeAccessMap(parsed) {
  const map = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map
  for (const [id, rec] of Object.entries(parsed)) {
    if (!ID_PATTERN.test(id) || !rec || typeof rec !== 'object') continue
    const at = typeof rec.at === 'string' ? rec.at : ''
    const count = Number(rec.count)
    if (!at || !Number.isFinite(Date.parse(at)) || !Number.isFinite(count) || count <= 0) continue
    map[id] = { at, count: Math.floor(count) }
  }
  return map
}

/** 读取命中账本（带签名缓存）；缺失/损坏按空账本处理，不影响读写。 */
function readAccessLedger(root) {
  const file = accessFilePath(root)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    accessCache.delete(root)
    return {}
  }
  const sig = accessSignature(st)
  const hit = accessCache.get(root)
  if (hit && hit.sig === sig) return hit.map
  let map = {}
  try {
    map = sanitizeAccessMap(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch { /* 损坏按空账本 corrupt => empty */ }
  if (accessCache.size >= ACCESS_CACHE_LIMIT) {
    const oldest = accessCache.keys().next().value
    if (oldest !== undefined) accessCache.delete(oldest)
  }
  accessCache.set(root, { sig, map })
  return map
}

/** 把账本命中值叠加到解析结果（账本权威；无记录时保留文件内旧字段）。 */
function applyAccess(root, entries) {
  const ledger = readAccessLedger(root)
  if (Object.keys(ledger).length === 0) return entries
  return entries.map((entry) => {
    const rec = entry && ledger[entry.id]
    if (!rec) return entry
    const merged = cloneEntry(entry)
    merged.last_access = rec.at
    merged.hit_count = rec.count
    return merged
  })
}

/**
 * 从命中账本移除指定 id（删除条目后清理）：避免账本残留「幽灵命中」——否则重新
 * 导入同 id 的新记忆会继承已删除条目的 last_access/hit_count，排序/统计失真，
 * 账本也会只增不减。best-effort，失败不影响删除本身。
 */
function removeAccessRecords(root, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => isValidId(id))
  if (list.length === 0) return
  const file = accessFilePath(root)
  try {
    withLock(path.join(root, '.lock-access'), () => {
      let map = {}
      try {
        map = sanitizeAccessMap(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {
        return
      }
      let changed = false
      for (const id of list) {
        if (map[id]) {
          delete map[id]
          changed = true
        }
      }
      if (!changed) return
      atomicWrite(file, `${JSON.stringify(map, null, 2)}\n`)
      try {
        const st = fs.statSync(file)
        if (accessCache.size >= ACCESS_CACHE_LIMIT) {
          const oldest = accessCache.keys().next().value
          if (oldest !== undefined) accessCache.delete(oldest)
        }
        accessCache.set(root, { sig: accessSignature(st), map })
      } catch { accessCache.delete(root) }
    })
  } catch { /* best-effort */ }
}

function readDirEntries(dir, scope) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    // 目录整体消失（workspace 被删）：清掉该目录的缓存条目与索引。
    const stale = entryDirIndex.get(dir)
    if (stale) {
      for (const file of stale) entryCache.delete(file)
      entryDirIndex.delete(dir)
    }
    return []
  }
  const entries = []
  const alive = new Set()
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!ID_PATTERN.test(id)) continue
    const file = path.join(dir, name)
    alive.add(file)
    const entry = readEntryFileCached(file, scope, id)
    if (entry) entries.push(entry)
  }
  // 清掉本目录下已删除文件的缓存，避免长期运行缓存只增不减（只遍历该目录上次的
  // 文件集合，不做全缓存扫描）。
  const previous = entryDirIndex.get(dir)
  if (previous) {
    for (const oldFile of previous) if (!alive.has(oldFile)) entryCache.delete(oldFile)
  }
  entryDirIndex.set(dir, alive)
  return entries
}

function byUpdatedDesc(a, b) {
  return String(b.updated).localeCompare(String(a.updated))
}

export function listScope(root, scope, cwd) {
  if (scope === 'workspace' && !cwd) return []
  return applyAccess(root, readDirEntries(scopeDir(root, scope, cwd), scope)).sort(byUpdatedDesc)
}

export function listAll(root, cwd) {
  return [...listScope(root, 'global', cwd), ...listScope(root, 'workspace', cwd)].sort(byUpdatedDesc)
}

/** 按目录键列出工作区记忆（索引损坏、cwd 未知时仍可用）。 */
export function listWorkspaceKey(root, key) {
  if (!WORKSPACE_KEY_PATTERN.test(String(key ?? ''))) return []
  return applyAccess(root, readDirEntries(path.join(root, 'workspaces', key), 'workspace')).sort(byUpdatedDesc)
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

/**
 * 收集全部作用域（global＋所有工作区目录）已占用的 id 集合（只读文件名，不读文件内容）。
 * 导入时用它保证 id 跨作用域唯一，避免「同一 id 在 global 与 workspace 并存」导致
 * findEntry 全局优先、按 id 更新/删除命中错误条目。
 */
export function allEntryIds(root) {
  const ids = new Set()
  const collect = (dir) => {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      if (ID_PATTERN.test(id)) ids.add(id)
    }
  }
  collect(path.join(root, 'global'))
  let keys = []
  try {
    keys = fs.readdirSync(path.join(root, 'workspaces'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && WORKSPACE_KEY_PATTERN.test(d.name))
      .map((d) => d.name)
  } catch { /* 无工作区目录 no workspace dir */ }
  for (const key of keys) collect(path.join(root, 'workspaces', key))
  return ids
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
  if (existing) {
    // 去重只对可见条目直接返回既有结果；若既有条目处于归档/过期隐藏态，
    // 用户再次保存同一事实意味着希望它重新生效 → 复活（清隐藏标记、刷新
    // updated/origin），避免「提示已存在却搜不到」的死角。
    const revived = Boolean(existing.archived) || isExpired(existing)
    if (!revived) return { entry: existing, deduplicated: true }
    delete existing.archived
    delete existing.expires
    existing.updated = new Date().toISOString()
    if (ORIGINS.includes(origin)) existing.origin = origin
    atomicWrite(entryFile(root, existing, cwd), serializeEntry(existing))
    return { entry: existing, deduplicated: true, revived: true }
  }
  let target
  if (supersedes !== undefined && supersedes !== '') {
    target = resolveSupersedeTarget(root, undefined, supersedes, cwd)
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
    const entry = readEntryFileCached(path.join(scopeDir(root, scope, cwd), `${id}.md`), scope, id)
    if (entry) return applyAccess(root, [entry])[0]
  }
  return undefined
}

function invalidError(message) {
  return Object.assign(new Error(message), { code: 'invalid' })
}

/**
 * 取代链目标校验（save/update/move 共用）：目标必须存在、不得是自身、不得已有
 * 后继（防止覆盖别人的取代链），且不得形成环（目标沿 supersedes 链向上能走回
 * 当前条目）。返回目标条目；违反任一条抛 code=invalid。
 */
function resolveSupersedeTarget(root, entryId, supersedes, cwd) {
  if (!isValidId(supersedes)) throw invalidError(`非法取代 id / invalid supersede id: ${supersedes}`)
  const target = findEntry(root, supersedes, cwd)
  if (!target) throw invalidError(`未找到要取代的记忆 / memory to supersede not found: ${supersedes}`)
  if (entryId !== undefined && target.id === entryId) throw invalidError('不能取代自身 / cannot supersede itself')
  if (target.superseded_by && target.superseded_by !== entryId) {
    throw invalidError(`目标记忆已被取代，不能覆盖其取代链 / target memory is already superseded: ${target.id} -> ${target.superseded_by}`)
  }
  if (entryId !== undefined) {
    // 环判定：target 沿 supersedes 链向上若能走到 entryId，则 entryId 再取代 target 会成环。
    const seen = new Set([target.id])
    let cursor = target
    while (cursor && cursor.supersedes) {
      if (cursor.supersedes === entryId) throw invalidError('不能形成取代环 / refusing to create a supersede cycle')
      if (seen.has(cursor.supersedes)) break
      seen.add(cursor.supersedes)
      cursor = findEntry(root, cursor.supersedes, cwd)
    }
  }
  return target
}

/** 新覆旧：原地更新内容/分类/标签并刷新 updated 时间；可选取代另一条记忆。 */
export function updateEntry(root, id, patch = {}, cwd) {
  const entry = findEntry(root, id, cwd)
  if (!entry) throw new Error(`未找到记忆 / memory not found: ${id}`)
  let target
  const previousSupersedes = entry.supersedes
  if (patch.supersedes !== undefined && patch.supersedes !== '') {
    target = resolveSupersedeTarget(root, entry.id, patch.supersedes, cwd)
  }
  applyPatch(entry, patch)
  if (target) entry.supersedes = target.id
  entry.updated = new Date().toISOString()
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  // 更新工作区条目也刷新索引 lastSeen（面板工作区排序/「最近使用」据此）。
  if (entry.scope === 'workspace') touchWorkspaceIndex(root, cwd)
  if (target) {
    target.superseded_by = entry.id
    target.superseded_at = entry.updated
    try { atomicWrite(entryFile(root, target, cwd), serializeEntry(target)) } catch { /* best-effort */ }
    // 改取代目标时清理旧目标的反向引用，避免「旧目标仍隐藏但已无人指向它」。
    if (previousSupersedes && previousSupersedes !== target.id) clearSupersededBy(root, previousSupersedes, entry.id, cwd)
  }
  return entry
}

/** 若旧目标仍被 entryId 标记为已取代，清掉反向引用（改链/删除后的悬垂清理）。 */
function clearSupersededBy(root, targetId, entryId, cwd) {
  try {
    const old = findEntry(root, targetId, cwd)
    if (!old || old.superseded_by !== entryId) return
    delete old.superseded_by
    delete old.superseded_at
    atomicWrite(entryFile(root, old, cwd), serializeEntry(old))
  } catch { /* best-effort */ }
}

/**
 * 永久删除一条记忆，并清理它参与的取代链引用（同可见范围：global＋当前工作区）：
 * - 被它取代的旧条目清掉 superseded_by/superseded_at → 重新可见，避免「悬垂引用
 *   让旧记忆永久隐藏」；
 * - 取代它的新条目清掉 supersedes 指针 → 不指向已删除的 id。
 * 清理失败不影响删除本身（best-effort）。
 */
export function forgetEntry(root, id, cwd) {
  if (!isValidId(id)) return false
  const entry = findEntry(root, id, cwd)
  if (!entry) {
    // 损坏/不可解析文件：findEntry 认不出来，但删除操作应以文件为准——否则坏文件
    // 永久残留（列表看不到、工具删不掉，还占用存储统计）。
    let removed = false
    for (const scope of SCOPES) {
      if (scope === 'workspace' && !cwd) continue
      const file = path.join(scopeDir(root, scope, cwd), `${id}.md`)
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true })
          removed = true
        }
      } catch { /* best-effort */ }
    }
    if (removed) removeAccessRecords(root, [id])
    return removed
  }
  try {
    for (const other of listAll(root, cwd)) {
      if (other.id === entry.id) continue
      if (other.superseded_by === entry.id) {
        delete other.superseded_by
        delete other.superseded_at
        atomicWrite(entryFile(root, other, cwd), serializeEntry(other))
      } else if (other.supersedes === entry.id) {
        delete other.supersedes
        atomicWrite(entryFile(root, other, cwd), serializeEntry(other))
      }
    }
  } catch { /* best-effort：清理失败仍执行删除 */ }
  fs.rmSync(entryFile(root, entry, cwd), { force: true })
  removeAccessRecords(root, [entry.id])
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
  // 移动可同时建立取代链（此前 supersedes 被静默丢弃，工具却报「已更新」）；
  // 先校验再落盘，失败时不影响原条目。
  let supersedeTarget
  const previousSupersedes = entry.supersedes
  if (patch.supersedes !== undefined && patch.supersedes !== '') {
    supersedeTarget = resolveSupersedeTarget(root, entry.id, patch.supersedes, cwd)
  }
  applyPatch(entry, patch)
  if (supersedeTarget) entry.supersedes = supersedeTarget.id
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
  if (supersedeTarget) {
    supersedeTarget.superseded_by = entry.id
    supersedeTarget.superseded_at = entry.updated
    try { atomicWrite(entryFile(root, supersedeTarget, cwd), serializeEntry(supersedeTarget)) } catch { /* best-effort */ }
    if (previousSupersedes && previousSupersedes !== supersedeTarget.id) clearSupersededBy(root, previousSupersedes, entry.id, cwd)
  }
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
 * 命中簿记：被检索返回或被注入即一次命中。节流 ≤1 次/小时/条目。
 * 只更新独立账本 `access.json`（withLock 内读-改-写，跨进程安全），不再改写条目
 * Markdown——没有单文件读-改-写窗口，也不会覆盖并发写入的正文；账本损坏按空处理。
 * best-effort：簿记失败不影响检索本身。
 */
export function touchAccess(root, entries, cwd, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) return
  const file = accessFilePath(root)
  try {
    withLock(path.join(root, '.lock-access'), () => {
      // 锁内重读账本，避免并发进程互相覆盖。
      let map = {}
      try {
        map = sanitizeAccessMap(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch { /* 首次写入或损坏 first write or corrupt */ }
      let changed = false
      for (const snapshot of entries) {
        if (!snapshot || !isValidId(snapshot.id)) continue
        const prev = map[snapshot.id]
        const ledgerAt = prev ? Date.parse(prev.at) : NaN
        const snapshotAt = Date.parse(snapshot.last_access || '')
        const last = Number.isFinite(ledgerAt) ? ledgerAt : (Number.isFinite(snapshotAt) ? snapshotAt : NaN)
        if (Number.isFinite(last) && now - last < ACCESS_THROTTLE_MS) continue
        const prevCount = prev ? Number(prev.count) : (Number(snapshot.hit_count) || 0)
        map[snapshot.id] = { at: new Date(now).toISOString(), count: Math.floor(Number.isFinite(prevCount) ? prevCount : 0) + 1 }
        changed = true
      }
      if (!changed) return
      atomicWrite(file, `${JSON.stringify(map, null, 2)}\n`)
      try {
        const st = fs.statSync(file)
        if (accessCache.size >= ACCESS_CACHE_LIMIT) {
          const oldest = accessCache.keys().next().value
          if (oldest !== undefined) accessCache.delete(oldest)
        }
        accessCache.set(root, { sig: accessSignature(st), map })
      } catch { accessCache.delete(root) }
    })
  } catch { /* best-effort：簿记失败不影响检索 */ }
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
