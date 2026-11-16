/**
 * dsh-memory v0.28.0 学习存储与工具边界闸门单测：
 * 信号消费、R1/R2/R3 分流、会话额度、pending 审批、审计与状态隐私。
 * 运行 Run: node --test tests/learning.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as learning from '../lib/learning.js'
import * as store from '../lib/store.js'

const SIGNAL = (id, type = 'correction') => ({ id, type, at: Date.now() })

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-learning-'))
  learning.ensureLearning(root)
  return root
}

function write(root, options = {}) {
  return learning.commitWithSignal({
    root,
    sessionId: options.sessionId ?? 's-1',
    signalId: options.signalId ?? 'sig-1',
    detectedSignals: options.detectedSignals ?? [SIGNAL(options.signalId ?? 'sig-1', options.type ?? 'correction')],
    origin: options.origin ?? 'auto',
    content: options.content ?? '以后回复用中文',
    category: options.category ?? 'preference',
    scope: options.scope ?? 'global',
    tags: options.tags ?? [],
    workspace: options.workspace,
    existing: options.existing ?? [],
    limit: options.limit ?? learning.AUTO_WRITES_DEFAULT,
    now: options.now,
  })
}

function readState(root) {
  return JSON.parse(fs.readFileSync(learning.learningPaths(root).state, 'utf8'))
}

function readPending(root) {
  return JSON.parse(fs.readFileSync(learning.learningPaths(root).pending, 'utf8'))
}

test('R1 auto write creates an active entry, consumes the signal and counts one quota', () => {
  const root = tmpRoot()
  const result = write(root)
  assert.equal(result.status, 'active')
  assert.equal(result.entry.origin, 'auto')
  assert.equal(result.risk, 'R1')
  const entries = store.listAll(root)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, '以后回复用中文')
  const state = readState(root)
  const session = state.sessions['s-1']
  assert.equal(session.quotaUsed, 1)
  assert.ok(session.signals['sig-1'].consumedAt)
  assert.equal(session.signals['sig-1'].entryId, entries[0].id)
  const audit = learning.auditTail(root)
  assert.equal(audit.at(-1).type, 'auto_saved')
  assert.equal(audit.at(-1).entryId, entries[0].id)
})

test('consuming a detected-but-unreminded signal keeps its type in persisted state', () => {
  const root = tmpRoot()
  write(root, { signalId: 'sig-typed', type: 'new_environment_fact' })
  const record = readState(root).sessions['s-1'].signals['sig-typed']
  assert.equal(record.type, 'new_environment_fact', 'type must not fall back to unknown')
  assert.ok(Number.isFinite(Date.parse(record.at)), 'at must stay parseable ISO for TTL pruning')
  assert.ok(record.consumedAt)
  write(root, { signalId: 'sig-typed-r2', type: 'repeat_statement', content: '以后都用 pnpm' })
  assert.equal(readState(root).sessions['s-1'].signals['sig-typed-r2'].type, 'repeat_statement', 'R2 path keeps type too')
})

test('gate accepts the reminder-rendered prefixed signal_id and consumes by bare id (H2)', () => {
  const root = tmpRoot()
  const bare = 'abcdef0123456789'
  const prefixed = 'correction:' + bare
  const result = learning.commitWithSignal({
    root, sessionId: 's-1', signalId: prefixed,
    detectedSignals: [SIGNAL(bare, 'correction')],
    origin: 'auto', content: '以后回复用中文', category: 'preference', scope: 'global',
  })
  assert.equal(result.status, 'active')
  const session = readState(root).sessions['s-1']
  assert.ok(session.signals[bare].consumedAt, 'state must be keyed by the bare id')
  assert.ok(!session.signals[prefixed], 'prefixed key must not leak into state')
  // 重放：无论带前缀还是裸 id，都按已消费拒绝（一次性消费键一致）。
  const replay = (signalId) => learning.commitWithSignal({ root, sessionId: 's-1', signalId, detectedSignals: [SIGNAL(bare)], origin: 'auto', content: '另一条', category: 'fact', scope: 'global' })
  assert.throws(() => replay(prefixed), (e) => e.code === 'signal-consumed')
  assert.throws(() => replay(bare), (e) => e.code === 'signal-consumed')
})

test('takeSignal accepts prefixed signal_id and consumes by bare id (H2)', () => {
  const root = tmpRoot()
  const bare = 'fedcba9876543210'
  const out = learning.takeSignal({ root, sessionId: 's-1', signalId: 'skill_hint:' + bare, detectedSignals: [SIGNAL(bare, 'procedural_knowledge')], origin: 'auto' })
  assert.ok(out.quotaUsed >= 1)
  assert.ok(readState(root).sessions['s-1'].signals[bare].consumedAt)
})

test('approvePending keeps the candidate own cwd over the panel workspace (C1)', () => {
  const root = tmpRoot()
  // 项目 B 会话产生的 workspace 候选（弱信号 → R2 待确认）。
  const res = learning.commitWithSignal({
    root, sessionId: 's-1', signalId: 'sig-b', detectedSignals: [SIGNAL('sig-b', 'unknown')],
    origin: 'auto', content: '项目B的某个稳定事实值得长期记录', category: 'fact', scope: 'workspace', workspace: '/proj/B',
  })
  assert.equal(res.status, 'pending')
  // 用户在项目 A 打开面板批准：候选须落回 B，而非被面板当前目录 A 覆盖。
  const approved = learning.approvePending({ root, pendingId: res.pendingId, workspace: '/proj/A' })
  assert.equal(approved.entry.scope, 'workspace')
  assert.ok(store.listAll(root, '/proj/B').some((e) => e.id === approved.entry.id), 'lands in original workspace B')
  assert.ok(!store.listAll(root, '/proj/A').some((e) => e.id === approved.entry.id), 'not misplaced into panel workspace A')
})

test('approvePending falls back to panel workspace when candidate has no cwd (C1/B3)', () => {
  const root = tmpRoot()
  const res = learning.commitWithSignal({
    root, sessionId: 's-1', signalId: 'sig-nocwd', detectedSignals: [SIGNAL('sig-nocwd', 'unknown')],
    origin: 'auto', content: '缺工作目录的待确认候选事实', category: 'fact', scope: 'workspace',
  })
  assert.equal(res.status, 'pending')
  const approved = learning.approvePending({ root, pendingId: res.pendingId, workspace: '/proj/A' })
  assert.ok(store.listAll(root, '/proj/A').some((e) => e.id === approved.entry.id), 'fallback to panel workspace')
})

test('unknown or expired signal ids are refused at the tool boundary', () => {
  const root = tmpRoot()
  assert.throws(() => learning.commitWithSignal({
    root, sessionId: 's-1', signalId: 'nope', detectedSignals: [], origin: 'auto', content: 'x', scope: 'global',
  }), (err) => err.code === 'no-signal')
  assert.equal(store.listAll(root).length, 0)
})

test('a consumed signal cannot be replayed (idempotency guard)', () => {
  const root = tmpRoot()
  write(root)
  assert.throws(() => write(root), (err) => err.code === 'signal-consumed')
  assert.equal(store.listAll(root).length, 1)
})

test('R2 candidates go to pending, never become active entries, and share the quota', () => {
  const root = tmpRoot()
  const result = write(root, { signalId: 'sig-r2', type: 'repeat_statement', content: '以后都用 pnpm' })
  assert.equal(result.status, 'pending')
  assert.equal(store.listAll(root).length, 0)
  const pending = learning.listPending({ root })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].status, 'pending')
  assert.equal(pending[0].risk, 'R2')
  assert.equal(readState(root).sessions['s-1'].quotaUsed, 1)
  // 批准后才生效
  const approved = learning.approvePending({ root, pendingId: result.pendingId })
  assert.ok(approved.entryId)
  assert.equal(store.listAll(root).length, 1)
  assert.equal(learning.listPending({ root }).length, 0)
  assert.equal(readState(root).sessions['s-1'].quotaUsed, 1, 'approval does not double count')
  const audit = learning.auditTail(root).map((e) => e.type)
  assert.ok(audit.includes('pending_created') && audit.includes('pending_approved'))
})

test('rejecting a pending candidate keeps it out of entries and out of the active list', () => {
  const root = tmpRoot()
  const result = write(root, { signalId: 'sig-r2b', type: 'repeat_statement', content: '以后都用 pnpm' })
  learning.rejectPending({ root, pendingId: result.pendingId })
  assert.equal(store.listAll(root).length, 0)
  const decided = learning.listPending({ root, status: 'rejected' })
  assert.equal(decided.length, 1)
  assert.ok(learning.auditTail(root).some((e) => e.type === 'pending_rejected'))
  assert.throws(() => learning.approvePending({ root, pendingId: result.pendingId }), (err) => err.code === 'invalid')
})

test('R3 refusals never persist candidate text in entries, pending, state or audit', () => {
  const root = tmpRoot()
  const secretText = 'api_key: abcd1234efgh'
  assert.throws(() => write(root, { content: secretText }), (err) => err.code === 'rejected-risk')
  assert.equal(store.listAll(root).length, 0)
  assert.equal(learning.listPending({ root }).length, 0)
  for (const file of [learning.learningPaths(root).state, learning.learningPaths(root).pending, learning.learningPaths(root).audit]) {
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(!text.includes('abcd1234efgh'), `${path.basename(file)} must not contain the candidate text`)
  }
  const state = readState(root)
  assert.equal(state.sessions['s-1'].quotaUsed, 0, 'refusals do not consume quota')
  assert.ok(state.sessions['s-1'].signals['sig-1'].consumedAt, 'refused signal is consumed to avoid reminder spam')
})

test('session quota blocks the 6th auto candidate by default and reports a fixed message', () => {
  const root = tmpRoot()
  for (let i = 1; i <= 5; i += 1) write(root, { signalId: `sig-${i}`, content: `偏好条目 ${i}` })
  assert.equal(store.listAll(root).length, 5)
  assert.throws(() => write(root, { signalId: 'sig-6', content: '偏好条目 6' }), (err) => err.code === 'autolimit' && /额度|quota/.test(err.message))
  assert.equal(store.listAll(root).length, 5)
})

test('quota 0 disables automatic writes while panel/manual paths stay unaffected', () => {
  const root = tmpRoot()
  assert.throws(() => write(root, { limit: 0 }), (err) => err.code === 'autolimit')
  assert.equal(store.listAll(root).length, 0)
})

test('origin=manual must bind an explicit-memory signal and does not consume quota', () => {
  const root = tmpRoot()
  assert.throws(() => write(root, {
    signalId: 'sig-correction', type: 'correction', origin: 'manual', content: '用户要求记住的内容',
  }), (err) => err.code === 'no-signal')
  const result = write(root, {
    signalId: 'sig-explicit', type: 'explicit_memory', origin: 'manual', content: '用户要求记住的内容',
  })
  assert.equal(result.status, 'active')
  assert.equal(readState(root).sessions['s-1'].quotaUsed, 0)
  // 显式 manual 之后，自动额度仍然完整
  const auto = write(root, { signalId: 'sig-auto', content: '主动沉淀的偏好' })
  assert.equal(auto.status, 'active')
  assert.equal(readState(root).sessions['s-1'].quotaUsed, 1)
})

test('markSignalsReminded only reports a signal once', () => {
  const root = tmpRoot()
  const signals = [SIGNAL('sig-a'), SIGNAL('sig-b')]
  const first = learning.markSignalsReminded({ root, sessionId: 's-1', signals })
  assert.deepEqual(first.reminded.map((s) => s.id), ['sig-a', 'sig-b'])
  const second = learning.markSignalsReminded({ root, sessionId: 's-1', signals })
  assert.deepEqual(second.reminded, [])
  // 已提醒的信号在有效期内仍可用于保存
  const result = write(root, { signalId: 'sig-a', detectedSignals: [] })
  assert.equal(result.status, 'active')
})

test('readQuota reflects persisted usage', () => {
  const root = tmpRoot()
  write(root)
  const quota = learning.readQuota({ root, sessionId: 's-1', limit: 5 })
  assert.deepEqual(quota, { used: 1, limit: 5, remaining: 4, blocked: false })
  assert.equal(learning.readQuota({ root, sessionId: 'nobody' }).used, 0)
})

test('stale session learning state is pruned by TTL', () => {
  const root = tmpRoot()
  learning.markSignalsReminded({ root, sessionId: 's-old', signals: [SIGNAL('sig-old')] })
  const state = readState(root)
  state.sessions['s-old'].lastSeenAt = new Date(Date.now() - learning.STATE_TTL_MS - 1000).toISOString()
  fs.writeFileSync(learning.learningPaths(root).state, JSON.stringify(state), 'utf8')
  learning.markSignalsReminded({ root, sessionId: 's-new', signals: [SIGNAL('sig-new')] })
  const pruned = readState(root)
  assert.equal(pruned.sessions['s-old'], undefined)
  assert.ok(pruned.sessions['s-new'])
})

test('corrupt state/pending files degrade to empty state instead of throwing', () => {
  const root = tmpRoot()
  fs.writeFileSync(learning.learningPaths(root).state, '{not json', 'utf8')
  fs.writeFileSync(learning.learningPaths(root).pending, '[', 'utf8')
  assert.deepEqual(learning.listPending({ root }), [])
  assert.equal(learning.readQuota({ root, sessionId: 's' }).used, 0)
  const result = write(root, { signalId: 'sig-corrupt' })
  assert.equal(result.status, 'active')
})

test('suspected conflict becomes a pending candidate instead of overwriting the old entry', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '构建工具统一使用 pnpm，不要用 npm', category: 'preference', scope: 'global', origin: 'manual' })
  const existing = store.listAll(root)
  const result = write(root, {
    signalId: 'sig-conflict',
    content: '构建工具统一使用 pnpm 不要用 npm',
    existing,
    category: 'preference',
  })
  assert.equal(result.status, 'pending')
  assert.equal(store.listAll(root).length, 1, 'old entry untouched')
  assert.equal(learning.listPending({ root })[0].reason, 'suspected-conflict')
})

test('appendAudit never blocks the write path when the audit file is unwritable', () => {
  const root = tmpRoot()
  fs.rmSync(learning.learningPaths(root).dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'learning', 'audit.jsonl'), { recursive: true })
  // 目录占据审计文件路径：append 失败必须被吞掉，条目照常落盘。
  const result = write(root, { signalId: 'sig-audit' })
  assert.equal(result.status, 'active')
  assert.equal(store.listAll(root).length, 1)
})
