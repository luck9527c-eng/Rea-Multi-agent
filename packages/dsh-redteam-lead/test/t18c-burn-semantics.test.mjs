/**
 * T18c：两条宿主容量拒绝的**损坏语义不同** —— 名字与席位到底有没有被烧掉。
 *
 * 宿主源码（安装构建 `_agent-team.js:1021-1030`，checkout `roster.ts:252-261`）：
 *
 * - `TEAM_MEMBER_LIMIT` 在 `journal.appendAndFlush` **之前**抛 → 根本没有成员行，
 *   名字仍然空闲、席位没有消耗。容量解决后**同名重试是合法的**。
 * - `ACTIVATION_LIMIT_REACHED` 在成员行 append **之后**抛（`subagents.startActivation`），
 *   catch 里把该行 settle 成 `phase:'failed'` → 名字与席位都被烧掉，不得同名重试（D12）。
 *
 * 所以诊断不能一句话覆盖两种情况：把「名字还在」说成「已烧掉」，会让 Lead 放弃一个还能用的
 * 名字、跳过唯一一次本该成功的重试。这与 T15 的假绿是同一类错误 —— 替身编了一个不存在的
 * 损失，测试再给那个损失背书。
 *
 * 断言只看公开行为：诊断文本、`rt_dispatch` 下一次派发实际用的名字、以及名册/席位数的变化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { handleDispatch } from '../dist/dispatch.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

const SAMPLE_BYTES = 'SAMPLE-BYTES-0123456789'

/** 宿主原文格式（`Team member limit N reached` / `active child limit: N`）。 */
const memberMessage = (limit) => `Team member limit ${limit} reached`
const activationMessage = (limit) =>
  `subagent limit reached (active child limit: ${limit}); wait for an existing child to finish or complete the current one`

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

/**
 * 声明了容量的派发现场（容量足够，所以「容量解决后同名重试」这一步不会被闸门挡住）。
 *
 * `members` 预置一名队友：成员席位满在 `used === 0` 时不可能发生（`maxMembers >= 1`），
 * 而 `used` 是所有观测值的兜底口径，替身必须给一个真实可发生的现场。
 */
function dispatchFixture(t, { members = [], maxMembers = 8, maxActiveSubagents = 8 } = {}) {
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
    capacity: { known: true, maxMembers, maxActiveSubagents, via: 'project' },
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

/** 所有诊断拼成一段文本（诊断才是模型看到的那一层，D21）。 */
function diagnosticText(envelope) {
  const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : {}
  const gaps = Array.isArray(data.gaps) ? data.gaps : []
  const entries = [...(envelope.diagnostics ?? []), ...gaps]
  return entries.map((entry) => `${entry.code}|${entry.reason}|${entry.next_step}`).join('\n')
}

/** 名册里这个名字到底有没有行（`listMembers` 是公开面，不读替身内部）。 */
function rosterNames(team) {
  return team.service
    .listMembers(team.agent)
    .filter((row) => row.role === 'teammate')
    .map((row) => row.name)
}

// ---------------------------------------------------------------------------
// 1 — TEAM_MEMBER_LIMIT：没有成员行 → 名字还在、席位没少 → 同名重试成功
// ---------------------------------------------------------------------------

test('T18c-1 成员席位满不烧名字与席位：诊断直说「没被占用」，同名重试成功', async (t) => {
  const { ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  // 宿主在 append 之前就拒绝：现场是「1 席已用、上限 1 席」。
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(1) })

  const seatsBefore = team.snapshot().teammates
  const first = await handleDispatch(ctx, input())

  assert.equal(first.envelope.status, 'partial')
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')

  // 席位没有被这次拒绝消耗，名册里也没有那个名字的行。
  assert.equal(team.snapshot().teammates, seatsBefore, '成员席位满发生在写成员行之前：席位不得增加')
  assert.equal(rosterNames(team).includes('rt-cross-check'), false, '拒绝之后名字仍然空闲')

  const text = diagnosticText(first.envelope)
  assert.match(text, /没有被占用/u, '必须直说这个名字没有被占用')
  assert.match(text, /没有消耗席位/u, '必须直说没有消耗席位')
  assert.match(text, /同名/u, '必须告诉 Lead 可以同名重试')
  assert.doesNotMatch(text, /已被烧掉/u, '名字还在时不得说「已烧掉」（那是过度声明）')
  assert.doesNotMatch(text, /不得同名重试/u, '名字还在时不得禁止同名重试')

  // 真实行为：容量足够时，下一次派发就用同一个名字，并且成功。
  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assert.equal(second.envelope.status, 'ok', '同名重试必须能成功')
  assert.equal(second.envelope.data.member, 'rt-cross-check', '名字没被烧掉 → 不需要 -2')
  assert.deepEqual(
    team.callsFor('spawnTeammate').map((call) => call.args[1].name),
    ['rt-cross-check', 'rt-cross-check'],
    '两次都用同一个名字',
  )
  assert.equal(team.snapshot().teammates, seatsBefore + 1, '重试成功才占一个席位')
})

// ---------------------------------------------------------------------------
// 2 — ACTIVATION_LIMIT_REACHED：成员行已 append 后失败 → 名字与席位都被烧掉
// ---------------------------------------------------------------------------

test('T18c-2 activation 池满烧掉名字与席位：同名重试被宿主拒绝，下一次必须用 -2', async (t) => {
  const { ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: activationMessage(2) })

  const seatsBefore = team.snapshot().teammates
  const first = await handleDispatch(ctx, input())

  assert.equal(first.envelope.status, 'partial')
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(team.snapshot().teammates, seatsBefore + 1, '失败成员占掉一个席位（D12）')
  assert.equal(rosterNames(team).includes('rt-cross-check'), true, '失败行留在名册里')

  const text = diagnosticText(first.envelope)
  assert.match(text, /该名字与席位已被烧掉/u, '名字与席位确实被烧掉了，必须直说')
  assert.match(text, /不得同名重试|不要用同名/u, '必须禁止同名重试')

  // 同名重试由宿主自己拒绝（不是我们这边猜的）。
  const sameName = await team.service.spawnTeammate(team.agent, {
    name: 'rt-cross-check',
    description: 'd',
    prompt: [{ type: 'text', text: 'p' }],
    context: 'fresh',
    provider: 'spawn',
    signal: new AbortController().signal,
  }).then(() => null, (error) => error.code)
  assert.equal(sameName, 'TEAM_MEMBER_NAME_TAKEN', '同名重试必须被宿主拒绝')

  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assert.equal(second.envelope.status, 'ok')
  assert.equal(second.envelope.data.member, 'rt-cross-check-2', '烧掉名字之后下一次派发只能用 -2')
})

// ---------------------------------------------------------------------------
// 3 — 观测值里的 used 也照这个语义算（T18b 的用例曾靠「成员席位满也烧席位」的假模型通过）
// ---------------------------------------------------------------------------

test('T18c-3 成员席位满的观测值 used 不含幽灵成员：两次碰撞的 used 都不变', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })

  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(6) })
  await handleDispatch(ctx, input())
  const observedPath = path.join(project.root, 're', 'team', 'capacity-observed.json')
  const first = JSON.parse(await readFile(observedPath, 'utf8'))
  assert.equal(first.basis.used_at_observation, 1, '成员席位满没有写下成员行，used 仍然是 1')

  ctx.fakes.clock.advance(60_000)
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(3) })
  await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  const second = JSON.parse(await readFile(observedPath, 'utf8'))
  assert.equal(second.basis.used_at_observation, 1, '第二次拒绝同样不写成员行，used 不得凭空 +1')
  assert.equal(second.max_members, 3, '解析出的准确值仍然要覆盖旧值')
})
