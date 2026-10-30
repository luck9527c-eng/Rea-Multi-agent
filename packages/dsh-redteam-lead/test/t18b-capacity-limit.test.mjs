/**
 * T18b：从宿主**自己的**拒绝消息里读出准确上限（被动观测，D1）。
 *
 * T18 的「撞一次就学」只能学到「你已经到顶了」（`used_at_observation`）。核对安装构建
 * `app.asar` 后发现宿主把真实数字写在消息里：
 *
 * - `ACTIVATION_LIMIT_REACHED` → `subagent limit reached (active child limit: N); …`
 * - `TEAM_MEMBER_LIMIT`        → `Team member limit N reached`
 *
 * 断言只看**公开行为**：`re/team/capacity-observed.json` 里到底写了什么、诊断文本怎么解释
 * 这个数字的来源（解析 / 回落 / 沿用）、以及后续 `rt_roster` 是否真的按学到的数字算余量。
 * 五个行为用例（ticket 编号）+ 两个守卫用例（解析只认两条稳定码、标记带 mtime）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { handleDispatch } from '../dist/dispatch.js'
import { handleRoster } from '../dist/roster.js'
import { capacityMarkerGuard, parseHostCapacityLimit, readObservationMarker } from '../dist/capacity-source.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

const OBSERVED_PATH = 're/team/capacity-observed.json'
const OBSERVING_PATH = 're/team/capacity-observing.json'

/** 宿主原文格式（逐字来自 `@deepseek-ai/dsh-subagent/lib/index.js:1047`）。 */
const activationMessage = (limit) =>
  `subagent limit reached (active child limit: ${limit}); wait for an existing child to finish or complete the current one`

/** 宿主原文格式（逐字来自 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1024`）。 */
const memberMessage = (limit) => `Team member limit ${limit} reached`

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

/**
 * 未声明容量的派发项目（与 T18 的 `dispatchFixture` 同形状）。
 *
 * 容量必须**未声明**：这正是「撞一次就学」唯一会发生的场合。
 *
 * `members` 预置队友：观测值的兜底口径是「观测当时的已用席位」，而 `used === 0` 时
 * `recordCapacityObservation` 会拒绝落盘（0 不能当上限）。`TEAM_MEMBER_LIMIT` 在真实宿主里
 * 只可能在 `used >= maxMembers >= 1` 时发生，所以成员席位满的用例必须给一个已用席位。
 */
function dispatchFixture(t, { members = [] } = {}) {
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
    teamOpts: { members },
    projectOpts: { routes: { 'R-001': ROUTE }, seals: [] },
    capacity: { known: false },
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

/** 所有诊断拼成一段文本（诊断才是模型看到的那一层，D21）。 */
function diagnosticText(envelope) {
  const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : {}
  const gaps = Array.isArray(data.gaps) ? data.gaps : []
  const entries = [...(envelope.diagnostics ?? []), ...gaps]
  return entries.map((entry) => `${entry.code}|${entry.reason}|${entry.next_step}`).join('\n')
}

// ---------------------------------------------------------------------------
// 1 — ACTIVATION_LIMIT_REACHED 里是 **activation 池** 的真实大小
// ---------------------------------------------------------------------------

test('T18b-1 `active child limit: 4` → max_active_subagents=4（不是已用席位数）', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t)
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: activationMessage(4) })

  const { envelope } = await handleDispatch(ctx, input())

  assert.equal(envelope.status, 'partial', '席位已烧 → 部分完成')
  assert.equal(envelope.code, 'CAPACITY_EXHAUSTED')

  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(observed.max_active_subagents, 4, '真实 activation 池大小来自宿主消息，不是 used=1')
  assert.equal(
    observed.max_members,
    1,
    '这条消息没说成员上限 → 该维度仍回落为观测当时已用席位（保守下限，T18 的语义不变）',
  )
  assert.deepEqual(observed.basis, {
    host_code: 'ACTIVATION_LIMIT_REACHED',
    parsed_limit: 4,
    used_at_observation: 1,
    message: activationMessage(4),
  }, 'basis 必须是四字段的并集，且留下原文以便复核')

  assert.match(diagnosticText(envelope), /4/u, '诊断必须把学到的数字说出来')
})

// ---------------------------------------------------------------------------
// 2 — TEAM_MEMBER_LIMIT 里是 **成员席位数** 的真实上限
// ---------------------------------------------------------------------------

test('T18b-2 `Team member limit 6 reached` → max_members=6，且余量按 6-1 算', async (t) => {
  // 预置 1 名队友：成员席位满在 used=0 时不可能发生（T18c），观测值才有真实口径。
  const { project, ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(6) })

  const { envelope } = await handleDispatch(ctx, input())
  assert.equal(envelope.status, 'partial')

  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(observed.max_members, 6, '学到的是准确 6，不是「到顶了」的 used=1')
  assert.equal(observed.max_active_subagents, 1, '这条消息没说 activation 池 → 回落为 used')
  assert.equal(observed.basis.parsed_limit, 6)
  assert.equal(observed.basis.host_code, 'TEAM_MEMBER_LIMIT')
  assert.equal(observed.basis.used_at_observation, 1)

  // 学到的数字必须真的被用上：上限 6、已用 1、提议预留 1 → 还能再开 4 个。
  // （T18 的 used 代理上限会算成 1-1-1 → 0，这正是本票要修的那个缺陷。）
  const roster = await handleRoster(ctx, { project_root: project.root, target_kinds: ['binary'] })
  assert.equal(roster.envelope.data.capacity.remaining_member_slots, 4, '余量必须按准确的 6 算：6-1（已用）-1（预留）')
  assert.match(diagnosticText(roster.envelope), /capacity_source=observed/u)
  assert.match(diagnosticText(roster.envelope), /解析|准确/u, '诊断要说明这个数字是解析出来的')
})

// ---------------------------------------------------------------------------
// 3 — 消息格式不认识 → 回落，且不抛
// ---------------------------------------------------------------------------

test('T18b-3 消息里没有可解析的数字 → 回落为 used_at_observation，不抛，诊断说明是回落', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t)
  // 宿主未来改措辞的样子：同一个稳定码、文案里没有数字。
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })

  const { envelope } = await handleDispatch(ctx, input())

  assert.equal(envelope.status, 'partial', '解析失败绝不能变成异常：仍然按容量碰撞收口')
  assert.equal(envelope.code, 'CAPACITY_EXHAUSTED')

  const observed = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(observed.max_members, 1, '取不到准确值 → 回落为观测当时已用席位')
  assert.equal(observed.max_active_subagents, 1)
  assert.equal(observed.basis.parsed_limit, null, '回落必须如实记成 null')
  assert.equal(observed.basis.used_at_observation, 1)
  assert.equal(observed.basis.message, 'subagent limit reached', '原文要留下，便于日后核对是不是改措辞了')

  assert.match(diagnosticText(envelope), /回落|回退/u, '诊断必须写清这个上限是回落值')
})

// ---------------------------------------------------------------------------
// 4 — 不可解析的碰撞不得把已解析的准确值降级
// ---------------------------------------------------------------------------

test('T18b-4 已有解析值，再撞一次但消息不可解析 → 保留原值、不降级、不改 observed_at', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })

  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(6) })
  await handleDispatch(ctx, input())
  const accurate = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(accurate.max_members, 6)
  assert.equal(accurate.basis.parsed_limit, 6)

  // 时间前进来证明「第二条消息没有把文件重写一遍」。
  ctx.fakes.clock.advance(60_000)
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached (host wording changed)' })
  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))

  assert.equal(second.envelope.status, 'partial', '第二次碰撞照样按容量碰撞收口')

  const after = await readJsonFile(project.root, OBSERVED_PATH)
  assert.deepEqual(after, accurate, '不可解析的一撞不得改写已经解析出来的准确值（含 observed_at）')
  assert.equal(after.max_members, 6, '准确值必须留着：它仍然成立，只是这次没重新读到')

  assert.match(diagnosticText(second.envelope), /沿用|保留|不降级/u, '诊断要说明这次沿用了已有的解析值')
})

// ---------------------------------------------------------------------------
// 5 — 解析出不同的 N → 覆盖并更新 observed_at
// ---------------------------------------------------------------------------

test('T18b-5 同会话再撞一次且解析出不同的 N → 覆盖数值并更新 observed_at', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })

  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(6) })
  await handleDispatch(ctx, input())
  const first = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(first.max_members, 6)

  // 用户在设置里把上限改小了：下一次撞到的消息会带新的数字（ticket：值可能因改设置失效）。
  ctx.fakes.clock.advance(60_000)
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(3) })
  await handleDispatch(ctx, input({ operation_id: 'op-2' }))

  const after = await readJsonFile(project.root, OBSERVED_PATH)
  assert.equal(after.max_members, 3, '新的准确值必须覆盖旧的')
  assert.equal(after.basis.parsed_limit, 3)
  assert.equal(
    after.basis.used_at_observation,
    1,
    '两次都是成员席位满：宿主在写成员行之前就拒绝，已用席位不得凭空 +1（T18c）',
  )
  assert.equal(after.basis.message, memberMessage(3))
  assert.notEqual(after.observed_at, first.observed_at, '覆盖必须更新 observed_at（值可能因改设置而失效）')
  assert.match(after.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u)
})

// ---------------------------------------------------------------------------
// 守卫：只认两条稳定码，不把任意宿主消息拿去正则
// ---------------------------------------------------------------------------

test('T18b-6 只对 ACTIVATION_LIMIT_REACHED / TEAM_MEMBER_LIMIT 解析', () => {
  assert.deepEqual(parseHostCapacityLimit('ACTIVATION_LIMIT_REACHED', activationMessage(4)), {
    pattern: 'active_child_limit',
    limit: 4,
  })
  assert.deepEqual(parseHostCapacityLimit('TEAM_MEMBER_LIMIT', memberMessage(6)), {
    pattern: 'team_member_limit',
    limit: 6,
  })

  // 别的宿主码即使文案里恰好带这些字样，也不解析（T18b 边界）。
  assert.deepEqual(parseHostCapacityLimit('TEAM_TASK_STALE_REVISION', memberMessage(6)), { pattern: null, limit: null })
  assert.deepEqual(parseHostCapacityLimit(null, activationMessage(4)), { pattern: null, limit: null })
  assert.deepEqual(parseHostCapacityLimit('ACTIVATION_LIMIT_REACHED', null), { pattern: null, limit: null })

  // 数字不合法（0）→ 不解析，交给回落路径。
  assert.equal(parseHostCapacityLimit('ACTIVATION_LIMIT_REACHED', 'active child limit: 0').limit, null)
})

// ---------------------------------------------------------------------------
// 守卫：残留的「观测中」标记要能判断是不是崩溃残骸
// ---------------------------------------------------------------------------

test('T18b-7 「观测中」标记的诊断带文件 mtime（判断是否为崩溃残骸）', async (t) => {
  const project = makeTempProject({ t })
  await writeJsonFile(project.root, OBSERVING_PATH, {
    schema_version: 1,
    session_id: 'session-x',
    started_at: '2026-10-30T00:00:00Z',
    member: 'rt-cross-check-2',
    operation_id: 'op-concurrent',
  })

  const marker = await readObservationMarker(project.root)
  assert.equal(marker.present, true)
  assert.match(marker.modified_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, '读标记时必须拿到文件 mtime')

  const info = await stat(path.join(project.root, ...OBSERVING_PATH.split('/')))
  assert.equal(marker.modified_at, info.mtime.toISOString(), 'mtime 必须是这个文件的，便于判断残骸新旧')

  const guard = capacityMarkerGuard(marker, 'session-x')
  assert.equal(guard.blocked, true)
  const text = `${guard.reason}\n${guard.next_step}`
  assert.match(text, /2026-10-30T00:00:00Z/u, '必须给出文件里记的 started_at')
  assert.match(text, new RegExp(info.mtime.toISOString().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), '必须给出文件 mtime')
  assert.match(text, /崩溃|残骸|手工删除|手工删/u, '必须告诉操作者这可能是一次崩溃留下的残骸，可以核对后删掉')
})
