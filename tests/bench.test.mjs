/**
 * scripts/bench.mjs 目录安全决策单测：绝不静默删除用户目录。
 * 运行 Run: node --test tests/bench.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBenchRebuild, resolveBenchWriteMode } from '../scripts/bench.mjs'

function tmpDir(prefix = 'dsh-memtest-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('missing directory is built', (t) => {
  const dir = path.join(tmpDir(), 'nested')
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }))
  assert.equal(resolveBenchRebuild({ dir }), 'build')
})

test('existing marked bench directory rebuilds with --regen', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, '.bench-root'), 'generated', 'utf8')
  fs.mkdirSync(path.join(dir, 'global'), { recursive: true })
  assert.equal(resolveBenchRebuild({ dir, regen: true }), 'build')
  assert.equal(resolveBenchRebuild({ dir }), 'reuse')
})

test('existing data root is reused without --regen', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'global'), { recursive: true })
  assert.equal(resolveBenchRebuild({ dir }), 'reuse')
  assert.throws(() => resolveBenchRebuild({ dir, regen: true }), (err) => err.code === 'refuse')
})

test('non-bench directory is never touched without force', (t) => {
  const dir = tmpDir('user-data-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'important.txt'), 'keep', 'utf8')
  assert.throws(() => resolveBenchRebuild({ dir }), (err) => err.code === 'refuse')
  assert.throws(() => resolveBenchRebuild({ dir, regen: true }), (err) => err.code === 'refuse')
  assert.equal(resolveBenchRebuild({ dir, regen: true, force: true }), 'build')
  assert.equal(fs.readFileSync(path.join(dir, 'important.txt'), 'utf8'), 'keep', 'decision must not delete anything')
})

test('O2: reuse without marker is read-only (must not delete real memories)', (t) => {
  const dir = tmpDir('user-data-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'global'), { recursive: true })
  // 无 marker/基准目录名的真实数据根：reuse 但只读。
  assert.equal(resolveBenchRebuild({ dir }), 'reuse')
  assert.equal(resolveBenchWriteMode({ dir, mode: 'reuse' }), 'read-only')
  // 带 marker 的基准根：可写（forget/flush 测量）。
  fs.writeFileSync(path.join(dir, '.bench-root'), 'generated', 'utf8')
  assert.equal(resolveBenchWriteMode({ dir, mode: 'reuse' }), 'read-write')
  // build 模式总是可写。
  assert.equal(resolveBenchWriteMode({ dir, mode: 'build' }), 'read-write')
})