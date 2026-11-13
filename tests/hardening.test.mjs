/**
 * dsh-memory 0.24.6：加固回归。
 * - 机密检查覆盖 tags（此前只查正文，标签可绕过硬拒）；
 * - 检索类接口非法 scope 回 400 而非 500；
 * - 工作区条目 update 刷新索引 lastSeen；
 * - workingDirectory 晚就绪时按次查询（cd 后工作区口径不会停留在 apply 时的旧目录）。
 * 运行 Run: node --test tests/hardening.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, resolveSessionCwd } from '../index.js'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'
import * as store from '../lib/store.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-hardening-'))
  return { root, service: createMemoryService({ root }) }
}

function fakeGetHandler(handler, url) {
  const req = {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:50562' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
  res.json = () => JSON.parse(res.body)
  return handler(req, res).then(() => ({ status: res.statusCode, json: res.json() }))
}

test('credentials in tags are rejected on save / update / import', () => {
  const { service } = tmpService()
  const token = 'ghp_' + 'a'.repeat(24)
  assert.throws(() => service.save({ content: '普通内容', scope: 'global', tags: [token] }), (err) => err.code === 'secret')
  assert.equal(service.list({ scope: 'global' }).length, 0)
  const saved = service.save({ content: '普通内容', scope: 'global' })
  assert.throws(() => service.update({ id: saved.entry.id, tags: ['分支', token] }), (err) => err.code === 'secret')
  // 更新失败时原标签保持不变。
  assert.deepEqual(store.findEntry(service.status().root, saved.entry.id, undefined).tags, [])
  const imported = service.import({ entries: [{ content: '导入内容', scope: 'global', tags: [token] }] })
  assert.equal(imported.imported, 0)
  assert.equal(imported.rejected.length, 1)
  assert.equal(imported.rejected[0].code, 'secret')
  // 正常标签不受影响。
  const ok = service.save({ content: '正常标签内容', scope: 'global', tags: ['构建', 'pnpm'] })
  assert.deepEqual(ok.entry.tags, ['构建', 'pnpm'])
})

test('invalid scope is a 400 invalid (service + routes), not a 500', async () => {
  const { service } = tmpService()
  assert.throws(() => service.search({ scope: 'bogus' }), (e) => e.code === 'invalid')
  assert.throws(() => service.searchDetailed({ scope: 'bogus' }), (e) => e.code === 'invalid')
  assert.throws(() => service.stats({ scope: 'bogus' }), (e) => e.code === 'invalid')
  assert.throws(() => service.similarPairs({ scope: 'bogus' }), (e) => e.code === 'invalid')
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: 'test' })
  for (const name of ['entries', 'stats', 'similar']) {
    const result = await fakeGetHandler(handlers[name], `/plugins/dsh-memory/${name}?scope=bogus`)
    assert.equal(result.status, 400, `${name} should be 400`)
    assert.equal(result.json.code, 'invalid', `${name} code`)
  }
})

test('updating a workspace entry refreshes index lastSeen', async () => {
  const { root, service } = tmpService()
  const ws = 'D:\\proj\\hardening-ws'
  const saved = service.save({ content: '索引刷新事实', scope: 'workspace', workspace: ws })
  const indexFile = path.join(root, 'workspaces', 'index.json')
  const before = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const key = store.workspaceKey(ws)
  const beforeSeen = before[key].lastSeen
  await new Promise((resolve) => setTimeout(resolve, 8))
  service.update({ id: saved.entry.id, content: '索引刷新事实（更新）', workspace: ws })
  const after = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  assert.ok(after[key].lastSeen >= beforeSeen, 'lastSeen should not go backwards')
  assert.notEqual(after[key].lastSeen, beforeSeen, 'lastSeen should be refreshed')
  assert.equal(after[key].firstSeen, before[key].firstSeen, 'firstSeen stable')
})

test('resolveSessionCwd prefers live workingDirectory and falls back to header', () => {
  const session = { id: 's1', header: { cwd: 'D:\\initial' } }
  assert.equal(resolveSessionCwd({ get: () => 'D:\\after-cd' }, session), 'D:\\after-cd')
  assert.equal(resolveSessionCwd(undefined, session), 'D:\\initial')
  assert.equal(resolveSessionCwd({ get: () => '' }, session), 'D:\\initial')
  assert.equal(resolveSessionCwd({ get: () => { throw new Error('boom') } }, session), 'D:\\initial')
  assert.equal(resolveSessionCwd({ get: () => 'D:\\x' }, null), undefined)
  assert.equal(resolveSessionCwd(undefined, { id: 's2', header: {} }), undefined)
})

test('apply re-reads workingDirectory each call (service ready after apply / after cd)', () => {
  const prevHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-home-'))
  process.env.DSH_HOME = home
  let dispose = null
  try {
    const tools = {}
    let workingDirectory = undefined
    const ctx = {
      get(name) {
        if (name === 'workingDirectory') return workingDirectory
        return undefined
      },
      effect(fn) {
        dispose = fn()
        return () => {}
      },
      tools: { register(tool) { tools[tool.name] = tool; return () => {} } },
      systemPrompt: { section() { return () => {} }, context() { return () => {} } },
      inject() { throw new Error('no webServer in test') },
      logger: { warn() {} },
    }
    apply(ctx, {})
    const session = { id: 'sess-late', header: { cwd: 'D:\\initial-cwd' } }
    const exec = { agent: { session } }
    // apply 时 workingDirectory 尚未就绪：回退 header。
    tools.memory_save.execute({ content: '晚就绪前的记忆', origin: 'auto', scope: 'workspace' }, exec)
    // 服务晚就绪并 cd 到新目录：下一次调用应立即使用新目录（不依赖 apply 时快照）。
    workingDirectory = { get: (s) => (s === session ? 'D:\\late-cwd' : undefined) }
    tools.memory_save.execute({ content: '晚就绪后的记忆', origin: 'auto', scope: 'workspace' }, exec)
    const root = path.join(home, '.dsh-memory')
    assert.ok(fs.existsSync(path.join(root, 'workspaces', store.workspaceKey('D:\\initial-cwd'))), 'entry written under header cwd')
    assert.ok(fs.existsSync(path.join(root, 'workspaces', store.workspaceKey('D:\\late-cwd'))), 'entry written under live cwd')
  } finally {
    try { dispose?.() } catch { /* ignore */ }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})