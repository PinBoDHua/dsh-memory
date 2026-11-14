// 第七轮审计 H3/H15 并发写测试工作进程。
// node write-worker.mjs <root> <mode> <args...>
// mode: supersede <targetId> <content> | update <id> <jsonPatch> | forget <id> | backup <count>
// 结果以 JSON 写 stdout：{ ok, id?, deleted?, error? }
import { createMemoryService } from '../../lib/service.js'
import * as store from '../../lib/store.js'

const [root, mode, ...args] = process.argv.slice(2)
const service = createMemoryService({ root })
const out = { ok: false }
try {
  if (mode === 'supersede') {
    const [targetId, content] = args
    const r = store.saveEntry(root, { content, scope: 'global', supersedes: targetId })
    out.ok = true
    out.id = r.entry.id
  } else if (mode === 'update') {
    const [id, patchJson] = args
    store.updateEntry(root, id, JSON.parse(patchJson))
    out.ok = true
  } else if (mode === 'forget') {
    const r = store.forgetEntries(root, [args[0]])
    out.ok = true
    out.deleted = r.deleted.length > 0
  } else if (mode === 'backup') {
    for (let i = 0; i < Number(args[0]); i += 1) service.backup()
    out.ok = true
  } else {
    out.error = `unknown mode: ${mode}`
  }
} catch (err) {
  out.error = err?.code ?? String(err?.message ?? err)
}
process.stdout.write(JSON.stringify(out))