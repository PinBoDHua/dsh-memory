/**
 * 包元数据一致性（第四轮审计：files 曾漏 scripts、验证入口在 npm 包里不可用）。
 * 运行 Run: node --test tests/package.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('published files include verification scripts and the detail doc', () => {
  assert.ok(Array.isArray(pkg.files))
  // O15：docs 整目录改为精确条目——内部台账 ITERATION.md（含本机路径/代理）不随包发布。
  for (const entry of ['index.js', 'lib', 'client', 'docs/DETAIL.md', 'scripts', 'tests', 'locale/*.json']) {
    assert.ok(pkg.files.includes(entry), `package.files must include ${entry}`)
  }
  assert.ok(!pkg.files.includes('docs'), 'internal docs ledger must not be published wholesale')
})

test('no runtime dependencies; node engine matches modern ESM requirements', () => {
  assert.equal(pkg.dependencies, undefined, 'plugin must stay dependency-free')
  assert.match(String(pkg.engines?.node ?? ''), />=\s*2[2-9]/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
})

test('O15: locale metadata is well-formed and detail/icon targets exist', () => {
  for (const lang of ['zh', 'en']) {
    const loc = JSON.parse(fs.readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(loc.meta && typeof loc.meta === 'object', `${lang}: meta missing`)
    for (const key of ['title', 'description', 'detail']) {
      assert.ok(typeof loc.meta[key] === 'string' && loc.meta[key].trim() !== '', `${lang}: meta.${key} must be non-empty`)
    }
    const detailUrl = new URL(`../${loc.meta.detail}`, import.meta.url)
    assert.ok(fs.existsSync(detailUrl), `${lang}: detail target ${loc.meta.detail} must exist`)
    assert.ok(fs.statSync(detailUrl).size < 1024 * 1024, `${lang}: detail must be < 1MiB`)
  }
  const icon = new URL('../icon.svg', import.meta.url)
  assert.ok(fs.existsSync(icon), 'icon.svg must exist')
  assert.ok(fs.statSync(icon).size < 100 * 1024, 'icon.svg must be < 100KiB')
  // zh/en 键结构一致。
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
})