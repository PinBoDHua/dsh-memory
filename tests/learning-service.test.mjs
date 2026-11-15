/**
 * dsh-memory v0.28.0 服务层学习闸门单测：信号驱动保存、R3/R2/R1 分流、
 * 面板学习分区数据、学习提醒一次性与 status/导出契约。
 * 运行 Run: node --test tests/learning-service.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

const SID = 'session-svc'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-learn-svc-'))
  return { root, service: createMemoryService({ root }) }
}

const signal = (id, type = 'correction') => ({ id, type, at: Date.now() })

function saveVia(service, { signalId = 'sig-1', type = 'correction', origin = 'auto', content = '以后回复用中文', category = 'preference', scope = 'global', detected } = {}) {
  return service.save({
    content,
    category,
    scope,
    origin,
    learning: { sessionId: SID, signalId, detectedSignals: detected ?? [signal(signalId, type)] },
  })
}

test('service gate: R1 auto save is active and a direct correction preference gets the constraint tag', () => {
  const { service } = tmpService()
  const result = saveVia(service, { content: '构建统一用 pnpm，不要用 npm' })
  assert.equal(result.status, 'active')
  assert.equal(result.risk, 'R1')
  assert.equal(result.entry.origin, 'auto')
  assert.ok(result.entry.tags.includes('constraint'), 'direct correction auto-save must carry the constraint tag')
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('service gate: missing or unknown signal ids are refused before any write', () => {
  const { service } = tmpService()
  assert.throws(() => service.save({
    content: '任意内容',
    scope: 'global',
    origin: 'auto',
    learning: { sessionId: SID, signalId: 'no-such-signal', detectedSignals: [] },
  }), (err) => err.code === 'no-signal')
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('service gate: origin=manual requires an explicit-memory signal', () => {
  const { service } = tmpService()
  assert.throws(() => saveVia(service, { origin: 'manual', content: '用户要求记住的事', type: 'correction' }),
    (err) => err.code === 'no-signal')
  const ok = saveVia(service, { origin: 'manual', content: '用户要求记住的事', type: 'explicit_memory', signalId: 'sig-explicit' })
  assert.equal(ok.status, 'active')
})

test('service gate: sensitive auto inference is refused without persisting candidate text', () => {
  const { service } = tmpService()
  assert.throws(() => saveVia(service, { content: '用户有焦虑症', category: 'fact' }),
    (err) => err.code === 'rejected-risk')
  const root = service.status().root
  const learningDir = path.join(root, 'learning')
  if (fs.existsSync(learningDir)) {
    for (const name of fs.readdirSync(learningDir)) {
      const text = fs.readFileSync(path.join(learningDir, name), 'utf8')
      assert.ok(!text.includes('焦虑'), `${name} must not contain refused candidate text`)
    }
  }
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('service gate: R2 candidate becomes pending, is listed by learningView and only applies after approval', () => {
  const { service } = tmpService()
  const pendingResult = saveVia(service, { signalId: 'sig-repeat', type: 'repeat_statement', content: '以后都用 pnpm' })
  assert.equal(pendingResult.status, 'pending')
  assert.equal(service.list({ scope: 'global' }).length, 0, 'pending candidates are never active entries')
  const view = service.learningView({ workspace: undefined })
  assert.equal(view.pendingCount, 1)
  assert.equal(view.pending[0].status, 'pending')
  assert.ok(Array.isArray(view.audit) && view.audit.some((event) => event.type === 'pending_created'))
  assert.equal(service.status().learning.pendingCount, 1)
  const approved = service.approvePending({ pendingId: pendingResult.pendingId })
  assert.ok(approved.entryId)
  assert.equal(service.list({ scope: 'global' }).length, 1)
  assert.equal(service.learningView({}).pendingCount, 0)
})

test('service gate: rejection keeps the candidate out of memory and can only be decided once', () => {
  const { service } = tmpService()
  const pendingResult = saveVia(service, { signalId: 'sig-repeat2', type: 'repeat_statement', content: '以后都用 yarn' })
  service.rejectPending({ pendingId: pendingResult.pendingId })
  assert.equal(service.list({ scope: 'global' }).length, 0)
  assert.throws(() => service.approvePending({ pendingId: pendingResult.pendingId }), (err) => err.code === 'invalid')
  assert.throws(() => service.approvePending({ pendingId: 'nope' }), (err) => err.code === 'not-found')
})

test('service gate: settings quota (autoLearn.maxWritesPerSession) is enforced live', () => {
  const { service } = tmpService()
  service.updateSettings({ autoLearn: { maxWritesPerSession: 1 } })
  saveVia(service, { signalId: 'sig-a', content: '第一条自动沉淀' })
  assert.throws(() => saveVia(service, { signalId: 'sig-b', content: '第二条自动沉淀' }), (err) => err.code === 'autolimit')
  // 用户显式 manual 不受自动额度限制（但需要显式记忆信号）。
  const manual = saveVia(service, { signalId: 'sig-c', type: 'explicit_memory', origin: 'manual', content: '用户明确要求记住的内容' })
  assert.equal(manual.status, 'active')
  service.updateSettings({ autoLearn: { maxWritesPerSession: 0 } })
  assert.throws(() => saveVia(service, { signalId: 'sig-d', content: '第三条自动沉淀' }), (err) => err.code === 'autolimit')
})

test('service gate: signal-driven saves must not carry pinned/expires/supersedes', () => {
  const { service } = tmpService()
  assert.throws(() => service.save({
    content: '禁止的显式字段',
    scope: 'global',
    origin: 'auto',
    pinned: true,
    explicitFields: ['content', 'scope', 'origin', 'pinned'],
    learning: { sessionId: SID, signalId: 'sig-pin', detectedSignals: [signal('sig-pin')] },
  }), (err) => err.code === 'invalid')
})

test('service gate: panel path (no learning option) stays a direct user-authorized save', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '面板手动添加', scope: 'global', origin: 'manual' })
  assert.ok(entry.id)
  const updated = service.save({ content: '面板手动添加', scope: 'global', origin: 'manual' })
  assert.equal(updated.deduplicated, true)
})

test('learningReminder: one-shot per signal and includes quota hint when exhausted', () => {
  const { service } = tmpService()
  const signals = [signal('sig-remind')]
  const first = service.learningReminder({ sessionId: SID, signals, limit: 5 })
  assert.ok(first.includes('sig-remind'))
  assert.equal(service.learningReminder({ sessionId: SID, signals, limit: 5 }), '', 'same signal must not remind twice')
  assert.equal(service.learningReminder({ sessionId: SID, signals: [], limit: 5 }), '')
})

test('export/backup payload carries learning state additively', () => {
  const { service } = tmpService()
  const pendingResult = saveVia(service, { signalId: 'sig-export', type: 'repeat_statement', content: '以后都用 pnpm' })
  assert.equal(pendingResult.status, 'pending')
  const doc = service.export()
  assert.ok(doc.learning && Array.isArray(doc.learning.pending) && Array.isArray(doc.learning.audit))
  assert.equal(doc.learning.pending[0].status, 'pending')
  const backup = service.backup()
  const file = path.join(service.status().root, 'backups', backup.file)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(saved.learning && saved.learning.pending.length === 1)
})

test('migration v2 -> v3 creates the learning directory and keeps entries byte-identical', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-learn-mig-'))
  const first = createMemoryService({ root })
  first.save({ content: '迁移前的条目', scope: 'global' })
  const file = path.join(root, 'global', store.listScope(root, 'global', undefined)[0].id + '.md')
  const before = fs.readFileSync(file, 'utf8')
  const metaFile = path.join(root, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  meta.schemaVersion = 2
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8')
  const migrated = createMemoryService({ root })
  assert.equal(migrated.status().schemaVersion, 3)
  assert.ok(fs.existsSync(path.join(root, 'learning', 'state.json')))
  assert.ok(fs.existsSync(path.join(root, 'learning', 'pending.json')))
  assert.ok(fs.existsSync(path.join(root, 'learning', 'audit.jsonl')))
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'entry files are never rewritten by migration')
  assert.equal(migrated.list({ scope: 'global' })[0].content, '迁移前的条目')
})
