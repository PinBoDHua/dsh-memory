/**
 * 第七轮审计 H3/H15：条目级读-改-写跨进程互斥（.lock-write）。
 * 此前 save/update/move/forget 无锁：跨进程可双后继取代同一目标、并发更新丢字段、
 * forget 被陈旧读复活；备份文件名分配在锁外可互相覆盖。
 * 运行 Run: node --test tests/concurrency-write.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as store from '../lib/store.js'
import { createMemoryService } from '../lib/service.js'

const WORKER = fileURLToPath(new URL('./fixtures/write-worker.mjs', import.meta.url))

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-cw-'))
}

/** 并发启动多个工作进程（spawnSync 串行无法制造竞态），等全部退出并解析 JSON 结果。 */
function runWorkersParallel(root, jobs) {
  return Promise.all(jobs.map(([mode, ...args]) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, root, mode, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker exit ${code}: ${stderr}`))
      else {
        try { resolve(JSON.parse(stdout)) } catch (err) { reject(new Error(`worker bad output: ${stdout} (${err.message})`)) }
      }
    })
  })))
}

test('H3: concurrent supersede of one target yields exactly one successor', async () => {
  const root = tmpRoot()
  const { entry: target } = store.saveEntry(root, { content: '被取代目标', scope: 'global' })
  const [a, b] = await runWorkersParallel(root, [
    ['supersede', target.id, '竞争者甲'],
    ['supersede', target.id, '竞争者乙'],
  ])
  const winners = [a, b].filter((r) => r.ok)
  assert.equal(winners.length, 1, `exactly one supersede must succeed: ${JSON.stringify([a, b])}`)
  const fresh = store.findEntry(root, target.id)
  assert.equal(fresh.superseded_by, winners[0].id, 'target successor must be the sole winner')
  // 失败方不得留下声称取代的条目（resolveSupersedeTarget 在写盘前拒绝）。
  const all = store.listScope(root, 'global')
  assert.ok(!all.some((e) => e.supersedes === target.id && e.id !== winners[0].id), 'loser must not persist a supersede claim')
  fs.rmSync(root, { recursive: true, force: true })
})

test('H3: concurrent updates to different fields lose neither', async () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '原始内容', scope: 'global' })
  const [a, b] = await runWorkersParallel(root, [
    ['update', entry.id, JSON.stringify({ content: '更新内容' })],
    ['update', entry.id, JSON.stringify({ tags: ['并发标签'] })],
  ])
  assert.ok(a.ok && b.ok, `both updates must succeed: ${JSON.stringify([a, b])}`)
  const fresh = store.findEntry(root, entry.id)
  assert.equal(fresh.content, '更新内容', 'content update must survive')
  assert.deepEqual(fresh.tags, ['并发标签'], 'tags update must survive (no lost update)')
  fs.rmSync(root, { recursive: true, force: true })
})

test('H3: forget cannot be resurrected by a concurrent stale update', async () => {
  const root = tmpRoot()
  const { entry } = store.saveEntry(root, { content: '将被删除', scope: 'global' })
  const [f, u] = await runWorkersParallel(root, [
    ['forget', entry.id],
    ['update', entry.id, JSON.stringify({ content: '复活尝试' })],
  ])
  assert.ok(f.ok, `forget must succeed: ${JSON.stringify(f)}`)
  if (f.deleted) {
    assert.ok(!store.findEntry(root, entry.id), 'a reported-deleted entry must not reappear')
  }
  // update 先落盘时 forget 仍删除成功；forget 先落盘时 update 报 not-found——两种交错都合法。
  assert.ok(u.ok || u.error === 'not-found' || /not found/.test(String(u.error)), JSON.stringify(u))
  fs.rmSync(root, { recursive: true, force: true })
})

test('H15: concurrent backups never overwrite each other', async () => {
  const root = tmpRoot()
  const service = createMemoryService({ root })
  service.save({ content: '备份并发测试', scope: 'global' })
  service.updateSettings({ backupRetention: 30 })
  const [a, b] = await runWorkersParallel(root, [['backup', '5'], ['backup', '5']])
  assert.ok(a.ok && b.ok, `both backup workers must succeed: ${JSON.stringify([a, b])}`)
  const files = fs.readdirSync(path.join(root, 'backups')).filter((n) => /^dsh-memory-.*\.json$/.test(n))
  assert.equal(files.length, 10, '10 concurrent backups must produce 10 distinct files')
  for (const n of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'backups', n), 'utf8'))
    assert.equal(doc.format, 'dsh-memory-export')
  }
  fs.rmSync(root, { recursive: true, force: true })
})