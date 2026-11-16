/**
 * dsh-memory 学习信号层 Learning signal layer.
 *
 * 纯函数、零 LLM 调用、零后台任务：
 * - detectSignals：从模型可见消息尾部检测「直接用户发出的、值得学习」的信号
 *   （显式记忆指令 / 直接纠正 / 工具失败后的纠正 / 新环境事实 / 重复交代）；
 * - classifyRisk：对模型即将落盘的候选记忆做 R0–R3 风险分级（工具边界强制执行）；
 * - renderSignalReminder：生成单行、只含信号 id 与类型的学习提醒（不夹带候选正文，
 *   防提示注入与正文泄漏）。
 *
 * 信号本身不含正文：提醒与持久化状态里只保留 sha256 派生的 signal id 与类型；
 * 原始消息正文只在检测函数内部短暂使用。
 * Signals never carry raw text: reminders and persisted state keep only the derived
 * signal id and type; raw message text is used only inside detection.
 */
import { createHash } from 'node:crypto'
import { detectSecret } from './guard.js'
import { contentSimilarity, normalizeContent } from './store.js'

/** 信号类型全集（持久化/提醒/评测共用同一套枚举）。 */
export const SIGNAL_TYPES = Object.freeze([
  'explicit_memory',
  'correction',
  'tool_failure_correction',
  'new_environment_fact',
  'repeat_statement',
])

/** 风险分级：R0 无学习信号 → R3 禁止自动落盘（R0 由调用方在无信号时直接拒绝）。 */
export const RISK_LEVELS = Object.freeze(['R0', 'R1', 'R2', 'R3'])

/** 只看最近 N 条消息（压缩后历史被替换也不影响近期信号）。 */
export const SIGNAL_WINDOW = 40
/** 单条消息参与检测的最大字符数（超长粘贴不参与规则匹配）。 */
export const SIGNAL_TEXT_MAX = 4000
/** 同一轮最多产出的信号数。 */
export const MAX_SIGNALS = 3
/** 提醒里最多列出的信号数。 */
export const REMINDER_MAX_SIGNALS = 3
/** 重复交代判定：与既有记忆的内容相似度阈值。 */
export const REPEAT_SIMILARITY = 0.62
/** 疑似冲突判定：与既有记忆的内容相似度阈值（低于去重，高于泛化噪声）。 */
export const CONFLICT_SIMILARITY = 0.55
/** 参与重复/冲突扫描的既有记忆上限（装配热路径的确定性上界）。 */
export const MEMORY_SCAN_LIMIT = 300

/** 显式记忆指令：用户明确要求「记住」。 */
const EXPLICIT_MEMORY = Object.freeze([
  /(?:请|帮我|麻烦)?(?:记住|记下|记一下|记录一下|记着)(?:这|那|以下|下面|：|:|，|,|\s|$)/,
  /以后(?:都|就|一律|别再|别用|不要用|不用|默认|只)/,
  /从今(?:后|往后)|今后/,
  /(?:from now on|remember (?:that|this)|always use|never use)/i,
])

/** 直接纠正：用户指出上一轮行为/结论有问题。 */
const CORRECTION = Object.freeze([
  /(?:不对|不是这样|不是这个意思|错了|搞错|弄错|你错)/,
  /(?:应该|应当)(?:是|用|改成|换成|这么|这样)/,
  /(?:不要|别|禁止|不能|不准)(?:再)?(?:用|使用|这样|这么)/,
  /(?:改成|改为|换成|替换成|改用|要用|得用)/,
  /(?:而不是|不是(?:用|要))/,
  /(?:that'?s wrong|incorrect|should be|instead|don'?t use|not what i)/i,
])

/** 新环境事实：用户描述自己的机器/配置/版本/路径。 */
const ENVIRONMENT_FACT = Object.freeze([
  /(?:我这里|我这边|我的环境|我的机器|我这台|我本机)/,
  /(?:装的是|安装的是|版本是|版本为|路径是|路径为|目录是|默认是|配置是|用的是|使用的是)/,
  /(?:on my machine|my setup|my environment|i'?m (?:using|on))/i,
])

/** 短期任务指令线索：出现即视为临时任务，不落长期记忆。 */
const SHORT_TERM = Object.freeze([
  /(?:今天|明天|后天|今晚|本周|这周|下周|上午|下午|稍后|待会|待会儿|等一下|马上|这次|暂时|先别|下一步|过一会|一会儿)/,
])
/** 持久化线索：与短期线索同时出现时以持久为准（「以后每天…」）。 */
const PERSISTENCE_CUES = /(?:以后|今后|永远|总是|每次|一律|一直|from now on|always|forever)/

/** 疑似提示注入/内嵌指令：来自工具结果或记忆正文的「新指令」不得进入记忆。 */
const INSTRUCTION_LIKE = Object.freeze([
  /(?:忽略|无视)[^。！？\n]{0,12}(?:指令|提示|规则|要求)/,
  /(?:ignore|disregard)\s+(?:all|previous|prior|the above)/i,
  /(?:你现在是|从现在起你是|roleplay as|you are now)/i,
  /system\s*prompt/i,
])

/** 敏感类别：自动推断一律禁止（R3）；用户显式要求时按低风险保存。 */
const SENSITIVE = Object.freeze([
  /(?:健康|疾病|病史|病症|生病|抑郁|焦虑|心理|精神|手术|用药|处方|怀孕|残疾)/,
  /(?:宗教|信仰|政治|党派|选举|种族|民族|性取向|性别认同)/,
  /(?:收入|工资|薪资|存款|负债|贷款|债务|资产|纳税)/,
  /(?:身份证|护照|住址|家庭住址|户籍|手机号|电话号码|社保|银行卡)/,
])

/** 宽泛约束：作用于「所有/任何/永远」的禁令或规则，必须人工确认。 */
const BROAD_CONSTRAINT = Object.freeze([
  /(?:所有|任何|一切|全部)(?:项目|任务|场景|情况|场合|时候|地方)/,
  /(?:永远|绝对|从不)(?:不要|别|不能|不准|必须)/,
  /(?:一律|统统|通通)/,
  /(?:all projects|every time|always|never)\b/i,
])

/** 程序性知识标签：默认进待确认（用户批准后才可作为 skill/playbook 使用）。 */
const PROCEDURAL_TAGS = Object.freeze(['skill', 'playbook', 'sop', 'procedure', 'checklist', 'recipe'])

/** 规范化消息正文：折叠空白、去首尾、限长。 */
export function normalizeSignalText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, SIGNAL_TEXT_MAX)
}

/** 信号 id：会话 × 类型 × 规范化正文的 sha256 前 16 位（确定性、可重放、不含正文）。 */
export function signalIdFor(sessionId, type, text) {
  return createHash('sha256')
    .update(`${String(sessionId ?? '')}\u0000${String(type ?? '')}\u0000${normalizeContent(normalizeSignalText(text))}`)
    .digest('hex')
    .slice(0, 16)
}

/** 归一化 signal_id：提醒与工具描述渲染/接受 `type:id`（如 correction:abc123），
 *  而检测匹配、state 键与一次性消费都用裸 id。闸门入口统一剥掉类型前缀，
 *  使「带前缀」与「裸 id」两种写法等价（遵循文档原样传前缀的模型不再被误拒）。 */
export function normalizeSignalId(signalId) {
  const raw = String(signalId ?? '')
  const at = raw.lastIndexOf(':')
  return at === -1 ? raw : raw.slice(at + 1)
}

/** 重复交代检测：当前用户文本与既有记忆高度相似（说明用户不得不重说）。 */
function matchRepeat(text, memories) {
  const list = Array.isArray(memories) ? memories.slice(0, MEMORY_SCAN_LIMIT) : []
  const norm = normalizeContent(text)
  if (norm.length < 8) return null
  for (const memory of list) {
    const other = normalizeContent(memory?.content ?? '')
    if (other === '') continue
    if (other === norm) return memory
    const shorter = Math.min(other.length, norm.length)
    const longer = Math.max(other.length, norm.length)
    if (longer === 0 || shorter / longer < 0.5) continue
    if (contentSimilarity(text, memory.content) >= REPEAT_SIMILARITY) return memory
  }
  return null
}

/**
 * 从消息尾部检测信号（纯函数）。
 * @param {object} input
 * @param {string} input.sessionId 当前会话 id（缺失时不检测）。
 * @param {Array<{role?:string,text?:string,directUser?:boolean,isError?:boolean}>} input.messages
 *   已归一化的模型可见消息尾部；`directUser` 必须由适配层依据消息 source 判定
 *   （注入上下文/定时提醒/技能内容不算直接用户）。
 * @param {Array<{id?:string,content?:string}>} [input.memories] 当前可见记忆（用于重复交代判定）。
 * @param {number} [input.now]
 * @returns {Array<{id:string,type:string,at:number}>}
 */
export function detectSignals({ sessionId = '', messages = [], memories = [], now = null } = {}) {
  const sid = String(sessionId ?? '')
  if (sid === '') return []
  const list = Array.isArray(messages) ? messages.slice(-SIGNAL_WINDOW) : []
  let lastIndex = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (message && message.role === 'user' && message.directUser === true) {
      lastIndex = i
      break
    }
  }
  if (lastIndex < 0) return []
  const text = normalizeSignalText(list[lastIndex].text)
  if (text === '') return []
  const before = list.slice(0, lastIndex)
  const priorAssistant = before.some((m) => m && m.role === 'assistant' && normalizeSignalText(m.text) !== '')
  const toolFailed = before.slice(-4).some((m) => m && m.role === 'tool' && m.isError === true)

  const types = []
  if (EXPLICIT_MEMORY.some((re) => re.test(text))) types.push('explicit_memory')
  if (CORRECTION.some((re) => re.test(text)) && (priorAssistant || toolFailed)) {
    types.push(toolFailed ? 'tool_failure_correction' : 'correction')
  }
  if (ENVIRONMENT_FACT.some((re) => re.test(text))) types.push('new_environment_fact')
  if (types.length === 0 && matchRepeat(text, memories)) types.push('repeat_statement')

  const at = now === null ? Date.now() : Number(now)
  const seen = new Set()
  const signals = []
  for (const type of types) {
    const id = signalIdFor(sid, type, text)
    if (seen.has(id)) continue
    seen.add(id)
    signals.push({ id, type, at })
    if (signals.length >= MAX_SIGNALS) break
  }
  return signals
}

/**
 * 候选记忆的 R0–R3 风险分级（纯函数，工具边界调用）。
 * - R3：机密、短期任务指令、内嵌指令、自动推断的敏感内容 → 拒绝且不保存候选正文；
 * - R2：程序性知识、宽泛约束、来源与 origin 不符、弱信号/推断、疑似新旧冲突 → 仅进待确认；
 * - R1：显式低风险 → 自动生效（origin=auto 可撤销）。
 * @returns {{level:string,reasons:string[]}}
 */
export function classifyRisk({ origin = 'auto', signalType = '', content = '', category = 'fact', scope = 'workspace', tags = [], existing = [] } = {}) {
  const text = String(content ?? '')
  const tagList = Array.isArray(tags) ? tags.map((t) => String(t)) : []
  const tagText = tagList.join(' ')
  const reasons = []
  const level = (value) => ({ level: value, reasons: reasons.slice() })

  if (text.trim() === '') return level('R3')
  if (detectSecret(text) || detectSecret(tagText)) { reasons.push('credential'); return level('R3') }
  if (SHORT_TERM.some((re) => re.test(text)) && !PERSISTENCE_CUES.test(text)) { reasons.push('short-term-task'); return level('R3') }
  if (INSTRUCTION_LIKE.some((re) => re.test(text))) { reasons.push('embedded-instruction'); return level('R3') }

  const sensitive = SENSITIVE.some((re) => re.test(text))
  if (sensitive && origin !== 'manual') { reasons.push('sensitive-inference'); return level('R3') }
  if (sensitive) reasons.push('sensitive-explicit-consent')

  if (tagList.some((tag) => PROCEDURAL_TAGS.includes(tag.toLowerCase()))) { reasons.push('procedural-knowledge'); return level('R2') }
  if (BROAD_CONSTRAINT.some((re) => re.test(text))) { reasons.push('broad-constraint'); return level('R2') }
  if (origin === 'auto' && signalType === 'explicit_memory') { reasons.push('origin-mismatch'); return level('R2') }
  if (signalType === 'repeat_statement') { reasons.push('inferred-from-repeat'); return level('R2') }
  if (origin === 'auto' && !['correction', 'tool_failure_correction', 'new_environment_fact', 'explicit_memory'].includes(signalType)) {
    reasons.push('weak-signal')
    return level('R2')
  }

  // 疑似新旧冲突：与既有可见条目高度相似但非完全相同 → 交用户确认（不自动覆盖）。
  const normalized = normalizeContent(text)
  const candidates = Array.isArray(existing) ? existing.slice(0, MEMORY_SCAN_LIMIT) : []
  for (const entry of candidates) {
    const other = normalizeContent(entry?.content ?? '')
    if (other === '' || other === normalized) continue
    if (other.includes(normalized) && normalized.length >= 12) { reasons.push('suspected-conflict'); return level('R2') }
    if (contentSimilarity(text, entry.content) >= CONFLICT_SIMILARITY) { reasons.push('suspected-conflict'); return level('R2') }
  }

  if (reasons.length === 0) reasons.push('low-risk')
  return level('R1')
}

/**
 * 疑似冲突候选（确定性，供 pending 项记录「与哪些旧条目冲突」）：
 * 规范化正文包含或 Jaccard ≥ CONFLICT_SIMILARITY，按分数倒序最多 limit 条。
 * 只用于让用户判断，不做任何自动覆盖/取代。
 */
export function findConflictCandidates(content, existing = [], { limit = 3 } = {}) {
  const text = String(content ?? '')
  const normalized = normalizeContent(text)
  if (normalized === '') return []
  const out = []
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 3
  for (const entry of Array.isArray(existing) ? existing : []) {
    const other = normalizeContent(entry?.content ?? '')
    if (other === '' || other === normalized) continue
    const contained = other.includes(normalized) && normalized.length >= 12
    const score = contained ? 1 : contentSimilarity(text, entry.content)
    if (!contained && score < CONFLICT_SIMILARITY) continue
    out.push({ id: entry.id, score: Math.round(score * 100) / 100 })
  }
  out.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
  return out.slice(0, max)
}

/**
 * 学习提醒（单行，只含类型与 signal id，不含任何候选/消息正文）。
 * 无信号时返回空串（不注入，不产生上下文噪声）。
 */
export function renderSignalReminder({ signals = [], quota = null } = {}) {
  const list = (Array.isArray(signals) ? signals : []).slice(0, REMINDER_MAX_SIGNALS)
  if (list.length === 0) return ''
  const tokens = list.map((signal) => `${signal.type}:${signal.id}`).join(', ')
  let text = `[dsh-memory] 检测到可学习信号（${tokens}）。若确为稳定的长期事实，用 memory_save 并携带对应 signal_id：用户显式要求→origin=manual；主动沉淀→origin=auto（自动分级，高风险进待确认）。无价值则忽略。`
  if (quota) {
    const used = Number(quota.used)
    const limit = Number(quota.limit)
    if (Number.isFinite(used) && Number.isFinite(limit) && limit >= 0 && used >= limit) {
      text += ` 本会话自动写入额度已用尽（${used}/${limit}），用户显式要求仍可保存。`
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}
