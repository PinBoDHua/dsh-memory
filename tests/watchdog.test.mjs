/**
 * 强杀看门狗测试：父验证脚本死亡后，测试记忆/设置/备份/锁必须被自动恢复。
 * 运行 Run: node --test tests/watchdog.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryService } from '../lib/service.js'
import { runWatchdogOnce } from '../scripts/watchdog.mjs'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-watchdog-'))
}

// O13①：哨兵 pid + process.kill mock 确定性模拟「owner 已死」（跨平台可靠）。
const DEAD_PID = 999999
const realKill = process.kill
process.kill = function (pid, sig) {
  if (pid === DEAD_PID && (sig === 0 || sig === undefined)) {
    const e = new Error('ESRCH: no such process'); e.code = 'ESRCH'; throw e
  }
  return realKill.call(process, pid, sig)
}

function seed(root) {
  const service = createMemoryService({ root })
  const marker = service.save({ content: '__gui_p1_残留测试', scope: 'global' })
  const markerLive = service.save({ content: '__livecheck_残留测试', scope: 'global' })
  const user = service.save({ content: '真实用户记忆', scope: 'global' })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  // O7：只轮转插件自己的时间戳备份；用户手放文件绝不动。用合法插件备份名。
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-2026-01-01T00-00-00-000Z.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-2026-01-02T00-00-00-000Z.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'user-manual-note.json'), '{"user":true}', 'utf8')
  fs.writeFileSync(path.join(root, 'settings.json'), '{"autoInject":false}', 'utf8')
  const dead = String(DEAD_PID)
  const old = new Date(Date.now() - 60_000)
  for (const name of ['.lock-verify', '.lock-settings', '.lock-import']) {
    fs.mkdirSync(path.join(root, name))
    fs.writeFileSync(path.join(root, name, 'owner'), dead, 'utf8')
    // O5：lib 锁（nonce owner）按 mtime 陈旧判据删除——陈旧锁模拟崩溃残留。
    fs.utimesSync(path.join(root, name), old, old)
  }
  return { marker, markerLive, user }
}

test('watchdog removes test markers, restores settings/backups and clears locks', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { marker, markerLive, user } = seed(root)
  const result = runWatchdogOnce({
    root,
    markers: ['__gui_', '__livecheck_'],
    settingsBefore: { exists: false },
    backupsBefore: ['dsh-memory-2026-01-01T00-00-00-000Z.json'],
    startedAt: Date.now() - 60_000,
  })
  assert.equal(result.entries.deleted, 2)
  assert.equal(result.settings, 'removed')
  assert.deepEqual(result.backups, ['dsh-memory-2026-01-02T00-00-00-000Z.json'])
  assert.deepEqual(result.locks.sort(), ['.lock-import', '.lock-settings', '.lock-verify'])
  const after = createMemoryService({ root }).list({ scope: 'global' })
  assert.deepEqual(after.map((e) => e.id).sort(), [user.entry.id], 'only real user entry remains')
  const backupsLeft = fs.readdirSync(path.join(root, 'backups')).sort()
  assert.deepEqual(backupsLeft, ['dsh-memory-2026-01-01T00-00-00-000Z.json', 'user-manual-note.json'], 'baseline backup + user manual file kept (O7)')
  assert.equal(fs.existsSync(path.join(root, 'settings.json')), false)
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.lock')), [])
  assert.ok(marker.entry.id && markerLive.entry.id)
})

test('O3: a thrown forgetEntries batch counts as failed (watchdog must retry, not delete manifest)', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root)
  // 让写锁被「另一进程」持有：forgetEntries 获取 .lock-write 超时抛错。
  // 预先创建新鲜锁目录即可（withLock 等待 3s 后抛 code=busy）。
  fs.mkdirSync(path.join(root, '.lock-write'))
  try {
    const result = runWatchdogOnce({ root, markers: ['__gui_', '__livecheck_'], backupsBefore: [] })
    assert.equal(result.entries.matched, 2)
    assert.equal(result.entries.deleted, 0)
    assert.equal(result.entries.failed, 2, 'thrown batch must be reported as failed (not silently "cleaned")')
  } finally {
    fs.rmSync(path.join(root, '.lock-write'), { recursive: true, force: true })
  }
})

test('watchdog restores a pre-existing settings baseline verbatim', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root)
  const original = '{\n  "autoInject": true,\n  "pageSize": 25\n}\n'
  const result = runWatchdogOnce({
    root,
    settingsBefore: { exists: true, content: original },
    backupsBefore: [],
  })
  assert.equal(result.settings, 'restored')
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), original)
})

test('watchdog is idempotent and tolerates a missing root', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root)
  const manifest = { root, settingsBefore: { exists: false }, backupsBefore: [] }
  const first = runWatchdogOnce(manifest)
  assert.equal(first.entries.deleted, 2)
  const second = runWatchdogOnce(manifest)
  assert.equal(second.entries.matched, 0)
  assert.equal(runWatchdogOnce({ root: path.join(root, 'missing-root') }).skipped, true)
})

test('O5: watchdog never deletes a live-owner verify lock or a fresh lib lock', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // 活 owner 的 .lock-verify（本进程存活）不得删。
  const verify = path.join(root, '.lock-verify')
  fs.mkdirSync(verify, { recursive: true })
  fs.writeFileSync(path.join(verify, 'owner'), `${process.pid}\nnonce`, 'utf8')
  // 新鲜的 .lock-import（宿主可能正持有）不得删。
  const imp = path.join(root, '.lock-import')
  fs.mkdirSync(imp, { recursive: true })
  fs.writeFileSync(path.join(imp, 'owner'), 'host-nonce', 'utf8')
  const result = runWatchdogOnce({ root, settingsBefore: { exists: false }, backupsBefore: [] })
  assert.ok(fs.existsSync(verify), 'live-owner verify lock must survive')
  assert.ok(fs.existsSync(imp), 'fresh lib lock must survive')
  assert.ok(!result.locks.includes('.lock-verify'))
  assert.ok(!result.locks.includes('.lock-import'))
})

test('O10: watchdog removes registered non-marker artifacts', (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const artifact = path.join(root, 'global', 'm-broken-artifact.md')
  fs.mkdirSync(path.join(root, 'global'), { recursive: true })
  fs.writeFileSync(artifact, 'not frontmatter', 'utf8')
  const result = runWatchdogOnce({ root, settingsBefore: { exists: false }, backupsBefore: [], artifacts: [artifact] })
  assert.equal(fs.existsSync(artifact), false, 'registered artifact must be removed')
  assert.deepEqual(result.artifacts, [artifact])
})