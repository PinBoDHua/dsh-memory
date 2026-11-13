/**
 * dsh-memory 0.14.0：注入召回预览（selectInjection 纯函数＋service.recallPreview＋GET /recall-preview）。
 * renderSection 重构等价性由 store.test.mjs 既有行为测试守护。
 * 运行 Run: node --test tests/preview.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { selectInjection } from '../lib/render.js'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-preview-'))
}

// ---------- render：selectInjection 纯函数 ----------

test('selectInjection fills budget by priority, counts omitted and usedChars', () => {
  const entries = [
    { id: 'm-fact', scope: 'workspace', category: 'fact', content: '事实', updated: '2026-01-03' },
    { id: 'm-pref', scope: 'global', category: 'preference', content: '偏好', updated: '2026-01-01' },
  ]
  const all = selectInjection(entries, { budgetChars: 6000 })
  assert.equal(all.selected.length, 2)
  assert.equal(all.omitted, 0)
  assert.equal(all.selected[0].id, 'm-pref', 'preference first')
  assert.ok(all.usedChars > 0)
  const prefLine = '- [preference] 偏好 (id: m-pref)'
  const tight = selectInjection(entries, { budgetChars: prefLine.length + 1 })
  assert.equal(tight.selected.length, 1)
  assert.equal(tight.selected[0].id, 'm-pref')
  assert.equal(tight.omitted, 1)
  assert.equal(tight.usedChars, prefLine.length + 1)
})

test('selectInjection excludes hidden entries; empty input yields zeros', () => {
  const entries = [
    { id: 'm-a', scope: 'global', category: 'fact', content: '活跃', updated: '2026-01-01' },
    { id: 'm-b', scope: 'global', category: 'fact', content: '归档', updated: '2026-01-02', archived: true },
  ]
  const res = selectInjection(entries, { budgetChars: 6000 })
  assert.equal(res.selected.length, 1)
  assert.equal(res.selected[0].id, 'm-a')
  assert.deepEqual(selectInjection([], {}), { selected: [], omitted: 0, usedChars: 0 })
})

test('selectInjection budget 0 omits all active entries', () => {
  const entries = [{ id: 'm-a', scope: 'global', category: 'fact', content: 'x', updated: '2026-01-01' }]
  const res = selectInjection(entries, { budgetChars: 0 })
  assert.equal(res.selected.length, 0)
  assert.equal(res.omitted, 1)
  assert.equal(res.usedChars, 0)
})

// ---------- service：recallPreview ----------

test('service.recallPreview reports injected/omitted/usedChars/budget and entries', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '预览偏好', scope: 'global', category: 'preference', origin: 'manual' })
  service.save({ content: '预览事实', scope: 'global', category: 'fact', origin: 'manual' })
  const p = service.recallPreview({})
  assert.equal(p.autoInject, true)
  assert.equal(p.budgetChars, 6000)
  assert.equal(p.injected, 2)
  assert.equal(p.omitted, 0)
  assert.ok(p.usedChars > 0)
  assert.equal(p.entries.length, 2)
  assert.equal(p.entries[0].category, 'preference')
  assert.ok(p.entries.every((e) => typeof e.id === 'string' && typeof e.content === 'string' && typeof e.pinned === 'boolean'))
})

test('service.recallPreview reflects budget overlay (0 omits all)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '预览偏好甲', scope: 'global', category: 'preference', origin: 'manual' })
  service.save({ content: '预览事实乙', scope: 'global', category: 'fact', origin: 'manual' })
  service.updateSettings({ injectionBudgetChars: 0 })
  const p = service.recallPreview({})
  assert.equal(p.budgetChars, 0)
  assert.equal(p.injected, 0)
  assert.equal(p.omitted, 2)
  assert.deepEqual(p.entries, [])
})

// ---------- routes：GET /recall-preview ----------

test('GET /recall-preview returns preview doc from loopback', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '路由预览', scope: 'global', category: 'fact', origin: 'manual' })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.14.0-test' })
  const req = {
    method: 'GET',
    url: '/plugins/dsh-memory/recall-preview',
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers['recall-preview'](req, res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.injected, 1)
  assert.equal(doc.budgetChars, 6000)
  assert.ok(Array.isArray(doc.entries))
})
