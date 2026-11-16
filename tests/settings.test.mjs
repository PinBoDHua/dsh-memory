/**
 * v0.7.0 设置层单测：sanitize/夹取、覆盖层读写重置、有效值优先级。
 * 运行 Run: node --test tests/settings.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as settings from '../lib/settings.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-settings-'))
}

test('sanitize clamps numbers, keeps valid enums/booleans, drops unknown/invalid', () => {
  const out = settings.sanitizeSettings({
    autoInject: false,
    injectionBudgetChars: 999999,
    autoBackup: true,
    backupRetention: 0,
    defaultView: 'workspace',
    pageSize: 100,
    viewMode: 'compact',
    animations: false,
    relativeTime: false,
    bogusKey: 1,
    pageSizeBad: 'x',
  })
  assert.equal(out.autoInject, false)
  assert.equal(out.injectionBudgetChars, settings.BUDGET_MAX)
  assert.equal(out.autoBackup, true)
  assert.equal(out.backupRetention, settings.RETENTION_MIN)
  assert.equal(out.defaultView, 'workspace')
  assert.equal(out.pageSize, 100)
  assert.equal(out.viewMode, 'compact')
  assert.equal(out.animations, false)
  assert.equal(out.relativeTime, false)
  assert.ok(!('bogusKey' in out))
  const dropped = settings.sanitizeSettings({ autoInject: 'yes', injectionBudgetChars: 'abc', defaultView: 'nope', pageSize: 999, viewMode: 'spacious' })
  assert.deepEqual(dropped, {})
  assert.equal(settings.SETTINGS_DEFAULTS.viewMode, 'comfortable')
  assert.deepEqual(settings.VIEW_MODES, ['comfortable', 'compact'])
  assert.equal(settings.sanitizeSettings({ injectionBudgetChars: -5 }).injectionBudgetChars, 0)
  assert.equal(settings.sanitizeSettings({ injectionBudgetChars: 1234.6 }).injectionBudgetChars, 1235)
})

test('readOverlay tolerates missing and corrupt files', () => {
  const root = tmpRoot()
  assert.deepEqual(settings.readOverlay(root), {})
  fs.writeFileSync(path.join(root, 'settings.json'), '{corrupt', 'utf8')
  assert.deepEqual(settings.readOverlay(root), {})
})

test('readOverlay tolerates a UTF-8 BOM (hand-edited via Windows Notepad)', () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'settings.json'), '﻿{"pageSize":100,"autoInject":false}', 'utf8')
  const overlay = settings.readOverlay(root)
  assert.equal(overlay.pageSize, 100)
  assert.equal(overlay.autoInject, false)
})

test('effective precedence: defaults < profile base < overlay', () => {
  const root = tmpRoot()
  const base = { autoInject: false, injectionBudgetChars: 1234 }
  let eff = settings.effectiveSettings(base, root)
  assert.equal(eff.autoInject, false)
  assert.equal(eff.injectionBudgetChars, 1234)
  assert.equal(eff.pageSize, 50)
  settings.writeOverlay(root, { autoInject: true, pageSize: 20 })
  eff = settings.effectiveSettings(base, root)
  assert.equal(eff.autoInject, true, 'overlay overrides base')
  assert.equal(eff.injectionBudgetChars, 1234, 'base still applies where overlay silent')
  assert.equal(eff.pageSize, 20)
})

test('viewMode defaults to comfortable and persists through the settings overlay', () => {
  const root = tmpRoot()
  assert.equal(settings.effectiveSettings({}, root).viewMode, 'comfortable', 'legacy settings fall back to comfortable')
  assert.equal(settings.writeOverlay(root, { viewMode: 'compact' }).viewMode, 'compact')
  assert.equal(settings.effectiveSettings({}, root).viewMode, 'compact')
  // 非法值被 sanitize 丢弃，不覆盖既有合法值。
  settings.writeOverlay(root, { viewMode: 'spacious' })
  assert.equal(settings.effectiveSettings({}, root).viewMode, 'compact')
  settings.resetOverlay(root)
  assert.equal(settings.effectiveSettings({}, root).viewMode, 'comfortable')
})

test('overlay lock contention surfaces as code=busy for write and reset', () => {
  const root = tmpRoot()
  const lockPath = path.join(root, '.lock-settings')
  fs.mkdirSync(lockPath, { recursive: true })
  try {
    assert.throws(() => settings.writeOverlay(root, { pageSize: 20 }), (err) => err.code === 'busy')
    assert.throws(() => settings.resetOverlay(root), (err) => err.code === 'busy')
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true })
  }
  // 锁释放后恢复正常（pageSize 必须是允许枚举 20/50/100）。
  assert.equal(settings.writeOverlay(root, { pageSize: 20 }).pageSize, 20)
  assert.equal(settings.resetOverlay(root), undefined)
  assert.deepEqual(settings.readOverlay(root), {})
})

test('writeOverlay merges and persists; resetOverlay removes the file', () => {
  const root = tmpRoot()
  settings.writeOverlay(root, { autoInject: false })
  settings.writeOverlay(root, { pageSize: 100 })
  const overlay = settings.readOverlay(root)
  assert.equal(overlay.autoInject, false)
  assert.equal(overlay.pageSize, 100)
  const file = path.join(root, 'settings.json')
  assert.ok(fs.existsSync(file))
  settings.resetOverlay(root)
  assert.ok(!fs.existsSync(file))
  assert.deepEqual(settings.readOverlay(root), {})
})

test('writeOverlay never materializes untouched nested defaults', () => {
  const root = tmpRoot()
  settings.writeOverlay(root, { pageSize: 20 })
  const file = path.join(root, 'settings.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(!('autoLearn' in raw), 'nested autoLearn defaults must not be written by an unrelated save')
  assert.ok(!('digest' in raw), 'nested digest defaults must not be written by an unrelated save')
  assert.equal(settings.effectiveSettings({}, root).autoLearn.maxWritesPerSession, 5, 'defaults still apply effectively')
  // 显式写嵌套键只落该键，其它嵌套默认仍不物化。
  settings.writeOverlay(root, { autoLearn: { maxWritesPerSession: 2 } })
  const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw2.autoLearn, { maxWritesPerSession: 2 })
  assert.ok(!('digest' in raw2))
  assert.equal(settings.effectiveSettings({}, root).digest.enabled, true)
  // 再次写普通键不丢失既有嵌套覆盖。
  settings.writeOverlay(root, { autoInject: false })
  assert.deepEqual(settings.readOverlay(root).autoLearn, { maxWritesPerSession: 2 })
  // 多子键命名空间同样只落显式写过的子键：digest.weekday 默认值不得被物化。
  settings.writeOverlay(root, { digest: { enabled: false } })
  const raw3 = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw3.digest, { enabled: false }, 'untouched default weekday must not be materialized')
  settings.writeOverlay(root, { digest: { weekday: 3 } })
  const raw4 = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw4.digest, { enabled: false, weekday: 3 }, 'previously touched subkeys survive later writes')
  const eff = settings.effectiveSettings({}, root)
  assert.equal(eff.digest.enabled, false)
  assert.equal(eff.digest.weekday, 3)
})

test('concurrent process writes to different keys do not lose each other (overlay lock)', async () => {
  const root = tmpRoot()
  const fixture = fileURLToPath(new URL('./fixtures/settings-worker.mjs', import.meta.url))
  // 真正并发：两个子进程同时写不同键（此前 spawnSync 是串行，无法捕获丢键回归）。
  const run = (key) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture, root, key, '80'], { stdio: 'ignore' })
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
  const [codeA, codeB] = await Promise.all([run('autoInject'), run('decayEnabled')])
  assert.equal(codeA, 0)
  assert.equal(codeB, 0)
  const overlay = settings.readOverlay(root)
  assert.ok('autoInject' in overlay, 'autoInject key survived concurrent writes')
  assert.ok('decayEnabled' in overlay, 'decayEnabled key survived concurrent writes')
})
