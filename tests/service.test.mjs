/**
 * 缝 1：MemoryService 公共 API —— 工具与 UI 共享的操作层。
 * 运行 Run: node --test tests/service.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-svc-'))
  return { root, service: createMemoryService({ root }) }
}

test('save makes an entry retrievable via list', () => {
  const { service } = tmpService()
  const { entry, deduplicated } = service.save({
    content: '用户偏好中文回复',
    category: 'preference',
    scope: 'global',
    tags: ['语言'],
  })
  assert.equal(deduplicated, false)
  assert.match(entry.id, /^m-/)
  const listed = service.list({ scope: 'global' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].content, '用户偏好中文回复')
  assert.equal(listed[0].category, 'preference')
  assert.deepEqual(listed[0].tags, ['语言'])
})

test('workspace entries are isolated and reported by workspaces()', () => {
  const { service } = tmpService()
  service.save({ content: 'alpha 约定', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  service.save({ content: 'beta 约定', scope: 'workspace', workspace: 'D:\\proj\\beta' })
  service.save({ content: '全局偏好', scope: 'global' })
  const alphaEntries = service.list({ scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  assert.equal(alphaEntries.length, 1)
  assert.equal(alphaEntries[0].content, 'alpha 约定')
  const workspaces = service.workspaces()
  assert.equal(workspaces.length, 2)
  const alpha = workspaces.find((w) => typeof w.cwd === 'string' && w.cwd.toLowerCase() === 'd:\\proj\\alpha')
  assert.ok(alpha, 'alpha workspace should be listed with its cwd')
  assert.equal(alpha.count, 1)
  assert.match(alpha.key, /^[a-f0-9]{16}$/)
})

test('save rejects credentials with code secret and stores nothing', () => {
  const { service } = tmpService()
  assert.throws(
    () => service.save({ content: 'password = hunter2secret', scope: 'global' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('update supersedes in place; unknown id fails with not-found', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '旧事实', scope: 'global' })
  const updated = service.update({ id: entry.id, content: '新事实', category: 'decision' })
  assert.equal(updated.id, entry.id)
  assert.equal(updated.content, '新事实')
  assert.equal(updated.category, 'decision')
  assert.equal(service.list({ scope: 'global' }).length, 1)
  assert.equal(service.list({ scope: 'global' })[0].content, '新事实')
  assert.throws(
    () => service.update({ id: 'm-nonexistent-000000', content: 'x' }),
    (err) => err.code === 'not-found',
  )
})

test('forget deletes permanently; unknown id fails with not-found', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '将被忘记', scope: 'global' })
  const result = service.forget({ id: entry.id })
  assert.deepEqual(result, { id: entry.id, deleted: true })
  assert.equal(service.list({ scope: 'global' }).length, 0)
  assert.throws(
    () => service.forget({ id: entry.id }),
    (err) => err.code === 'not-found',
  )
})

test('search filters by query, category, scope and limit', () => {
  const { service } = tmpService()
  service.save({ content: '构建使用 pnpm install', scope: 'workspace', workspace: 'D:\\proj\\alpha', tags: ['build'] })
  service.save({ content: '测试使用 vitest', scope: 'workspace', workspace: 'D:\\proj\\alpha', category: 'decision' })
  service.save({ content: '用户喜欢深色主题', scope: 'global', category: 'preference' })
  const ws = 'D:\\proj\\alpha'
  assert.equal(service.search({ query: 'PNPM 构建', workspace: ws }).length, 1)
  assert.equal(service.search({ query: 'pnpm vitest', workspace: ws }).length, 0)
  assert.equal(service.search({ query: '', category: 'preference', workspace: ws }).length, 1)
  assert.equal(service.search({ query: '', scope: 'workspace', workspace: ws }).length, 2)
  assert.equal(service.search({ query: '', workspace: ws, limit: 1 }).length, 1)
  assert.equal(service.search({ query: 'build', workspace: ws }).length, 1)
  assert.equal(service.search({ query: '', workspace: ws }).length, 3)
})

test('save deduplicates identical content within the same scope', () => {
  const { service } = tmpService()
  const first = service.save({ content: 'Project uses pnpm', scope: 'global' })
  const second = service.save({ content: '  project   USES   pnpm  ', scope: 'global' })
  assert.equal(first.deduplicated, false)
  assert.equal(second.deduplicated, true)
  assert.equal(second.entry.id, first.entry.id)
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('save validates input with coded errors', () => {
  const { service } = tmpService()
  assert.throws(() => service.save({ content: '   ', scope: 'global' }), (err) => err.code === 'invalid')
  assert.throws(() => service.save({ content: 'x', category: 'bogus', scope: 'global' }), (err) => err.code === 'invalid')
  assert.throws(() => service.save({ content: 'x', scope: 'workspace' }), (err) => err.code === 'no-workspace')
  assert.equal(service.list({ scope: 'all' }).length, 0)
})

test('update rejects credentials with code secret and keeps the old content', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '正常内容', scope: 'global' })
  assert.throws(
    () => service.update({ id: entry.id, content: 'api_key: abcd1234efgh' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' })[0].content, '正常内容')
})

test('status reports root and counts', () => {
  const { root, service } = tmpService()
  service.save({ content: '全局一', scope: 'global' })
  service.save({ content: '全局二', scope: 'global' })
  service.save({ content: '工作区一', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  const status = service.status()
  assert.equal(status.root, root)
  assert.deepEqual(status.counts, { global: 2, workspaces: 1 })
})

const WS = 'D:\\proj\\alpha'

test('update with scope moves between global and workspace', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '可移动', scope: 'global' })
  const moved = service.update({ id: entry.id, scope: 'workspace', workspace: WS })
  assert.equal(moved.scope, 'workspace')
  assert.equal(service.list({ scope: 'global' }).length, 0)
  assert.equal(service.list({ scope: 'workspace', workspace: WS })[0].id, entry.id)
  const back = service.update({ id: entry.id, scope: 'global', workspace: WS })
  assert.equal(back.scope, 'global')
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).length, 0)
})

test('update scope validation: invalid scope, missing workspace, duplicate target', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '甲', scope: 'global' })
  assert.throws(() => service.update({ id: entry.id, scope: 'bogus' }), (err) => err.code === 'invalid')
  assert.throws(() => service.update({ id: entry.id, scope: 'workspace' }), (err) => err.code === 'no-workspace')
  service.save({ content: '甲', scope: 'workspace', workspace: WS })
  assert.throws(() => service.update({ id: entry.id, scope: 'workspace', workspace: WS }), (err) => err.code === 'duplicate')
  assert.equal(service.list({ scope: 'global' })[0].id, entry.id)
})

test('update same scope keeps working and can patch content while moving', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '旧', scope: 'global' })
  const same = service.update({ id: entry.id, scope: 'global', content: '新' })
  assert.equal(same.content, '新')
  assert.equal(same.scope, 'global')
  const moved = service.update({ id: entry.id, scope: 'workspace', workspace: WS, content: '更新又移动', category: 'decision' })
  assert.equal(moved.content, '更新又移动')
  assert.equal(moved.category, 'decision')
  assert.equal(moved.scope, 'workspace')
})

test('update move rejects credentials in new content', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '正常', scope: 'global' })
  assert.throws(
    () => service.update({ id: entry.id, scope: 'workspace', workspace: WS, content: 'password = hunter2secret' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' })[0].content, '正常')
})

test('export produces a versioned document covering all scopes', () => {
  const { service } = tmpService()
  service.save({ content: '全局偏好', scope: 'global', category: 'preference', tags: ['语言'] })
  service.save({ content: '工作区事实', scope: 'workspace', workspace: WS })
  const doc = service.export()
  assert.equal(doc.format, 'dsh-memory-export')
  assert.equal(doc.version, 1)
  assert.ok(doc.exportedAt)
  assert.equal(doc.entries.length, 2)
  const globalEntry = doc.entries.find((e) => e.scope === 'global')
  assert.equal(globalEntry.workspace, null)
  assert.deepEqual(globalEntry.tags, ['语言'])
  const wsEntry = doc.entries.find((e) => e.scope === 'workspace')
  assert.equal(wsEntry.workspace.toLowerCase(), WS.toLowerCase())
  assert.ok(wsEntry.created && wsEntry.updated && wsEntry.id)
})

test('import dryRun plans without writing', () => {
  const { service } = tmpService()
  const plan = service.import({
    dryRun: true,
    entries: [
      { content: '新记忆', scope: 'global', category: 'fact' },
      { content: 'password = hunter2secret', scope: 'global' },
    ],
  })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.imported, 1)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].code, 'secret')
  assert.equal(service.list({ scope: 'all' }).length, 0)
})

test('import writes entries preserving id, timestamps, tags and source', () => {
  const { service } = tmpService()
  const result = service.import({
    entries: [{
      id: 'm-import-aaaaaa',
      content: '导入的记忆',
      scope: 'global',
      category: 'preference',
      tags: ['导入', '导入', 'x'.repeat(100)],
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      source: 'old-session',
    }],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.deduplicated, 0)
  assert.equal(result.rejected.length, 0)
  const entries = service.list({ scope: 'global' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'm-import-aaaaaa')
  assert.equal(entries[0].created, '2026-01-01T00:00:00.000Z')
  assert.equal(entries[0].updated, '2026-01-02T00:00:00.000Z')
  assert.equal(entries[0].source, 'old-session')
  assert.deepEqual(entries[0].tags, ['导入', 'x'.repeat(64)])
})

test('import deduplicates against disk and within the batch', () => {
  const { service } = tmpService()
  service.save({ content: '已存在', scope: 'global' })
  const result = service.import({
    entries: [
      { content: '已存在', scope: 'global' },
      { content: '批量新条目', scope: 'global' },
      { content: '  批量新条目  ', scope: 'global' },
    ],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.deduplicated, 2)
  assert.equal(service.list({ scope: 'global' }).length, 2)
})

test('import rejects invalid entries individually and keeps going', () => {
  const { service } = tmpService()
  const result = service.import({
    entries: [
      { content: '   ', scope: 'global' },
      { content: 'x', scope: 'global', category: 'bogus' },
      { content: 'x', scope: 'bogus' },
      { content: '缺工作区', scope: 'workspace' },
      { content: '有效条目', scope: 'workspace', workspace: WS },
    ],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.rejected.length, 4)
  assert.deepEqual(result.rejected.map((r) => r.code), ['invalid', 'invalid', 'invalid', 'no-workspace'])
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).length, 1)
  assert.throws(() => service.import({ entries: 'not-an-array' }), (err) => err.code === 'invalid')
})

test('import resolves id collisions by allocating a new id', () => {
  const { service } = tmpService()
  service.import({ entries: [{ id: 'm-collide-aaaaaa', content: '原条目', scope: 'global' }] })
  const result = service.import({ entries: [{ id: 'm-collide-aaaaaa', content: '不同内容', scope: 'global' }] })
  assert.equal(result.imported, 1)
  const entries = service.list({ scope: 'global' })
  assert.equal(entries.length, 2)
  const ids = entries.map((e) => e.id)
  assert.ok(ids.includes('m-collide-aaaaaa'))
  assert.equal(new Set(ids).size, 2)
})

test('export -> import roundtrip into a fresh root restores everything', () => {
  const { service } = tmpService()
  service.save({ content: '全局偏好', scope: 'global', category: 'preference', tags: ['语言'] })
  service.save({ content: '工作区事实', scope: 'workspace', workspace: WS, category: 'decision' })
  const doc = service.export()
  const fresh = tmpService().service
  const result = fresh.import({ entries: doc.entries })
  assert.equal(result.imported, 2)
  assert.equal(result.deduplicated, 0)
  assert.equal(result.rejected.length, 0)
  const before = doc.entries.slice().sort((a, b) => a.id.localeCompare(b.id))
  const after = fresh.export().entries.slice().sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(after.map((e) => ({ ...e, workspace: e.workspace && e.workspace.toLowerCase() })), before.map((e) => ({ ...e, workspace: e.workspace && e.workspace.toLowerCase() })))
})
