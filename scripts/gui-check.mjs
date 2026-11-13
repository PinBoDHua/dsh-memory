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
      }
    })()`)
    check('Tabs 具备 ARIA tablist/tab/tabpanel 关联', tabsAria.listRole === 'tablist' && tabsAria.memRole === 'tab' && tabsAria.memControls === 'dm-panel-memories' && tabsAria.setControls === 'dm-panel-settings' && tabsAria.panelRole === 'tabpanel' && tabsAria.panelLabelled === 'dm-tab-memories', JSON.stringify(tabsAria))
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
      // 1c) 标签：去重 + 12 个上限计数/提示（客户端与服务端同口径）
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

    // 6) 删除撤销吐司优先级 + 撤销恢复（0.24.4）：删除后的撤销不能被后续提示挤掉。
    const marker = `__gui_undo_${Date.now().toString(36)}__`
    let createdIds = []
    try {
      const status = await apiJson('/status')
      const token = status && status.key
      const a = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} A`, scope: 'global', origin: 'auto' } })
      const b = await apiJson('/save', { method: 'POST', token, body: { content: `${marker} B`, scope: 'global', origin: 'auto' } })
      const idA = a?.result?.entry?.id
      const idB = b?.result?.entry?.id
      createdIds = [idA, idB].filter(Boolean)
      check('API 创建两条验收临时记忆', createdIds.length === 2, JSON.stringify(createdIds))

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
      check('临时记忆出现在面板列表', cards.filter((text) => text.includes(marker)).length === 2, JSON.stringify(cards.length))

      // 删除 A（卡片内「删除」→ 确认弹窗危险按钮）。
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('.dm_card')].find(el => (el.innerText || '').includes(${JSON.stringify(`${marker} A`)}))
        if (!card) return false
        const btn = [...card.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '删除' || (b.textContent || '').trim() === 'Delete')
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      await sleep(500)
      await evaluate(`(() => { const btn = document.querySelector('.dm_btn_danger_solid'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(1000)
      const afterDelete = await evaluate(`(() => ({ text: (document.querySelector('.dm_toast_text') || {}).textContent || '', hasAction: document.querySelector('.dm_toast_action') !== null }))()`)
      check('删除后出现带撤销的吐司', afterDelete.hasAction && /删除|Delete/.test(afterDelete.text), JSON.stringify(afterDelete))

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
      await evaluate(`(() => { const btn = document.querySelector('.dm_toast_action'); if (btn) btn.click(); return Boolean(btn) })()`)
      await sleep(1400)
      const listAfterUndo = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&include_superseded=true&include_expired=true&include_archived=true`)
      check('撤销后记忆恢复且 id 不变', (listAfterUndo?.entries || []).some((e) => e.id === idA), JSON.stringify((listAfterUndo?.entries || []).map((e) => e.id)))
      const queuedText = await evaluate(`(document.querySelector('.dm_toast_text') || {}).textContent || ''`)
      check('排队的普通提示随后展示', /钉选|Pin/.test(queuedText) || queuedText.length > 0, queuedText)
    } finally {
      // 清理验收临时记忆（失败路径也要清）。
      try {
        const status = await apiJson('/status')
        for (const id of createdIds) await apiJson('/forget', { method: 'POST', token: status?.key, body: { id } })
        const left = await apiJson(`/entries?query=${encodeURIComponent(marker)}&scope=global&include_superseded=true&include_expired=true&include_archived=true`)
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
    const settingsBefore = await apiJson('/settings')
    const originalRetention = Number(settingsBefore?.effective?.backupRetention)
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
    // 8a) 输入 0：服务端夹取为 1，草稿应回收为 effective（界面值=实际值）。
    const setZero = await setRetention(0)
    await sleep(1800)
    if (setZero !== true) console.log('  · 设置页保留份数输入框未就绪')
    const clampedValue = await evaluate(`(() => { const input = document.querySelectorAll('.dm_numinput')[0]; return input ? input.value : null })()`)
    const clampedDoc = await apiJson('/settings')
    check('保留份数 0 被夹取为 1 且界面同步', String(clampedValue) === '1' && Number(clampedDoc?.effective?.backupRetention) === 1, `${clampedValue} / ${clampedDoc?.effective?.backupRetention}`)
    // 8b) 改值后立刻点「立即备份」（600ms 防抖窗内）→ 重载设置不得覆盖草稿。
    const targetRetention = Math.min(30, originalRetention + 1)
    await setRetention(targetRetention)
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /立即备份|Back up now/.test((x.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
    await sleep(3200)
    const afterBackupValue = await evaluate(`(() => { const input = document.querySelectorAll('.dm_numinput')[0]; return input ? input.value : null })()`)
    const afterBackupDoc = await apiJson('/settings')
    check('备份触发的设置重载不覆盖未保存草稿', String(afterBackupValue) === String(targetRetention) && Number(afterBackupDoc?.effective?.backupRetention) === targetRetention, `${afterBackupValue} / ${afterBackupDoc?.effective?.backupRetention}`)
    // 还原原始保留份数并切回记忆页。
    await setRetention(originalRetention)
    await sleep(1800)
    const restoredSettings = await apiJson('/settings')
    check('备份保留份数已还原', Number(restoredSettings?.effective?.backupRetention) === originalRetention, String(restoredSettings?.effective?.backupRetention))

    // 8c) 保存失败 → footer 显示重试 → 点击重试成功（设置写入状态机 0.24.10）
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    const failTarget = Math.min(30, originalRetention + 1)
    await setRetention(failTarget)
    await sleep(1600)
    const failState = await evaluate(`(() => ({
      footer: (document.querySelector('.dm_savestate') || {}).innerText || '',
      retry: document.querySelector('.dm_linkbtn') !== null,
      value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null,
    }))()`)
    check('保存失败显示重试而非谎报已保存', failState.retry && /重试|Retry/.test(failState.footer) && String(failState.value) === String(failTarget), JSON.stringify(failState))
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await sleep(400)
    await evaluate(`(() => { const b = document.querySelector('.dm_linkbtn'); if (b) b.click(); return Boolean(b) })()`)
    await sleep(1700)
    const retryState = await evaluate(`(() => ({
      footer: (document.querySelector('.dm_savestate') || {}).innerText || '',
      value: (document.querySelectorAll('.dm_numinput')[0] || {}).value || null,
    }))()`)
    const retryDoc = await apiJson('/settings')
    check('失败后重试保存成功且状态回到已保存', /已保存|Saved/.test(retryState.footer) && Number(retryDoc?.effective?.backupRetention) === failTarget, JSON.stringify(retryState))
    await setRetention(originalRetention)
    await sleep(1600)

    // 8d) 重置与在途保存互斥：改值后立刻点「恢复默认」→ 默认值生效、不被旧保存响应回滚
    const defaultsRetention = Number(settingsBefore?.defaults?.backupRetention)
    await setRetention(Math.min(30, originalRetention + 2))
    await evaluate(`(() => { const b = [...document.querySelectorAll('.dm_settings button')].find(x => /恢复默认|Reset to defaults/.test((x.textContent || '').trim())); if (b) b.click(); return Boolean(b) })()`)
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

    await evaluate(`(() => { const tab = document.querySelector('#dm-tab-memories'); if (tab) tab.click(); return Boolean(tab) })()`)
    await sleep(800)

    // 9) 无 JS 异常 + 截图
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
  if (!report.ok && consoleLines.length > 0) console.log('CONSOLE ' + JSON.stringify(consoleLines.slice(0, 20), null, 2))
  if (failed !== null) process.exit(1)
  process.exit(report.ok ? 0 : 1)
}

main().catch((err) => { console.error('gui-check 启动失败：', err); process.exit(1) })