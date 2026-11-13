/**
 * 缝 1：MemoryService 公共 API —— 工具与 UI 共享的操作层。
 * 运行 Run: node --test tests/service.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import * as store from '../lib/store.js'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-svc-'))
  return { root, service: createMemoryService({ root }) }
}

test('save makes an entry retrievable via list', () => {
  const { service } = tmpService()
  const { entry, deduplicated } = service.save({
    content: '用户偏好中文回复',
    category: 'preference',
    scope: 'global',
    tags: ['语言'],
  })
  assert.equal(deduplicated, false)
  assert.match(entry.id, /^m-/)
  const listed = service.list({ scope: 'global' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].content, '用户偏好中文回复')
  assert.equal(listed[0].category, 'preference')
  assert.deepEqual(listed[0].tags, ['语言'])
})

test('workspace entries are isolated and reported by workspaces()', () => {
  const { service } = tmpService()
  service.save({ content: 'alpha 约定', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  service.save({ content: 'beta 约定', scope: 'workspace', workspace: 'D:\\proj\\beta' })
  service.save({ content: '全局偏好', scope: 'global' })
  const alphaEntries = service.list({ scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  assert.equal(alphaEntries.length, 1)
  assert.equal(alphaEntries[0].content, 'alpha 约定')
  const workspaces = service.workspaces()
  assert.equal(workspaces.length, 2)
  const alpha = workspaces.find((w) => typeof w.cwd === 'string' && w.cwd.toLowerCase() === 'd:\\proj\\alpha')
  assert.ok(alpha, 'alpha workspace should be listed with its cwd')
  assert.equal(alpha.count, 1)
  assert.match(alpha.key, /^[a-f0-9]{16}$/)
})

test('save rejects credentials with code secret and stores nothing', () => {
  const { service } = tmpService()
  assert.throws(
    () => service.save({ content: 'password = hunter2secret', scope: 'global' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' }).length, 0)
})

test('update supersedes in place; unknown id fails with not-found', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '旧事实', scope: 'global' })
  const updated = service.update({ id: entry.id, content: '新事实', category: 'decision' })
  assert.equal(updated.id, entry.id)
  assert.equal(updated.content, '新事实')
  assert.equal(updated.category, 'decision')
  assert.equal(service.list({ scope: 'global' }).length, 1)
  assert.equal(service.list({ scope: 'global' })[0].content, '新事实')
  assert.throws(
    () => service.update({ id: 'm-nonexistent-000000', content: 'x' }),
    (err) => err.code === 'not-found',
  )
})

test('forget deletes permanently; unknown id fails with not-found', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '将被忘记', scope: 'global' })
  const result = service.forget({ id: entry.id })
  assert.deepEqual(result, { id: entry.id, deleted: true })
  assert.equal(service.list({ scope: 'global' }).length, 0)
  assert.throws(
    () => service.forget({ id: entry.id }),
    (err) => err.code === 'not-found',
  )
})

test('search filters by query, category, scope and limit', () => {
  const { service } = tmpService()
  service.save({ content: '构建使用 pnpm install', scope: 'workspace', workspace: 'D:\\proj\\alpha', tags: ['build'] })
  service.save({ content: '测试使用 vitest', scope: 'workspace', workspace: 'D:\\proj\\alpha', category: 'decision' })
  service.save({ content: '用户喜欢深色主题', scope: 'global', category: 'preference' })
  const ws = 'D:\\proj\\alpha'
  assert.equal(service.search({ query: 'PNPM 构建', workspace: ws }).length, 1)
  assert.equal(service.search({ query: 'pnpm vitest', workspace: ws }).length, 0)
  assert.equal(service.search({ query: '', category: 'preference', workspace: ws }).length, 1)
  assert.equal(service.search({ query: '', scope: 'workspace', workspace: ws }).length, 2)
  assert.equal(service.search({ query: '', workspace: ws, limit: 1 }).length, 1)
  assert.equal(service.search({ query: 'build', workspace: ws }).length, 1)
  assert.equal(service.search({ query: '', workspace: ws }).length, 3)
})

test('save deduplicates identical content within the same scope', () => {
  const { service } = tmpService()
  const first = service.save({ content: 'Project uses pnpm', scope: 'global' })
  const second = service.save({ content: '  project   USES   pnpm  ', scope: 'global' })
  assert.equal(first.deduplicated, false)
  assert.equal(second.deduplicated, true)
  assert.equal(second.entry.id, first.entry.id)
  assert.equal(service.list({ scope: 'global' }).length, 1)
})

test('save revives an archived/expired identical entry instead of leaving it hidden', () => {
  const { service } = tmpService()
  const first = service.save({ content: '部署走内网镜像', scope: 'global', origin: 'auto' })
  service.update({ id: first.entry.id, archived: true })
  assert.equal(service.search({ query: '内网镜像', scope: 'global' }).length, 0)
  const revived = service.save({ content: '部署走内网镜像', scope: 'global', origin: 'manual' })
  assert.equal(revived.deduplicated, true)
  assert.equal(revived.revived, true)
  assert.equal(revived.entry.id, first.entry.id)
  assert.equal(revived.entry.archived, undefined)
  assert.equal(revived.entry.origin, 'manual')
  // 复活后重新可见、可检索。
  assert.equal(service.search({ query: '内网镜像', scope: 'global' }).length, 1)

  // 过期条目同样复活（清 expires），过期日之外的隐藏态不受影响。
  const exp = service.save({ content: '临时口令轮换周期', scope: 'global', expires: '2020-01-01' })
  const again = service.save({ content: '临时口令轮换周期', scope: 'global' })
  assert.equal(again.revived, true)
  assert.equal(again.entry.id, exp.entry.id)
  assert.equal(again.entry.expires, undefined)
})

test('save validates input with coded errors', () => {
  const { service } = tmpService()
  assert.throws(() => service.save({ content: '   ', scope: 'global' }), (err) => err.code === 'invalid')
  assert.throws(() => service.save({ content: 'x', category: 'bogus', scope: 'global' }), (err) => err.code === 'invalid')
  assert.throws(() => service.save({ content: 'x', scope: 'workspace' }), (err) => err.code === 'no-workspace')
  assert.equal(service.list({ scope: 'all' }).length, 0)
})

test('update rejects credentials with code secret and keeps the old content', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '正常内容', scope: 'global' })
  assert.throws(
    () => service.update({ id: entry.id, content: 'api_key: abcd1234efgh' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' })[0].content, '正常内容')
})

test('status reports root, schemaVersion and counts', () => {
  const { root, service } = tmpService()
  service.save({ content: '全局一', scope: 'global' })
  service.save({ content: '全局二', scope: 'global' })
  service.save({ content: '工作区一', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  const status = service.status()
  assert.equal(status.root, root)
  assert.equal(status.schemaVersion, 2)
  assert.deepEqual(status.counts, { global: 2, workspaces: 1 })
})

test('workspaces() ignores lock and non-hash directories', () => {
  const { root, service } = tmpService()
  service.save({ content: '工作区一', scope: 'workspace', workspace: 'D:\\proj\\alpha' })
  fs.mkdirSync(path.join(root, 'workspaces', '.lock'), { recursive: true })
  fs.mkdirSync(path.join(root, 'workspaces', 'junk-dir'), { recursive: true })
  const workspaces = service.workspaces()
  assert.equal(workspaces.length, 1)
  assert.match(workspaces[0].key, /^[a-f0-9]{16}$/)
})

test('stats reports totals, category and scope distribution for the filter', () => {
  const { service } = tmpService()
  service.save({ content: '统计甲 pnpm', scope: 'global', category: 'preference' })
  service.save({ content: '统计乙 pnpm', scope: 'global', category: 'fact' })
  service.save({ content: '统计丙 pnpm', scope: 'workspace', workspace: WS, category: 'decision' })
  service.save({ content: '无关条目', scope: 'global', category: 'fact' })
  const all = service.stats({ workspace: WS })
  assert.equal(all.total, 4)
  assert.deepEqual(all.byCategory, { preference: 1, fact: 2, decision: 1 })
  assert.deepEqual(all.byScope, { global: 3, workspace: 1 })
  const queried = service.stats({ query: 'pnpm', workspace: WS })
  assert.equal(queried.total, 3)
  assert.deepEqual(queried.byCategory, { preference: 1, fact: 1, decision: 1 })
  const scoped = service.stats({ scope: 'global', query: 'pnpm', workspace: WS })
  assert.equal(scoped.total, 2)
  assert.deepEqual(scoped.byScope, { global: 2, workspace: 0 })
})

test('settings view exposes defaults/base/overlay/effective, privacy always-on, storage meta', () => {
  const { root, service } = tmpService()
  service.save({ content: '设置元信息', scope: 'global' })
  const view = service.settings()
  assert.equal(view.defaults.pageSize, 50)
  assert.equal(view.privacy.alwaysOn, true)
  assert.equal(view.effective.autoInject, true)
  assert.equal(view.meta.root, root)
  assert.equal(view.meta.storage.entries, 1)
  assert.ok(view.meta.storage.bytes > 0)
  assert.equal(view.meta.backup.count, 0)
  assert.deepEqual(view.bounds.pageSizes, [20, 50, 100])
})

test('baseConfig is the base layer; overlay overrides; recallConfig reflects live', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-svc-base-'))
  const service = createMemoryService({ root, baseConfig: { autoInject: false, injectionBudgetChars: 1234 } })
  assert.deepEqual(service.recallConfig(), { autoInject: false, injectionBudgetChars: 1234, decayEnabled: true })
  service.updateSettings({ autoInject: true, injectionBudgetChars: 8000, pageSize: 20 })
  assert.deepEqual(service.recallConfig(), { autoInject: true, injectionBudgetChars: 8000, decayEnabled: true })
  assert.equal(service.settings().effective.pageSize, 20)
  service.resetSettings()
  assert.deepEqual(service.recallConfig(), { autoInject: false, injectionBudgetChars: 1234, decayEnabled: true })
  assert.equal(service.settings().effective.pageSize, 50)
})

test('backup writes to backups/ and prunes to retention; maybeAutoBackup gates on flag and freshness', () => {
  const { root, service } = tmpService()
  service.save({ content: '备份内容', scope: 'global' })
  service.updateSettings({ autoBackup: true, backupRetention: 2 })
  const dir = path.join(root, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  // 只有插件自己的时间戳备份参与轮转（0.24.18 起不再按任意 *.json 计数）。
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `dsh-memory-2020-01-01T00-00-0${i}-000Z.json`), '{}', 'utf8')
  const result = service.backup()
  assert.equal(result.count, 2)
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 2)
  assert.ok(result.file.startsWith('dsh-memory-'))
  // fresh backup -> maybeAutoBackup returns null; disabled -> null
  assert.equal(service.maybeAutoBackup(), null)
  service.updateSettings({ autoBackup: false })
  assert.equal(service.maybeAutoBackup(), null)
})

test('backup only rotates plugin timestamp files; foreign json never deleted nor blocks auto-backup', () => {
  const { root, service } = tmpService()
  service.save({ content: '备份内容', scope: 'global' })
  service.updateSettings({ autoBackup: true, backupRetention: 1 })
  const dir = path.join(root, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const foreign = path.join(dir, 'notes-and-manual-export.json')
  fs.writeFileSync(foreign, '{"user":"manual"}', 'utf8')
  // 外来的「未来 mtime」文件不应被当作 lastBackup（否则自动备份永久不触发）。
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  fs.utimesSync(foreign, future, future)
  service.backup()
  const own = fs.readdirSync(dir).filter((n) => /^dsh-memory-\d{4}-\d{2}-\d{2}T/.test(n))
  assert.equal(own.length, 1)
  assert.ok(fs.existsSync(foreign), 'foreign json preserved')
  fs.rmSync(path.join(dir, own[0]))
  const auto = service.maybeAutoBackup()
  assert.ok(auto && typeof auto.file === 'string', 'auto-backup still runs despite foreign future mtime')
  assert.ok(fs.existsSync(foreign))
})

test('v1 migration backup failure degrades to readable status, then recovers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-mig-'))
  fs.mkdirSync(path.join(root, 'global'), { recursive: true })
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ plugin: 'dsh-memory', schemaVersion: 1 }), 'utf8')
  fs.writeFileSync(path.join(root, 'backups'), 'blocker', 'utf8') // 让备份目录创建失败
  const broken = createMemoryService({ root })
  const status = broken.status()
  assert.equal(status.migrationPending, true)
  assert.match(String(status.migrationError || ''), /迁移备份失败|迁移失败/)
  assert.equal(status.schemaVersion, 1, 'schema only bumps after a successful backup')
  // 记忆仍可读写（迁移失败不阻断）。
  broken.save({ content: '迁移期间的记忆', scope: 'global' })
  assert.equal(broken.list({ scope: 'global' }).length, 1)
  // 自动备份失败降级返回 null，而不是向调用方抛错。
  broken.updateSettings({ autoBackup: true })
  assert.equal(broken.maybeAutoBackup(), null)
  // 修复阻塞后再次加载：完成迁移，状态可观测为已恢复。
  fs.rmSync(path.join(root, 'backups'), { force: true })
  const fixed = createMemoryService({ root })
  assert.equal(fixed.status().schemaVersion, 2)
  assert.equal(fixed.status().migrationPending, false)
  assert.equal(fixed.status().migrationError, null)
})

test('concurrent import fails fast with retryable busy instead of freezing on the lock', () => {
  const { root, service } = tmpService()
  const lock = path.join(root, '.lock-import')
  fs.mkdirSync(lock, { recursive: true })
  const started = Date.now()
  let err = null
  try {
    service.import({ entries: [{ content: '并发导入', scope: 'global' }] })
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - started
  fs.rmSync(lock, { recursive: true, force: true })
  assert.ok(err, 'import must fail while lock held')
  assert.equal(err.code, 'busy')
  assert.ok(elapsed < 5000, `lock wait ${elapsed}ms (expected ~3s cap)`)
})

test('backup refuses quickly (busy, no partial snapshot) while another process holds the import lock', () => {
  const { root, service } = tmpService()
  service.save({ content: '备份锁测试', scope: 'global' })
  const lock = path.join(root, '.lock-import')
  fs.mkdirSync(lock, { recursive: true })
  const started = Date.now()
  let err = null
  try {
    service.backup()
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - started
  fs.rmSync(lock, { recursive: true, force: true })
  assert.ok(err && err.code === 'busy', `expected busy, got ${err && err.code}`)
  assert.ok(elapsed < 3000, `lock wait ${elapsed}ms (expected ~500ms cap)`)
  const dir = path.join(root, 'backups')
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'no partial backup written')
  assert.match(String(service.status().backupError || ''), /备份失败/)
  // 锁释放后恢复正常。
  const ok = service.backup()
  assert.ok(ok.file)
})

test('same-millisecond backups get unique names, are counted and rotated as plugin-owned files', () => {
  const { root, service } = tmpService()
  service.save({ content: '同毫秒备份统计', scope: 'global' })
  const RealDate = globalThis.Date
  const fixed = RealDate.parse('2026-05-01T12:00:00.000Z')
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }
    static now() { return fixed }
  }
  try {
    const a = service.backup()
    const b = service.backup()
    assert.notEqual(a.file, b.file)
    const dir = path.join(root, 'backups')
    assert.ok(fs.existsSync(path.join(dir, a.file)))
    assert.ok(fs.existsSync(path.join(dir, b.file)))
    // 去重名备份必须是插件自己的文件：计数正确、可被轮转。
    assert.equal(service.settings().meta.backup.count, 2, 'both unique backups counted')
    service.updateSettings({ backupRetention: 1 })
    const c = service.backup()
    assert.ok(fs.existsSync(path.join(dir, c.file)))
    assert.equal(service.settings().meta.backup.count, 1, 'retention still applies to suffixed backups')
  } finally {
    globalThis.Date = RealDate
  }
})

test('status counts use directory listing (damaged files included) and corrupt meta is surfaced', () => {
  const { root, service } = tmpService()
  service.save({ content: '计数甲', scope: 'global' })
  fs.writeFileSync(path.join(root, 'global', 'm-damaged-count.md'), 'not frontmatter', 'utf8')
  const st = service.status()
  assert.equal(st.counts.global, 2, 'counts are file counts, not parseable-only')
  assert.equal(st.metaError, null)
  fs.writeFileSync(path.join(root, 'meta.json'), 'not json', 'utf8')
  const corrupt = service.status()
  assert.equal(corrupt.schemaVersion, null, 'corrupt meta must not masquerade as healthy v2')
  assert.match(String(corrupt.metaError || ''), /损坏|corrupt/)
})

test('migration meta write failure stays pending and retry reuses the recent backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-migwrite-'))
  const setup = createMemoryService({ root })
  setup.save({ content: '迁移写入失败内容', scope: 'global' })
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ plugin: 'dsh-memory', schemaVersion: 1, createdAt: new Date().toISOString() }), 'utf8')
  const originalRename = fs.renameSync
  fs.renameSync = function (from, to, ...rest) {
    if (String(to).endsWith('meta.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return originalRename.call(this, from, to, ...rest)
  }
  let failedService
  try {
    failedService = createMemoryService({ root })
  } finally {
    fs.renameSync = originalRename
  }
  const failedStatus = failedService.status()
  assert.equal(failedStatus.schemaVersion, 1, 'meta still v1 after failed write')
  assert.equal(failedStatus.migrationPending, true)
  assert.match(String(failedStatus.migrationError || ''), /io|迁移失败/)
  const backupsAfterFail = fs.readdirSync(path.join(root, 'backups')).length
  assert.ok(backupsAfterFail >= 1, 'forced backup happened before the failed meta write')
  // 恢复：最近 10 分钟已有备份 → 复用，不再新增（避免反复启动轮转掉历史备份）；迁移成功。
  const recovered = createMemoryService({ root })
  assert.equal(recovered.status().schemaVersion, 2)
  assert.equal(recovered.status().migrationPending, false)
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, backupsAfterFail, 'recent backup reused')
})

test('forgetMany deletes a batch in one pass and clears supersede refs', () => {
  const { root, service } = tmpService()
  const entries = Array.from({ length: 400 }, (_, i) => ({
    id: `m-batch-${String(i).padStart(4, '0')}`,
    content: `批量删除条目 ${i}`,
    scope: 'global',
    origin: 'auto',
  }))
  service.import({ entries })
  // 被取代的前驱必须在批量删除后继后恢复可见。
  const pred = service.save({ content: '批量前驱记忆', scope: 'global' })
  const succ = service.save({ content: '批量后继记忆', scope: 'global', supersedes: pred.entry.id })
  const ids = entries.slice(0, 100).map((e) => e.id).concat([succ.entry.id])
  const started = Date.now()
  const res = service.forgetMany({ ids })
  const elapsed = Date.now() - started
  assert.equal(res.deleted, 101)
  assert.deepEqual(res.notFound, [])
  assert.equal(service.list({ scope: 'global' }).length, 400 - 100 + 1)
  assert.equal(store.findEntry(root, pred.entry.id, undefined).superseded_by, undefined)
  assert.ok(service.search({ scope: 'global' }).some((e) => e.id === pred.entry.id), 'predecessor restored')
  assert.ok(elapsed < 1500, `forgetMany 101 of ~400 took ${elapsed}ms (N full scans would be seconds)`)
  // 空数组 / 全部不存在 → 明确错误。
  assert.throws(() => service.forgetMany({ ids: [] }), (err) => err.code === 'invalid')
  assert.throws(() => service.forgetMany({ ids: ['m-batch-missing'] }), (err) => err.code === 'not-found')
})

test('forgetMany deletes damaged files by id and reports missing ids', () => {
  const { root, service } = tmpService()
  fs.mkdirSync(path.join(root, 'global'), { recursive: true })
  fs.writeFileSync(path.join(root, 'global', 'm-batch-broken.md'), 'not frontmatter', 'utf8')
  const res = service.forgetMany({ ids: ['m-batch-broken', 'm-batch-absent'] })
  assert.deepEqual(res.ids, ['m-batch-broken'])
  assert.deepEqual(res.notFound, ['m-batch-absent'])
  assert.equal(fs.existsSync(path.join(root, 'global', 'm-batch-broken.md')), false)
})

test('stats honours status/include_* so filtered view totals match the list', () => {
  const { service } = tmpService()
  const archived = service.save({ content: '归档统计条目', scope: 'global' })
  service.update({ id: archived.entry.id, archived: true })
  service.save({ content: '活跃统计条目', scope: 'global' })
  const active = service.stats({ scope: 'global' })
  assert.equal(active.total, 1)
  const archivedView = service.stats({ scope: 'global', status: 'archived', includeArchived: true })
  assert.equal(archivedView.total, 1)
  assert.equal(archivedView.byStatus.archived, 1)
  assert.equal(archivedView.byStatus.active, 1)
  const allView = service.stats({ scope: 'global', status: 'all', includeArchived: true })
  assert.equal(allView.total, 2)
})

test('search offset paginates without overlap', () => {
  const { service } = tmpService()
  for (let i = 0; i < 5; i++) service.save({ content: `服务分页 ${i}`, scope: 'global' })
  const p1 = service.search({ query: '服务分页', limit: 2, offset: 0 })
  const p2 = service.search({ query: '服务分页', limit: 2, offset: 2 })
  assert.equal(p1.length, 2)
  assert.equal(p2.length, 2)
  assert.equal(new Set([...p1, ...p2].map((e) => e.id)).size, 4)
})

const WS = 'D:\\proj\\alpha'

test('update with scope moves between global and workspace', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '可移动', scope: 'global' })
  const moved = service.update({ id: entry.id, scope: 'workspace', workspace: WS })
  assert.equal(moved.scope, 'workspace')
  assert.equal(service.list({ scope: 'global' }).length, 0)
  assert.equal(service.list({ scope: 'workspace', workspace: WS })[0].id, entry.id)
  const back = service.update({ id: entry.id, scope: 'global', workspace: WS })
  assert.equal(back.scope, 'global')
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).length, 0)
})

test('update scope validation: invalid scope, missing workspace, duplicate target', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '甲', scope: 'global' })
  assert.throws(() => service.update({ id: entry.id, scope: 'bogus' }), (err) => err.code === 'invalid')
  assert.throws(() => service.update({ id: entry.id, scope: 'workspace' }), (err) => err.code === 'no-workspace')
  service.save({ content: '甲', scope: 'workspace', workspace: WS })
  assert.throws(() => service.update({ id: entry.id, scope: 'workspace', workspace: WS }), (err) => err.code === 'duplicate')
  assert.equal(service.list({ scope: 'global' })[0].id, entry.id)
})

test('update same scope keeps working and can patch content while moving', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '旧', scope: 'global' })
  const same = service.update({ id: entry.id, scope: 'global', content: '新' })
  assert.equal(same.content, '新')
  assert.equal(same.scope, 'global')
  const moved = service.update({ id: entry.id, scope: 'workspace', workspace: WS, content: '更新又移动', category: 'decision' })
  assert.equal(moved.content, '更新又移动')
  assert.equal(moved.category, 'decision')
  assert.equal(moved.scope, 'workspace')
})

test('update move rejects credentials in new content', () => {
  const { service } = tmpService()
  const { entry } = service.save({ content: '正常', scope: 'global' })
  assert.throws(
    () => service.update({ id: entry.id, scope: 'workspace', workspace: WS, content: 'password = hunter2secret' }),
    (err) => err.code === 'secret',
  )
  assert.equal(service.list({ scope: 'global' })[0].content, '正常')
})

test('export produces a versioned document covering all scopes', () => {
  const { service } = tmpService()
  service.save({ content: '全局偏好', scope: 'global', category: 'preference', tags: ['语言'] })
  service.save({ content: '工作区事实', scope: 'workspace', workspace: WS })
  const doc = service.export()
  assert.equal(doc.format, 'dsh-memory-export')
  assert.equal(doc.version, 1)
  assert.ok(doc.exportedAt)
  assert.equal(doc.entries.length, 2)
  const globalEntry = doc.entries.find((e) => e.scope === 'global')
  assert.equal(globalEntry.workspace, null)
  assert.deepEqual(globalEntry.tags, ['语言'])
  const wsEntry = doc.entries.find((e) => e.scope === 'workspace')
  assert.equal(wsEntry.workspace.toLowerCase(), WS.toLowerCase())
  assert.ok(wsEntry.created && wsEntry.updated && wsEntry.id)
})

test('import dryRun plans without writing', () => {
  const { service } = tmpService()
  const plan = service.import({
    dryRun: true,
    entries: [
      { content: '新记忆', scope: 'global', category: 'fact' },
      { content: 'password = hunter2secret', scope: 'global' },
    ],
  })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.imported, 1)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].code, 'secret')
  assert.equal(service.list({ scope: 'all' }).length, 0)
})

test('import writes entries preserving id, timestamps, tags and source', () => {
  const { service } = tmpService()
  const result = service.import({
    entries: [{
      id: 'm-import-aaaaaa',
      content: '导入的记忆',
      scope: 'global',
      category: 'preference',
      tags: ['导入', '导入', 'x'.repeat(100)],
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      source: 'old-session',
    }],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.deduplicated, 0)
  assert.equal(result.rejected.length, 0)
  const entries = service.list({ scope: 'global' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'm-import-aaaaaa')
  assert.equal(entries[0].created, '2026-01-01T00:00:00.000Z')
  assert.equal(entries[0].updated, '2026-01-02T00:00:00.000Z')
  assert.equal(entries[0].source, 'old-session')
  assert.deepEqual(entries[0].tags, ['导入', 'x'.repeat(64)])
})

test('import deduplicates against disk and within the batch', () => {
  const { service } = tmpService()
  service.save({ content: '已存在', scope: 'global' })
  const result = service.import({
    entries: [
      { content: '已存在', scope: 'global' },
      { content: '批量新条目', scope: 'global' },
      { content: '  批量新条目  ', scope: 'global' },
    ],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.deduplicated, 2)
  assert.equal(service.list({ scope: 'global' }).length, 2)
})

test('import rejects invalid entries individually and keeps going', () => {
  const { service } = tmpService()
  const result = service.import({
    entries: [
      { content: '   ', scope: 'global' },
      { content: 'x', scope: 'global', category: 'bogus' },
      { content: 'x', scope: 'bogus' },
      { content: '缺工作区', scope: 'workspace' },
      { content: '有效条目', scope: 'workspace', workspace: WS },
    ],
  })
  assert.equal(result.imported, 1)
  assert.equal(result.rejected.length, 4)
  assert.deepEqual(result.rejected.map((r) => r.code), ['invalid', 'invalid', 'invalid', 'no-workspace'])
  assert.equal(service.list({ scope: 'workspace', workspace: WS }).length, 1)
  assert.throws(() => service.import({ entries: 'not-an-array' }), (err) => err.code === 'invalid')
})

test('import resolves id collisions by allocating a new id', () => {
  const { service } = tmpService()
  service.import({ entries: [{ id: 'm-collide-aaaaaa', content: '原条目', scope: 'global' }] })
  const result = service.import({ entries: [{ id: 'm-collide-aaaaaa', content: '不同内容', scope: 'global' }] })
  assert.equal(result.imported, 1)
  const entries = service.list({ scope: 'global' })
  assert.equal(entries.length, 2)
  const ids = entries.map((e) => e.id)
  assert.ok(ids.includes('m-collide-aaaaaa'))
  assert.equal(new Set(ids).size, 2)
})

test('import avoids ids shadowed by global entries (findEntry prefers global)', () => {
  const { service } = tmpService()
  service.import({ entries: [{ id: 'm-shadow-aaaaaa', content: '全局原条目', scope: 'global' }] })
  const result = service.import({ entries: [{ id: 'm-shadow-aaaaaa', content: '工作区新条目', scope: 'workspace', workspace: WS }] })
  assert.equal(result.imported, 1)
  const wsEntry = service.list({ scope: 'workspace', workspace: WS })[0]
  assert.notEqual(wsEntry.id, 'm-shadow-aaaaaa', 'workspace import must not reuse a global id')
  // updating the workspace entry by its new id must hit the workspace entry
  const updated = service.update({ id: wsEntry.id, content: '改对了', workspace: WS })
  assert.equal(updated.scope, 'workspace')
  assert.equal(service.list({ scope: 'global' })[0].content, '全局原条目')
})

test('export -> import roundtrip into a fresh root restores everything', () => {
  const { service } = tmpService()
  service.save({ content: '全局偏好', scope: 'global', category: 'preference', tags: ['语言'] })
  service.save({ content: '工作区事实', scope: 'workspace', workspace: WS, category: 'decision' })
  const doc = service.export()
  const fresh = tmpService().service
  const result = fresh.import({ entries: doc.entries })
  assert.equal(result.imported, 2)
  assert.equal(result.deduplicated, 0)
  assert.equal(result.rejected.length, 0)
  const before = doc.entries.slice().sort((a, b) => a.id.localeCompare(b.id))
  const after = fresh.export().entries.slice().sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(after.map((e) => ({ ...e, workspace: e.workspace && e.workspace.toLowerCase() })), before.map((e) => ({ ...e, workspace: e.workspace && e.workspace.toLowerCase() })))
})
