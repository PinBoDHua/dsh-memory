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

function seed(root) {
  const service = createMemoryService({ root })
  const marker = service.save({ content: '__gui_p1_残留测试', scope: 'global' })
  const markerLive = service.save({ content: '__livecheck_残留测试', scope: 'global' })
  const user = service.save({ content: '真实用户记忆', scope: 'global' })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-baseline.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(root, 'backups', 'dsh-memory-test-new.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(root, 'settings.json'), '{"autoInject":false}', 'utf8')
  for (const name of ['.lock-verify', '.lock-settings', '.lock-import']) {
    fs.mkdirSync(path.join(root, name))
    fs.writeFileSync(path.join(root, name, 'owner'), '999999', 'utf8')
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
    backupsBefore: ['dsh-memory-baseline.json'],
  })
  assert.equal(result.entries.deleted, 2)
  assert.equal(result.settings, 'removed')
  assert.deepEqual(result.backups, ['dsh-memory-test-new.json'])
  assert.deepEqual(result.locks.sort(), ['.lock-import', '.lock-settings', '.lock-verify'])
  const after = createMemoryService({ root }).list({ scope: 'global' })
  assert.deepEqual(after.map((e) => e.id).sort(), [user.entry.id], 'only real user entry remains')
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups')), ['dsh-memory-baseline.json'])
  assert.equal(fs.existsSync(path.join(root, 'settings.json')), false)
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.lock')), [])
  assert.ok(marker.entry.id && markerLive.entry.id)
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