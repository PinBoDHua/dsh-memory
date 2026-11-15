/**
 * dsh-memory v0.29.0 分层召回单测：常驻层（pinned/constraint 完整）→ 索引层
 * （单行摘要，80 字符截断）→ 预算与 omitted 原因（预算不足 / 单条过长）。
 * 运行 Run: node --test tests/render-layers.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_SUMMARY_MAX, renderSection, selectInjection } from '../lib/render.js'

const NOW = Date.parse('2026-11-15T00:00:00.000Z')
const AT = (n) => new Date(NOW - n * 60000).toISOString()

function entry(id, content, extra = {}) {
  return {
    id,
    scope: 'global',
    category: 'fact',
    content,
    updated: AT(0),
    ...extra,
  }
}

const residentLine = (e) => `- [${e.scope}/${e.category}${Array.isArray(e.tags) && e.tags.includes('constraint') ? '/constraint' : ''}] ${e.content} (id: ${e.id})`
const indexLine = (e) => {
  const text = String(e.content).replace(/\s+/g, ' ').trim()
  const summary = text.length > INDEX_SUMMARY_MAX ? `${text.slice(0, INDEX_SUMMARY_MAX)}…` : text
  return `- [${e.scope}/${e.category}] ${summary} (id: ${e.id})`
}

test('layers: pinned/constraint render full and come first; index entries are summarized', () => {
  const long = 'x'.repeat(INDEX_SUMMARY_MAX + 40)
  const entries = [
    entry('m-pin', '钉选事实', { pinned: true, category: 'fact' }),
    entry('m-con', '约束偏好', { tags: ['constraint'], category: 'preference' }),
    entry('m-pref', long, { category: 'preference' }),
  ]
  const sel = selectInjection(entries, { budgetChars: 8000, now: NOW })
  assert.deepEqual(sel.residentSelected.map((e) => e.id), ['m-pin', 'm-con'])
  assert.deepEqual(sel.indexSelected.map((e) => e.id), ['m-pref'])
  assert.deepEqual(sel.selected.map((e) => e.id), ['m-pin', 'm-con', 'm-pref'], 'resident layer precedes index layer')
  const text = renderSection(entries, { budgetChars: 8000, now: NOW })
  assert.ok(text.includes('### 常驻记忆 Resident memories'))
  assert.ok(text.includes('### 记忆索引 Memory index'))
  assert.ok(text.includes('(id: m-pin)') && text.includes('(id: m-con)'), 'resident lines are complete')
  assert.ok(text.includes(`${'x'.repeat(INDEX_SUMMARY_MAX)}…`), 'index content is deterministically truncated')
  assert.ok(!text.includes('x'.repeat(INDEX_SUMMARY_MAX + 1)), 'index must not contain the full oversized text')
})

test('budget accounting: exact fit selects both layers; omitted reasons stay zero', () => {
  const a = entry('m-a', '常驻', { pinned: true })
  const b = entry('m-b', '索引', { category: 'preference' })
  const exact = residentLine(a).length + 1 + indexLine(b).length + 1
  const sel = selectInjection([a, b], { budgetChars: exact, now: NOW })
  assert.equal(sel.usedChars, exact)
  assert.equal(sel.omitted, 0)
  assert.equal(sel.selected.length, 2)
  const tight = selectInjection([a, b], { budgetChars: exact - 1, now: NOW })
  assert.equal(tight.selected.length, 1)
  assert.equal(tight.selected[0].id, 'm-a')
  assert.equal(tight.omitted, 1)
  assert.equal(tight.omittedIndex, 1)
  assert.equal(tight.oversized, 0)
})

test('budget 0 omits everything by budget (not oversized)', () => {
  const sel = selectInjection([entry('m-a', 'x'), entry('m-b', 'y', { pinned: true })], { budgetChars: 0, now: NOW })
  assert.equal(sel.selected.length, 0)
  assert.equal(sel.usedChars, 0)
  assert.equal(sel.omitted, 2)
  assert.equal(sel.oversized, 0)
  assert.equal(sel.omittedResident, 1)
  assert.equal(sel.omittedIndex, 1)
})

test('a single line longer than the budget is counted as oversized and does not block smaller entries', () => {
  const big = entry('m-big', 'z'.repeat(400), { category: 'preference' })
  const small = entry('m-small', '小', { category: 'fact' })
  const sel = selectInjection([big, small], { budgetChars: 80, now: NOW })
  assert.equal(sel.oversized, 1)
  assert.deepEqual(sel.selected.map((e) => e.id), ['m-small'])
  assert.ok(sel.usedChars <= 80)
  const text = renderSection([big, small], { budgetChars: 80, now: NOW })
  assert.ok(/单条过长 1 条/.test(text), text)
  assert.ok(/预算不足 0 条/.test(text) || !/预算不足 0 条/.test(text))
})

test('resident overflow is reported separately from index overflow', () => {
  const pinnedLong = entry('m-pin', 'p'.repeat(200), { pinned: true })
  const index = entry('m-idx', '普通条目')
  const constraint = entry('m-con', '约束', { tags: ['constraint'], category: 'preference' })
  const budget = residentLine(constraint).length + 1 + indexLine(index).length + 1
  const sel = selectInjection([pinnedLong, index, constraint], { budgetChars: budget, now: NOW })
  assert.equal(sel.oversized, 1, 'pinned line longer than the whole budget')
  assert.equal(sel.omittedResident, 0)
  assert.deepEqual(sel.selected.map((e) => e.id), ['m-con', 'm-idx'])
  const tighter = selectInjection([pinnedLong, index, constraint], { budgetChars: residentLine(constraint).length + 1, now: NOW })
  assert.deepEqual(tighter.selected.map((e) => e.id), ['m-con'])
  assert.equal(tighter.omittedIndex, 1)
})

test('500-entry library: deterministic selection, budget never exceeded, omitted math consistent', () => {
  const entries = []
  for (let i = 0; i < 500; i += 1) {
    const isResident = i % 50 === 0
    entries.push({
      id: `m-${String(i).padStart(4, '0')}`,
      scope: i % 3 === 0 ? 'global' : 'workspace',
      category: i % 5 === 0 ? 'preference' : i % 7 === 0 ? 'decision' : 'fact',
      content: isResident ? `常驻条目 ${i} ${'a'.repeat(20)}` : `索引条目 ${i} ${'b'.repeat(180)}`,
      pinned: isResident && i % 100 === 0,
      tags: isResident && i % 100 !== 0 ? ['constraint'] : [],
      updated: AT(i),
    })
  }
  const first = selectInjection(entries, { budgetChars: 8000, now: NOW })
  const second = selectInjection(entries, { budgetChars: 8000, now: NOW })
  assert.deepEqual(first.selected.map((e) => e.id), second.selected.map((e) => e.id), 'selection is deterministic')
  assert.ok(first.usedChars <= 8000, `usedChars ${first.usedChars} must fit budget`)
  assert.equal(first.selected.length + first.omitted, 500, 'every active entry is either selected or counted omitted')
  assert.equal(first.omitted, first.omittedResident + first.omittedIndex + first.oversized)
  assert.ok(first.residentSelected.length >= 1, 'resident entries are prioritized')
  assert.ok(first.indexSelected.some((e) => e.id !== first.residentSelected[0].id), 'index layer fills remaining budget')
  // 预算更大时必须单调不减少选中数。
  const bigger = selectInjection(entries, { budgetChars: 20000, now: NOW })
  assert.ok(bigger.selected.length >= first.selected.length)
})
