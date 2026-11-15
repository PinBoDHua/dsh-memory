/**
 * dsh-memory 学习存储与闸门 Learning store & tool-boundary gate.
 *
 * schema v3 新增 `learning/` 目录（与条目正文分离）：
 * - `pending.json`：R2「需确认」候选（不注入，用户批准前不生效）；
 * - `audit.jsonl`：只追加的审计事件（不复制候选正文）；
 * - `state.json`：operational 状态（会话额度、信号提醒/消费状态、摘要游标）；
 *   会话结束后的残留按 TTL 惰性回收。
 *
 * 闸门语义（由 memory_save 工具边界调用，不靠模型自觉）：
 * 1. 自动/模型手写保存都必须携带「本会话有效且未消费」的 signal_id；
 * 2. R3 拒绝且不落任何候选正文（条目/pending/audit/state 只有计数与类型）；
 * 3. R2 只进 pending 并计入会话额度；R1 直接生效（origin=auto 可撤销）；
 * 4. 自动落盘候选（活跃条目 + pending）每会话默认最多 5 条，用户显式 manual 不占额度；
 * 5. 条目先落盘、状态后消费：状态写失败时重试会命中去重而非产生重复条目。
 *
 * 所有读-改-写都在 `.lock-learning` 跨进程锁内完成，并与条目写锁保持
 * 「learning → write」的固定锁序（无反向获取，不构成死锁）。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from './lock.js'
import { classifyRisk, findConflictCandidates } from './signals.js'
import * as skills from './skills.js'
import { atomicWrite, listScope, normalizeContent, readJsonText, saveEntry } from './store.js'

export const LEARNING_DIR = 'learning'
export const LEARNING_SCHEMA_VERSION = 1
/** 会话学习状态保留期（残留 state 惰性回收）。 */
export const STATE_TTL_MS = 7 * 24 * 3600 * 1000
/** 已决 pending 保留期（保留短期可追溯，之后清理）。 */
export const PENDING_DECIDED_TTL_MS = 30 * 24 * 3600 * 1000
/** 提醒过的信号可用于工具保存的有效期。 */
export const SIGNAL_TTL_MS = 24 * 3600 * 1000
export const AUDIT_TAIL_LIMIT = 50
export const PENDING_CONTENT_MAX = 4000
export const AUTO_WRITES_DEFAULT = 5
export const AUTO_WRITES_MAX = 5

const LEARNING_LOCK = '.lock-learning'

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

export function learningPaths(root) {
  const dir = path.join(root, LEARNING_DIR)
  return {
    dir,
    state: path.join(dir, 'state.json'),
    pending: path.join(dir, 'pending.json'),
    audit: path.join(dir, 'audit.jsonl'),
    digests: path.join(dir, 'digests.json'),
  }
}

/** 创建 learning 目录与初始文件（迁移/首次写入时调用；可重复调用）。 */
export function ensureLearning(root) {
  const paths = learningPaths(root)
  fs.mkdirSync(paths.dir, { recursive: true })
  if (!fs.existsSync(paths.state)) atomicWrite(paths.state, `${JSON.stringify({ version: LEARNING_SCHEMA_VERSION, sessions: {} }, null, 2)}\n`)
  if (!fs.existsSync(paths.pending)) atomicWrite(paths.pending, `${JSON.stringify({ version: LEARNING_SCHEMA_VERSION, items: [] }, null, 2)}\n`)
  if (!fs.existsSync(paths.audit)) {
    try { fs.writeFileSync(paths.audit, '', 'utf8') } catch { /* best-effort */ }
  }
  return paths
}

function withLearningLock(root, fn) {
  return withLock(path.join(root, LEARNING_LOCK), fn, { timeoutMs: 1500 })
}

function iso(now) {
  return new Date(Number(now)).toISOString()
}

function readStateDoc(root) {
  const parsed = readJsonText(learningPaths(root).state)
  if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
    return {
      version: LEARNING_SCHEMA_VERSION,
      sessions: parsed.sessions,
      ...(parsed.digest && typeof parsed.digest === 'object' ? { digest: parsed.digest } : {}),
    }
  }
  return { version: LEARNING_SCHEMA_VERSION, sessions: {} }
}

function writeStateDoc(root, state) {
  atomicWrite(learningPaths(root).state, `${JSON.stringify(state, null, 2)}\n`)
}

function readPendingDoc(root) {
  const parsed = readJsonText(learningPaths(root).pending)
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
    return { version: LEARNING_SCHEMA_VERSION, items: parsed.items }
  }
  return { version: LEARNING_SCHEMA_VERSION, items: [] }
}

function writePendingDoc(root, doc) {
  atomicWrite(learningPaths(root).pending, `${JSON.stringify(doc, null, 2)}\n`)
}

function sessionOf(state, sessionId, now) {
  const key = String(sessionId ?? '')
  let session = state.sessions[key]
  if (!session || typeof session !== 'object') {
    session = { signals: {}, quotaUsed: 0, lastSeenAt: iso(now) }
  }
  if (!session.signals || typeof session.signals !== 'object') session.signals = {}
  const used = Number(session.quotaUsed)
  session.quotaUsed = Number.isFinite(used) && used >= 0 ? Math.floor(used) : 0
  const pendingSeen = Number(session.lastPendingCount)
  session.lastPendingCount = Number.isFinite(pendingSeen) && pendingSeen >= 0 ? Math.floor(pendingSeen) : 0
  session.lastSeenAt = iso(now)
  state.sessions[key] = session
  return session
}

/** 惰性回收：过期会话状态、已决 pending。 */
function pruneDocs(state, pendingDoc, now) {
  for (const [key, session] of Object.entries(state.sessions)) {
    const seen = Date.parse(session?.lastSeenAt ?? '')
    if (!Number.isFinite(seen) || now - seen > STATE_TTL_MS) {
      delete state.sessions[key]
      continue
    }
    for (const [id, record] of Object.entries(session.signals ?? {})) {
      const at = Date.parse(record?.at ?? '')
      if (!Number.isFinite(at) || now - at > STATE_TTL_MS) delete session.signals[id]
    }
  }
  const items = Array.isArray(pendingDoc.items) ? pendingDoc.items : []
  pendingDoc.items = items.filter((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.status === 'pending') return true
    const decided = Date.parse(item.decidedAt ?? '')
    return Number.isFinite(decided) && now - decided <= PENDING_DECIDED_TTL_MS
  })
}

/** 追加审计事件（只记事件与 id，不记候选正文）。 */
export function appendAudit(root, event) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
  try {
    fs.mkdirSync(learningPaths(root).dir, { recursive: true })
    fs.appendFileSync(learningPaths(root).audit, line, 'utf8')
  } catch { /* 审计 best-effort：不得因审计失败回滚记忆写入 */ }
}

/** 读取最近 N 条审计事件（容忍损坏行）。 */
export function auditTail(root, limit = AUDIT_TAIL_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : AUDIT_TAIL_LIMIT
  let text = ''
  try { text = fs.readFileSync(learningPaths(root).audit, 'utf8') } catch { return [] }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const out = []
  for (const line of lines.slice(-max)) {
    try { out.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
  }
  return out
}

/** 标记信号已提醒（同一信号只提醒一次）；返回本次新提醒的信号。写失败时按未提醒处理。 */
export function markSignalsReminded({ root, sessionId, signals = [], now = Date.now() } = {}) {
  const list = (Array.isArray(signals) ? signals : []).filter((s) => s && typeof s.id === 'string' && s.id !== '')
  if (list.length === 0) return { reminded: [] }
  try {
    return withLearningLock(root, () => {
      const state = readStateDoc(root)
      const session = sessionOf(state, sessionId, now)
      const reminded = []
      for (const signal of list) {
        const record = session.signals[signal.id] ?? { type: signal.type, at: iso(signal.at ?? now) }
        // 已消费的信号不再提醒（避免已落盘后还催模型重复写入）。
        if (record.consumedAt) continue
        if (!record.remindedAt) {
          record.remindedAt = iso(now)
          reminded.push(signal)
        }
        session.signals[signal.id] = record
      }
      pruneDocs(state, readPendingDoc(root), now)
      writeStateDoc(root, state)
      return { reminded }
    })
  } catch {
    // 状态写失败不应丢提醒（下次装配会再次提醒，属可接受的重复）。
    return { reminded: list }
  }
}

/** 读取会话额度（只读、不加锁；用于提醒与面板展示）。 */
export function readQuota({ root, sessionId, limit = AUTO_WRITES_DEFAULT, now = Date.now() } = {}) {
  const state = readStateDoc(root)
  const session = state.sessions[String(sessionId ?? '')] ?? { quotaUsed: 0 }
  const used = Number(session.quotaUsed) || 0
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : AUTO_WRITES_DEFAULT
  return { used, limit: max, remaining: Math.max(0, max - used), blocked: used >= max }
}

/** 待确认候选提醒（v0.31.0 / I4）：仅在候选数量变化时返回一行系统侧提示，只含数量与入口。 */
export function pendingNotice({ root, sessionId, conflictAlert = true, now = Date.now() } = {}) {
  const sid = String(sessionId ?? '')
  if (sid === '') return null
  return withLearningLock(root, () => {
    ensureLearning(root)
    const state = readStateDoc(root)
    const session = sessionOf(state, sid, now)
    const pendingDoc = readPendingDoc(root)
    const pending = pendingDoc.items.filter((item) => item && item.status === 'pending')
    const conflicts = pending.filter((item) => Array.isArray(item.conflictWith) && item.conflictWith.length > 0)
    const count = pending.length
    const last = Math.max(0, Math.floor(Number(session.lastPendingCount) || 0))
    if (count === last) return null
    session.lastPendingCount = count
    pruneDocs(state, pendingDoc, now)
    writeStateDoc(root, state)
    if (count === 0) return null
    const conflictNote = conflictAlert === false || conflicts.length === 0 ? '' : `（含 ${conflicts.length} 条疑似冲突）`
    return {
      text: `[dsh-memory] 有 ${count} 条待确认学习候选${conflictNote}，未批准前不生效；请在面板「学习」分区审阅。`,
      pendingCount: count,
      conflictCount: conflictAlert === false ? 0 : conflicts.length,
    }
  })
}

function startOfLocalWeek(now) {
  const d = new Date(Number(now))
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime()
}

function weekKeyOf(now) {
  const start = startOfLocalWeek(now)
  const d = new Date(start)
  const year = d.getFullYear()
  const jan1 = new Date(year, 0, 1).getTime()
  const week = Math.floor((start - jan1) / (7 * 86400000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

function countAuditTypes(events) {
  const counts = {}
  for (const event of events) {
    const type = typeof event?.type === 'string' ? event.type : 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

function digestText(weekKey, counts, pendingCount, conflictCount, pendingSkillCount) {
  const parts = []
  const add = (label, n) => { if (n > 0) parts.push(`${label} ${n}`) }
  add('自动写入', counts.auto_saved ?? 0)
  const created = counts.pending_created ?? 0
  if (created > 0) parts.push(`新候选 ${created}（批准 ${counts.pending_approved ?? 0} / 拒绝 ${counts.pending_rejected ?? 0}）`)
  add('重复合并组', counts.duplicates_merged ?? 0)
  add('归档', counts.entries_archived ?? 0)
  add('恢复', counts.entries_restored ?? 0)
  add('技能批准', counts.skill_approved ?? 0)
  add('技能待批', counts.skill_pending ?? 0)
  if (parts.length === 0) return null
  const now = `当前待确认 ${pendingCount} 条${conflictCount > 0 ? `（疑似冲突 ${conflictCount} 条）` : ''}${pendingSkillCount > 0 ? `、技能待批 ${pendingSkillCount} 条` : ''}`
  return `[dsh-memory 周报 ${weekKey}] 本周：${parts.join(' / ')}；${now}。可在面板「学习」分区审阅。`
}

/**
 * 确定性周报（v0.31.0 / I4）：对审计事件做纯聚合，每周（本地周一为界）首次装配最多注入一次；
 * 无事件不注入、不调用 LLM、不生成新事实；注入文本只含计数，不含正文。
 * 返回 {text, record} 或 null。
 */
export function maybeWeeklyDigest({ root, now = Date.now(), enabled = true } = {}) {
  if (enabled === false) return null
  const weekKey = weekKeyOf(now)
  return withLearningLock(root, () => {
    ensureLearning(root)
    const state = readStateDoc(root)
    const digest = state.digest && typeof state.digest === 'object' ? state.digest : {}
    if (digest.lastWeekKey === weekKey) return null
    // 首次生成聚合全部可读审计（2000 条上限）；之后只看上次生成之后的增量事件。
    const since = Number.isFinite(Number(digest.lastEmittedAt)) ? Number(digest.lastEmittedAt) : 0
    const events = auditTail(root, 2000).filter((event) => {
      const ts = Date.parse(event?.ts ?? '')
      return Number.isFinite(ts) && ts > since
    })
    if (events.length === 0) return null
    const counts = countAuditTypes(events)
    const pendingDoc = readPendingDoc(root)
    const pending = pendingDoc.items.filter((item) => item && item.status === 'pending')
    const conflictCount = pending.filter((item) => Array.isArray(item.conflictWith) && item.conflictWith.length > 0).length
    let pendingSkillCount = 0
    try { pendingSkillCount = skills.listSkills(root, { status: 'pending' }).length } catch { /* ignore */ }
    const text = digestText(weekKey, counts, pending.length, conflictCount, pendingSkillCount)
    if (!text) return null
    const record = {
      weekKey,
      generatedAt: iso(now),
      since: iso(since),
      events: events.length,
      counts,
      pending: pending.length,
      conflicts: conflictCount,
      pendingSkills: pendingSkillCount,
      text,
    }
    const archivePath = learningPaths(root).digests
    const parsed = readJsonText(archivePath)
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
    items.push(record)
    while (items.length > DIGEST_ARCHIVE_LIMIT) items.shift()
    atomicWrite(archivePath, `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
    state.digest = { lastWeekKey: weekKey, lastEmittedAt: Number(now), lastAt: iso(now) }
    writeStateDoc(root, state)
    appendAudit(root, { type: 'digest_emitted', weekKey })
    return { text, record }
  })
}

/** 摘要存档（面板展示/验收）：最近 N 期周报。 */
export const DIGEST_ARCHIVE_LIMIT = 20
export function readDigestArchive(root) {
  const parsed = readJsonText(learningPaths(root).digests)
  if (parsed && Array.isArray(parsed.items)) return parsed.items.slice(-DIGEST_ARCHIVE_LIMIT)
  return []
}

function signalRecord(session, signalId) {
  const record = session.signals[String(signalId ?? '')]
  return record && typeof record === 'object' ? record : null
}

function consumeSignal(session, signalId, patch, now) {
  const id = String(signalId ?? '')
  const record = session.signals[id] ?? patch._detected ?? { type: 'unknown', at: iso(now) }
  delete record._detected
  record.consumedAt = iso(now)
  if (patch.origin) record.origin = patch.origin
  if (patch.entryId) record.entryId = patch.entryId
  if (patch.pendingId) record.pendingId = patch.pendingId
  if (patch.risk) record.risk = patch.risk
  session.signals[id] = record
}

/** 归一化 pending 条目（读取时容错，防止手工编辑破坏面板）。 */
function normalizePendingItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.content !== 'string' || raw.content.trim() === '') return null
  return {
    id: raw.id,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    signalId: typeof raw.signalId === 'string' ? raw.signalId : '',
    origin: raw.origin === 'manual' ? 'manual' : 'auto',
    category: ['preference', 'fact', 'decision'].includes(raw.category) ? raw.category : 'fact',
    scope: raw.scope === 'global' ? 'global' : 'workspace',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    content: raw.content.slice(0, PENDING_CONTENT_MAX),
    source: typeof raw.source === 'string' ? raw.source : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    risk: typeof raw.risk === 'string' ? raw.risk : 'R2',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    conflictWith: Array.isArray(raw.conflictWith) ? raw.conflictWith.filter((id) => typeof id === 'string') : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    status: raw.status === 'approved' || raw.status === 'rejected' ? raw.status : 'pending',
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : undefined,
    entryId: typeof raw.entryId === 'string' ? raw.entryId : undefined,
  }
}

/** 列出 pending 候选（默认只看待确认；面板用于审核）。 */
export function listPending({ root, status = 'pending' } = {}) {
  const doc = readPendingDoc(root)
  const items = []
  for (const raw of doc.items) {
    const item = normalizePendingItem(raw)
    if (!item) continue
    if (status === 'all' || item.status === status) items.push(item)
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id))
  return items
}

/**
 * 学习信号驱动的写入闸门（工具边界）。
 * 返回 {status:'active'|'pending', ...}；R3/额度/信号无效一律抛带 code 的固定文案错误。
 */
export function commitWithSignal({
  root,
  sessionId,
  signalId,
  detectedSignals = [],
  origin = 'auto',
  content,
  category = 'fact',
  scope = 'workspace',
  tags = [],
  source = '',
  workspace,
  existing = [],
  limit = AUTO_WRITES_DEFAULT,
  now = Date.now(),
} = {}) {
  const sid = String(sessionId ?? '')
  if (sid === '') throw coded('no-signal', '没有可用的学习信号：自动/模型手写保存必须来自当前会话的直接用户消息 / no learning signal for this session')
  if (origin !== 'auto' && origin !== 'manual') throw coded('invalid', `未知来源 unknown origin: ${origin}`)
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : AUTO_WRITES_DEFAULT
  if (max === 0) {
    throw coded('autolimit', '自动学习已关闭（额度 0），只有用户在面板手动添加才能保存 / automatic learning is disabled (limit 0); only panel saves are allowed')
  }
  const detected = Array.isArray(detectedSignals) ? detectedSignals : []
  const detectedSignal = detected.find((s) => s && s.id === signalId)

  return withLearningLock(root, () => {
    // 首个学习写入时创建 learning/ 目录与初始文件（fresh v3 存储没有迁移流程）。
    ensureLearning(root)
    const state = readStateDoc(root)
    const session = sessionOf(state, sid, now)
    const record = signalRecord(session, signalId)
    if (record?.consumedAt) {
      throw coded('signal-consumed', '该学习信号已被使用，不能重复落盘；如内容有变化请用 memory_update / this signal was already consumed')
    }
    // 有效信号 = 本轮检测到，或同一会话内已提醒过且未过期。
    const remindedAt = Date.parse(record?.remindedAt ?? '')
    const usableFromState = Number.isFinite(remindedAt) && now - remindedAt <= SIGNAL_TTL_MS
    if (!detectedSignal && !(record && usableFromState)) {
      throw coded('no-signal', 'signal_id 无效或已过期：只有当轮检测到的学习信号可用于保存 / invalid or expired signal_id')
    }
    const signalType = detectedSignal?.type ?? record?.type ?? ''
    if (origin === 'manual' && signalType !== 'explicit_memory') {
      throw coded('no-signal', 'origin=manual 只能绑定用户显式「记住」指令；主动沉淀请用 origin=auto / origin=manual requires a direct explicit-memory instruction')
    }
    if (origin === 'auto' && session.quotaUsed >= max) {
      throw coded('autolimit', `本会话自动写入额度已用尽（${session.quotaUsed}/${max}），如用户明确要求请用 origin=manual / session auto-write quota exhausted`)
    }

    const risk = classifyRisk({ origin, signalType, content, category, scope, tags, existing })
    if (risk.level === 'R3') {
      consumeSignal(session, signalId, { origin, risk: 'R3' }, now)
      pruneDocs(state, readPendingDoc(root), now)
      writeStateDoc(root, state)
      appendAudit(root, { type: 'auto_rejected', risk: 'R3', reason: risk.reasons[0] ?? '', sessionId: sid, signalId })
      throw coded('rejected-risk', '该内容属于禁止自动落盘类别（机密/短期任务/内嵌指令/敏感推断），未保存 / refused: this candidate must not be auto-stored')
    }

    // 直接用户纠正形成的偏好：自动补 `constraint` 保留 tag（注入置顶、免软衰减），
    // 不依赖模型是否记得加标签（I1 验收 FI-2）。
    let writeTags = Array.isArray(tags) ? tags.slice() : []
    if (origin === 'auto' && (signalType === 'correction' || signalType === 'tool_failure_correction') && category === 'preference') {
      if (!writeTags.some((tag) => String(tag).toLowerCase() === 'constraint')) writeTags.push('constraint')
    }

    if (risk.level === 'R2') {
      const pendingDoc = readPendingDoc(root)
      const item = {
        id: `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
        sessionId: sid,
        signalId: String(signalId ?? ''),
        origin,
        category,
        scope,
        tags: writeTags,
        content: String(content ?? '').slice(0, PENDING_CONTENT_MAX),
        source: typeof source === 'string' ? source : '',
        ...(scope === 'workspace' && typeof workspace === 'string' && workspace !== '' ? { cwd: workspace } : {}),
        risk: 'R2',
        reason: risk.reasons[0] ?? '',
        conflictWith: risk.reasons.includes('suspected-conflict') ? findConflictCandidates(content, existing).map((hit) => hit.id) : [],
        createdAt: iso(now),
        status: 'pending',
      }
      pendingDoc.items.push(item)
      consumeSignal(session, signalId, { origin, pendingId: item.id, risk: 'R2' }, now)
      if (origin === 'auto') session.quotaUsed += 1
      pruneDocs(state, pendingDoc, now)
      writePendingDoc(root, pendingDoc)
      writeStateDoc(root, state)
      appendAudit(root, { type: 'pending_created', risk: 'R2', reason: item.reason, sessionId: sid, signalId, pendingId: item.id, conflictCount: item.conflictWith.length })
      return { status: 'pending', pendingId: item.id, scope, category, origin, risk: 'R2', reason: item.reason, conflictWith: item.conflictWith }
    }

    // R1：先落条目（去重/取代/相似提示沿用现有实现），成功后再消费信号。
    const saved = saveEntry(root, {
      content,
      category,
      scope,
      tags: writeTags,
      cwd: workspace,
      source: typeof source === 'string' ? source : '',
      origin,
      explicitFields: [],
    })
    const counted = !saved.deduplicated || saved.revived
    consumeSignal(session, signalId, { origin, entryId: saved.entry.id, risk: 'R1' }, now)
    if (origin === 'auto' && counted) session.quotaUsed += 1
    pruneDocs(state, readPendingDoc(root), now)
    writeStateDoc(root, state)
    appendAudit(root, { type: 'auto_saved', risk: 'R1', sessionId: sid, signalId, entryId: saved.entry.id, deduplicated: Boolean(saved.deduplicated) })
    return {
      status: 'active',
      entry: saved.entry,
      deduplicated: Boolean(saved.deduplicated),
      revived: Boolean(saved.revived),
      applied: Boolean(saved.applied),
      similar: Array.isArray(saved.similar) ? saved.similar : [],
      risk: risk.level,
    }
  })
}

/**
 * 技能候选（I3）的一次性信号消费：与记忆闸门同规则，但不写 pending.json ——
 * pending skill 由 skills/ 目录的状态机承载；信号/额度在创建 pending skill 后消费。
 */
export function takeSignal({ root, sessionId, signalId, detectedSignals = [], origin = 'auto', limit = AUTO_WRITES_DEFAULT, now = Date.now() } = {}) {
  const sid = String(sessionId ?? '')
  if (sid === '') throw coded('no-signal', '没有可用的学习信号：skill 候选必须来自当前会话的直接用户消息 / no learning signal for this session')
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : AUTO_WRITES_DEFAULT
  if (max === 0) throw coded('autolimit', '自动学习已关闭（额度 0），请用户在面板手动创建 / automatic learning is disabled (limit 0)')
  const detected = Array.isArray(detectedSignals) ? detectedSignals : []
  const detectedSignal = detected.find((s) => s && s.id === signalId)
  return withLearningLock(root, () => {
    ensureLearning(root)
    const state = readStateDoc(root)
    const session = sessionOf(state, sid, now)
    const record = signalRecord(session, signalId)
    if (record?.consumedAt) throw coded('signal-consumed', '该学习信号已被使用 / this signal was already consumed')
    const remindedAt = Date.parse(record?.remindedAt ?? '')
    const usableFromState = Number.isFinite(remindedAt) && now - remindedAt <= SIGNAL_TTL_MS
    if (!detectedSignal && !(record && usableFromState)) throw coded('no-signal', 'signal_id 无效或已过期 / invalid or expired signal_id')
    if (origin === 'auto' && session.quotaUsed >= max) throw coded('autolimit', `本会话自动写入额度已用尽（${session.quotaUsed}/${max}） / session auto-write quota exhausted`)
    const signalType = detectedSignal?.type ?? record?.type ?? ''
    consumeSignal(session, signalId, { origin, risk: 'R2' }, now)
    if (origin === 'auto') session.quotaUsed += 1
    pruneDocs(state, readPendingDoc(root), now)
    writeStateDoc(root, state)
    appendAudit(root, { type: 'skill_candidate_created', sessionId: sid, signalId, signalType })
    return { signalType, quotaUsed: session.quotaUsed, limit: max }
  })
}

/** 批准 pending 候选：落盘为活跃条目（origin 沿用候选来源；不占自动额度）。 */
export function approvePending({ root, pendingId, workspace, now = Date.now() } = {}) {
  return withLearningLock(root, () => {
    const doc = readPendingDoc(root)
    const index = doc.items.findIndex((raw) => raw && raw.id === pendingId)
    if (index < 0) throw coded('not-found', `未找到待确认候选 / pending candidate not found: ${pendingId}`)
    const item = normalizePendingItem(doc.items[index])
    if (!item) throw coded('invalid', '待确认候选损坏 / corrupt pending candidate')
    if (item.status !== 'pending') throw coded('invalid', '该候选已处理 / pending candidate already decided')
    const cwd = item.scope === 'workspace' ? (workspace || item.cwd) : undefined
    if (item.scope === 'workspace' && !cwd) throw coded('no-workspace', '待确认候选需要工作目录 / pending candidate requires a workspace')
    const saved = saveEntry(root, {
      content: item.content,
      category: item.category,
      scope: item.scope,
      tags: item.tags,
      cwd,
      source: item.source,
      origin: item.origin,
      explicitFields: [],
    })
    doc.items[index] = {
      ...doc.items[index],
      status: 'approved',
      decidedAt: iso(now),
      entryId: saved.entry.id,
    }
    writePendingDoc(root, doc)
    appendAudit(root, { type: 'pending_approved', pendingId: item.id, entryId: saved.entry.id, sessionId: item.sessionId })
    return { pendingId: item.id, entryId: saved.entry.id, entry: saved.entry, deduplicated: Boolean(saved.deduplicated) }
  })
}

/** 拒绝 pending 候选（不删除审计痕迹；候选正文标记为 rejected 后按 TTL 回收）。 */
export function rejectPending({ root, pendingId, now = Date.now() } = {}) {
  return withLearningLock(root, () => {
    const doc = readPendingDoc(root)
    const index = doc.items.findIndex((raw) => raw && raw.id === pendingId)
    if (index < 0) throw coded('not-found', `未找到待确认候选 / pending candidate not found: ${pendingId}`)
    const item = normalizePendingItem(doc.items[index])
    if (!item) throw coded('invalid', '待确认候选损坏 / corrupt pending candidate')
    if (item.status !== 'pending') throw coded('invalid', '该候选已处理 / pending candidate already decided')
    doc.items[index] = { ...doc.items[index], status: 'rejected', decidedAt: iso(now) }
    writePendingDoc(root, doc)
    appendAudit(root, { type: 'pending_rejected', pendingId: item.id, sessionId: item.sessionId })
    return { pendingId: item.id }
  })
}

/** 学习分区概览（面板）。 */
export function learningOverview({ root, now = Date.now() } = {}) {
  const pending = listPending({ root, status: 'pending' })
  const audit = auditTail(root, 20)
  return {
    pending,
    pendingCount: pending.length,
    audit,
    signalsSeen: 0,
  }
}
