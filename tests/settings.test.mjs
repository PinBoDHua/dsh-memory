/**
 * v0.7.0 设置层单测：sanitize/夹取、覆盖层读写重置、有效值优先级。
 * 运行 Run: node --test tests/settings.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  assert.equal(out.animations, false)
  assert.equal(out.relativeTime, false)
  assert.ok(!('bogusKey' in out))
  const dropped = settings.sanitizeSettings({ autoInject: 'yes', injectionBudgetChars: 'abc', defaultView: 'nope', pageSize: 999 })
  assert.deepEqual(dropped, {})
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
