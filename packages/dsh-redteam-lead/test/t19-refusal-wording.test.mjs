/**
 * T19：非焚烧类容量拒绝的**措辞**与**回执字段** —— 不得承诺一个不存在的损失、也不得点名一个
 * 名册里不存在的成员。
 *
 * 两条宿主容量码的损坏语义不同（T18c / D12 补正）：
 *
 * - `TEAM_MEMBER_LIMIT` 在写成员行**之前**抛 → 名字仍空闲、席位没消耗，**什么都没烧**；
 * - `ACTIVATION_LIMIT_REACHED` 在成员行 append **之后**抛 → 名字与席位都被烧掉（D12）。
 *
 * 所以对前者说「避免再烧一个名字与席位」是虚报（本票第 1 条），回执里写 `member: "rt-cross-check"`
 * 是承诺一个不存在的对象（第 2 条）。第 3 条是 `解析出的activation` 缺分隔的 typo。
 *
 * 断言只看公开行为：诊断文本与信封字段。**注意 `member: null` 不是合法形状**：
 * 规格 `$defs.failureData.member` 是 `$defs/text`（`string` / `minLength:1`），写 `null` 会让整封
 * 回执过不了入口的 `$defs.result` 校验、被换成 `RECOVERY_REQUIRED`。因此「不点名」的唯一合法
 * 表达是**不带这个键**，T19-1 用入口同一条校验把它钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { OBSERVED_CAPACITY_PATH } from '../dist/capacity-source.js'
import { handleDispatch } from '../dist/dispatch.js'
import { schemaDefs } from '../dist/tool-schema.js'
import { validateInput } from '../dist/validate.js'
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

/** 观测值文件与台账的落地位置（前者取实现常量，后者是 D-契约里的公开路径）。 */
const observedPathOf = (project) => path.join(project.root, ...OBSERVED_CAPACITY_PATH.split('/'))
const ledgerPathOf = (project, operationId) => path.join(project.root, 're', 'team', 'operations', `${operationId}.json`)

/**
 * 派发现场：预置一名队友（成员席位满在 `used === 0` 时不可能发生，`maxMembers >= 1`）。
 *
 * `capacity` 传 `null` 表示**不声明**容量（→ `capacity_source=unknown`，前置判定照派）。
 */
function dispatchFixture(t, { members = [], capacity = { known: true, maxMembers: 8, maxActiveSubagents: 8 } } = {}) {
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
    ...(capacity === null ? {} : { capacity }),
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

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/**
 * 让「等锁期间另一个派发学到了上限」可复现（D40 §5 的竞态）。
 *
 * 前置判定在**拿到锁之前**跑，闸门在**锁内**重读观测值 —— 两者之间别的派发可能刚把观测值落盘。
 * 这里用一个包装过的适配器在「台账已写（说明已过分派前置）」的那一刻落盘，模拟那次并发学习。
 */
function learnCapacityDuringLock({ project, ctx, record, operationId = 'op-2' }) {
  const observedPath = observedPathOf(project)
  const ledgerPath = ledgerPathOf(project, operationId)
  const adapter = ctx.deps.teamAdapter
  ctx.deps.teamAdapter = {
    ...adapter,
    async listMembers(agent) {
      const listed = await adapter.listMembers(agent)
      if (existsSync(ledgerPath) && !existsSync(observedPath)) {
        mkdirSync(path.dirname(observedPath), { recursive: true })
        writeFileSync(observedPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      }
      return listed
    },
  }
}

// ---------------------------------------------------------------------------
// 1 — 席位满（TEAM_MEMBER_LIMIT）：什么都没烧 → 不点名成员、不说「烧掉/再烧」
// ---------------------------------------------------------------------------

test('T19-1 席位满：回执不点名不存在的成员、诊断不出现「烧掉/再烧」，且信封仍过 $defs.result', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(1) })

  const first = await handleDispatch(ctx, input())

  assert.equal(first.envelope.status, 'partial')
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')

  // 名册里没有 `rt-cross-check`（宿主在写成员行之前就拒绝了）：回执不得点名它。
  const seats = team.service.listMembers(team.agent).filter((row) => row.role === 'teammate').map((row) => row.name)
  assert.equal(seats.includes('rt-cross-check'), false, '失败现场本身不产生成员行')

  const data = first.envelope.data
  assert.equal(Object.hasOwn(data, 'member'), false, '非焚烧类拒绝不得点名成员（也不得写 null：那不是 $defs.text 的合法值）')
  assert.notEqual(data.member, 'rt-cross-check', '不得承诺一个名册里不存在的成员')

  const text = diagnosticText(first.envelope)
  assert.doesNotMatch(text, /烧掉|再烧/u, '什么都没烧，就不得出现「烧掉/再烧」')
  assert.match(text, /写成员行之前/u, '必须说清宿主在哪一步拒绝')

  // 反向钉住：`member: null` 会让入口的 $defs.result 校验失败、整封换成 RECOVERY_REQUIRED。
  const verdict = validateInput(schemaDefs, 'result', first.envelope)
  assert.deepEqual(verdict.issues, [], '回执本身必须是 $defs.result 的合法形状')
})

// ---------------------------------------------------------------------------
// 2 — activation 池满：真的烧了 → 说「已烧掉」并点名成员；顺带钉住 typo
// ---------------------------------------------------------------------------

test('T19-2 activation 池满：诊断说「已烧掉、不得同名重试」，回执点名成员', async (t) => {
  const { ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: activationMessage(2) })

  const first = await handleDispatch(ctx, input())

  assert.equal(first.envelope.status, 'partial')
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(first.envelope.data.member, 'rt-cross-check', '名字与席位确实被烧掉了 → 必须点名')

  const text = diagnosticText(first.envelope)
  assert.match(text, /该名字与席位已被烧掉/u)
  assert.match(text, /不得同名重试/u)
  // T19 第 3 条：「解析出的 activation 池大小准确值」少了一个分隔空格。
  assert.match(text, /解析出的 activation 池大小准确值/u, '维度名后面必须有分隔，不能粘成「解析出的activation」')
  assert.doesNotMatch(text, /解析出的activation/u)
})

// ---------------------------------------------------------------------------
// 3 — 认不出的宿主码：保持保守（按「已烧掉」说）并点名
// ---------------------------------------------------------------------------

test('T19-3 未知宿主码：保持保守（「已烧掉」）并点名成员', async (t) => {
  const { ctx, team, input } = dispatchFixture(t, { members: [{ name: 'rt-existing' }] })
  team.failNextSpawn({ code: 'TEAM_SOMETHING_LIMIT_REACHED', message: 'something limit reached (unknown wording)' })

  const first = await handleDispatch(ctx, input())

  assert.equal(first.envelope.status, 'partial')
  assert.equal(first.envelope.code, 'RECOVERY_REQUIRED', '未登记的宿主码按 RECOVERY_REQUIRED 保守处理')
  assert.equal(first.envelope.data.member, 'rt-cross-check', '认不出时按已烧掉说，所以要点名')

  const text = diagnosticText(first.envelope)
  assert.match(text, /该名字与席位已被烧掉/u, '认不出的码不得给出「同名重试没问题」的承诺')
  assert.match(text, /TEAM_SOMETHING_LIMIT_REACHED/u, '必须带上宿主原始码')
})

// ---------------------------------------------------------------------------
// 4 — 闸门（锁内重读观测值）：席位满学来的上限 → 不得说「避免再烧」
// ---------------------------------------------------------------------------

test('T19-4 闸门拒绝（席位满学来的上限）：不得说「烧掉/再烧」，要说宿主在写成员行之前就拒绝', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: null, members: [{ name: 'rt-existing' }] })

  // 一次真实碰撞拿到本会话身份与观测值形状（不猜、不读私有字段；T18 T7 同法）。
  team.failNextSpawn({ code: 'TEAM_MEMBER_LIMIT', message: memberMessage(6) })
  const first = await handleDispatch(ctx, input())
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')
  const learned = await readJsonFile(observedPathOf(project))
  // 下一次派发的前置判定必须**看不到**它（否则拒绝发生在前置，走不到闸门）。
  await rm(observedPathOf(project))

  learnCapacityDuringLock({
    project,
    ctx,
    record: {
      ...learned,
      max_members: 1,
      max_active_subagents: 1,
      basis: {
        host_code: 'TEAM_MEMBER_LIMIT',
        parsed_limit: 1,
        used_at_observation: 1,
        message: memberMessage(1),
      },
    },
  })

  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))

  // 闸门在锁内、台账/资源/契约已落盘之后才跑（失败面统一走 partial），但宿主一步都没碰。
  assert.equal(second.envelope.status, 'partial')
  assert.equal(second.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(team.callsFor('spawnTeammate').length, 1, '闸门拒绝不得真的去 spawn')
  assert.equal(Object.hasOwn(second.envelope.data, 'member'), false, '闸门拒绝不得点名成员')

  const gateText = diagnosticText(second.envelope)
  assert.match(gateText, /maxMembers=1/u, '必须说清按哪个上限判定')
  assert.doesNotMatch(gateText, /烧掉|再烧/u, '席位满学来的上限不代表本次会烧 —— 不得虚报')
  assert.match(gateText, /写成员行之前/u)
  assert.match(gateText, /名字与席位都不会被占用/u)
})

// ---------------------------------------------------------------------------
// 5 — 闸门：上限是 activation 池满学来的 → 保留「会烧掉」的措辞（保守的另一侧）
// ---------------------------------------------------------------------------

test('T19-5 闸门拒绝（activation 池满学来的上限）：保留「避免再烧一个名字与席位」', async (t) => {
  const { project, ctx, team, input } = dispatchFixture(t, { capacity: null, members: [{ name: 'rt-existing' }] })

  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: activationMessage(3) })
  const first = await handleDispatch(ctx, input())
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')
  const learned = await readJsonFile(observedPathOf(project))
  await rm(observedPathOf(project))

  learnCapacityDuringLock({
    project,
    ctx,
    record: {
      ...learned,
      max_members: 1,
      max_active_subagents: 3,
      basis: {
        host_code: 'ACTIVATION_LIMIT_REACHED',
        parsed_limit: 3,
        used_at_observation: 2,
        message: activationMessage(3),
      },
    },
  })

  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))

  assert.equal(second.envelope.status, 'partial')
  assert.equal(second.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(team.callsFor('spawnTeammate').length, 1, '闸门拒绝不得真的去 spawn')
  const gateText = diagnosticText(second.envelope)
  assert.match(gateText, /避免再烧一个名字与席位/u, 'activation 池满真的会烧 → 措辞必须保留')
})
