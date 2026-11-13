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
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
let statusRoot = ''

async function main() {
  console.log(`dsh-memory live-check @ ${BASE}\n`)

  // 1. status：版本与 schema
  let token = ''
  await check('status 报告 version=0.24.4 / schemaVersion=2 并下发 token', async () => {
    const { status, json } = await req('GET', '/status')
    ok('status HTTP 200', status === 200, `got ${status}`)
    ok('status.ok', json?.ok === true)
    ok('version === 0.24.4', json?.version === '0.24.4', `got ${json?.version}`)
    ok('schemaVersion === 2', json?.schemaVersion === 2, `got ${json?.schemaVersion}`)
    ok('token 非空', typeof json?.key === 'string' && json.key.length > 0)
    token = json?.key ?? ''
    statusRoot = json?.root ?? ''
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
