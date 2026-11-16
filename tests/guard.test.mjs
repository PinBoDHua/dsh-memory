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

test('guard: rejects compound credential names with identifier prefixes (H1)', () => {
  // snake_case 复合名此前因 \b 词边界（_ 是词字符）整体绕过凭据赋值正则。
  const positives = [
    'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'AWS_SECRET_ACCESS_KEY: abcd1234efgh5678',
    'client_secret=abc123def456',
    'secret_access_key: hunter2hunter2',
    'db_password=hunter2hunter2',
    'oauth_consumer_secret: xyz987654321',
    'my_access_key=abcdef123456',
    'session_token=abcdef123456',
  ]
  for (const text of positives) assert.ok(detectSecret(text), `should reject: ${text}`)
})

test('guard: compound-name hardening does not flag benign policy prose (H1)', () => {
  const negatives = [
    'password_policy: 至少八位',
    'token_budget 是注入预算',
    'the password= field is required',
    'max_token_count=123456',
    'refresh_token_expiry: 3600seconds',
    '项目使用 pnpm 管理依赖',
  ]
  for (const text of negatives) assert.equal(detectSecret(text), null, `should pass: ${text}`)
})

test('guard: credential scan is linear on long alphanumeric blobs (no ReDoS)', () => {
  // 大备份/哈希/base64 等长字母数字串不得触发灾难性回溯阻塞宿主（第十二轮 H1 回归）。
  const blobs = ['x'.repeat(1_200_000), ('Ab3_'.repeat(300_000)), ('a'.repeat(500_000) + 'secret_access_key=' + 'b'.repeat(500_000))]
  for (const blob of blobs) {
    const started = Date.now()
    const hit = detectSecret(blob)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `scan must be fast, took ${elapsed}ms`)
    // 前两条无凭据赋值（纯填充）；第三条含真实复合凭据赋值，应命中且仍快速。
    if (blob.startsWith('x'.repeat(100)) || blob.startsWith('Ab3_')) assert.equal(hit, null)
    else assert.ok(hit, 'embedded compound credential still detected')
  }
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
