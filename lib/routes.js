/**
 * 缝 3：HTTP 契约 —— /plugins/dsh-memory/* 命名路由。
 * 与 dsh-time-machine / dsh-reverse-proxy-connect 同一模式：
 * ctx.webServer 注册 + 浏览器同源 fetch；回环检查；写操作校验进程级 token。
 * createHandlers 返回纯 (req,res) 处理器，可在传输边界桩上单测；
 * attachRoutes 负责真实 webServer 挂载（live 验证）。
 */
import { timingSafeEqual } from 'node:crypto'

export const API_BASE = '/plugins/dsh-memory'
export const CONTROL_HEADER = 'x-rpc-key'

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK_ADDRS.has(addr)) return false
  const host = String(req.headers?.host ?? '')
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
}

function writeJson(res, status, doc) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(doc))
}

const STATUS_BY_CODE = Object.freeze({
  'not-found': 404,
  secret: 400,
  invalid: 400,
  'no-workspace': 400,
  duplicate: 409,
})

const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { code: 'body-too-large' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createHandlers({ service, token, version, resolveCwd }) {
  const tokenOk = (req) => {
    const provided = Buffer.from(String(req.headers?.[CONTROL_HEADER] ?? ''))
    const expected = Buffer.from(String(token))
    return provided.length > 0 && provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  const writeHandler = (method, run) => async (req, res) => {
    if (!isLoopback(req)) return writeJson(res, 403, { error: 'loopback-only' })
    if (req.method !== method) return writeJson(res, 405, { error: 'method-not-allowed' })
    if (!tokenOk(req)) return writeJson(res, 403, { error: 'unauthorized' })
    let input
    try {
      input = await readJsonBody(req)
    } catch (err) {
      if (err?.code === 'body-too-large') return writeJson(res, 413, { error: 'body-too-large' })
      return writeJson(res, 400, { error: 'invalid-json' })
    }
    try {
      writeJson(res, 200, { result: run(input) })
    } catch (err) {
      const status = STATUS_BY_CODE[err?.code] ?? 500
      writeJson(res, status, { error: err?.message ?? String(err), code: err?.code ?? 'internal' })
    }
  }

  const readHandler = (run) => async (req, res) => {
    if (!isLoopback(req)) return writeJson(res, 403, { error: 'loopback-only' })
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method-not-allowed' })
    try {
      writeJson(res, 200, run(new URL(req.url, 'http://localhost').searchParams))
    } catch (err) {
      const status = STATUS_BY_CODE[err?.code] ?? 500
      writeJson(res, status, { error: err?.message ?? String(err), code: err?.code ?? 'internal' })
    }
  }

  const settingsGet = readHandler(() => service.settings())
  const settingsPost = writeHandler('POST', (input) => service.updateSettings(input))

  return {
    async status(req, res) {
      if (!isLoopback(req)) return writeJson(res, 403, { error: 'loopback-only' })
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'method-not-allowed' })
      const status = service.status()
      writeJson(res, 200, { ok: true, version, key: token, root: status.root, schemaVersion: status.schemaVersion, counts: status.counts })
    },
    entries: readHandler((params) => {
      const limit = Number(params.get('limit'))
      const offset = Number(params.get('offset'))
      const flag = (name) => params.get(name) === 'true' || params.get(name) === '1'
      return {
        entries: service.search({
          query: params.get('query') ?? '',
          scope: params.get('scope') ?? 'all',
          category: params.get('category') || undefined,
          workspace: params.get('workspace') || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
          offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
          includeSuperseded: flag('include_superseded'),
          includeExpired: flag('include_expired'),
          includeArchived: flag('include_archived'),
        }),
      }
    }),
    workspaces: readHandler(() => ({ workspaces: service.workspaces() })),
    cwd: readHandler((params) => {
      const sessionId = params.get('sessionId') || ''
      let cwd = null
      try { cwd = typeof resolveCwd === 'function' ? (resolveCwd(sessionId) ?? null) : null } catch { cwd = null }
      return { cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null }
    }),
    stats: readHandler((params) => ({
      stats: service.stats({
        query: params.get('query') ?? '',
        scope: params.get('scope') ?? 'all',
        workspace: params.get('workspace') || undefined,
      }),
    })),
    similar: readHandler((params) => ({
      pairs: service.similarPairs({
        scope: params.get('scope') ?? 'all',
        workspace: params.get('workspace') || undefined,
      }),
    })),
    'recall-preview': readHandler((params) => service.recallPreview({ workspace: params.get('workspace') || undefined })),
    export: readHandler(() => service.export()),
    settings: (req, res) => (req.method === 'GET' ? settingsGet(req, res) : settingsPost(req, res)),
    'settings/reset': writeHandler('POST', () => service.resetSettings()),
    backup: writeHandler('POST', () => service.backup()),
    save: writeHandler('POST', (input) => service.save(input)),
    update: writeHandler('POST', (input) => service.update(input)),
    forget: writeHandler('POST', (input) => service.forget(input)),
    import: writeHandler('POST', (input) => service.import(input)),
  }
}

/** 真实 webServer 挂载：exact 路由注册，返回合并 disposer。 */
export function attachRoutes({ webCtx, service, token, version, resolveCwd }) {
  const handlers = createHandlers({ service, token, version, resolveCwd })
  const names = ['status', 'entries', 'workspaces', 'cwd', 'stats', 'similar', 'recall-preview', 'export', 'settings', 'settings/reset', 'backup', 'save', 'update', 'forget', 'import']
  const disposers = names.map((name) => webCtx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/${name}`,
    handler: handlers[name],
  }))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch { /* 卸载期容错 tolerate teardown races */ }
    }
  }
}
