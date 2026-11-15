/**
 * dsh-memory v0.30.0 程序性知识（skill 载体）单测：
 * pending/批准的加载边界、路径穿越拒绝、索引条目同步、修订/回滚版本一致性、
 * 信号闸门（skill 候选同样需要 signal_id）、备份/快照口径与 HTTP 契约。
 * 运行 Run: node --test tests/skills.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotDataRoot, diffSnapshots } from '../scripts/data-snapshot.mjs'
import * as learning from '../lib/learning.js'
import { createHandlers } from '../lib/routes.js'
import { createMemoryService } from '../lib/service.js'
import * as skills from '../lib/skills.js'
import * as store from '../lib/store.js'

const TOKEN = 't-0123456789abcdef'
const SID = 'session-skill'

function tmpService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-skills-'))
  return { root, service: createMemoryService({ root }) }
}

function reqBody(body) {
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:50562', 'x-rpc-key': TOKEN },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

function getReq(url = '/plugins/dsh-memory/skills') {
  return { method: 'GET', url, headers: { host: '127.0.0.1:50562' }, socket: { remoteAddress: '127.0.0.1' } }
}

async function call(handler, req) {
  const res = { statusCode: null, body: '' }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (payload) => { res.body = payload ?? '' }
  res.json = () => JSON.parse(res.body)
  await handler(req, res)
  return res
}

const signal = (id) => ({ id, type: 'correction', at: Date.now() })

test('skills storage: pending is not loadable, approved is; ids and paths are validated', () => {
  const { root } = tmpService()
  const pending = skills.createPendingSkill(root, { name: '发布流程', trigger: '当要发布版本时', body: '1. 建 tag\n2. 推送', source: 's1' })
  assert.equal(pending.status, 'pending')
  assert.equal(skills.listSkills(root, { status: 'pending' }).length, 1)
  assert.throws(() => skills.loadApprovedSkill(root, pending.id), (err) => err.code === 'not-approved')
  const approved = skills.createApprovedSkill(root, { name: '提交规范', trigger: '当写提交信息时', body: '使用中文' })
  assert.equal(skills.loadApprovedSkill(root, approved.id).body, '使用中文')
  // 路径穿越 / 非法 id 一律拒绝（不读盘）。
  for (const bad of ['../etc/passwd', 'sk-../../x', 'm-not-a-skill', 'sk-OK']) {
    assert.throws(() => skills.readSkill(root, bad), (err) => err.code === 'invalid')
  }
  assert.throws(() => skills.loadApprovedSkill(root, 'sk-../../etc'), (err) => err.code === 'invalid')
  assert.ok(!fs.existsSync(path.join(root, 'skills', '..', 'etc')))
})

test('approve creates the deterministic skill-index memory entry; revise archives it until re-approved', () => {
  const { root, service } = tmpService()
  const pending = skills.createPendingSkill(root, { name: '构建', trigger: '当构建前端时', body: 'pnpm build' })
  const approved = service.approveSkill({ skillId: pending.id })
  assert.equal(approved.status, 'approved')
  const index = store.findEntry(root, `m-skill-${pending.id}`, undefined)
  assert.ok(index, 'index entry created')
  assert.deepEqual(index.tags.sort(), ['skill-index', pending.id].sort())
  assert.ok(index.content.includes('当构建前端时') && index.content.includes(`skill: ${pending.id}`) && index.content.includes('v1'))
  const loaded = service.loadSkill({ id: pending.id })
  assert.equal(loaded.content, 'pnpm build')
  // 修订（经服务层信号闸门）→ pending：索引暂归档、旧版本仍不可加载（重新批准后才生效）。
  const revised = service.reviseSkillWithSignal({
    sessionId: SID,
    signalId: 'sig-revise',
    detectedSignals: [signal('sig-revise')],
    skillId: pending.id,
    body: 'pnpm build --mode production',
  })
  assert.equal(revised.version, 2)
  assert.equal(revised.status, 'pending')
  assert.throws(() => service.loadSkill({ id: pending.id }), (err) => err.code === 'not-approved')
  const afterRevise = store.findEntry(root, `m-skill-${pending.id}`, undefined)
  assert.equal(afterRevise?.archived, true, 'index entry archived while revision pending')
  service.approveSkill({ skillId: pending.id })
  const reindexed = store.findEntry(root, `m-skill-${pending.id}`, undefined)
  assert.ok(reindexed.content.includes('v2'), 'index entry reflects the new version')
  assert.equal(service.loadSkill({ id: pending.id }).content, 'pnpm build --mode production')
})

test('rollback restores an earlier revision, bumps the version, and keeps index/body versions consistent', () => {
  const { root, service } = tmpService()
  const created = skills.createApprovedSkill(root, { name: '部署', trigger: '当部署时', body: '旧流程' })
  const v2 = skills.reviseSkill(root, created.id, { body: '新流程' }).skill
  service.approveSkill({ skillId: created.id })
  const before = service.loadSkill({ id: created.id })
  assert.equal(before.version, v2.version)
  const rolled = service.rollbackSkill({ skillId: created.id, revision: 1 })
  const after = service.loadSkill({ id: created.id })
  assert.equal(after.content, '旧流程', 'body restored from revision 1')
  assert.equal(after.version, before.version + 1)
  const index = store.findEntry(root, `m-skill-${created.id}`, undefined)
  assert.ok(index.content.includes(`v${after.version}`), 'index version matches the body version')
  const revisions = skills.listSkillRevisions(root, created.id)
  assert.ok(revisions.includes(1) && revisions.includes(rolled.skill.version))
  const audit = learning.auditTail(root).map((e) => e.type)
  assert.ok(audit.includes('skill_rolled_back') && audit.includes('skill_approved'))
})

test('rejecting a pending revision restores the previous approved version and its index', () => {
  const { root, service } = tmpService()
  const created = skills.createApprovedSkill(root, { name: '日志', trigger: '当排查日志时', body: '用 grep' })
  const revised = skills.reviseSkill(root, created.id, { body: '用 rg' }).skill
  assert.equal(revised.status, 'pending')
  const result = service.rejectSkill({ skillId: created.id })
  assert.equal(result.removed, false)
  const current = skills.readSkill(root, created.id)
  assert.equal(current.status, 'approved')
  assert.equal(current.body, '用 grep')
  assert.equal(service.loadSkill({ id: created.id }).content, '用 grep')
  const index = store.findEntry(root, `m-skill-${created.id}`, undefined)
  assert.ok(index && index.archived !== true, 'index is restored to the approved previous version')
  assert.ok(index.content.includes('v1'), 'restored index points at the approved previous version')
})

test('signal gate: skill candidates require a live signal and consume one session quota', () => {
  const { root, service } = tmpService()
  assert.throws(() => service.saveSkillWithSignal({
    sessionId: SID, signalId: 'nope', detectedSignals: [], name: 'x', trigger: 'y', body: 'z',
  }), (err) => err.code === 'no-signal')
  assert.equal(skills.listSkills(root).length, 0, 'failed candidate leaves no pending skill file')
  const saved = service.saveSkillWithSignal({
    sessionId: SID,
    signalId: 'sig-skill',
    detectedSignals: [signal('sig-skill')],
    name: '回滚',
    trigger: '当需要回滚时',
    body: '先备份再回滚',
  })
  assert.equal(saved.status, 'pending')
  assert.equal(learning.readQuota({ root, sessionId: SID, limit: 5 }).used, 1)
  assert.equal(store.findEntry(root, `m-skill-${saved.id}`, undefined), undefined, 'pending skill is not indexed')
  assert.throws(() => service.saveSkillWithSignal({
    sessionId: SID, signalId: 'sig-skill', detectedSignals: [signal('sig-skill')], name: '重复', trigger: 't', body: 'b',
  }), (err) => err.code === 'signal-consumed')
})

test('secret/short-term skill bodies are refused before a pending file is written', () => {
  const { root, service } = tmpService()
  assert.throws(() => service.saveSkillWithSignal({
    sessionId: SID, signalId: 'sig-secret', detectedSignals: [signal('sig-secret')], name: 'x', trigger: 'y', body: 'api_key: abcd1234efgh',
  }), (err) => err.code === 'secret' || err.code === 'rejected-risk')
  assert.throws(() => service.saveSkillWithSignal({
    sessionId: SID, signalId: 'sig-short', detectedSignals: [signal('sig-short')], name: 'x', trigger: '今天先这样', body: '明天再改',
  }), (err) => err.code === 'rejected-risk')
  assert.equal(skills.listSkills(root).length, 0)
})

test('snapshot + backup include skills; learning view exposes pending skills', () => {
  const { root, service } = tmpService()
  const before = snapshotDataRoot(root)
  const pending = skills.createPendingSkill(root, { name: '快照技能', trigger: '当快照时', body: 'body' })
  const after = snapshotDataRoot(root)
  const changes = diffSnapshots(before, after)
  assert.ok(changes.some((line) => /新增 skills\//.test(line)), JSON.stringify(changes))
  const view = service.learningView({})
  assert.equal(view.pendingSkillCount, 1)
  assert.equal(view.pendingSkills[0].id, pending.id)
  const doc = service.export()
  assert.ok(Array.isArray(doc.skills) && doc.skills.some((skill) => skill.id === pending.id && skill.body === 'body'))
  const backup = service.backup()
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'backups', backup.file), 'utf8'))
  assert.ok(saved.skills.some((skill) => skill.id === pending.id))
})

test('HTTP routes: skills list/approve/reject/rollback and unknown-skill error mapping', async () => {
  const { root, service } = tmpService()
  const handlers = createHandlers({ service, token: TOKEN, version: '0.30.0-test' })
  const list = await call(handlers.skills, getReq())
  assert.equal(list.statusCode, 200)
  assert.deepEqual(list.json().skills, [])
  const pending = skills.createPendingSkill(root, { name: '路由技能', trigger: '当测试路由时', body: 'steps' })
  const approve = await call(handlers['skills/approve'], reqBody({ skillId: pending.id }))
  assert.equal(approve.statusCode, 200)
  assert.equal(approve.json().result.status, 'approved')
  const unknown = await call(handlers['skills/rollback'], reqBody({ skillId: 'sk-nope0000', revision: 1 }))
  assert.equal(unknown.statusCode, 404)
  const approveAgain = await call(handlers['skills/approve'], reqBody({ skillId: pending.id }))
  assert.equal(approveAgain.statusCode, 400)
  const archived = await call(handlers['skills/archive'], reqBody({ skillId: pending.id }))
  assert.equal(archived.statusCode, 200)
  const denied = await call(handlers['skills/reject'], { method: 'POST', headers: { host: '127.0.0.1:50562' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } })
  assert.equal(denied.statusCode, 403)
})
