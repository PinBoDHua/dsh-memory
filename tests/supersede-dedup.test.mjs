/**
 * dsh-memory 第九轮审计回归：save 去重命中时的取代指针改向/撤销（H1）、显式空
 * 标签（H7）、跨作用域移动时的取代清除语义（H6）。三者共同的不变量：
 * 旧目标的反向指针必须被解除，不允许「无人指向却永久隐藏」的搁浅条目。
 * 运行 Run: node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

const WS = path.join(os.tmpdir(), 'dsh-memory-dedup-ws')

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-dedup-'))
  return { root, service: createMemoryService({ root }) }
}

test('H1: save dedup retargets supersedes and un-hides the old target', () => {
  const { root, service } = tmpService()
  const old = service.save({ content: '旧口径事实', scope: 'global', origin: 'manual' })
  const next = service.save({ content: '新口径事实', scope: 'global', origin: 'manual' })
  // 第一次：E 取代 O。
  const first = service.save({ content: '去重改向条目', scope: 'global', origin: 'manual', supersedes: old.entry.id })
  assert.equal(first.deduplicated, false)
  assert.ok(store.findEntry(root, old.entry.id).superseded_by, 'old target hidden after first supersede')
  // 第二次（同内容 → 去重命中）：显式 supersedes 改向 N。
  const second = service.save({ content: '去重改向条目', scope: 'global', origin: 'manual', supersedes: next.entry.id })
  assert.equal(second.deduplicated, true)
  assert.equal(second.applied, true, 'explicit supersede applied on the dedup path')
  const e = store.findEntry(root, second.entry.id)
  assert.equal(e.supersedes, next.entry.id, 'pointer retargeted')
  assert.equal(store.findEntry(root, next.entry.id).superseded_by, e.id, 'new target hidden')
  assert.equal(store.findEntry(root, old.entry.id).superseded_by, undefined, 'old target un-hidden (no stranded entry)')
})

test('H1: save dedup with supersedes="" clears the chain and restores the old target', () => {
  const { root, service } = tmpService()
  const old = service.save({ content: '撤销取代目标', scope: 'global', origin: 'manual' })
  service.save({ content: '撤销取代条目', scope: 'global', origin: 'manual', supersedes: old.entry.id })
  const second = service.save({ content: '撤销取代条目', scope: 'global', origin: 'manual', supersedes: '' })
  assert.equal(second.deduplicated, true)
  const e = store.findEntry(root, second.entry.id)
  assert.equal(e.supersedes, undefined, 'pointer cleared')
  assert.equal(store.findEntry(root, old.entry.id).superseded_by, undefined, 'old target visible again')
})

test('H7: save dedup applies an explicit empty tags array (clears tags)', () => {
  const { root, service } = tmpService()
  service.save({ content: '清空标签条目', scope: 'global', origin: 'manual', tags: ['旧标签'] })
  const second = service.save({ content: '清空标签条目', scope: 'global', origin: 'manual', tags: [] })
  assert.equal(second.deduplicated, true)
  assert.deepEqual(store.findEntry(root, second.entry.id).tags, [], 'tags cleared via explicit empty array')
})

test('H6: move with supersedes="" clears the pointer and un-hides the old target', () => {
  const { root, service } = tmpService()
  const old = service.save({ content: '移动撤销旧目标', scope: 'global', origin: 'manual' })
  const moving = service.save({ content: '移动撤销条目', scope: 'workspace', workspace: WS, origin: 'manual', supersedes: old.entry.id })
  assert.ok(store.findEntry(root, old.entry.id).superseded_by, 'old target hidden before the move')
  // 移动到 global 同时显式撤销取代：旧实现静默丢弃 supersedes=''，条目带着指针搬家。
  const moved = service.update({ id: moving.entry.id, scope: 'global', supersedes: '', workspace: WS })
  assert.equal(moved.scope, 'global')
  assert.equal(moved.supersedes, undefined, 'pointer cleared on move')
  assert.equal(store.findEntry(root, old.entry.id).superseded_by, undefined, 'old target restored to visible')
})

test('H6: move with superseded_by="" clears a dangling hidden flag instead of carrying it over', () => {
  const { root, service } = tmpService()
  const marked = service.save({ content: '悬垂前驱条目', scope: 'global', origin: 'manual' })
  service.save({ content: '悬垂后继条目', scope: 'global', origin: 'manual', supersedes: marked.entry.id })
  // marked 是被取代的一方：带 superseded_by=后继（默认隐藏）。
  const before = store.findEntry(root, marked.entry.id, undefined)
  assert.ok(before.superseded_by, 'entry starts hidden via superseded_by')
  // 移动（global → workspace）同时显式清除悬垂标记：旧实现把 superseded_by=''
  // 静默丢弃，条目带着「已被取代」标记搬家、继续隐藏。
  const moved = service.update({ id: marked.entry.id, scope: 'workspace', workspace: WS, superseded_by: '' })
  assert.equal(moved.scope, 'workspace')
  assert.equal(moved.superseded_by, undefined, 'dangling superseded_by cleared on move')
  const after = store.findEntry(root, marked.entry.id, WS)
  assert.equal(after.superseded_by, undefined, 'moved entry is visible in the new scope')
})
