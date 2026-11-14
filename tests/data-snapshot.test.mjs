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
import { snapshotDataRoot, diffSnapshots, evacuateOldestBackup, restoreEvacuatedBackups, PLUGIN_BACKUP_PATTERN } from '../scripts/data-snapshot.mjs'

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

test('O12: root-level stray json and unexpected-dir markdown are visible in diff', () => {
  const root = makeRoot()
  const before = snapshotDataRoot(root)
  fs.writeFileSync(path.join(root, 'foo.json'), '{}', 'utf8')
  fs.mkdirSync(path.join(root, 'other'), { recursive: true })
  fs.writeFileSync(path.join(root, 'other', 'x.md'), 'stray', 'utf8')
  const after = snapshotDataRoot(root)
  const changes = diffSnapshots(before, after)
  assert.ok(changes.some((c) => c.includes('foo.json')), `stray root json must be detected: ${JSON.stringify(changes)}`)
  assert.ok(changes.some((c) => c.includes('other/x.md')), `stray subdir markdown must be detected: ${JSON.stringify(changes)}`)
  fs.rmSync(root, { recursive: true, force: true })
})

test('O3: evacuate/restore protects the oldest plugin backup at the retention ceiling', () => {
  const root = makeRoot()
  const dir = path.join(root, 'backups')
  // 造 30 份插件时间戳备份 + 1 份用户手放文件。
  const names = []
  for (let i = 0; i < 30; i += 1) {
    const name = `dsh-memory-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.json`
    fs.writeFileSync(path.join(dir, name), `{"n":${i}}`, 'utf8')
    // 让第 0 份最旧。
    const t = new Date(Date.now() - (30 - i) * 60_000)
    fs.utimesSync(path.join(dir, name), t, t)
    names.push(name)
  }
  fs.writeFileSync(path.join(dir, 'user-manual.json'), '{"user":true}', 'utf8')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-evac-'))
  const evacuated = evacuateOldestBackup(root, tmp, 30)
  assert.equal(evacuated.length, 1, 'must evacuate exactly the oldest one')
  assert.equal(evacuated[0].name, names[0])
  // 模拟轮转删掉最旧一份。
  fs.rmSync(path.join(dir, names[0]), { force: true })
  const restored = restoreEvacuatedBackups(root, evacuated)
  assert.deepEqual(restored, [names[0]], 'deleted oldest must be restored from temp copy')
  assert.equal(fs.readFileSync(path.join(dir, names[0]), 'utf8'), '{"n":0}')
  // 用户手放文件与其余备份不受影响。
  assert.ok(fs.existsSync(path.join(dir, 'user-manual.json')))
  assert.equal(fs.readdirSync(dir).filter((n) => PLUGIN_BACKUP_PATTERN.test(n)).length, 30)
  // 临时副本已清理。
  assert.equal(fs.existsSync(evacuated[0].tempPath), false)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('O3: below the ceiling nothing is evacuated', () => {
  const root = makeRoot()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-evac-'))
  assert.deepEqual(evacuateOldestBackup(root, tmp, 30), [], 'few backups → no evacuation')
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

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