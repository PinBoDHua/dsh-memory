/**
 * 缝 1：MemoryService —— 记忆操作的唯一公共边界。
 * agent 工具与 Web 面板的 HTTP 路由都调用这里（一个操作，两个调用方）。
 * 错误带 code：secret / invalid / no-workspace / not-found。
 */
import fs from 'node:fs'
import path from 'node:path'
import { detectSecret } from './guard.js'
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

export function createMemoryService({ root }) {
  return {
    status() {
      return {
        root,
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
    update({ id, content, category, tags, workspace } = {}) {
      if (!store.findEntry(root, id, workspace)) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      if (content !== undefined) rejectSecret(content)
      return store.updateEntry(root, id, { content, category, tags }, workspace)
    },
    forget({ id, workspace } = {}) {
      if (!store.forgetEntry(root, id, workspace)) {
        throw coded('not-found', `未找到记忆 / memory not found: ${id}`)
      }
      return { id, deleted: true }
    },
    search({ query = '', scope = 'all', category, workspace, limit = 20 } = {}) {
      return store.searchEntries(root, { query, scope, category, cwd: workspace, limit })
    },
    workspaces() {
      const base = path.join(root, 'workspaces')
      let keys = []
      try {
        keys = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
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
  }
}
