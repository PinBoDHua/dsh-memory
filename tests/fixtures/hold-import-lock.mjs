// 第十轮审计 H3 回归工作进程：持 .lock-import 一段时间，期间模拟「另一进程」改写目标条目，
// 然后释放锁。主进程的 import 会在等待锁窗口后提交——它必须读取最新磁盘状态而不是
// 规划期的陈旧副本，否则并发编辑被静默回滚。
// node hold-import-lock.mjs <root> <targetId> <delayMs>
import fs from 'node:fs'
import path from 'node:path'
import { parseEntry, serializeEntry } from '../../lib/store.js'

const [root, targetId, delayMs] = process.argv.slice(2)
const lockPath = path.join(root, '.lock-import')
fs.mkdirSync(lockPath, { recursive: true })
process.stdout.write('ready\n')
setTimeout(() => {
  try {
    const file = path.join(root, 'global', `${targetId}.md`)
    const entry = parseEntry(fs.readFileSync(file, 'utf8'), { expectedScope: 'global', fallbackId: targetId })
    entry.content = '目标记忆 v2（并发编辑）'
    fs.writeFileSync(file, serializeEntry(entry), 'utf8')
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true })
  }
}, Number(delayMs))
// 保持进程存活到写锁窗口结束，避免提前退出。
setTimeout(() => {}, Number(delayMs) + 5000)
