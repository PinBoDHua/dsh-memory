/**
 * dsh-memory 0.24.9：导出/导入保真（权威 workspaceKey）。
 * 导出为工作区条目附 `workspaceKey`（目录 key），导入优先按 key 落盘：
 * - 索引损坏/缺失（workspace=null）不再被 no-workspace 拒绝、备份不丢条目；
 * - 索引陈旧（cwd 指错）不会把条目恢复到错误工作区；
 * - 旧导出（无 workspaceKey）按 cwd 照常导入；merge 模式也可按 key 合并。
 * 运行 Run: node --test tests/export-key.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

const WS_A = path.join(os.tmpdir(), 'dsh-memory-key-alpha')
const WS_B = path.join(os.tmpdir(), 'dsh-memory-key-beta')

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-key-'))
  return { root, service: createMemoryService({ root }) }
}

function seed(service) {
  service.save({ content: '全局约定', scope: 'global', origin: 'manual' })
  service.save({ content: 'alpha 记忆', scope: 'workspace', workspace: WS_A, origin: 'manual' })
  service.save({ content: 'beta 记忆', scope: 'workspace', workspace: WS_B, origin: 'manual' })
}

function namesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return []
  }
}

test('export carries authoritative workspaceKey (null for global)', () => {
  const { service } = tmpService()
  seed(service)
  const doc = service.export({ scope: 'all' })
  const globalEntry = doc.entries.find((e) => e.scope === 'global')
  assert.equal(globalEntry.workspaceKey, null)
  for (const entry of doc.entries.filter((e) => e.scope === 'workspace')) {
    assert.match(String(entry.workspaceKey), /^[a-f0-9]{16}$/)
  }
  const alpha = doc.entries.find((e) => e.content === 'alpha 记忆')
  assert.equal(alpha.workspaceKey, store.workspaceKey(WS_A))
  assert.equal(alpha.workspace, store.normalizeCwd(WS_A))
})

test('corrupt index: export → import restores every entry by workspaceKey', () => {
  const a = tmpService()
  seed(a.service)
  fs.writeFileSync(path.join(a.root, 'workspaces', 'index.json'), '{broken', 'utf8')
  const doc = a.service.export({ scope: 'all' })
  assert.equal(doc.entries.length, 3)
  assert.ok(doc.entries.filter((e) => e.scope === 'workspace').every((e) => e.workspace === null), 'index corrupt => cwd unknown in doc')

  const b = tmpService()
  const res = b.service.import({ entries: doc.entries })
  assert.equal(res.imported, 3)
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected))
  assert.equal(namesIn(path.join(b.root, 'global')).length, 1)
  assert.equal(namesIn(path.join(b.root, 'workspaces', store.workspaceKey(WS_A))).length, 1)
  assert.equal(namesIn(path.join(b.root, 'workspaces', store.workspaceKey(WS_B))).length, 1)
  assert.equal(store.listWorkspaceKey(b.root, store.workspaceKey(WS_A))[0].content, 'alpha 记忆')
})

test('stale index: entries still restore to their original key directories, not the stale cwd', () => {
  const a = tmpService()
  seed(a.service)
  const indexFile = path.join(a.root, 'workspaces', 'index.json')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const alphaKey = store.workspaceKey(WS_A)
  const betaKey = store.workspaceKey(WS_B)
  index[alphaKey].cwd = WS_B // 陈旧索引：alpha 目录指向 beta 的 cwd
  fs.writeFileSync(indexFile, JSON.stringify(index), 'utf8')
  const doc = a.service.export({ scope: 'all' })
  const alphaDoc = doc.entries.find((e) => e.content === 'alpha 记忆')
  assert.equal(alphaDoc.workspaceKey, alphaKey, 'authoritative key survives stale index')

  const b = tmpService()
  const res = b.service.import({ entries: doc.entries })
  assert.equal(res.imported, 3)
  assert.equal(store.listWorkspaceKey(b.root, alphaKey)[0].content, 'alpha 记忆')
  assert.equal(store.listWorkspaceKey(b.root, betaKey)[0].content, 'beta 记忆')
})

test('legacy export without workspaceKey still imports by cwd (backward compatible)', () => {
  const a = tmpService()
  seed(a.service)
  const legacy = a.service.export({ scope: 'all' }).entries.map(({ workspaceKey, ...rest }) => {
    void workspaceKey
    return rest
  })
  const b = tmpService()
  const res = b.service.import({ entries: legacy })
  assert.equal(res.imported, 3)
  assert.equal(res.rejected.length, 0)
  assert.equal(store.listWorkspaceKey(b.root, store.workspaceKey(WS_A))[0].content, 'alpha 记忆')
})

test('import accepts workspaceKey without cwd (no more no-workspace rejection)', () => {
  const key = store.workspaceKey(WS_A)
  const b = tmpService()
  const res = b.service.import({ entries: [{ id: 'm-keyonly-1', content: '只有 key 的条目', scope: 'workspace', workspaceKey: key }] })
  assert.equal(res.imported, 1)
  assert.equal(res.rejected.length, 0)
  assert.equal(store.listWorkspaceKey(b.root, key)[0].id, 'm-keyonly-1')
})

test('merge mode merges by workspaceKey when cwd is unknown', () => {
  const a = tmpService()
  seed(a.service)
  const doc = a.service.export({ scope: 'all' })
  const alphaDoc = doc.entries.find((e) => e.content === 'alpha 记忆')
  const res = a.service.import({ mode: 'merge', entries: [{ ...alphaDoc, workspace: undefined, content: 'alpha 记忆（更新）' }] })
  assert.equal(res.updated, 1)
  assert.equal(res.imported, 0)
  assert.equal(store.listWorkspaceKey(a.root, store.workspaceKey(WS_A))[0].content, 'alpha 记忆（更新）')
})