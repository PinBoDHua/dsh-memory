/**
 * dsh-memory 0.20.0：导入合并模式（mode='merge' 按 id 原地更新，保留 created）。
 * 默认 mode='skip' 完全向后兼容。缝 1（service.import）＋缝 3（POST /import）。
 * 运行 Run: node --test tests/import-mode.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-import-mode-'))
  return { root, service: createMemoryService({ root }) }
}

test('import skip (default) keeps existing entry and allocates new id for changed content', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '原内容', scope: 'global', origin: 'manual' })
  const res = service.import({ entries: [{ id: entry.id, content: '改内容', scope: 'global' }] })
  assert.equal(res.updated, 0)
  assert.equal(res.imported, 1)
  assert.equal(service.list({ scope: 'global' }).find((e) => e.id === entry.id).content, '原内容')
  assert.equal(service.list({ scope: 'global' }).length, 2)
})

test('import merge updates existing by id, preserves created, no duplicate', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '原内容', scope: 'global', origin: 'manual' })
  const created = entry.created
  const res = service.import({ mode: 'merge', entries: [{ id: entry.id, content: '改内容', scope: 'global', category: 'decision' }] })
  assert.equal(res.updated, 1)
  assert.equal(res.imported, 0)
  const list = service.list({ scope: 'global' })
  assert.equal(list.length, 1, 'no duplicate created')
  const after = list.find((e) => e.id === entry.id)
  assert.equal(after.content, '改内容')
  assert.equal(after.category, 'decision')
  assert.equal(after.created, created, 'created preserved')
})

test('import merge creates new entries for unknown ids', () => {
  const { service } = tmpService()
  const res = service.import({ mode: 'merge', entries: [{ content: '新条目', scope: 'global' }] })
  assert.equal(res.imported, 1)
  assert.equal(res.updated, 0)
})

test('import merge mixed: one update + one new', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '甲', scope: 'global', origin: 'manual' })
  const res = service.import({ mode: 'merge', entries: [{ id: entry.id, content: '甲改', scope: 'global' }, { content: '乙新', scope: 'global' }] })
  assert.equal(res.updated, 1)
  assert.equal(res.imported, 1)
  assert.equal(service.list({ scope: 'global' }).length, 2)
})

test('import merge dryRun reports plan without writing', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '原', scope: 'global', origin: 'manual' })
  const res = service.import({ mode: 'merge', dryRun: true, entries: [{ id: entry.id, content: '改', scope: 'global' }] })
  assert.equal(res.dryRun, true)
  assert.equal(res.updated, 1)
  assert.equal(service.list({ scope: 'global' }).find((e) => e.id === entry.id).content, '原')
})

test('import merge preserves scope isolation (workspace id not merged into global)', () => {
  const { service } = tmpService()
  const WS = path.join(os.tmpdir(), 'dsh-memory-import-ws')
  const { entry } = service.save({ content: '工作区原', scope: 'workspace', workspace: WS, origin: 'manual' })
  const res = service.import({ mode: 'merge', entries: [{ id: entry.id, content: '工作区改', scope: 'workspace', workspace: WS }] })
  assert.equal(res.updated, 1)
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).find((e) => e.id === entry.id).content, '工作区改')
})

test('import invalid mode throws invalid', () => {
  const { service } = tmpService()
  assert.throws(() => service.import({ mode: 'bogus', entries: [] }), (e) => e.code === 'invalid')
})

test('import rejects invalid expires instead of writing a hidden-forever entry', () => {
  const { service } = tmpService()
  const res = service.import({
    entries: [
      { content: '坏日历日期', scope: 'global', expires: '2026-99-99' },
      { content: '垃圾日期', scope: 'global', expires: 'not-a-date' },
      { content: '合法日期', scope: 'global', expires: '2026-12-31' },
    ],
  })
  assert.equal(res.imported, 1)
  assert.equal(res.rejected.length, 2)
  assert.deepEqual(res.rejected.map((r) => r.code), ['invalid', 'invalid'])
  const list = service.list({ scope: 'global' })
  assert.equal(list.length, 1)
  assert.equal(list[0].expires, '2026-12-31')
  // 坏日期条目没有落盘（不会被字符串比较永久隐藏）。
  assert.equal(service.search({ query: '坏日历日期', scope: 'global' }).length, 0)
})

test('import works on a fresh, not-yet-created data root (migration path)', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-import-fresh-'))
  const root = path.join(parent, 'not-yet')
  assert.ok(!fs.existsSync(root))
  const service = createMemoryService({ root })
  const res = service.import({ entries: [{ content: '全新安装导入', scope: 'global', origin: 'manual' }] })
  assert.equal(res.imported, 1)
  assert.equal(service.list({ scope: 'global' }).length, 1)
  assert.ok(fs.existsSync(path.join(root, 'global')))
})

test('POST /import mode=merge updates through the route', async () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '路由原', scope: 'global', origin: 'manual' })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.20.0-test' })
  const req = {
    method: 'POST',
    url: '/plugins/dsh-memory/import',
    headers: { host: '127.0.0.1:50562', 'x-rpc-key': 't-0123456789abcdef' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ mode: 'merge', entries: [{ id: entry.id, content: '路由改', scope: 'global' }] })) },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers.import(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().result.updated, 1)
  assert.equal(service.list({ scope: 'global' }).find((e) => e.id === entry.id).content, '路由改')
})
