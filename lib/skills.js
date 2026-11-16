/**
 * dsh-memory 程序性知识层 Skills（v0.30.0 / I3）。
 *
 * 设计约束（docs/learning-design.md §4 I3）：
 * - 索引条目（记忆条目，tag `skill-index`）只保存「何时用 + skill id」；正文独立存放
 *   在 `~/.dsh/.dsh-memory/skills/<id>.md`，不写全局 skills 目录；
 * - skill 带版本 / 修订 / 来源；自动产生的 skill 先 pending，用户批准后才索引与可加载；
 * - skill 与记忆一样属于**不可信参考数据**（不是系统指令、更不是授权）；
 * - 加载工具必须校验 id 与路径，拒绝路径穿越与未批准内容；
 * - 归档/恢复/备份/快照/回滚复用既有基础能力。
 *
 * 本模块只做文件存储与状态机，不 import learning（避免循环依赖）；审计由服务层写入。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from './lock.js'
import { atomicWrite, readJsonText } from './store.js'

export const SKILLS_DIR = 'skills'
export const SKILL_REVISIONS_DIR = '.revisions'
export const SKILL_STATUSES = Object.freeze(['pending', 'approved', 'archived'])
export const SKILL_ID_PATTERN = /^sk-[a-z0-9]{4,32}$/
export const SKILL_NAME_MAX = 80
export const SKILL_TRIGGER_MAX = 300
export const SKILL_BODY_MAX = 32 * 1024
export const SKILL_VERSION_MAX = 1000
const SKILL_LOCK = '.lock-skills'

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

function skillsRoot(root) {
  return path.join(root, SKILLS_DIR)
}

/** 校验 id 且解析到 skills/ 之内的路径（拒绝 ../、绝对路径、符号化路径穿越）。 */
export function skillFile(root, id) {
  if (!SKILL_ID_PATTERN.test(String(id ?? ''))) throw coded('invalid', `非法 skill id / invalid skill id: ${id}`)
  const base = path.resolve(skillsRoot(root))
  const file = path.resolve(base, `${id}.md`)
  if (file !== path.join(base, `${id}.md`)) throw coded('invalid', 'skill 路径越界 / skill path escapes the skills directory')
  return file
}

export function revisionFile(root, id, version) {
  if (!SKILL_ID_PATTERN.test(String(id ?? ''))) throw coded('invalid', `非法 skill id / invalid skill id: ${id}`)
  const v = Number(version)
  if (!Number.isInteger(v) || v < 1 || v > SKILL_VERSION_MAX) throw coded('invalid', `非法 skill 版本 / invalid skill version: ${version}`)
  const base = path.resolve(skillsRoot(root), SKILL_REVISIONS_DIR)
  const file = path.resolve(base, String(id), `${v}.md`)
  const expected = path.join(base, String(id), `${v}.md`)
  if (file !== expected) throw coded('invalid', 'skill 修订路径越界 / skill revision path escapes its directory')
  return file
}

function oneLine(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max)
}

export function serializeSkill(skill) {
  const lines = [
    '---',
    `id: ${oneLine(skill.id, 40)}`,
    `name: ${oneLine(skill.name, SKILL_NAME_MAX)}`,
    `trigger: ${oneLine(skill.trigger, SKILL_TRIGGER_MAX)}`,
    `version: ${Number(skill.version)}`,
    `revision: ${Number(skill.revision)}`,
    `status: ${oneLine(skill.status, 20)}`,
  ]
  // 归档前状态（H5）：仅在归档态携带，恢复时据此还原；普通 skill 序列化逐字节不变。
  if (skill.status === 'archived' && SKILL_STATUSES.includes(skill.archivedFrom)) {
    lines.push(`archivedFrom: ${skill.archivedFrom}`)
  }
  lines.push(
    `source: ${oneLine(skill.source, 200)}`,
    `created: ${oneLine(skill.created, 40)}`,
    `updated: ${oneLine(skill.updated, 40)}`,
    '---',
    '',
    String(skill.body ?? '').trim(),
    '',
  )
  return lines.join('\n')
}

export function parseSkill(text, { fallbackId } = {}) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) return null
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 5).trim()
  const fields = {}
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const id = SKILL_ID_PATTERN.test(String(fallbackId ?? '')) ? fallbackId : fields.id
  if (!id || !SKILL_ID_PATTERN.test(id) || body === '') return null
  if (!SKILL_STATUSES.includes(fields.status)) return null
  const version = Number(fields.version)
  const revision = Number(fields.revision)
  if (!Number.isInteger(version) || version < 1 || version > SKILL_VERSION_MAX) return null
  if (!Number.isInteger(revision) || revision < 1 || revision > SKILL_VERSION_MAX) return null
  return {
    id,
    name: oneLine(fields.name, SKILL_NAME_MAX),
    trigger: oneLine(fields.trigger, SKILL_TRIGGER_MAX),
    version,
    revision,
    status: fields.status,
    source: fields.source ?? '',
    created: fields.created ?? '',
    updated: fields.updated ?? '',
    // 归档前状态（H5）：仅合法值才保留，缺失/非法回落由 restoreSkill 兜底为 approved。
    ...(SKILL_STATUSES.includes(fields.archivedFrom) ? { archivedFrom: fields.archivedFrom } : {}),
    body,
  }
}

function readSkillFile(file, id) {
  try {
    return parseSkill(fs.readFileSync(file, 'utf8'), { fallbackId: id })
  } catch {
    return null
  }
}

export function readSkill(root, id) {
  const skill = readSkillFile(skillFile(root, id), id)
  return skill
}

export function listSkills(root, { status } = {}) {
  let names = []
  try {
    names = fs.readdirSync(skillsRoot(root)).filter((name) => name.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const id = name.slice(0, -3)
    if (!SKILL_ID_PATTERN.test(id)) continue
    const skill = readSkill(root, id)
    if (!skill) continue
    if (status && skill.status !== status) continue
    out.push(skill)
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || String(a.id).localeCompare(String(b.id)))
  return out
}

export function listSkillRevisions(root, id) {
  // 先校验 id（路径安全），再列目录。
  skillFile(root, id)
  let names = []
  try {
    names = fs.readdirSync(path.dirname(revisionFile(root, id, 1))).filter((name) => /^\d+\.md$/.test(name))
  } catch {
    return []
  }
  return names.map((name) => Number(name.slice(0, -3))).sort((a, b) => a - b)
}

/** 首个 pending 版本写入时创建 revisions/ 目录并保存当前内容（供回滚）。 */
function saveRevision(root, skill) {
  try {
    atomicWrite(revisionFile(root, skill.id, skill.version), serializeSkill(skill))
  } catch { /* 修订快照失败不回滚主写入（fixture 下可用回滚前会再次校验） */ }
}

function withSkillsLock(root, fn) {
  return withLock(path.join(root, SKILL_LOCK), fn, { timeoutMs: 1500 })
}

export function newSkillId() {
  return `sk-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

function normalizeInput({ name, trigger, body }) {
  const cleanName = oneLine(name, SKILL_NAME_MAX)
  const cleanTrigger = oneLine(trigger, SKILL_TRIGGER_MAX)
  const cleanBody = String(body ?? '').trim()
  if (cleanName === '') throw coded('invalid', 'skill 名称不能为空 / skill name must not be empty')
  if (cleanTrigger === '') throw coded('invalid', 'skill 触发条件不能为空 / skill trigger must not be empty')
  if (cleanBody === '') throw coded('invalid', 'skill 正文不能为空 / skill body must not be empty')
  if (Buffer.byteLength(cleanBody, 'utf8') > SKILL_BODY_MAX) throw coded('invalid', `skill 正文超过 ${SKILL_BODY_MAX} 字节 / skill body too large`)
  return { name: cleanName, trigger: cleanTrigger, body: cleanBody }
}

/** 创建 pending skill（自动学习路径；批准前不可加载/不进索引）。 */
export function createPendingSkill(root, { name, trigger, body, source = '', now = Date.now() } = {}) {
  const input = normalizeInput({ name, trigger, body })
  return withSkillsLock(root, () => {
    fs.mkdirSync(skillsRoot(root), { recursive: true })
    let id = newSkillId()
    while (fs.existsSync(skillFile(root, id))) id = newSkillId()
    const stamp = new Date(Number(now)).toISOString()
    const skill = { id, ...input, version: 1, revision: 1, status: 'pending', source: String(source ?? ''), created: stamp, updated: stamp }
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    saveRevision(root, skill)
    return skill
  })
}

/** 创建 approved skill（面板用户显式创建路径）。 */
export function createApprovedSkill(root, { name, trigger, body, source = '', now = Date.now() } = {}) {
  const input = normalizeInput({ name, trigger, body })
  return withSkillsLock(root, () => {
    fs.mkdirSync(skillsRoot(root), { recursive: true })
    let id = newSkillId()
    while (fs.existsSync(skillFile(root, id))) id = newSkillId()
    const stamp = new Date(Number(now)).toISOString()
    const skill = { id, ...input, version: 1, revision: 1, status: 'approved', source: String(source ?? ''), created: stamp, updated: stamp }
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    saveRevision(root, skill)
    return skill
  })
}

/** 在已有 skill 上创建新修订（pending，需重新批准；旧修订保留在 revisions/）。 */
export function reviseSkill(root, id, { name, trigger, body, source, now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    const input = normalizeInput({
      name: name === undefined ? current.name : name,
      trigger: trigger === undefined ? current.trigger : trigger,
      body: body === undefined ? current.body : body,
    })
    const version = current.version + 1
    if (version > SKILL_VERSION_MAX) throw coded('invalid', 'skill 版本已达上限 / skill version limit reached')
    const stamp = new Date(Number(now)).toISOString()
    const skill = { ...current, ...input, version, revision: version, status: 'pending', source: source === undefined ? current.source : String(source), updated: stamp }
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    saveRevision(root, skill)
    return { skill, previous: current }
  })
}

/** 批准 pending skill；返回 {skill, previousStatus}。 */
export function approveSkill(root, id, { now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    if (current.status !== 'pending') throw coded('invalid', `skill 当前状态不是 pending / skill is not pending: ${current.status}`)
    const skill = { ...current, status: 'approved', updated: new Date(Number(now)).toISOString() }
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    saveRevision(root, skill)
    return { skill, previous: current }
  })
}

/**
 * 拒绝 pending skill：
 * - 首个版本（version=1）：删除 pending 文件与修订快照；
 * - 新修订（version>1）：恢复上一版已批准内容并回到 approved（不产生新版本号）。
 */
export function rejectSkill(root, id, { now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    if (current.status !== 'pending') throw coded('invalid', `skill 当前状态不是 pending / skill is not pending: ${current.status}`)
    if (current.version <= 1) {
      fs.rmSync(skillFile(root, id), { force: true })
      try { fs.rmSync(path.dirname(revisionFile(root, id, 1)), { recursive: true, force: true }) } catch { /* ignore */ }
      return { skill: current, removed: true, restored: null }
    }
    const previousVersion = current.version - 1
    const previousFile = revisionFile(root, id, previousVersion)
    const previous = readSkillFile(previousFile, id)
    if (!previous) throw coded('invalid', '缺少可回滚的上一版 skill / previous skill revision is missing')
    const restored = {
      ...previous,
      id,
      version: previousVersion,
      revision: previousVersion,
      status: 'approved',
      updated: new Date(Number(now)).toISOString(),
    }
    atomicWrite(skillFile(root, id), serializeSkill(restored))
    fs.rmSync(revisionFile(root, id, current.version), { force: true })
    return { skill: restored, removed: false, restored: current }
  })
}

/** 回滚到指定已保存修订：恢复内容并生成 +1 版本（索引随后同步）。 */
export function rollbackSkill(root, id, revision, { now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    if (current.status !== 'approved') throw coded('invalid', '只能回滚已批准的 skill / only approved skills can be rolled back')
    const target = Number(revision)
    if (!Number.isInteger(target) || target < 1) throw coded('invalid', `非法修订号 / invalid revision: ${revision}`)
    const targetFile = revisionFile(root, id, target)
    const from = readSkillFile(targetFile, id)
    if (!from) throw coded('not-found', `未找到 skill 修订 / skill revision not found: ${id}@${target}`)
    const version = current.version + 1
    if (version > SKILL_VERSION_MAX) throw coded('invalid', 'skill 版本已达上限 / skill version limit reached')
    const stamp = new Date(Number(now)).toISOString()
    const skill = {
      ...from,
      id,
      version,
      revision: version,
      status: 'approved',
      source: current.source,
      created: current.created,
      updated: stamp,
    }
    if (version === 1) skill.revision = 1
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    saveRevision(root, skill)
    return { skill, from: { version: current.version, revision: current.revision }, rollbackTo: target }
  })
}

export function archiveSkill(root, id, { now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    // 记录归档前状态（H5）：恢复时还原，pending 不会经 archive→restore 绕过审批。
    const archivedFrom = current.status === 'archived' ? current.archivedFrom : current.status
    const skill = { ...current, status: 'archived', archivedFrom, updated: new Date(Number(now)).toISOString() }
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    return { skill, previous: current }
  })
}

export function restoreSkill(root, id, { now = Date.now() } = {}) {
  return withSkillsLock(root, () => {
    const current = readSkill(root, id)
    if (!current) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
    if (current.status !== 'archived') throw coded('invalid', '只能恢复已归档的 skill / skill is not archived')
    // 还原归档前状态；旧文件无 archivedFrom 时回落 approved（向后兼容）。
    const restoreTo = SKILL_STATUSES.includes(current.archivedFrom) && current.archivedFrom !== 'archived' ? current.archivedFrom : 'approved'
    const skill = { ...current, status: restoreTo, updated: new Date(Number(now)).toISOString() }
    delete skill.archivedFrom
    atomicWrite(skillFile(root, id), serializeSkill(skill))
    return { skill, previous: current }
  })
}

/** 加载用：仅 approved 且正文完整；返回不可信参考数据提示所需字段。 */
export function loadApprovedSkill(root, id) {
  const skill = readSkill(root, id)
  if (!skill) throw coded('not-found', `未找到 skill / skill not found: ${id}`)
  if (skill.status !== 'approved') throw coded('not-approved', `skill 未批准，禁止加载 / skill is not approved: ${skill.status}`)
  return skill
}

/** 备份/快照用：技能正文（不含派生索引条目）。 */
export function exportSkills(root) {
  return listSkills(root).map((skill) => ({
    id: skill.id,
    name: skill.name,
    trigger: skill.trigger,
    version: skill.version,
    revision: skill.revision,
    status: skill.status,
    source: skill.source,
    created: skill.created,
    updated: skill.updated,
    body: skill.body,
  }))
}

/** 迁移/初始化：确保 skills/ 目录存在（v3 库可无技能）。 */
export function ensureSkills(root) {
  try { fs.mkdirSync(skillsRoot(root), { recursive: true }) } catch { /* best-effort */ }
}

// readJsonText 保留导入以便外部诊断技能状态（当前版本未使用 JSON 元数据）。
export const __internal = { readJsonText }
