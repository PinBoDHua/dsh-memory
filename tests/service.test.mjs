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
