/**
 * 缝 4：客户端纯逻辑 —— client.js UMD 尾部导出的纯函数。
 * React 渲染与真实 fetch 不在此测试（live 验证覆盖）。
 * 运行 Run: node --test tests/client.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import helpers from '../client/client.js'

const { validateDraft, groupEntries, nextToken, entriesParams, buildEntriesQuery, workspaceOptions, errorKeyFor, shouldQueueToast, partitionSettled, parseTags, unwrapResult, settingsStatusNext, savedToastKey, exportParams, defaultViewSelection, sectionCountsExact, chunkEntries, parseImportText, validateImportDoc, importSummary, pageSlice, entryDetailRows, relativeTime, formatBytes, isExpired, statusOf, originOf, statusQueryFlags } = helpers

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

// 0.24.1 回归：面板来源/标签/状态过滤必须随请求上行，否则服务端过滤不生效。
test('buildEntriesQuery serializes origin/tag/status filters', () => {
  assert.equal(buildEntriesQuery({ origin: 'auto' }), '?scope=all&origin=auto')
  assert.equal(buildEntriesQuery({ tag: '构建 工具' }), '?scope=all&tag=%E6%9E%84%E5%BB%BA%20%E5%B7%A5%E5%85%B7')
  assert.equal(buildEntriesQuery({ status: 'archived' }), '?scope=all&status=archived')
  assert.equal(
    buildEntriesQuery({ scope: 'workspace', workspace: 'D:\\proj', origin: 'manual', tag: 'x', status: 'all', include_superseded: true, include_expired: true, include_archived: true, limit: 51 }),
    '?scope=workspace&workspace=D%3A%5Cproj&origin=manual&tag=x&status=all&include_superseded=true&include_expired=true&include_archived=true&limit=51',
  )
  // 空过滤值不产生空参数（否则服务端会把空串当成过滤条件）。
  assert.equal(buildEntriesQuery({ origin: '', tag: '', status: '' }), '?scope=all')
})

test('entriesParams assembles panel list params with filters and status flags', () => {
  assert.deepEqual(entriesParams({}), { scope: 'all' })
  assert.deepEqual(entriesParams({ scope: 'workspace', workspace: 'D:\\proj', query: 'pnpm', category: 'fact', origin: 'auto', tag: 'npm', status: 'active', limit: 51, offset: 0 }), {
    scope: 'workspace', workspace: 'D:\\proj', query: 'pnpm', category: 'fact', origin: 'auto', tag: 'npm', status: 'active', limit: 51,
  })
  // status=all 放宽全部隐藏态；查看任一隐藏态都放宽全部（服务端隐藏门先于 status）；
  // active 不需要放宽。
  assert.deepEqual(entriesParams({ status: 'all' }), { scope: 'all', status: 'all', include_superseded: true, include_expired: true, include_archived: true })
  assert.deepEqual(entriesParams({ status: 'expired' }), { scope: 'all', status: 'expired', include_superseded: true, include_expired: true, include_archived: true })
  assert.deepEqual(entriesParams({ status: 'archived' }), { scope: 'all', status: 'archived', include_superseded: true, include_expired: true, include_archived: true })
  assert.deepEqual(entriesParams({ status: 'active' }), { scope: 'all', status: 'active' })
  // 分页 0 省略，非 0 保留。
  assert.deepEqual(entriesParams({ offset: 50, limit: 51 }), { scope: 'all', limit: 51, offset: 50 })
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

test('parseTags trims, splits zh/en commas, dedupes, caps length and count', () => {
  assert.deepEqual(parseTags(''), [])
  assert.deepEqual(parseTags('   ,  ,'), [])
  assert.deepEqual(parseTags('a, b，c'), ['a', 'b', 'c'])
  assert.deepEqual(parseTags('a, a , A'), ['a', 'A'], 'exact-case dedupe, case variants kept')
  assert.deepEqual(parseTags('x,'.repeat(20)), ['x'], 'dedupe keeps one')
  const many = Array.from({ length: 20 }, (_, i) => 't' + i).join(',')
  assert.deepEqual(parseTags(many).length, 12, 'max 12 tags')
  const long = 'a'.repeat(100)
  assert.equal(parseTags(long)[0].length, 64, 'single tag capped at 64 chars')
  assert.deepEqual(parseTags('中文，标签,中文'), ['中文', '标签'])
})

test('unwrapResult unwraps write-route {result} envelopes (settings views)', () => {
  const view = { effective: { backupRetention: 7 }, bounds: { retentionMin: 1 } }
  assert.equal(unwrapResult({ result: view }), view)
  assert.deepEqual(unwrapResult(view), view)
  assert.equal(unwrapResult(null), null)
  assert.equal(unwrapResult({ result: null }), null)
  assert.deepEqual(unwrapResult({ other: 1 }), { other: 1 })
})

test('savedToastKey prioritizes revived over dedup and similar', () => {
  assert.equal(savedToastKey(null), 'saved')
  assert.equal(savedToastKey({}), 'saved')
  assert.equal(savedToastKey({ revived: true }), 'revivedSaved')
  assert.equal(savedToastKey({ deduplicated: true }), 'deduplicated')
  assert.equal(savedToastKey({ deduplicated: true, similar: [{ id: 'm-1' }] }), 'deduplicated')
  // 复活是真实状态变化，优先于去重提示。
  assert.equal(savedToastKey({ revived: true, deduplicated: true }), 'revivedSaved')
  assert.equal(savedToastKey({ similar: [{ id: 'm-1' }, { id: 'm-2' }] }), 'similarSaved')
  assert.equal(savedToastKey({ deduplicated: false, similar: [] }), 'saved')
})

test('parseTags keeps tags named after Object.prototype members (no prototype-key dropout)', () => {
  assert.deepEqual(parseTags('constructor, toString, __proto__, hasOwnProperty, a'), ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'a'])
  assert.deepEqual(parseTags('toString，toString，b'), ['toString', 'b'])
})

test('locale dictionaries stay in sync; import size copy matches the 32 MB limit', () => {
  const src = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const zhBlock = src.slice(src.indexOf('var ZH = {'), src.indexOf('var EN = {'))
  const enBlock = src.slice(src.indexOf('var EN = {'), src.indexOf('var CSS = ['))
  assert.ok(zhBlock.length > 1000 && enBlock.length > 1000)
  const keysOf = (block) => [...block.matchAll(/^ {4}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1])
  const zhKeys = keysOf(zhBlock)
  const enKeys = keysOf(enBlock)
  assert.equal(new Set(zhKeys).size, zhKeys.length, 'duplicate keys in ZH')
  assert.equal(new Set(enKeys).size, enKeys.length, 'duplicate keys in EN')
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh/en key sets must match')
  assert.match(zhBlock, /errBodyTooLarge: '文件过大（超过 32 MB）/)
  assert.match(enBlock, /errBodyTooLarge: 'File too large \(over 32 MB\)/)
  // 占位符一致：逐键比对（两字典行文本）。
  const lineOf = (block, key) => (block.match(new RegExp(`^ {4}${key}: (.*)$`, 'm')) || [])[1] || ''
  for (const key of zhKeys) {
    const z = (lineOf(zhBlock, key).match(/\{\w+\}/g) || []).sort()
    const e = (lineOf(enBlock, key).match(/\{\w+\}/g) || []).sort()
    assert.deepEqual(z, e, `placeholder mismatch in ${key}`)
  }
})

test('chunkEntries splits import payloads into bounded atomic batches', () => {
  assert.deepEqual(chunkEntries([], 300), [])
  assert.deepEqual(chunkEntries([1, 2, 3], 2), [[1, 2], [3]])
  const items = Array.from({ length: 320 }, (_, i) => i)
  const chunks = chunkEntries(items, 300)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 300)
  assert.equal(chunks[1].length, 20)
  assert.equal(chunkEntries(items, 0).length, 320, 'invalid size falls back to 1 per chunk')
})

test('sectionCountsExact only trusts group counts on a single full page', () => {
  assert.equal(sectionCountsExact(0, false, false), true)
  assert.equal(sectionCountsExact(1, false, false), false, 'later page is a slice')
  assert.equal(sectionCountsExact(0, true, false), false, 'more pages exist => totals differ')
  assert.equal(sectionCountsExact(0, false, true), false, 'filtered subset != full library')
})

test('defaultViewSelection waits for cwd instead of locking the default in', () => {
  // 设置尚未加载：继续等待。
  assert.deepEqual(defaultViewSelection(null, 'D:\\proj'), { selection: null, resolved: false })
  assert.deepEqual(defaultViewSelection({}, 'D:\\proj'), { selection: null, resolved: false })
  // 默认视图＝全局：立即生效。
  assert.deepEqual(defaultViewSelection({ effective: { defaultView: 'global' } }, undefined), { selection: 'global', resolved: true })
  // 默认视图＝当前工作区：cwd 晚到时不能先标记 resolved（否则默认视图永远不生效）。
  assert.deepEqual(defaultViewSelection({ effective: { defaultView: 'workspace' } }, undefined), { selection: null, resolved: false })
  assert.deepEqual(defaultViewSelection({ effective: { defaultView: 'workspace' } }, 'D:\\proj'), { selection: 'D:\\proj', resolved: true })
  // 默认视图＝全部：无需选择。
  assert.deepEqual(defaultViewSelection({ effective: { defaultView: 'all' } }, undefined), { selection: null, resolved: true })
})

test('parseImportText tolerates BOM and separates parse vs format errors', () => {
  const doc = '{"format":"dsh-memory-export","version":1,"entries":[{"content":"导入条目","scope":"global"}]}'
  const plain = parseImportText(doc)
  assert.equal(plain.ok, true)
  assert.equal(plain.doc.entries.length, 1)
  // Windows 记事本/部分编辑器保存会带 UTF-8 BOM：此前 JSON.parse 直接失败。
  const bom = parseImportText('\uFEFF' + doc)
  assert.equal(bom.ok, true)
  assert.equal(bom.doc.format, 'dsh-memory-export')
  // JSON 语法错误 vs 不是导出文件，归因分开。
  assert.deepEqual(parseImportText('{broken'), { ok: false, errorKey: 'errImportJson' })
  assert.deepEqual(parseImportText('{"foo":1}'), { ok: false, errorKey: 'errImportDoc' })
  assert.equal(parseImportText(null).ok, false)
  assert.equal(parseImportText('').ok, false)
})

test('exportParams keeps export scope equal to the visible view', () => {
  assert.deepEqual(exportParams('global', 'D:\\proj'), { scope: 'global' })
  assert.deepEqual(exportParams('all', 'D:\\proj'), { scope: 'all', workspace: 'D:\\proj' })
  assert.deepEqual(exportParams('all', undefined), { scope: 'global' })
  assert.deepEqual(exportParams('D:\\proj', 'D:\\proj'), { scope: 'workspace', workspace: 'D:\\proj' })
})

test('settingsStatusNext: coherent save/reset/failure/retry transitions', () => {
  // 初始状态（null 也安全）。
  assert.deepEqual(settingsStatusNext(null, { type: 'init' }), { dirty: false, saving: false, savedOnce: false, error: '' })
  let s = settingsStatusNext(null, { type: 'edit' })
  assert.deepEqual(s, { dirty: true, saving: false, savedOnce: false, error: '' })
  s = settingsStatusNext(s, { type: 'save-start' })
  assert.equal(s.saving, true)
  s = settingsStatusNext(s, { type: 'save-ok' })
  assert.deepEqual(s, { dirty: false, saving: false, savedOnce: true, error: '' })

  // 保存失败：保留脏标记与错误原因，footer 可显示「重试保存」，不谎报已保存。
  s = settingsStatusNext(settingsStatusNext(s, { type: 'edit' }), { type: 'save-start' })
  s = settingsStatusNext(s, { type: 'save-fail', error: '网络异常' })
  assert.deepEqual(s, { dirty: true, saving: false, savedOnce: false, error: '网络异常' })
  s = settingsStatusNext(settingsStatusNext(s, { type: 'save-start' }), { type: 'save-ok' })
  assert.deepEqual(s, { dirty: false, saving: false, savedOnce: true, error: '' })

  // 重置：清掉在途标记/脏标记与错误，成功后已保存。
  s = settingsStatusNext({ dirty: true, saving: true, savedOnce: false, error: '旧错误' }, { type: 'reset-start' })
  assert.deepEqual(s, { dirty: false, saving: false, savedOnce: false, error: '' })
  s = settingsStatusNext(s, { type: 'reset-ok' })
  assert.deepEqual(s, { dirty: false, saving: false, savedOnce: true, error: '' })
  s = settingsStatusNext(s, { type: 'reset-fail', error: '重置失败' })
  assert.deepEqual(s, { dirty: false, saving: false, savedOnce: false, error: '重置失败' })

  // save-settled 只负责结束「保存中」，不清脏标记/错误（失败路径已单独置位）。
  s = settingsStatusNext({ dirty: true, saving: true, savedOnce: false, error: 'x' }, { type: 'save-settled' })
  assert.deepEqual(s, { dirty: true, saving: false, savedOnce: false, error: 'x' })
  // 未知事件不改变状态（含 undefined event）。
  assert.deepEqual(settingsStatusNext(s, { type: 'bogus' }), s)
  assert.deepEqual(settingsStatusNext(s, undefined), s)
})

test('errorKeyFor maps service and route errors to locale keys', () => {
  assert.equal(errorKeyFor({ code: 'not-found', message: '未找到记忆 / memory not found: x' }), 'errNotFound')
  assert.equal(errorKeyFor({ code: 'secret', message: '拒绝写入…' }), 'errSecret')
  assert.equal(errorKeyFor({ code: 'invalid', message: '记忆内容不能为空…' }), 'errInvalid')
  assert.equal(errorKeyFor({ code: 'no-workspace', message: '…' }), 'errNoWorkspace')
  assert.equal(errorKeyFor({ code: 'duplicate', message: '…' }), 'errDuplicate')
  // 0.24.16：导入落盘 IO 失败（已回滚）与锁忙（可重试）有专属本地化文案。
  assert.equal(errorKeyFor({ code: 'io', message: '导入写入失败，未做任何变更' }), 'errIo')
  assert.equal(errorKeyFor({ code: 'busy', message: '另一个进程正在写入记忆' }), 'errBusy')
  // 0.24.4：超时/网络/坏响应（fetch 无响应时不再永久转圈）。
  assert.equal(errorKeyFor({ code: 'timeout', message: 'timeout' }), 'errTimeout')
  assert.equal(errorKeyFor({ code: 'network', message: 'network' }), 'errNetwork')
  assert.equal(errorKeyFor({ code: 'bad-response', message: 'bad-response' }), 'errBadResponse')
  assert.equal(errorKeyFor({ message: 'timeout' }), 'errTimeout')
  assert.equal(errorKeyFor({ status: 403, message: 'unauthorized' }), 'errUnauthorized')
  assert.equal(errorKeyFor({ status: 403, message: 'loopback-only' }), 'errLoopback')
  assert.equal(errorKeyFor({ status: 400, message: 'invalid-json' }), 'errInvalidJson')
  assert.equal(errorKeyFor({ status: 413, message: 'body-too-large' }), 'errBodyTooLarge')
  // 0.24.24：宿主未知异常统一 internal（不回传路径）；面板显示本地化通用错误。
  assert.equal(errorKeyFor({ status: 500, code: 'internal', message: 'internal' }), 'errInternal')
  assert.equal(errorKeyFor({ status: 500, message: 'boom' }), null)
  assert.equal(errorKeyFor(null), null)
})

test('shouldQueueToast protects an unexpired undo toast from plain toasts', () => {
  const now = 1000
  const undo = { action: { label: '撤销' }, until: 7000 }
  assert.equal(shouldQueueToast(undo, { text: '已钉选' }, now), true)
  assert.equal(shouldQueueToast(undo, { text: '已复制' }, 6999), true)
  // 已到期：不再保护。
  assert.equal(shouldQueueToast(undo, { text: 'x' }, 7000), false)
  // 新提示也是撤销动作时允许替换；没有撤销吐司时正常展示。
  assert.equal(shouldQueueToast(undo, { action: { label: '撤销' } }, now), false)
  assert.equal(shouldQueueToast(null, { text: 'x' }, now), false)
  assert.equal(shouldQueueToast({ text: '普通', until: 7000 }, { text: 'x' }, now), false)
  assert.equal(shouldQueueToast(undo, null, now), false)
})

test('partitionSettled splits batch delete results into deletable and failed', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const settled = [
    { status: 'fulfilled' },
    { status: 'rejected', reason: new Error('not-found') },
    { status: 'fulfilled' },
  ]
  const out = partitionSettled(items, settled)
  assert.deepEqual(out.ok.map((e) => e.id), ['a', 'c'])
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].entry.id, 'b')
  assert.equal(out.failed[0].error.message, 'not-found')
  // 边界：空输入/缺项按失败处理，避免静默丢项。
  assert.deepEqual(partitionSettled([], []), { ok: [], failed: [] })
  const partial = partitionSettled([{ id: 'x' }, { id: 'y' }], [{ status: 'fulfilled' }])
  assert.deepEqual(partial.ok.map((e) => e.id), ['x'])
  assert.equal(partial.failed[0].entry.id, 'y')
  assert.deepEqual(partitionSettled(null, null), { ok: [], failed: [] })
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
  assert.deepEqual(importSummary({ imported: 3, deduplicated: 1, rejected: [{ index: 0, code: 'secret', reason: 'x' }] }), { imported: 3, updated: 0, deduplicated: 1, rejected: 1 })
  assert.deepEqual(importSummary({}), { imported: 0, updated: 0, deduplicated: 0, rejected: 0 })
  assert.deepEqual(importSummary(null), { imported: 0, updated: 0, deduplicated: 0, rejected: 0 })
  assert.deepEqual(importSummary({ imported: 1, updated: 2, deduplicated: 0, rejected: [] }), { imported: 1, updated: 2, deduplicated: 0, rejected: 0 })
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
  // 任一隐藏态视图都放宽全部隐藏门：服务端先过隐藏门再按状态后置过滤，
  // 只放宽自身会漏掉「被取代＋归档」这类组合态条目。
  const ALL = { include_superseded: true, include_expired: true, include_archived: true }
  assert.deepEqual(statusQueryFlags('superseded'), ALL)
  assert.deepEqual(statusQueryFlags('expired'), ALL)
  assert.deepEqual(statusQueryFlags('archived'), ALL)
  assert.deepEqual(statusQueryFlags('active'), {})
  assert.deepEqual(statusQueryFlags('pinned'), ALL)
  assert.deepEqual(statusQueryFlags(''), {})
  assert.deepEqual(statusQueryFlags(undefined), {})
})

test('statusQueryFlags: all reveals every hidden state', () => {
  assert.deepEqual(statusQueryFlags('all'), { include_superseded: true, include_expired: true, include_archived: true })
})
