/**
 * dsh-memory 0.11.0：写入时相似记忆提示（advisory，不阻断）。
 * 缝 1（store 纯逻辑＋saveEntry）＋缝 1（service 公共 API）＋缝 3（HTTP 形状）。
 * 运行 Run: node --test tests/similar.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import { createMemoryService } from '../lib/service.js'
import { createHandlers } from '../lib/routes.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-similar-'))
}

const NEAR_A = '用户要求所有回复一律使用简体中文'
const NEAR_B = '用户要求所有回复使用简体中文'
const UNRELATED = '本项目使用 pnpm 管理依赖'

// ---------- store：contentSimilarity 纯函数 ----------

test('contentSimilarity: identical=1, disjoint=0, reworded CJK high, unrelated low', () => {
  assert.equal(store.contentSimilarity(NEAR_A, NEAR_A), 1)
  assert.equal(store.contentSimilarity('甲乙丙丁戊己庚', '辛壬癸子丑寅卯'), 0)
  assert.ok(store.contentSimilarity(NEAR_A, NEAR_B) >= 0.5, `reworded should be >=0.5, got ${store.contentSimilarity(NEAR_A, NEAR_B)}`)
  assert.ok(store.contentSimilarity(NEAR_A, UNRELATED) < 0.5, `unrelated should be <0.5, got ${store.contentSimilarity(NEAR_A, UNRELATED)}`)
})

test('contentSimilarity: tiny content (<3 features) never matches; case/whitespace insensitive', () => {
  assert.equal(store.contentSimilarity('用 pnpm', '用 pnpm 吧'), 0)
  assert.equal(store.contentSimilarity('', ''), 0)
  assert.equal(store.contentSimilarity('Git PUSH needs proxy', 'git push needs proxy'), 1)
})

// ---------- store：saveEntry 附带 similar ----------

test('saveEntry reports similar near-duplicate (id/content/score), not deduplicated', () => {
  const root = tmpRoot()
  const { entry: first } = store.saveEntry(root, { content: NEAR_A, scope: 'global' })
  const { entry: second, deduplicated, similar } = store.saveEntry(root, { content: NEAR_B, scope: 'global' })
  assert.equal(deduplicated, false)
  assert.ok(Array.isArray(similar) && similar.length >= 1)
  const hit = similar.find((s) => s.id === first.id)
  assert.ok(hit, 'similar should contain the first entry')
  assert.equal(hit.content, NEAR_A)
  assert.ok(hit.score >= 0.5 && hit.score <= 1)
  assert.ok(!similar.some((s) => s.id === second.id), 'must not include itself')
})

test('saveEntry exact duplicate stays deduplicated without similar; unrelated yields empty similar', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: NEAR_A, scope: 'global' })
  const dup = store.saveEntry(root, { content: `  ${NEAR_A}  `, scope: 'global' })
  assert.equal(dup.deduplicated, true)
  assert.ok(!dup.similar || dup.similar.length === 0)
  const other = store.saveEntry(root, { content: UNRELATED, scope: 'global' })
  assert.deepEqual(other.similar, [])
})

test('saveEntry similar excludes the supersede target and hidden entries', () => {
  const root = tmpRoot()
  const { entry: target } = store.saveEntry(root, { content: NEAR_A, scope: 'global' })
  // 显式取代目标：不再把目标当作相似提示（噪音）。
  const sup = store.saveEntry(root, { content: NEAR_B, scope: 'global', supersedes: target.id })
  assert.ok(!sup.similar.some((s) => s.id === target.id))
  // 归档/过期/被取代的条目不参与相似提示。
  const root2 = tmpRoot()
  const { entry: a } = store.saveEntry(root2, { content: NEAR_A, scope: 'global' })
  store.updateEntry(root2, a.id, { archived: true })
  const { entry: b } = store.saveEntry(root2, { content: '项目使用 pnpm 而不是 npm 管理依赖', scope: 'global' })
  store.updateEntry(root2, b.id, { expires: '2020-01-01' })
  const res = store.saveEntry(root2, { content: NEAR_B, scope: 'global' })
  assert.deepEqual(res.similar, [])
})

test('saveEntry similar is scope-local, sorted by score desc, capped at 3', () => {
  const root = tmpRoot()
  const cwd = path.join(os.tmpdir(), 'dsh-memory-similar-ws')
  // 跨作用域不提示：global 的相似条目不影响 workspace 写入。
  store.saveEntry(root, { content: NEAR_A, scope: 'global' })
  const ws = store.saveEntry(root, { content: NEAR_B, scope: 'workspace', cwd })
  assert.deepEqual(ws.similar, [])
  // 同作用域多条相似：按分数倒序、最多 3 条。
  const root2 = tmpRoot()
  const variants = [
    '用户要求所有回复一律使用简体中文',
    '用户要求所有回复都使用简体中文',
    '用户要求全部回复一律使用简体中文',
    '用户要求所有回复一律使用简体中文谢谢',
  ]
  const ids = variants.map((c) => store.saveEntry(root2, { content: c, scope: 'global' }).entry.id)
  const res = store.saveEntry(root2, { content: NEAR_B, scope: 'global' })
  assert.ok(res.similar.length <= 3, `cap 3, got ${res.similar.length}`)
  assert.ok(res.similar.length >= 2, 'should find multiple similar')
  for (let i = 1; i < res.similar.length; i++) assert.ok(res.similar[i - 1].score >= res.similar[i].score)
  assert.ok(res.similar.every((s) => ids.includes(s.id)))
})

// ---------- service：公共 API 贯通 ----------

test('service.save surfaces similar from store (one operation, two callers)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const first = service.save({ content: NEAR_A, scope: 'global', origin: 'manual' })
  const second = service.save({ content: NEAR_B, scope: 'global', origin: 'auto' })
  assert.equal(second.deduplicated, false)
  assert.ok(second.similar.some((s) => s.id === first.entry.id))
})

// ---------- routes：HTTP 形状 ----------

test('POST /save result carries similar array', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const handlers = createHandlers({ service, token: 't-0123456789abcdef', version: '0.11.0-test' })
  const req = (body) => ({
    method: 'POST',
    url: '/plugins/dsh-memory/save',
    headers: { host: '127.0.0.1:50562', 'x-rpc-key': 't-0123456789abcdef' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) },
  })
  const res = () => {
    const r = { statusCode: null, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b ?? '' } }
    r.json = () => JSON.parse(r.body)
    return r
  }
  const r1 = res()
  await handlers.save(req({ content: NEAR_A, scope: 'global', origin: 'manual' }), r1)
  assert.equal(r1.statusCode, 200)
  const firstId = r1.json().result.entry.id
  const r2 = res()
  await handlers.save(req({ content: NEAR_B, scope: 'global', origin: 'auto' }), r2)
  assert.equal(r2.statusCode, 200)
  const doc = r2.json()
  assert.ok(Array.isArray(doc.result.similar))
  assert.ok(doc.result.similar.some((s) => s.id === firstId && typeof s.score === 'number'))
})
