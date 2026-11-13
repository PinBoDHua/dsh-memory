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
 * 安全：只读＋可逆操作——不保存/删除任何真实记忆；新建弹窗只输入草稿后关闭。
 * 登录 cookie 由本机 <DSH_HOME>/.credentials.yaml 的 browser-session secret 自签
 * （与 dsh-client-connection 同一算法），仅用于回环地址。
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const BASE = argOf('url') ?? process.env.DSH_MEMORY_GUI_URL ?? 'http://127.0.0.1:57031/'
const SHOT = argOf('shot') ?? path.join(os.tmpdir(), 'dsh-memory-gui-check.png')
const CDP_PORT = Number(argOf('cdp-port') ?? 9334)
const USER_DATA = path.join(os.tmpdir(), `dsh-memory-gui-profile-${process.pid}`)
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function main() {
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}（可用 EDGE_PATH 指定）`)
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

    // 6) 无 JS 异常 + 截图
    check('页面无未捕获 JS 异常', consoleLines.every((line) => !line.startsWith('exception:')), JSON.stringify(consoleLines.slice(0, 5)))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`  · 截图：${SHOT}`)
  } catch (err) {
    failed = err
    console.error('GUI CHECK 异常：', err)
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    try { edge.kill() } catch { /* ignore */ }
    try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log(`\n结果：${report.checks.filter((c) => c.ok).length} 通过，${report.checks.filter((c) => !c.ok).length} 失败`)
  if (failed !== null) process.exit(1)
  process.exit(report.ok ? 0 : 1)
}

main().catch((err) => { console.error('gui-check 启动失败：', err); process.exit(1) })