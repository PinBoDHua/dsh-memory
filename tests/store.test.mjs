/**
 * dsh-memory 纯逻辑单测：store / guard / render。
 * 运行 Run: node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import { detectSecret } from '../lib/guard.js'
import { GUIDANCE, renderSection } from '../lib/render.js'

const CWD_A = 'D:\\proj\\alpha'
const CWD_B = 'D:\\proj\\beta'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'))
}

test('save + find roundtrip, file layout and frontmatter', () => {
  const root = tmpRoot()
  const { entry, deduplicated } = store.saveEntry(root, {
    content: '用户偏好中文回复',
    category: 'preference',
    scope: 'global',
    tags: ['语言', '中文'],
    source: 'session-1',
  })
  assert.equal(deduplicated, false)
  assert.match(entry.id, /^m-[a-z0-9]+-[a-f0-9]{6}$/)
  const file = path.join(root, 'global', `${entry.id}.md`)
  assert.ok(fs.existsSync(file))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.startsWith('---\n'))
  assert.ok(text.includes('category: preference'))
  const found = store.findEntry(root, entry.id, undefined)
  assert.equal(found.content, '用户偏好中文回复')
  assert.deepEqual(found.tags, ['语言', '中文'])
  assert.equal(found.source, 'session-1')
})

test('dedupe: same content ignoring whitespace/case in same scope', () => {
  const root = tmpRoot()
  const first = store.saveEntry(root, { content: 'Project uses pnpm', scope: 'workspace', cwd: CWD_A })
  const second = store.saveEntry(root, { content: '  project   USES   pnpm  ', scope: 'workspace', cwd: CWD_A })
  assert.equal(second.deduplicated, true)
  assert.equal(second.entry.id, first.entry.id)
  assert.equal(store.listScope(root, 'workspace', CWD_A).length, 1)
})

test('workspace isolation and global visibility', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: 'alpha 的秘密约定', scope: 'workspace', cwd: CWD_A })
  store.saveEntry(root, { content: '全局偏好', scope: 'global' })
  assert.equal(store.searchEntries(root, { query: 'alpha', cwd: CWD_B }).length, 0)
  assert.equal(store.searchEntries(root, { query: 'alpha', cwd: CWD_A }).length, 1)
  assert.equal(store.searchEntries(root, { query: '全局', cwd: CWD_B }).length, 1)
  assert.equal(store.listAll(root, CWD_A).length, 2)
  assert.equal(store.listAll(root, CWD_B).length, 1)
})

test('update supersedes in place', async () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '旧事实', scope: 'workspace', cwd: CWD_A })
  await new Promise((r) => setTimeout(r, 5))
  const updated = store.updateEntry(root, entry.id, { content: '新事实', category: 'decision', tags: ['v2'] }, CWD_A)
  assert.equal(updated.id, entry.id)
  assert.equal(updated.content, '新事实')
  assert.equal(updated.category, 'decision')
  assert.deepEqual(updated.tags, ['v2'])
  assert.ok(updated.updated >= entry.created)
  assert.equal(store.listScope(root, 'workspace', CWD_A).length, 1)
  assert.equal(store.findEntry(root, entry.id, CWD_A).content, '新事实')
})

test('forget deletes permanently', () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '将被忘记', scope: 'global' })
  assert.equal(store.forgetEntry(root, entry.id, undefined), true)
  assert.equal(store.findEntry(root, entry.id, undefined), undefined)
  assert.equal(store.forgetEntry(root, entry.id, undefined), false)
})

test('search: AND tokens, case-insensitive, filters, limit, empty query', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '构建使用 pnpm install', scope: 'workspace', cwd: CWD_A, tags: ['build'] })
  store.saveEntry(root, { content: '测试使用 vitest', scope: 'workspace', cwd: CWD_A, category: 'decision' })
  store.saveEntry(root, { content: '用户喜欢深色主题', scope: 'global', category: 'preference' })
  assert.equal(store.searchEntries(root, { query: 'PNPM 构建', cwd: CWD_A }).length, 1)
  assert.equal(store.searchEntries(root, { query: 'pnpm vitest', cwd: CWD_A }).length, 0)
  assert.equal(store.searchEntries(root, { query: '', category: 'preference', cwd: CWD_A }).length, 1)
  assert.equal(store.searchEntries(root, { query: '', scope: 'workspace', cwd: CWD_A }).length, 2)
  assert.equal(store.searchEntries(root, { query: '', cwd: CWD_A, limit: 1 }).length, 1)
  assert.equal(store.searchEntries(root, { query: '', cwd: CWD_A }).length, 3)
  assert.equal(store.searchEntries(root, { query: 'build', cwd: CWD_A }).length, 1)
})

test('hand-edited and malformed files', () => {
  const root = tmpRoot()
  const dir = path.join(root, 'global')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm-handedit-aaaaaa.md'), [
    '---',
    'id: m-handedit-aaaaaa',
    'category: fact',
    'scope: global',
    'tags: ["手工"]',
    'created: 2026-01-01T00:00:00.000Z',
    'updated: 2026-01-02T00:00:00.000Z',
    'source: ',
    '---',
    '',
    '手工写入的记忆',
    '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'm-broken-bbbbbb.md'), '这不是 frontmatter', 'utf8')
  const entries = store.listScope(root, 'global', undefined)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, '手工写入的记忆')
  assert.deepEqual(entries[0].tags, ['手工'])
})

test('id safety: traversal rejected', () => {
  const root = tmpRoot()
  assert.equal(store.findEntry(root, '../evil', undefined), undefined)
  assert.equal(store.findEntry(root, '..\\evil', undefined), undefined)
  assert.equal(store.forgetEntry(root, '../evil', undefined), false)
})

test('workspace scope without cwd fails loudly', () => {
  const root = tmpRoot()
  assert.throws(() => store.saveEntry(root, { content: 'x', scope: 'workspace' }), /working directory/)
  assert.deepEqual(store.listScope(root, 'workspace', undefined), [])
  assert.throws(() => store.saveEntry(root, { content: '   ' }), /empty/)
  assert.throws(() => store.saveEntry(root, { content: 'x', category: 'bogus' }), /category/)
})

test('workspace index maps hash to normalized cwd', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '索引测试', scope: 'workspace', cwd: CWD_A })
  const index = JSON.parse(fs.readFileSync(path.join(root, 'workspaces', 'index.json'), 'utf8'))
  const key = store.workspaceKey(CWD_A)
  assert.equal(index[key].cwd, store.normalizeCwd(CWD_A))
  assert.ok(index[key].firstSeen)
})

test('serialize/parse roundtrip with unicode and braces', () => {
  const entry = {
    id: 'm-test-abcdef',
    category: 'decision',
    scope: 'global',
    tags: ['模板', '{{var}}'],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    source: 's',
    content: '模板里保留 {{literal}} 花括号\n第二行',
  }
  const parsed = store.parseEntry(store.serializeEntry(entry), {})
  assert.deepEqual(parsed, entry)
})

test('guard: credentials rejected', () => {
  const positives = [
    'sk-abcdefghijklmnopqrst1234',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'xoxb-123456789012-abcdef',
    '-----BEGIN RSA PRIVATE KEY-----',
    'password = hunter2secret',
    'api_key: abcd1234efgh',
    '数据库密码：supersecret123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn9.abc12',
  ]
  for (const text of positives) {
    assert.ok(detectSecret(text), `should reject: ${text}`)
  }
})

test('guard: ordinary prose passes', () => {
  const negatives = [
    '用户偏好中文回复',
    'the secret to success is consistency',
    'memory token budget is 6000 chars',
    '项目使用 pnpm 管理依赖',
    'password 字段应该放在环境变量里',
  ]
  for (const text of negatives) {
    assert.equal(detectSecret(text), null, `should pass: ${text}`)
  }
})

test('move: global -> workspace relocates the file and refreshes updated', async () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '待移动的事实', scope: 'global', tags: ['t'] })
  await new Promise((r) => setTimeout(r, 5))
  const moved = store.moveEntry(root, entry.id, 'workspace', CWD_A)
  assert.equal(moved.id, entry.id)
  assert.equal(moved.scope, 'workspace')
  assert.equal(moved.content, '待移动的事实')
  assert.deepEqual(moved.tags, ['t'])
  assert.ok(moved.updated > entry.updated)
  assert.ok(!fs.existsSync(path.join(root, 'global', `${entry.id}.md`)))
  assert.ok(fs.existsSync(path.join(root, 'workspaces', store.workspaceKey(CWD_A), `${entry.id}.md`)))
  assert.equal(store.findEntry(root, entry.id, CWD_A).scope, 'workspace')
  assert.equal(store.findEntry(root, entry.id, CWD_B), undefined)
})

test('move: workspace -> global and same-scope no-op', () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '工作区记忆', scope: 'workspace', cwd: CWD_A })
  const moved = store.moveEntry(root, entry.id, 'global', CWD_A)
  assert.equal(moved.scope, 'global')
  assert.ok(fs.existsSync(path.join(root, 'global', `${entry.id}.md`)))
  assert.equal(store.listScope(root, 'workspace', CWD_A).length, 0)
  const before = fs.readFileSync(path.join(root, 'global', `${entry.id}.md`), 'utf8')
  const noop = store.moveEntry(root, entry.id, 'global', CWD_A)
  assert.equal(noop.scope, 'global')
  assert.equal(fs.readFileSync(path.join(root, 'global', `${entry.id}.md`), 'utf8'), before)
})

test('move: duplicate content in target scope is rejected, source intact', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '共同的内容', scope: 'workspace', cwd: CWD_A })
  const { entry } = store.saveEntry(root, { content: '共同的内容', scope: 'global' })
  assert.throws(() => store.moveEntry(root, entry.id, 'workspace', CWD_A), (err) => err.code === 'duplicate')
  assert.equal(store.findEntry(root, entry.id, CWD_A).scope, 'global')
  assert.equal(store.listScope(root, 'workspace', CWD_A).length, 1)
})

test('move: applies content/category/tags patch together with the move', () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '旧内容', scope: 'global' })
  const moved = store.moveEntry(root, entry.id, 'workspace', CWD_A, { content: '新内容', category: 'decision', tags: ['v2'] })
  assert.equal(moved.content, '新内容')
  assert.equal(moved.category, 'decision')
  assert.deepEqual(moved.tags, ['v2'])
  assert.equal(moved.scope, 'workspace')
  assert.equal(store.listScope(root, 'global', undefined).length, 0)
})

test('move: unknown id throws; workspace target without cwd throws', () => {
  const root = tmpRoot()
  assert.throws(() => store.moveEntry(root, 'm-nonexistent-000000', 'global', undefined), /not found/)
  const { entry } = store.saveEntry(root, { content: 'x', scope: 'global' })
  assert.throws(() => store.moveEntry(root, entry.id, 'workspace', undefined), /working directory/)
})

test('writeEntry preserves id and timestamps (import primitive)', () => {
  const root = tmpRoot()
  const entry = {
    id: 'm-import-aaaaaa',
    category: 'preference',
    scope: 'global',
    tags: ['导入'],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    source: 'old-session',
    content: '导入的记忆',
  }
  store.writeEntry(root, entry, undefined)
  const found = store.findEntry(root, 'm-import-aaaaaa', undefined)
  assert.deepEqual(found, entry)
  assert.equal(store.hasEntry(root, 'm-import-aaaaaa', 'global', undefined), true)
  assert.equal(store.hasEntry(root, 'm-import-aaaaaa', 'workspace', CWD_A), false)
  assert.equal(store.hasEntry(root, '../evil', 'global', undefined), false)
})

test('listWorkspaceKey lists by directory key without cwd', () => {
  const root = tmpRoot()
  store.saveEntry(root, { content: '按键列出', scope: 'workspace', cwd: CWD_A })
  const key = store.workspaceKey(CWD_A)
  const entries = store.listWorkspaceKey(root, key)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, '按键列出')
  assert.deepEqual(store.listWorkspaceKey(root, 'zzzz'), [])
})

test('render: guidance, budget, grouping, empty', () => {
  assert.ok(GUIDANCE.includes('memory_save'))
  assert.ok(renderSection([], {}).includes('暂无记忆'))
  assert.equal(renderSection([{ id: 'x', scope: 'global', category: 'fact', content: 'c', updated: '' }], { autoInject: false }), GUIDANCE)
  const entries = [
    { id: 'm-1', scope: 'global', category: 'preference', content: '全局偏好甲', updated: '2026-01-03' },
    { id: 'm-2', scope: 'workspace', category: 'fact', content: '工作区事实乙', updated: '2026-01-02' },
    { id: 'm-3', scope: 'workspace', category: 'decision', content: '工作区决策丙', updated: '2026-01-01' },
  ]
  const full = renderSection(entries, { budgetChars: 6000 })
  assert.ok(full.includes('全局 Global:'))
  assert.ok(full.includes('当前工作区 Current workspace:'))
  assert.ok(full.includes('(id: m-1)'))
  assert.ok(!full.includes('未注入'))
  const tiny = renderSection(entries, { budgetChars: 30 })
  assert.ok(tiny.includes('未注入'))
  assert.ok(tiny.includes('memory_search'))
  const multiline = renderSection([{ id: 'm-x', scope: 'global', category: 'fact', content: '第一行\n第二行', updated: '' }], {})
  assert.ok(multiline.includes('第一行 第二行'))
})
