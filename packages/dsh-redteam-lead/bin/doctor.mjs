/**
 * 只读自检 CLI（薄壳）：解析参数 → `dist/doctor.js` → 打印信封 → 设退出码。
 *
 * 固定入口（契约「自检、会话接管与 Lead 循环」）：
 *
 * ```
 * node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>
 * ```
 *
 * 这个文件**不 import `dist/index.js`，也不 import 任何适配器**：它必须在插件没挂载、
 * 团队服务没注册、甚至内核模块缺失时照样能跑。逻辑全在 `src/doctor.ts`（编译产物
 * `dist/doctor.js`），这里只做 I/O。
 */

import { runDoctor, parseDoctorArgs, USAGE } from '../dist/doctor.js'

const parsed = parseDoctorArgs(process.argv.slice(2))
const result = runDoctor(parsed)

process.stdout.write(`${JSON.stringify(result.envelope, null, 2)}\n`)

if (parsed.help === true) {
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 0
} else {
  process.exitCode = result.exitCode
}
