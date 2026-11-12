// 并发导入测试工作进程：node import-worker.mjs <root> <prefix> <count>
import { createMemoryService } from '../../lib/service.js'

const [root, prefix, count] = process.argv.slice(2)
const service = createMemoryService({ root })
const entries = []
for (let i = 0; i < Number(count); i++) {
  entries.push({ content: `${prefix} import ${i}`, scope: 'global' })
}
const result = service.import({ entries })
if (result.imported !== Number(count)) {
  console.error(`expected ${count} imported, got ${result.imported}`)
  process.exit(1)
}
