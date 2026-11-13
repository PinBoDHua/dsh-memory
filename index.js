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
import { GUIDANCE, renderSection } from './lib/render.js'
import { attachRoutes } from './lib/routes.js'
import { createMemoryService } from './lib/service.js'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))

export const name = 'dsh-memory'
export const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
export const inject = ['tools', 'systemPrompt']

/** 配置字段与默认值（无 schemastery 依赖；经插件行 config 调整）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  autoInject: true,
  injectionBudgetChars: 6000,
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

/** 自动提取提示阈值：距上次记忆写入的装配评估次数（活动代理量）。 */
const HINT_THRESHOLD = 3
const HINT_TEXT = '本会话已有一段时间未写入记忆。若出现了值得长期保留的新稳定偏好/项目事实/决策（且非代码可推导、非短期任务指令），请用 memory_save 沉淀（origin 必填：主动沉淀=auto）；信息变化可用 supersedes 取代旧条目。若无则忽略此提示。'

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

  // workingDirectory 服务是会话有效目录的权威来源（会跟随 cd）；
  // 可选查找，缺失时回退到不可变的 session.header.cwd。
  let workingDirectory
  try {
    workingDirectory = ctx.get('workingDirectory')
  } catch {
    workingDirectory = undefined
  }
  const cwdOf = (session) => {
    if (!session) return undefined
    try {
      const effective = workingDirectory?.get?.(session)
      if (typeof effective === 'string' && effective !== '') return effective
    } catch { /* 回退 header fall back to the immutable header */ }
    const original = session.header?.cwd
    return typeof original === 'string' && original !== '' ? original : undefined
  }
  const sessionOf = (exec) => exec?.agent?.session

  // 自动提取提示的每会话簿记：evals=装配评估累计，lastWriteEval=上次记忆写入时的 evals。
  const hintState = new Map()
  const noteWrite = (session) => {
    const sid = session?.id
    if (!sid) return
    const st = hintState.get(sid) ?? { evals: 0, lastWriteEval: 0 }
    st.lastWriteEval = st.evals
    hintState.set(sid, st)
  }

  const saveTool = {
    name: 'memory_save',
    description: '把一条值得长期记住的事实写入跨会话记忆（一事一条）。用户偏好→scope=global，项目事实/决策→scope=workspace。origin 必填：manual=用户显式要求，auto=你主动沉淀（便于用户审阅撤销）；信息变化可 supersedes=旧id 取代（保留历史）。写入时若检测到相似记忆会一并提示，便于取代/更新旧条目、避免并存矛盾。密码/密钥/token 会被拒绝。Save one durable fact to cross-session memory; origin is required (manual=user-requested, auto=agent-initiated); similar memories are reported on save (prefer supersede/update); credentials are rejected.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容，一条独立事实 The fact to remember, self-contained' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '分类：preference=用户偏好 fact=事实 decision=决策（默认 fact）' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'global=用户级，跨项目共享；workspace=仅当前工作区（默认 workspace）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选检索关键词 Optional search keywords' },
        origin: { type: 'string', enum: ['manual', 'auto'], description: '来源（必填）：manual=用户显式要求；auto=你主动沉淀（便于用户审阅撤销）Origin (required): manual=user explicitly requested; auto=agent-initiated for review' },
        supersedes: { type: 'string', description: '可选：要取代的旧记忆 id；旧记忆标记被取代、默认隐藏，历史保留 Optional id of the memory this supersedes' },
        expires: { type: 'string', description: '可选过期日 YYYY-MM-DD（UTC、当日含；到期隐藏不删除、可恢复）Optional expiry date' },
        pinned: { type: 'boolean', description: '可选：钉选常驻（预算内优先注入、免衰减）Optional pin for always-inject' },
      },
      required: ['content', 'origin'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          scope: { type: 'string' },
          category: { type: 'string' },
          origin: { type: 'string' },
          deduplicated: { type: 'boolean' },
          similar: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, content: { type: 'string' }, score: { type: 'number' } },
              required: ['id'],
            },
          },
        },
        required: ['id', 'scope', 'category', 'deduplicated'],
      },
      render: (_args, value) => {
        const base = value.deduplicated
          ? `已有相同记忆，未重复写入：${value.id} (duplicate; existing memory kept)`
          : `已记录记忆 ${value.id} [${value.category}/${value.scope}/${value.origin}] (memory saved)`
        const similar = value.similar ?? []
        if (similar.length === 0) return [{ type: 'text', text: base }]
        const list = similar.map((s) => `${s.id}「${s.content.length > 40 ? `${s.content.slice(0, 40)}…` : s.content}」(${s.score})`).join('；')
        return [{ type: 'text', text: `${base}\n检测到 ${similar.length} 条相似记忆：${list}。若为信息更新，请取代（supersedes）或更新旧条目，避免并存矛盾 (similar memories detected; prefer supersede/update over duplicating)` }]
      },
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const session = sessionOf(exec)
      const { entry, deduplicated, similar } = service.save({
        content: args.content,
        category: args.category ?? 'fact',
        scope: args.scope ?? 'workspace',
        tags: args.tags ?? [],
        origin: args.origin,
        supersedes: args.supersedes,
        expires: args.expires,
        pinned: args.pinned,
        workspace: cwdOf(session),
        source: session?.id,
      })
      if (!deduplicated) noteWrite(session)
      return { id: entry.id, scope: entry.scope, category: entry.category, origin: entry.origin, deduplicated, similar: similar ?? [] }
    },
  }

  const searchTool = {
    name: 'memory_search',
    description: '检索跨会话记忆：关键词大小写不敏感、多词须全部命中（中文支持模糊），非空查询按相关度×新近度排序；空查询＝按更新时间列出。默认隐藏被取代/已过期/已归档条目，可用 include_* 找回。Search cross-session memory; hidden (superseded/expired/archived) entries excluded by default.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分词；留空列出全部 Keywords; empty lists all' },
        scope: { type: 'string', enum: ['global', 'workspace', 'all'], description: '检索范围（默认 all=全局+当前工作区）' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '按分类过滤 Optional category filter' },
        limit: { type: 'integer', description: '最多返回条数（默认 20）Max results (default 20)' },
        include_superseded: { type: 'boolean', description: '包含被取代的历史条目（默认 false）Include superseded history' },
        include_expired: { type: 'boolean', description: '包含已过期条目（默认 false）Include expired' },
        include_archived: { type: 'boolean', description: '包含已归档条目（默认 false）Include archived' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
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
      render: (_args, entries) => [{
        type: 'text',
        text: entries.length === 0
          ? '没有匹配的记忆 (no matching memories)'
          : entries.map((e) => {
            const marks = [e.pinned ? 'pinned' : '', e.archived ? 'archived' : '', e.superseded_by ? `superseded→${e.superseded_by}` : '', e.expires ? `expires ${e.expires}` : ''].filter(Boolean).join(', ')
            return `- [${e.category}/${e.scope}${marks ? `; ${marks}` : ''}] ${e.content} (id: ${e.id}, updated: ${e.updated})`
          }).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const entries = service.search({
        query: args.query ?? '',
        scope: args.scope ?? 'all',
        category: args.category,
        workspace: cwdOf(sessionOf(exec)),
        limit: args.limit ?? 20,
        includeSuperseded: args.include_superseded ?? false,
        includeExpired: args.include_expired ?? false,
        includeArchived: args.include_archived ?? false,
      })
      return entries.map((e) => ({
        id: e.id, scope: e.scope, category: e.category, content: e.content, tags: e.tags, updated: e.updated,
        origin: e.origin, pinned: e.pinned, expires: e.expires, archived: e.archived, superseded_by: e.superseded_by,
      }))
    },
  }

  const updateTool = {
    name: 'memory_update',
    description: '按 id 更新一条记忆（新覆旧）：信息变化时原地更新，而不是新增重复条目；可选 scope 在 global 与当前工作区之间移动；可 supersedes 取代另一条、archived 归档/恢复、expires 设过期日（空串清除）、pinned 钉选、origin 修正来源标记。Update a memory by id; optional supersede/archive/expire/pin/origin.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（来自注入内容或 memory_search）Memory id' },
        content: { type: 'string', description: '新内容（可选）New content' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '新分类（可选）New category' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表，整体替换（可选）Replacement tags' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '可选：移动到新作用域（workspace 以当前会话工作目录为目标）；目标已有相同内容会被拒绝 Optional: move to a new scope' },
        supersedes: { type: 'string', description: '可选：本条取代的另一条记忆 id Optional id this entry supersedes' },
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
      render: (_args, value) => [{ type: 'text', text: `已更新记忆 ${value.id} [${value.scope}]（新覆旧）(memory updated)` }],
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
        expires: args.expires,
        pinned: args.pinned,
        archived: args.archived,
        origin: args.origin,
        workspace: cwdOf(session),
      })
      noteWrite(session)
      return { id: entry.id, updated: entry.updated, scope: entry.scope, origin: entry.origin }
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
      render: (_args, value) => [{ type: 'text', text: `已忘记记忆 ${value.id} (memory forgotten)` }],
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
      return renderSection(entries, {
        autoInject: recall.autoInject,
        budgetChars: recall.injectionBudgetChars,
        decayEnabled: recall.decayEnabled,
      })
    } catch {
      return GUIDANCE
    }
  }

  // 自动提取动态提示：context provider 每次装配/准入重读，按会话累计活动量，
  // 距上次记忆写入达阈值则给出静态提示（写入后清零）。特性检测：宿主无此 API
  // 则静默跳过（GUIDANCE 仍生效）。零额外模型调用。
  const hintProvider = (assembly) => {
    try {
      const sid = assembly?.agent?.session?.id
      if (!sid) return ''
      if (!service.recallConfig().autoExtractHint) return ''
      const st = hintState.get(sid) ?? { evals: 0, lastWriteEval: 0 }
      st.evals += 1
      hintState.set(sid, st)
      if (hintState.size > 500) {
        const oldest = hintState.keys().next().value
        hintState.delete(oldest)
      }
      return st.evals - st.lastWriteEval >= HINT_THRESHOLD ? HINT_TEXT : ''
    } catch {
      return ''
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.systemPrompt.section({ name: 'dsh-memory', order: 9500, interpolate: false, text: sectionText }),
      ctx.tools.register(saveTool),
      ctx.tools.register(searchTool),
      ctx.tools.register(updateTool),
      ctx.tools.register(forgetTool),
    ]
    if (typeof ctx.systemPrompt?.context === 'function') {
      try {
        disposers.push(ctx.systemPrompt.context({ name: 'dsh-memory-extract', order: 9600, interpolate: false, text: hintProvider }))
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
      hintState.clear()
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
