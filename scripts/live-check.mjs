/**
 * dsh-memory live 验证脚本 —— 对运行中的宿主回环路由做端到端检查。
 *
 * 用法 Run:
 *   node scripts/live-check.mjs --port=51953
 *   node scripts/live-check.mjs            （默认端口 51953，或 env DSH_MEMORY_PORT）
 *
 * 安全：对真实数据根运行。测试条目带唯一标记并在末尾全部 forget 清理；
 * 设置 toggle 到反值验证后还原原值，绝不 reset 用户配置；backup 仅新增备份文件。
 * 仅打回环地址 127.0.0.1（与任务目标一致，不使用任何代理）。
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const portArg = argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? argv.find((a) => /^\d+$/.test(a))
const PORT = Number(portArg ?? process.env.DSH_MEMORY_PORT ?? 51953)
const BASE = `http://127.0.0.1:${PORT}`
const API = `${BASE}/plugins/dsh-memory`
const RUN = `__livecheck_${Date.now().toString(36)}__`
const CLIENT_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function check(name, fn) {
  try { await fn() } catch (err) { ok(name, false, err?.message ?? String(err)) }
}

async function req(method, path, { body, token, base = API } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-RPC-Key'] = token
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
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

async function main() {
  console.log(`dsh-memory live-check @ ${BASE}\n`)

  // 1. status：版本与 schema
  let token = ''
  await check('status 报告 version=0.13.0 / schemaVersion=2 并下发 token', async () => {
    const { status, json } = await req('GET', '/status')
    ok('status HTTP 200', status === 200, `got ${status}`)
    ok('status.ok', json?.ok === true)
    ok('version === 0.13.0', json?.version === '0.13.0', `got ${json?.version}`)
    ok('schemaVersion === 2', json?.schemaVersion === 2, `got ${json?.schemaVersion}`)
    ok('token 非空', typeof json?.key === 'string' && json.key.length > 0)
    token = json?.key ?? ''
  })
  if (!token) { console.log('\n无法取得 token，终止。'); finish(); return }

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

  // 3. stats byStatus
  await check('stats 含 byStatus', async () => {
    const { json } = await req('GET', '/stats')
    ok('stats.byStatus 存在', json?.stats?.byStatus && typeof json.stats.byStatus.active === 'number')
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
  await check('backup / export / import dry-run / workspaces', async () => {
    const bk = await req('POST', '/backup', { token, body: {} })
    ok('backup 返回 file', typeof bk.json?.result?.file === 'string')
    const ex = await req('GET', '/export')
    ok('export format', ex.json?.format === 'dsh-memory-export')
    const im = await req('POST', '/import', { token, body: { dryRun: true, entries: [{ content: `${RUN} 导入预览`, scope: 'global' }] } })
    ok('import dryRun imported=1', im.json?.result?.dryRun === true && im.json?.result?.imported === 1)
    const ws = await req('GET', '/workspaces')
    ok('workspaces 数组', Array.isArray(ws.json?.workspaces))
  })

  // 6. 客户端分发 rev：按宿主配方从 client.js stat 计算 rev，取 bundle 验证含新代码
  await check('客户端 bundle 按 rev 分发且含新代码', async () => {
    const rev = clientRev()
    const url = `${BASE}/plugins/??dsh-memory/client.js&rev=${rev}`
    const b = await fetch(url)
    const code = await b.text()
    ok('bundle HTTP 200', b.status === 200, `got ${b.status} rev=${rev}`)
    ok('bundle 含 0.9.0 代码标记 autoExtractHint', code.includes('autoExtractHint'))
    ok('bundle 含 0.10.0 新文案 显式要求/Requested', code.includes('显式要求') && code.includes('Requested'))
    ok('bundle 含 0.11.0 新文案 similarSaved', code.includes('similarSaved'))
    ok('bundle 含 0.12.0 新文案 auditTitle', code.includes('auditTitle'))
  })

  // 7. 清理测试条目
  await check('清理测试条目', async () => {
    for (const id of created) await req('POST', '/forget', { token, body: { id } })
    const left = await req('GET', `/entries?query=${encodeURIComponent(RUN)}&include_superseded=true&include_archived=true&include_expired=true`)
    ok('测试条目已全部清理', (left.json?.entries ?? []).length === 0, `残留 ${(left.json?.entries ?? []).length}`)
  })

  finish()
}

function finish() {
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => { console.error('live-check 异常：', err); process.exit(1) })
