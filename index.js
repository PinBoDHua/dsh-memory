/**
 * dsh-memory — DSH 跨会话长期记忆插件 Host entry.
 *
 * 机制（均为已验证的 DSH API）：
 * - lib/service.js 是记忆操作的唯一公共边界：agent 工具与 Web 面板的
 *   HTTP 路由都调用它（一个操作，两个调用方）。
 * - ctx.tools.register(...)：4 个记忆工具（纯对象定义＋原始 JSON Schema）。
 * - ctx.systemPrompt.section(...)：每次装配实时重读记忆文件，把全局＋
 *   当前工作区记忆在预算内注入系统提示；interpolate: false 保护用户内容。
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

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  const root = dataRoot()
  const service = createMemoryService({ root })
  const controlToken = randomBytes(24).toString('hex')

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

  const saveTool = {
    name: 'memory_save',
    description: '把一条值得长期记住的事实写入跨会话记忆（一事一条）。用户偏好→scope=global，项目事实/决策→scope=workspace。密码/密钥/token 会被拒绝。Save one durable fact to cross-session memory (one fact per entry); credentials are rejected.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容，一条独立事实 The fact to remember, self-contained' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '分类：preference=用户偏好 fact=事实 decision=决策（默认 fact）' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'global=用户级，跨项目共享；workspace=仅当前工作区（默认 workspace）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选检索关键词 Optional search keywords' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          scope: { type: 'string' },
          category: { type: 'string' },
          deduplicated: { type: 'boolean' },
        },
        required: ['id', 'scope', 'category', 'deduplicated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deduplicated
          ? `已有相同记忆，未重复写入：${value.id} (duplicate; existing memory kept)`
          : `已记录记忆 ${value.id} [${value.category}/${value.scope}] (memory saved)`,
      }],
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const session = sessionOf(exec)
      const { entry, deduplicated } = service.save({
        content: args.content,
        category: args.category ?? 'fact',
        scope: args.scope ?? 'workspace',
        tags: args.tags ?? [],
        workspace: cwdOf(session),
        source: session?.id,
      })
      return { id: entry.id, scope: entry.scope, category: entry.category, deduplicated }
    },
  }

  const searchTool = {
    name: 'memory_search',
    description: '检索跨会话记忆：关键词大小写不敏感、多词须全部命中；空查询＝按更新时间列出。Search cross-session memory (case-insensitive, all terms must match; empty query lists recent memories).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分词；留空列出全部 Keywords; empty lists all' },
        scope: { type: 'string', enum: ['global', 'workspace', 'all'], description: '检索范围（默认 all=全局+当前工作区）' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '按分类过滤 Optional category filter' },
        limit: { type: 'integer', description: '最多返回条数（默认 20）Max results (default 20)' },
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
          },
          required: ['id', 'scope', 'category', 'content'],
        },
      },
      render: (_args, entries) => [{
        type: 'text',
        text: entries.length === 0
          ? '没有匹配的记忆 (no matching memories)'
          : entries.map((e) => `- [${e.category}/${e.scope}] ${e.content} (id: ${e.id}, updated: ${e.updated})`).join('\n'),
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
      })
      return entries.map((e) => ({ id: e.id, scope: e.scope, category: e.category, content: e.content, tags: e.tags, updated: e.updated }))
    },
  }

  const updateTool = {
    name: 'memory_update',
    description: '按 id 更新一条记忆（新覆旧）：信息变化时原地更新，而不是新增重复条目；可选 scope 在 global 与当前工作区之间移动。Update a memory by id (newer supersedes older) instead of adding a duplicate; optional scope moves it between global and the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（来自注入内容或 memory_search）Memory id' },
        content: { type: 'string', description: '新内容（可选）New content' },
        category: { type: 'string', enum: ['preference', 'fact', 'decision'], description: '新分类（可选）New category' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表，整体替换（可选）Replacement tags' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '可选：移动到新作用域（workspace 以当前会话工作目录为目标）；目标已有相同内容会被拒绝 Optional: move to a new scope; identical content in the target is rejected' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, updated: { type: 'string' }, scope: { type: 'string' } },
        required: ['id', 'updated', 'scope'],
      },
      render: (_args, value) => [{ type: 'text', text: `已更新记忆 ${value.id} [${value.scope}]（新覆旧）(memory updated)` }],
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const entry = service.update({
        id: args.id,
        content: args.content,
        category: args.category,
        tags: args.tags,
        scope: args.scope,
        workspace: cwdOf(sessionOf(exec)),
      })
      return { id: entry.id, updated: entry.updated, scope: entry.scope }
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

  // 每次装配实时重读：手工编辑记忆文件立即生效；任何读取失败都只降级为
  // 纯指引文本，绝不让系统提示装配失败。
  const sectionText = (assembly) => {
    try {
      const cwd = cwdOf(assembly?.agent?.session)
      const entries = service.list({ scope: 'all', workspace: cwd })
      return renderSection(entries, {
        autoInject: config.autoInject,
        budgetChars: config.injectionBudgetChars,
      })
    } catch {
      return GUIDANCE
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
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch { /* 卸载期容错 tolerate teardown races */ }
      }
    }
  })

  // Web 管理面板的数据面：webServer 可选挂载，缺失时工具与注入仍可用。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => attachRoutes({ webCtx, service, token: controlToken, version }))
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-memory: 无法挂载 Web 面板接口（没有 webServer 服务）', error)
  }
}
