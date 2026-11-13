/**
 * 缝 1：MemoryService —— 记忆操作的唯一公共边界。
 * agent 工具与 Web 面板的 HTTP 路由都调用这里（一个操作，两个调用方）。
 * 错误带 code：secret / invalid / no-workspace / not-found / duplicate。
 */
import fs from 'node:fs'
import path from 'node:path'
import { detectSecret } from './guard.js'
import { withLock, touchLock } from './lock.js'
import { selectInjection } from './render.js'
import * as settings from './settings.js'
import * as store from './store.js'

function coded(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 机密检查覆盖正文与标签：标签同样会落盘并被检索，此前只查正文可绕过硬拒。 */
function rejectSecret(content, tags) {
  const texts = [String(content ?? '')]
  if (Array.isArray(tags) && tags.length > 0) texts.push(tags.map((t) => String(t)).join(' '))
  for (const text of texts) {
    const hit = detectSecret(text)
    if (hit) {
      throw coded('secret', `拒绝写入：检测到疑似机密（${hit.label}）。密码/密钥/token 永不进入记忆，标签也不例外。Write rejected: suspected credential (${hit.label}). Credentials are never stored in memory, including tags.`)
    }
  }
}

/** 检索类接口的合法作用域（all=全局＋当前工作区）。非法值应回 400 而非 500。 */
const SEARCH_SCOPES = Object.freeze(['all', ...store.SCOPES])
function assertSearchScope(scope) {
  if (!SEARCH_SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
}

// 存储占用只用于设置页元信息展示：5 秒缓存，避免每次设置保存响应对大库全树 stat。
const storageUsageCache = new Map()

// 单次导入条数上限：32MB body 可装数万条，同步规划+落盘会冻结宿主数秒到数十秒；
// 客户端已按 ≤300/片提交，直连/整档预演也必须受同一契约约束。
const MAX_IMPORT_ENTRIES = 1000
// importId 幂等回执 LRU：merge 重试不得回滚用户在失败窗口内写入的新内容。
const IMPORT_RECEIPT_LIMIT = 200

function storageUsage(root) {
  const cached = storageUsageCache.get(root)
  if (cached && Date.now() - cached.at < 5000) return cached.value
  let entries = 0
  let bytes = 0
  const walk = (dir) => {
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of names) {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) walk(p)
      else if (d.name.endsWith('.md')) {
        entries += 1
        try { bytes += fs.statSync(p).size } catch { /* 忽略不可读 ignore unreadable */ }
      }
    }
  }
  walk(path.join(root, 'global'))
  walk(path.join(root, 'workspaces'))
  const value = { entries, bytes }
  storageUsageCache.set(root, { at: Date.now(), value })
  return value
}

/** meta 状态：损坏的 meta.json 不能回落成「健康 v2」掩盖问题（缺失=未初始化仍按当前版本）。 */
function metaInfo(root) {
  const meta = store.readMeta(root)
  if (meta) return { schemaVersion: meta.schemaVersion, metaError: null }
  try {
    fs.accessSync(path.join(root, 'meta.json'))
    return { schemaVersion: null, metaError: 'meta.json 损坏 / corrupt' }
  } catch {
    return { schemaVersion: store.SCHEMA_VERSION, metaError: null }
  }
}

// 备份文件名模式：只认插件自己写的时间戳备份（dsh-memory-<ISO>.json，同毫秒去重名
// 允许 -1/-2 后缀）。旧实现把 backups/ 下任意 *.json 都当自己的：用户手放的导出
// 可能被轮转删除，外来的未来 mtime 文件会让 lastBackup 永久为「刚备份过」。
const BACKUP_FILE_PATTERN = /^dsh-memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{1,3})?\.json$/

function listBackupFiles(dir) {
  try {
    const files = fs.readdirSync(dir).filter((n) => BACKUP_FILE_PATTERN.test(n))
    return files
      .map((name) => {
        try { return { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs } } catch { return { name, mtime: 0 } }
      })
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
      .map((x) => x.name)
  } catch {
    return []
  }
}

function backupInfo(root, eff) {
  const dir = path.join(root, 'backups')
  const files = listBackupFiles(dir)
  let last = null
  for (const n of files) {
    try {
      const m = fs.statSync(path.join(dir, n)).mtimeMs
      if (last === null || m > last) last = m
    } catch { /* ignore */ }
  }
  return {
    enabled: eff.autoBackup,
    retention: eff.backupRetention,
    count: files.length,
    lastBackup: last === null ? null : new Date(last).toISOString(),
  }
}

const BACKUP_INTERVAL_MS = 24 * 3600 * 1000

/** 从导入 raw 条目保留 v2 可选字段（稀疏，仅在显式提供时附加）。 */
function carryOptionalFields(entry, raw) {
  if (store.ORIGINS.includes(raw.origin)) entry.origin = raw.origin
  if (raw.supersedes && store.isValidId(raw.supersedes)) entry.supersedes = String(raw.supersedes)
  if (raw.superseded_by && store.isValidId(raw.superseded_by)) entry.superseded_by = String(raw.superseded_by)
  if (raw.superseded_at) entry.superseded_at = String(raw.superseded_at)
  if (raw.expires !== undefined && raw.expires !== null && raw.expires !== '') {
    // 与 save/update 同一校验：非法日期拒绝整条导入（per-entry catch 归入 rejected），
    // 避免把坏日期写盘后条目被永久隐藏。
    entry.expires = store.normalizeExpires(raw.expires)
  }
  if (raw.pinned) entry.pinned = true
  if (raw.archived) entry.archived = true
  if (raw.last_access) entry.last_access = String(raw.last_access)
  const hits = Number(raw.hit_count)
  if (Number.isFinite(hits) && hits > 0) entry.hit_count = Math.floor(hits)
  return entry
}

export function createMemoryService({ root, baseConfig = {} }) {
  // 运行期可观测状态（status 暴露）：迁移备份失败、自动备份失败等不再被静默吞掉。
  const runtime = { migrationPending: false, migrationError: null, backupError: null }
  const importReceipts = new Map()
  const receiptKey = (importId, chunkIndex) => `${importId}\u0000${chunkIndex}`
  const rememberImportReceipt = (importId, chunkIndex, summary) => {
    if (!importId) return
    const key = receiptKey(importId, chunkIndex)
    importReceipts.delete(key)
    importReceipts.set(key, summary)
    while (importReceipts.size > IMPORT_RECEIPT_LIMIT) {
      const oldest = importReceipts.keys().next().value
      if (oldest === undefined) break
      importReceipts.delete(oldest)
    }
  }
  const api = {
    status() {
      const meta = metaInfo(root)
      const counts = store.countEntries(root)
      return {
        root,
        schemaVersion: meta.schemaVersion,
        metaError: meta.metaError,
        counts: { global: counts.global, workspaces: counts.workspaceDirs },
        migrationPending: runtime.migrationPending,
        migrationError: runtime.migrationError,
        backupError: runtime.backupError,
      }
    },
    save({ workspace, content, category = 'fact', scope = 'workspace', ...rest } = {}) {
      if (String(content ?? '').trim() === '') {
        throw coded('invalid', '记忆内容不能为空 / memory content must not be empty')
      }
      if (!store.CATEGORIES.includes(category)) throw coded('invalid', `未知分类 unknown category: ${category}`)
      if (!store.SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
      if (scope === 'workspace' && !workspace) {
        throw coded('no-workspace', 'workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
      }
      rejectSecret(content, rest.tags)
      return store.saveEntry(root, { content, category, scope, ...rest, cwd: workspace })
    },
    list({ scope = 'all', workspace } = {}) {
      return scope === 'all' ? store.listAll(root, workspace) : store.listScope(root, scope, workspace)
    },
    update({ id, content, category, tags, scope, workspace, origin, supersedes, expires, pinned, archived } = {}) {
      const entry = store.findEntry(root, id, workspace)
      if (!entry) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      if (content !== undefined || tags !== undefined) rejectSecret(content, tags)
      const patch = { content, category, tags, origin, supersedes, expires, pinned, archived }
      if (scope === undefined || scope === entry.scope) {
        return store.updateEntry(root, id, patch, workspace)
      }
      if (!store.SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
      if (scope === 'workspace' && !workspace) {
        throw coded('no-workspace', 'workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
      }
      return store.moveEntry(root, id, scope, workspace, patch)
    },
    forget({ id, workspace } = {}) {
      if (!store.forgetEntry(root, id, workspace)) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      return { id, deleted: true }
    },
    /** 批量删除（面板批量选择）：一次扫描定位/删除、一次全作用域清理取代指针。 */
    forgetMany({ ids } = {}) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw coded('invalid', 'ids 必须是非空数组 / ids must be a non-empty array')
      }
      if (ids.length > 5000) throw coded('invalid', '一次最多删除 5000 条 / at most 5000 ids per call')
      const result = store.forgetEntries(root, ids)
      if (result.deleted.length === 0) {
        throw coded('not-found', '未找到任何要删除的记忆 / no matching memories to delete')
      }
      return { deleted: result.deleted.length, ids: result.deleted, notFound: result.notFound }
    },
    search({ query = '', scope = 'all', category, workspace, origin, tag, status, limit = 20, offset = 0, includeSuperseded = false, includeExpired = false, includeArchived = false } = {}) {
      assertSearchScope(scope)
      const eff = settings.effectiveSettings(baseConfig, root)
      const entries = store.searchEntries(root, {
        query, scope, category, cwd: workspace, origin, tag, status, limit, offset,
        includeSuperseded, includeExpired, includeArchived, decayEnabled: eff.decayEnabled,
      })
      // 命中簿记（节流 ≤1 次/小时）：被检索返回即一次命中。
      try { store.touchAccess(root, entries, workspace) } catch { /* best-effort */ }
      return entries
    },
    /** 检索＋隐藏态匹配计数：entries 为分页可见结果，hidden 统计被默认过滤隐藏的匹配（按首个排除原因归类，不重复计数）。 */
    searchDetailed({ query = '', scope = 'all', category, workspace, origin, tag, status, limit = 20, offset = 0, includeSuperseded = false, includeExpired = false, includeArchived = false } = {}) {
      assertSearchScope(scope)
      const eff = settings.effectiveSettings(baseConfig, root)
      // 单遍收集：可见集与隐藏计数来自同一次目录扫描/过滤（旧实现两遍全量）。
      const collected = store.collectEntries(root, {
        query, scope, category, cwd: workspace, origin, tag, status,
        includeSuperseded, includeExpired, includeArchived, decayEnabled: eff.decayEnabled,
      })
      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
      const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
      const entries = collected.visible.slice(start, start + max)
      try { store.touchAccess(root, entries, workspace) } catch { /* best-effort */ }
      return { entries, hidden: collected.hidden }
    },
    /** 注入命中簿记（系统提示装配时调用）：只更新 access.json 账本，节流 ≤1 次/小时/条目。 */
    recordHits(entries) {
      try { store.touchAccess(root, entries) } catch { /* best-effort：簿记失败不影响装配 */ }
    },
    /** 当前过滤条件下的全量统计（不分页）：总数、分类分布、作用域分布、状态分布。 */
    stats({ query = '', scope = 'all', workspace, category, origin, tag, status, includeSuperseded = false, includeExpired = false, includeArchived = false } = {}) {
      assertSearchScope(scope)
      // 单遍收集：可见统计与 byStatus（含隐藏态）共享同一次全量过滤。
      // status/include_* 与列表同口径透传：切到「全部状态/已归档」时统计头与列表一致。
      const collected = store.collectEntries(root, { query, scope, cwd: workspace, category, origin, tag, status, includeSuperseded, includeExpired, includeArchived })
      const entries = collected.visible
      const byCategory = { preference: 0, fact: 0, decision: 0 }
      const byScope = { global: 0, workspace: 0 }
      for (const e of entries) {
        byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
        byScope[e.scope] = (byScope[e.scope] ?? 0) + 1
      }
      // 状态分布按完整匹配集（含隐藏态）计，供 UI 状态筛选计数。
      const byStatus = collected.byStatus
      return { total: entries.length, byCategory, byScope, byStatus }
    },
    /** 相似记忆查重：同作用域活跃条目两两相似度（面板按需调用）。 */
    similarPairs({ scope = 'all', workspace } = {}) {
      assertSearchScope(scope)
      return store.findSimilarPairs(root, { scope, cwd: workspace })
    },
    /** 导出记忆为带版本的 JSON 文档（备份/迁移）；含隐藏态，完整无损。scope=all 全量（默认，备份用）、global 仅全局、workspace 指定工作区。 */
    export({ scope = 'all', workspace } = {}) {
      if (scope !== 'all' && !store.SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
      if (scope === 'workspace' && !workspace) throw coded('no-workspace', 'workspace 导出需要工作目录 / workspace export requires a working directory')
      let entries = []
      // files 用于发现「目录里有但解析失败」的损坏条目：备份/导出不能静默漏数据。
      let files = 0
      const countFiles = (dir) => {
        try { files += fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length } catch { /* ignore */ }
      }
      if (scope === 'global' || scope === 'all') {
        entries = store.listScope(root, 'global', undefined).map((e) => ({ ...e, workspace: null, workspaceKey: null }))
        countFiles(path.join(root, 'global'))
      }
      if (scope === 'all') {
        if (workspace) {
          // 面板「全局＋当前工作区」视图导出：只含全局与该工作区，与所见一致（不静默
          // 导出其他项目的记忆）；全量备份走不带 workspace 的 export/立即备份。
          const key = store.workspaceKey(workspace)
          for (const e of store.listScope(root, 'workspace', workspace)) {
            entries.push({ ...e, workspace: store.normalizeCwd(workspace), workspaceKey: key })
          }
          countFiles(path.join(root, 'workspaces', key))
        } else {
          for (const ws of this.workspaces()) {
            // 目录才是权威：索引里的 cwd 仅供显示/排查，陈旧或损坏时按 cwd 读取会
            // 漏条目/重复；始终按目录 key 读取，并附上权威 workspaceKey 供导入按 key 恢复
            // （workspace=cwd 仍保留向后兼容，索引损坏时可能为 null）。
            const list = store.listWorkspaceKey(root, ws.key)
            for (const e of list) entries.push({ ...e, workspace: ws.cwd ?? null, workspaceKey: ws.key })
            countFiles(path.join(root, 'workspaces', ws.key))
          }
        }
      } else if (scope === 'workspace') {
        const key = store.workspaceKey(workspace)
        entries = store.listScope(root, 'workspace', workspace).map((e) => ({ ...e, workspace, workspaceKey: key }))
        countFiles(path.join(root, 'workspaces', key))
      }
      // skipped：解析失败被跳过的损坏文件数（导入端不消费，仅用于提示/审计）。
      const skipped = Math.max(0, files - entries.length)
      return { format: 'dsh-memory-export', version: 1, exportedAt: new Date().toISOString(), entries, skipped }
    },
    /**
     * 导入记忆条目：逐条校验（机密硬拒），同作用域同内容去重（含批内），
     * id 空闲则保留、被占用则新分配；保留原时间戳与 v2 可选字段。dryRun 只返回计划不落盘。
     * mode='merge' 时 id 命中同作用域既有条目则原地更新（保留 created），计入 updated；
     * 默认 mode='skip' 完全向后兼容。返回 imported（新增）/updated（合并更新）/deduplicated/rejected。
     */
    import({ entries, dryRun = false, mode = 'skip', importId, chunkIndex = 0 } = {}) {
      if (!Array.isArray(entries)) throw coded('invalid', 'entries 必须是数组 / entries must be an array')
      if (mode !== 'skip' && mode !== 'merge') throw coded('invalid', `未知导入模式 unknown import mode: ${mode}`)
      if (entries.length > MAX_IMPORT_ENTRIES) {
        throw coded('invalid', `单次导入最多 ${MAX_IMPORT_ENTRIES} 条，请分片提交 / at most ${MAX_IMPORT_ENTRIES} entries per import; split into batches`)
      }
      const receiptId = typeof importId === 'string' && importId !== '' && importId.length <= 128 ? importId : ''
      const receiptChunk = Number.isInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex < 100000 ? chunkIndex : 0
      // 幂等回执：同一 importId+chunkIndex 重放直接返回首次结果，不再规划/落盘。
      if (!dryRun && receiptId) {
        const cached = importReceipts.get(receiptKey(receiptId, receiptChunk))
        if (cached) return { ...cached, cached: true }
      }
      const planned = []
      const deduplicated = []
      const rejected = []
      const usedIds = new Set()
      // 每个作用域只全量读一次，建 normalizeContent → id 映射；批内新增/合并同步更新。
      // 取代逐条 listScope().find() 的 O(N×M) 读放大（解析层还有 mtime 缓存兜底）。
      const dedupeMaps = new Map()
      const dedupeMapFor = (scope, workspace, workspaceKey) => {
        const scopeKey = scope === 'workspace' ? (workspaceKey ?? store.workspaceKey(workspace)) : ''
        const key = `${scope}\u0000${scopeKey}`
        let map = dedupeMaps.get(key)
        if (!map) {
          map = new Map()
          // 有权威 key 时按目录 key 读（cwd 未知/索引损坏也能对齐）；否则按 cwd。
          const list = scope === 'workspace' && workspaceKey ? store.listWorkspaceKey(root, workspaceKey) : store.listScope(root, scope, workspace)
          for (const e of list) map.set(store.normalizeContent(e.content), e.id)
          dedupeMaps.set(key, map)
        }
        return map
      }
      // 跨作用域 id 占用表（global＋所有工作区，一次扫描）：导入不得制造跨作用域
      // 同 id——findEntry 全局优先，会让按 id 的更新/删除命中另一作用域的条目。
      const occupiedIds = store.allEntryIds(root)
      let updated = 0
      const now = new Date().toISOString()
      const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
      for (let i = 0; i < entries.length; i++) {
        const raw = entries[i] && typeof entries[i] === 'object' ? entries[i] : {}
        try {
          const content = String(raw.content ?? '').trim()
          if (content === '') throw coded('invalid', '记忆内容不能为空 / memory content must not be empty')
          const category = raw.category ?? 'fact'
          if (!store.CATEGORIES.includes(category)) throw coded('invalid', `未知分类 unknown category: ${category}`)
          const scope = raw.scope ?? 'workspace'
          if (!store.SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
          const workspace = typeof raw.workspace === 'string' && raw.workspace !== '' ? raw.workspace : undefined
          // 权威工作区 key（导出带出）：备份恢复时不依赖索引/cwd；非法/缺失时回退 cwd。
          const rawKey = typeof raw.workspaceKey === 'string' ? raw.workspaceKey : ''
          const workspaceKey = scope === 'workspace' && store.isValidWorkspaceKey(rawKey) ? rawKey : undefined
          if (scope === 'workspace' && !workspace && !workspaceKey) {
            throw coded('no-workspace', 'workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
          }
          const scopeKey = scope === 'workspace' ? (workspaceKey ?? store.workspaceKey(workspace)) : ''
          rejectSecret(content, raw.tags)
          let id = store.isValidId(raw.id) ? String(raw.id) : ''
          const sameScopeExisting = id !== ''
            && (scope === 'workspace' && workspaceKey
              ? store.hasEntryByKey(root, scopeKey, id)
              : store.hasEntry(root, id, scope, workspace))
          const takenElsewhere = id !== '' && occupiedIds.has(id) && !sameScopeExisting
          // merge 模式：id 命中「同作用域且未在别处占用」的既有条目 → 原地更新（保留 created）。
          if (mode === 'merge' && id && !usedIds.has(id) && !takenElsewhere && sameScopeExisting) {
            const mergeMap = dedupeMapFor(scope, workspace, workspaceKey)
            const mergeDup = mergeMap.get(store.normalizeContent(content))
            if (mergeDup !== undefined && mergeDup !== id) {
              // merge 把本条改成与另一条完全相同的内容：不得绕过 save 的同内容去重
              // 不变量（否则同作用域出现双份重复记忆）。
              deduplicated.push({ index: i, id: mergeDup })
              continue
            }
            const existing = scope === 'workspace' && workspaceKey
              ? store.findEntryByKey(root, id, scopeKey)
              : store.findEntry(root, id, workspace)
            const entry = carryOptionalFields({
              id,
              category,
              scope,
              tags: store.cleanTags(raw.tags),
              created: existing && existing.created ? existing.created : (isoLike.test(String(raw.created ?? '')) ? String(raw.created) : now),
              updated: isoLike.test(String(raw.updated ?? '')) ? String(raw.updated) : now,
              source: typeof raw.source === 'string' ? raw.source : '',
              content,
            }, raw)
            usedIds.add(id)
            updated += 1
            planned.push({ entry, workspace, workspaceKey: scope === 'workspace' ? scopeKey : undefined })
            // 合并会替换内容：同步映射，避免后续同内容行被误判为重复。
            const map = dedupeMapFor(scope, workspace, workspaceKey)
            const previous = existing && typeof existing.content === 'string' ? store.normalizeContent(existing.content) : ''
            if (previous !== '' && map.get(previous) === id) map.delete(previous)
            map.set(store.normalizeContent(content), id)
            continue
          }
          const dedupeMap = dedupeMapFor(scope, workspace, workspaceKey)
          const dupId = dedupeMap.get(store.normalizeContent(content))
          if (dupId !== undefined) {
            deduplicated.push({ index: i, id: dupId })
            continue
          }
          if (id === '' || usedIds.has(id) || occupiedIds.has(id)) id = store.newId()
          usedIds.add(id)
          occupiedIds.add(id)
          dedupeMap.set(store.normalizeContent(content), id)
          const entry = carryOptionalFields({
            id,
            category,
            scope,
            tags: store.cleanTags(raw.tags),
            created: isoLike.test(String(raw.created ?? '')) ? String(raw.created) : now,
            updated: isoLike.test(String(raw.updated ?? '')) ? String(raw.updated) : now,
            source: typeof raw.source === 'string' ? raw.source : '',
            content,
          }, raw)
          planned.push({ entry, workspace, workspaceKey: scope === 'workspace' ? scopeKey : undefined })
        } catch (err) {
          rejected.push({ index: i, code: err.code ?? 'invalid', reason: err.message })
        }
      }
      let repaired = 0
      // 取代关系物化（第五轮审计 P1）：目标必须能从条目自身作用域解析；批内/磁盘目标
      // 的链要双向补齐（supersedes ↔ superseded_by），而不是只做「丢弃悬垂指针」。
      const plannedById = new Map(planned.map((p) => [p.entry.id, p]))
      const residentById = new Map()
      const wsRoot = path.join(root, 'workspaces')
      for (const { entry: resident, file } of store.listEverywhere(root)) {
        if (plannedById.has(resident.id)) continue // merge 同 id：以本批新内容为准
        let key = null
        if (resident.scope === 'workspace') {
          const rel = path.relative(wsRoot, file)
          key = rel && !rel.startsWith('..') ? rel.split(path.sep)[0] : null
        }
        residentById.set(resident.id, { entry: resident, scope: resident.scope, workspaceKey: key })
      }
      const scopeAllows = (p, info) => {
        if (p.entry.scope === 'global') return info.scope === 'global'
        return info.scope === 'global' || info.workspaceKey === p.workspaceKey
      }
      const diskUpdates = new Map()
      const markDiskUpdate = (info, patch) => {
        let item = diskUpdates.get(info.entry.id)
        if (!item) {
          item = { entry: { ...info.entry }, workspaceKey: info.scope === 'workspace' ? info.workspaceKey : undefined }
          diskUpdates.set(info.entry.id, item)
        }
        Object.assign(item.entry, patch)
      }
      const dropPointer = (p, key) => {
        delete p.entry[key]
        if (key === 'superseded_by') delete p.entry.superseded_at
        repaired += 1
      }
      for (const p of planned) {
        for (const key of ['supersedes', 'superseded_by']) {
          const target = p.entry[key]
          if (!target) continue
          if (target === p.entry.id) { dropPointer(p, key); continue }
          const plannedTarget = plannedById.get(target)
          const diskTarget = residentById.get(target)
          const info = plannedTarget
            ? { scope: plannedTarget.entry.scope, workspaceKey: plannedTarget.workspaceKey }
            : diskTarget
          if (!info || !scopeAllows(p, info)) { dropPointer(p, key); continue }
          if (key === 'supersedes') {
            // 本条目声称取代 target：target 必须接受（未被别的后继占用）。
            if (plannedTarget) {
              if (plannedTarget.entry.superseded_by && plannedTarget.entry.superseded_by !== p.entry.id) dropPointer(p, key)
              else {
                plannedTarget.entry.superseded_by = p.entry.id
                plannedTarget.entry.superseded_at = p.entry.updated
              }
            } else if (diskTarget.entry.superseded_by && diskTarget.entry.superseded_by !== p.entry.id) {
              dropPointer(p, key)
            } else {
              markDiskUpdate(diskTarget, { superseded_by: p.entry.id, superseded_at: p.entry.updated })
            }
          } else {
            // 本条目标记为 target 取代：target 必须声明（或补上）supersedes=本条目。
            if (plannedTarget) {
              if (plannedTarget.entry.supersedes && plannedTarget.entry.supersedes !== p.entry.id) dropPointer(p, key)
              else plannedTarget.entry.supersedes = p.entry.id
            } else if (diskTarget.entry.supersedes !== p.entry.id) {
              dropPointer(p, key)
            }
          }
        }
      }
      // 环检测（含磁盘目标物化出的反向边）：a.superseded_by=b 且 b.superseded_by=a
      // （或更长环）会让整条链默认隐藏；从「链终止于集合外」的安全节点反向传播，
      // 剩余节点丢弃 superseded_by（磁盘目标则取消物化）。
      const nodeEntries = new Map()
      for (const p of planned) nodeEntries.set(p.entry.id, { entry: p.entry, planned: true })
      for (const [id, item] of diskUpdates) nodeEntries.set(id, { entry: item.entry, planned: false })
      const pendingTarget = new Map()
      for (const [id, node] of nodeEntries) {
        const t = node.entry.superseded_by
        if (t && nodeEntries.has(t)) pendingTarget.set(id, t)
      }
      const safe = new Set()
      const reverse = new Map()
      for (const [id, target] of pendingTarget) {
        if (!reverse.has(target)) reverse.set(target, [])
        reverse.get(target).push(id)
      }
      const queue = []
      for (const id of nodeEntries.keys()) {
        if (!pendingTarget.has(id)) {
          safe.add(id)
          queue.push(id)
        }
      }
      while (queue.length > 0) {
        const id = queue.pop()
        for (const src of reverse.get(id) || []) {
          if (safe.has(src)) continue
          safe.add(src)
          queue.push(src)
        }
      }
      for (const [id, node] of nodeEntries) {
        if (!pendingTarget.has(id) || safe.has(id)) continue
        delete node.entry.superseded_by
        delete node.entry.superseded_at
        if (!node.planned) diskUpdates.delete(id)
        repaired += 1
      }
      if (!dryRun) {
        // 批写互斥 + 全成或零变更：writeEntryBatch 先暂存再统一提交，失败自动回滚，
        // 不会再出现「前 N 条已落盘、第 N+1 条失败」的半套恢复。
        // 大批量导入的临界区可能远超默认 10s staleMs：显式放宽，避免被另一进程判为陈旧抢锁；
        // 获取锁最多等 3s（返回可重试 busy），不让宿主同步冻结 30s。
        try {
          const importLock = path.join(root, '.lock-import')
          const batchItems = planned.map((p) => ({ entry: p.entry, cwd: p.workspace, workspaceKey: p.workspaceKey }))
          // 磁盘既有目标的反向指针（superseded_by/supersedes）随同一原子批次落盘。
          for (const item of diskUpdates.values()) batchItems.push(item)
          withLock(importLock, () => {
            store.writeEntryBatch(root, batchItems, {
              // 大导入临界区可能超过 staleMs：每 128 条刷新锁 mtime，避免被并发进程判陈旧抢占。
              onProgress: () => touchLock(importLock),
            })
          }, { timeoutMs: 3000, staleMs: 120_000 })
        } catch (err) {
          const message = String(err?.message ?? err)
          if (/^lock timeout/.test(message)) {
            throw coded('busy', '另一个进程正在写入记忆，请稍后重试 / another process is writing memories; please retry')
          }
          if (err?.code === 'invalid' || err?.code === 'busy') throw err
          // 结构化 io 错误：不回传本机绝对路径（500 文案会原样进客户端）。
          throw coded('io', '导入写入失败，未做任何变更 / import write failed; no changes were made')
        }
        // 导入可能引入/复用历史 id：顺手清理账本里已无文件的幽灵命中（best-effort）。
        try { this.pruneAccessLedger() } catch { /* ignore */ }
      }
      const result = {
        dryRun: Boolean(dryRun),
        imported: planned.length - updated,
        updated,
        deduplicated: deduplicated.length,
        repaired,
        rejected,
        // 预览需要计划明细；落盘模式客户端只用计数，回传全量 entries 会让大导入
        // 多一次 MB 级序列化与传输（且没有调用方使用）。
        ...(dryRun ? { entries: planned.map((p) => p.entry) } : {}),
      }
      if (!dryRun && receiptId) rememberImportReceipt(receiptId, receiptChunk, result)
      return result
    },
    /** 清理命中账本里已无对应文件的幽灵记录（惰性 GC；启动与导入后 best-effort 调用）。 */
    pruneAccessLedger() {
      return store.pruneAccessLedger(root)
    },
    workspaces() {
      const base = path.join(root, 'workspaces')
      let keys = []
      try {
        keys = fs.readdirSync(base, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^[a-f0-9]{16}$/.test(d.name))
          .map((d) => d.name)
      } catch {
        return []
      }
      let index = {}
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed
      } catch { /* 索引缺失或损坏时仍列出目录 list dirs even without a usable index */ }
      const out = []
      for (const key of keys) {
        let count = 0
        try {
          count = fs.readdirSync(path.join(base, key)).filter((n) => n.endsWith('.md')).length
        } catch { /* 不可读目录计 0 unreadable dir counts 0 */ }
        const meta = index[key] ?? {}
        out.push({
          key,
          cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
          firstSeen: meta.firstSeen ?? null,
          lastSeen: meta.lastSeen ?? null,
          count,
        })
      }
      out.sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || a.key.localeCompare(b.key))
      return out
    },
    /** 轻量召回配置（系统提示装配每次实时读取）：autoInject + 预算 + 衰减开关。 */
    recallConfig() {
      const eff = settings.effectiveSettings(baseConfig, root)
      return { autoInject: eff.autoInject, injectionBudgetChars: eff.injectionBudgetChars, decayEnabled: eff.decayEnabled }
    },
    /** 注入召回预览：当前设置下实际注入的条目、占用字符与未注入数（设置页调预算用）。 */
    recallPreview({ workspace } = {}) {
      const eff = settings.effectiveSettings(baseConfig, root)
      const entries = store.listAll(root, workspace)
      const { selected, omitted, usedChars } = selectInjection(entries, { budgetChars: eff.injectionBudgetChars, decayEnabled: eff.decayEnabled })
      return {
        autoInject: eff.autoInject,
        budgetChars: eff.injectionBudgetChars,
        injected: selected.length,
        omitted,
        usedChars,
        entries: selected.map((e) => ({ id: e.id, category: e.category, scope: e.scope, content: e.content, pinned: !!e.pinned })),
      }
    },
    /** 设置全量视图：默认/基线/覆盖/有效值 + 边界 + 隐私 + 存储与备份元信息。 */
    settings() {
      const eff = settings.effectiveSettings(baseConfig, root)
      return {
        defaults: settings.SETTINGS_DEFAULTS,
        base: settings.sanitizeSettings({ autoInject: baseConfig.autoInject, injectionBudgetChars: baseConfig.injectionBudgetChars }),
        overlay: settings.readOverlay(root),
        effective: eff,
        bounds: {
          budgetMax: settings.BUDGET_MAX,
          pageSizes: settings.PAGE_SIZES,
          views: settings.VIEWS,
          retentionMin: settings.RETENTION_MIN,
          retentionMax: settings.RETENTION_MAX,
        },
        privacy: { alwaysOn: true },
        meta: {
          root,
          schemaVersion: store.readMeta(root)?.schemaVersion ?? store.SCHEMA_VERSION,
          storage: storageUsage(root),
          backup: backupInfo(root, eff),
        },
      }
    },
    updateSettings(patch) {
      settings.writeOverlay(root, patch)
      return this.settings()
    },
    resetSettings() {
      settings.resetOverlay(root)
      return this.settings()
    },
    /** 立即备份：导出全量到 backups/，只按插件自己的时间戳备份文件轮转（不动用户手放文件）。 */
    backup() {
      try {
        const eff = settings.effectiveSettings(baseConfig, root)
        const dir = path.join(root, 'backups')
        fs.mkdirSync(dir, { recursive: true })
        // 与批量导入共用写锁：避免另一进程写到一半时导出「半批」快照。锁忙（≤500ms）
        // 返回可重试 busy，而不是静默保存不完整备份。
        let doc
        try {
          doc = withLock(path.join(root, '.lock-import'), () => this.export(), { timeoutMs: 500, staleMs: 120_000 })
        } catch (err) {
          if (/^lock timeout/.test(String(err?.message ?? err))) {
            throw coded('busy', '另一个进程正在写入记忆，稍后重试备份 / another process is writing; retry backup later')
          }
          throw err
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        // 同毫秒两次备份不得互相覆盖。
        const name = store.uniqueFileName(dir, `dsh-memory-${stamp}.json`)
        store.atomicWrite(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`)
        const files = listBackupFiles(dir)
        while (files.length > eff.backupRetention) {
          const old = files.shift()
          try { fs.rmSync(path.join(dir, old), { force: true }) } catch { /* ignore */ }
        }
        runtime.backupError = null
        return { file: name, count: files.length, lastBackup: new Date().toISOString() }
      } catch (err) {
        // 失败可观测（status.backupError），但仍向上抛给显式调用方（面板立即备份）。
        // busy 是瞬时/可重试状态（另一进程正在导入），不应粘滞成「备份失败」误报。
        if (err?.code !== 'busy') runtime.backupError = `备份失败 / backup failed: ${String(err?.code ?? err?.message ?? err)}`
        throw err
      }
    },
    /** 自动备份：开启且距上次备份超过 24h（或无备份）时执行；不可写时降级返回 null。 */
    maybeAutoBackup() {
      try {
        const eff = settings.effectiveSettings(baseConfig, root)
        if (!eff.autoBackup) return null
        const info = backupInfo(root, eff)
        if (info.lastBackup !== null && Date.now() - Date.parse(info.lastBackup) < BACKUP_INTERVAL_MS) return null
        return this.backup()
      } catch {
        return null
      }
    },
  }
  // schema 迁移：旧 v1 数据先强制备份（即使 autoBackup 关）再升级 meta 锚点；
  // 新字段懒缺省、不逐文件改写，旧记忆零丢失。fresh 存储无 meta，跳过。
  // 失败时保持 v1 并在 status 暴露 pending/error，不再静默吞掉；最近 10 分钟已有
  // 备份则复用（避免每次启动重试都新增备份、轮转掉用户历史恢复点）。
  try {
    const meta = store.readMeta(root)
    if (meta && meta.schemaVersion < store.SCHEMA_VERSION) {
      runtime.migrationPending = true
      const info = backupInfo(root, settings.effectiveSettings(baseConfig, root))
      const recent = info.lastBackup !== null && Date.now() - Date.parse(info.lastBackup) < 10 * 60 * 1000
      if (!recent) api.backup()
      store.migrateSchema(root)
      runtime.migrationPending = false
      runtime.migrationError = null
    }
  } catch (err) {
    runtime.migrationPending = true
    runtime.migrationError = `迁移失败 / migration failed: ${String(err?.code ?? err?.message ?? err)}`
  }
  // 启动时惰性清理命中账本幽灵记录（手工删文件/外部删除后账本只增不减）。
  try { api.pruneAccessLedger() } catch { /* best-effort */ }
  return api
}
