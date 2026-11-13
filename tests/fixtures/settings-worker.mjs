/**
 * 并发设置写入 worker：反复合并写同一个键，用于验证 writeOverlay 读-改-写跨进程互斥。
 * 用法 usage: node settings-worker.mjs <root> <autoInject|decayEnabled> <count>
 */
import { writeOverlay } from '../../lib/settings.js'

const [root, key, countArg] = process.argv.slice(2)
const count = Number(countArg)
for (let i = 0; i < count; i += 1) {
  writeOverlay(root, key === 'autoInject' ? { autoInject: i % 2 === 0 } : { decayEnabled: i % 2 === 0 })
}
process.exit(0)