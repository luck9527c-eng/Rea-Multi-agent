/**
 * T20：`rt_roster` 的 `render` 补上验收与排查需要的字段。
 *
 * 背景（ticket T19-T20 §T20）：`rosterData` **数据里**本来就有 `capacity`（D19 的 4 个字段）、
 * `gaps[].code` 与 `session_id`/`team_id`，但 `output.render` 只投影计数，于是：
 *
 * - 模型看不到「每个岗位缺什么能力」，只能去翻 `re/team/operations/*.json`；
 * - A38（只报 unknown 要看 `gaps[].code`）、A40（`session_id` 是本会话）
 *   在工具面上不可观察，只能一直 `not-run`。
 *   （A09 那类「真实余额 vs 未知」的判据随 T23 一起删除：本插件不再做容量规划。）
 *
 * 这里断言的是**宿主能看到的接缝**：注册进 `ctx.tools.register` 的 `output.render`（宿主的真实调用点），
 * 以及它吃真实 handler 产出的信封。不断言内部函数名，也不改 `output.schema` / wire data。
 *
 * 关键约束（D26 + 宿主契约）：`render` 对每个成功调用都跑，抛一次就是 `INVALID_TOOL_OUTPUT`。
 * 所以病态 data 必须**降级**（可读文本）而不是抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { handleRoster } from '../dist/roster.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

/** 与 roster.test.mjs 同一套 Lead 现场：完整工具集（T23：没有容量声明可传）。 */
const FULL_TOOLS = {
  pwsh: {},
  read: {},
  write: {},
  glob: {},
  grep: {},
  job_list: {},
  job_output: {},
  job_kill: {},
  web_fetch: {},
  web_search: {},
  skill: {},
}


/** `$defs.rosterData` 的 12 个必备字段（wire shape；本票不动它）。 */
const ROSTER_DATA_KEYS = [
  'action', 'binding_ref', 'capacity', 'compatibility', 'gaps', 'posts', 'project_id',
  'project_root', 'proposal_hash', 'recommended_members', 'session_id', 'team_id',
]

/**
 * 走 `apply()` 拿到**宿主实际注册**的 `rt_roster`（不直接 import 内部函数：
 * 渲染是注册表上的公开面）。
 */
async function rosterTool() {
  const index = await import('../dist/index.js')
  const registered = new Map()
  const registry = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  index.apply({ tools: registry, get: () => undefined })
  const tool = registered.get('rt_roster')
  assert.ok(tool !== undefined, 'rt_roster 必须注册成功')
  assert.equal(typeof tool.output.render, 'function')
  return tool
}

/** 调 `output.render` 并拼成一段文本；同时钉住宿主只接受 `{type:'text',text}`。 */
function renderText(tool, value) {
  let blocks
  assert.doesNotThrow(() => {
    blocks = tool.output.render({}, value)
  }, 'render 不得抛（抛 = INVALID_TOOL_OUTPUT）')
  assert.ok(Array.isArray(blocks) && blocks.length >= 1)
  for (const block of blocks) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
  }
  return blocks.map((block) => block.text).join('\n')
}

/** 真 handler 产出的 `rosterData`（有 5 个岗位、5 条 gaps、4 个恒为「未知/不预留」的容量键）。 */
async function realisticEnvelope(t) {
  const project = makeTempProject({ t })
  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    tools: { lead: FULL_TOOLS },
  })
  const { envelope } = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.equal(envelope.status, 'ok')
  return envelope
}

/** 在真实信封上替换 `data` 的若干字段（其余保持合法），用来造未知/病态形状。 */
function envelopeWith(envelope, dataPatch) {
  return { ...envelope, data: { ...envelope.data, ...dataPatch } }
}

function dataWithout(envelope, keys) {
  const data = { ...envelope.data }
  for (const key of keys) delete data[key]
  return { ...envelope, data }
}

// ---------------------------------------------------------------------------
// 1. capacity：T23 起 render **不再**打印这一行（数据里仍是 wire 必备的 4 个键）
// ---------------------------------------------------------------------------

test('T23 capacity：render 不再打印容量行，但 data 里仍是 wire 要求的 4 个键', async (t) => {
  const tool = await rosterTool()
  const envelope = await realisticEnvelope(t)

  const text = renderText(tool, envelope)
  for (const field of ['remaining_member_slots', 'remaining_activations', 'reserved_member_slots', 'reserved_activations']) {
    assert.equal(text.includes(field), false, `render 不得再打印 ${field}：\n${text}`)
  }
  assert.equal(text.includes('capacity：'), false, 'render 不得再有 capacity 行')
  // 数据面不变（$defs.rosterData 仍要求这四个键；删字段要 Lead 改规格）
  assert.deepEqual(Object.keys(envelope.data.capacity).sort(), [
    'remaining_activations', 'remaining_member_slots', 'reserved_activations', 'reserved_member_slots',
  ])

  // 「现在用了几个席位」改由一条诊断承担 —— 它照样出现在渲染文本里（诊断段）。
  assert.ok(
    envelope.diagnostics.some((entry) => entry.code === 'TEAM_SEATS_USED'),
    '已用席位必须以诊断形式存在',
  )
  assert.match(text, /\[TEAM_SEATS_USED\]/u, `已用席位必须可读：\n${text}`)

  // render 必须纯：同一输入两次逐字相同
  assert.deepEqual(tool.output.render({}, envelope), tool.output.render({}, envelope))
})

// ---------------------------------------------------------------------------
// 2. gaps：每条打 code + 一行 reason（不再只有条数）
// ---------------------------------------------------------------------------

test('T20 gaps：至少一条 code 出现在渲染文本里（不再只有条数）', async (t) => {
  const tool = await rosterTool()
  const envelope = await realisticEnvelope(t)

  const codes = envelope.data.gaps.map((gap) => gap.code)
  assert.ok(codes.length > 0, '真实现场至少有一条 gap')
  const text = renderText(tool, envelope)

  for (const code of codes) {
    assert.ok(text.includes(code), `gap 的 code ${code} 必须出现在渲染文本里：\n${text}`)
  }
  // 「只打条数」的旧行为：文本里只有 `gaps：N`，没有条目。这里要求条目本身可读。
  const first = envelope.data.gaps[0]
  assert.ok(text.includes(first.reason), `gap 的 reason 必须可读（一行原文）：\n${text}`)
  assert.match(text, new RegExp(`gaps（${codes.length}）`, 'u'), `gaps 头部应带条数：\n${text}`)
})

// ---------------------------------------------------------------------------
// 3. 会话身份：session_id / team_id（A40 的判据就在这一层可观察）
// ---------------------------------------------------------------------------

test('T20 会话身份：session_id / team_id 出现在渲染文本里', async (t) => {
  const tool = await rosterTool()
  const envelope = await realisticEnvelope(t)

  const text = renderText(tool, envelope)
  assert.equal(typeof envelope.data.session_id, 'string')
  assert.equal(typeof envelope.data.team_id, 'string')
  assert.ok(text.includes(`session_id：${envelope.data.session_id}`), `session_id 必须可读：\n${text}`)
  assert.ok(text.includes(`team_id：${envelope.data.team_id}`), `team_id 必须可读：\n${text}`)
  // A40 还要求 project_id 由根决定（同一个根两次一致）—— 一并投影出来，才不必翻 operations/*.json
  assert.ok(text.includes(`project_id：${envelope.data.project_id}`), `project_id 必须可读：\n${text}`)

  // posts 仍是摘要：每个岗位一行 post_id + state，不整段 JSON
  const post = envelope.data.posts.find((entry) => entry.state === 'vacant')
  assert.ok(post !== undefined, '真实现场有 vacant 岗位')
  assert.match(text, new RegExp(`^- ${post.post_id}：vacant；要求 `, 'mu'), `岗位行应是 post_id + state + 能力族：\n${text}`)
  assert.equal(text.includes('"post_id"'), false, '不得把整段 JSON 倒进渲染')
  // 同一条缺口说明不重复打两遍：岗位行是摘要，细节留给下面的 gaps 段
  assert.equal(text.split(post.reason).length - 1, 1, `岗位缺口说明只应出现一次：\n${text}`)
})

// ---------------------------------------------------------------------------
// 4. 病态 data：不抛，降级成可读文本（render 的全能性）
// ---------------------------------------------------------------------------

test('T20 病态 data：缺 gaps / gaps 非数组 / capacity 为 null / posts 元素缺字段 → 不抛且可读', async (t) => {
  const tool = await rosterTool()
  const envelope = await realisticEnvelope(t)

  const cases = [
    ['缺 gaps', dataWithout(envelope, ['gaps'])],
    ['gaps 不是数组', envelopeWith(envelope, { gaps: '不-是-数组' })],
    ['gaps 元素是垃圾', envelopeWith(envelope, { gaps: [null, 42, {}, { code: 'CAPABILITY_MISSING' }, { reason: '只有原因' }] })],
    ['capacity 为 null', envelopeWith(envelope, { capacity: null })],
    ['capacity 缺字段', envelopeWith(envelope, { capacity: {} })],
    ['capacity 不是对象', envelopeWith(envelope, { capacity: ['x'] })],
    ['posts 不是数组', envelopeWith(envelope, { posts: { triage: 'assigned' } })],
    ['posts 元素缺字段', envelopeWith(envelope, { posts: [{ post_id: 'triage' }, {}, null, 42] })],
    ['identity 缺失', dataWithout(envelope, ['session_id', 'team_id', 'project_id'])],
    ['data 为 null', { ...envelope, data: null }],
  ]

  for (const [label, value] of cases) {
    const text = renderText(tool, value)
    assert.ok(text.length > 0, `${label}：仍要给出可读文本`)
    assert.match(text, /^rt_roster/u, `${label}：仍以工具名开头`)
    assert.equal(text.includes('undefined'), false, `${label}：不得把 undefined 写进文本：\n${text}`)
    assert.equal(text.includes('[object Object]'), false, `${label}：不得把对象直接拼进文本：\n${text}`)
    assert.equal(text.includes('NaN'), false, `${label}：不得把 NaN 写进文本：\n${text}`)
  }

  // 降级不吞信息：还能读到的那部分照常打出来
  const degraded = renderText(tool, dataWithout(envelope, ['gaps']))
  assert.ok(degraded.includes('gaps：无法读取（不是数组）'), `gaps 缺失要降级成可读文本：\n${degraded}`)
  assert.ok(degraded.includes(`session_id：${envelope.data.session_id}`), `session_id 仍可读：\n${degraded}`)

  const placeholder = renderText(tool, envelopeWith(envelope, { posts: [{ post_id: 'triage' }, {}] }))
  assert.ok(placeholder.includes('triage'), `有 post_id 的条目仍要打出来：\n${placeholder}`)
  assert.match(placeholder, /posts（2）/u, `条数仍要正确：\n${placeholder}`)
})

// ---------------------------------------------------------------------------
// 5. wire data 与 output.schema 不变（本票只改 render）
// ---------------------------------------------------------------------------

test('T20 只改 render：wire data 仍是 $defs.rosterData 的 12 个字段，output.schema 仍是 resultOutput', async (t) => {
  const tool = await rosterTool()
  const envelope = await realisticEnvelope(t)
  assert.deepEqual(Object.keys(envelope.data).sort(), ROSTER_DATA_KEYS, 'wire data 字段不得增删')
  assert.deepEqual(Object.keys(envelope.data.capacity).sort(), [
    'remaining_activations', 'remaining_member_slots', 'reserved_activations', 'reserved_member_slots',
  ], 'D19：capacity 恰好 4 个字段')

  const schema = await import('../dist/tool-schema.js')
  assert.deepEqual(tool.output.schema, schema.resultOutput, 'output.schema 不得改动')
})
