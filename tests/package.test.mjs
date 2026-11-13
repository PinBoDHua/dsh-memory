/**
 * 包元数据一致性（第四轮审计：files 曾漏 scripts、验证入口在 npm 包里不可用）。
 * 运行 Run: node --test tests/package.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('published files include verification scripts and docs', () => {
  assert.ok(Array.isArray(pkg.files))
  for (const entry of ['index.js', 'lib', 'client', 'docs', 'scripts', 'tests', 'locale/*.json']) {
    assert.ok(pkg.files.includes(entry), `package.files must include ${entry}`)
  }
})

test('no runtime dependencies; node engine matches modern ESM requirements', () => {
  assert.equal(pkg.dependencies, undefined, 'plugin must stay dependency-free')
  assert.match(String(pkg.engines?.node ?? ''), />=\s*2[2-9]/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
})