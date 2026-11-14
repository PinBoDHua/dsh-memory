/**
 * dsh-memory 0.24.7：命中簿记迁移到独立 access.json 账本。
 * 要点：检索/注入命中只写账本、不改写条目 Markdown（无读-改-写窗口/写放大）；
 * 节流 ≤1 次/小时；损坏账本按空处理并在下次命中时修复；旧文件内命中字段兼容；
 * 跨进程并发不丢计数。
 * 运行 Run: node --test tests/access-ledger.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-access-'))
  return { root, service: createMemoryService({ root }) }
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8'))
}

function runWorker(root, offset, count, env = {}) {
  const worker = fileURLToPath(new URL('./fixtures/access-worker.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, String(offset), String(count)], { stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

test('search hit writes access.json but never rewrites the entry markdown', () => {
  const { root, service } = tmpService()
  const saved = service.save({ content: '账本命中事实', scope: 'global', origin: 'auto' })
  const file = path.join(root, 'global', `${saved.entry.id}.md`)
  const beforeText = fs.readFileSync(file, 'utf8')
  const beforeMtime = fs.statSync(file).mtimeMs

  assert.equal(service.search({ query: '账本命中', scope: 'global' }).length, 1)

  const accessFile = path.join(root, 'access.json')
  assert.ok(fs.existsSync(accessFile), 'access.json created')
  const ledger = readLedger(root)
  assert.equal(ledger[saved.entry.id].count, 1)
  assert.ok(Number.isFinite(Date.parse(ledger[saved.entry.id].at)))
  assert.equal(fs.readFileSync(file, 'utf8'), beforeText, 'entry markdown unchanged')
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime, 'no write churn on entry file')

  // 读取路径叠加账本值：列表/检索可见命中字段。
  const list = service.list({ scope: 'global' })
  assert.equal(list[0].hit_count, 1)
  assert.ok(list[0].last_access)
})

test('touchAccess throttles per entry for one hour and persists via ledger', () => {
  const { root, service } = tmpService()
  const saved = service.save({ content: '节流事实', scope: 'global' })
  const now = Date.parse('2026-11-13T12:00:00.000Z')
  const snapshot = service.list({ scope: 'global' })[0]
  store.touchAccess(root, [snapshot], undefined, now)
  assert.equal(readLedger(root)[saved.entry.id].count, 1)
  store.touchAccess(root, service.list({ scope: 'global' }), undefined, now + 30 * 60 * 1000)
  assert.equal(readLedger(root)[saved.entry.id].count, 1, 'within an hour: no increment')
  store.touchAccess(root, service.list({ scope: 'global' }), undefined, now + 61 * 60 * 1000)
  assert.equal(readLedger(root)[saved.entry.id].count, 2, 'after an hour: increment')
  assert.equal(store.findEntry(root, saved.entry.id, undefined).hit_count, 2)
})

test('corrupt access ledger is ignored and repaired on the next hit', () => {
  const { root, service } = tmpService()
  const saved = service.save({ content: '损坏账本事实', scope: 'global' })
  fs.writeFileSync(path.join(root, 'access.json'), '{not json', 'utf8')
  assert.equal(service.list({ scope: 'global' }).length, 1, 'list still works')
  assert.equal(service.search({ query: '损坏账本', scope: 'global' }).length, 1)
  const ledger = readLedger(root)
  assert.equal(ledger[saved.entry.id].count, 1, 'ledger repaired')
})

test('legacy file hit fields are honored until the ledger takes over', () => {
  const { root, service } = tmpService()
  const now = new Date().toISOString()
  store.writeEntry(root, {
    id: 'm-legacy-hits-1',
    category: 'fact',
    scope: 'global',
    tags: [],
    created: now,
    updated: now,
    source: '',
    content: '旧文件命中字段',
    last_access: '2026-01-04T00:00:00.000Z',
    hit_count: 5,
  })
  assert.equal(service.list({ scope: 'global' })[0].hit_count, 5, 'legacy file value visible')
  store.touchAccess(root, service.list({ scope: 'global' }), undefined, Date.parse('2026-11-13T12:00:00.000Z'))
  const ledger = readLedger(root)
  assert.equal(ledger['m-legacy-hits-1'].count, 6, 'ledger continues from legacy count')
  assert.equal(service.list({ scope: 'global' })[0].hit_count, 6)
})

test('two processes touching disjoint entries lose no ledger updates', async () => {
  const { root, service } = tmpService()
  for (let i = 0; i < 40; i += 1) service.save({ content: `并发账本 ${i}`, scope: 'global' })
  const ids = service.list({ scope: 'global' }).map((e) => e.id)
  const [codeA, codeB] = await Promise.all([
    runWorker(root, 0, 20, { DSH_MEMORY_ACCESS_LOCK_TIMEOUT: '8000' }),
    runWorker(root, 20, 20, { DSH_MEMORY_ACCESS_LOCK_TIMEOUT: '8000' }),
  ])
  assert.equal(codeA, 0)
  assert.equal(codeB, 0)
  const ledger = readLedger(root)
  for (const id of ids) {
    assert.ok(ledger[id], `ledger entry ${id} present`)
    assert.equal(ledger[id].count, 1)
  }
})

test('pruneAccessLedger removes ghost records from externally deleted files', () => {
  const { root, service } = tmpService()
  const kept = service.save({ content: '保留条目', scope: 'global' })
  const gone = service.save({ content: '外部删除条目', scope: 'global' })
  service.search({ query: '条目', scope: 'global' })
  const before = readLedger(root)
  assert.ok(before[gone.entry.id], 'ledger recorded for soon-deleted file')
  // 模拟手工/外部删除（不经过 forget）：账本残留幽灵记录。
  fs.rmSync(path.join(root, 'global', `${gone.entry.id}.md`))
  const removed = service.pruneAccessLedger()
  assert.equal(removed, 1)
  const after = readLedger(root)
  assert.equal(after[gone.entry.id], undefined)
  assert.ok(after[kept.entry.id], 'alive record kept')
  // 同 id 重新导入：不继承幽灵命中。
  const res = service.import({ entries: [{ id: gone.entry.id, content: '重新导入的新内容', scope: 'global' }] })
  assert.equal(res.imported, 1)
  const reimported = service.list({ scope: 'global' }).find((e) => e.id === gone.entry.id)
  assert.equal(reimported.hit_count, undefined)
  assert.equal(reimported.last_access, undefined)
})

test('touchAccess never blocks search when the ledger lock is held (short timeout)', async () => {
  const { root, service } = tmpService()
  service.save({ content: '锁忙条目', scope: 'global' })
  fs.mkdirSync(path.join(root, '.lock-access'), { recursive: true }) // 模拟另一进程持锁
  const started = Date.now()
  const results = service.search({ query: '锁忙条目', scope: 'global' })
  const elapsed = Date.now() - started
  assert.equal(results.length, 1, 'search still works')
  assert.ok(elapsed < 1500, `search waited ${elapsed}ms on ledger lock (must be best-effort ~400ms)`)
  fs.rmSync(path.join(root, '.lock-access'), { recursive: true, force: true })
})

test('ledger survives prototype-key ids (__proto__ entries)', () => {
  // 第八轮审计：账本此前用普通对象按条目 id 建键——ID_PATTERN 允许 __proto__，
  // 赋值触发原型 setter 导致记录静默丢失；applyAccess 的 Object.prototype 影子读
  // 还会把条目文件内的 last_access/hit_count 覆盖成 undefined。
  const { root, service } = tmpService()
  service.import({
    entries: [
      { id: '__proto__', content: '原型键条目', scope: 'global', last_access: '2026-01-01T00:00:00.000Z', hit_count: 5 },
      { id: 'm-normal-1', content: '普通条目', scope: 'global' },
    ],
  })
  // 账本非空（普通条目先记账）时，__proto__ 条目的文件内命中字段不得被影子读覆盖。
  service.search({ query: '普通条目', scope: 'global' })
  const shadowed = service.list({ scope: 'global' }).find((e) => e.id === '__proto__')
  assert.equal(shadowed.last_access, '2026-01-01T00:00:00.000Z', 'file-based last_access preserved')
  assert.equal(shadowed.hit_count, 5, 'file-based hit_count preserved')
  // 对 __proto__ 条目记账：记录必须成为账本自有键并落盘（此前被原型 setter 吞掉）。
  service.search({ query: '原型键', scope: 'global' })
  const ledger = readLedger(root)
  assert.ok(Object.prototype.hasOwnProperty.call(ledger, '__proto__'), 'own record persisted')
  assert.equal(ledger['__proto__'].count, 6, 'count continues from the file-based value')
  const merged = service.list({ scope: 'global' }).find((e) => e.id === '__proto__')
  assert.equal(merged.hit_count, 6, 'ledger value wins once recorded')
})

test('system prompt injection records hits (throttled) through the ledger', () => {
  const prevHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-inject-home-'))
  process.env.DSH_HOME = home
  let dispose = null
  try {
    const tools = {}
    let sectionText = null
    const ctx = {
      get() { return undefined },
      effect(fn) {
        dispose = fn()
        return () => {}
      },
      tools: { register(tool) { tools[tool.name] = tool; return () => {} } },
      systemPrompt: {
        section(opts) { sectionText = opts.text; return () => {} },
        context() { return () => {} },
      },
      inject() { throw new Error('no webServer in test') },
      logger: { warn() {} },
    }
    apply(ctx, {})
    const session = { id: 'sess-inject', header: { cwd: 'D:\\proj' } }
    const exec = { agent: { session } }
    tools.memory_save.execute({ content: '注入命中事实甲', origin: 'auto', scope: 'global' }, exec)
    tools.memory_save.execute({ content: '注入命中事实乙', origin: 'auto', scope: 'global' }, exec)

    const text = sectionText({ agent: { session } })
    assert.ok(text.includes('注入命中事实甲'), 'injected section contains memory')
    const accessFile = path.join(home, '.dsh-memory', 'access.json')
    const first = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
    const ids = Object.keys(first)
    assert.equal(ids.length, 2, 'both injected entries recorded')
    for (const id of ids) assert.equal(first[id].count, 1)

    // 同一小时内的再次装配不重复计数（节流）。
    sectionText({ agent: { session } })
    const second = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
    for (const id of ids) assert.equal(second[id].count, 1, 'throttled within an hour')
  } finally {
    try { dispose?.() } catch { /* ignore */ }
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})