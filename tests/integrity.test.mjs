/**
 * dsh-memory 0.24.2：数据一致性加固回归。
 * - 取代链不变量：禁止覆盖已有后继、禁止成环、forget 清理双向悬垂引用；
 * - move + supersedes 不再静默丢弃；
 * - touchAccess 写前重读，旧快照不回写正文；
 * - frontmatter scope 不再覆盖目录作用域（手改/错放文件可正确删除与更新）。
 * 运行 Run: node --test tests/integrity.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-integrity-'))
}

test('supersede rejects a target that already has a successor (no chain overwrite)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const old = service.save({ content: '旧决定', scope: 'global' })
  const first = service.save({ content: '新决定甲', scope: 'global', supersedes: old.entry.id })
  // 第二条「取代旧决定」必须被拒，而不是悄悄覆盖 old.superseded_by。
  assert.throws(
    () => service.save({ content: '新决定乙', scope: 'global', supersedes: old.entry.id }),
    (err) => err.code === 'invalid' && /已被取代|already superseded/.test(err.message),
  )
  assert.equal(store.findEntry(root, old.entry.id, undefined).superseded_by, first.entry.id)
  assert.equal(service.search({ query: '新决定', scope: 'global' }).length, 1)
})

test('update rejects supersede cycles (A supersedes B, then B supersedes A)', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const b = service.save({ content: '乙事实', scope: 'global' })
  const a = service.save({ content: '甲事实', scope: 'global', supersedes: b.entry.id })
  assert.throws(
    () => service.update({ id: b.entry.id, supersedes: a.entry.id }),
    (err) => err.code === 'invalid' && /取代环|cycle/.test(err.message),
  )
  // 两条都仍可见性一致：甲可见、乙被取代隐藏，而不是互取代一起消失。
  assert.equal(service.search({ query: '事实', scope: 'global' }).length, 1)
  assert.equal(service.search({ query: '事实', scope: 'global', includeSuperseded: true }).length, 2)
})

test('update rejects self-supersede and already-superseded target', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const old = service.save({ content: '旧内容', scope: 'global' })
  const neu = service.save({ content: '新内容', scope: 'global', supersedes: old.entry.id })
  const other = service.save({ content: '无关内容', scope: 'global' })
  assert.throws(() => service.update({ id: neu.entry.id, supersedes: neu.entry.id }), (err) => err.code === 'invalid' && /自身|itself/.test(err.message))
  // 旁观条目不得覆盖已有的取代链。
  assert.throws(() => service.update({ id: other.entry.id, supersedes: old.entry.id }), (err) => err.code === 'invalid' && /已被取代|already superseded/.test(err.message))
})

test('forget the successor restores the superseded entry and clears dangling references', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const old = service.save({ content: '旧 API 约定', scope: 'global' })
  const neu = service.save({ content: '新 API 约定', scope: 'global', supersedes: old.entry.id })
  assert.equal(service.search({ query: 'API 约定', scope: 'global' }).length, 1)
  service.forget({ id: neu.entry.id })
  // 旧条目重新可见，且不再指向已删除的 id。
  const visible = service.search({ query: 'API 约定', scope: 'global' })
  assert.equal(visible.length, 1)
  assert.equal(visible[0].id, old.entry.id)
  assert.equal(visible[0].superseded_by, undefined)
  assert.equal(visible[0].superseded_at, undefined)
  assert.equal(store.findEntry(root, old.entry.id, undefined).superseded_by, undefined)
})

test('forget an old superseded entry clears the successor supersedes pointer', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const old = service.save({ content: '待删除旧事实', scope: 'global' })
  const neu = service.save({ content: '后继事实', scope: 'global', supersedes: old.entry.id })
  service.forget({ id: old.entry.id })
  const successor = store.findEntry(root, neu.entry.id, undefined)
  assert.ok(successor)
  assert.equal(successor.supersedes, undefined)
})

test('cross-scope supersede then forget restores the global entry', () => {
  const root = tmpRoot()
  const cwd = 'D:\\proj\\integrity-alpha'
  const service = createMemoryService({ root })
  const globalEntry = service.save({ content: '全局约定', scope: 'global' })
  const workspaceEntry = service.save({ content: '工作区新约定', scope: 'workspace', workspace: cwd, supersedes: globalEntry.entry.id })
  assert.equal(store.findEntry(root, globalEntry.entry.id, cwd).superseded_by, workspaceEntry.entry.id)
  service.forget({ id: workspaceEntry.entry.id, workspace: cwd })
  const restored = store.findEntry(root, globalEntry.entry.id, cwd)
  assert.equal(restored.superseded_by, undefined)
})

test('re-superseding a different target clears the previous back-reference', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const a = service.save({ content: '旧事实甲', scope: 'global' })
  const b = service.save({ content: '旧事实乙', scope: 'global' })
  const n = service.save({ content: '新事实', scope: 'global', supersedes: a.entry.id })
  // 改取代目标：乙成为新的后继，甲恢复可见、不再挂着已被放弃的反向引用。
  const updated = service.update({ id: n.entry.id, supersedes: b.entry.id })
  assert.equal(updated.supersedes, b.entry.id)
  assert.equal(store.findEntry(root, b.entry.id, undefined).superseded_by, n.entry.id)
  assert.equal(store.findEntry(root, a.entry.id, undefined).superseded_by, undefined)
  // 对同一目标重复声明取代是幂等的（不报错、不重复写坏）。
  service.update({ id: n.entry.id, supersedes: b.entry.id })
  assert.equal(store.findEntry(root, b.entry.id, undefined).superseded_by, n.entry.id)
})

test('move to another scope can create a supersede chain (previously silently dropped)', () => {
  const root = tmpRoot()
  const cwd = 'D:\\proj\\integrity-beta'
  const service = createMemoryService({ root })
  const target = service.save({ content: '被取代的旧条目', scope: 'global' })
  const moving = service.save({ content: '移动并取代', scope: 'workspace', workspace: cwd })
  const moved = service.update({ id: moving.entry.id, scope: 'global', supersedes: target.entry.id, workspace: cwd })
  assert.equal(moved.scope, 'global')
  assert.equal(moved.supersedes, target.entry.id)
  const targetAfter = store.findEntry(root, target.entry.id, cwd)
  assert.equal(targetAfter.superseded_by, moving.entry.id)
  assert.deepEqual(service.list({ scope: 'workspace', workspace: cwd }), [])
})

test('touchAccess re-reads before writing: stale snapshot never clobbers newer content', () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  const saved = service.save({ content: '原始内容', scope: 'global' })
  // 检索拿到快照后，另一路写入更新内容（模拟并发进程/面板编辑）。
  const staleSnapshot = service.list({ scope: 'global' })[0]
  service.update({ id: saved.entry.id, content: '更新后的内容' })
  store.touchAccess(root, [staleSnapshot], undefined, Date.parse('2026-11-13T12:00:00Z'))
  const after = store.findEntry(root, saved.entry.id, undefined)
  assert.equal(after.content, '更新后的内容')
  assert.equal(after.hit_count, 1)
  assert.equal(after.last_access, '2026-11-13T12:00:00.000Z')
})

test('directory scope wins over hand-edited frontmatter scope', () => {
  const root = tmpRoot()
  const cwd = 'D:\\proj\\integrity-gamma'
  store.saveEntry(root, { content: '正常写入', scope: 'workspace', cwd })
  const dir = path.join(root, 'workspaces', store.workspaceKey(cwd))
  const id = 'm-mismatch-aaaaaa'
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    'category: fact',
    'scope: global', // 错放：文件在 workspace 目录却写 global
    'tags: []',
    `created: ${now}`,
    `updated: ${now}`,
    'source: ',
    '---',
    '',
    '错放目录的手工条目',
    '',
  ].join('\n'), 'utf8')
  const found = store.findEntry(root, id, cwd)
  assert.equal(found.scope, 'workspace')
  assert.equal(store.listScope(root, 'global', undefined).some((e) => e.id === id), false)
  assert.equal(store.forgetEntry(root, id, cwd), true)
  assert.equal(fs.existsSync(path.join(dir, `${id}.md`)), false, 'forget really deletes the workspace file')
})