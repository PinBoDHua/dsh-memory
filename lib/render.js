/**
 * dsh-memory 提示渲染 Prompt rendering.
 *
 * GUIDANCE：何时记、记什么、隐私红线、写入纪律与取代流（中文为主，附英文要点）。
 * renderSection：指引 + 预算内的召回记忆。记忆内容按原文注入，
 * 因此注册 section 时必须 interpolate: false（内容可能含 {{…}}）。
 * 注入排序：钉选最先 → 分类优先（偏好→决策→事实）→ 类内衰减乘子倒序
 * （同分按更新时间倒序）；默认排除被取代/已过期/已归档条目。
 */
import { decayMultiplier, isHidden } from './store.js'

export const GUIDANCE = `## 长期记忆 Long-term memory (dsh-memory)

你拥有跨会话长期记忆。下方召回的记忆来自过去的会话，直接适用于当前对话；与用户当前指令冲突时，以当前指令为准。
You have cross-session long-term memory. Recalled memories below apply unless the user's current instructions override them.

何时写入（memory_save，一事一条；origin 必填）：
- 用户明确要求记住某事 → origin=manual。
- 出现稳定的用户偏好/习惯（语言、格式、工具偏好等）→ scope=global。
- 出现项目级事实或重要决策（架构选择、约定、环境事实）→ scope=workspace。
- 你主动沉淀（非用户显式要求）→ origin=auto，便于用户在面板审阅与撤销。
写入纪律：只存蒸馏后的持久事实，不存临时闲聊、可从代码/文档直接推导的内容、短期任务指令、与既有记忆重复的内容；敏感话题（健康、政治、宗教、种族等）默认不存，密码/密钥/token 工具会硬拒绝，其他敏感个人信息写入前必须先征得用户同意。
信息变化：优先 memory_save 新条目并 supersedes=旧id（保留历史、默认读最新），或 memory_update 新覆旧；用户要求忘记用 memory_forget；需要更多细节用 memory_search。
依赖某条记忆前，若能廉价核对当前代码/文件则先核对（just-in-time 验证）；发现过时即用 memory_update 修正或取代，不要沿用过时事实。
自动写入后在回复中简短提及（如"已记录 1 条记忆"），不逐条罗列内容。`

function entryLine(entry) {
  return `- [${entry.category}] ${entry.content.replace(/\s+/g, ' ')} (id: ${entry.id})`
}

/** 注入优先级：偏好（行为指令）→ 决策 → 事实。 */
const CATEGORY_PRIORITY = { preference: 0, decision: 1, fact: 2 }

/** 钉选最先 → 分类优先 → 类内衰减乘子倒序（同分按更新时间倒序）。 */
function injectionOrder(decayEnabled, now) {
  return (a, b) => {
    const pinA = a.pinned ? 0 : 1
    const pinB = b.pinned ? 0 : 1
    if (pinA !== pinB) return pinA - pinB
    const pa = CATEGORY_PRIORITY[a.category] ?? 2
    const pb = CATEGORY_PRIORITY[b.category] ?? 2
    if (pa !== pb) return pa - pb
    if (decayEnabled) {
      const ma = decayMultiplier(a, now, true)
      const mb = decayMultiplier(b, now, true)
      if (ma !== mb) return mb - ma
    }
    return String(b.updated).localeCompare(String(a.updated))
  }
}

/**
 * 预算内召回选择（纯函数）：默认排除隐藏态（被取代/已过期/已归档），按注入
 * 优先级排序后贪心装预算。返回 selected（装入条目，按注入顺序）、omitted
 * （装不下的条数）、usedChars（占用字符，含每条末尾换行）。供渲染与预览共用。
 */
export function selectInjection(entries, { budgetChars = 6000, decayEnabled = true, now = Date.now() } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => !isHidden(e, now))
  const budget = Math.max(0, Number(budgetChars) || 0)
  const selected = []
  let usedChars = 0
  let omitted = 0
  for (const entry of list.slice().sort(injectionOrder(decayEnabled, now))) {
    const line = entryLine(entry)
    if (usedChars + line.length + 1 > budget) {
      omitted += 1
      continue
    }
    usedChars += line.length + 1
    selected.push(entry)
  }
  return { selected, omitted, usedChars }
}

/**
 * 渲染注入文本。默认排除隐藏态（被取代/已过期/已归档）；预算从优先级
 * 最高的条目开始装（钉选→偏好→决策→事实，类内衰减乘子高者优先），
 * 装不下的跳过并计数，提示 agent 用 memory_search 获取。
 * selection 可由调用方预先算好（装配时命中簿记已用过一次 selectInjection，
 * 复用结果避免同样的排序/预算计算做两遍）。
 */
export function renderSection(entries, { autoInject = true, budgetChars = 6000, decayEnabled = true, now = Date.now(), selection } = {}) {
  const parts = [GUIDANCE]
  if (!autoInject) return parts.join('\n')
  const { selected, omitted } = selection ?? selectInjection(entries, { budgetChars, decayEnabled, now })
  if (selected.length === 0 && omitted === 0) {
    parts.push('', '（暂无记忆。No memories yet.）')
    return parts.join('\n')
  }
  const groups = { global: [], workspace: [] }
  for (const entry of selected) {
    groups[entry.scope === 'global' ? 'global' : 'workspace'].push(entryLine(entry))
  }
  parts.push('', '### 已召回的记忆 Recalled memories')
  if (groups.global.length > 0) parts.push('全局 Global:', ...groups.global)
  if (groups.workspace.length > 0) parts.push('当前工作区 Current workspace:', ...groups.workspace)
  if (omitted > 0) {
    parts.push(`（另有 ${omitted} 条记忆未注入，用 memory_search 检索。${omitted} more memories not injected; use memory_search.)`)
  }
  return parts.join('\n')
}
