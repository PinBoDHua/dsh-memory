// 并发写测试工作进程：node save-worker.mjs <root> <cwd> <count> <prefix>
import { createMemoryService } from '../../lib/service.js'

const [root, cwd, count, prefix] = process.argv.slice(2)
const service = createMemoryService({ root })
for (let i = 0; i < Number(count); i++) {
  service.save({ content: `${prefix} entry ${i}`, scope: 'workspace', workspace: cwd })
}
