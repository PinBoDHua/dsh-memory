/**
 * 缝 4：客户端纯逻辑 —— client.js UMD 尾部导出的纯函数。
 * React 渲染与真实 fetch 不在此测试（live 验证覆盖）。
 * 运行 Run: node --test tests/client.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import helpers from '../client/client.js'

const { validateDraft, groupEntries, nextToken, buildEntriesQuery, workspaceOptions, errorKeyFor, validateImportDoc, importSummary, pageSlice, entryDetailRows, relativeTime, formatBytes, isExpired, statusOf, originOf, statusQueryFlags, matchesFilters } = helpers

test('validateDraft accepts a complete draft and rejects bad ones', () => {
  assert.deepEqual(validateDraft({ content: '一条事实', category: 'fact' }), { ok: true })
  assert.deepEqual(validateDraft({ content: 'x' }), { ok: true })
  assert.deepEqual(validateDraft({ content: '   ', category: 'fact' }), { ok: false, error: 'empty-content' })
  assert.deepEqual(validateDraft({ content: 'x', category: 'bogus' }), { ok: false, error: 'bad-category' })
  assert.deepEqual(validateDraft({ content: 'x', expires: '' }), { ok: true })
  assert.deepEqual(validateDraft({ content: 'x', expires: '2026-12-01' }), { ok: true })
  assert.deepEqual(validateDraft({ content: 'x', expires: '2026-12-1' }), { ok: false, error: 'bad-expires' })
  assert.deepEqual(validateDraft({ content: 'x', expires: '2026-02-30' }), { ok: false, error: 'bad-expires' })
  assert.deepEqual(validateDraft({ content: 'x', expires: 'garbage' }), { ok: false, error: 'bad-expires' })
})

test('groupEntries splits by scope preserving order', () => {
  const a = { id: 'm-1', scope: 'global', content: 'a' }
  const b = { id: 'm-2', scope: 'workspace', content: 'b' }
  const c = { id: 'm-3', scope: 'global', content: 'c' }
  assert.deepEqual(groupEntries([a, b, c]), { global: [a, c], workspace: [b] })
  assert.deepEqual(groupEntries([]), { global: [], workspace: [] })
})

test('nextToken refreshes from payload, clears on 403, otherwise keeps', () => {
  assert.equal(nextToken('old', { status: 200, payload: { key: 'new' } }), 'new')
  assert.equal(nextToken('old', { status: 403, payload: { error: 'unauthorized' } }), '')
  assert.equal(nextToken('old', { status: 200, payload: { entries: [] } }), 'old')
  assert.equal(nextToken('', { status: 200, payload: { key: 'first' } }), 'first')
  assert.equal(nextToken('old', { status: 500, payload: null }), 'old')
})

test('buildEntriesQuery encodes values and omits empty params', () => {
  assert.equal(buildEntriesQuery({}), '?scope=all')
  assert.equal(
    buildEntriesQuery({ scope: 'workspace', workspace: 'D:\\proj\\alpha', query: 'pnpm 构建' }),
    '?scope=workspace&workspace=D%3A%5Cproj%5Calpha&query=pnpm%20%E6%9E%84%E5%BB%BA',
  )
  assert.equal(buildEntriesQuery({ category: 'fact', limit: 5 }), '?scope=all&category=fact&limit=5')
  assert.equal(buildEntriesQuery({ limit: 51, offset: 50 }), '?scope=all&limit=51&offset=50')
  assert.equal(buildEntriesQuery({ limit: 51, offset: 0 }), '?scope=all&limit=51')
  assert.equal(buildEntriesQuery({ include_superseded: true }), '?scope=all&include_superseded=true')
  assert.equal(buildEntriesQuery({ include_expired: true, include_archived: true }), '?scope=all&include_expired=true&include_archived=true')
  assert.equal(buildEntriesQuery({ category: 'fact', include_superseded: true, limit: 5 }), '?scope=all&category=fact&include_superseded=true&limit=5')
  assert.equal(buildEntriesQuery({ include_superseded: false }), '?scope=all')
})

test('pageSlice splits items and detects a next page', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(pageSlice(rows, 2), { items: [{ id: 'a' }, { id: 'b' }], hasMore: true })
  assert.deepEqual(pageSlice(rows, 3), { items: rows, hasMore: false })
  assert.deepEqual(pageSlice(rows, 5), { items: rows, hasMore: false })
  assert.deepEqual(pageSlice([], 2), { items: [], hasMore: false })
  assert.deepEqual(pageSlice(null, 2), { items: [], hasMore: false })
})

test('relativeTime renders zh/en buckets and falls back to a date', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  const at = (ms) => new Date(now - ms).toISOString()
  assert.equal(relativeTime(at(10_000), now, 'zh'), '刚刚')
  assert.equal(relativeTime(at(10_000), now, 'en'), 'just now')
  assert.equal(relativeTime(at(5 * 60_000), now, 'zh'), '5 分钟前')
  assert.equal(relativeTime(at(5 * 60_000), now, 'en'), '5 min ago')
  assert.equal(relativeTime(at(3 * 3_600_000), now, 'zh'), '3 小时前')
  assert.equal(relativeTime(at(3 * 3_600_000), now, 'en'), '3 h ago')
  assert.equal(relativeTime(at(2 * 86_400_000), now, 'zh'), '2 天前')
  assert.equal(relativeTime(at(2 * 86_400_000), now, 'en'), '2 d ago')
  assert.equal(relativeTime(at(20 * 86_400_000), now, 'zh'), '10 月 24 日')
  assert.equal(relativeTime(at(-60_000), now, 'zh'), '刚刚')
  assert.equal(relativeTime('not-a-date', now, 'zh'), 'not-a-date')
  assert.equal(relativeTime('', now, 'en'), '')
})

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1048576), '1.0 MB')
  assert.equal(formatBytes(null), '0 B')
})

test('entryDetailRows lists created/updated/origin and omits empty source', () => {
  const entry = { created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z', source: '' }
  assert.deepEqual(entryDetailRows(entry), [
    { key: 'createdAt', value: '2026-01-01T00:00:00.000Z' },
    { key: 'updatedAt', value: '2026-01-02T00:00:00.000Z' },
    { key: 'originLabel', value: 'manual' },
  ])
  assert.deepEqual(entryDetailRows({ ...entry, source: 'sess-1' })[2], { key: 'sourceLabel', value: 'sess-1' })
  assert.deepEqual(entryDetailRows(null), [
    { key: 'createdAt', value: '' },
    { key: 'updatedAt', value: '' },
    { key: 'originLabel', value: 'manual' },
  ])
})

test('entryDetailRows appends v2 fields in stable order', () => {
  const entry = {
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z', source: 'sess-1',
    origin: 'auto', expires: '2026-12-01', last_access: '2026-11-13T08:00:00.000Z', hit_count: 7,
    supersedes: 'm-old', superseded_by: 'm-new',
  }
  assert.deepEqual(entryDetailRows(entry), [
    { key: 'createdAt', value: '2026-01-01T00:00:00.000Z' },
    { key: 'updatedAt', value: '2026-01-02T00:00:00.000Z' },
    { key: 'sourceLabel', value: 'sess-1' },
    { key: 'originLabel', value: 'auto' },
    { key: 'expiresOn', value: '2026-12-01' },
    { key: 'lastAccessLabel', value: '2026-11-13T08:00:00.000Z' },
    { key: 'hitCountLabel', value: '7' },
    { key: 'supersedesLabel', value: 'm-old' },
    { key: 'supersededByLabel', value: 'm-new' },
  ])
  assert.deepEqual(entryDetailRows({ hit_count: 0 }).slice(2), [
    { key: 'originLabel', value: 'manual' },
    { key: 'hitCountLabel', value: '0' },
  ])
})

test('workspaceOptions builds global plus known workspaces and current cwd', () => {
  const opts = workspaceOptions({
    workspaces: [
      { key: 'k1', cwd: 'd:\\proj\\alpha', count: 2 },
      { key: 'k2', cwd: null, count: 1 },
      { key: 'k3', cwd: 'D:\\proj\\alpha', count: 2 },
    ],
    currentCwd: 'D:\\proj\\beta',
  })
  assert.deepEqual(opts, [
    { value: 'global', kind: 'global' },
    { value: 'd:\\proj\\alpha', kind: 'workspace', count: 2 },
    { value: 'D:\\proj\\beta', kind: 'workspace', count: 0 },
  ])
  assert.deepEqual(workspaceOptions({ workspaces: [], currentCwd: undefined }), [{ value: 'global', kind: 'global' }])
})

test('errorKeyFor maps service and route errors to locale keys', () => {
  assert.equal(errorKeyFor({ code: 'not-found', message: '未找到记忆 / memory not found: x' }), 'errNotFound')
  assert.equal(errorKeyFor({ code: 'secret', message: '拒绝写入…' }), 'errSecret')
  assert.equal(errorKeyFor({ code: 'invalid', message: '记忆内容不能为空…' }), 'errInvalid')
  assert.equal(errorKeyFor({ code: 'no-workspace', message: '…' }), 'errNoWorkspace')
  assert.equal(errorKeyFor({ code: 'duplicate', message: '…' }), 'errDuplicate')
  assert.equal(errorKeyFor({ status: 403, message: 'unauthorized' }), 'errUnauthorized')
  assert.equal(errorKeyFor({ status: 403, message: 'loopback-only' }), 'errLoopback')
  assert.equal(errorKeyFor({ status: 400, message: 'invalid-json' }), 'errInvalidJson')
  assert.equal(errorKeyFor({ status: 413, message: 'body-too-large' }), 'errBodyTooLarge')
  assert.equal(errorKeyFor({ status: 500, message: 'boom' }), null)
  assert.equal(errorKeyFor(null), null)
})

test('validateImportDoc accepts only dsh-memory export v1 documents', () => {
  const good = { format: 'dsh-memory-export', version: 1, entries: [] }
  assert.deepEqual(validateImportDoc(good), { ok: true })
  assert.deepEqual(validateImportDoc(null), { ok: false, error: 'bad-doc' })
  assert.deepEqual(validateImportDoc({ format: 'other', version: 1, entries: [] }), { ok: false, error: 'bad-doc' })
  assert.deepEqual(validateImportDoc({ format: 'dsh-memory-export', version: 2, entries: [] }), { ok: false, error: 'bad-doc' })
  assert.deepEqual(validateImportDoc({ format: 'dsh-memory-export', version: 1, entries: {} }), { ok: false, error: 'bad-doc' })
})

test('importSummary condenses a plan into display counts', () => {
  assert.deepEqual(importSummary({ imported: 3, deduplicated: 1, rejected: [{ index: 0, code: 'secret', reason: 'x' }] }), { imported: 3, deduplicated: 1, rejected: 1 })
  assert.deepEqual(importSummary({}), { imported: 0, deduplicated: 0, rejected: 0 })
  assert.deepEqual(importSummary(null), { imported: 0, deduplicated: 0, rejected: 0 })
})

test('isExpired compares UTC dates inclusively and fails open on bad input', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  assert.equal(isExpired('2026-11-12', now), true)
  assert.equal(isExpired('2026-11-13', now), false) // 当日含：expires=今天仍有效
  assert.equal(isExpired('2026-11-14', now), false)
  assert.equal(isExpired('2026-02-30', now), false) // 非法日历日期 fail-open
  assert.equal(isExpired('2026-13-01', now), false)
  assert.equal(isExpired('garbage', now), false)
  assert.equal(isExpired('', now), false)
  assert.equal(isExpired(undefined, now), false)
  assert.equal(isExpired(null, now), false)
  assert.equal(isExpired('2026-11-12', NaN), false)
})

test('statusOf prioritizes superseded over expired over archived', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  assert.equal(statusOf({}, now), 'active')
  assert.equal(statusOf(null, now), 'active')
  assert.equal(statusOf({ archived: true }, now), 'archived')
  assert.equal(statusOf({ expires: '2026-11-01' }, now), 'expired')
  assert.equal(statusOf({ superseded_by: 'm-new' }, now), 'superseded')
  assert.equal(statusOf({ superseded_by: 'm-new', expires: '2026-11-01', archived: true }, now), 'superseded')
  assert.equal(statusOf({ expires: '2026-11-01', archived: true }, now), 'expired')
  assert.equal(statusOf({ expires: '2026-12-01' }, now), 'active')
  assert.equal(statusOf({ pinned: true }, now), 'active') // pinned 与状态正交
})

test('originOf defaults missing origin to manual', () => {
  assert.equal(originOf({ origin: 'auto' }), 'auto')
  assert.equal(originOf({ origin: 'manual' }), 'manual')
  assert.equal(originOf({}), 'manual')
  assert.equal(originOf(null), 'manual')
})

test('statusQueryFlags maps hidden statuses to include_* params', () => {
  assert.deepEqual(statusQueryFlags('superseded'), { include_superseded: true })
  assert.deepEqual(statusQueryFlags('expired'), { include_expired: true })
  assert.deepEqual(statusQueryFlags('archived'), { include_archived: true })
  assert.deepEqual(statusQueryFlags('active'), {})
  assert.deepEqual(statusQueryFlags('pinned'), {})
  assert.deepEqual(statusQueryFlags(''), {})
  assert.deepEqual(statusQueryFlags(undefined), {})
})

test('matchesFilters combines status and origin filters', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  const active = { id: 'a' }
  const auto = { id: 'b', origin: 'auto' }
  const pinned = { id: 'c', pinned: true, origin: 'auto' }
  const superseded = { id: 'd', superseded_by: 'x' }
  const archived = { id: 'e', archived: true }
  assert.equal(matchesFilters(active, {}, now), true)
  assert.equal(matchesFilters(active, { status: 'active' }, now), true)
  // 活跃视图的隐藏态由服务端排除，客户端不再二次过滤
  assert.equal(matchesFilters(superseded, { status: 'active' }, now), true)
  assert.equal(matchesFilters(superseded, { status: 'superseded' }, now), true)
  assert.equal(matchesFilters(active, { status: 'superseded' }, now), false)
  assert.equal(matchesFilters(archived, { status: 'archived' }, now), true)
  assert.equal(matchesFilters(pinned, { status: 'pinned' }, now), true)
  assert.equal(matchesFilters(active, { status: 'pinned' }, now), false)
  assert.equal(matchesFilters(auto, { origin: 'auto' }, now), true)
  assert.equal(matchesFilters(active, { origin: 'auto' }, now), false)
  assert.equal(matchesFilters(active, { origin: 'manual' }, now), true)
  assert.equal(matchesFilters(pinned, { status: 'pinned', origin: 'auto' }, now), true)
  assert.equal(matchesFilters(pinned, { status: 'pinned', origin: 'manual' }, now), false)
  assert.equal(matchesFilters(null, {}, now), true)
})

test('statusQueryFlags: all reveals every hidden state', () => {
  assert.deepEqual(statusQueryFlags('all'), { include_superseded: true, include_expired: true, include_archived: true })
})

test('matchesFilters: all status passes every entry regardless of state', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  const entries = [
    { id: 'a' },
    { id: 'd', superseded_by: 'x' },
    { id: 'e', archived: true },
    { id: 'f', expires: '2020-01-01' },
    { id: 'c', pinned: true },
  ]
  for (const e of entries) assert.equal(matchesFilters(e, { status: 'all' }, now), true)
  assert.equal(matchesFilters({ id: 'g', origin: 'auto' }, { status: 'all', origin: 'manual' }, now), false)
  assert.equal(matchesFilters({ id: 'h', origin: 'manual' }, { status: 'all', origin: 'manual' }, now), true)
})
