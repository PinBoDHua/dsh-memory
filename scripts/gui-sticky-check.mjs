/**
 * dsh-memory 吸顶工具栏布局回归测量（Edge headless + CDP，只读，不写任何数据）。
 *
 * 症状（用户截图 2026-11-14）：滚动后工具栏不贴滚动容器顶，上方留出一条
 * 「露出带」，滚动的卡片从带里露出、中段被工具栏盖住，像把卡片拦腰切断。
 * 根因假设：.dm_toolbar_wrap 的 sticky top 用了 --dsh-frame-top-clearance
 * （回退 48px），而宿主主区域并无占据该高度的顶栏。
 *
 * 用法 Run:
 *   node scripts/gui-sticky-check.mjs --url=http://127.0.0.1:<GUI端口>/ [--shot=out.png]
 *   --probe=1：受控实验模式（临时改 DOM 样式，测量 sticky 停驻位与 top/padding-top 关系）。
 * 退出码：0=绿；1=红（露出带/未贴顶）；2=无法判定（列表太短滚不动）。
 * 登录 cookie 与 gui-check 同一自签算法，仅用于回环地址。
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const BASE = argOf('url') ?? process.env.DSH_MEMORY_GUI_URL ?? 'http://127.0.0.1:52271/'
const SHOT = argOf('shot') ?? path.join(os.tmpdir(), 'dsh-memory-sticky-check.png')
const CDP_PORT = Number(argOf('cdp-port') ?? (9300 + Math.floor(Math.random() * 600)))
const USER_DATA = path.join(os.tmpdir(), `dsh-memory-sticky-profile-${process.pid}`)
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ===== cookie 自签（与 gui-check 同算法） =====
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
    if (matched !== null) return Buffer.from(matched[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  }
  throw new Error('credentials: browser-session secret 缺失')
}
function authCookie(base) {
  const url = new URL(base)
  const key = readSigningSecret(path.join(DSH_HOME, '.credentials.yaml'))
  const issuedAt = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: url.host, issuedAt, expiresAt: issuedAt + 86400000 }), 'utf8'))
  const signature = b64url(createHmac('sha256', key).update(body).digest())
  return { name: 'dsh-auth-' + b64url(createHash('sha256').update(url.host).digest()), value: `v1.${body}.${signature}`, url: url.href }
}

// ===== 最小 CDP 客户端 =====
let ws
let nextId = 0
const pending = new Map()
async function connect() {
  let targets = null
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      targets = await res.json()
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break
    } catch { /* 浏览器尚未就绪 */ }
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
    }
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  return result.result?.value
}

let red = false
function check(name, cond, detail = '') {
  if (!cond) red = true
  console.log(`${cond ? '  ✔' : '  ✖'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
}

async function main() {
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(USER_DATA, { recursive: true })
  const edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,950', 'about:blank',
  ], { stdio: 'ignore' })
  try {
    console.log(`dsh-memory sticky layout check @ ${BASE}\n`)
    await connect()
    await send('Page.enable')
    await send('Runtime.enable')
    const cookie = authCookie(BASE)
    await send('Network.setCookie', { name: cookie.name, value: cookie.value, url: cookie.url, path: '/', httpOnly: true, sameSite: 'Strict' })
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000)
      ws.addEventListener('message', (message) => {
        const data = JSON.parse(message.data)
        if (data.method === 'Page.loadEventFired') { clearTimeout(timer); resolve() }
      })
    })
    await send('Page.navigate', { url: BASE })
    await loaded
    await sleep(2500)
    // 宿主可能弹「预览版说明」对话框，先关掉。
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => (el.innerText || '').includes('预览版说明'))
      if (dialog) { const b = dialog.querySelector('button'); if (b) b.click() }
      return true
    })()`)
    const opened = await evaluate(`(() => {
      const hit = [...document.querySelectorAll('button,[role="button"],a')].find(el => ((el.textContent || '').trim() === '记忆' || el.getAttribute('aria-label') === '记忆') && el.children.length <= 3)
      if (!hit) return false
      hit.click()
      return true
    })()`)
    await sleep(2000)
    if (!opened || !(await evaluate(`document.querySelector('.dm_page') !== null`))) throw new Error('记忆面板未打开')

    const rest = await evaluate(`(() => {
      const page = document.querySelector('.dm_page')
      const toolbar = document.querySelector('.dm_toolbar_wrap')
      const pr = page.getBoundingClientRect()
      const cs = getComputedStyle(toolbar)
      return {
        rootVar: getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance').trim(),
        pageVar: getComputedStyle(page).getPropertyValue('--dsh-frame-top-clearance').trim(),
        stickyTop: cs.top, position: cs.position,
        paddingTop: getComputedStyle(page).paddingTop,
        pageTop: pr.top, restToolbarTop: toolbar.getBoundingClientRect().top,
        scrollHeight: page.scrollHeight, clientHeight: page.clientHeight,
        topHit: document.elementsFromPoint(pr.left + pr.width / 2, pr.top + 2).slice(0, 3).map(el => String(el.className || el.tagName).slice(0, 60)),
      }
    })()`)
    console.log('  · 静止态:', JSON.stringify(rest))

    const pinned = await evaluate(`(async () => {
      const page = document.querySelector('.dm_page')
      const max = page.scrollHeight - page.clientHeight
      if (max < 200) return { inconclusive: true, max }
      page.scrollTop = Math.min(400, max)
      await new Promise(r => setTimeout(r, 450))
      const toolbar = document.querySelector('.dm_toolbar_wrap')
      const pr = page.getBoundingClientRect()
      const tr = toolbar.getBoundingClientRect()
      const gap = tr.top - pr.top
      const bandY = pr.top + Math.max(gap, 0) / 2
      const bandHits = document.elementsFromPoint(pr.left + pr.width / 2, bandY).map(el => String(el.className || el.tagName).slice(0, 80))
      const card = document.querySelector('.dm_card')
      const cr = card ? card.getBoundingClientRect() : null
      return {
        max, scrollTop: page.scrollTop, pageTop: pr.top, toolbarTop: tr.top, toolbarBottom: tr.bottom,
        gap, bandHits,
        // 露出带只在 gap>1 时存在；gap≤1 时采样点落在工具栏上，栈下层被盖住属正常吸顶。
        bandContent: gap > 1 && bandHits.some(c => /dm_card|dm_section_title|dm_content|dm_rail/.test(c)),
        cardTop: cr ? cr.top : null, cardBottom: cr ? cr.bottom : null,
      }
    })()`)
    console.log('  · 吸顶态:', JSON.stringify(pinned))

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    console.log(`  · 截图: ${SHOT}`)

    if (argOf('probe') !== undefined) {
      // 受控实验：sticky 停驻位置与 top / 容器 padding-top 的关系（只改临时 DOM 样式）。
      const exp = await evaluate(`(async () => {
        const page = document.querySelector('.dm_page')
        const toolbar = document.querySelector('.dm_toolbar_wrap')
        const wait = () => new Promise(r => setTimeout(r, 250))
        const measure = () => toolbar.getBoundingClientRect().top - page.getBoundingClientRect().top
        const out = {}
        page.scrollTop = 400; await wait()
        out.base = measure()
        toolbar.style.top = '0px'; await wait(); out.top0_pad66 = measure()
        page.style.paddingTop = '0px'; await wait(); out.top0_pad0 = measure()
        toolbar.style.top = '48px'; await wait(); out.top48_pad0 = measure()
        page.style.paddingTop = '18px'; await wait(); out.top48_pad18 = measure()
        toolbar.style.top = '0px'; await wait(); out.top0_pad18 = measure()
        toolbar.style.top = ''; page.style.paddingTop = ''
        const chain = []
        let el = toolbar.parentElement
        while (el && el !== document.body) {
          const cs = getComputedStyle(el)
          chain.push({ cls: String(el.className || el.tagName).slice(0, 40), overflow: cs.overflowY, transform: cs.transform, filter: cs.filter, contain: cs.contain })
          el = el.parentElement
        }
        out.chain = chain
        return out
      })()`)
      console.log('  · 实验:', JSON.stringify(exp, null, 1))
      process.exitCode = 0
    } else if (pinned.inconclusive) {
      console.log('  ! 列表太短，无法滚动到吸顶，无法判定')
      process.exitCode = 2
    } else {
      check('滚动后工具栏贴滚动容器顶（gap≤1px）', pinned.gap <= 1, `gap=${pinned.gap.toFixed(1)}px`)
      check('工具栏上方无露出带暴露滚动卡片', !pinned.bandContent, JSON.stringify(pinned.bandHits))
      process.exitCode = red ? 1 : 0
    }
  } finally {
    try { edge.kill() } catch { /* ignore */ }
    await sleep(400)
    try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
