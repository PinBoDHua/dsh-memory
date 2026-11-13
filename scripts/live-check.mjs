/**
 * dsh-memory live 验证脚本 —— 对运行中的宿主回环路由做端到端检查。
 *
 * 用法 Run:
 *   node scripts/live-check.mjs --port=51953
 *   node scripts/live-check.mjs            （默认端口 51953，或 env DSH_MEMORY_PORT）
 *
 * 安全：对真实数据根运行。测试条目带唯一标记并在末尾/异常与中断时统一清理；
 * 设置与备份在启动时快照、清理时原样恢复（先 reset 再写回原 overlay，删除本次新增
 * 备份文件）；备份前临时抬高保留份数，保证轮转不会删除用户历史备份。
 * 运行前后用 scripts/data-snapshot.mjs 做数据根快照 diff 自检（应为零差异）。
 * 可用 `--fail-at=<检查名子串>` 注入失败，验证异常路径同样零残留。
 * 仅打回环地址 127.0.0.1（与任务目标一致，不使用任何代理）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLock } from '../lib/lock.js'
import { atomicWrite } from '../lib/store.js'
import { snapshotDataRoot, diffSnapshots } from './data-snapshot.mjs'

const argv = process.argv.slice(2)
const portArg = argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? argv.find((a) => /^\d+$/.test(a))
const PORT = Number(portArg ?? process.env.DSH_MEMORY_PORT ?? 51953)
const FAIL_AT = argv.find((a) => a.startsWith('--fail-at='))?.split('=').slice(1).join('=') || ''
const BASE = `http://127.0.0.1:${PORT}`
const API = `${BASE}/plugins/dsh-memory`
const RUN = `__livecheck_${Date.now().toString(36)}__`
const CLIENT_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))
// 版本断言读 package.json（升版本无需手改脚本）。
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const EXPECTED_VERSION = String(PKG.version)

let pass = 0
let fail = 0
let emergencyCleanup = null
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function check(name, fn) {
  try { await fn() } catch (err) { ok(name, false, err?.message ?? String(err)) }
  // 失败注入：在指定检查完成后抛错，用于验证「异常中断也不会污染真实数据」。
  if (FAIL_AT && name.includes(FAIL_AT)) throw new Error(`fail-at 注入：${name}`)
}

async function req(method, path, { body, token, base = API } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-RPC-Key'] = token
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

// 原样发送 body（用于验证非对象 JSON / 坏 JSON 的路由错误映射）。
async function reqRaw(method, path, { raw, token, base = API } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-RPC-Key'] = token
  const res = await fetch(`${base}${path}`, { method, headers, body: raw })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

// rev 配方（与宿主 dsh-client-modules artifactRevision 一致）：
// sha1(domain + \0 + 各段「字节长度:内容」) 取前 12 位；输入 mtimeMs/ctimeMs/size。
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}
function clientRev() {
  const st = statSync(CLIENT_PATH)
  return framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
}

const created = []
let statusRoot = ''

async function main() {
  console.log(`dsh-memory live-check @ ${BASE}\n`)

  // 1. status：版本与 schema
  let token = ''
  await check(`status 报告 version=${EXPECTED_VERSION} / schemaVersion=2 并下发 token`, async () => {
    const { status, json } = await req('GET', '/status')
    ok('status HTTP 200', status === 200, `got ${status}`)
    ok('status.ok', json?.ok === true)
    ok(`version === ${EXPECTED_VERSION}`, json?.version === EXPECTED_VERSION, `got ${json?.version}`)
    ok('schemaVersion === 2', json?.schemaVersion === 2, `got ${json?.schemaVersion}`)
    ok('token 非空', typeof json?.key === 'string' && json.key.length > 0)
    // 0.24.18：迁移/备份失败可观测字段（健康时应为 false/null）。
    ok('migrationPending=false', json?.migrationPending === false, `got ${JSON.stringify(json?.migrationPending)}`)
    ok('backupError=null', json?.backupError === null, `got ${JSON.stringify(json?.backupError)}`)
    token = json?.key ?? ''
    statusRoot = json?.root ?? ''
  })
  if (!token) { console.log('\n无法取得 token，终止。'); finish(); return }

  // ===== 真实数据根快照 + 幂等清理（正常结束/异常/中断都要恢复） =====
  let settingsSnapshot = null
  let backupsSnapshot = []
  let cleaned = false
  const listBackups = () => {
    try {
      return readdirSync(path.join(statusRoot, 'backups')).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
  }
  const restoreSettings = async () => {
    await req('POST', '/settings/reset', { token, body: {} })
    if (settingsSnapshot && Object.keys(settingsSnapshot).length > 0) {
      await req('POST', '/settings', { token, body: settingsSnapshot })
    }
  }
  const pruneAccessLedger = () => {
    if (!statusRoot || created.length === 0) return
    const accessFile = path.join(statusRoot, 'access.json')
    try {
      withLock(path.join(statusRoot, '.lock-access'), () => {
        let ledger = {}
        try { ledger = JSON.parse(readFileSync(accessFile, 'utf8')) } catch { return }
        let changed = false
        for (const id of created) {
          if (ledger[id]) { delete ledger[id]; changed = true }
        }
        if (changed) atomicWrite(accessFile, `${JSON.stringify(ledger, null, 2)}\n`)
      }, { timeoutMs: 3000 })
    } catch { /* best-effort */ }
  }
  const cleanupAll = async () => {
    if (cleaned) return
    cleaned = true
    for (const id of created) await req('POST', '/forget', { token, body: { id } })
    pruneAccessLedger()
    try { await restoreSettings() } catch { /* ignore */ }
    try {
      const dir = path.join(statusRoot, 'backups')
      for (const name of listBackups()) {
        if (!backupsSnapshot.includes(name)) rmSync(path.join(dir, name), { force: true })
      }
    } catch { /* ignore */ }
  }
  try {
    settingsSnapshot = (await req('GET', '/settings')).json?.overlay ?? {}
    backupsSnapshot = listBackups()
  } catch { /* ignore */ }
  const abortAndExit = (code, err) => {
    if (err !== undefined) console.error('live-check 中断：', err)
    cleanupAll().catch(() => {}).then(() => finish(code))
  }
  emergencyCleanup = cleanupAll
  const dataSnapshotBefore = snapshotDataRoot(statusRoot)
  process.once('SIGINT', () => { abortAndExit(130) })
  process.once('SIGTERM', () => { abortAndExit(143) })
  process.once('uncaughtException', (err) => { abortAndExit(1, err) })
  process.once('unhandledRejection', (err) => { abortAndExit(1, err) })

  // 2. CRUD 往返（写路由包 {result}；save 返回 {entry, deduplicated}）
  let idA = ''
  let idN = ''
  await check('save → entries 检索往返', async () => {
    const { status, json } = await req('POST', '/save', { token, body: { content: `${RUN} 甲事实`, scope: 'global', category: 'fact', origin: 'auto' } })
    ok('save HTTP 200', status === 200, `got ${status} ${JSON.stringify(json)}`)
    idA = json?.result?.entry?.id ?? ''
    ok('save 返回 id', idA.startsWith('m-'))
    ok('save origin=auto', json?.result?.entry?.origin === 'auto')
    if (idA) created.push(idA)
    const q = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('entries 检索命中', (q.json?.entries ?? []).some((e) => e.id === idA))
  })

  await check('save 机密硬拒（0.15.0 新令牌格式）', async () => {
    const rej = await req('POST', '/save', { token, body: { content: 'glpat-' + 'a'.repeat(24), scope: 'global', origin: 'auto' } })
    ok('机密 save HTTP 400', rej.status === 400, `got ${rej.status}`)
    ok('机密 code=secret', rej.json?.code === 'secret', JSON.stringify(rej.json))
  })

  await check('save 相似记忆提示（0.11.0）', async () => {
    const near = await req('POST', '/save', { token, body: { content: `${RUN} 甲事实乙`, scope: 'global', origin: 'auto' } })
    idN = near.json?.result?.entry?.id ?? ''
    if (idN) created.push(idN)
    ok('save 返回 similar 数组', Array.isArray(near.json?.result?.similar), JSON.stringify(near.json))
    ok('similar 命中既有甲（score≥0.5）', (near.json?.result?.similar ?? []).some((s) => s.id === idA && s.score >= 0.5))
  })

  await check('GET /similar 查重命中相似对（0.12.0）', async () => {
    const sim = await req('GET', '/similar?scope=global')
    ok('similar HTTP 200', sim.status === 200, `got ${sim.status}`)
    const pairs = sim.json?.pairs ?? []
    ok('similar 返回 pairs 数组', Array.isArray(pairs))
    ok('similar 含甲↔甲乙对', pairs.some((p) => (p.older.id === idA && p.newer.id === idN) || (p.older.id === idN && p.newer.id === idA)))
  })

  await check('POST /import 合并模式 dry-run（0.20.0）', async () => {
    const mg = await req('POST', '/import', { token, body: { mode: 'merge', dryRun: true, entries: [{ id: idA, content: `${RUN} 甲事实合并改`, scope: 'global' }] } })
    ok('merge dry-run updated=1/imported=0', mg.json?.result?.updated === 1 && mg.json?.result?.imported === 0, JSON.stringify(mg.json))
  })

  await check('同内容复活归档条目（0.24.1）', async () => {
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 可复活事实`, scope: 'global', origin: 'auto' } })
    const idR = sv.json?.result?.entry?.id ?? ''
    if (idR) created.push(idR)
    const ar = await req('POST', '/update', { token, body: { id: idR, archived: true } })
    ok('归档 HTTP 200', ar.status === 200, `got ${ar.status}`)
    const hidden = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('归档后默认不可见', !(hidden.json?.entries ?? []).some((e) => e.id === idR))
    const again = await req('POST', '/save', { token, body: { content: `${RUN} 可复活事实`, scope: 'global', origin: 'manual' } })
    ok('再次保存 deduplicated=true', again.json?.result?.deduplicated === true, JSON.stringify(again.json))
    ok('再次保存 revived=true', again.json?.result?.revived === true, JSON.stringify(again.json))
    ok('复活后 id 不变', again.json?.result?.entry?.id === idR)
    ok('复活后 origin 更新为 manual', again.json?.result?.entry?.origin === 'manual')
    const visible = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('复活后重新可见', (visible.json?.entries ?? []).some((e) => e.id === idR))
  })

  await check('取代链不变量＋删除清理（0.24.2）', async () => {
    const a = await req('POST', '/save', { token, body: { content: `${RUN} 链甲`, scope: 'global', origin: 'auto' } })
    const idA = a.json?.result?.entry?.id ?? ''
    if (idA) created.push(idA)
    const b = await req('POST', '/save', { token, body: { content: `${RUN} 链乙`, scope: 'global', origin: 'auto', supersedes: idA } })
    const idB = b.json?.result?.entry?.id ?? ''
    if (idB) created.push(idB)
    ok('链条建立成功', a.status === 200 && b.status === 200 && b.json?.result?.entry?.supersedes === idA, JSON.stringify(b.json))
    // 覆盖已有后继必须被拒（不再静默改写 superseded_by）。
    const overwrite = await req('POST', '/save', { token, body: { content: `${RUN} 链丙`, scope: 'global', origin: 'auto', supersedes: idA } })
    ok('覆盖既有后继 HTTP 400', overwrite.status === 400, `got ${overwrite.status}`)
    ok('覆盖既有后继 code=invalid', overwrite.json?.code === 'invalid', JSON.stringify(overwrite.json))
    // 反向取代成环必须被拒。
    const cycle = await req('POST', '/update', { token, body: { id: idA, supersedes: idB } })
    ok('形成取代环 HTTP 400', cycle.status === 400, `got ${cycle.status}`)
    ok('形成取代环 code=invalid', cycle.json?.code === 'invalid', JSON.stringify(cycle.json))
    // 删除后继 → 被取代的旧条目恢复可见、引用清理。
    await req('POST', '/forget', { token, body: { id: idB } })
    const restored = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 链甲`)}`)
    ok('删除后继后旧条目恢复可见', (restored.json?.entries ?? []).some((e) => e.id === idA))
    const raw = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 链甲`)}&include_superseded=true`)
    const oldEntry = (raw.json?.entries ?? []).find((e) => e.id === idA)
    ok('旧条目 superseded_by 已清理', oldEntry && oldEntry.superseded_by === undefined, JSON.stringify(oldEntry))
  })

  await check('导入 id 跨作用域唯一（0.24.2，dry-run）', async () => {
    const im = await req('POST', '/import', { token, body: { dryRun: true, entries: [
      { id: 'm-live-cross-1', content: `${RUN} 跨域甲`, scope: 'workspace', workspace: 'D:\\Questions' },
      { id: 'm-live-cross-1', content: `${RUN} 跨域乙`, scope: 'global' },
    ] } })
    const ids = (im.json?.result?.entries ?? []).map((e) => e.id)
    ok('两条计划均生成', ids.length === 2, JSON.stringify(im.json))
    ok('同 id 输入被分配为不同 id', ids.length === 2 && ids[0] !== ids[1], JSON.stringify(ids))
  })

  await check('解析缓存不破坏手工编辑即时生效（0.24.3）', async () => {
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 手工编辑正文`, scope: 'global', origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    if (id) created.push(id)
    ok('save 手改条目', id.startsWith('m-'))
    // 先读一次让解析缓存预热（stat 签名缓存该文件）。
    const before = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 手工编辑正文`)}`)
    ok('缓存预热后命中', (before.json?.entries ?? []).some((e) => e.id === id))
    // 直接改写磁盘文件（模拟手工编辑/其它进程），签名变化应让缓存失效。
    const file = path.join(statusRoot, 'global', `${id}.md`)
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('手工编辑正文', '手工编辑正文已改'), 'utf8')
    const after = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 手工编辑正文已改`)}`)
    ok('外部改写后立即可见', (after.json?.entries ?? []).some((e) => e.id === id), JSON.stringify((after.json?.entries ?? []).map((e) => e.content)))
  })

  await check('非法作用域返回 400（0.24.6）', async () => {
    for (const name of ['entries', 'stats', 'similar']) {
      const r = await req('GET', `/${name}?scope=bogus`)
      ok(`${name} scope=bogus HTTP 400`, r.status === 400, `got ${r.status}`)
      ok(`${name} scope=bogus code=invalid`, r.json?.code === 'invalid', JSON.stringify(r.json))
    }
  })

  await check('非对象 JSON body 返回 400 invalid-json（0.24.13）', async () => {
    for (const raw of ['null', '[]', '[1,2]', '42', '"str"']) {
      const r = await reqRaw('POST', '/save', { token, raw })
      ok(`save body=${raw} HTTP 400`, r.status === 400, `got ${r.status}`)
      ok(`save body=${raw} error=invalid-json`, r.json?.error === 'invalid-json', JSON.stringify(r.json))
    }
    const settingsNull = await reqRaw('POST', '/settings', { token, raw: 'null' })
    ok('settings body=null HTTP 400', settingsNull.status === 400, `got ${settingsNull.status}`)
    ok('settings body=null error=invalid-json', settingsNull.json?.error === 'invalid-json', JSON.stringify(settingsNull.json))
  })

  await check('标签中的机密被硬拒（0.24.6）', async () => {
    const r = await req('POST', '/save', { token, body: { content: `${RUN} 标签机密`, scope: 'global', origin: 'auto', tags: ['safe', 'ghp_' + 'a'.repeat(24)] } })
    ok('save 标签机密 HTTP 400', r.status === 400, `got ${r.status}`)
    ok('save 标签机密 code=secret', r.json?.code === 'secret', JSON.stringify(r.json))
  })

  await check('工作区条目 update 刷新索引 lastSeen（0.24.6）', async () => {
    const wsCwd = 'D:\\Questions'
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 工作区索引`, scope: 'workspace', workspace: wsCwd, origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    try {
      ok('工作区 save 返回 id', id.startsWith('m-'))
      const before = await req('GET', '/workspaces')
      const findKey = (doc) => (doc?.workspaces ?? []).find((w) => typeof w.cwd === 'string' && w.cwd.toLowerCase().endsWith('questions'))
      const beforeSeen = findKey(before.json)?.lastSeen
      await new Promise((resolve) => setTimeout(resolve, 20))
      const up = await req('POST', '/update', { token, body: { id, content: `${RUN} 工作区索引更新`, workspace: wsCwd } })
      ok('update workspace HTTP 200', up.status === 200, `got ${up.status}`)
      const after = await req('GET', '/workspaces')
      const afterSeen = findKey(after.json)?.lastSeen
      ok('lastSeen 被刷新', Boolean(afterSeen) && Boolean(beforeSeen) && afterSeen >= beforeSeen, `${beforeSeen} -> ${afterSeen}`)
    } finally {
      await req('POST', '/forget', { token, body: { id, workspace: wsCwd } })
    }
  })

  await check('命中簿记写独立账本且不改写条目文件（0.24.7）', async () => {
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 账本命中`, scope: 'global', origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    if (id) created.push(id)
    const file = path.join(statusRoot, 'global', `${id}.md`)
    const beforeText = readFileSync(file, 'utf8')
    const beforeMtime = statSync(file).mtimeMs
    const first = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 账本命中`)}`)
    ok('账本条目检索命中', (first.json?.entries ?? []).some((e) => e.id === id))
    const accessFile = path.join(statusRoot, 'access.json')
    let ledger = {}
    try { ledger = JSON.parse(readFileSync(accessFile, 'utf8')) } catch { /* 首次 */ }
    ok('access.json 记录命中次数', Boolean(ledger[id]) && ledger[id].count >= 1, JSON.stringify(ledger[id]))
    ok('条目 Markdown 未被命中簿记改写', readFileSync(file, 'utf8') === beforeText && statSync(file).mtimeMs === beforeMtime)
    const second = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 账本命中`)}`)
    const hitEntry = (second.json?.entries ?? []).find((e) => e.id === id)
    ok('再次检索可见命中计数（账本叠加）', Boolean(hitEntry) && hitEntry.hit_count >= 1, JSON.stringify(hitEntry))
  })

  await check('手工文件健壮性：BOM/CRLF、文件名权威、坏文件可删、账本清理（0.24.8）', async () => {
    const stamp = Date.now().toString(36)
    const bomId = `m-livebom-${stamp}`
    const brokenId = `m-livebroken-${stamp}`
    const bomFile = path.join(statusRoot, 'global', `${bomId}.md`)
    const brokenFile = path.join(statusRoot, 'global', `${brokenId}.md`)
    const nowIso = new Date().toISOString()
    try {
      // 1) BOM + CRLF + frontmatter id 与文件名不一致：应以文件名解析出来。
      const bomText = [
        '\uFEFF---',
        'id: m-deadbeef', // 与文件名不一致，应被忽略
        'category: fact',
        'scope: global',
        'tags: []',
        `created: ${nowIso}`,
        `updated: ${nowIso}`,
        'source: ',
        '---',
        '',
        `${RUN} 记事本保存的条目`,
        '',
      ].join('\r\n')
      writeFileSync(bomFile, bomText, 'utf8')
      const found = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 记事本保存的条目`)}`)
      ok('BOM/CRLF 条目可见', (found.json?.entries ?? []).some((e) => e.id === bomId), JSON.stringify((found.json?.entries ?? []).map((e) => e.id)))
      ok('文件名权威（非 frontmatter id）', !(found.json?.entries ?? []).some((e) => e.id === 'm-deadbeef'))
      // 2) 坏文件可按 id 删除。
      writeFileSync(brokenFile, 'not frontmatter', 'utf8')
      const delBroken = await req('POST', '/forget', { token, body: { id: brokenId } })
      ok('损坏文件可按 id 删除', delBroken.status === 200 && delBroken.json?.result?.deleted === true, JSON.stringify(delBroken.json))
      ok('损坏文件已消失', !existsSync(brokenFile))
    } finally {
      try { if (existsSync(bomFile)) await req('POST', '/forget', { token, body: { id: bomId } }) } catch { /* ignore */ }
      try { if (existsSync(bomFile)) rmSync(bomFile, { force: true }) } catch { /* ignore */ }
      try { rmSync(brokenFile, { force: true }) } catch { /* ignore */ }
    }
    // 3) forget 清理账本余影。
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 账本清理`, scope: 'global', origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    if (id) created.push(id)
    await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 账本清理`)}`)
    await req('POST', '/forget', { token, body: { id } })
    let ledger = {}
    try { ledger = JSON.parse(readFileSync(path.join(statusRoot, 'access.json'), 'utf8')) } catch { /* ignore */ }
    ok('forget 后账本记录已清理', ledger[id] === undefined, JSON.stringify(ledger[id]))
  })

  await check('导出携带权威 workspaceKey 且可回灌（0.24.9）', async () => {
    const wsCwd = 'D:\\Questions'
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 导出键`, scope: 'workspace', workspace: wsCwd, origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    try {
      ok('工作区导出测试条目已创建', id.startsWith('m-'))
      const doc = await req('GET', '/export?scope=all')
      const mine = (doc.json?.entries ?? []).find((e) => e.id === id)
      ok('导出条目含权威 workspaceKey', Boolean(mine) && /^[a-f0-9]{16}$/.test(String(mine.workspaceKey)), JSON.stringify(mine && mine.workspaceKey))
      // 按 workspaceKey 回灌（dry-run）：能定位作用域、不应被 no-workspace 拒绝。
      const im = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ id, content: `${RUN} 导出键`, scope: 'workspace', workspaceKey: mine?.workspaceKey }] } })
      ok('按 workspaceKey 回灌可解析', im.status === 200 && (im.json?.result?.rejected?.length ?? 1) === 0, JSON.stringify(im.json))
    } finally {
      await req('POST', '/forget', { token, body: { id, workspace: wsCwd } })
    }
  })

  await check('update origin 修正往返（0.10.0）', async () => {
    const up = await req('POST', '/update', { token, body: { id: idA, origin: 'manual' } })
    ok('update origin HTTP 200', up.status === 200, `got ${up.status}`)
    ok('update 返回 origin=manual', up.json?.result?.origin === 'manual', JSON.stringify(up.json))
    const q = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('entries 反映 origin=manual', (q.json?.entries ?? []).some((e) => e.id === idA && e.origin === 'manual'))
    const back = await req('POST', '/update', { token, body: { id: idA, origin: 'auto' } })
    ok('origin 还原 auto', back.json?.result?.origin === 'auto')
  })

  await check('save 缺 origin 服务层兜底 manual（0.10.0）', async () => {
    const { json } = await req('POST', '/save', { token, body: { content: `${RUN} 缺省来源`, scope: 'global' } })
    const idD = json?.result?.entry?.id ?? ''
    if (idD) created.push(idD)
    ok('缺 origin 兜底 manual', json?.result?.entry?.origin === 'manual', JSON.stringify(json))
  })

  let idB = ''
  await check('update（pinned）＋取代链＋默认隐藏', async () => {
    const up = await req('POST', '/update', { token, body: { id: idA, pinned: true } })
    ok('update pinned HTTP 200', up.status === 200, `got ${up.status}`)
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 乙事实（取代甲）`, scope: 'global', supersedes: idA } })
    idB = sv.json?.result?.entry?.id ?? ''
    ok('supersede save 返回 id', idB.startsWith('m-'))
    if (idB) created.push(idB)
    const def = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    const defIds = (def.json?.entries ?? []).map((e) => e.id)
    ok('默认隐藏被取代的甲', !defIds.includes(idA), `ids=${defIds}`)
    ok('默认显示取代者乙', defIds.includes(idB))
    const inc = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_superseded=true`)
    ok('include_superseded 找回甲', (inc.json?.entries ?? []).some((e) => e.id === idA))
  })

  await check('归档/恢复＋过期过滤', async () => {
    const ar = await req('POST', '/update', { token, body: { id: idB, archived: true } })
    ok('archive HTTP 200', ar.status === 200, `got ${ar.status}`)
    const def = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('默认隐藏已归档乙', !(def.json?.entries ?? []).some((e) => e.id === idB))
    const inc = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_archived=true`)
    ok('include_archived 找回乙', (inc.json?.entries ?? []).some((e) => e.id === idB))
    await req('POST', '/update', { token, body: { id: idB, archived: false } })
    const ex = await req('POST', '/save', { token, body: { content: `${RUN} 过期事实`, scope: 'global', expires: '2020-01-01' } })
    const idC = ex.json?.result?.entry?.id ?? ''
    if (idC) created.push(idC)
    const def2 = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('默认隐藏已过期', !(def2.json?.entries ?? []).some((e) => e.id === idC))
    const inc2 = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_expired=true`)
    ok('include_expired 找回', (inc2.json?.entries ?? []).some((e) => e.id === idC))
  })

  await check('GET /entries 隐藏态计数（0.18.0）', async () => {
    const def = await req('GET', `/entries?query=${encodeURIComponent(RUN)}`)
    ok('entries 返回 hidden 对象', def.json?.hidden && typeof def.json.hidden.total === 'number')
    ok('默认有隐藏匹配', def.json?.hidden?.total >= 1)
    const inc = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_superseded=true&include_expired=true&include_archived=true`)
    ok('全 include 后 hidden.total=0', inc.json?.hidden?.total === 0)
  })

  await check('GET /entries 来源过滤（0.21.0）', async () => {
    const a = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&origin=auto`)
    ok('origin=auto 仅自动条目', (a.json?.entries ?? []).every((e) => (e.origin || 'manual') === 'auto'))
  })

  await check('GET /entries 状态服务端过滤（0.24.0）', async () => {
    const a = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&status=active`)
    const today = new Date().toISOString().slice(0, 10)
    ok('status=active 仅活跃条目', (a.json?.entries ?? []).every((e) => !e.superseded_by && !e.archived && !(e.expires && e.expires < today)))
  })

  // 3. stats byStatus
  await check('stats 含 byStatus', async () => {
    const { json } = await req('GET', '/stats')
    ok('stats.byStatus 存在', json?.stats?.byStatus && typeof json.stats.byStatus.active === 'number')
  })

  await check('GET /recall-preview 召回预览（0.14.0）', async () => {
    const rp = await req('GET', '/recall-preview')
    ok('recall-preview HTTP 200', rp.status === 200, `got ${rp.status}`)
    const d = rp.json
    ok('recall-preview 字段齐全', typeof d?.injected === 'number' && typeof d?.omitted === 'number' && typeof d?.usedChars === 'number' && typeof d?.budgetChars === 'number' && Array.isArray(d?.entries))
    ok('recall-preview injected===entries.length', d?.injected === d?.entries?.length)
  })

  // 4. settings：toggle 到反值验证后还原原值（GET 无 {result} 包裹；绝不 reset）
  await check('settings 新键 toggle 后还原', async () => {
    const before = await req('GET', '/settings')
    const origDecay = before.json?.effective?.decayEnabled
    const origHint = before.json?.effective?.autoExtractHint
    ok('effective.decayEnabled 为布尔', typeof origDecay === 'boolean', `got ${origDecay}`)
    ok('effective.autoExtractHint 为布尔', typeof origHint === 'boolean', `got ${origHint}`)
    const target = !origDecay
    const post = await req('POST', '/settings', { token, body: { decayEnabled: target, autoExtractHint: target } })
    ok('settings POST 生效', post.json?.result?.effective?.decayEnabled === target && post.json?.result?.effective?.autoExtractHint === target)
    await req('POST', '/settings', { token, body: { decayEnabled: origDecay, autoExtractHint: origHint } })
    const restored = await req('GET', '/settings')
    ok('settings 还原原值', restored.json?.effective?.decayEnabled === origDecay && restored.json?.effective?.autoExtractHint === origHint)
  })

  // 5. backup / export / import dry-run / workspaces
  await check('backup / export / import dry-run / workspaces（不裁剪历史备份，0.24.15）', async () => {
    // 先抬高保留份数再备份：确保轮转不会删除用户已有备份（清理阶段会恢复原设置）。
    const settingsNow = (await req('GET', '/settings')).json
    const retentionNow = Number(settingsNow?.effective?.backupRetention) || 7
    const safeRetention = Math.max(retentionNow, backupsSnapshot.length + 2)
    await req('POST', '/settings', { token, body: { backupRetention: safeRetention } })
    const beforeTrigger = listBackups().length
    // 用户手放的 JSON 不应被轮转删除（0.24.18：只轮转插件自己的时间戳备份）。
    const manualFile = path.join(statusRoot, 'backups', 'user-manual-note.json')
    writeFileSync(manualFile, '{"user":"manual"}', 'utf8')
    const bk = await req('POST', '/backup', { token, body: {} })
    ok('backup 返回 file', typeof bk.json?.result?.file === 'string')
    ok('backup 未裁剪既有历史备份', listBackups().length >= beforeTrigger + 2, `${beforeTrigger} -> ${listBackups().length}`)
    ok('备份不删除用户手放文件', existsSync(manualFile))
    const ex = await req('GET', '/export')
    ok('export format', ex.json?.format === 'dsh-memory-export')
    const im = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ content: `${RUN} 导入预览`, scope: 'global' }] } })
    ok('import dryRun imported=1', im.json?.result?.dryRun === true && im.json?.result?.imported === 1)
    const ws = await req('GET', '/workspaces')
    ok('workspaces 数组', Array.isArray(ws.json?.workspaces))
  })

  await check('备份在导入锁期间快速失败（busy，0.24.21）', async () => {
    const lock = path.join(statusRoot, '.lock-import')
    try {
      mkdirSync(lock, { recursive: true })
      const started = Date.now()
      const r = await req('POST', '/backup', { token, body: {} })
      const elapsed = Date.now() - started
      ok('backup busy HTTP 503', r.status === 503, `got ${r.status}`)
      ok('backup busy code=busy', r.json?.code === 'busy', JSON.stringify(r.json))
      ok('backup busy 快速返回（≤3s）', elapsed < 3000, `${elapsed}ms`)
    } finally {
      try { rmSync(lock, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  await check('隐藏归类与统计/列表同口径（0.24.20）', async () => {
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 双态条目`, scope: 'global', origin: 'auto' } })
    const id = sv.json?.result?.entry?.id ?? ''
    if (id) created.push(id)
    await req('POST', '/update', { token, body: { id, archived: true, expires: '2020-01-01' } })
    const q = `query=${encodeURIComponent(`${RUN} 双态条目`)}&scope=global`
    const det = await req('GET', `/entries?${q}`)
    ok('双态 hidden 归入 expired（与状态优先一致）', det.json?.hidden?.expired === 1 && det.json?.hidden?.archived === 0, JSON.stringify(det.json?.hidden))
    const stats = await req('GET', `/stats?${q}`)
    ok('双态 byStatus 也是 expired', stats.json?.stats?.byStatus?.expired === 1, JSON.stringify(stats.json?.stats))
    const partial = await req('GET', `/entries?${q}&include_expired=true`)
    ok('部分放宽时按被拦截的归档归类', partial.json?.hidden?.archived === 1 && partial.json?.hidden?.expired === 0, JSON.stringify(partial.json?.hidden))
    const filteredStats = await req('GET', `/stats?${q}&status=expired&include_expired=true&include_archived=true`)
    ok('stats 过滤视图与列表同口径', filteredStats.json?.stats?.total === 1, JSON.stringify(filteredStats.json?.stats))
  })

  await check('账本幽灵清理与悬垂取代指针修复（0.24.18）', async () => {
    // a) 手工删除文件留下的账本幽灵记录：下一次导入成功后触发惰性 prune。
    const sv = await req('POST', '/save', { token, body: { content: `${RUN} 幽灵清理`, scope: 'global', origin: 'auto' } })
    const ghostId = sv.json?.result?.entry?.id ?? ''
    ok('幽灵测试条目已创建', ghostId.startsWith('m-'))
    created.push(ghostId)
    await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 幽灵清理`)}`)
    let ledger = {}
    try { ledger = JSON.parse(readFileSync(path.join(statusRoot, 'access.json'), 'utf8')) } catch { /* ignore */ }
    ok('账本命中记录已建立', Boolean(ledger[ghostId]))
    rmSync(path.join(statusRoot, 'global', `${ghostId}.md`), { force: true })
    const im = await req('POST', '/import', { token, body: { entries: [{ content: `${RUN} 触发清理`, scope: 'global' }] } })
    ok('触发清理的导入成功', im.json?.result?.imported === 1, JSON.stringify(im.json?.result))
    const found = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 触发清理`)}&scope=global`)
    for (const e of found.json?.entries ?? []) created.push(e.id)
    let after = {}
    try { after = JSON.parse(readFileSync(path.join(statusRoot, 'access.json'), 'utf8')) } catch { /* ignore */ }
    ok('幽灵账本记录已被 prune', after[ghostId] === undefined, JSON.stringify(after[ghostId]))

    // b) 悬垂 supersede 指针：dryRun 与落盘都计 repaired，修复后条目默认可见。
    const dangling = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ content: `${RUN} 悬垂指针`, scope: 'global', supersedes: 'm-missing-deadbeef' }] } })
    ok('悬垂指针 dryRun repaired=1', dangling.json?.result?.repaired === 1, JSON.stringify(dangling.json?.result))
    const realImp = await req('POST', '/import', { token, body: { entries: [{ content: `${RUN} 悬垂指针`, scope: 'global', supersedes: 'm-missing-deadbeef' }] } })
    ok('悬垂指针落盘 repaired=1', realImp.json?.result?.repaired === 1 && realImp.json?.result?.imported === 1, JSON.stringify(realImp.json?.result))
    const visible = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 悬垂指针`)}&scope=global`)
    for (const e of visible.json?.entries ?? []) created.push(e.id)
    ok('修复后条目默认可见', (visible.json?.entries ?? []).length === 1, JSON.stringify(visible.json?.entries))
  })

  await check('导入落盘失败零变更（结构化 io 错误，0.24.16）', async () => {
    const key = 'f'.repeat(16)
    const blocker = path.join(statusRoot, 'workspaces', key)
    try {
      mkdirSync(path.join(statusRoot, 'workspaces'), { recursive: true })
      ok('阻塞路径可用', !existsSync(blocker))
      writeFileSync(blocker, 'blocker', 'utf8')
      const r = await req('POST', '/import', { token, body: { entries: [
        { content: `${RUN} 原子全局`, scope: 'global' },
        { content: `${RUN} 原子工作区`, scope: 'workspace', workspaceKey: key },
      ] } })
      ok('失败导入 HTTP 500', r.status === 500, `got ${r.status}`)
      ok('失败导入 code=io', r.json?.code === 'io', JSON.stringify(r.json))
      ok('失败导入文案不含绝对路径', !String(r.json?.error ?? '').includes(statusRoot), String(r.json?.error))
      const left = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 原子`)}&scope=all&include_superseded=true&include_expired=true&include_archived=true`)
      ok('失败导入未留下部分写入', (left.json?.entries ?? []).length === 0, JSON.stringify((left.json?.entries ?? []).map((e) => e.id)))
    } finally {
      try { rmSync(blocker, { force: true }) } catch { /* ignore */ }
    }
  })

  await check('>1MB 导入备份可恢复（0.24.15）', async () => {
    const bigContent = `${RUN} 大备份 ` + 'x'.repeat(1_200_000)
    const dry = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ content: bigContent, scope: 'global' }] } })
    ok('大 body dryRun HTTP 200', dry.status === 200, `got ${dry.status}`)
    ok('大 body dryRun 返回预览计划', dry.json?.result?.imported === 1 && Array.isArray(dry.json?.result?.entries))
    const real = await req('POST', '/import', { token, body: { entries: [{ content: bigContent, scope: 'global' }] } })
    ok('大 body 落盘 HTTP 200', real.status === 200, `got ${real.status}`)
    ok('落盘响应不回传 entries', real.status === 200 && real.json?.result?.entries === undefined)
    const found = await req('GET', `/entries?query=${encodeURIComponent(`${RUN} 大备份`)}&scope=global`)
    for (const e of found.json?.entries ?? []) created.push(e.id)
    ok('大备份条目已建立', (found.json?.entries ?? []).length === 1, JSON.stringify(found.json).slice(0, 160))
  })

  await check('POST /import 拒绝非法 expires（0.24.1）', async () => {
    const im = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ content: `${RUN} 坏日期`, scope: 'global', expires: '2026-99-99' }] } })
    ok('import 坏日期 rejected=1', im.json?.result?.rejected?.length === 1, JSON.stringify(im.json))
    ok('import 坏日期 code=invalid', im.json?.result?.rejected?.[0]?.code === 'invalid')
  })

  await check('GET /export 作用域过滤（0.17.0）', async () => {
    const g = await req('GET', '/export?scope=global')
    ok('export global format', g.json?.format === 'dsh-memory-export')
    ok('export global 仅全局条目', (g.json?.entries ?? []).every((e) => e.scope === 'global' && e.workspace === null))
  })

  // 6. 客户端分发 rev：按宿主配方从 client.js stat 计算 rev，取 bundle 验证含新代码
  await check('客户端 bundle 按 rev 分发且含新代码', async () => {
    const rev = clientRev()
    const url = `${BASE}/plugins/??dsh-memory/client.js&rev=${rev}`
    const b = await fetch(url)
    const code = await b.text()
    ok('bundle HTTP 200', b.status === 200, `got ${b.status} rev=${rev}`)
    ok('bundle 内容体量合理（非空壳）', code.length > 20000, `${code.length} bytes`)
    // 陈旧 rev 必须被拒绝，避免把旧代码当新版本分发。
    const stale = await fetch(`${BASE}/plugins/??dsh-memory/client.js&rev=000000000000`)
    ok('陈旧 rev 被拒绝', stale.status !== 200, `got ${stale.status}`)
    ok('bundle 含 0.9.0 代码标记 autoExtractHint', code.includes('autoExtractHint'))
    ok('bundle 含 0.10.0 新文案 显式要求/Requested', code.includes('显式要求') && code.includes('Requested'))
    ok('bundle 含 0.11.0 新文案 similarSaved', code.includes('similarSaved'))
    ok('bundle 含 0.12.0 新文案 auditTitle', code.includes('auditTitle'))
    ok('bundle 含 0.14.0 新文案 recallTitle', code.includes('recallTitle'))
    ok('bundle 含 0.16.0 新文案 statusAll/jumpToEntry', code.includes('statusAll') && code.includes('jumpToEntry'))
    ok('bundle 含 0.17.0 新文案 已导出 {n} 条记忆', code.includes('已导出 {n} 条记忆'))
    ok('bundle 含 0.18.0 新文案 hiddenHint', code.includes('hiddenHint'))
    ok('bundle 含 0.19.0 新文案 injectedLabel', code.includes('injectedLabel'))
    ok('bundle 含 0.20.0 新文案 importMergeLabel', code.includes('importMergeLabel'))
    ok('bundle 含 0.22.0 新文案 tagFilterPlaceholder', code.includes('tagFilterPlaceholder'))
    // 0.24.1：面板列表请求构造器必须序列化 origin/tag/status，否则过滤不生效。
    ok('bundle 含 0.24.1 修复 entriesParams', code.includes('entriesParams'))
    ok('bundle 序列化 origin/tag/status', code.includes('p.origin') && code.includes('p.tag') && code.includes('p.status'))
    // 0.24.4：请求超时/网络错误映射、撤销吐司优先队列、批量删除逐项结算。
    ok('bundle 含 0.24.4 超时与队列修复', code.includes('REQUEST_TIMEOUT_MS') && code.includes('AbortSignal') && code.includes('errTimeout'))
    ok('bundle 含 0.24.4 撤销队列与删除结算', code.includes('shouldQueueToast') && code.includes('partitionSettled'))
    // 0.24.5：设置写路由解包、标签收敛、ARIA Tabs。
    ok('bundle 含 0.24.5 设置解包与标签收敛', code.includes('unwrapResult') && code.includes('parseTags'))
    ok('bundle 含 0.24.5 ARIA Tabs', code.includes('dm-panel-settings') && code.includes('onTabKey'))
    // 0.24.10：设置写入状态机（失败重试、重置互斥）。
    ok('bundle 含 0.24.19 面板体验', code.includes('sectionCountsExact') && code.includes('toastPausedRef') && code.includes('clearSearch') && code.includes('deleting'))
    ok('bundle 含 0.24.16 原子导入错误文案', code.includes('errIo') && code.includes('errBusy'))
    ok('bundle 含 0.24.15 大备份导入', code.includes('IMPORT_MAX_BYTES') && code.includes('IMPORT_TIMEOUT_MS'))
    ok('bundle 含 0.24.14 刷新解耦', code.includes('defaultViewSelection') && code.includes('refreshRecall'))
    ok('bundle 含 0.24.12 可访问性与导入', code.includes('parseImportText') && code.includes('closeToast') && code.includes('onCategoryKey'))
    ok('bundle 含 0.24.11 面板正确性', code.includes('savedToastKey') && code.includes('exportParams') && code.includes('filterByTag') && code.includes('emptyScopeTitle'))
    ok('bundle 含 0.24.10 设置状态机', code.includes('settingsStatusNext') && code.includes('dm_linkbtn'))
  })

  // 7. 清理测试条目 + 恢复设置/备份快照（正常结束与异常中断共用同一幂等清理）
  await check('清理测试条目并恢复设置/备份快照', async () => {
    await cleanupAll()
    const left = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_superseded=true&include_archived=true&include_expired=true`)
    ok('测试条目已全部清理', (left.json?.entries ?? []).length === 0, `残留 ${(left.json?.entries ?? []).length}`)
    const restoredOverlay = (await req('GET', '/settings')).json?.overlay ?? {}
    ok('设置 overlay 已恢复原值', JSON.stringify(restoredOverlay) === JSON.stringify(settingsSnapshot), JSON.stringify({ restoredOverlay, settingsSnapshot }))
    ok('backups 无本次新增残留', listBackups().every((n) => backupsSnapshot.includes(n)), JSON.stringify({ before: backupsSnapshot, after: listBackups() }))
    const dataChanges = diffSnapshots(dataSnapshotBefore, snapshotDataRoot(statusRoot))
    ok('真实数据根快照前后一致（零残留）', dataChanges.length === 0, JSON.stringify(dataChanges.slice(0, 5)))
  })

  finish()
}

function finish(exitCode) {
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(typeof exitCode === 'number' ? exitCode : (fail > 0 ? 1 : 0))
}

main().catch(async (err) => {
  console.error('live-check 异常：', err)
  try { if (emergencyCleanup) await emergencyCleanup() } catch { /* ignore */ }
  process.exit(1)
})
