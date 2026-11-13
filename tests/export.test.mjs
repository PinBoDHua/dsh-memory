/**
 * dsh-memory 0.17.0：作用域感知导出（service.export scope/workspace＋GET /export）。
 * 默认 all 全量（向后兼容，备份不受影响）；global 仅全局；workspace 指定工作区。
 * 运行 Run: node --test tests/export.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

const WS = path.join(os.tmpdir(), 'dsh-memory-export-ws')

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-export-'))
  const service = createMemoryService({ root })
  service.save({ content: '全局甲', scope: 'global', origin: 'manual' })
  service.save({ content: '工作区乙', scope: 'workspace', workspace: WS, origin: 'manual' })
  return { root, service }
}

test('service.export default and scope=all include global and all workspaces', () => {
  const { service } = tmpService()
  const def = service.export()
  assert.equal(def.format, 'dsh-memory-export')
  assert.equal(def.entries.length, 2)
  assert.equal(service.export({ scope: 'all' }).entries.length, 2)
})

test('service.export scope=global returns only global entries', () => {
  const { service } = tmpService()
  const g = service.export({ scope: 'global' })
  assert.equal(g.entries.length, 1)
  assert.equal(g.entries[0].content, '全局甲')
  assert.equal(g.entries[0].workspace, null)
})

test('service.export scope=workspace returns only that workspace', () => {
  const { service } = tmpService()
  const w = service.export({ scope: 'workspace', workspace: WS })
  assert.equal(w.entries.length, 1)
  assert.equal(w.entries[0].content, '工作区乙')
  assert.equal(w.entries[0].workspace, WS)
})

test('service.export workspace without cwd throws no-workspace; invalid scope throws invalid', () => {
  const { service } = tmpService()
  assert.throws(() => service.export({ scope: 'workspace' }), (e) => e.code === 'no-workspace')
  assert.throws(() => service.export({ scope: 'bogus' }), (e) => e.code === 'invalid')
})

test('service.export reads each workspace by directory key, not by stale index cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-export-stale-'))
  const service = createMemoryService({ root })
  const alpha = path.join(os.tmpdir(), 'dsh-memory-export-alpha')
  const beta = path.join(os.tmpdir(), 'dsh-memory-export-beta')
  service.save({ content: 'alpha 记忆', scope: 'workspace', workspace: alpha, origin: 'manual' })
  service.save({ content: 'beta 记忆', scope: 'workspace', workspace: beta, origin: 'manual' })
  // 模拟索引损坏/陈旧：把 alpha 目录的 key 指向 beta 的 cwd。
  const indexFile = path.join(root, 'workspaces', 'index.json')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const keys = Object.keys(index)
  const alphaKey = keys.find((k) => index[k].cwd.endsWith('alpha'))
  const betaKey = keys.find((k) => index[k].cwd.endsWith('beta'))
  assert.ok(alphaKey && betaKey)
  index[alphaKey].cwd = index[betaKey].cwd
  fs.writeFileSync(indexFile, JSON.stringify(index), 'utf8')
  const doc = service.export({ scope: 'all' })
  const contents = doc.entries.map((e) => e.content).sort()
  assert.deepEqual(contents, ['alpha 记忆', 'beta 记忆'], 'no entries lost or duplicated')
})

test('GET /export?scope=global returns global only from loopback', async () => {
  const { service } = tmpService()
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.17.0-test' })
  const req = {
    method: 'GET',
    url: '/plugins/dsh-memory/export?scope=global',
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  await handlers.export(req, res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].content, '全局甲')
})

test('export reports skipped damaged files instead of silently losing them', () => {
  const { root, service } = tmpService()
  fs.writeFileSync(path.join(root, 'global', 'm-export-broken.md'), 'not frontmatter', 'utf8')
  const doc = service.export({ scope: 'global' })
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.skipped, 1, 'damaged file must be counted, not silently dropped')
  const all = service.export({ scope: 'all' })
  assert.ok(Array.isArray(all.entries) && all.entries.length >= 2)
  assert.equal(typeof all.skipped, 'number')
})
