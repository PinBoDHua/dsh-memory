/**
 * dsh-memory 提示渲染 Prompt rendering.
 *
 * GUIDANCE：何时记、记什么、隐私红线（中文为主，附英文要点）。
 * renderSection：指引 + 预算内的召回记忆。记忆内容按原文注入，
 * 因此注册 section 时必须 interpolate: false（内容可能含 {{…}}）。
 */

export const GUIDANCE = `## 长期记忆 Long-term memory (dsh-memory)

你拥有跨会话长期记忆。下方召回的记忆来自过去的会话，直接适用于当前对话；与用户当前指令冲突时，以当前指令为准。
You have cross-session long-term memory. Recalled memories below apply unless the user's current instructions override them.

何时写入（memory_save，一事一条）：
- 用户明确要求记住某事。
- 出现稳定的用户偏好/习惯（语言、格式、工具偏好等）→ scope=global。
- 出现项目级事实或重要决策（架构选择、约定、环境事实）→ scope=workspace。
- 信息变化用 memory_update 新覆旧；用户要求忘记用 memory_forget；需要更多细节用 memory_search。
不要记录：临时闲聊、可从代码/文档直接推导的内容、密码/密钥/token（工具会硬拒绝）。其他敏感个人信息写入前必须先征得用户同意。
自动写入后在回复中简短提及（如"已记录 1 条记忆"），不逐条罗列内容。`

function entryLine(entry) {
  return `- [${entry.category}] ${entry.content.replace(/\s+/g, ' ')} (id: ${entry.id})`
}

/**
 * 渲染注入文本。entries 需已按 updated 倒序；预算从最新条目开始装，
 * 装不下的跳过并计数，提示 agent 用 memory_search 获取。
 */
export function renderSection(entries, { autoInject = true, budgetChars = 6000 } = {}) {
  const parts = [GUIDANCE]
  if (!autoInject) return parts.join('\n')
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) {
    parts.push('', '（暂无记忆。No memories yet.）')
    return parts.join('\n')
  }
  const budget = Math.max(0, Number(budgetChars) || 0)
  const groups = { global: [], workspace: [] }
  let used = 0
  let omitted = 0
  for (const entry of list) {
    const line = entryLine(entry)
    if (used + line.length + 1 > budget) {
      omitted += 1
      continue
    }
    used += line.length + 1
    groups[entry.scope === 'global' ? 'global' : 'workspace'].push(line)
  }
  parts.push('', '### 已召回的记忆 Recalled memories')
  if (groups.global.length > 0) parts.push('全局 Global:', ...groups.global)
  if (groups.workspace.length > 0) parts.push('当前工作区 Current workspace:', ...groups.workspace)
  if (omitted > 0) {
    parts.push(`（另有 ${omitted} 条记忆未注入，用 memory_search 检索。${omitted} more memories not injected; use memory_search.)`)
  }
  return parts.join('\n')
}
