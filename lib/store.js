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
 * 本模块只依赖 Node 内置模块，可独立单测。
 * This module only uses Node built-ins and is unit-testable standalone.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from './lock.js'

export const CATEGORIES = Object.freeze(['preference', 'fact', 'decision'])
export const SCOPES = Object.freeze(['global', 'workspace'])
/** 存储布局版本：未来迁移的锚点。 */
export const SCHEMA_VERSION = 1
const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKSPACE_KEY_PATTERN = /^[a-f0-9]{16}$/

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

export function serializeEntry(entry) {
  return [
    '---',
    `id: ${entry.id}`,
    `category: ${entry.category}`,
    `scope: ${entry.scope}`,
    `tags: ${JSON.stringify(entry.tags ?? [])}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    `source: ${entry.source ?? ''}`,
    '---',
    '',
    String(entry.content).trim(),
    '',
  ].join('\n')
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
  return {
    id,
    category,
    scope,
    tags,
    created: fields.created ?? '',
    updated: fields.updated ?? fields.created ?? '',
    source: fields.source ?? '',
    content,
  }
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

/** 目标作用域是否已占用该 id（文件存在即占用，含损坏文件）。 */
export function hasEntry(root, id, scope, cwd) {
  if (!isValidId(id)) return false
  try {
    return fs.existsSync(path.join(scopeDir(root, scope, cwd), `${id}.md`))
  } catch {
    return false
  }
}

function atomicWrite(file, text) {
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

/**
 * 写入一条记忆。同作用域内容完全相同（忽略空白与大小写）时去重，
 * 返回既有条目并标记 deduplicated。
 */
export function saveEntry(root, { content, category = 'fact', scope = 'workspace', tags = [], cwd, source } = {}) {
  const text = String(content ?? '').trim()
  if (text === '') throw new Error('记忆内容不能为空 / memory content must not be empty')
  if (!CATEGORIES.includes(category)) throw new Error(`未知分类 unknown category: ${category}`)
  if (!SCOPES.includes(scope)) throw new Error(`未知作用域 unknown scope: ${scope}`)
  if (scope === 'workspace' && !cwd) {
    throw new Error('workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
  }
  const normalized = normalizeContent(text)
  const existing = listScope(root, scope, cwd).find(
    (e) => normalizeContent(e.content) === normalized,
  )
  if (existing) return { entry: existing, deduplicated: true }
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
  }
  ensureMeta(root)
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
  if (scope === 'workspace') touchWorkspaceIndex(root, cwd)
  return { entry, deduplicated: false }
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

/** 新覆旧：原地更新内容/分类/标签并刷新 updated 时间。 */
export function updateEntry(root, id, patch = {}, cwd) {
  const entry = findEntry(root, id, cwd)
  if (!entry) throw new Error(`未找到记忆 / memory not found: ${id}`)
  applyPatch(entry, patch)
  entry.updated = new Date().toISOString()
  atomicWrite(entryFile(root, entry, cwd), serializeEntry(entry))
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

function countOccurrences(haystack, needle) {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
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
 * 关键词检索：查询分词后要求全部命中（AND），匹配内容/标签/分类/id，
 * 大小写不敏感。非空查询按相关度排序（同分按更新时间倒序）；
 * 空查询＝按更新时间倒序列出。offset/limit 用于分页。
 */
export function searchEntries(root, { query = '', scope = 'all', category, cwd, limit = 20, offset = 0 } = {}) {
  let entries = scope === 'all' ? listAll(root, cwd) : listScope(root, scope, cwd)
  if (category) entries = entries.filter((e) => e.category === category)
  const trimmed = String(query).trim().toLowerCase()
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length > 0) {
    entries = entries.filter((e) => {
      const haystack = `${e.content}\n${e.tags.join(' ')}\n${e.category}\n${e.id}`.toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
    const phraseCompact = tokens.join('')
    const phraseJoined = tokens.join(' ')
    entries = entries
      .map((e) => ({ e, score: relevance(e, tokens, phraseCompact, phraseJoined) }))
      .sort((a, b) => b.score - a.score || byUpdatedDesc(a.e, b.e))
      .map(({ e }) => e)
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  return entries.slice(start, start + max)
}
