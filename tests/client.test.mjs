/**
 * 缝 4：客户端纯逻辑 —— client.js UMD 尾部导出的纯函数。
 * React 渲染与真实 fetch 不在此测试（live 验证覆盖）。
 * 运行 Run: node --test tests/client.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import helpers from '../client/client.js'

const { validateDraft, groupEntries, nextToken, buildEntriesQuery, workspaceOptions, errorKeyFor, validateImportDoc, importSummary, pageSlice, entryDetailRows } = helpers

test('validateDraft accepts a complete draft and rejects bad ones', () => {
  assert.deepEqual(validateDraft({ content: '一条事实', category: 'fact' }), { ok: true })
  assert.deepEqual(validateDraft({ content: 'x' }), { ok: true })
  assert.deepEqual(validateDraft({ content: '   ', category: 'fact' }), { ok: false, error: 'empty-content' })
  assert.deepEqual(validateDraft({ content: 'x', category: 'bogus' }), { ok: false, error: 'bad-category' })
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
})

test('pageSlice splits items and detects a next page', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(pageSlice(rows, 2), { items: [{ id: 'a' }, { id: 'b' }], hasMore: true })
  assert.deepEqual(pageSlice(rows, 3), { items: rows, hasMore: false })
  assert.deepEqual(pageSlice(rows, 5), { items: rows, hasMore: false })
  assert.deepEqual(pageSlice([], 2), { items: [], hasMore: false })
  assert.deepEqual(pageSlice(null, 2), { items: [], hasMore: false })
})

test('entryDetailRows lists created/updated and omits empty source', () => {
  const entry = { created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z', source: '' }
  assert.deepEqual(entryDetailRows(entry), [
    { key: 'createdAt', value: '2026-01-01T00:00:00.000Z' },
    { key: 'updatedAt', value: '2026-01-02T00:00:00.000Z' },
  ])
  assert.deepEqual(entryDetailRows({ ...entry, source: 'sess-1' })[2], { key: 'sourceLabel', value: 'sess-1' })
  assert.deepEqual(entryDetailRows(null), [
    { key: 'createdAt', value: '' },
    { key: 'updatedAt', value: '' },
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
