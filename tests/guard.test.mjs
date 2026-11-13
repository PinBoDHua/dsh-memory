/**
 * dsh-memory 0.15.0：隐私护栏扩充（更多独立令牌格式）。
 * 缝 1（guard.detectSecret 纯逻辑）。正样本用假令牌（仅匹配格式，非真实凭据）。
 * 运行 Run: node --test tests/guard.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectSecret } from '../lib/guard.js'

const rep = (c, n) => c.repeat(n)

test('guard: rejects GitLab / npm / Stripe / SendGrid / PyPI standalone tokens', () => {
  const positives = [
    'glpat-' + rep('a', 20),
    'npm_' + rep('a', 36),
    'sk_live_' + rep('a', 20),
    'rk_live_' + rep('a', 20),
    'sk_test_' + rep('a', 20),
    'SG.' + rep('a', 22) + '.' + rep('b', 43),
    'pypi-' + rep('a', 30),
  ]
  for (const text of positives) assert.ok(detectSecret(text), `should reject: ${text}`)
})

test('guard: rejects all GitHub token prefixes (ghp/gho/ghu/ghs/ghr)', () => {
  for (const p of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
    const text = p + '_' + rep('a', 30)
    assert.ok(detectSecret(text), `should reject: ${text}`)
  }
  assert.ok(detectSecret('github_pat_' + rep('a', 30)), 'github_pat_ still rejected')
})

test('guard: detects tokens embedded in a sentence', () => {
  assert.ok(detectSecret('我的 GitLab 令牌是 glpat-' + rep('x', 24) + ' 请妥善保管'))
  assert.ok(detectSecret('npm token: npm_' + rep('z', 36)))
})

test('guard: prefix mentions without a long token body still pass (no false positives)', () => {
  const negatives = [
    'glpat- 是 GitLab 个人访问令牌的前缀',
    'npm_ 前缀的令牌属于 npm',
    'Stripe 的 sk_live_ 前缀表示生产密钥',
    'SendGrid 密钥以 SG. 开头',
    'pypi- 开头的令牌用于 PyPI 上传',
    'GitHub token 前缀有 ghp_ gho_ ghu_ ghs_ ghr_',
    '项目使用 pnpm 管理依赖',
    'memory token budget is 6000 chars',
  ]
  for (const text of negatives) assert.equal(detectSecret(text), null, `should pass: ${text}`)
})
