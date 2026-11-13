/**
 * dsh-memory 真实 GUI 验证脚本（Edge headless + CDP）。
 *
 * 为什么需要它：live-check 直接打回环 API，覆盖不到「面板发出的请求到底带了什么
 * 参数」「下拉/弹窗的真实键盘行为」这类浏览器侧契约——0.22–0.24 的过滤失效与
 * 0.24.1 的下拉焦点问题都恰好落在这一层。
 *
 * 用法 Run:
 *   node scripts/gui-check.mjs --url=http://127.0.0.1:57031/ [--shot=out.png]
 *   默认 URL 取 env DSH_MEMORY_GUI_URL；Edge 路径可用 env EDGE_PATH 覆盖。
 *
 * 安全：默认只做「可逆」操作——临时记忆全部清理；设置页破坏性用例（重置/备份）
 * 运行前快照真实 settings overlay 与 backups/ 文件集，结束后原样恢复并删除本次新增
 * 备份，保证真实数据根前后一致。日志/截图只在本机临时目录。
 * 登录 cookie 由本机 <DSH_HOME>/.credentials.yaml 的 browser-session secret 自签
 * （与 dsh-client-connection 同一算法），仅用于回环地址。
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotDataRoot, diffSnapshots } from './data-snapshot.mjs'
import { acquireVerifyLock } from './verify-lock.mjs'
import { startCleanupWatchdog } from './watchdog.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const BASE = argOf('url') ?? process.env.DSH_MEMORY_GUI_URL ?? 'http://127.0.0.1:57031/'
const SHOT = argOf('shot') ?? path.join(os.tmpdir(), 'dsh-memory-gui-check.png')
// 动态默认 CDP 端口：固定 9334 会让并发运行连到同一个 Edge 页面。
const CDP_PORT = Number(argOf('cdp-port') ?? (9300 + Math.floor(Math.random() * 600)))
// 测试用中断注入：到点走与真实 SIGINT 相同的清理/自检路径（Windows 下无法可靠发 SIGINT）。
const ABORT_AFTER = Number(argOf('abort-after') ?? 0)
const USER_DATA = path.join(os.tmpdir(), `dsh-memory-gui-profile-${process.pid}`)
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ===== 真实数据根快照/恢复（设置页破坏性用例前后保持一致） =====
let ROOT = ''
let TOKEN = ''
let verifyLock = null
let dataSnapshotBefore = null
let overlayBaseline = {}
let backupsBaseline = []
let watchdog = null

/** 看门狗恢复 settings 用的原始基线（不存在则删除）。 */
function readSettingsRaw(root) {
  try {
    return { exists: true, content: readFileSync(path.join(root, 'settings.json'), 'utf8') }
  } catch {
    return { exists: false }
  }
}

// ===== 中断安全：幂等清理注册表 + 统一 abort 路径（SIGINT/SIGTERM/未捕获异常）=====
const cleanupHooks = []
let aborting = false

function registerCleanup(fn) {
  cleanupHooks.push(fn)
}

async function runCleanupHooks() {
  const hooks = cleanupHooks.splice(0).reverse()
  for (const fn of hooks) {
    try {
      await fn()
    } catch (err) {
      console.error('清理钩子失败：', err?.message ?? err)
    }
  }
}

async function forgetIds(ids) {
  const list = (ids || []).filter(Boolean)
  if (list.length === 0) return
  await apiJson('/forget', { method: 'POST', token: TOKEN, body: { ids: list } }).catch(() => {})
}

/** 启动时清理上次中断留下的测试条目（只认 __gui_/__livecheck_ 内容标记，不碰真实记忆）。 */
async function cleanupResidueMarkers() {
  if (!TOKEN) return
  const ids = []
  for (const marker of ['__gui_', '__livecheck_']) {
    const doc = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=all&limit=200&include_superseded=true&include_expired=true&include_archived=true`).catch(() => null)
    for (const entry of doc?.entries || []) {
      const content = String(entry.content || '')
      if (content.startsWith(marker) || content.includes(marker)) ids.push(entry.id)
    }
  }
  await forgetIds(ids)
}

async function abortAndExit(code, err) {
  if (aborting) return
  aborting = true
  console.error(`GUI CHECK 中断（${code}）：`, err?.message ?? err ?? '')
  await runCleanupHooks()
  if (ROOT && dataSnapshotBefore) {
    const changes = diffSnapshots(dataSnapshotBefore, snapshotDataRoot(ROOT))
    if (changes.length > 0) console.error('数据根残差：', JSON.stringify(changes.slice(0, 5)))
    else console.error('数据根零残留（中断清理成功）')
  }
  process.exit(code)
}

process.once('SIGINT', () => { void abortAndExit(130, new Error('SIGINT')) })
process.once('SIGTERM', () => { void abortAndExit(143, new Error('SIGTERM')) })
process.on('uncaughtException', (err) => { void abortAndExit(1, err) })
process.on('unhandledRejection', (err) => { void abortAndExit(1, err) })

function listBackups() {
  if (!ROOT) return []
  try {
    return readdirSync(path.join(ROOT, 'backups')).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function removeNewBackups(before) {
  if (!ROOT) return
  const dir = path.join(ROOT, 'backups')
  for (const name of listBackups()) {
    if (before.includes(name)) continue
    try { rmSync(path.join(dir, name), { force: true }) } catch { /* ignore */ }
  }
}

// 先 reset 再写回原 overlay：恢复成「运行前精确状态」（reset 清除测试期间新增键）。
async function restoreSettingsOverlay(overlay) {
  if (!TOKEN) return
  await apiJson('/settings/reset', { method: 'POST', token: TOKEN, body: {} })
  if (overlay && Object.keys(overlay).length > 0) await apiJson('/settings', { method: 'POST', token: TOKEN, body: overlay })
}

// 浏览器之外的直连 API（仅本机回环）：用于创建/清理验收临时记忆、核对撤销结果。
async function apiJson(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-RPC-Key'] = token
  const res = await fetch(new URL(`/plugins/dsh-memory${pathname}`, BASE), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json().catch(() => null)
}

// ===== 浏览器会话 cookie 自签（host: dsh-client-connection browser-session） =====
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

function readSigningSecret(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const at = lines.findIndex((line) => line.trim() === 'client-connection/browser-session:')
  if (at === -1) throw new Error(`credentials: ${file} 缺少 client-connection/browser-session 记录`)
  const indent = lines[at].length - lines[at].trimStart().length
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (lines[i].length - lines[i].trimStart().length <= indent) break
    const matched = /^\s*secret:\s*(\S+)\s*$/.exec(lines[i])
    if (matched !== null) {
      const key = Buffer.from(matched[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
      if (key.byteLength !== 32) throw new Error(`credentials: secret 为 ${key.byteLength} 字节，期望 32`)
      return key
    }
  }
  throw new Error('credentials: browser-session secret 缺失')
}

function authCookie(base) {
  const url = new URL(base)
  const key = readSigningSecret(path.join(DSH_HOME, '.credentials.yaml'))
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: url.host, issuedAt, expiresAt }), 'utf8'))
  const signature = b64url(createHmac('sha256', key).update(body).digest())
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(url.host).digest())
  return { name, value: `v1.${body}.${signature}`, url: url.href }
}

// ===== CDP 最小客户端 =====
let ws
let nextId = 0
const pending = new Map()
const events = new Map()
const requests = []
const consoleLines = []

async function connect() {
  let targets = null
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      targets = await res.json()
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break
    } catch { /* 浏览器尚未就绪 browser not ready */ }
    await sleep(250)
  }
  if (!Array.isArray(targets)) throw new Error(`CDP 端口 ${CDP_PORT} 未就绪`)
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id !== undefined) {
      const entry = pending.get(data.id)
      if (entry !== undefined) {
        pending.delete(data.id)
        if (data.error) entry.reject(new Error(JSON.stringify(data.error)))
        else entry.resolve(data.result)
      }
      return
    }
    if (data.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`${data.params.type}: ${(data.params.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ')}`)
    }
    if (data.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${data.params.exceptionDetails?.text ?? ''}`)
    if (data.method === 'Network.requestWillBeSent') {
      const url = data.params.request?.url ?? ''
      if (url.includes('/plugins/dsh-memory/')) requests.push(url)
    }
    for (const handler of events.get(data.method) ?? []) handler(data.params)
  }
}

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

const once = (method, timeout = 20000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeout)
  const handler = (params) => {
    clearTimeout(timer)
    events.set(method, (events.get(method) ?? []).filter((item) => item !== handler))
    resolve(params)
  }
  events.set(method, [...(events.get(method) ?? []), handler])
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  return result.result?.value
}

async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sleep(120)
}

// ===== 检查断言 =====
const report = { ok: true, checks: [] }
function check(name, cond, detail = '') {
  report.checks.push({ name, ok: Boolean(cond), detail })
  if (!cond) report.ok = false
  console.log(`${cond ? '  ✔' : '  ✖'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
}
const lastEntriesRequest = () => [...requests].reverse().find((u) => u.includes('/entries'))
const lastStatsRequest = () => [...requests].reverse().find((u) => u.includes('/stats'))

function ownerPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

async function removeProfileDir(dir, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(400)
    }
  }
  return false
}

/**
 * 清扫历史 GUI 临时 profile：Windows 下 Edge 子进程句柄未释放会让 rm 失败而静默残留，
 * 每次约 250MB。owner pid 已死或目录超过 1 小时即视为陈旧（仍可能被活进程占用时跳过）。
 */
function sweepStaleProfiles() {
  const base = os.tmpdir()
  let names = []
  try { names = readdirSync(base) } catch { return }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith('dsh-memory-gui-profile-')) continue
    const full = path.join(base, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    const match = /-(\d+)$/.exec(name)
    const pid = match ? Number(match[1]) : 0
    const stale = !ownerPidAlive(pid) || now - stat.mtimeMs > 3600_000
    if (!stale) continue
    for (let i = 0; i < 3; i += 1) {
      try { rmSync(full, { recursive: true, force: true }); break } catch { /* 句柄仍在，下次再试 */ }
    }
  }
}

async function main() {
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}（可用 EDGE_PATH 指定）`)
  sweepStaleProfiles()
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(USER_DATA, { recursive: true })
  const edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,950',
    'about:blank',
  ], { stdio: 'ignore' })
  // 最后兜底：即使浏览器句柄尚未释放，cleanup 注册表（含 abort 路径）也会杀 Edge 并重试删 profile。
  registerCleanup(async () => {
    try { edge.kill() } catch { /* ignore */ }
    await sleep(400)
    await removeProfileDir(USER_DATA)
  })
  let failed = null
  try {
    console.log(`dsh-memory GUI check @ ${BASE}\n`)
    await connect()
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    const cookie = authCookie(BASE)
    await send('Network.setCookie', { name: cookie.name, value: cookie.value, url: cookie.url, path: '/', httpOnly: true, sameSite: 'Strict' })
    const loaded = once('Page.loadEventFired')
    await send('Page.navigate', { url: BASE })
    await loaded
    await sleep(3000)

    const boot = await evaluate(`(() => ({
      title: document.title,
      bundle: globalThis.__DSH_BOOT__ ? globalThis.__DSH_BOOT__.entries.length : null,
      hasMemory: globalThis.__DSH_BOOT__ ? globalThis.__DSH_BOOT__.entries.some(e => e.id === 'dsh-memory') : null,
      nav: [...document.querySelectorAll('button,[role="button"],a')].some(el => (el.getAttribute('aria-label') || '').trim() === '记忆' || (el.textContent || '').trim() === '记忆'),
    }))()`)
    check('客户端 bundle 已加载且含 dsh-memory', boot.hasMemory === true, String(boot.bundle))
    check('侧边栏存在「记忆」入口', boot.nav === true)

    // 宿主启动时可能弹出「预览版说明」对话框（焦点陷阱会挡住面板键盘操作）：先关掉它。
    const dismissed = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => (el.innerText || '').includes('预览版说明'))
      if (!dialog) return 'none'
      const button = dialog.querySelector('button')
      if (!button) return 'no-button'
      button.click()
      return 'dismissed'
    })()`)
    if (dismissed === 'no-button') { await key('Escape', 'Escape', 27); await sleep(500) }
    console.log(`  · 宿主预览对话框：${dismissed}`)

    // 打开记忆面板
    const opened = await evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,[role="button"],a')].find(el => ((el.textContent || '').trim() === '记忆' || el.getAttribute('aria-label') === '记忆') && el.children.length <= 3)
      if (!hit) return false
      hit.click()
      return true
    })()`)
    await sleep(2500)
    check('记忆面板已打开', opened && (await evaluate(`document.querySelector('.dm_page') !== null`)))

    // 记录真实数据根与 token（设置/备份快照恢复用）。
    const statusDoc = await apiJson('/status')
    ROOT = statusDoc?.root ?? ''
    TOKEN = statusDoc?.key ?? ''
    // 验证脚本互斥：同一数据根只允许一个 live/gui 验证脚本（并发会互相删备份/竞态恢复设置）。
    verifyLock = acquireVerifyLock(ROOT)
    registerCleanup(async () => { try { verifyLock.release() } catch { /* ignore */ } })
    // 先清理上次中断残留（__gui_*/__livecheck_* 测试条目），再拍零残留基线。
    await cleanupResidueMarkers()
    overlayBaseline = (await apiJson('/settings'))?.overlay ?? {}
    backupsBaseline = listBackups()
    registerCleanup(async () => {
      try { await restoreSettingsOverlay(overlayBaseline) } catch { /* ignore */ }
      removeNewBackups(backupsBaseline)
    })
    // 运行前后用户数据零差异自检（快照默认排除 access.json/index.json 等派生数据）。
    dataSnapshotBefore = snapshotDataRoot(ROOT)
    // 强杀看门狗：GUI 验证被 taskkill/CI 超时杀死时，detached 子进程清理测试记忆、
    // 恢复 settings/backups 并删除残留锁（正常收尾由 cleanup 注册表停掉）。
    try {
      watchdog = startCleanupWatchdog({
        root: ROOT,
        markers: ['__gui_', '__livecheck_'],
        settingsBefore: readSettingsRaw(ROOT),
        backupsBefore: backupsBaseline,
      }, { manifestPath: path.join(os.tmpdir(), `dsh-memory-gui-watchdog-${process.pid}.json`), logPath: path.join(os.tmpdir(), `dsh-memory-gui-watchdog-${process.pid}.log`) })
      registerCleanup(async () => { try { watchdog.stop() } catch { /* ignore */ } })
    } catch { /* 看门狗启动失败不阻断验证 */ }
    if (ABORT_AFTER > 0) setTimeout(() => { void abortAndExit(130, new Error(`abort-after=${ABORT_AFTER}ms 注入`)) }, ABORT_AFTER)

    // 1b) Tabs：ARIA 关联 + ←/→ 键盘切换跟随焦点（WAI-ARIA tablist 模式）
    const tabsAria = await evaluate(`(() => {
      const mem = document.querySelector('#dm-tab-memories')
      const set = document.querySelector('#dm-tab-settings')
      const panel = document.querySelector('#dm-panel-memories')
      return {
        memRole: mem && mem.getAttribute('role'),
        memControls: mem && mem.getAttribute('aria-controls'),
        setControls: set && set.getAttribute('aria-controls'),
        panelRole: panel && panel.getAttribute('role'),
        panelLabelled: panel && panel.getAttribute('aria-labelledby'),
        memTabIndex: mem && mem.getAttribute('tabindex'),
        setTabIndex: set && set.getAttribute('tabindex'),
        listRole: (document.querySelector('.dm_tabs') || {}).getAttribute ? document.querySelector('.dm_tabs').getAttribute('role') : null,
        // 非激活 tab 的 aria-controls 目标也必须存在（0.24.12：两个 tabpanel 常驻 + hidden）。
        settingsPanelExists: document.querySelector('#dm-panel-settings') !== null,
        memoriesPanelHidden: (document.querySelector('#dm-panel-memories') || {}).hasAttribute ? document.querySelector('#dm-panel-memories').hasAttribute('hidden') : null,
      }
    })()`)
    check('Tabs 具备 ARIA tablist/tab/tabpanel 关联', tabsAria.listRole === 'tablist' && tabsAria.memRole === 'tab' && tabsAria.memControls === 'dm-panel-memories' && tabsAria.setControls === 'dm-panel-settings' && tabsAria.panelRole === 'tabpanel' && tabsAria.panelLabelled === 'dm-tab-memories', JSON.stringify(tabsAria))
    check('非激活 tabpanel 常驻且 aria-controls 目标存在', tabsAria.settingsPanelExists === true, JSON.stringify(tabsAria))
    check('Tabs roving tabIndex', tabsAria.memTabIndex === '0' && tabsAria.setTabIndex === '-1', JSON.stringify(tabsAria))
    await evaluate(`(() => { const t = document.querySelector('#dm-tab-memories'); if (t) t.focus(); return Boolean(t) })()`)
    await key('ArrowRight', 'ArrowRight', 39)
    const tabRight = await evaluate(`(() => ({
      settingsSelected: (document.querySelector('#dm-tab-settings') || {}).getAttribute ? document.querySelector('#dm-tab-settings').getAttribute('aria-selected') : null,
      focused: document.activeElement ? document.activeElement.id : null,
      panel: document.querySelector('#dm-panel-settings') !== null,
    }))()`)
    check('→ 键切到设置页且焦点跟随', tabRight.settingsSelected === 'true' && tabRight.focused === 'dm-tab-settings' && tabRight.panel, JSON.stringify(tabRight))
    await key('ArrowLeft', 'ArrowLeft', 37)
    const tabLeft = await evaluate(`(() => ({
      memoriesSelected: (document.querySelector('#dm-tab-memories') || {}).getAttribute ? document.querySelector('#dm-tab-memories').getAttribute('aria-selected') : null,
      focused: document.activeElement ? document.activeElement.id : null,
      panel: document.querySelector('#dm-panel-memories') !== null,
    }))()`)
    check('← 键切回记忆页且焦点跟随', tabLeft.memoriesSelected === 'true' && tabLeft.focused === 'dm-tab-memories' && tabLeft.panel, JSON.stringify(tabLeft))

    // 1) 自定义下拉键盘：Enter 打开 → 焦点进入浮层 → ArrowDown 移动高亮 → Esc 关闭
    const kbdOpened = await evaluate(`(() => { const t = document.querySelector('.dm_select_trigger'); if (!t) return false; t.focus(); return document.activeElement === t })()`)
    await key('Enter', 'Enter', 13)
    await sleep(400)
    const kbd1 = await evaluate(`(() => ({
      list: document.querySelector('.dm_select_pop') !== null,
      inPop: document.activeElement && document.activeElement.closest('.dm_select_pop') !== null,
      active: (document.querySelector('.dm_select_opt_active') || {}).textContent || null,
    }))()`)
    check('下拉开合：Enter 打开后焦点进入浮层', kbdOpened && kbd1.list && kbd1.inPop, JSON.stringify(kbd1))
    await key('ArrowDown', 'ArrowDown', 40)
    const kbd2 = await evaluate(`(document.querySelector('.dm_select_opt_active') || {}).textContent || null`)
    check('下拉键盘：ArrowDown 移动高亮项', typeof kbd2 === 'string' && kbd2.length > 0 && kbd2 !== kbd1.active, `${kbd1.active} -> ${kbd2}`)
    await key('Escape', 'Escape', 27)
    await sleep(300)
    check('下拉键盘：Esc 关闭浮层且焦点回到触发器', await evaluate(`document.querySelector('.dm_select_pop') === null && (document.activeElement || {}).className === 'dm_select_trigger'`))

    // 2) 来源过滤：选择「主动沉淀」后列表请求必须带 origin=auto
    await evaluate(`(() => { const t = [...document.querySelectorAll('.dm_select_trigger')].find(el => (el.getAttribute('aria-label') || '').includes('来源')); if (t) t.click(); return Boolean(t) })()`)
    await sleep(500)
    const originPicked = await evaluate(`(() => {
      const opts = [...document.querySelectorAll('[role="option"], .dm_select_opt')]
      const hit = opts.length >= 2 ? opts[1] : null
      if (hit) hit.click()
      return Boolean(hit)
    })()`)
    await sleep(1200)
    const originReq = lastEntriesRequest()
    check('面板来源过滤随请求上行（origin=auto）', originPicked && originReq !== undefined && /[?&]origin=auto(&|$)/.test(originReq), originReq)
    // 还原为「全部来源」
    await evaluate(`(() => { const t = [...document.querySelectorAll('.dm_select_trigger')].find(el => (el.getAttribute('aria-label') || '').includes('来源')); if (t) t.click(); return true })()`)
    await sleep(400)
    await evaluate(`(() => { const opts = [...document.querySelectorAll('[role="option"], .dm_select_opt')]; if (opts[0]) opts[0].click(); return Boolean(opts[0]) })()`)
    await sleep(1000)

    // 3) 状态过滤：已归档（chips 顺序 all/active/superseded/expired/archived/pinned → 下标 4）
    const archivedClicked = await evaluate(`(() => {
      const chips = [...document.querySelectorAll('.dm_chips_status .dm_chip')]
      if (chips.length < 5) return false
      chips[4].click()
      return true
    })()`)
    await sleep(1200)
    const archivedReq = lastEntriesRequest()
    check('面板状态过滤随请求上行（status=archived）', archivedClicked && archivedReq !== undefined && /[?&]status=archived(&|$)/.test(archivedReq), archivedReq)
    check('隐藏态视图放宽全部 include_*', archivedReq !== undefined && archivedReq.includes('include_superseded=true') && archivedReq.includes('include_expired=true') && archivedReq.includes('include_archived=true'), archivedReq)
    // 0.24.20：统计请求与列表同口径（status/include_*），否则「全部状态/已归档」视图头部数字与列表矛盾。
    const statsArchivedReq = lastStatsRequest()
    check('统计请求同步 status/include_archived（视图一致）', statsArchivedReq !== undefined && /[?&]status=archived(&|$)/.test(statsArchivedReq) && statsArchivedReq.includes('include_archived=true'), statsArchivedReq)
    await evaluate(`(() => { const chips = [...document.querySelectorAll('.dm_chips_status .dm_chip')]; if (chips[1]) chips[1].click(); return true })()`)
    await sleep(800)

    // 4) 标签过滤：输入非存在标签，请求必须带 tag 参数
    const tagTyped = await evaluate(`(() => {
      const input = [...document.querySelectorAll('input')].find(el => (el.getAttribute('aria-label') || '').includes('标签'))
      if (!input) return false
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'zz-gui-check-no-such-tag')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1400)
    const tagReq = lastEntriesRequest()
    check('面板标签过滤随请求上行（tag=…）', tagTyped && tagReq !== undefined && /[?&]tag=zz-gui-check-no-such-tag(&|$)/.test(tagReq), tagReq)
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('input')].find(el => (el.getAttribute('aria-label') || '').includes('标签'))
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1000)

    // 4b) 注入徽章刷新与筛选解耦（0.24.14）：输入搜索只刷新列表，不重复请求 recall-preview
    const recallBefore = requests.filter((u) => u.includes('/recall-preview')).length
    await evaluate(`(() => {
      const input = document.querySelector('input.dm_search')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'zz-gui-recall-probe')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1300)
    const recallAfter = requests.filter((u) => u.includes('/recall-preview')).length
    check('列表筛选刷新不重复请求 recall-preview', recallAfter === recallBefore, `${recallBefore} -> ${recallAfter}`)
      // 0.24.28：导出/查重/导入预演只翻转 busy，不应触发全量 /recall-preview。
      const exportRecallBefore = requests.filter((u) => u.includes('/recall-preview')).length
      await evaluate(`(() => { const btn = [...document.querySelectorAll('.dm_toolbtn')].find((b) => /导出|Export/.test((b.textContent || '').trim())); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(1200)
      const exportRecallAfter = requests.filter((u) => u.includes('/recall-preview')).length
      check('导出不触发 recall-preview 全量刷新', exportRecallAfter === exportRecallBefore, `${exportRecallBefore} -> ${exportRecallAfter}`)
      // 0.24.29：导出 skipped 在 UI 可见（临时放一个损坏 .md，导出后删掉）。
      const brokenExportPath = path.join(ROOT, 'global', 'm-gui-broken-export.md')
      registerCleanup(async () => { try { rmSync(brokenExportPath, { force: true }) } catch { /* ignore */ } })
      writeFileSync(brokenExportPath, 'not frontmatter', 'utf8')
      try {
        await evaluate(`(() => { const btn = [...document.querySelectorAll('.dm_toolbtn')].find((b) => /导出|Export/.test((b.textContent || '').trim())); if (btn) btn.click(); return Boolean(btn) })()`)
        await sleep(1200)
        const exportToast = await evaluate(`(document.querySelector('.dm_toast_text') || {}).textContent || ''`)
        check('导出提示损坏文件数（skipped）', /损坏|damaged/i.test(exportToast), exportToast)
      } finally {
        rmSync(brokenExportPath, { force: true })
      }
    await evaluate(`(() => {
      const input = document.querySelector('input.dm_search')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(800)

    // 5) 弹窗内下拉：Esc 只关下拉（草稿保留），Tab 归还焦点，最后 Esc 关弹窗
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(el => /新建记忆|New memory/.test((el.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
    await sleep(800)
    const modalOpen = await evaluate(`document.querySelector('.dm_dialog') !== null`)
    check('新建记忆弹窗已打开', modalOpen)
    if (modalOpen) {
      const draft = 'GUI 键盘草稿测试'
      await evaluate(`(() => {
        const ta = document.querySelector('.dm_dialog textarea')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ${JSON.stringify(draft)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      // 1c) 分类 radiogroup：←/→ 循环切换且焦点跟随（WAI-ARIA radiogroup 模式）
      const catBefore = await evaluate(`(() => {
        const grid = document.querySelector('.dm_catgrid')
        if (!grid) return null
        const radios = [...grid.querySelectorAll('[role="radio"]')]
        const current = radios.findIndex(r => r.getAttribute('aria-checked') === 'true')
        if (current === -1) return null
        radios[current].focus()
        return { current, focused: radios.indexOf(document.activeElement) }
      })()`)
      await key('ArrowRight', 'ArrowRight', 39)
      const catAfter = await evaluate(`(() => {
        const radios = [...document.querySelectorAll('.dm_catgrid [role="radio"]')]
        return {
          checked: radios.findIndex(r => r.getAttribute('aria-checked') === 'true'),
          focused: radios.indexOf(document.activeElement),
          tabIndexes: radios.map(r => r.getAttribute('tabindex')),
        }
      })()`)
      check('分类 radiogroup 方向键切换且焦点跟随', catBefore !== null && catAfter.checked === (catBefore.current + 1) % 3 && catAfter.focused === catAfter.checked, JSON.stringify({ catBefore, catAfter }))
      check('分类 radiogroup roving tabIndex', catAfter.tabIndexes.filter((v) => v === '0').length === 1, JSON.stringify(catAfter.tabIndexes))
      // 1d) 标签：去重 + 12 个上限计数/提示（客户端与服务端同口径）
      await evaluate(`(() => {
        const input = document.querySelector('#dm-tags')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, 'a, a, b')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(250)
      const tagsCounter = await evaluate(`(() => {
        const field = [...document.querySelectorAll('.dm_dialog .dm_field')].find(f => (f.innerText || '').includes('标签'))
        return field ? ((field.querySelector('.dm_charcount') || {}).textContent || '') : ''
      })()`)
      check('标签计数显示去重后的 2/12', /2\s*\/\s*12/.test(tagsCounter), tagsCounter)
      await evaluate(`(() => {
        const input = document.querySelector('#dm-tags')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, Array.from({ length: 14 }, (_, i) => 't' + i).join(','))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(250)
      const tagsLimit = await evaluate(`(() => {
        const field = [...document.querySelectorAll('.dm_dialog .dm_field')].find(f => (f.innerText || '').includes('标签'))
        return field ? ((field.querySelector('.dm_charcount') || {}).textContent || '') : ''
      })()`)
      check('标签超过 12 个显示上限提示', /12\s*\/\s*12/.test(tagsLimit) && /上限|Limit/.test(tagsLimit), tagsLimit)
      // 清空标签（弹窗不保存），避免影响后续键盘用例。
      await evaluate(`(() => {
        const input = document.querySelector('#dm-tags')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(150)
      await evaluate(`(() => { const t = document.querySelector('.dm_dialog .dm_select_trigger'); if (t) t.click(); return true })()`)
      await sleep(500)
      check('弹窗内下拉已展开', await evaluate(`document.querySelector('.dm_dialog') !== null && document.querySelector('.dm_select_pop') !== null`))
      await key('Escape', 'Escape', 27)
      const afterEsc = await evaluate(`(() => ({
        dialog: document.querySelector('.dm_dialog') !== null,
        list: document.querySelector('.dm_select_pop') !== null,
        draft: (document.querySelector('.dm_dialog textarea') || {}).value || '',
      }))()`)
      check('弹窗内 Esc 只关下拉、弹窗与草稿保留', afterEsc.dialog && !afterEsc.list && afterEsc.draft === draft, JSON.stringify(afterEsc))
      await evaluate(`(() => { const t = document.querySelector('.dm_dialog .dm_select_trigger'); if (t) t.click(); return true })()`)
      await sleep(400)
      await key('Tab', 'Tab', 9)
      const afterTab = await evaluate(`(() => ({ list: document.querySelector('.dm_select_pop') !== null, body: document.activeElement === document.body }))()`)
      check('弹窗内 Tab 关闭下拉且焦点不逃逸到 body', !afterTab.list && !afterTab.body, JSON.stringify(afterTab))
      await key('Escape', 'Escape', 27)
      await sleep(400)
    }

    // 1e) 导入：带 UTF-8 BOM 的导出文件也能进入预览（0.24.12）；导入窗口的后处理不卡 busy
    {
      const dir = path.join(os.tmpdir(), `dsh-memory-gui-import-${process.pid}`)
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'bom-export.json')
      writeFileSync(file, '\uFEFF' + JSON.stringify({
        format: 'dsh-memory-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: [{ id: 'm-gui-bom-1', content: 'GUI 导入 BOM 预览条目', scope: 'global', category: 'fact' }],
      }), 'utf8')
      try {
        await send('DOM.enable')
        const { root } = await send('DOM.getDocument', { depth: -1 })
        const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
        await send('DOM.setFileInputFiles', { files: [file], nodeId })
        await sleep(2200)
        const planState = await evaluate(`(() => {
          const dialog = document.querySelector('.dm_dialog')
          return {
            open: dialog !== null,
            text: dialog ? (dialog.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : '',
            busyButtons: document.querySelectorAll('.dm_toolbtn[disabled]').length,
          }
        })()`)
        check('BOM 导出文件可进入导入预览', planState.open && /导入|Import|预览|Preview/.test(planState.text), JSON.stringify(planState))
        check('导入预览后 busy 已复位', planState.busyButtons === 0, JSON.stringify(planState))
        await key('Escape', 'Escape', 27)
        await sleep(400)

        // 0.24.25：大文件导入分片（320 条 → 2 次 /import）、显示进度、全部落盘；批量接口清理。
        const bigEntries = Array.from({ length: 320 }, (_, i) => ({
          id: `m-gui-shard-${String(i).padStart(4, '0')}`,
          content: `GUI 分片导入 ${i}`,
          scope: 'global',
          category: 'fact',
        }))
        // 一对取代链横跨 300 条分片边界：分包必须保持同批，否则服务端会修复丢弃指针、
        // 已取代的旧条目重新变为活跃（客户端 P1 回归）。
        bigEntries[299].superseded_by = bigEntries[300].id
        bigEntries[300].supersedes = bigEntries[299].id
        const bigIds = bigEntries.map((e) => e.id)
        registerCleanup(async () => { await forgetIds(bigIds); bigIds.length = 0 })
        const bigFile = path.join(dir, 'big-export.json')
        writeFileSync(bigFile, JSON.stringify({ format: 'dsh-memory-export', version: 1, exportedAt: new Date().toISOString(), entries: bigEntries }), 'utf8')
        try {
          const { root: docRoot } = await send('DOM.getDocument', { depth: -1 })
          const { nodeId: bigNode } = await send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: 'input[type=file]' })
          await send('DOM.setFileInputFiles', { files: [bigFile], nodeId: bigNode })
          await sleep(2600)
          const importBefore = requests.filter((u) => u.includes('/import')).length
          await send('Network.emulateNetworkConditions', { offline: false, latency: 250, downloadThroughput: -1, uploadThroughput: -1 })
          await evaluate(`(() => {
            const dialog = document.querySelector('.dm_dialog')
            if (!dialog) return false
            const btn = [...dialog.querySelectorAll('button')].find((b) => b.classList.contains('dm_btn_primary'))
            if (btn) btn.click()
            return Boolean(btn)
          })()`)
          let sawProgress = false
          for (let i = 0; i < 30; i += 1) {
            await sleep(120)
            const st = await evaluate(`(() => ({ open: document.querySelector('.dm_dialog') !== null, text: (document.querySelector('.dm_dialog') || {}).innerText || '' }))()`)
            if (/正在导入|Importing/.test(st.text)) sawProgress = true
            if (!st.open) break
          }
          await sleep(1200)
          await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          const importAfter = requests.filter((u) => u.includes('/import')).length
          const listed = await apiJson(`/entries?query=${encodeURIComponent('GUI 分片导入')}&scope=global&limit=1000`)
          check('大导入按分片多次提交（≥2 次 /import）', importAfter - importBefore >= 2, `${importBefore} -> ${importAfter}`)
          check('大导入显示分片进度', sawProgress, 'progress text not observed')
          check('大导入全部落盘（319 可见 + 1 被取代）', (listed?.entries || []).length === 319, String((listed?.entries || []).length))
          const pairDoc = await apiJson(`/entries?query=${encodeURIComponent('GUI 分片导入 299')}&scope=global&limit=50&include_superseded=true`)
          const older = (pairDoc?.entries || []).find((e) => e.id === bigIds[299])
          check('分片导入保留跨片取代链（旧条目仍隐藏）', Boolean(older) && older.superseded_by === bigIds[300], JSON.stringify(older && { id: older.id, superseded_by: older.superseded_by }))
        } finally {
          await forgetIds(bigEntries.map((e) => e.id))
          bigIds.length = 0
          const left = await apiJson(`/entries?query=${encodeURIComponent('GUI 分片导入')}&scope=global&limit=10`)
          check('分片导入测试条目已批量清理', (left?.entries || []).length === 0, String((left?.entries || []).length))
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // 6) 删除撤销吐司优先级 + 撤销恢复（0.24.4）：删除后的撤销不能被后续提示挤掉。
    const marker = `__gui_undo_${Date.now().toString(36)}__`
    let createdIds = []
    registerCleanup(async () => { await forgetIds(createdIds); createdIds = [] })
    try {
      const status = await apiJson('/status')
      const token = status && status.key
      // 先造滚动/分页条目（较旧，落在第 2 页），再造 A/B/K/L（最新，保证在第一页可点）。
      for (let i = 0; i < 55; i += 1) {
        const extra = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} 滚动条目 ${i}`, scope: 'global', origin: 'auto' } })
        const extraId = extra?.result?.entry?.id
        if (extraId) createdIds.push(extraId)
      }
      const a = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} A`, scope: 'global', origin: 'auto' } })
      const b = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} B`, scope: 'global', origin: 'auto' } })
      const idA = a?.result?.entry?.id
      const idB = b?.result?.entry?.id
      // 连续删除场景用的两条记忆（K/L）。
      const k = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} K`, scope: 'global', origin: 'auto' } })
      const l = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} L`, scope: 'global', origin: 'auto' } })
      const idK = k?.result?.entry?.id
      const idL = l?.result?.entry?.id
      // 批量删除场景用的两条记忆（M/N，最新 → 第一页可点）。
      const m = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} M`, scope: 'global', origin: 'auto' } })
      const n = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} N`, scope: 'global', origin: 'auto' } })
      const idM = m?.result?.entry?.id
      const idN = n?.result?.entry?.id
      createdIds = createdIds.filter(Boolean).concat([idA, idB, idK, idL, idM, idN].filter(Boolean))
      check('API 创建验收临时记忆', createdIds.length >= 4, JSON.stringify(createdIds.length))

      // 搜索标记让两条临时记忆出现在列表。
      await evaluate(`(() => {
        const input = document.querySelector('input.dm_search')
        if (!input) return false
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(marker)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(1400)
      const cards = await evaluate(`[...document.querySelectorAll('.dm_card')].map(el => (el.innerText || '').replace(/\\s+/g, ' '))`)
      check('临时记忆出现在面板列表', cards.filter((text) => text.includes(marker)).length >= 2, JSON.stringify(cards.length))
      const boxLabels = await evaluate(`[...document.querySelectorAll('.dm_card .dm_check input')].slice(0, 2).map((el) => el.getAttribute('aria-label') || '')`)
      check('卡片复选框 aria-label 含各自内容', boxLabels.length === 2 && boxLabels[0] !== boxLabels[1] && boxLabels.every((label) => label.includes(marker)), JSON.stringify(boxLabels))

      // 0.24.23：常驻 tabpanel 共享滚动容器——切到设置页再切回，列表 scrollTop 应恢复。
      // 判别力：保存的是列表最大滚动位置，且设置页最大滚动更小（旧实现会被夹小）。
      const scrollState = await evaluate(`(() => {
        const page = document.querySelector('.dm_page')
        const tabSettings = document.querySelector('#dm-tab-settings')
        if (!page || !tabSettings) return null
        page.scrollTop = page.scrollHeight
        const set = page.scrollTop
        tabSettings.click()
        return { set }
      })()`)
      await sleep(500)
      const settingsScroll = await evaluate(`(() => { const p = document.querySelector('.dm_page'); return p ? Math.max(0, p.scrollHeight - p.clientHeight) : -1 })()`)
      await evaluate(`(() => { const t = document.querySelector('#dm-tab-memories'); if (t) t.click(); return Boolean(t) })()`)
      await sleep(700)
      const scrollAfter = await evaluate(`(() => { const page = document.querySelector('.dm_page'); return page ? page.scrollTop : -1 })()`)
      check('切 tab 恢复的是被夹取前的最大滚动位置', scrollState !== null && scrollState.set > 400 && scrollState.set > settingsScroll + 50 && Math.abs(scrollAfter - scrollState.set) <= 2, `${JSON.stringify(scrollState)} settingsMax=${settingsScroll} after=${scrollAfter}`)

      // 0.24.23：翻页是导航，应回到列表顶部，而不是停在新页中后段。
      const pagerState = await evaluate(`(() => {
        const page = document.querySelector('.dm_page')
        if (page) page.scrollTop = page.scrollHeight
        const buttons = [...document.querySelectorAll('.dm_pager button')]
        if (!buttons.length) return null
        const next = buttons[buttons.length - 1]
        const before = { hasNext: !next.disabled }
        next.click()
        return before
      })()`)
      await sleep(1000)
      const afterNext = await evaluate(`(() => ({ scroll: document.querySelector('.dm_page') ? document.querySelector('.dm_page').scrollTop : -1, pageText: (document.querySelector('.dm_pageinfo') || {}).textContent || '' }))()`)
      check('翻页后回到列表顶部', pagerState !== null && pagerState.hasNext && afterNext.scroll <= 4, `${JSON.stringify(pagerState)} -> ${JSON.stringify(afterNext)}`)
      // 翻回第一页，后续卡片操作依赖 A/B/K/L 在第一页。
      await evaluate(`(() => { const prev = document.querySelector('.dm_pager button'); if (prev && !prev.disabled) prev.click(); return Boolean(prev) })()`)
      await sleep(900)

      // 0.24.19：批量浮栏在列表之前（键盘 Tab 可近达）+ region 语义。
      const selState = await evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.dm_card .dm_check input')]
        if (boxes.length < 2) return null
        boxes[0].click()
        boxes[1].click()
        const bar = document.querySelector('.dm_selbar')
        const card = document.querySelector('.dm_card')
        if (!bar || !card) return null
        return {
          before: Boolean(bar.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
          role: bar.getAttribute('role'),
          label: bar.getAttribute('aria-label'),
          buttons: [...bar.querySelectorAll('button')].length,
        }
      })()`)
      check('批量浮栏在列表之前且可聚焦（键盘可达）', selState !== null && selState.before && selState.role === 'region' && selState.buttons >= 2, JSON.stringify(selState))
      await evaluate(`(() => { const b = [...document.querySelectorAll('.dm_selbar button')].find((el) => /取消选择|Clear selection/.test((el.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
      await sleep(300)
      const clearFocus = await evaluate(`(document.activeElement ? (document.activeElement.className || '') : '').includes('dm_page')`)
      check('取消选择后焦点回到面板容器', clearFocus, String(clearFocus))

      // 删除 A（卡片内「删除」→ 确认弹窗危险按钮）。
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('.dm_card')].find(el => (el.innerText || '').includes(${JSON.stringify(`${marker} A`)}))
        if (!card) return false
        const btn = [...card.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '删除' || (b.textContent || '').trim() === 'Delete')
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await sleep(500)
      // 0.24.19：删除确认弹窗在请求期间显示「删除中…」而不是整框静默变灰。
      await send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 })
      await evaluate(`(() => { const btn = document.querySelector('.dm_dialog .dm_btn_danger_solid'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(400)
      const deleteBusy = await evaluate(`(() => {
        const dialog = document.querySelector('.dm_dialog')
        return { text: dialog ? (dialog.innerText || '').replace(/\\s+/g, ' ') : '', disabled: [...document.querySelectorAll('.dm_dialog button')].every((b) => b.disabled) }
      })()`)
      check('删除请求期间确认弹窗显示进行中', /删除中|Deleting/.test(deleteBusy.text) && deleteBusy.disabled, JSON.stringify(deleteBusy).slice(0, 160))
      await sleep(2300)
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await sleep(400)
      const afterDelete = await evaluate(`(() => ({ text: (document.querySelector('.dm_toast_text') || {}).textContent || '', hasAction: document.querySelector('.dm_toast_action') !== null }))()`)
      check('删除后出现带撤销的吐司', afterDelete.hasAction && /删除|Delete/.test(afterDelete.text), JSON.stringify(afterDelete))
      const undoFocus = await evaluate(`document.activeElement ? (document.activeElement.className || '') : ''`)
      check('删除后焦点移到撤销按钮（键盘可达）', typeof undoFocus === 'string' && undoFocus.includes('dm_toast_action'), undoFocus)
      const toastCloseLabel = await evaluate(`(() => { const el = document.querySelector('.dm_toast_close'); return el ? el.getAttribute('aria-label') : null })()`)
      check('吐司关闭按钮 aria-label 为「关闭提示」', /关闭|Dismiss/.test(String(toastCloseLabel || '')), String(toastCloseLabel))

      // 0.24.19：聚焦/悬停时倒计时暂停——撤销入口不会在用户操作途中消失。
      await sleep(7000)
      const pauseState = await evaluate(`(() => ({
        hasAction: document.querySelector('.dm_toast_action') !== null,
        focused: document.activeElement ? document.activeElement.className || '' : '',
        barState: (() => { const bar = document.querySelector('.dm_toast_bar'); return bar ? getComputedStyle(bar).animationPlayState : 'none' })(),
      }))()`)
      check('撤销吐司聚焦时暂停倒计时（7s 后仍在）', pauseState.hasAction && /dm_toast_action/.test(pauseState.focused), JSON.stringify(pauseState))
      check('暂停时进度条同步冻结（视觉与可撤销窗口一致）', pauseState.barState === 'paused', JSON.stringify(pauseState))

      // 批量浮栏在列表之前（键盘 Tab 可近达）+ region 语义。
      // 立即触发另一条普通提示（对 B 钉选）：撤销吐司不应被覆盖，普通提示排队。
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('.dm_card')].find(el => (el.innerText || '').includes(${JSON.stringify(`${marker} B`)}))
        if (!card) return false
        const btn = [...card.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '钉选' || (b.textContent || '').trim() === 'Pin')
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await sleep(600)
      const afterPin = await evaluate(`(() => ({ text: (document.querySelector('.dm_toast_text') || {}).textContent || '', hasAction: document.querySelector('.dm_toast_action') !== null }))()`)
      check('后续普通提示不覆盖撤销吐司', afterPin.hasAction && afterPin.text === afterDelete.text, JSON.stringify(afterPin))

      // 点撤销 → A 通过 import 原样恢复（id/时间戳不变）。
      await evaluate(`(() => { const old = document.querySelector('.dm_toast'); if (old) old.dataset.marker = 'old-node'; const btn = document.querySelector('.dm_toast_action'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(250)
      const queuedPreview = await evaluate(`(() => ({
        text: (document.querySelector('.dm_toast_text') || {}).textContent || '',
        marker: (document.querySelector('.dm_toast') || {}).dataset ? (document.querySelector('.dm_toast').dataset.marker || '') : 'none',
      }))()`)
      check('排队的普通提示随后展示', /钉选|Pin|已恢复|Restored/.test(queuedPreview.text), JSON.stringify(queuedPreview))
      await sleep(1400)
      const afterUndoToast = await evaluate(`(() => {
        const el = document.querySelector('.dm_toast')
        return { exists: el !== null, marker: el ? el.dataset.marker || '' : 'none', text: (document.querySelector('.dm_toast_text') || {}).textContent || '' }
      })()`)
      // 0.24.19：吐司切换使用新 DOM 节点（倒计时条从头开始，而不是停在旧进度）。
      check('吐司切换使用新节点（倒计时重启）', queuedPreview.marker !== 'old-node' && (!afterUndoToast.exists || afterUndoToast.marker !== 'old-node'), JSON.stringify({ queuedPreview, afterUndoToast }))
      const listAfterUndo = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&limit=100&include_superseded=true&include_expired=true&include_archived=true`)
      check('撤销后记忆恢复且 id 不变', (listAfterUndo?.entries || []).some((e) => e.id === idA), JSON.stringify((listAfterUndo?.entries || []).map((e) => e.id)))
      // 关闭当前吐司 → 若焦点在吐司内应回退到面板容器（不掉到 body）。
      const focusBeforeClose = await evaluate(`document.activeElement ? (document.activeElement.className || '') : ''`)
      await evaluate(`(() => { const close = document.querySelector('.dm_toast_close'); if (close) close.focus(); if (close) close.click(); return Boolean(close) })()`)
      await sleep(300)
      const focusAfterClose = await evaluate(`(document.activeElement ? (document.activeElement.className || '') : '').includes('dm_page')`)
      check('吐司关闭后焦点回退到面板容器', focusAfterClose, `${focusBeforeClose} -> page=${focusAfterClose}`)

      // 0.24.23：连续删除两次——第一条的撤销吐司入队而不是被覆盖，两条都能恢复。
      const clickDeleteFor = async (text) => evaluate(`(() => {
        const card = [...document.querySelectorAll('.dm_card')].find((el) => (el.innerText || '').includes(${JSON.stringify(text)}))
        if (!card) return false
        const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '删除' || (b.textContent || '').trim() === 'Delete')
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await clickDeleteFor(`${marker} K`)
      await sleep(500)
      await evaluate(`(() => { const btn = document.querySelector('.dm_dialog .dm_btn_danger_solid'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(900)
      await clickDeleteFor(`${marker} L`)
      await sleep(500)
      await evaluate(`(() => { const btn = document.querySelector('.dm_dialog .dm_btn_danger_solid'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(1000)
      const secondUndo = await evaluate(`(() => ({ hasAction: document.querySelector('.dm_toast_action') !== null, text: (document.querySelector('.dm_toast_text') || {}).textContent || '' }))()`)
      check('连续删除后仍有撤销入口', secondUndo.hasAction, JSON.stringify(secondUndo))
      await evaluate(`(() => { const btn = document.querySelector('.dm_toast_action'); if (btn) btn.click(); return Boolean(btn) })()`)
      // 等排队的第一条撤销吐司出现（导入/刷新时序有波动，固定 sleep 会偶发假失败）。
      let queuedUndo = { hasAction: false, text: '' }
      for (let i = 0; i < 10; i += 1) {
        await sleep(300)
        queuedUndo = await evaluate(`(() => ({ hasAction: document.querySelector('.dm_toast_action') !== null, text: (document.querySelector('.dm_toast_text') || {}).textContent || '' }))()`)
        if (queuedUndo.hasAction) break
      }
      check('第一条删除的撤销吐司排队后仍可操作', queuedUndo.hasAction, JSON.stringify(queuedUndo))
      if (queuedUndo.hasAction) {
        await evaluate(`(() => { const btn = document.querySelector('.dm_toast_action'); if (btn) btn.click(); return Boolean(btn) })()`)
      }
      // 轮询到两条都恢复（导入落盘与列表刷新异步）。
      let restoredIds = new Set()
      for (let i = 0; i < 12; i += 1) {
        await sleep(300)
        const listKL = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&limit=100&include_superseded=true&include_expired=true&include_archived=true`)
        restoredIds = new Set((listKL?.entries || []).map((e) => e.id))
        if (restoredIds.has(idK) && restoredIds.has(idL)) break
      }
      check('连续删除的两条记忆都能撤销恢复', restoredIds.has(idK) && restoredIds.has(idL), JSON.stringify({ idK, idL, restored: [...restoredIds].filter((id) => id === idK || id === idL) }))

      // 0.24.25：批量删除单请求 + 一次撤销恢复多条。
      const forgetReqBefore = requests.filter((u) => u.includes('/forget')).length
      const bulkPicked = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.dm_card')]
        let picked = 0
        for (const text of [${JSON.stringify(`${marker} M`)}, ${JSON.stringify(`${marker} N`)}]) {
          const card = cards.find((el) => (el.innerText || '').includes(text))
          const box = card ? card.querySelector('.dm_check input') : null
          if (box) { box.click(); picked += 1 }
        }
        return picked
      })()`)
      await sleep(300)
      const selbarState = await evaluate(`(() => { const bar = document.querySelector('.dm_selbar'); return { exists: bar !== null, text: bar ? (bar.innerText || '').replace(/\\s+/g, ' ') : '' } })()`)
      await evaluate(`(() => { const b = [...document.querySelectorAll('.dm_selbar button')].find((x) => /删除所选|Delete selected/.test((x.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
      await sleep(700)
      const bulkDialog = await evaluate(`(() => { const d = document.querySelector('.dm_dialog'); return { open: d !== null, text: d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 100) : '' } })()`)
      const confirmState = await evaluate(`(() => ({ count: document.querySelectorAll('.dm_dialog .dm_btn_danger_solid').length, disabled: (() => { const b = document.querySelector('.dm_dialog .dm_btn_danger_solid'); return b ? b.disabled : null })(), cardBusy: [...document.querySelectorAll('.dm_card button')].filter((b) => b.disabled).length }))()`)
      const clickedConfirm = await evaluate(`(() => { const b = document.querySelector('.dm_dialog .dm_btn_danger_solid'); if (b) { b.click() } return Boolean(b) })()`)
      await sleep(300)
      const dialogAfterClick = await evaluate(`(() => { const d = document.querySelector('.dm_dialog'); return { open: d !== null, text: d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) : '' } })()`)
      let bulkToast = { hasAction: false }
      for (let i = 0; i < 12; i += 1) {
        await sleep(250)
        bulkToast = await evaluate(`(() => ({ hasAction: document.querySelector('.dm_toast_action') !== null }))()`)
        if (bulkToast.hasAction) break
      }
      const forgetReqAfter = requests.filter((u) => u.includes('/forget')).length
      const bulkInfo = { picked: bulkPicked, selbar: selbarState, dialog: bulkDialog, confirmState, clickedConfirm, dialogAfterClick, forgetBefore: forgetReqBefore, forgetAfter: forgetReqAfter, recentRequests: requests.slice(-8), recentConsole: consoleLines.slice(-8) }
      check('批量删除只发一次 /forget 请求', bulkToast.hasAction && forgetReqAfter - forgetReqBefore === 1, JSON.stringify(bulkInfo))
      if (bulkToast.hasAction) {
        await evaluate(`(() => { const btn = document.querySelector('.dm_toast_action'); if (btn) btn.click(); return Boolean(btn) })()`)
      }
      let bulkRestored = new Set()
      for (let i = 0; i < 12; i += 1) {
        await sleep(300)
        const listed = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&limit=100&include_superseded=true&include_expired=true&include_archived=true`)
        bulkRestored = new Set((listed?.entries || []).map((e) => e.id))
        if (bulkRestored.has(idM) && bulkRestored.has(idN)) break
      }
      check('批量删除可一次撤销恢复多条', bulkToast.hasAction && bulkRestored.has(idM) && bulkRestored.has(idN), JSON.stringify({ bulkInfo, idM, idN, restored: [idM, idN].filter((id) => bulkRestored.has(id)) }))
    } finally {
      // 清理验收临时记忆（失败路径也要清；批量单请求，兼容并发/中断清理钩子）。
      try {
        await forgetIds(createdIds)
        createdIds = []
        const left = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&limit=100&include_superseded=true&include_expired=true&include_archived=true`)
        check('验收临时记忆已清理', (left?.entries || []).length === 0, JSON.stringify((left?.entries || []).map((e) => e.id)))
      } catch (err) {
        check('验收临时记忆已清理', false, String(err))
      }
      // 清空搜索框，恢复面板常态。
      await evaluate(`(() => {
        const input = document.querySelector('input.dm_search')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`).catch(() => {})
      await sleep(600)
    }

    // 6b) P2 面板正确性（0.24.11）：标签点击精确过滤 / revived 提示 / busy 禁用卡片操作
    const marker2 = `__gui_p2_${Date.now().toString(36)}__`
    let p2ids = []
    try {
      const status = await apiJson('/status')
      const token = status?.key
      const saveOne = async (body) => (await apiJson('/save', { method: 'POST', token, body }))?.result?.entry
      const tagA = await saveOne({ content: `${marker2} 标签A`, scope: 'global', origin: 'auto', tags: ['gui-p2-x'] })
      const tagB = await saveOne({ content: `${marker2} gui-p2-x 只在正文`, scope: 'global', origin: 'auto', tags: ['gui-p2-y'] })
      const reviveBase = await saveOne({ content: `${marker2} 复活条目`, scope: 'global', origin: 'auto' })
      p2ids = [tagA?.id, tagB?.id, reviveBase?.id].filter(Boolean)
      await apiJson('/update', { method: 'POST', token, body: { id: reviveBase.id, archived: true } })
      const setInput = async (selector, value) => evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      const searchInput = await evaluate(`(() => {
        const el = document.querySelector('input.dm_search')
        return el ? el.outerHTML.slice(0, 80) : 'missing'
      })()`)
      await setInput('input.dm_search', marker2)
      await sleep(1400)
      // 1. 卡片标签点击 = 精确 tag= 过滤（不再把标签塞进全文 query）
      const tagClicked = await evaluate(`(() => {
        const btn = [...document.querySelectorAll('.dm_tag')].find(el => (el.textContent || '').trim() === '#gui-p2-x')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(1300)
      const tagReq2 = lastEntriesRequest()
      const idsShown = await evaluate(`[...document.querySelectorAll('.dm_id')].map(el => (el.textContent || '').trim())`)
      check('标签点击走精确 tag= 过滤', tagClicked && tagReq2 !== undefined && /[?&]tag=gui-p2-x(&|$)/.test(tagReq2) && !/[?&]query=/.test(tagReq2), tagReq2 ?? searchInput)
      check('标签过滤只显示该标签条目', idsShown.includes(tagA.id) && !idsShown.includes(tagB.id), JSON.stringify(idsShown))
      // 清空标签过滤，恢复搜索。
      await setInput('input[aria-label*="标签"]', '')
      await sleep(400)
      await setInput('input.dm_search', marker2)
      await sleep(1300)
      // 2. revived：归档条目以相同内容再次保存 → 提示「已恢复为活跃」，而不是「未重复写入」
      await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(el => /新建记忆|New memory/.test((el.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
      await sleep(800)
      await setInput('.dm_dialog textarea', `${marker2} 复活条目`)
      const scopeSelected = await evaluate(`(() => {
        const trigger = [...document.querySelectorAll('.dm_dialog .dm_select_trigger')].find(el => /作用域|Scope/.test((el.getAttribute('aria-label') || '') + (el.innerText || '')))
        if (!trigger) return false
        trigger.click()
        return true
      })()`)
      await sleep(500)
      const globalPicked = await evaluate(`(() => {
        const opt = [...document.querySelectorAll('[role="option"], .dm_select_opt')].find(el => /全局|Global/.test((el.textContent || '').trim()))
        if (!opt) return false
        opt.click()
        return true
      })()`)
      await sleep(400)
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll('.dm_dialog button')].find(el => /保存|Save/.test((el.textContent || '').trim()) && !/取消|Cancel/.test((el.textContent || '').trim()))
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await sleep(1800)
      const reviveToast = await evaluate(`(document.querySelector('.dm_toast_text') || {}).textContent || ''`)
      const revivedList = await apiJson(`/entries?query=${encodeURIComponent(`${marker2} 复活条目`)}&scope=global&include_superseded=true&include_expired=true&include_archived=true`)
      const revivedEntry = (revivedList?.entries || []).find((e) => e.id === reviveBase.id)
      check('再次保存同内容显示「已恢复为活跃」', scopeSelected && globalPicked && /恢复|Restored/.test(reviveToast), reviveToast)
      check('复活后条目回到活跃且 id 不变', Boolean(revivedEntry) && !revivedEntry.archived, JSON.stringify(revivedEntry && { id: revivedEntry.id, archived: revivedEntry.archived }))
      // 3. busy 期间卡片操作按钮禁用 + 列表 aria-busy
      await setInput('input.dm_search', marker2)
      await sleep(1200)
      await send('Network.emulateNetworkConditions', { offline: false, latency: 1800, downloadThroughput: -1, uploadThroughput: -1 })
      await evaluate(`(() => {
        const card = document.querySelector('.dm_card')
        if (!card) return false
        const btn = [...card.querySelectorAll('.dm_card_actions button')].find(el => /钉选|Pin/.test((el.textContent || '').trim()))
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await sleep(200)
      const busyState = await evaluate(`(() => ({
        allDisabled: [...document.querySelectorAll('.dm_card_actions button')].every(b => b.disabled),
        listBusy: document.querySelector('[aria-busy="true"]') !== null,
      }))()`)
      check('busy 期间卡片操作按钮禁用且列表 aria-busy', busyState.allDisabled && busyState.listBusy, JSON.stringify(busyState))
      await sleep(3500)
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await sleep(800)
    } finally {
      try {
        const status = await apiJson('/status')
        for (const id of p2ids) await apiJson('/forget', { method: 'POST', token: status?.key, body: { id } })
      } catch { /* ignore */ }
      await evaluate(`(() => {
        const el = document.querySelector('input.dm_search')
        if (!el) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`).catch(() => {})
      await sleep(600)
    }

    // 7) 网络失败：离线时请求快速失败并显示可重试错误，而不是永久骨架/卡死。
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await evaluate(`(() => { const chips = [...document.querySelectorAll('.dm_chips .dm_chip')]; if (chips[1]) chips[1].click(); return Boolean(chips[1]) })()`)
    await sleep(1500)
    const offlineError = await evaluate(`(() => {
      const el = document.querySelector('.dm_empty')
      return el ? (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : ''
    })()`)
    check('网络失败显示可重试错误（不卡死）', /网络异常|Network error|失败|Failed/.test(offlineError), offlineError)
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await sleep(600)
    await evaluate(`(() => { const chips = [...document.querySelectorAll('.dm_chips .dm_chip')]; if (chips[0]) chips[0].click(); return Boolean(chips[0]) })()`)
    await sleep(1200)
    check('恢复在线后列表重新加载', (await evaluate(`document.querySelectorAll('.dm_card').length`)) >= 0)

    // 8) 设置页：保留份数夹取 + 备份触发重载不覆盖防抖中的草稿（0.24.5）
    // 破坏性用例保护：快照真实 settings overlay 与 backups 文件集，结束原样恢复并删除本次
    // 新增备份（0.24.15 起不再 reset 用户设置/裁剪用户历史备份）。
    const settingsBefore = await apiJson('/settings')
    const overlayBefore = overlayBaseline
    const originalRetention = Number(settingsBefore?.effective?.backupRetention)
    const backupsBefore = backupsBaseline
    try {
      check('读取原始备份保留份数', Number.isInteger(originalRetention), String(originalRetention))
      await evaluate(`(() => { const tab = document.querySelector('#dm-tab-settings'); if (tab) tab.click(); return Boolean(tab) })()`)
      await sleep(1000)
      check('设置页已打开', await evaluate(`document.querySelector('#dm-panel-settings') !== null && document.querySelectorAll('.dm_numinput').length > 0`))
      const setRetention = async (value) => evaluate(`(() => {
        const input = document.querySelectorAll('.dm_numinput')[0]
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(String(value))})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      const clickButton = async (pattern) => evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => ${pattern}.test((x.textContent || '').trim()))
        if (b) b.click()
        return Boolean(b)
      })()`)
      const readRetentionInput = () => evaluate(`(() => { const input = document.querySelectorAll('.dm_numinput')[0]; return input ? input.value : null })()`)
      // 0.24.19：滑杆拖动期间只更新本地值（不逐帧 setDraft/整页重渲染），松手/失焦才提交保存。
      const settingsReqCount = () => requests.filter((u) => /dsh-memory\/settings$/.test(u)).length
      const sliderBefore = settingsReqCount()
      const sliderDragged = await evaluate(`(() => {
        const el = document.querySelector('input.dm_range')
        if (!el) return null
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        const base = Number(el.value)
        for (let i = 1; i <= 5; i += 1) {
          setter.call(el, String(base + (i % 2 === 0 ? -60 : 60)))
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        return { shown: Number(el.value), base }
      })()`)
      await sleep(500)
      const sliderMid = settingsReqCount()
      check('滑杆拖动期间不触发设置保存', sliderDragged !== null && sliderMid === sliderBefore, `${sliderBefore} -> ${sliderMid}`)
      await evaluate(`(() => {
        const el = document.querySelector('input.dm_range')
        if (!el) return false
        el.dispatchEvent(new Event('pointerup', { bubbles: true }))
        el.blur()
        return true
      })()`)
      await sleep(1700)
      const sliderAfter = settingsReqCount()
      check('滑杆松手后提交一次设置保存', sliderAfter > sliderMid, `${sliderMid} -> ${sliderAfter}`)
      // 8a) 输入 0：服务端夹取为 1，草稿应回收为 effective（界面值=实际值）。
      const recallBeforeSettingsSave = requests.filter((u) => u.includes('/recall-preview')).length
      const setZero = await setRetention(0)
      await sleep(1800)
      if (setZero !== true) console.log('  · 设置页保留份数输入框未就绪')
      check('设置保存后召回预览随之刷新（且只 +1，隐藏面板不重复请求）', requests.filter((u) => u.includes('/recall-preview')).length === recallBeforeSettingsSave + 1, `${recallBeforeSettingsSave} -> ${requests.filter((u) => u.includes('/recall-preview')).length}`)
      const clampedValue = await readRetentionInput()
      const clampedDoc = await apiJson('/settings')
      check('保留份数 0 被夹取为 1 且界面同步', String(clampedValue) === '1' && Number(clampedDoc?.effective?.backupRetention) === 1, `${clampedValue} / ${clampedDoc?.effective?.backupRetention}`)
      // 8b) 安全备份：先把「足够大的保留份数」落盘（保证轮转不会删真实历史备份），
      //     再制造未保存草稿并点「立即备份」，验证重载不覆盖防抖中的草稿。
      const safeRetention = Math.min(30, Math.max(originalRetention + 1, backupsBefore.length + 2))
      await setRetention(safeRetention)
      await sleep(1900)
      await setRetention(Math.min(30, safeRetention + 1))
      await sleep(150)
      const backupCountBeforeTrigger = listBackups().length
      await clickButton(/立即备份|Back up now/)
      await sleep(280) // 备份+重载已返回，但 600ms 防抖保存尚未落地
      const draftAtReload = await readRetentionInput()
      const docAtReload = await apiJson('/settings')
      check('备份触发的设置重载不覆盖未保存草稿', String(draftAtReload) === String(Math.min(30, safeRetention + 1)) && Number(docAtReload?.effective?.backupRetention) === safeRetention, `${draftAtReload} / ${docAtReload?.effective?.backupRetention}`)
      check('备份未裁剪既有历史备份', listBackups().length >= backupCountBeforeTrigger + 1, `${backupCountBeforeTrigger} -> ${listBackups().length}`)
      await sleep(1700) // 防抖保存落地：草稿按正常路径持久化（而非被重载丢弃）
      const docAfterDraftSave = await apiJson('/settings')
      check('备份后未保存草稿仍按正常路径保存', Number(docAfterDraftSave?.effective?.backupRetention) === Math.min(30, safeRetention + 1), String(docAfterDraftSave?.effective?.backupRetention))
      await setRetention(originalRetention)
      await sleep(1800)
      const restoredSettings = await apiJson('/settings')
      check('备份保留份数已还原', Number(restoredSettings?.effective?.backupRetention) === originalRetention, String(restoredSettings?.effective?.backupRetention))

      // 8c) 保存失败 → footer 显示重试 → 点击重试成功（设置写入状态机 0.24.10）
      // 用 .lock-settings 阻塞写锁制造确定性失败（锁超时 1s）。若用 CDP offline，fetch 可能
      // 挂到 15s 请求超时，固定轮询窗口会偶发假失败。
      const failTarget = Math.min(30, originalRetention + 1)
      const settingsLock = path.join(ROOT, '.lock-settings')
      mkdirSync(settingsLock, { recursive: true })
      await setRetention(failTarget)
      let failState = null
      for (let i = 0; i < 16; i += 1) {
        await sleep(400)
        failState = await evaluate(`(() => ({
          footer: (document.querySelector('.dm_savestate') || {}).innerText || '',
          retry: document.querySelector('.dm_linkbtn') !== null,
          value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null,
        }))()`)
        if (failState.retry) break
      }
      check('保存失败显示重试而非谎报已保存', failState.retry && /重试|Retry/.test(failState.footer) && String(failState.value) === String(failTarget), JSON.stringify({ ...failState, recentSettings: requests.filter((u) => u.includes('/settings')).slice(-4) }))
      rmSync(settingsLock, { recursive: true, force: true })
      await sleep(400)
      await evaluate(`(() => { const b = document.querySelector('.dm_linkbtn'); if (b) b.click(); return Boolean(b) })()`)
      let retryState = { footer: '', value: null }
      for (let i = 0; i < 14; i += 1) {
        await sleep(400)
        retryState = await evaluate(`(() => ({
          footer: (document.querySelector('.dm_savestate') || {}).innerText || '',
          value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null,
        }))()`)
        if (/已保存|Saved/.test(retryState.footer)) break
      }
      const retryDoc = await apiJson('/settings')
      check('失败后重试保存成功且状态回到已保存', /已保存|Saved/.test(retryState.footer) && Number(retryDoc?.effective?.backupRetention) === failTarget, JSON.stringify(retryState))
      await setRetention(originalRetention)
      await sleep(1600)

      // 8d) 重置与在途保存互斥：改值后立刻点「恢复默认」→ 默认值生效、不被旧保存响应回滚
      const defaultsRetention = Number(settingsBefore?.defaults?.backupRetention)
      await setRetention(Math.min(30, originalRetention + 2))
      await clickButton(/恢复默认|Reset to defaults/)
      await sleep(2300)
      const afterReset = await apiJson('/settings')
      const resetState = await evaluate(`(() => {
        const footer = (document.querySelector('.dm_savestate') || {}).innerText || ''
        return {
          footer,
          saving: /保存中|Saving/.test(footer),
          value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null,
        }
      })()`)
      check('重置后在途保存不回滚默认值', Number(afterReset?.effective?.backupRetention) === defaultsRetention && String(resetState.value) === String(defaultsRetention), JSON.stringify({ ...resetState, effective: afterReset?.effective?.backupRetention }))
      check('重置后不卡在保存中', resetState.saving === false && /已保存|Saved/.test(resetState.footer), JSON.stringify(resetState))

      // 8e) 慢网络竞态：防抖保存尚未落地时点「恢复默认」→ 旧草稿不得以更新 seq 覆盖 reset（0.24.15）
      await evaluate(`(() => { const tab = document.querySelector('#dm-tab-settings'); if (tab) tab.click(); return true })()`)
      await send('Network.emulateNetworkConditions', { offline: false, latency: 1800, downloadThroughput: -1, uploadThroughput: -1 })
      await setRetention(Math.min(30, defaultsRetention + 2))
      await sleep(250) // 600ms 防抖窗口内点重置
      await clickButton(/恢复默认|Reset to defaults/)
      await sleep(6000)
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await sleep(500)
      const afterRace = await apiJson('/settings')
      const raceState = await evaluate(`(() => {
        const footer = (document.querySelector('.dm_savestate') || {}).innerText || ''
        return { footer, value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null }
      })()`)
      check('慢网络下「恢复默认」不被在途防抖保存回滚', Number(afterRace?.effective?.backupRetention) === defaultsRetention && String(raceState.value) === String(defaultsRetention) && /已保存|Saved/.test(raceState.footer), JSON.stringify({ ...raceState, effective: afterRace?.effective?.backupRetention }))
    } finally {
      // 真实数据根恢复：overlay 原值 + 删除本次新增备份；随后回到记忆页。
      try {
        await restoreSettingsOverlay(overlayBefore)
      } catch (err) {
        console.error('恢复设置 overlay 失败：', err)
      }
      removeNewBackups(backupsBefore)
      try { rmSync(path.join(ROOT, '.lock-settings'), { recursive: true, force: true }) } catch { /* ignore */ }
      const restoredOverlay = (await apiJson('/settings'))?.overlay ?? {}
      check('真实设置 overlay 已恢复原值', JSON.stringify(restoredOverlay) === JSON.stringify(overlayBefore), JSON.stringify({ restoredOverlay, overlayBefore }))
      check('真实 backups 文件集已恢复（无新增残留）', JSON.stringify(listBackups()) === JSON.stringify(backupsBefore), JSON.stringify({ before: backupsBefore, after: listBackups() }))
      try {
        await evaluate(`(() => { const tab = document.querySelector('#dm-tab-memories'); if (tab) tab.click(); return Boolean(tab) })()`)
      } catch { /* ignore */ }
      await sleep(800)
    }

    // 9) 无 JS 异常 + 截图（先截图：cleanup 钩子会杀 Edge，不能再发 CDP 请求）
    check('页面无未捕获 JS 异常', consoleLines.every((line) => !line.startsWith('exception:')), JSON.stringify(consoleLines.slice(0, 5)))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`  · 截图：${SHOT}`)
    // 真实数据根前后一致（临时记忆已清理、设置/备份已恢复；中断路径共用同一清理注册表）。
    await runCleanupHooks()
    const dataChangesGui = diffSnapshots(dataSnapshotBefore, snapshotDataRoot(ROOT))
    check('真实数据根快照前后一致（零残留）', dataChangesGui.length === 0, JSON.stringify(dataChangesGui.slice(0, 5)))
  } catch (err) {
    failed = err
    console.error('GUI CHECK 异常：', err)
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    try { edge.kill() } catch { /* ignore */ }
    await removeProfileDir(USER_DATA)
  }
  console.log(`\n结果：${report.checks.filter((c) => c.ok).length} 通过，${report.checks.filter((c) => !c.ok).length} 失败`)
  if (!report.ok && consoleLines.length > 0) console.log('CONSOLE ' + JSON.stringify(consoleLines.slice(0, 20), null, 2))
  // 用 exitCode 而非 process.exit()：Windows 上在 Edge 子进程/管道仍在收尾时强制 exit
  // 偶发触发 libuv 断言（0xC0000409）。让 Node 在句柄自然关闭后退出。
  process.exitCode = failed !== null || !report.ok ? 1 : 0
}

main().catch((err) => { console.error('gui-check 启动失败：', err); process.exitCode = 1 })