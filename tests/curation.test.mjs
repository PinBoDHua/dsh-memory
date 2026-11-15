/**
 * dsh-memory v0.29.0 存量治理单测：确定性重复组、合并（dryRun/应用/审计/可恢复）、
 * 批量归档/恢复、分层召回预览字段、回环路由契约。
 * 运行 Run: node --test tests/curation.test.mjs
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
const WS = 'D:\\proj\\curation'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-curation-'))
  return { root, service: createMemoryService({ root }) }
}

function writeDup(root, { id, content = '重复条目正文', tags = [], origin = 'manual', scope = 'global', created = '2026-01-01T00:00:00.000Z', cwd }) {
  store.writeEntry(root, {
    id,
    category: 'fact',
    scope,
    tags,
    origin,
    created,
    updated: created,
    source: '',
    content,
  }, cwd)
}

function fakeReq({ method = 'GET', url = '/plugins/dsh-memory/duplicates', token = TOKEN, body = null, remote = '127.0.0.1' } = {}) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:50562', ...(token === null ? {} : { 'x-rpc-key': token }) },
    socket: { remoteAddress: remote },
  }
  if (body !== null) {
    req[Symbol.asyncIterator] = async function* iterate() {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  return req
}

function fakeRes() {
  const res = { statusCode: null, body: '' }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (payload) => { res.body = payload ?? '' }
  res.json = () => JSON.parse(res.body)
  return res
}

async function call(handler, req) {
  const res = fakeRes()
  await handler(req, res)
  return res
}

test('duplicateGroups groups exact same-content entries per scope and picks the earliest keeper', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-dup-b', content: '重复正文', created: '2026-01-02T00:00:00.000Z' })
  writeDup(root, { id: 'm-dup-a', content: '重复正文', created: '2026-01-01T00:00:00.000Z' })
  const groups = service.duplicateGroups({ scope: 'all' })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].mergeable, true)
  assert.equal(groups[0].keeperId, 'm-dup-a', 'earliest created is the keeper')
  assert.deepEqual(groups[0].entries.map((e) => e.id), ['m-dup-a', 'm-dup-b'])
  assert.match(groups[0].key, /^dup-[a-f0-9]{16}$/)
})

test('metadata-different duplicates are reported but never merged automatically', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-x1', content: '同文不同标', tags: ['a'] })
  writeDup(root, { id: 'm-x2', content: '同文不同标', tags: ['b'] })
  const groups = service.duplicateGroups({ scope: 'all' })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].mergeable, false)
  assert.deepEqual(groups[0].metadataMismatch, ['m-x1', 'm-x2'])
  const plan = service.mergeDuplicates({ scope: 'all', dryRun: true })
  assert.equal(plan.mergeable, 0)
  assert.equal(plan.skipped, 1)
  const applied = service.mergeDuplicates({ scope: 'all' })
  assert.equal(applied.archived.length, 0)
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.content === '同文不同标').length, 2, 'nothing archived')
})

test('dryRun plans a deterministic merge without touching the disk', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-d1', content: '合并计划正文' })
  writeDup(root, { id: 'm-d2', content: '合并计划正文' })
  const before = service.list({ scope: 'global' }).map((e) => ({ id: e.id, archived: e.archived === true }))
  const plan = service.mergeDuplicates({ scope: 'all', dryRun: true })
  assert.equal(plan.groups, 1)
  assert.equal(plan.mergeable, 1)
  assert.equal(plan.wouldArchive, 1)
  assert.deepEqual(plan.archived, [])
  assert.deepEqual(service.list({ scope: 'global' }).map((e) => ({ id: e.id, archived: e.archived === true })), before)
})

test('merge keeps the keeper, archives the duplicate, writes an audit event, and restore is byte-identical', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-k', content: '可合并正文' })
  writeDup(root, { id: 'm-v', content: '可合并正文' })
  const variantFile = path.join(root, 'global', 'm-v.md')
  const before = fs.readFileSync(variantFile, 'utf8')
  const result = service.mergeDuplicates({ scope: 'all' })
  assert.deepEqual(result.archived, ['m-v'])
  assert.equal(result.failed.length, 0)
  const files = service.list({ scope: 'global' })
  const keeper = files.find((e) => e.id === 'm-k')
  const variant = files.find((e) => e.id === 'm-v')
  assert.ok(keeper && keeper.archived !== true, 'keeper stays active')
  assert.equal(variant.archived, true, 'duplicate is archived (reversible)')
  const audit = learning.auditTail(root).filter((e) => e.type === 'duplicates_merged')
  assert.equal(audit.length, 1)
  assert.equal(audit[0].keeperId, 'm-k')
  assert.deepEqual(audit[0].archivedIds, ['m-v'])
  // 归档→恢复逐字节相同（operational 字段不刷新 updated）。
  service.archiveMany({ ids: ['m-v'], archived: false })
  assert.equal(fs.readFileSync(variantFile, 'utf8'), before, 'restore reproduces the original file bytes')
  assert.equal(service.duplicateGroups({ scope: 'all' }).length, 1, 'after restore the exact duplicate set is back')
})

test('merge can be limited to selected group keys', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-a1', content: '组一正文' })
  writeDup(root, { id: 'm-a2', content: '组一正文' })
  writeDup(root, { id: 'm-b1', content: '组二正文' })
  writeDup(root, { id: 'm-b2', content: '组二正文' })
  const groups = service.duplicateGroups({ scope: 'all' })
  assert.equal(groups.length, 2)
  const only = groups.find((g) => g.content === '组二正文').key
  const result = service.mergeDuplicates({ scope: 'all', keys: [only] })
  assert.equal(result.archived.length, 1)
  const active = service.list({ scope: 'global' }).filter((e) => e.archived !== true)
  assert.equal(active.filter((e) => e.content === '组一正文').length, 2)
  assert.equal(active.filter((e) => e.content === '组二正文').length, 1)
})

test('workspace scope isolation: duplicates in different scopes are not grouped together', () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-g', content: '跨作用域同文' })
  writeDup(root, { id: 'm-w', content: '跨作用域同文', scope: 'workspace', cwd: WS })
  assert.equal(service.duplicateGroups({ scope: 'all', workspace: WS }).length, 0)
  writeDup(root, { id: 'm-w2', content: '跨作用域同文', scope: 'workspace', cwd: WS })
  const groups = service.duplicateGroups({ scope: 'workspace', workspace: WS })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].keeperId, 'm-w')
})

test('archiveMany archives/restores a batch with per-id results and audit', () => {
  const { root, service } = tmpService()
  const a = store.saveEntry(root, { content: '批量归档甲', scope: 'global' }).entry
  const b = store.saveEntry(root, { content: '批量归档乙', scope: 'global' }).entry
  const files = new Map([[a.id, path.join(root, 'global', `${a.id}.md`)], [b.id, path.join(root, 'global', `${b.id}.md`)]])
  const before = new Map([...files].map(([id, file]) => [id, fs.readFileSync(file, 'utf8')]))
  const archived = service.archiveMany({ ids: [a.id, b.id, '../evil', 'm-missing'] })
  assert.deepEqual(archived.archived.sort(), [a.id, b.id].sort())
  assert.equal(archived.failed.length, 2)
  assert.ok(archived.failed.every((f) => f.code === 'invalid' || f.code === 'not-found'))
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.archived === true).length, 2)
  const restored = service.archiveMany({ ids: [a.id, b.id], archived: false })
  assert.deepEqual(restored.restored.sort(), [a.id, b.id].sort())
  for (const [id, file] of files) {
    assert.equal(fs.readFileSync(file, 'utf8'), before.get(id), `${id} restored byte-identically`)
  }
  const auditTypes = learning.auditTail(root).map((e) => e.type)
  assert.ok(auditTypes.includes('entries_archived') && auditTypes.includes('entries_restored'))
  assert.throws(() => service.archiveMany({ ids: [] }), (err) => err.code === 'invalid')
})

test('recallPreview exposes layered resident/index counts and omitted reasons', () => {
  const { root, service } = tmpService()
  store.saveEntry(root, { content: '常驻偏好', scope: 'global', category: 'preference', pinned: true })
  store.saveEntry(root, { content: '约束偏好', scope: 'global', category: 'preference', tags: ['constraint'] })
  store.saveEntry(root, { content: '普通事实', scope: 'global', category: 'fact' })
  const p = service.recallPreview({})
  assert.equal(p.residentCount, 2)
  assert.equal(p.indexCount, 1)
  assert.equal(p.injected, 3)
  assert.deepEqual(p.entries.filter((e) => e.layer === 'resident').map((e) => e.content), ['常驻偏好', '约束偏好'])
  assert.ok(p.entries.find((e) => e.content === '约束偏好').constraint === true)
  service.updateSettings({ injectionBudgetChars: 0 })
  const zero = service.recallPreview({})
  assert.equal(zero.injected, 0)
  assert.equal(zero.omitted, 3)
  assert.equal(zero.omittedResident, 2)
  assert.equal(zero.omittedIndex, 1)
})

test('routes expose duplicates, dry-run merge and archive batch with token/loopback rules', async () => {
  const { root, service } = tmpService()
  writeDup(root, { id: 'm-r1', content: '路由重复正文' })
  writeDup(root, { id: 'm-r2', content: '路由重复正文' })
  const handlers = createHandlers({ service, token: TOKEN, version: '0.29.0-test' })

  const list = await call(handlers.duplicates, fakeReq())
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().groups.length, 1)
  assert.equal(list.json().groups[0].mergeable, true)

  const denied = await call(handlers['duplicates/merge'], fakeReq({ method: 'POST', token: null, body: {} }))
  assert.equal(denied.statusCode, 403)

  const plan = await call(handlers['duplicates/merge'], fakeReq({ method: 'POST', body: { dryRun: true } }))
  assert.equal(plan.statusCode, 200)
  assert.equal(plan.json().result.dryRun, true)
  assert.equal(plan.json().result.wouldArchive, 1)
  assert.equal(service.list({ scope: 'global' }).filter((e) => e.archived === true).length, 0, 'dryRun writes nothing')

  const badArchive = await call(handlers.archive, fakeReq({ method: 'POST', body: {} }))
  assert.equal(badArchive.statusCode, 400)
  assert.equal(badArchive.json().code, 'invalid')

  const applied = await call(handlers['duplicates/merge'], fakeReq({ method: 'POST', body: {} }))
  assert.equal(applied.statusCode, 200)
  assert.equal(applied.json().result.archived.length, 1)
})
