/**
 * 缝 3：HTTP 契约 —— 回环检查、写路由鉴权、错误码→状态码映射、JSON 形状。
 * req/res 为传输边界桩（系统边界模拟）；真实 webServer 挂载另行 live 验证。
 * 运行 Run: node --test tests/routes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

const TOKEN = 'test-token-0123456789abcdef'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-http-'))
  const service = createMemoryService({ root })
  const handlers = createHandlers({ service, token: TOKEN, version: '0.2.0-test' })
  return { service, handlers }
}

function fakeReq({ method = 'GET', url = '/plugins/dsh-memory/status', headers = {}, remoteAddress = '127.0.0.1', body } = {}) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:50562', ...headers },
    socket: { remoteAddress },
  }
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  }
  return req
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
  res.json = () => JSON.parse(res.body)
  return res
}

test('GET status from loopback returns key, version and counts', async () => {
  const { handlers } = setup()
  const res = fakeRes()
  await handlers.status(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.ok, true)
  assert.equal(doc.key, TOKEN)
  assert.equal(doc.version, '0.2.0-test')
  assert.equal(doc.schemaVersion, 1)
  assert.deepEqual(doc.counts, { global: 0, workspaces: 0 })
})

test('non-loopback requests are rejected with 403', async () => {
  const { handlers } = setup()
  const byAddr = fakeRes()
  await handlers.status(fakeReq({ remoteAddress: '192.168.1.5' }), byAddr)
  assert.equal(byAddr.statusCode, 403)
  assert.equal(byAddr.json().error, 'loopback-only')
  const byHost = fakeRes()
  await handlers.status(fakeReq({ headers: { host: 'evil.example.com' } }), byHost)
  assert.equal(byHost.statusCode, 403)
  assert.equal(byHost.json().error, 'loopback-only')
})

test('write routes require the process token', async () => {
  const { service, handlers } = setup()
  const url = '/plugins/dsh-memory/save'
  const body = { content: '授权写入', scope: 'global' }
  const noKey = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url, body }), noKey)
  assert.equal(noKey.statusCode, 403)
  assert.equal(noKey.json().error, 'unauthorized')
  const wrongKey = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url, headers: { 'x-rpc-key': 'wrong-token' }, body }), wrongKey)
  assert.equal(wrongKey.statusCode, 403)
  assert.equal(service.list({ scope: 'global' }).length, 0)
  const ok = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url, headers: { 'x-rpc-key': TOKEN }, body }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().result.entry.content, '授权写入')
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('GET entries parses query; GET workspaces lists directories', async () => {
  const { service, handlers } = setup()
  service.save({ content: '构建使用 pnpm', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  service.save({ content: '全局偏好', scope: 'global', category: 'preference' })
  const res = fakeRes()
  await handlers.entries(fakeReq({ url: '/plugins/dsh-memory/entries?scope=workspace&workspace=D%3A%5Cproj%5Calpha&query=pnpm' }), res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].content, '构建使用 pnpm')
  const ws = fakeRes()
  await handlers.workspaces(fakeReq({ url: '/plugins/dsh-memory/workspaces' }), ws)
  assert.equal(ws.statusCode, 200)
  assert.equal(ws.json().workspaces.length, 1)
})

test('update and forget routes operate through the token', async () => {
  const { service, handlers } = setup()
  const { entry } = service.save({ content: '旧', scope: 'global' })
  const auth = { 'x-rpc-key': TOKEN }
  const upd = fakeRes()
  await handlers.update(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/update', headers: auth, body: { id: entry.id, content: '新' } }), upd)
  assert.equal(upd.statusCode, 200)
  assert.equal(upd.json().result.content, '新')
  const del = fakeRes()
  await handlers.forget(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/forget', headers: auth, body: { id: entry.id } }), del)
  assert.equal(del.statusCode, 200)
  assert.deepEqual(del.json().result, { id: entry.id, deleted: true })
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('GET entries honors offset and category together', async () => {
  const { service, handlers } = setup()
  for (let i = 0; i < 4; i++) service.save({ content: `路由分页 ${i}`, scope: 'global', category: i % 2 ? 'fact' : 'decision' })
  const res = fakeRes()
  await handlers.entries(fakeReq({ url: '/plugins/dsh-memory/entries?query=%E8%B7%AF%E7%94%B1%E5%88%86%E9%A1%B5&category=decision&limit=1&offset=1' }), res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].category, 'decision')
  const all = fakeRes()
  await handlers.entries(fakeReq({ url: '/plugins/dsh-memory/entries?query=%E8%B7%AF%E7%94%B1%E5%88%86%E9%A1%B5&category=decision&limit=10' }), all)
  const ids = all.json().entries.map((e) => e.id)
  assert.equal(ids.length, 2)
  assert.ok(ids.includes(doc.entries[0].id))
})

test('GET export returns the full document; loopback enforced', async () => {
  const { service, handlers } = setup()
  service.save({ content: '导出内容', scope: 'global' })
  const res = fakeRes()
  await handlers.export(fakeReq({ url: '/plugins/dsh-memory/export' }), res)
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.equal(doc.format, 'dsh-memory-export')
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.entries[0].content, '导出内容')
  const remote = fakeRes()
  await handlers.export(fakeReq({ url: '/plugins/dsh-memory/export', remoteAddress: '10.0.0.9' }), remote)
  assert.equal(remote.statusCode, 403)
})

test('POST import requires token; dryRun and apply work over HTTP', async () => {
  const { service, handlers } = setup()
  const auth = { 'x-rpc-key': TOKEN }
  const url = '/plugins/dsh-memory/import'
  const body = { entries: [{ content: 'HTTP 导入', scope: 'global' }] }
  const noKey = fakeRes()
  await handlers.import(fakeReq({ method: 'POST', url, body }), noKey)
  assert.equal(noKey.statusCode, 403)
  const dry = fakeRes()
  await handlers.import(fakeReq({ method: 'POST', url, headers: auth, body: { ...body, dryRun: true } }), dry)
  assert.equal(dry.statusCode, 200)
  assert.equal(dry.json().result.imported, 1)
  assert.equal(service.list({ scope: 'global' }).length, 0)
  const apply = fakeRes()
  await handlers.import(fakeReq({ method: 'POST', url, headers: auth, body }), apply)
  assert.equal(apply.statusCode, 200)
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('update with scope moves over HTTP; duplicate maps to 409', async () => {
  const { service, handlers } = setup()
  const auth = { 'x-rpc-key': TOKEN }
  const { entry } = service.save({ content: '移动我', scope: 'global' })
  service.save({ content: '移动我', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  const dup = fakeRes()
  await handlers.update(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/update', headers: auth, body: { id: entry.id, scope: 'workspace', workspace: 'D:\\proj\\alpha' } }), dup)
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().code, 'duplicate')
  const ok = fakeRes()
  await handlers.update(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/update', headers: auth, body: { id: entry.id, scope: 'workspace', workspace: 'D:\\proj\\beta' } }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().result.scope, 'workspace')
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('oversized body maps to 413 body-too-large, not invalid-json', async () => {
  const { handlers } = setup()
  const auth = { 'x-rpc-key': TOKEN }
  const big = { content: 'x'.repeat(1024 * 1024 + 10), scope: 'global' }
  const res = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/save', headers: auth, body: big }), res)
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error, 'body-too-large')
})

test('update with invalid category maps to 400 invalid (not 500)', async () => {
  const { service, handlers } = setup()
  const auth = { 'x-rpc-key': TOKEN }
  const { entry } = service.save({ content: '分类校验', scope: 'global' })
  const res = fakeRes()
  await handlers.update(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/update', headers: auth, body: { id: entry.id, category: 'bogus' } }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'invalid')
})

test('service errors and bad input map to HTTP status codes', async () => {
  const { handlers } = setup()
  const auth = { 'x-rpc-key': TOKEN }
  const missing = fakeRes()
  await handlers.update(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/update', headers: auth, body: { id: 'm-nonexistent-000000', content: 'x' } }), missing)
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, 'not-found')
  const secret = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/save', headers: auth, body: { content: 'password = hunter2secret', scope: 'global' } }), secret)
  assert.equal(secret.statusCode, 400)
  assert.equal(secret.json().code, 'secret')
  const badJson = fakeRes()
  await handlers.save(fakeReq({ method: 'POST', url: '/plugins/dsh-memory/save', headers: auth, body: '{oops' }), badJson)
  assert.equal(badJson.statusCode, 400)
  assert.equal(badJson.json().error, 'invalid-json')
  const wrongMethod = fakeRes()
  await handlers.save(fakeReq({ method: 'GET', url: '/plugins/dsh-memory/save', headers: auth }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})
