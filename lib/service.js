/**
 * 缝 1：MemoryService —— 记忆操作的唯一公共边界。
 * agent 工具与 Web 面板的 HTTP 路由都调用这里（一个操作，两个调用方）。
 * 错误带 code：secret / invalid / no-workspace / not-found / duplicate。
 */
import fs from 'node:fs'
import path from 'node:path'
import { detectSecret } from './guard.js'
import { withLock } from './lock.js'
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

function storageUsage(root) {
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
  return { entries, bytes }
}

function backupInfo(root, eff) {
  const dir = path.join(root, 'backups')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch { /* 无备份目录 no backups dir */ }
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
  const api = {
    status() {
      return {
        root,
        schemaVersion: store.readMeta(root)?.schemaVersion ?? store.SCHEMA_VERSION,
        counts: {
          global: store.listScope(root, 'global', undefined).length,
          workspaces: this.workspaces().length,
        },
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
      const entries = store.searchEntries(root, {
        query, scope, category, cwd: workspace, origin, tag, status, limit, offset,
        includeSuperseded, includeExpired, includeArchived, decayEnabled: eff.decayEnabled,
      })
      try { store.touchAccess(root, entries, workspace) } catch { /* best-effort */ }
      const full = store.filterEntries(root, {
        query, scope, category, cwd: workspace, origin, tag,
        includeSuperseded: true, includeExpired: true, includeArchived: true, decayEnabled: eff.decayEnabled,
      })
      const hidden = { superseded: 0, expired: 0, archived: 0, total: 0 }
      for (const e of full) {
        if (store.isSuperseded(e) && !includeSuperseded) { hidden.superseded += 1; hidden.total += 1 }
        else if (e.archived && !includeArchived) { hidden.archived += 1; hidden.total += 1 }
        else if (store.isExpired(e) && !includeExpired) { hidden.expired += 1; hidden.total += 1 }
      }
      return { entries, hidden }
    },
    /** 当前过滤条件下的全量统计（不分页）：总数、分类分布、作用域分布、状态分布。 */
    stats({ query = '', scope = 'all', workspace, includeSuperseded = false, includeExpired = false, includeArchived = false } = {}) {
      assertSearchScope(scope)
      const entries = store.filterEntries(root, { query, scope, cwd: workspace, includeSuperseded, includeExpired, includeArchived })
      const byCategory = { preference: 0, fact: 0, decision: 0 }
      const byScope = { global: 0, workspace: 0 }
      for (const e of entries) {
        byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
        byScope[e.scope] = (byScope[e.scope] ?? 0) + 1
      }
      // 状态分布按完整匹配集（含隐藏态）计，供 UI 状态筛选计数。
      const full = store.filterEntries(root, { query, scope, cwd: workspace, includeSuperseded: true, includeExpired: true, includeArchived: true })
      const byStatus = { active: 0, superseded: 0, expired: 0, archived: 0, pinned: 0 }
      for (const e of full) {
        byStatus[store.entryStatus(e)] += 1
        if (e.pinned) byStatus.pinned += 1
      }
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
      if (scope === 'global' || scope === 'all') {
        entries = store.listScope(root, 'global', undefined).map((e) => ({ ...e, workspace: null }))
      }
      if (scope === 'all') {
        for (const ws of this.workspaces()) {
          // 目录才是权威：索引里的 cwd 仅供显示/排查，陈旧或损坏时按 cwd 读取会
          // 漏条目/重复；始终按目录 key 读取，workspace 字段仍带索引 cwd（可能为 null）。
          const list = store.listWorkspaceKey(root, ws.key)
          for (const e of list) entries.push({ ...e, workspace: ws.cwd ?? null })
        }
      } else if (scope === 'workspace') {
        entries = store.listScope(root, 'workspace', workspace).map((e) => ({ ...e, workspace }))
      }
      return { format: 'dsh-memory-export', version: 1, exportedAt: new Date().toISOString(), entries }
    },
    /**
     * 导入记忆条目：逐条校验（机密硬拒），同作用域同内容去重（含批内），
     * id 空闲则保留、被占用则新分配；保留原时间戳与 v2 可选字段。dryRun 只返回计划不落盘。
     * mode='merge' 时 id 命中同作用域既有条目则原地更新（保留 created），计入 updated；
     * 默认 mode='skip' 完全向后兼容。返回 imported（新增）/updated（合并更新）/deduplicated/rejected。
     */
    import({ entries, dryRun = false, mode = 'skip' } = {}) {
      if (!Array.isArray(entries)) throw coded('invalid', 'entries 必须是数组 / entries must be an array')
      if (mode !== 'skip' && mode !== 'merge') throw coded('invalid', `未知导入模式 unknown import mode: ${mode}`)
      const planned = []
      const deduplicated = []
      const rejected = []
      const usedIds = new Set()
      // 每个作用域只全量读一次，建 normalizeContent → id 映射；批内新增/合并同步更新。
      // 取代逐条 listScope().find() 的 O(N×M) 读放大（解析层还有 mtime 缓存兜底）。
      const dedupeMaps = new Map()
      const dedupeMapFor = (scope, workspace) => {
        const key = `${scope}\u0000${scope === 'workspace' ? store.workspaceKey(workspace) : ''}`
        let map = dedupeMaps.get(key)
        if (!map) {
          map = new Map()
          for (const e of store.listScope(root, scope, workspace)) map.set(store.normalizeContent(e.content), e.id)
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
          if (scope === 'workspace' && !workspace) {
            throw coded('no-workspace', 'workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
          }
          rejectSecret(content, raw.tags)
          let id = store.isValidId(raw.id) ? String(raw.id) : ''
          const sameScopeExisting = id !== '' && store.hasEntry(root, id, scope, workspace)
          const takenElsewhere = id !== '' && occupiedIds.has(id) && !sameScopeExisting
          // merge 模式：id 命中「同作用域且未在别处占用」的既有条目 → 原地更新（保留 created）。
          if (mode === 'merge' && id && !usedIds.has(id) && !takenElsewhere && sameScopeExisting) {
            const existing = store.findEntry(root, id, workspace)
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
            planned.push({ entry, workspace })
            // 合并会替换内容：同步映射，避免后续同内容行被误判为重复。
            const map = dedupeMapFor(scope, workspace)
            const previous = existing && typeof existing.content === 'string' ? store.normalizeContent(existing.content) : ''
            if (previous !== '' && map.get(previous) === id) map.delete(previous)
            map.set(store.normalizeContent(content), id)
            continue
          }
          const dedupeMap = dedupeMapFor(scope, workspace)
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
          planned.push({ entry, workspace })
        } catch (err) {
          rejected.push({ index: i, code: err.code ?? 'invalid', reason: err.message })
        }
      }
      if (!dryRun) {
        // 批写互斥：并发导入不互相穿插；单条 save 仍是原子写，不受此锁约束。
        withLock(path.join(root, '.lock-import'), () => {
          for (const { entry, workspace } of planned) store.writeEntry(root, entry, workspace)
        })
      }
      return {
        dryRun: Boolean(dryRun),
        imported: planned.length - updated,
        updated,
        deduplicated: deduplicated.length,
        rejected,
        entries: planned.map((p) => p.entry),
      }
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
    /** 立即备份：导出全量到 backups/，按保留份数裁剪最旧。 */
    backup() {
      const eff = settings.effectiveSettings(baseConfig, root)
      const dir = path.join(root, 'backups')
      fs.mkdirSync(dir, { recursive: true })
      const doc = this.export()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = `dsh-memory-${stamp}.json`
      store.atomicWrite(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`)
      let files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
      while (files.length > eff.backupRetention) {
        const old = files.shift()
        try { fs.rmSync(path.join(dir, old), { force: true }) } catch { /* ignore */ }
      }
      return { file: name, count: files.length, lastBackup: new Date().toISOString() }
    },
    /** 自动备份：开启且距上次备份超过 24h（或无备份）时执行；否则返回 null。 */
    maybeAutoBackup() {
      const eff = settings.effectiveSettings(baseConfig, root)
      if (!eff.autoBackup) return null
      const info = backupInfo(root, eff)
      if (info.lastBackup !== null && Date.now() - Date.parse(info.lastBackup) < BACKUP_INTERVAL_MS) return null
      return this.backup()
    },
  }
  // schema 迁移：旧 v1 数据先强制备份（即使 autoBackup 关）再升级 meta 锚点；
  // 新字段懒缺省，不逐文件改写，旧记忆零丢失。fresh 存储无 meta，跳过。
  try {
    const meta = store.readMeta(root)
    if (meta && meta.schemaVersion < store.SCHEMA_VERSION) {
      api.backup()
      store.migrateSchema(root)
    }
  } catch { /* best-effort：迁移失败不阻断记忆读写 */ }
  return api
}
