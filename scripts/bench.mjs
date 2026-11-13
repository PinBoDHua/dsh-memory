#!/usr/bin/env node
/**
 * 大库性能基准：生成合成数据根（global + 一个工作区），测冷/热读取与常见操作。
 * 用法 Run:
 *   node scripts/bench.mjs --entries=30000 [--dir=C:\Temp\dsh-memory-bench-30k] [--keep]
 * 输出 JSON 便于对比迭代；默认复用已存在的数据根（--regen 强制重建）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMemoryService } from '../lib/service.js'
import { serializeEntry, workspaceKey, listAll } from '../lib/store.js'

const argv = new Map(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=')
  return i === -1 ? [a.replace(/^--/, ''), 'true'] : [a.slice(2, i), a.slice(i + 1)]
}))
const TOTAL = Math.max(100, Number(argv.get('entries') || 30000))
const CWD = 'D:\\proj\\alpha'
const ROOT = argv.get('dir') || path.join(os.tmpdir(), `dsh-memory-bench-${TOTAL}`)
const REGEN = argv.has('regen') || argv.has('keep') === false

function nowMs() { return Number(process.hrtime.bigint() / 1_000_000n) }

function build() {
  fs.rmSync(ROOT, { recursive: true, force: true })
  const globalDir = path.join(ROOT, 'global')
  const key = workspaceKey(CWD)
  const wsDir = path.join(ROOT, 'workspaces', key)
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(wsDir, { recursive: true })
  const globalCount = Math.min(2000, Math.round(TOTAL * 0.07))
  const stamp = new Date().toISOString()
  let t = nowMs()
  for (let i = 0; i < TOTAL; i += 1) {
    const global = i < globalCount
    const entry = {
      id: `m-bench-${String(i).padStart(6, '0')}`,
      category: ['fact', 'preference', 'decision'][i % 3],
      scope: global ? 'global' : 'workspace',
      tags: i % 5 === 0 ? ['bench', `t${i % 7}`] : [],
      created: stamp,
      updated: `${stamp.slice(0, -2)}${String(i % 100).padStart(2, '0')}Z`,
      source: 'bench',
      content: `基准条目 ${i}：性能测试内容 payload=${'x'.repeat(120)}`,
    }
    const dir = global ? globalDir : wsDir
    fs.writeFileSync(path.join(dir, `${entry.id}.md`), serializeEntry(entry), 'utf8')
  }
  return { buildMs: nowMs() - t, globalCount, workspaceCount: TOTAL - globalCount }
}

const service = createMemoryService({ root: ROOT })
const rebuild = REGEN || !fs.existsSync(path.join(ROOT, 'global'))
const buildInfo = rebuild ? build() : { buildMs: 0, reused: true }
const results = { entries: TOTAL, root: ROOT, build: buildInfo }

let t = nowMs()
const cold = listAll(ROOT, CWD)
results.coldListMs = nowMs() - t
results.coldEntries = cold.length

const warm = []
for (let i = 0; i < 5; i += 1) {
  t = nowMs()
  const list = listAll(ROOT, CWD)
  warm.push(nowMs() - t)
  if (i === 0) results.warmEntries = list.length
}
results.warmListMs = warm
t = nowMs()
service.status()
results.statusMs = nowMs() - t
t = nowMs()
service.export({ scope: 'all' })
results.exportMs = nowMs() - t
t = nowMs()
service.recallPreview({ workspace: CWD })
results.recallPreviewMs = nowMs() - t
t = nowMs()
service.search({ query: '基准条目 99999', scope: 'all', workspace: CWD })
results.searchMs = nowMs() - t
const target = cold.find((e) => e.scope === 'workspace')
if (target) {
  t = nowMs()
  service.forget({ id: target.id })
  results.forgetOneMs = nowMs() - t
}
console.log(JSON.stringify(results, null, 2))