/**
 * 缝 1：MemoryService —— 记忆操作的唯一公共边界。
 * agent 工具与 Web 面板的 HTTP 路由都调用这里（一个操作，两个调用方）。
 * 错误带 code：secret / invalid / no-workspace / not-found / duplicate。
 */
import fs from 'node:fs'
import path from 'node:path'
import { detectSecret } from './guard.js'
import { withLock } from './lock.js'
import * as settings from './settings.js'
import * as store from './store.js'

function coded(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function rejectSecret(content) {
  const hit = detectSecret(content)
  if (hit) {
    throw coded('secret', `拒绝写入：检测到疑似机密（${hit.label}）。密码/密钥/token 永不进入记忆。Write rejected: suspected credential (${hit.label}). Credentials are never stored in memory.`)
  }
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

export function createMemoryService({ root, baseConfig = {} }) {
  return {
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
      rejectSecret(content)
      return store.saveEntry(root, { content, category, scope, ...rest, cwd: workspace })
    },
    list({ scope = 'all', workspace } = {}) {
      return scope === 'all' ? store.listAll(root, workspace) : store.listScope(root, scope, workspace)
    },
    update({ id, content, category, tags, scope, workspace } = {}) {
      const entry = store.findEntry(root, id, workspace)
      if (!entry) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      if (content !== undefined) rejectSecret(content)
      if (scope === undefined || scope === entry.scope) {
        return store.updateEntry(root, id, { content, category, tags }, workspace)
      }
      if (!store.SCOPES.includes(scope)) throw coded('invalid', `未知作用域 unknown scope: ${scope}`)
      if (scope === 'workspace' && !workspace) {
        throw coded('no-workspace', 'workspace 记忆需要会话工作目录 / workspace memory requires a session working directory')
      }
      return store.moveEntry(root, id, scope, workspace, { content, category, tags })
    },
    forget({ id, workspace } = {}) {
      if (!store.forgetEntry(root, id, workspace)) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      return { id, deleted: true }
    },
    search({ query = '', scope = 'all', category, workspace, limit = 20, offset = 0 } = {}) {
      return store.searchEntries(root, { query, scope, category, cwd: workspace, limit, offset })
    },
    /** 当前过滤条件下的全量统计（不分页）：总数、分类分布、作用域分布。 */
    stats({ query = '', scope = 'all', workspace } = {}) {
      const entries = store.filterEntries(root, { query, scope, cwd: workspace })
      const byCategory = { preference: 0, fact: 0, decision: 0 }
      const byScope = { global: 0, workspace: 0 }
      for (const e of entries) {
        byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
        byScope[e.scope] = (byScope[e.scope] ?? 0) + 1
      }
      return { total: entries.length, byCategory, byScope }
    },
    /** 导出全部记忆为带版本的 JSON 文档（备份/迁移）。 */
    export() {
      const entries = store.listScope(root, 'global', undefined).map((e) => ({ ...e, workspace: null }))
      for (const ws of this.workspaces()) {
        const list = ws.cwd ? store.listScope(root, 'workspace', ws.cwd) : store.listWorkspaceKey(root, ws.key)
        for (const e of list) entries.push({ ...e, workspace: ws.cwd ?? null })
      }
      return { format: 'dsh-memory-export', version: 1, exportedAt: new Date().toISOString(), entries }
    },
    /**
     * 导入记忆条目：逐条校验（机密硬拒），同作用域同内容去重（含批内），
     * id 空闲则保留、被占用则新分配；保留原时间戳。dryRun 只返回计划不落盘。
     */
    import({ entries, dryRun = false } = {}) {
      if (!Array.isArray(entries)) throw coded('invalid', 'entries 必须是数组 / entries must be an array')
      const planned = []
      const deduplicated = []
      const rejected = []
      const seen = new Set()
      const usedIds = new Set()
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
          rejectSecret(content)
          const dedupeKey = `${scope}\u0000${scope === 'workspace' ? store.workspaceKey(workspace) : ''}\u0000${store.normalizeContent(content)}`
          if (seen.has(dedupeKey)) {
            deduplicated.push({ index: i })
            continue
          }
          const dup = store.listScope(root, scope, workspace).find((e) => store.normalizeContent(e.content) === store.normalizeContent(content))
          if (dup) {
            deduplicated.push({ index: i, id: dup.id })
            continue
          }
          let id = store.isValidId(raw.id) ? String(raw.id) : ''
          // findEntry 先查 global：workspace 导入不得复用已被 global 占用的 id，
          // 否则后续按 id 更新/删除会命中 global 条目。
          const taken = store.hasEntry(root, id, scope, workspace)
            || (scope === 'workspace' && store.hasEntry(root, id, 'global', undefined))
          if (id === '' || usedIds.has(id) || taken) id = store.newId()
          usedIds.add(id)
          seen.add(dedupeKey)
          planned.push({
            entry: {
              id,
              category,
              scope,
              tags: store.cleanTags(raw.tags),
              created: isoLike.test(String(raw.created ?? '')) ? String(raw.created) : now,
              updated: isoLike.test(String(raw.updated ?? '')) ? String(raw.updated) : now,
              source: typeof raw.source === 'string' ? raw.source : '',
              content,
            },
            workspace,
          })
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
        imported: planned.length,
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
    /** 轻量召回配置（系统提示装配每次实时读取）：autoInject + 预算。 */
    recallConfig() {
      const eff = settings.effectiveSettings(baseConfig, root)
      return { autoInject: eff.autoInject, injectionBudgetChars: eff.injectionBudgetChars }
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
}
