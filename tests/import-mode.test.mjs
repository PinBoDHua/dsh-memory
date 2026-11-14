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

test('import keeps ids unique across scopes (no global/workspace id collision)', () => {
  const { service } = tmpService()
  const WS = path.join(os.tmpdir(), 'dsh-memory-import-id-ws')
  const first = service.import({ entries: [{ id: 'm-cross-aaaaaa', content: '工作区先占', scope: 'workspace', workspace: WS }] })
  assert.equal(first.imported, 1)
  const second = service.import({ entries: [{ id: 'm-cross-aaaaaa', content: '全局后到', scope: 'global' }] })
  assert.equal(second.imported, 1)
  const all = [...service.list({ scope: 'global' }), ...service.list({ scope: 'workspace', workspace: WS })]
  assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'ids unique across scopes')

  // 反向：global 先占 id，workspace 后导入同 id 必须换新 id。
  service.import({ entries: [{ id: 'm-cross-bbbbbb', content: '全局先占乙', scope: 'global' }] })
  service.import({ entries: [{ id: 'm-cross-bbbbbb', content: '工作区后到乙', scope: 'workspace', workspace: WS }] })
  const globalIds = service.list({ scope: 'global' }).map((e) => e.id)
  const wsIds = service.list({ scope: 'workspace', workspace: WS }).map((e) => e.id)
  assert.ok(globalIds.includes('m-cross-bbbbbb'))
  assert.ok(!wsIds.includes('m-cross-bbbbbb'))
  assert.equal(new Set([...globalIds, ...wsIds]).size, globalIds.length + wsIds.length)
})

test('import merge does not merge into an id occupied in another scope', () => {
  const { service } = tmpService()
  const WS = path.join(os.tmpdir(), 'dsh-memory-import-id-merge')
  service.import({ entries: [{ id: 'm-cross-cccccc', content: '工作区原内容', scope: 'workspace', workspace: WS }] })
  const res = service.import({ mode: 'merge', entries: [{ id: 'm-cross-cccccc', content: '全局合并尝试', scope: 'global' }] })
  assert.equal(res.updated, 0, 'must not update the workspace entry')
  assert.equal(res.imported, 1)
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).find((e) => e.id === 'm-cross-cccccc').content, '工作区原内容')
  const globalEntry = service.list({ scope: 'global' }).find((e) => e.content === '全局合并尝试')
  assert.ok(globalEntry)
  assert.notEqual(globalEntry.id, 'm-cross-cccccc', 'new id allocated to avoid cross-scope duplicate')
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

test('sequential chunks rebuild cross-chunk supersede chains from disk state', () => {
  // 第八轮审计契约：超过单请求上限的取代链分量按「目标在前、指针在后」拆片时，
  // 后片对磁盘上的取代目标必须物化反向指针（superseded_by），链语义跨片重建。
  const { service } = tmpService()
  const older = { id: 'm-xold-1', content: '旧条目', scope: 'global' }
  const newer = { id: 'm-xnew-1', content: '新条目', scope: 'global', supersedes: 'm-xold-1' }
  // 片 1：目标（旧条目）先落盘（其反向指针不可达，被修复丢弃，计入 repaired）。
  service.import({ entries: [{ ...older, superseded_by: 'm-xnew-1' }] })
  // 片 2：指针（新条目）到达，supersedes 指向片 1 已落盘的磁盘条目。
  const res = service.import({ entries: [newer] })
  assert.equal(res.imported, 1)
  assert.equal(res.repaired, 0, 'pointer to a disk target needs no repair')
  const all = service.list({ scope: 'global', includeSuperseded: true })
  const oldEntry = all.find((e) => e.id === 'm-xold-1')
  const newEntry = all.find((e) => e.id === 'm-xnew-1')
  assert.equal(oldEntry.superseded_by, 'm-xnew-1', 'disk target materialized by the later chunk')
  assert.equal(newEntry.supersedes, 'm-xold-1', 'pointer preserved')
  // 默认检索视图隐藏被取代的旧条目：链语义完整生效。
  assert.equal(service.searchDetailed({ scope: 'global' }).entries.find((e) => e.id === 'm-xold-1'), undefined)
})

test('reverse order (pointer before target) documents why topological splitting is required', () => {
  const { service } = tmpService()
  // 指针先到：supersedes 目标不可达（不在本片也不在磁盘）→ 按悬垂修复丢弃。
  const newer = { id: 'm-rnew-1', content: '反向新', scope: 'global', supersedes: 'm-rold-1' }
  const res = service.import({ entries: [newer] })
  assert.equal(res.repaired, 1, 'dangling pointer dropped')
  service.import({ entries: [{ id: 'm-rold-1', content: '反向旧', scope: 'global' }] })
  const all = service.list({ scope: 'global', includeSuperseded: true })
  assert.equal(all.find((e) => e.id === 'm-rnew-1').supersedes, undefined, 'link lost when target arrives later')
  assert.equal(all.find((e) => e.id === 'm-rold-1').superseded_by, undefined)
})
