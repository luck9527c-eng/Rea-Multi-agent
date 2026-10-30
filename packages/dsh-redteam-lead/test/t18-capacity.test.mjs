/**
 * T18：容量改为「按调用声明」+ 未声明时「照派、撞一次就学」。
 *
 * 断言只看**公开行为**：wire schema 是否接受 `capacity`、`rosterData.capacity` 的四个投影字段、
 * `proposal_hash` 是否随生效容量变化、回执的 status/code/diagnostics、`re/team/` 里到底写了什么、
 * 以及宿主替身收到的调用与名字（D12：绝不同名重试）。
 *
 * 七条（ticket 编号 → 用例）：
 * 1. 按调用 capacity 覆盖项目文件 → T1；dispatch 侧同一条 → T1b；
 * 2. 同一提议、不同 capacity → proposal_hash 不同（call/project → T2；observed → T5）；
 * 3. 容量 unknown → rt_dispatch 不再拒绝，改为明确警告 → T3；
 * 4. 宿主 ACTIVATION_LIMIT_REACHED → 写 capacity-observed.json、partial、点名成员/hostCode → T4；
 * 5. 观测值在同会话后续 roster/dispatch 生效（capacity_source: observed）→ T5；
 * 6. 观测值来自别的会话 → 不生效 → T6；
 * 7. 并发保护：无已知容量 + 已有「观测中」标记 → 明确拒绝 → T7。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { handleDispatch } from '../dist/dispatch.js'
import { handleRoster } from '../dist/roster.js'
import { validateInput } from '../dist/validate.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

const SPEC = JSON.parse(
  await readFile(new URL('../../../docs/specs/rt-tools.schema.json', import.meta.url), 'utf8'),
)

const OBSERVED_PATH = 're/team/capacity-observed.json'
const OBSERVING_PATH = 're/team/capacity-observing.json'

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

const SAMPLE_BYTES = 'SAMPLE-BYTES-0123456789'

const ROUTE = Object.freeze({
  schema_version: 1,
  id: 'R-001',
  status: 'active',
  target_ids: ['T-001'],
  problem: '样本的导入表是否暴露可疑能力',
  hypothesis: '导入表指向的可疑 API 构成触发链',
  criteria: ['可核验定位', '至少一次有效运行'],
  budget: { max_runs: 3 },
  depends_on: [],
})

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 只做 roster 的项目（带项目级容量声明，用来证明 per-call 覆盖它）。 */
function rosterFixture(t, { maxMembers = 8 } = {}) {
  const project = makeTempProject({ t })
  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: { known: true, maxMembers, maxActiveSubagents: 8, via: 'project' },
    tools: { lead: FULL_TOOLS },
  })
  return { project, ctx }
}

function dispatchFixture(t, options = {}) {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': SAMPLE_BYTES,
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', name: 'sample', path: 're/samples/sample.bin' }],
      }),
      're/team/resources.json': JSON.stringify({
        schema_version: 1,
        revision: 0,
        aliases: { sample: { physical_identity: 'file:T-001', immutable_read: true } },
        leases: [],
      }),
    },
  })

  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    teamOpts: { members: options.members ?? [] },
    projectOpts: { routes: { 'R-001': ROUTE }, seals: [] },
    capacity: options.capacity ?? { known: false },
    tools: { lead: FULL_TOOLS },
  })

  const input = (over = {}) => ({
    project_root: project.root,
    operation_id: 'op-1',
    post_id: 'cross-check',
    route_id: 'R-001',
    target_ids: ['T-001'],
    objective: '确认样本导入表与可疑字符串，交回可核验定位',
    evidence_required: ['artifact_locator'],
    prohibited: ['不要执行样本'],
    ...over,
  })

  return { project, ctx, team: ctx.fakes.team, input }
}

async function readJsonFile(root, relative) {
  return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8'))
}

async function writeJsonFile(root, relative, value) {
  const target = path.join(root, ...relative.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 所有诊断拼成一段文本（诊断才是模型真正看到的那一层，D21）。
 *
 * 两个通道都要看：`rt_dispatch` 走 `result.diagnostics`，`rt_roster` 的缺口按
 * `$defs.rosterData.gaps` 上报（T5 的既有形状）。
 */
function diagnosticText(envelope) {
  const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : {}
  const gaps = Array.isArray(data.gaps) ? data.gaps : []
  const entries = [...(envelope.diagnostics ?? []), ...gaps]
  return entries.map((entry) => `${entry.code}|${entry.reason}|${entry.next_step}`).join('\n')
}

// ---------------------------------------------------------------------------
// T0 — wire schema：两个入参都接受可选的 capacity
// ---------------------------------------------------------------------------

test('T0 wire schema 接受可选 capacity（rosterInput 与 dispatchInput）', () => {
  const capacity = { max_members: 2, max_active_subagents: 4 }

  const roster = validateInput(SPEC, 'rosterInput', { project_root: 'D:\\p', capacity })
  assert.deepEqual(roster.issues, [], 'rosterInput 必须接受 capacity')

  const dispatchOk = validateInput(SPEC, 'dispatchInput', {
    project_root: 'D:\\p',
    operation_id: 'op-1',
    post_id: 'cross-check',
    route_id: 'R-001',
    target_ids: ['T-001'],
    objective: '确认导入表',
    evidence_required: ['artifact_locator'],
    prohibited: [],
    capacity,
  })
  assert.deepEqual(dispatchOk.issues, [], 'dispatchInput 必须接受 capacity')

  // 两个字段都必填、都必须是 >=1 的整数
  for (const [label, value] of [
    ['缺 max_active_subagents', { max_members: 2 }],
    ['max_members 为 0', { max_members: 0, max_active_subagents: 4 }],
    ['max_active_subagents 非整数', { max_members: 2, max_active_subagents: 1.5 }],
    ['多了未知字段', { max_members: 2, max_active_subagents: 4, max_extra: 1 }],
  ]) {
    const checked = validateInput(SPEC, 'rosterInput', { project_root: 'D:\\p', capacity: value })
    assert.equal(checked.ok, false, `${label} 必须被拒`)
  }
})

// ---------------------------------------------------------------------------
// T1 — 按调用的 capacity 覆盖项目文件
// ---------------------------------------------------------------------------

test('T1 按调用声明 capacity 覆盖 re/team/capacity.json（8 → 2），并记 capacity_source=call', async (t) => {
  const { project, ctx } = rosterFixture(t)

  const declared = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.equal(declared.envelope.status, 'ok')
  assert.equal(declared.envelope.data.capacity.remaining_member_slots, 7, '项目声明 8、已用 0、预留 1')
  assert.equal(declared.envelope.data.recommended_members, 2)

  const called = await handleRoster(ctx, {
    project_root: project.root,
    target_kinds: ['binary'],
    capacity: { max_members: 2, max_active_subagents: 4 },
  })
  assert.equal(called.envelope.status, 'ok')
  assert.equal(
    called.envelope.data.capacity.remaining_member_slots,
    1,
    '提议必须按本次调用声明的 2 算，而不是项目文件里的 8',
  )
  assert.equal(called.envelope.data.recommended_members, 1, '席位只够 1 个新成员')
  assert.notEqual(
    called.envelope.data.proposal_hash,
    declared.envelope.data.proposal_hash,
    '生效容量变了，提议必须换 hash（否则 bind 会沿过期提议落盘）',
  )

  const text = diagnosticText(called.envelope)
  assert.match(text, /capacity_source=call/u, '诊断里必须能回答「当时它以为上限是多少」')
  assert.match(text, /2/u)
})

test('T1b rt_dispatch 同样按调用声明 capacity，且优先于项目文件', async (t) => {
  const { ctx, team, input } = dispatchFixture(t, {
    capacity: { known: true, maxMembers: 8, maxActiveSubagents: 8, via: 'project' },
    members: [{ name: 'rt-other' }],
  })

  const tooTight = await handleDispatch(ctx, input({ capacity: { max_members: 1, max_active_subagents: 4 } }))
  assert.equal(tooTight.envelope.status, 'blocked')
  assert.equal(tooTight.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(team.callsFor('spawnTeammate').length, 0, '前置拒绝必须零副作用')

  const allowed = await handleDispatch(ctx, input({
    operation_id: 'op-2',
    capacity: { max_members: 2, max_active_subagents: 4 },
  }))
  assert.equal(allowed.envelope.status, 'ok')
  assert.equal(team.callsFor('spawnTeammate').length, 1)
  assert.match(diagnosticText(allowed.envelope), /capacity_source=call/u)
})

// ---------------------------------------------------------------------------
// T2 — proposal_hash 随生效容量变化（call / project）
// ---------------------------------------------------------------------------

test('T2 同一提议、不同 capacity → proposal_hash 不同（call 与 project 各一例）', async (t) => {
  const { project, ctx } = rosterFixture(t)

  const two = await handleRoster(ctx, {
    project_root: project.root, target_kinds: ['binary'], capacity: { max_members: 2, max_active_subagents: 4 },
  })
  const again = await handleRoster(ctx, {
    project_root: project.root, target_kinds: ['binary'], capacity: { max_members: 2, max_active_subagents: 4 },
  })
  const three = await handleRoster(ctx, {
    project_root: project.root, target_kinds: ['binary'], capacity: { max_members: 3, max_active_subagents: 4 },
  })
  assert.equal(again.envelope.data.proposal_hash, two.envelope.data.proposal_hash, '同样的输入必须同一个 hash')
  assert.notEqual(three.envelope.data.proposal_hash, two.envelope.data.proposal_hash, 'max_members 变了必须换 hash')

  // 项目声明也算「预算」：8 → 2 必须换 hash（与 T15 的 declared_budget 一致）
  const eight = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  project.write('re/team/capacity.json', {
    schema_version: 1,
    declared_at: '2026-10-30T00:00:00Z',
    declared_by: 'operator',
    maxMembers: 2,
    maxActiveSubagents: 8,
  })
  const shrunk = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.notEqual(shrunk.envelope.data.proposal_hash, eight.envelope.data.proposal_hash)
})

test('T2b 容量变了之后用旧 proposal_hash bind → OPERATION_CONFLICT，且不写 binding', async (t) => {
  const { project, ctx } = rosterFixture(t)

  const inspected = await handleRoster(ctx, {
    project_root: project.root, target_kinds: ['binary'], capacity: { max_members: 3, max_active_subagents: 4 },
  })
  const hash = inspected.envelope.data.proposal_hash

  const bound = await handleRoster(ctx, {
    project_root: project.root,
    target_kinds: ['binary'],
    action: 'bind',
    operation_id: 'op-bind-budget-changed',
    proposal_hash: hash,
    capacity: { max_members: 2, max_active_subagents: 4 },
  })
  assert.equal(bound.envelope.status, 'blocked')
  assert.equal(bound.envelope.code, 'OPERATION_CONFLICT')
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
})

// ---------------------------------------------------------------------------
// T3 — 未声明容量：不再拒绝，改为明确警告
// ---------------------------------------------------------------------------

test('T3 容量 unknown → rt_dispatch 照派，并明确说明「未声明 / 不保证有位置 / 最多损失一个名字与席位」', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: { known: false } })

  const { envelope } = await handleDispatch(ctx, input())

  assert.equal(envelope.status, 'ok', '未知容量不再拒绝（T18 的核心行为变化）')
  assert.notEqual(envelope.code, 'CAPACITY_UNKNOWN')
  assert.equal(team.callsFor('spawnTeammate').length, 1, '照派必须真的去创建')

  const text = diagnosticText(envelope)
  assert.match(text, /capacity_source=unknown/u, '必须能在诊断里回答「当时它以为上限是多少」')
  assert.match(text, /未声明/u, '必须明说容量未声明')
  assert.match(text, /不保证/u, '必须明说本次创建不保证有位置')
  assert.match(text, /损失/u, '必须明说最多可能损失一个成员名与席位')
  assert.match(text, /名字|成员名/u)

  // 没有碰撞就没有观测值：不能凭空写一个上限
  assert.equal(existsSync(path.join(project.root, ...OBSERVED_PATH.split('/'))), false)
})

// ---------------------------------------------------------------------------
// T4 — 宿主拒绝 spawn：写观测值、返回 partial、点名成员与 hostCode、不同名重试
// ---------------------------------------------------------------------------

test('T4 宿主 ACTIVATION_LIMIT_REACHED → 写 capacity-observed.json（max_members = 当时已用席位），partial 并点名', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: { known: false } })
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })

  const { envelope } = await handleDispatch(ctx, input())

  assert.equal(envelope.status, 'partial', '席位已烧 → 部分完成，不是前置拒绝')
  assert.equal(envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(envelope.data.phase, 'member_ready')
  assert.equal(envelope.data.member, 'rt-cross-check', '回执必须点名被烧掉的成员')

  const text = diagnosticText(envelope)
  assert.match(text, /rt-cross-check/u, '诊断必须点名被烧掉的成员名')
  assert.match(text, /ACTIVATION_LIMIT_REACHED/u, '诊断必须带上宿主原始码')
  assert.match(text, /capacity-observed\.json/u, '诊断必须说明观测值写到了哪里')
  assert.match(text, /D12|不要用同名|不得同名/u, '必须说明不得同名重试')

  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(observed.schema_version, 1)
  assert.equal(observed.max_members, 1, '观测当时的已用席位 = 1（失败成员已计入席位）')
  assert.equal(observed.max_active_subagents, 1, 'activation 占用不可观测 → 取同一个保守下限')
  assert.equal(observed.basis.used_at_observation, 1)
  assert.equal(observed.basis.host_code, 'ACTIVATION_LIMIT_REACHED')
  assert.equal(typeof observed.session_id, 'string')
  assert.ok(observed.session_id.length > 0, '观测值必须绑定会话')
  assert.match(observed.observed_at, /^\d{4}-\d{2}-\d{2}T/u)

  // D12：只尝试一次，且绝不同名重试；「观测中」标记必须清掉
  assert.equal(team.callsFor('spawnTeammate').length, 1)
  assert.deepEqual(team.callsFor('spawnTeammate').map((call) => call.args[1].name), ['rt-cross-check'])
  assert.equal(existsSync(path.join(project.root, ...OBSERVING_PATH.split('/'))), false)
})

// ---------------------------------------------------------------------------
// T5 — 观测值在同会话后续生效
// ---------------------------------------------------------------------------

test('T5 同会话后续 rt_roster(inspect) 与 rt_dispatch 都按 observed 生效（capacity_source=observed）', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: { known: false } })

  const before = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  const unknownHash = before.envelope.data.proposal_hash
  assert.equal(before.envelope.data.capacity.remaining_member_slots, null, '观测之前上限未知')

  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })
  await handleDispatch(ctx, input())

  const after = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.match(diagnosticText(after.envelope), /capacity_source=observed/u, 'roster 必须报 observed')
  assert.equal(after.envelope.data.capacity.remaining_member_slots, 0, '已到顶：1 席已用、1 席上限')
  assert.notEqual(after.envelope.data.proposal_hash, unknownHash, '观测到的上限必须进 proposal_hash')

  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assert.equal(second.envelope.status, 'blocked')
  assert.equal(second.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(team.callsFor('spawnTeammate').length, 1, '学到上限之后不得再烧名字与席位')
})

// ---------------------------------------------------------------------------
// T6 — 观测值按会话生效：别的会话不套用
// ---------------------------------------------------------------------------

test('T6 别的会话观测到的上限不生效（仍 unknown），并说明原因', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: { known: false } })

  const before = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  const unknownHash = before.envelope.data.proposal_hash

  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })
  await handleDispatch(ctx, input())

  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  await writeJsonFile(project.root, OBSERVED_PATH, { ...observed, session_id: 'session-from-another-lead' })

  const after = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.doesNotMatch(diagnosticText(after.envelope), /capacity_source=observed/u, '别的会话的观测值不得套用')
  assert.equal(after.envelope.data.capacity.remaining_member_slots, null)
  assert.equal(after.envelope.data.proposal_hash, unknownHash, '未生效的观测值不得进 hash')

  // 未被套用也要说清楚（不能静默丢一个上限）
  assert.match(diagnosticText(after.envelope), /会话|session/u)

  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assert.equal(second.envelope.status, 'ok', 'unknown → 照派')
  assert.equal(team.callsFor('spawnTeammate').length, 2)
  assert.equal(second.envelope.data.member, 'rt-cross-check-2', 'D12：换个名字，不同名重试')
})

// ---------------------------------------------------------------------------
// T7 — 并发保护
// ---------------------------------------------------------------------------

test('T7 无已知容量 + 已有「观测中」标记 → 第二次派发明确拒绝；别的会话的标记不挡', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: { known: false } })

  // 会话 id 用**公开产物**取得：一次真实碰撞写出的观测值（不猜、不读私有字段）
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })
  await handleDispatch(ctx, input())
  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  await rm(path.join(project.root, ...OBSERVED_PATH.split('/')))

  await writeJsonFile(project.root, OBSERVING_PATH, {
    schema_version: 1,
    session_id: observed.session_id,
    started_at: '2026-10-30T00:00:00Z',
    member: 'rt-cross-check-2',
    operation_id: 'op-concurrent',
  })

  const blocked = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assert.equal(blocked.envelope.status, 'blocked')
  assert.equal(blocked.envelope.code, 'CAPACITY_UNKNOWN')
  const blockedText = diagnosticText(blocked.envelope)
  assert.match(blockedText, /观测中|正在观测/u, '必须明说另一次观测正在进行')
  assert.match(blockedText, /capacity-observing\.json/u, '必须点名标记文件')
  assert.equal(team.callsFor('spawnTeammate').length, 1, '拒绝必须零副作用：不撞第二次')

  // 别的会话的标记：席位随会话重置，不该挡住本会话
  await writeJsonFile(project.root, OBSERVING_PATH, {
    schema_version: 1,
    session_id: 'session-from-another-lead',
    started_at: '2026-10-30T00:00:00Z',
    member: 'rt-cross-check-2',
    operation_id: 'op-other-session',
  })
  const proceeded = await handleDispatch(ctx, input({ operation_id: 'op-3' }))
  assert.equal(proceeded.envelope.status, 'ok', '别的会话的标记不得挡住本会话')
  assert.equal(team.callsFor('spawnTeammate').length, 2)
  assert.equal(proceeded.envelope.data.member, 'rt-cross-check-2')
})

// ---------------------------------------------------------------------------
// 台账：capacity_source 必须落进 operation 台账
// ---------------------------------------------------------------------------

test('capacity_source 落进 operation 台账（出问题能回答「当时它以为上限是多少」）', async (t) => {
  const { project, ctx, input } = dispatchFixture(t, { capacity: { known: false } })

  const { envelope } = await handleDispatch(ctx, input())
  assert.equal(envelope.status, 'ok')

  const record = await readJsonFile(project.root, `re/team/operations/${input().operation_id}.json`)
  assert.equal(record.data.capacity_source, 'unknown')
})

test('按调用声明时，台账里的 capacity_source 是 call', async (t) => {
  const { project, ctx, input } = dispatchFixture(t, {
    capacity: { known: true, maxMembers: 8, maxActiveSubagents: 8, via: 'project' },
  })

  const { envelope } = await handleDispatch(ctx, input({
    capacity: { max_members: 2, max_active_subagents: 4 },
  }))
  assert.equal(envelope.status, 'ok')
  const record = await readJsonFile(project.root, `re/team/operations/${input().operation_id}.json`)
  assert.equal(record.data.capacity_source, 'call')
  assert.equal(record.data.capacity_max_members, 2)
})
