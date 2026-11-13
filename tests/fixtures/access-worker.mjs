/**
 * 并发账本测试 worker：对一批（互不重叠的）条目各记一次命中。
 * 用法：node access-worker.mjs <root> <offset> <count>
 */
import { createMemoryService } from '../../lib/service.js'
import * as store from '../../lib/store.js'

const [root, offsetArg, countArg] = process.argv.slice(2)
const offset = Number(offsetArg)
const count = Number(countArg)
const service = createMemoryService({ root })
const entries = service.list({ scope: 'global' })
const now = Date.now()
for (let i = 0; i < count; i += 1) {
  const entry = entries[offset + i]
  if (!entry) break
  store.touchAccess(root, [{ ...entry, last_access: '2000-01-01T00:00:00.000Z' }], undefined, now)
}
process.exit(0)