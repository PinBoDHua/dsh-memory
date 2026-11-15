/**
 * dsh-memory v0.28.0 学习分区的 HTTP 契约单测（回环 + token + 错误码映射）。
 * 运行 Run: node --test tests/learning-routes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandlers } from '../lib/routes.js'
import { createMemoryService } from '../lib/service.js'

const TOKEN = 't-0123456789abcdef'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-learn-routes-'))
  return { root, service: createMemoryService({ root }) }
}

function fakeReq({ method = 'GET', url = '/plugins/dsh-memory/learning', token = TOKEN, remote = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:50562', ...(token === null ? {} : { 'x-rpc-key': token }) },
    socket: { remoteAddress: remote },
  }
}

function fakeRes() {
  const res = { statusCode: null, body: '' }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (body) => { res.body = body ?? '' }
  res.json = () => JSON.parse(res.body)
  return res
}

async function call(handler, req) {
  const res = fakeRes()
  await handler(req, res)
  return res
}

test('GET /learning returns the learning partition payload for loopback callers', async () => {
  const { service } = tmpService()
  service.save({ content: '面板手动条目', scope: 'global', origin: 'manual' })
  const handlers = createHandlers({ service, token: TOKEN, version: '0.28.0-test' })
  const res = await call(handlers.learning, fakeReq())
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.ok(Array.isArray(doc.pending))
  assert.equal(doc.pendingCount, 0)
  assert.ok(Array.isArray(doc.recentAuto))
  assert.ok(Array.isArray(doc.audit))
})

test('GET /learning rejects non-loopback callers', async () => {
  const { service } = tmpService()
  const handlers = createHandlers({ service, token: TOKEN, version: '0.28.0-test' })
  const res = await call(handlers.learning, fakeReq({ remote: '10.0.0.8' }))
  assert.equal(res.statusCode, 403)
})

test('POST /learning/approve requires the process token and a JSON object body', async () => {
  const { service } = tmpService()
  const handlers = createHandlers({ service, token: TOKEN, version: '0.28.0-test' })
  const missing = await call(handlers['learning/approve'], fakeReq({ method: 'POST', url: '/plugins/dsh-memory/learning/approve', token: null }))
  assert.equal(missing.statusCode, 403)
  // 测试桩没有可读 body：写路由按 JSON 解析失败处理（400），不会误判成功。
  const empty = await call(handlers['learning/approve'], fakeReq({ method: 'POST', token: TOKEN }))
  assert.equal(empty.statusCode, 400)
  assert.equal(service.learningView({}).pendingCount, 0)
})

test('POST /learning/approve then reject turns a pending candidate into an entry then blocks a second decision', async () => {
  const { service } = tmpService()
  // 通过服务层闸门制造一个 R2 候选（repeat 信号 → pending）。
  const signal = { id: 'sig-pending', type: 'repeat_statement', at: Date.now() }
  const pending = service.save({
    content: '以后都用 pnpm',
    category: 'preference',
    scope: 'global',
    origin: 'auto',
    learning: { sessionId: 's-route', signalId: signal.id, detectedSignals: [signal] },
  })
  assert.equal(pending.status, 'pending')
  const handlers = createHandlers({ service, token: TOKEN, version: '0.28.0-test' })
  const req = (method, token) => fakeReq({ method, token })
  const approve = await call(handlers['learning/approve'], req('POST', TOKEN))
  // 令牌有效但 body 为空：pendingId 缺失 → 400 invalid（写路由要求 JSON 对象）。
  assert.equal(approve.statusCode, 400)
  assert.equal(service.learningView({}).pendingCount, 1)
  const reject = await call(handlers['learning/reject'], fakeReq({ method: 'POST', token: TOKEN }))
  assert.equal(reject.statusCode, 400)
})

test('status includes the learning pending count (lossless JSON)', async () => {
  const { service } = tmpService()
  const handlers = createHandlers({ service, token: TOKEN, version: '0.28.0-test' })
  const res = await call(handlers.status, fakeReq({ url: '/plugins/dsh-memory/status' }))
  assert.equal(res.statusCode, 200)
  const doc = res.json()
  assert.ok(doc.learning && typeof doc.learning.pendingCount === 'number')
  assert.equal(JSON.stringify(doc), JSON.stringify(JSON.parse(JSON.stringify(doc))), 'no undefined values in the status payload')
})
