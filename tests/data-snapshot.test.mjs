/**
 * dsh-memory：脚本真实数据根快照工具（scripts/data-snapshot.mjs）单测。
 * 用于保证 live-check / gui-check 运行前后用户数据零差异。
 * 运行 Run: node --test tests/data-snapshot.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotDataRoot, diffSnapshots } from '../scripts/data-snapshot.mjs'

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-snap-'))
  fs.mkdirSync(path.join(root, 'global'), { recursive: true })
  fs.mkdirSync(path.join(root, 'workspaces', '0123456789abcdef'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(root, 'global', 'm-a.md'), 'entry a', 'utf8')
  fs.writeFileSync(path.join(root, 'workspaces', '0123456789abcdef', 'm-b.md'), 'entry b', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-2026-01-01T00-00-00-000Z.json'), '{"entries":[]}', 'utf8')
  fs.writeFileSync(path.join(root, 'settings.json'), '{"pageSize":20}', 'utf8')
  fs.writeFileSync(path.join(root, 'meta.json'), '{"schemaVersion":2}', 'utf8')
  fs.writeFileSync(path.join(root, 'access.json'), '{"m-a":{"at":"2026-01-01T00:00:00.000Z","count":1}}', 'utf8')
  return root
}

test('snapshot captures entries, backup hashes, settings and meta', () => {
  const root = makeRoot()
  const snap = snapshotDataRoot(root)
  assert.deepEqual(Object.keys(snap.entries).sort(), ['global/m-a.md', 'workspaces/0123456789abcdef/m-b.md'])
  assert.ok(snap.backups['dsh-memory-2026-01-01T00-00-00-000Z.json'], 'backup content hash recorded')
  assert.ok(snap.settings)
  assert.ok(snap.meta)
  assert.deepEqual(snap.junk, [], 'clean root has no junk')
  assert.equal(snapshotDataRoot(null), null)
})

test('diffSnapshots reports no changes for identical roots and ignores access.json', () => {
  const root = makeRoot()
  const before = snapshotDataRoot(root)
  fs.writeFileSync(path.join(root, 'access.json'), '{"m-a":{"at":"2026-06-01T00:00:00.000Z","count":9}}', 'utf8')
  const after = snapshotDataRoot(root)
  assert.deepEqual(diffSnapshots(before, after), [], 'hit ledger is derived data and may change')
})

test('diffSnapshots detects entry edits/additions/removals, settings, backup changes and junk', () => {
  const root = makeRoot()
  const before = snapshotDataRoot(root)
  fs.writeFileSync(path.join(root, 'global', 'm-a.md'), 'entry a edited', 'utf8')
  fs.writeFileSync(path.join(root, 'global', 'm-new.md'), 'entry new', 'utf8')
  fs.rmSync(path.join(root, 'workspaces', '0123456789abcdef', 'm-b.md'))
  fs.writeFileSync(path.join(root, 'settings.json'), '{"pageSize":50}', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-2026-02-02T00-00-00-000Z.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-2026-01-01T00-00-00-000Z.json'), '{"entries":["changed"]}', 'utf8')
  fs.writeFileSync(path.join(root, 'global', 'm-a.md.tmp-1234abcd'), 'tmp', 'utf8')
  fs.writeFileSync(path.join(root, 'global', 'scratch-note.json'), '{}', 'utf8')
  fs.mkdirSync(path.join(root, '.lock-import'))
  const changes = diffSnapshots(before, snapshotDataRoot(root))
  assert.ok(changes.some((c) => c.includes('修改 global/m-a.md')), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('新增 global/m-new.md')), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('删除 workspaces/0123456789abcdef/m-b.md')), JSON.stringify(changes))
  assert.ok(changes.includes('settings.json 变更'), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('修改 dsh-memory-2026-01-01T00-00-00-000Z.json')), 'backup content change detected')
  assert.ok(changes.some((c) => c.includes('新增 dsh-memory-2026-02-02T00-00-00-000Z.json')), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('垃圾文件新增 .lock-import')), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('垃圾文件新增 global/m-a.md.tmp-1234abcd')), JSON.stringify(changes))
  assert.ok(changes.some((c) => c.includes('垃圾文件新增 global/scratch-note.json')), JSON.stringify(changes))
})

test('snapshot ignores the derived .cache index directory', () => {
  const root = makeRoot()
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true })
  fs.writeFileSync(path.join(root, '.cache', 'entries-v1.json'), '{"indexVersion":1}', 'utf8')
  const snap = snapshotDataRoot(root)
  assert.deepEqual(snap.junk, [], '.cache is derived data, not junk')
})

test('snapshot ignores the verification lock directory but detects other locks', () => {
  const root = makeRoot()
  fs.mkdirSync(path.join(root, '.lock-verify'))
  const snap = snapshotDataRoot(root)
  assert.deepEqual(snap.junk, [], '.lock-verify belongs to the verification scripts themselves')
  fs.mkdirSync(path.join(root, 'workspaces', '.lock'))
  assert.deepEqual(snapshotDataRoot(root).junk, ['workspaces/.lock'])
})

test('diffSnapshots handles unavailable snapshots', () => {
  assert.deepEqual(diffSnapshots(null, null), ['快照不可用'])
})