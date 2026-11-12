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

export const CATEGORIES = Object.freeze(['preference', 'fact', 'decision'])
export const SCOPES = Object.freeze(['global', 'workspace'])
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

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

function newId() {
  return `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function cleanTags(tags) {
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

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 哈希 → cwd 对照表，仅供人工排查；失败不影响记忆写入。 */
function touchWorkspaceIndex(root, cwd) {
  try {
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
  } catch { /* best-effort */ }
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
  const normalized = text.replace(/\s+/g, ' ').toLowerCase()
  const existing = listScope(root, scope, cwd).find(
    (e) => e.content.replace(/\s+/g, ' ').toLowerCase() === normalized,
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
  if (patch.content !== undefined) {
    const text = String(patch.content).trim()
    if (text === '') throw new Error('记忆内容不能为空 / memory content must not be empty')
    entry.content = text
  }
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category)) throw new Error(`未知分类 unknown category: ${patch.category}`)
    entry.category = patch.category
  }
  if (patch.tags !== undefined) entry.tags = cleanTags(patch.tags)
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

/**
 * 关键词检索：查询分词后要求全部命中（AND），匹配内容/标签/分类/id，
 * 大小写不敏感。空查询＝按更新时间倒序列出。
 */
export function searchEntries(root, { query = '', scope = 'all', category, cwd, limit = 20 } = {}) {
  let entries = scope === 'all' ? listAll(root, cwd) : listScope(root, scope, cwd)
  if (category) entries = entries.filter((e) => e.category === category)
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length > 0) {
    entries = entries.filter((e) => {
      const haystack = `${e.content}\n${e.tags.join(' ')}\n${e.category}\n${e.id}`.toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
  return entries.slice(0, max)
}
