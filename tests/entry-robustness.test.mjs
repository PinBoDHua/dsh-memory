/**
 * dsh-memory 0.24.8：条目解析/删除健壮性回归。
 * - 文件名是 id 权威（复制/改名/手改 frontmatter 不再误删/误写另一条）；
 * - UTF-8 BOM + CRLF（Windows 记事本保存）可解析、可检索、可删除；
 * - 损坏文件可按 id 删除（不再残留不可管理的孤儿文件）；
 * - forget 清理 access.json 账本余影（重新导入同 id 不继承幽灵命中）；
 * - 解析缓存签名含 ino/birthtime：Windows 时间戳 tick 碰撞也不返回陈旧内容。
 * 运行 Run: node --test tests/entry-robustness.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-robust-'))
  return { root, service: createMemoryService({ root }) }
}

function entryText({ id, content, scope = 'global', tags = [], created, updated }) {
  const now = created ?? new Date().toISOString()
  return [
    '---',
    `id: ${id}`,
    'category: fact',
    `scope: ${scope}`,
    `tags: ${JSON.stringify(tags)}`,
    `created: ${now}`,
    `updated: ${updated ?? now}`,
    'source: ',
    '---',
    '',
    content,
    '',
  ].join('\n')
}

test('file name is authoritative over frontmatter id (copy/rename safety)', () => {
  const { root, service } = tmpService()
  const globalDir = path.join(root, 'global')
  fs.mkdirSync(globalDir, { recursive: true })
  const now = new Date().toISOString()
  // 模拟复制/改名/手改后 frontmatter id 与实际文件名不一致。
  fs.writeFileSync(path.join(globalDir, 'm-real-b.md'), entryText({ id: 'm-real-b', content: '真实条目', created: now }))
  fs.writeFileSync(path.join(globalDir, 'm-copy-a.md'), entryText({ id: 'm-real-b', content: '复制条目', created: now }))

  const list = service.list({ scope: 'global' })
  assert.deepEqual(list.map((e) => e.id).sort(), ['m-copy-a', 'm-real-b'], 'distinct ids, no duplicated frontmatter id')

  // 删除 m-copy-a 只删同名文件，不碰 m-real-b。
  service.forget({ id: 'm-copy-a' })
  assert.ok(fs.existsSync(path.join(globalDir, 'm-real-b.md')), 'real entry kept')
  assert.ok(!fs.existsSync(path.join(globalDir, 'm-copy-a.md')), 'target file removed')

  // 更新 m-real-b 只改同名文件，并把 frontmatter id 修正为文件名。
  service.update({ id: 'm-real-b', content: '真实条目更新' })
  const text = fs.readFileSync(path.join(globalDir, 'm-real-b.md'), 'utf8')
  assert.ok(text.includes('真实条目更新'))
  assert.match(text, /^id: m-real-b$/m)
})

test('BOM + CRLF hand-edited entries are parsed, searchable and deletable', () => {
  const { root, service } = tmpService()
  const globalDir = path.join(root, 'global')
  fs.mkdirSync(globalDir, { recursive: true })
  const bomCrlf = entryText({ id: 'm-bad-frontmatter', content: '记事本保存的记忆', tags: ['记事本'] })
    .replace(/^\uFEFF?/, '\uFEFF')
    .replace(/\n/g, '\r\n')
  fs.writeFileSync(path.join(globalDir, 'm-bom-1.md'), bomCrlf, 'utf8')

  const list = service.list({ scope: 'global' })
  assert.equal(list.length, 1, 'BOM entry is parsed instead of silently skipped')
  assert.equal(list[0].id, 'm-bom-1', 'file name wins over frontmatter id')
  assert.equal(list[0].content, '记事本保存的记忆')
  assert.deepEqual(service.search({ query: '记事本', scope: 'global' }).map((e) => e.id), ['m-bom-1'])
  assert.equal(service.forget({ id: 'm-bom-1' }).deleted, true)
  assert.ok(!fs.existsSync(path.join(globalDir, 'm-bom-1.md')))
})

test('damaged files can be forgotten by id (no orphan residue)', () => {
  const { root, service } = tmpService()
  service.save({ content: '正常条目', scope: 'global' })
  const broken = path.join(root, 'global', 'm-broken-9.md')
  fs.writeFileSync(broken, 'this is not frontmatter at all', 'utf8')
  assert.equal(service.list({ scope: 'global' }).some((e) => e.id === 'm-broken-9'), false)
  assert.deepEqual(service.forget({ id: 'm-broken-9' }), { id: 'm-broken-9', deleted: true })
  assert.ok(!fs.existsSync(broken), 'damaged file removed')
  assert.throws(() => service.forget({ id: 'm-does-not-exist' }), (err) => err.code === 'not-found')
})

test('forget clears the access ledger; re-importing the same id starts with clean hits', () => {
  const { root, service } = tmpService()
  const saved = service.save({ content: '幽灵命中事实', scope: 'global' })
  service.search({ query: '幽灵命中', scope: 'global' })
  const accessFile = path.join(root, 'access.json')
  assert.ok(JSON.parse(fs.readFileSync(accessFile, 'utf8'))[saved.entry.id], 'ledger recorded')

  service.forget({ id: saved.entry.id })
  assert.equal(JSON.parse(fs.readFileSync(accessFile, 'utf8'))[saved.entry.id], undefined, 'ledger record removed')

  const res = service.import({ entries: [{ id: saved.entry.id, content: '重新导入的新内容', scope: 'global' }] })
  assert.equal(res.imported, 1)
  const entry = service.list({ scope: 'global' }).find((e) => e.id === saved.entry.id)
  assert.ok(entry)
  assert.equal(entry.hit_count, undefined, 'no ghost hits')
  assert.equal(entry.last_access, undefined)
})

test('forgetting a damaged successor restores predecessors (no dangling superseded_by)', () => {
  const { root, service } = tmpService()
  const globalDir = path.join(root, 'global')
  fs.mkdirSync(globalDir, { recursive: true })
  const now = new Date().toISOString()
  // 前驱 X 指向一个无法解析的坏文件 Y；若 forget(Y) 不清理指针，X 会永久隐藏。
  store.writeEntry(root, {
    id: 'm-pred-1',
    category: 'fact',
    scope: 'global',
    tags: [],
    created: now,
    updated: now,
    source: '',
    content: '前驱记忆',
    superseded_by: 'm-broken-9',
  })
  fs.writeFileSync(path.join(globalDir, 'm-broken-9.md'), 'not frontmatter at all', 'utf8')
  assert.equal(service.forget({ id: 'm-broken-9' }).deleted, true)
  assert.ok(service.search({ scope: 'global' }).some((e) => e.id === 'm-pred-1'), 'predecessor visible again')
  assert.equal(store.findEntry(root, 'm-pred-1', undefined).superseded_by, undefined)
})

test('entry cache invalidates on inode change even when mtime/ctime/size collide', () => {
  const { root, service } = tmpService()
  store.clearEntryCache()
  const saved = service.save({ content: '缓存碰撞甲', scope: 'global' })
  const file = path.join(root, 'global', `${saved.entry.id}.md`)
  // 首次读取填充缓存。
  assert.equal(service.list({ scope: 'global' })[0].content, '缓存碰撞甲')
  // 同字节长度原地改写（模拟 Windows 同一文件时间 tick 内的写）。
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('缓存碰撞甲', '缓存碰撞乙'), 'utf8')
  const original = fs.statSync
  const basename = path.basename(file)
  // 无论 store 传绝对路径还是相对路径都命中补丁：inode 强制 +1，保证签名必然不同。
  fs.statSync = function (target, ...args) {
    const current = original.call(this, target, ...args)
    if (String(target) === file || String(target).endsWith(basename)) {
      return { ...current, ino: Number(current.ino) + 1 }
    }
    return current
  }
  try {
    const after = service.list({ scope: 'global' })[0]
    assert.equal(after.content, '缓存碰撞乙', 'inode change must invalidate cache despite colliding timestamps')
  } finally {
    fs.statSync = original
  }
})