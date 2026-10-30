// 规格静态验证（`docs/specs/acceptance-matrix.md` 的「规格静态验证」）：工具清单示例的
// **文档/数据一致性**。断言三件事，全部只读文件：
//   1. `tools.md` 写出的源 JSON SHA256 等于 `tools.json` 的实际字节（MD 陈旧即失败）；
//   2. 不可变快照与当前 JSON 字节相同，且 MD 指向的正是这份快照；
//   3. 四层状态里「未知不冒充验证成功」：除 `discovered` 外，任何 `pass` 都必须有对应 `checks`，
//      且 MD 逐入口渲染的状态必须与 JSON 逐个相同。
//
// 这里的期望值全部来自**文件字节**或 JSON 本身（两个独立来源对撞），不由源码重算。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const jsonUrl = new URL('../../../docs/examples/tools.json', import.meta.url)
const mdUrl = new URL('../../../docs/examples/tools.md', import.meta.url)
const snapshotUrl = new URL('../../../docs/examples/ENV-tools-example.json', import.meta.url)

const jsonBytes = readFileSync(jsonUrl)
const inventory = JSON.parse(jsonBytes.toString('utf8'))
const markdown = readFileSync(mdUrl, 'utf8')

/** 四层状态的固定顺序（`tool-discovery.md` 的层级名）。 */
const LAYERS = ['discovered', 'executable', 'session_ready', 'target_ready']

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** JSON 里的每个入口（工具 → 入口）。 */
function entrypoints() {
  return inventory.tools.flatMap((tool) => tool.entrypoints.map((entry) => ({ tool, entry })))
}

/** 取 MD 里某个入口的正文段（从它的 `- 路径：` 到下一条 `###`/`##`）。 */
function entrySection(path) {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.startsWith('- 路径：') && line.includes(`\`${path}\``))
  assert.notEqual(start, -1, `tools.md 必须列出入口 ${path}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('### ') || line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

test('tools.md 的源 JSON SHA256 等于当前 tools.json 字节（MD 不得陈旧）', () => {
  const matched = /源 JSON SHA256：`([0-9a-f]{64})`/u.exec(markdown)
  assert.ok(matched, 'tools.md 必须写出源 JSON 的 SHA256')
  assert.equal(
    matched[1],
    sha256(jsonBytes),
    'MD 的源哈希必须等于 tools.json 的实际字节哈希；陈旧的是 MD，按 JSON 重新生成，不能反过来改 JSON',
  )

  // MD 展示的 revision / host.id 同样来自这份 JSON，不能手写第二份状态。
  assert.match(markdown, new RegExp(`inventory_revision：\`${inventory.inventory_revision}\``, 'u'))
  assert.match(markdown, new RegExp(`host\\.id：\`${inventory.host.id}\``, 'u'))
})

test('不可变快照与当前 JSON 字节相同，MD 指向的正是这份快照', () => {
  assert.equal(inventory.snapshot_ref, 'docs/examples/ENV-tools-example.json', 'snapshot_ref 必须指向示例快照')
  assert.equal(
    sha256(readFileSync(snapshotUrl)),
    sha256(jsonBytes),
    '示例快照与当前 JSON 必须同字节（MD 声明「与源 JSON 字节相同」）',
  )
  assert.match(markdown, /\[ENV-tools-example\.json\]\(ENV-tools-example\.json\)/u, 'MD 必须链接到不可变快照')
})

test('四层状态：未知不冒充验证成功，且 MD 逐入口与 JSON 一致', () => {
  const allowed = new Set(['unknown', 'pass', 'fail', 'not_applicable'])
  const entries = entrypoints()
  assert.ok(entries.length > 0, '示例至少要有一个入口')

  for (const { tool, entry } of entries) {
    const label = `${tool.id}/${entry.id}`
    assert.deepEqual(Object.keys(entry.states).sort(), [...LAYERS].sort(), `${label}: 四层状态必须齐备且不夹带别的层`)
    for (const layer of LAYERS) {
      assert.ok(allowed.has(entry.states[layer]), `${label}: ${layer} 的状态 ${String(entry.states[layer])} 不在允许值内`)
    }

    // 只有 discovered 可以凭文件元数据判 pass；其余三层要 pass 必须有对应层级的 checks。
    for (const layer of ['executable', 'session_ready', 'target_ready']) {
      if (entry.states[layer] !== 'pass') continue
      assert.ok(
        Array.isArray(entry.checks) && entry.checks.some((check) => check.level === layer && check.result === 'pass'),
        `${label}: ${layer}=pass 必须有同层级的 checks 证据`,
      )
    }

    // MD 的该入口状态行必须与 JSON 逐个相同（不许把 unknown 渲染成 pass）。
    const expected = `- 四层状态：${LAYERS.map((layer) => `${layer}=${entry.states[layer]}`).join('；')}`
    assert.ok(
      entrySection(entry.path).includes(expected),
      `${label}: tools.md 的四层状态行必须与 JSON 一致（期望 ${expected}）`,
    )
  }

  // 本示例没有执行任何程序：不允许出现通过态冒充验证成功。
  assert.doesNotMatch(
    markdown,
    /(?:executable|session_ready|target_ready)=pass/u,
    '示例未执行任何验证，MD 不得写出 executable/session_ready/target_ready 的通过态',
  )
  assert.equal(inventory.registry_ref, null, '示例未读取 DSH MCP 注册表，registry_ref 必须是 null（不是空数组）')
})
