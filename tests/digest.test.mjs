/**
 * dsh-memory v0.31.0（I4）单测：
 * 疑似冲突候选（只进 pending、保留双方来源、不自动覆盖）、待确认提醒只变一次、
 * 确定性周报（每周首次、无事件不注入、只含计数、游标防重复、可关）与批量审批/摘要存档。
 * 运行 Run: node --test tests/digest.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as learning from '../lib/learning.js'
import { createHandlers } from '../lib/routes.js'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

const TOKEN = 't-0123456789abcdef'
const SID = 'session-i4'
const NOW = Date.parse('2026-11-18T10:00:00.000Z') // 2026-11-18 周三
const WEEK_LATER = NOW + 8 * 86400000

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-digest-'))
  return { root, service: createMemoryService({ root }) }
}

function sig(id, type = 'correction') {
  return { id, type, at: NOW }
}

function saveAuto(service, { content, signalId, type = 'correction' }) {
  return service.save({
    content,
    category: 'preference',
    scope: 'global',
    origin: 'auto',
    learning: { sessionId: SID, signalId, detectedSignals: [sig(signalId, type)], now: NOW },
  })
}

test('suspected conflict becomes a pending candidate with conflict ids, never overwrites the old entry', () => {
  const { root, service } = tmpService()
  const original = store.saveEntry(root, { content: '构建工具统一使用 pnpm，不要用 npm', category: 'preference', scope: 'global', origin: 'manual' }).entry
  const result = saveAuto(service, { content: '构建工具统一使用 pnpm 不要用 npm', signalId: 'sig-conflict' })
  assert.equal(result.status, 'pending')
  assert.ok(result.conflictWith.includes(original.id), JSON.stringify(result.conflictWith))
  const candidate = learning.listPending({ root }).find((item) => item.id === result.pendingId)
  assert.ok(candidate.conflictWith.includes(original.id), 'pending item keeps the conflicting entry ids')
  const after = store.findEntry(root, original.id, undefined)
  assert.equal(after.content, original.content, 'old entry untouched')
  assert.equal(after.superseded_by, undefined, 'no automatic supersede')
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.archived !== true).length, 1, 'candidate is not active')
})

test('pending notice appears only when the candidate count changes and never includes candidate content', () => {
  const { root, service } = tmpService()
  const first = saveAuto(service, { content: '待确认候选甲', signalId: 'sig-a', type: 'repeat_statement' })
  assert.equal(first.status, 'pending')
  const notice = service.pendingNotice({ sessionId: SID })
  assert.ok(notice && /1 条待确认/.test(notice.text))
  assert.ok(!notice.text.includes('待确认候选甲'), 'notice must not carry candidate content')
  assert.equal(service.pendingNotice({ sessionId: SID }), null, 'same count does not repeat the notice')
  service.approvePending({ pendingId: first.pendingId })
  assert.equal(service.pendingNotice({ sessionId: SID }), null, 'count -> 0 is silent')
  const second = saveAuto(service, { content: '待确认候选乙', signalId: 'sig-b', type: 'repeat_statement' })
  const notice2 = service.pendingNotice({ sessionId: SID })
  assert.ok(notice2 && /1 条待确认/.test(notice2.text), 'a new increase notifies again')
  assert.ok(second.status === 'pending')
})

test('weekly digest aggregates audit events once per week, omits empty weeks and can be disabled', () => {
  const { root, service } = tmpService()
  const realNow = Date.now()
  assert.equal(service.maybeWeeklyDigest({ now: realNow }), null, 'no events -> no digest')
  saveAuto(service, { content: '周报自动写入条目', signalId: 'sig-week' })
  const pending = saveAuto(service, { content: '周报待确认候选', signalId: 'sig-week-2', type: 'repeat_statement' })
  service.approvePending({ pendingId: pending.pendingId })
  const digest = service.maybeWeeklyDigest({ now: realNow })
  assert.ok(digest && digest.record, 'digest generated from audit events')
  assert.ok(/周报/.test(digest.text) && /自动写入 1/.test(digest.text), digest.text)
  assert.ok(!digest.text.includes('周报自动写入条目'), 'digest only contains counts, no entry content')
  assert.equal(service.maybeWeeklyDigest({ now: realNow }), null, 'at most once per week')
  // 下一周 + 新事件 → 再次生成；存档保留两期。
  saveAuto(service, { content: '跨周自动写入条目', signalId: 'sig-next-week' })
  const nextWeek = service.maybeWeeklyDigest({ now: realNow + 8 * 86400000 })
  assert.ok(nextWeek && nextWeek.record.weekKey !== digest.record.weekKey)
  const view = service.digestView()
  assert.ok(view.archive.length >= 2, JSON.stringify(view.archive.map((d) => d.weekKey)))
  assert.ok(view.archive.every((item) => typeof item.text === 'string' && !item.text.includes('自动写入条目')), 'archive contains counts only')
  service.updateSettings({ digest: { enabled: false } })
  saveAuto(service, { content: '关闭后自动写入条目', signalId: 'sig-off' })
  assert.equal(service.maybeWeeklyDigest({ now: realNow + 16 * 86400000 }), null, 'digest disabled by settings')
})

test('batch approval endpoint approves multiple candidates and reports failures', async () => {
  const { root, service } = tmpService()
  const a = saveAuto(service, { content: '批量候选甲', signalId: 'sig-ma', type: 'repeat_statement' })
  const b = saveAuto(service, { content: '批量候选乙', signalId: 'sig-mb', type: 'repeat_statement' })
  const handlers = createHandlers({ service, token: TOKEN, version: '0.31.0-test' })
  const post = (body) => ({
    method: 'POST',
    headers: { host: '127.0.0.1:50562', 'x-rpc-key': TOKEN },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  })
  const res = await (async () => {
    const res = { statusCode: null, body: '' }
    res.writeHead = (s) => { res.statusCode = s }
    res.end = (payload) => { res.body = payload ?? '' }
    res.json = () => JSON.parse(res.body)
    await handlers['learning/approve-many'](post({ pendingIds: [a.pendingId, b.pendingId, 'p-missing'] }), res)
    return res
  })()
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().result.approved.length, 2)
  assert.equal(res.json().result.failed.length, 1)
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.archived !== true).length, 2)
  const digest = await (async () => {
    const res = { statusCode: null, body: '' }
    res.writeHead = (s) => { res.statusCode = s }
    res.end = (payload) => { res.body = payload ?? '' }
    res.json = () => JSON.parse(res.body)
    await handlers.digest({ method: 'GET', url: '/plugins/dsh-memory/digest', headers: { host: '127.0.0.1:50562' }, socket: { remoteAddress: '127.0.0.1' } }, res)
    return res
  })()
  assert.equal(digest.statusCode, 200)
  assert.ok(Array.isArray(digest.json().archive))
  assert.ok(typeof digest.json().enabled === 'boolean')
})
