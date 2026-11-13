/**
 * dsh-memory 0.23.0：工具输出渲染纯函数回归测试（行为保持＋lossless JSON）。
 * 提取自 memory_save/search/update/forget 的 render，防止 v0.13 式输出回归。
 * 运行 Run: node --test tests/tool-render.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSaveResult, renderSearchResult, renderUpdateResult, renderForgetResult } from '../index.js'

test('renderSaveResult: saved / deduplicated / similar hint', () => {
  const saved = renderSaveResult({ id: 'm-1', category: 'fact', scope: 'global', origin: 'auto', deduplicated: false })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].type, 'text')
  assert.ok(saved[0].text.includes('已记录记忆 m-1'))
  assert.ok(saved[0].text.includes('fact/global/auto'))
  const dup = renderSaveResult({ id: 'm-1', deduplicated: true })
  assert.ok(dup[0].text.includes('已有相同记忆'))
  const sim = renderSaveResult({ id: 'm-2', category: 'fact', scope: 'global', origin: 'manual', deduplicated: false, similar: [{ id: 'm-old', content: '相似内容', score: 0.8 }] })
  assert.ok(sim[0].text.includes('检测到 1 条相似记忆'))
  assert.ok(sim[0].text.includes('m-old'))
  assert.ok(sim[0].text.includes('0.8'))
})

test('renderSaveResult truncates long similar content to 40 chars', () => {
  const long = 'a'.repeat(60)
  const sim = renderSaveResult({ id: 'm-2', category: 'fact', scope: 'global', origin: 'manual', deduplicated: false, similar: [{ id: 'm-old', content: long, score: 0.9 }] })
  assert.ok(sim[0].text.includes('a'.repeat(40) + '…'))
  assert.ok(!sim[0].text.includes('a'.repeat(41)))
})

test('renderSearchResult: empty / hidden-only / entries with marks / hidden note', () => {
  const empty = renderSearchResult({ entries: [], hidden: { total: 0 } })
  assert.ok(empty[0].text.includes('没有匹配的记忆'))
  const hiddenOnly = renderSearchResult({ entries: [], hidden: { total: 2, superseded: 1, expired: 1, archived: 0 } })
  assert.ok(hiddenOnly[0].text.includes('没有可见的匹配记忆'))
  assert.ok(hiddenOnly[0].text.includes('另有 2 条匹配被隐藏'))
  const withEntries = renderSearchResult({ entries: [{ id: 'm-1', category: 'fact', scope: 'global', content: '内容', updated: '2026-01-01', pinned: true }], hidden: { total: 0 } })
  assert.ok(withEntries[0].text.includes('- [fact/global; pinned] 内容'))
  assert.ok(withEntries[0].text.includes('id: m-1'))
})

test('renderUpdateResult / renderForgetResult produce expected text', () => {
  assert.ok(renderUpdateResult({ id: 'm-1', scope: 'global' })[0].text.includes('已更新记忆 m-1 [global]'))
  assert.ok(renderForgetResult({ id: 'm-1' })[0].text.includes('已忘记记忆 m-1'))
})

test('tool render outputs are lossless JSON', () => {
  const outputs = [
    renderSaveResult({ id: 'm-1', category: 'fact', scope: 'global', origin: 'auto', deduplicated: false, similar: [{ id: 'm-o', content: 'x', score: 0.7 }] }),
    renderSearchResult({ entries: [{ id: 'm-1', category: 'fact', scope: 'global', content: 'c', updated: 'u' }], hidden: { total: 1, superseded: 1, expired: 0, archived: 0 } }),
    renderUpdateResult({ id: 'm-1', scope: 'global' }),
    renderForgetResult({ id: 'm-1' }),
  ]
  for (const o of outputs) assert.equal(JSON.stringify(JSON.parse(JSON.stringify(o))), JSON.stringify(o))
})
