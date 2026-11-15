/**
 * dsh-memory — DSH 跨会话长期记忆插件 Host entry.
 *
 * 机制（均为已验证的 DSH API）：
 * - lib/service.js 是记忆操作的唯一公共边界：agent 工具与 Web 面板的
 *   HTTP 路由都调用它（一个操作，两个调用方）。
 * - ctx.tools.register(...)：4 个记忆工具（纯对象定义＋原始 JSON Schema）。
 * - ctx.systemPrompt.section(...)：每次装配实时重读记忆文件，把全局＋
 *   当前工作区记忆在预算内注入系统提示；interpolate: false 保护用户内容。
 * - ctx.systemPrompt.context(...)：自动提取动态提示（特性检测，缺失则跳过）。
 * - ctx.webServer 命名路由 /plugins/dsh-memory/*：Web 管理面板的数据面，
 *   进程级 token + 回环检查（与 dsh-time-machine 同一模式）。
 * - 数据：~/.dsh/.dsh-memory/ 下 Markdown + frontmatter，一事一文件。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包：本地链接目录的 ESM 解析够不到
 * DSH 安装树（与 dsh-time-machine / dsh-reverse-proxy-connect 同一做法）。
 *
 * 隐私：密码/密钥/token 服务层硬拒写；其他敏感信息由指引要求先问用户。
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUIDANCE, renderSection, selectInjection } from './lib/render.js'
import { attachRoutes } from './lib/routes.js'
import { createMemoryService } from './lib/service.js'
import { detectSignals } from './lib/signals.js'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))

export const name = 'dsh-memory'
export const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
export const inject = ['tools', 'systemPrompt']

/** 配置字段与默认值（无 schemastery 依赖；经插件行 config 调整）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  autoInject: true,
  injectionBudgetChars: 8000,
})

function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const budget = Number(c.injectionBudgetChars)
  return {
    enabled: c.enabled !== false,
    autoInject: c.autoInject !== false,
    injectionBudgetChars: Number.isFinite(budget) && budget >= 0 ? budget : CONFIG_DEFAULTS.injectionBudgetChars,
  }
}

function dataRoot() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, '.dsh-memory')
}

/**
 * 消息正文提取（纯函数，可单测）：兼容字符串与 ContentBlock[]（只取文本块）。
 * 工具结果/注入上下文的非文本块不参与信号检测。
 */
export function extractMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 会话可见消息 → 信号检测输入（纯函数，可单测）。
 * 只保留 user/assistant/tool 的角色与正文；`directUser` 依据 user/message 的
 * `source.kind === 'user'` 判定——runtime-context / schedule / goal / skill 注入
 * 都不算直接用户（核心不变量：记忆正文、召回内容与工具输出不得冒充用户授权）。
 */
export function buildSignalMessages(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role
    const text = extractMessageText(message)
    if (role === 'user') out.push({ role, text, directUser: message?.source?.kind === 'user' })
    else if (role === 'assistant') out.push({ role, text })
    else if (role === 'tool') out.push({ role, text, isError: message?.isError === true })
  }
  return out
}

/** 检索输出条目：稀疏字段仅在存在时附加，避免 undefined 被 JSON.stringify 丢弃而破坏工具输出的 lossless JSON 校验。 */
export function searchResultEntry(e) {
  const item = { id: e.id, scope: e.scope, category: e.category, content: e.content, tags: e.tags ?? [], updated: e.updated }
  if (e.origin !== undefined) item.origin = e.origin
  if (e.pinned !== undefined) item.pinned = e.pinned
  if (e.expires !== undefined) item.expires = e.expires
  if (e.archived !== undefined) item.archived = e.archived
  if (e.superseded_by !== undefined) item.superseded_by = e.superseded_by
  return item
}

/** memory_save 工具返回值（纯函数）：旧 v1/手写条目可能没有 origin，统一兜底
 * manual——否则 undefined 会成为自有属性，宿主 lossless JSON 校验会拒绝整个
 * 工具输出（写盘已生效却报失败）。v3 起附带 status=active（R1 生效）。 */
export function saveResultValue(entry, deduplicated, similar, revived, applied) {
  const value = { status: 'active', id: entry.id, scope: entry.scope, category: entry.category, origin: entry.origin ?? 'manual', deduplicated: Boolean(deduplicated), similar: similar ?? [] }
  if (revived) value.revived = true
  if (applied) value.applied = true
  return value
}

/** memory_save 待确认返回值（R2）：候选只进 pending，用户面板批准前不注入、不生效。 */
export function savePendingResultValue(result) {
  return {
    status: 'pending',
    pendingId: result.pendingId,
    scope: result.scope ?? 'workspace',
    category: result.category ?? 'fact',
    origin: result.origin ?? 'auto',
    risk: result.risk ?? 'R2',
    reason: result.reason ?? '',
  }
}

/** memory_update 工具返回值（纯函数）：origin 兜底同 save（lossless JSON）。 */
export function updateResultValue(entry) {
  return { id: entry.id, updated: entry.updated ?? '', scope: entry.scope, origin: entry.origin ?? 'manual' }
}

/**
 * 工具错误脱敏（第十轮审计 H1）：宿主会把 execute 抛出的 error.message 原样渲染给
 * 模型（toolErrorResult），而锁/IO 原始错误可能含数据根绝对路径与用户名。工具面
 * 统一把已知基础设施错误收敛为固定双语文案（HTTP 面 routes.js 有同一映射）。
 * 未知错误原样抛出，交由宿主按内部错误处理。
 */
export function sanitizeToolError(err) {
  const code = err?.code
  if (code === 'busy') {
    return Object.assign(new Error('另一个进程正在写入记忆，请稍后重试 / another process is writing; retry shortly'), { code: 'busy' })
  }
  if (code === 'io') {
    return Object.assign(new Error('记忆写入失败，未做任何变更 / memory write failed; no changes were made'), { code: 'io' })
  }
  return err
}

/** 工具 execute 外层统一脱敏（不改变工具其余行为与并发声明）。 */
export function withSanitizedToolErrors(tool) {
  return {
    ...tool,
    execute(args, exec) {
      try {
        return tool.execute(args, exec)
      } catch (err) {
        throw sanitizeToolError(err)
      }
    },
  }
}

/** memory_save 输出渲染（纯函数，可单测）。 */
export function renderSaveResult(value) {
  if (value?.status === 'pending') {
    const reason = value.reason ? `（原因：${value.reason}）` : ''
    return [{ type: 'text', text: `已记录为待确认候选${reason}：${value.pendingId}。候选不会注入、也不生效，需用户在面板「学习」分区批准 (pending review; approved from the panel before it takes effect)` }]
  }
  let base
  if (value.revived) base = `已有相同记忆，已从归档/过期状态恢复为活跃：${value.id} (duplicate; revived to active)`
  else if (value.deduplicated && value.applied) base = `已有相同记忆，已应用显式字段更新（不重复写入）：${value.id} (duplicate; explicit fields applied)`
  else if (value.deduplicated) base = `已有相同记忆，未重复写入：${value.id} (duplicate; existing memory kept)`
  else base = `已记录记忆 ${value.id} [${value.category}/${value.scope}/${value.origin}] (memory saved)`
  const similar = value.similar ?? []
  if (similar.length === 0) return [{ type: 'text', text: base }]
  const list = similar.map((s) => `${s.id}「${s.content.length > 40 ? `${s.content.slice(0, 40)}…` : s.content}」(${s.score})`).join('；')
  return [{ type: 'text', text: `${base}\n检测到 ${similar.length} 条相似记忆：${list}。若为信息更新，请取代（supersedes）或更新旧条目，避免并存矛盾 (similar memories detected; prefer supersede/update over duplicating)` }]
}

/** memory_search 输出渲染（纯函数，可单测）。 */
export function renderSearchResult(value) {
  const entries = value.entries ?? []
  const hidden = value.hidden ?? { total: 0 }
  const list = entries.length === 0
    ? (hidden.total > 0 ? '没有可见的匹配记忆 (no visible matches)' : '没有匹配的记忆 (no matching memories)')
    : entries.map((e) => {
      const marks = [e.pinned ? 'pinned' : '', e.archived ? 'archived' : '', e.superseded_by ? `superseded→${e.superseded_by}` : '', e.expires ? `expires ${e.expires}` : ''].filter(Boolean).join(', ')
      return `- [${e.category}/${e.scope}${marks ? `; ${marks}` : ''}] ${e.content} (id: ${e.id}, updated: ${e.updated})`
    }).join('\n')
  const note = hidden.total > 0
    ? `\n另有 ${hidden.total} 条匹配被隐藏（被取代 ${hidden.superseded} / 已过期 ${hidden.expired} / 已归档 ${hidden.archived}），可用 include_superseded/include_expired/include_archived 找回 (${hidden.total} hidden matches; use include_* to recover)`
    : ''
  return [{ type: 'text', text: list + note }]
}

/** memory_update 输出渲染（纯函数，可单测）。 */
export function renderUpdateResult(value) {
  return [{ type: 'text', text: `已更新记忆 ${value.id} [${value.scope}]（新覆旧）(memory updated)` }]
}

/** memory_forget 输出渲染（纯函数，可单测）。 */
export function renderForgetResult(value) {
  return [{ type: 'text', text: `已忘记记忆 ${value.id} (memory forgotten)` }]
}

/**
 * 会话有效目录解析（纯函数）：workingDirectory 服务是权威（会跟随 cd），
 * 缺失/异常时回退到不可变的 session.header.cwd。调用方每次实时传入服务引用——
 * apply 时一次性捕获可能早于该服务就绪，会让 cd 后的工作区口径永久停留在旧目录。
 */
export function resolveSessionCwd(workingDirectory, session) {
  if (!session) return undefined
  try {
    const effective = workingDirectory?.get?.(session)
    if (typeof effective === 'string' && effective !== '') return effective
  } catch { /* 回退 header fall back to the immutable header */ }
  const original = session.header?.cwd
  return typeof original === 'string' && original !== '' ? original : undefined
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  const root = dataRoot()
  const service = createMemoryService({ root, baseConfig: config })
  const controlToken = randomBytes(24).toString('hex')

  // 版本号每次 apply 实时读取 package.json：宿主 ESM 模块可能被缓存，模块级
  // version 常量会滞后于实际安装版本；状态路由据此始终报告当前真实版本。
  let liveVersion = version
  try {
    const fresh = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version
    if (typeof fresh === 'string' && fresh !== '') liveVersion = fresh
  } catch { /* 读取失败时保留模块级 version fall back to module-level version */ }

  // workingDirectory 服务是会话有效目录的权威来源（会跟随 cd）；每次实时查询，
  // 不缓存 apply 时的引用（服务可能晚于插件就绪；ctx.get 为 Map 查表，开销可忽略）。
  const cwdOf = (session) => {
    let workingDirectory
    try {
      workingDirectory = ctx.get('workingDirectory')
    } catch {
      workingDirectory = undefined
    }
    return resolveSessionCwd(workingDirectory, session)
  }
  const sessionOf = (exec) => exec?.agent?.session

  // 学习信号：从会话可见消息实时派生（deriveMessages 是同步缓存投影；只有
  // source.kind==='user' 算直接用户输入，runtime-context/定时提醒/技能内容都不算）。
  // 检测本身是纯函数（lib/signals.js），装配期提醒与工具期闸门使用同一套判定。
  const signalMessagesOf = (session) => {
    try {
      return buildSignalMessages(typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [])
    } catch {
      return []
    }
  }
  const memoriesOf = (cwd) => {
    try {
      return service.list({ scope: 'all', workspace: cwd }).map((entry) => ({ id: entry.id, content: entry.content }))
    } catch {
      return []
    }
  }
  const detectedSignalsOf = (session) => {
    const sid = session?.id
    if (!sid) return []
    const messages = signalMessagesOf(session)
    if (messages.length === 0) return []
    try {
      return detectSignals({ sessionId: sid, messages, memories: memoriesOf(cwdOf(session)) })
    } catch {
      return []
    }
  }

  const saveTool = {
    name: 'memory_save',
    description: '把一条值得长期记住的事实写入跨会话记忆（一事一条）。用户偏好→scope=global，项目事实/决策→scope=workspace。origin 必填：manual=用户显式要求，auto=你主动沉淀（便于用户审阅撤销）。写入必须携带本会话提醒中给出的 signal_id：自动沉淀一律 origin=auto，用户显式「记住」用 origin=manual；没有 signal_id 或信号已消费会被工具拒绝。风险分级（R1 直接生效 / R2 进待确认 / R3 拒绝）与每会话额度由工具边界强制。写入时若检测到相似记忆会一并提示；密码/密钥/token 会被拒绝。Save one durable fact to cross-session memory; origin is required and a live session signal_id is mandatory; risk levels (auto / pending / refused) and per-session quota are enforced at the tool boundary.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容，一条独立事实 The fact to remember, self-contained' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '分类：preference=用户偏好 fact=事实 decision=决策（默认 fact）' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'global=用户级，跨项目共享；workspace=仅当前工作区（默认 workspace）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选检索关键词 Optional search keywords' },
        origin: { type: 'string', enum: ['manual', 'auto'], description: '来源（必填）：manual=用户显式要求（须绑定用户显式「记住」信号）；auto=你主动沉淀（须绑定检测到的学习信号）Origin (required): manual=user explicitly asked; auto=agent-initiated from a detected learning signal' },
        signal_id: { type: 'string', description: '必填：本会话学习提醒里给出的信号 id（形如 correction:abc123）。工具边界校验其有效性、未消费与额度 Signal id from the learning reminder; required and enforced' },
        supersedes: { type: 'string', description: '可选：要取代的旧记忆 id（仅 memory_update 修正流支持；信号驱动写入不接受此字段）Optional supersede target' },
        expires: { type: 'string', description: '可选过期日 YYYY-MM-DD（信号驱动写入不接受）Optional expiry date' },
        pinned: { type: 'boolean', description: '可选：钉选常驻（信号驱动写入不接受）Optional pin for always-inject' },
      },
      required: ['content', 'origin'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'pending'] },
          id: { type: 'string' },
          pendingId: { type: 'string' },
          scope: { type: 'string' },
          category: { type: 'string' },
          origin: { type: 'string' },
          risk: { type: 'string' },
          reason: { type: 'string' },
          deduplicated: { type: 'boolean' },
          revived: { type: 'boolean' },
          applied: { type: 'boolean' },
          similar: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, content: { type: 'string' }, score: { type: 'number' } },
              required: ['id'],
            },
          },
        },
        required: ['status', 'scope', 'category'],
      },
      render: (_args, value) => renderSaveResult(value),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const session = sessionOf(exec)
      const result = service.save({
        content: args.content,
        category: args.category ?? 'fact',
        scope: args.scope ?? 'workspace',
        tags: args.tags ?? [],
        origin: args.origin,
        supersedes: args.supersedes,
        expires: args.expires,
        pinned: args.pinned,
        explicitFields: Object.keys(args),
        workspace: cwdOf(session),
        source: session?.id,
        learning: {
          sessionId: session?.id,
          signalId: args.signal_id,
          detectedSignals: detectedSignalsOf(session),
        },
      })
      if (result.status === 'pending') return savePendingResultValue(result)
      return saveResultValue(result.entry, result.deduplicated, result.similar, result.revived, result.applied)
    },
  }

  const searchTool = {
    name: 'memory_search',
    description: '检索跨会话记忆：关键词大小写不敏感、多词须全部命中（中文支持模糊），非空查询按相关度×新近度排序；空查询＝按更新时间列出；可按 scope/category/origin/tag 过滤。默认隐藏被取代/已过期/已归档条目，可用 include_* 找回。返回 {entries, hidden}：hidden 统计被隐藏的匹配数（提示可用 include_* 找回的历史）；offset 分页。Search cross-session memory; filter by scope/category/origin/tag; returns {entries, hidden} with hidden-match counts; hidden (superseded/expired/archived) entries excluded by default; offset paginates.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分词；留空列出全部 Keywords; empty lists all' },
        scope: { type: 'string', enum: ['global', 'workspace', 'all'], description: '检索范围（默认 all=全局+当前工作区）' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '按分类过滤 Optional category filter' },
        origin: { type: 'string', enum: ['manual', 'auto'], description: '按来源过滤（manual=显式要求 / auto=主动沉淀）Filter by origin' },
        tag: { type: 'string', description: '按标签精确过滤（大小写不敏感）Filter by exact tag (case-insensitive)' },
        limit: { type: 'integer', maximum: 200, description: '最多返回条数（默认 20，上限 200）Max results (default 20, capped at 200)' },
        offset: { type: 'integer', description: '分页偏移，跳过前 N 条（默认 0）Pagination offset (default 0)' },
        include_superseded: { type: 'boolean', description: '包含被取代的历史条目（默认 false）Include superseded history' },
        include_expired: { type: 'boolean', description: '包含已过期条目（默认 false）Include expired' },
        include_archived: { type: 'boolean', description: '包含已归档条目（默认 false）Include archived' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                category: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                updated: { type: 'string' },
                origin: { type: 'string' },
                pinned: { type: 'boolean' },
                expires: { type: 'string' },
                archived: { type: 'boolean' },
                superseded_by: { type: 'string' },
              },
              required: ['id', 'scope', 'category', 'content'],
            },
          },
          hidden: {
            type: 'object',
            properties: {
              superseded: { type: 'integer' },
              expired: { type: 'integer' },
              archived: { type: 'integer' },
              total: { type: 'integer' },
            },
            required: ['total'],
          },
        },
        required: ['entries', 'hidden'],
      },
      render: (_args, value) => renderSearchResult(value),
    },
    // 检索会写命中簿记（last_access/hit_count），属写副作用：遵守宿主并发契约，
    // 声明为非并发安全，避免只读语义的并行执行互相踩写。
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { entries, hidden } = service.searchDetailed({
        query: args.query ?? '',
        scope: args.scope ?? 'all',
        category: args.category,
        origin: args.origin,
        tag: args.tag,
        workspace: cwdOf(sessionOf(exec)),
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        includeSuperseded: args.include_superseded ?? false,
        includeExpired: args.include_expired ?? false,
        includeArchived: args.include_archived ?? false,
      })
      return {
        entries: entries.map(searchResultEntry),
        hidden,
      }
    },
  }

  const updateTool = {
    name: 'memory_update',
    description: '按 id 更新一条记忆（新覆旧）：信息变化时原地更新，而不是新增重复条目；可选 scope 在 global 与当前工作区之间移动；可 supersedes 取代另一条（目标必须未被其他条目取代且不会形成取代环，否则拒绝）、archived 归档/恢复、expires 设过期日（空串清除）、pinned 钉选、origin 修正来源标记。Update a memory by id; optional supersede/archive/expire/pin/origin.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（来自注入内容或 memory_search）Memory id' },
        content: { type: 'string', description: '新内容（可选）New content' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '新分类（可选）New category' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表，整体替换（可选）Replacement tags' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '可选：移动到新作用域（workspace 以当前会话工作目录为目标）；目标已有相同内容会被拒绝 Optional: move to a new scope' },
        supersedes: { type: 'string', description: '可选：本条取代的另一条记忆 id；传空串撤销取代（恢复旧条目的可见性）Optional id this entry supersedes; empty string clears the chain' },
        superseded_by: { type: 'string', description: '可选：仅传空串清除本条自己的悬垂取代标记（修复误隐藏）Optional: empty string clears this entry dangling superseded_by flag' },
        expires: { type: 'string', description: '可选过期日 YYYY-MM-DD；空串清除 Optional expiry; empty string clears' },
        pinned: { type: 'boolean', description: '可选：钉选/取消钉选 Optional pin/unpin' },
        archived: { type: 'boolean', description: '可选：true 归档（默认隐藏）/false 恢复 Optional archive/restore' },
        origin: { type: 'string', enum: ['manual', 'auto'], description: '可选：修正来源标记 manual=用户显式要求 / auto=主动沉淀 Optional: correct the origin mark' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, updated: { type: 'string' }, scope: { type: 'string' }, origin: { type: 'string' } },
        required: ['id', 'updated', 'scope'],
      },
      render: (_args, value) => renderUpdateResult(value),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const session = sessionOf(exec)
      const entry = service.update({
        id: args.id,
        content: args.content,
        category: args.category,
        tags: args.tags,
        scope: args.scope,
        supersedes: args.supersedes,
        superseded_by: args.superseded_by,
        expires: args.expires,
        pinned: args.pinned,
        archived: args.archived,
        origin: args.origin,
        workspace: cwdOf(session),
      })
      return updateResultValue(entry)
    },
  }

  const forgetTool = {
    name: 'memory_forget',
    description: '按 id 永久删除一条记忆。仅在用户要求忘记或确认清理时使用。Permanently delete a memory by id; use when the user asks to forget.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆 id Memory id to delete' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, deleted: { type: 'boolean' } },
        required: ['id', 'deleted'],
      },
      render: (_args, value) => renderForgetResult(value),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      return service.forget({ id: args.id, workspace: cwdOf(sessionOf(exec)) })
    },
  }

  // 每次装配实时重读：手工编辑记忆文件与 settings.json 立即生效；任何读取
  // 失败都只降级为纯指引文本，绝不让系统提示装配失败。
  const sectionText = (assembly) => {
    try {
      const cwd = cwdOf(assembly?.agent?.session)
      const entries = service.list({ scope: 'all', workspace: cwd })
      const recall = service.recallConfig()
      // 注入命中入账：记录实际被注入系统提示的条目（access.json 账本节流 ≤1 次/小时/条目）。
      // 同一次 selectInjection 结果复用到 renderSection，避免装配路径重复排序/预算计算。
      let selection
      if (recall.autoInject) {
        try {
          selection = selectInjection(entries, { budgetChars: recall.injectionBudgetChars, decayEnabled: recall.decayEnabled })
          service.recordHits(selection.selected)
        } catch { /* best-effort：簿记失败不影响装配 */ }
      }
      return renderSection(entries, {
        autoInject: recall.autoInject,
        budgetChars: recall.injectionBudgetChars,
        decayEnabled: recall.decayEnabled,
        selection,
      })
    } catch {
      return GUIDANCE
    }
  }

  // 学习提醒（context provider，每次装配/准入重读）：只在「本会话检测到尚未提醒过的
  // 直接用户信号」时出现一行；同一信号只提醒一次（持久化在 learning/state.json）。
  // 宿主按上下文快照去重落盘（仅变化时写入模型历史），零额外模型调用。
  const learningProvider = (assembly) => {
    try {
      const session = assembly?.agent?.session
      const sid = session?.id
      if (!sid) return ''
      const recall = service.recallConfig()
      if (!recall.autoExtractHint) return ''
      const messages = signalMessagesOf(session)
      if (messages.length === 0) return ''
      const signals = detectSignals({ sessionId: sid, messages, memories: memoriesOf(cwdOf(session)) })
      if (signals.length === 0) return ''
      return service.learningReminder({ sessionId: sid, signals, limit: recall.autoLearn.maxWritesPerSession })
    } catch {
      return ''
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.systemPrompt.section({ name: 'dsh-memory', order: 9500, interpolate: false, text: sectionText }),
      ctx.tools.register(withSanitizedToolErrors(saveTool)),
      ctx.tools.register(withSanitizedToolErrors(searchTool)),
      ctx.tools.register(withSanitizedToolErrors(updateTool)),
      ctx.tools.register(withSanitizedToolErrors(forgetTool)),
    ]
    if (typeof ctx.systemPrompt?.context === 'function') {
      try {
        disposers.push(ctx.systemPrompt.context({ name: 'dsh-memory-learning', order: 9600, interpolate: false, text: learningProvider }))
      } catch { /* 特性缺失或注册失败：静默跳过，GUIDANCE 仍生效 */ }
    }
    // 自动备份：启动 5 秒后首检，此后每小时检查一次（开启且超 24h 才落盘）。
    const startupTimer = setTimeout(() => {
      try { service.maybeAutoBackup() } catch { /* best-effort */ }
    }, 5000)
    const backupTimer = setInterval(() => {
      try { service.maybeAutoBackup() } catch { /* best-effort */ }
    }, 3600 * 1000)
    return () => {
      clearTimeout(startupTimer)
      clearInterval(backupTimer)
      // 关闭 store 的 fs.watch/索引定时器（第七轮审计 H11），重载不泄漏 watcher。
      try { service.dispose() } catch { /* 卸载期容错 */ }
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch { /* 卸载期容错 tolerate teardown races */ }
      }
    }
  })

  // Web 管理面板的数据面：webServer 可选挂载，缺失时工具与注入仍可用。
  // resolveCwd：按 sessionId 返回会话有效目录（workingDirectory 权威，跟随 cd），
  // 供面板「当前工作区」与工具口径对齐；服务缺失时回退 undefined（面板用初始目录）。
  const resolveCwd = (sessionId) => {
    if (!sessionId) return undefined
    try {
      const sessions = ctx.get('sessions')
      return cwdOf(sessions?.get?.(sessionId))
    } catch {
      return undefined
    }
  }
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => attachRoutes({ webCtx, service, token: controlToken, version: liveVersion, resolveCwd }))
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-memory: 无法挂载 Web 面板接口（没有 webServer 服务）', error)
  }
}
