/**
 * T6 `rt_dispatch` handler：前置检查零副作用、成功派发形状、阶段重入与恢复、retry_of。
 *
 * 断言只看行为与状态：任务板（status/owner）、成员名册、`re/team/` 文件产物、
 * 交付消息的字节数与引用、以及回执字段。不断言内部函数名或日志文案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { handleDispatch } from '../dist/dispatch.js'
import * as contract from '../dist/contract.js'
import { validateInput } from '../dist/validate.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

const SCHEMA = JSON.parse(
  await readFile(new URL('../../../docs/specs/rt-tools.schema.json', import.meta.url), 'utf8'),
)

const SAMPLE_BYTES = 'SAMPLE-BYTES-0123456789'
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE_BYTES, 'utf8').digest('hex')

const ROUTE = Object.freeze({
  schema_version: 1,
  id: 'R-001',
  status: 'active',
  target_ids: ['T-001', 'T-002'],
  problem: '样本的导入表是否暴露可疑能力',
  hypothesis: '导入表指向的可疑 API 构成触发链',
  criteria: ['可核验定位', '至少一次有效运行'],
  budget: { max_runs: 3 },
  depends_on: [],
})

const BASE_TOOLS = { default: { read: {}, write: {}, glob: {}, grep: {} } }

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function setup(t, options = {}) {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': SAMPLE_BYTES,
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [
          { id: 'T-001', name: 'sample', path: 're/samples/sample.bin' },
          { id: 'T-002', name: 'sample-2', path: 're/samples/sample.bin' },
        ],
      }),
      're/team/resources.json': JSON.stringify({
        schema_version: 1,
        revision: 0,
        aliases: { sample: { physical_identity: 'file:T-001', immutable_read: true } },
        leases: [],
      }),
      ...(options.files ?? {}),
    },
  })

  const ctx = makeCtx({
    t,
    projectRoot: project.root,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    teamOpts: {
      members: options.members ?? [],
      tasks: options.tasks ?? [],
      ...(options.teamOpts ?? {}),
    },
    projectOpts: {
      routes: { 'R-001': ROUTE, ...(options.routes ?? {}) },
      seals: options.seals ?? [],
    },
    capacity: options.capacity ?? { known: true, maxMembers: 6, maxActiveSubagents: 4, via: 'project' },
    tools: options.tools ?? BASE_TOOLS,
    depsOverrides: options.depsOverrides,
    config: options.config,
  })

  const team = ctx.fakes.team
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

  return { project, ctx, team, input }
}

function assertEnvelopeShape(envelope, { expectStatus } = {}) {
  if (expectStatus !== undefined) assert.equal(envelope.status, expectStatus)
  const checked = validateInput(SCHEMA, 'result', envelope)
  assert.equal(checked.ok, true, `回执不符合 $defs.result：${JSON.stringify(checked.issues)}`)
  if (envelope.status === 'ok') {
    const dataCheck = validateInput(SCHEMA, 'dispatchData', envelope.data)
    assert.equal(dataCheck.ok, true, `ok data 不符合 $defs.dispatchData：${JSON.stringify(dataCheck.issues)}`)
  } else if (envelope.data !== null) {
    const dataCheck = validateInput(SCHEMA, 'failureData', envelope.data)
    assert.equal(dataCheck.ok, true, `失败 data 不符合 $defs.failureData：${JSON.stringify(dataCheck.issues)}`)
  }
}

async function filesUnder(root, relative) {
  const out = []
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), next)
      else out.push(next)
    }
  }
  await walk(join(root, ...relative.split('/')), relative)
  return out.sort()
}

async function teamFiles(root) {
  return filesUnder(root, 're/team')
}

function sentMessageRequests(team) {
  return team.callsFor('sendMessage').map((call) => call.args[1])
}

function messageBytes(request, callerName = 'lead') {
  const content = [
    { type: 'text', text: `Team message from ${callerName}:` },
    ...request.content,
  ]
  return Buffer.byteLength(JSON.stringify(content), 'utf8')
}

function messageText(request) {
  return request.content.map((block) => block.text).join('\n')
}

function taskOf(team, taskId) {
  return team.snapshot().tasks.find((task) => task.id === taskId)
}

function memberByName(team, name) {
  return team.snapshot().members.find((member) => member.name === name)
}

async function contractFile(project, ref) {
  const text = await readFile(join(project.root, ...ref.split('/')), 'utf8')
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), json: JSON.parse(text) }
}

// ---------------------------------------------------------------------------
// 成功派发
// ---------------------------------------------------------------------------

test('成功派发：任务 in_progress + owner 正确、契约落盘、交付只发引用', async (t) => {
  const { project, ctx, team, input } = setup(t)

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })

  const data = envelope.data
  assert.equal(data.phase, 'delivered')
  assert.equal(data.started_at, null, 'delivered 不等于已开始')
  assert.equal(data.route_id, 'R-001')
  assert.equal(data.member, 'rt-cross-check')
  assert.equal(data.revision, 2, 'create(1) → reassign(2)')

  const dispatchId = data.dispatch_id
  const attemptId = data.attempt_id
  assert.match(dispatchId, /^D-[a-z0-9][a-z0-9_-]{0,63}$/u)
  assert.equal(attemptId, 'A-000001')
  assert.equal(data.work_dir, contract.workDirFor(dispatchId, attemptId))
  assert.equal(data.contract_ref, `re/team/dispatches/${dispatchId}.json`)

  // 成员与任务板
  const member = memberByName(team, 'rt-cross-check')
  assert.ok(member, '必须真的建了成员')
  assert.equal(member.role, 'teammate')
  assert.equal(team.callsFor('spawnTeammate').length, 1)

  const task = taskOf(team, data.task_id)
  assert.equal(task.status, 'in_progress')
  assert.equal(team.snapshot().members.find((row) => row.id === task.ownerId)?.name, 'rt-cross-check')
  assert.ok(task.subject.length <= 200)
  assert.ok(task.description.length <= 16384)

  // 契约文件：完整、不可变、baseline 有真实目标哈希
  const file = await contractFile(project, data.contract_ref)
  assert.equal(file.json.dispatch_id, dispatchId)
  assert.equal(file.json.attempt_id, attemptId)
  assert.equal(file.json.work_dir, data.work_dir)
  assert.equal(file.json.work_rules.length, 3)
  assert.equal(file.json.authority.dispatchable, false)
  assert.deepEqual(file.json.prohibited, [
    '替 Lead 验收或修改正式路线',
    '把同源导出累计为独立验证',
    '不要执行样本',
  ], 'prohibited 只追加：岗位默认禁止事项必须保留')
  assert.deepEqual(file.json.evidence_required, ['artifact_locator'])
  assert.equal(file.json.baseline_ref.targets[0].id, 'T-001')
  assert.equal(file.json.baseline_ref.targets[0].sha256, SAMPLE_SHA256)
  assert.deepEqual(file.json.baseline_ref.preexisting_seals, [], '首次无 seal 时是空数组，但目标哈希必须存在')
  assert.equal(file.json.retry_of, null)

  // 工作目录真的存在
  assert.equal((await stat(join(project.root, ...data.work_dir.split('/')))).isDirectory(), true)

  // 交付信封：只发引用，字节含宿主前缀
  const sends = sentMessageRequests(team)
  assert.equal(sends.length, 1)
  const text = messageText(sends[0])
  assert.match(text, new RegExp(data.contract_ref.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(text, new RegExp(file.sha256, 'u'), '消息里的契约哈希必须等于契约文件字节的 SHA256')
  assert.match(text, /docs\/agents\/reverse-project-management\.md/u, '必须带项目规则入口')
  assert.match(text, /A-000001/u)
  assert.ok(messageBytes(sends[0]) < 65536)
  assert.ok(!text.includes('baseline_ref'), '消息里不得搬运契约的 baseline_ref 正文')
  assert.ok(!text.includes('work_rules'), '消息里不得搬运契约正文')

  // 审计与台账
  const audit = await readFile(join(project.root, 're', 'team', 'audit.jsonl'), 'utf8')
  assert.equal(audit.trimEnd().split('\n').length, 1)
  assert.equal(JSON.parse(audit.trimEnd()).kind, 'dispatch')
  const ledger = JSON.parse(await readFile(join(project.root, 're', 'team', 'operations', 'op-1.json'), 'utf8'))
  assert.equal(ledger.phase, 'delivered')
  assert.equal(ledger.data.contract_sha256, file.sha256)
  const attemptRecord = JSON.parse(
    await readFile(join(project.root, 're', 'team', 'attempts', `${dispatchId}.${attemptId}.json`), 'utf8'),
  )
  assert.equal(attemptRecord.task_id, data.task_id)
  assert.equal(attemptRecord.member, 'rt-cross-check')
})

test('同岗已有空闲成员时复用，不新建成员，交付同一份契约引用', async (t) => {
  const { project, ctx, team, input } = setup(t, { members: [{ name: 'rt-cross-check' }] })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })
  assert.equal(envelope.data.member, 'rt-cross-check')
  assert.equal(team.callsFor('spawnTeammate').length, 0, '复用不应 spawn')
  assert.equal(team.snapshot().members.filter((row) => row.role === 'teammate').length, 1)

  const task = taskOf(team, envelope.data.task_id)
  assert.equal(task.status, 'in_progress')
  assert.equal(team.snapshot().members.find((row) => row.id === task.ownerId)?.name, 'rt-cross-check')

  const file = await contractFile(project, envelope.data.contract_ref)
  const text = messageText(sentMessageRequests(team)[0])
  assert.match(text, new RegExp(file.sha256, 'u'))
})

test('完全成功的重入返回 replayed=true，不重复 spawn/createTask/发消息', async (t) => {
  const { ctx, team, input } = setup(t)
  const first = await handleDispatch(ctx, input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'ok' })

  const second = await handleDispatch(ctx, input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  assert.equal(second.envelope.replayed, true)
  assert.equal(second.envelope.data.task_id, first.envelope.data.task_id)
  assert.equal(team.callsFor('spawnTeammate').length, 1)
  assert.equal(team.callsFor('createTask').length, 1)
  assert.equal(team.callsFor('sendMessage').length, 1)
  assert.equal(team.snapshot().tasks.length, 1)
})

test('同一 operation_id 换内容 → OPERATION_CONFLICT，且不再产生副作用', async (t) => {
  const { project, ctx, team, input } = setup(t)
  const first = await handleDispatch(ctx, input())
  assert.equal(first.envelope.status, 'ok')
  const after = await teamFiles(project.root)

  const second = await handleDispatch(ctx, input({ objective: '换了一个问题' }))
  assertEnvelopeShape(second.envelope, { expectStatus: 'blocked' })
  assert.equal(second.envelope.code, 'OPERATION_CONFLICT')
  assert.deepEqual(await teamFiles(project.root), after)
  assert.equal(team.callsFor('spawnTeammate').length, 1)
  assert.equal(team.callsFor('createTask').length, 1)
})

// ---------------------------------------------------------------------------
// 前置拒绝：零副作用
// ---------------------------------------------------------------------------

test('同岗成员忙碌 → MEMBER_BUSY，且零副作用', async (t) => {
  const { project, ctx, team, input } = setup(t, {
    members: [{ name: 'rt-cross-check' }],
    tasks: [{ id: 'task-5', subject: '未收口', description: '进行中', status: 'in_progress', owner: 'rt-cross-check' }],
  })
  const before = await teamFiles(project.root)

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'MEMBER_BUSY')
  assert.ok(envelope.diagnostics[0].next_step.length > 0)
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.equal(team.callsFor('sendMessage').length, 0)
  assert.deepEqual(await teamFiles(project.root), before)
})

test('未声明容量 → CAPACITY_UNKNOWN；席位不足 → CAPACITY_EXHAUSTED（都不动成员/任务）', async (t) => {
  const unknown = setup(t, { capacity: { known: false } })
  const beforeUnknown = await teamFiles(unknown.project.root)
  const first = await handleDispatch(unknown.ctx, unknown.input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'blocked' })
  assert.equal(first.envelope.code, 'CAPACITY_UNKNOWN')
  assert.equal(unknown.team.callsFor('spawnTeammate').length, 0)
  assert.equal(unknown.team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(unknown.project.root), beforeUnknown)

  const exhausted = setup(t, {
    capacity: { known: true, maxMembers: 1, maxActiveSubagents: 4, via: 'project' },
    members: [{ name: 'rt-other' }],
  })
  const beforeExhausted = await teamFiles(exhausted.project.root)
  const second = await handleDispatch(exhausted.ctx, exhausted.input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'blocked' })
  assert.equal(second.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(exhausted.team.callsFor('spawnTeammate').length, 0)
  assert.equal(exhausted.team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(exhausted.project.root), beforeExhausted)
})

test('缺必需能力 → CAPABILITY_MISSING，且不建成员/任务', async (t) => {
  const { project, ctx, team, input } = setup(t, {
    tools: { default: { read: {}, glob: {}, grep: {} } },
  })
  const before = await teamFiles(project.root)

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'CAPABILITY_MISSING')
  assert.match(envelope.diagnostics[0].reason, /fs|file-write/u)
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(project.root), before)
})

test('路线不存在 / 目标不在路线内 → blocked 且零副作用', async (t) => {
  const missing = setup(t, { routes: { 'R-001': null } })
  const beforeMissing = await teamFiles(missing.project.root)
  const first = await handleDispatch(missing.ctx, missing.input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'blocked' })
  assert.equal(first.envelope.code, 'PROJECT_NOT_CONFIGURED')
  assert.match(first.envelope.diagnostics[0].reason, /R-001/u)
  assert.deepEqual(await teamFiles(missing.project.root), beforeMissing)

  const narrow = setup(t, {
    routes: { 'R-001': { ...ROUTE, target_ids: ['T-002'] } },
  })
  const beforeNarrow = await teamFiles(narrow.project.root)
  const second = await handleDispatch(narrow.ctx, narrow.input({ target_ids: ['T-001'] }))
  assertEnvelopeShape(second.envelope, { expectStatus: 'blocked' })
  assert.equal(second.envelope.code, 'PROJECT_NOT_CONFIGURED')
  assert.match(second.envelope.diagnostics[0].reason, /T-001/u)
  assert.match(second.envelope.diagnostics[0].next_step, /路线/u)
  assert.equal(narrow.team.callsFor('spawnTeammate').length, 0)
  assert.deepEqual(await teamFiles(narrow.project.root), beforeNarrow)
})

test('路线不可派发（validated / paused）→ blocked 且点名下一步', async (t) => {
  const done = setup(t, { routes: { 'R-001': { ...ROUTE, status: 'validated' } } })
  const first = await handleDispatch(done.ctx, done.input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'blocked' })
  assert.equal(first.envelope.code, 'PROJECT_NOT_CONFIGURED')

  const paused = setup(t, { routes: { 'R-001': { ...ROUTE, status: 'paused' } } })
  const second = await handleDispatch(paused.ctx, paused.input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'blocked' })
  assert.equal(second.envelope.code, 'RECOVERY_REQUIRED')
  assert.equal(paused.team.callsFor('spawnTeammate').length, 0)
})

test('impact 报告 open 争议 → blocked 且不建半条路线', async (t) => {
  const { project, ctx, team, input } = setup(t)
  // 直接替换 impact 应答
  ctx.deps.projectAdapter.queue('impact', {
    exitCode: 0,
    stdout: `${JSON.stringify({ pending_reviews: [], dispute_impacts: [{ route_id: 'R-001', id: 'DSP-1' }] })}\n`,
  })
  const before = await teamFiles(project.root)

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.match(envelope.diagnostics[0].reason, /R-001/u)
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.deepEqual(await teamFiles(project.root), before)
})

test('depends_on_tasks：未完成 → DEPENDENCY_BLOCKED；已完成 → 任务带 blockedBy', async (t) => {
  const blocked = setup(t, {
    tasks: [{ id: 'task-9', subject: '前置', description: '前置任务', status: 'in_progress', owner: 'lead' }],
  })
  const beforeBlocked = await teamFiles(blocked.project.root)
  const first = await handleDispatch(blocked.ctx, blocked.input({ depends_on_tasks: ['task-9'] }))
  assertEnvelopeShape(first.envelope, { expectStatus: 'blocked' })
  assert.equal(first.envelope.code, 'DEPENDENCY_BLOCKED')
  assert.equal(blocked.team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(blocked.project.root), beforeBlocked)

  const ready = setup(t, {
    tasks: [{ id: 'task-9', subject: '前置', description: '前置任务', status: 'completed', owner: 'lead' }],
  })
  const second = await handleDispatch(ready.ctx, ready.input({ depends_on_tasks: ['task-9'] }))
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  const created = ready.team.callsFor('createTask')[0].args[1]
  assert.deepEqual(created.blockedBy, ['task-9'], 'depends_on_tasks 必须映射为 blockedBy')
  assert.deepEqual(taskOf(ready.team, second.envelope.data.task_id).blockedBy, ['task-9'])
})

test('依赖任务不存在 → DEPENDENCY_BLOCKED；跨团队任务 ID → PROJECT_SESSION_MISMATCH', async (t) => {
  const unknown = setup(t)
  const first = await handleDispatch(unknown.ctx, unknown.input({ depends_on_tasks: ['task-404'] }))
  assertEnvelopeShape(first.envelope, { expectStatus: 'blocked' })
  assert.equal(first.envelope.code, 'DEPENDENCY_BLOCKED')

  const foreign = setup(t, {
    files: {
      're/team/binding.json': JSON.stringify({
        schema_version: 1, project_id: 'p-1', session_id: 's-1', team_id: 'team-A', epoch: 1,
      }),
      're/team/attempts/D-other.A-000001.json': JSON.stringify({
        schema_version: 1,
        dispatch_id: 'D-other',
        attempt_id: 'A-000001',
        task_id: 'task-77',
        phase: 'delivered',
        binding: { team_id: 'team-B', session_id: 's-9' },
      }),
    },
  })
  const before = await teamFiles(foreign.project.root)
  const second = await handleDispatch(foreign.ctx, foreign.input({ depends_on_tasks: ['task-77'] }))
  assertEnvelopeShape(second.envelope, { expectStatus: 'blocked' })
  assert.equal(second.envelope.code, 'PROJECT_SESSION_MISMATCH')
  assert.equal(foreign.team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(foreign.project.root), before)
})

test('资源冲突 → RESOURCE_BUSY，不改资源记录也不建成员', async (t) => {
  const { project, ctx, team, input } = setup(t, {
    files: {
      're/team/resources.json': JSON.stringify({
        schema_version: 1,
        revision: 2,
        aliases: { sample: { physical_identity: 'file:T-001', immutable_read: true } },
        leases: [{
          resource_key: 'sample',
          physical_identity: 'file:T-001',
          mode: 'exclusive',
          dispatch_id: 'D-other',
          attempt_id: 'A-000001',
          generation: 1,
          state: 'held',
          recovery_ref: null,
          acquired_at: '2026-10-29T07:00:00.000Z',
        }],
      }),
    },
  })
  const before = await readFile(join(project.root, 're', 'team', 'resources.json'), 'utf8')

  const { envelope } = await handleDispatch(ctx, input({ resource_needs: [{ resource_key: 'sample', mode: 'exclusive' }] }))
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'RESOURCE_BUSY')
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.equal(await readFile(join(project.root, 're', 'team', 'resources.json'), 'utf8'), before)
})

test('非 Lead 调用 → ROLE_REQUIRED，且不产生任何宿主副作用', async (t) => {
  const { project, ctx, team, input } = setup(t, { role: 'teammate', agentName: 'rt-cross-check' })
  const before = await teamFiles(project.root)

  const { envelope } = await handleDispatch(ctx, input({ project_root: project.root }))
  assertEnvelopeShape(envelope, { expectStatus: 'error' })
  assert.equal(envelope.code, 'ROLE_REQUIRED')
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.deepEqual(await teamFiles(project.root), before)
})

test('禁用的岗位 / 工作区被换成 junction → 拒绝且不建成员', async (t) => {
  const disabled = setup(t)
  const beforeDisabled = await teamFiles(disabled.project.root)
  const postResult = await handleDispatch(disabled.ctx, disabled.input({ post_id: 'web-attack' }))
  assertEnvelopeShape(postResult.envelope, { expectStatus: 'blocked' })
  assert.equal(postResult.envelope.code, 'POST_DISABLED')
  assert.equal(disabled.team.callsFor('spawnTeammate').length, 0)
  assert.deepEqual(await teamFiles(disabled.project.root), beforeDisabled)

  const junction = setup(t)
  await mkdir(join(junction.project.root, 're', 'team'), { recursive: true })
  await symlink(join(junction.project.root, 'evil-work'), join(junction.project.root, 're', 'team', 'work'), 'junction')
  const workResult = await handleDispatch(junction.ctx, junction.input())
  assertEnvelopeShape(workResult.envelope, { expectStatus: 'partial' })
  assert.equal(workResult.envelope.code, 'PATH_INVALID')
  assert.equal(junction.team.callsFor('spawnTeammate').length, 0)
  assert.equal(junction.team.callsFor('createTask').length, 0)
  assert.deepEqual(await filesUnder(junction.project.root, 're/team/dispatches'), [])
})

test('前置拒绝在完全没有 re/team 的项目上也不创建任何目录或文件', async (t) => {
  const { project, ctx, team, input } = setup(t, {
    files: { 're/team/resources.json': null },
    capacity: { known: false },
    tools: { default: { read: {}, glob: {}, grep: {} } },
  })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'CAPABILITY_MISSING')

  let exists = true
  try {
    await stat(join(project.root, 're', 'team'))
  } catch {
    exists = false
  }
  assert.equal(exists, false, '前置拒绝不得创建 re/team/（锁、台账、契约、资源都不行）')
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
})

// ---------------------------------------------------------------------------
// 超长契约 / 交付
// ---------------------------------------------------------------------------

test('契约 >64 KiB 仍能派发：消息 <65536 字节、契约完整、哈希与文件字节一致', async (t) => {
  const { project, ctx, team, input } = setup(t)
  const objective = `超长目标：${'证'.repeat(24000)}`

  const { envelope } = await handleDispatch(ctx, input({ objective }))
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })

  const file = await contractFile(project, envelope.data.contract_ref)
  assert.ok(Buffer.byteLength(file.text, 'utf8') > 65536, '契约文件必须真的超过 64 KiB')
  assert.equal(file.json.objective, objective, '契约正文必须完整')

  const request = sentMessageRequests(team)[0]
  const bytes = messageBytes(request)
  assert.ok(bytes < 65536, `消息 ${bytes} 字节必须小于 65536`)
  assert.match(messageText(request), new RegExp(file.sha256, 'u'))
  assert.ok(!messageText(request).includes('证'.repeat(1200)), '消息不得搬运契约正文')
})

test('消息发送失败 → partial + DELIVERY_FAILED + 保留身份；重投只发同一份信封', async (t) => {
  const { project, ctx, team, input } = setup(t)
  team.faults.beforeHost('sendMessage', 1, { code: 'TEAM_MESSAGE_TOO_LARGE', message: 'team message exceeds 65536 bytes' })

  const first = await handleDispatch(ctx, input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'partial' })
  assert.equal(first.envelope.code, 'DELIVERY_FAILED')
  assert.equal(first.envelope.data.phase, 'assigned')
  assert.ok(first.envelope.data.task_id, 'partial 必须带回已建任务')
  assert.equal(first.envelope.data.member, 'rt-cross-check')

  const taskAfterFailure = taskOf(team, first.envelope.data.task_id)
  assert.equal(taskAfterFailure.status, 'in_progress', '任务已被指派，身份保留')
  assert.equal(team.snapshot().teammates, 1)

  const second = await handleDispatch(ctx, input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  assert.equal(second.envelope.data.task_id, first.envelope.data.task_id)
  assert.equal(team.callsFor('spawnTeammate').length, 1)
  assert.equal(team.callsFor('createTask').length, 1)
  assert.equal(team.snapshot().tasks.length, 1)

  const sends = sentMessageRequests(team)
  assert.equal(sends.length, 2)
  assert.deepEqual(sends[1].content, sends[0].content, '重投必须是同一份信封字节')
  assert.equal(messageBytes(sends[1]), messageBytes(sends[0]))
})

test('started_at 只认成员写下的 start.json，不从 delivered 推断', async (t) => {
  const { project, ctx, team, input } = setup(t)
  team.faults.beforeHost('sendMessage', 1, { code: 'TEAM_MESSAGE_TOO_LARGE' })

  const first = await handleDispatch(ctx, input())
  assert.equal(first.envelope.status, 'partial')
  const data = first.envelope.data
  assert.equal(data.started_at, undefined, '未交付前没有 started_at 可报')

  project.write(`${data.work_dir}/start.json`, JSON.stringify({
    attempt: data.attempt_id,
    at: '2026-10-29T08:30:00.000Z',
    target: 'T-001',
  }))

  const second = await handleDispatch(ctx, input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  assert.equal(second.envelope.data.started_at, '2026-10-29T08:30:00.000Z')
})

// ---------------------------------------------------------------------------
// 阶段注入与恢复
// ---------------------------------------------------------------------------

test('member_ready 之后、task_created 之前失败 → 重入复用同一成员，只建一个任务', async (t) => {
  const { project, ctx, team, input } = setup(t)
  team.faults.beforeHost('createTask', 1, { code: 'TEAM_HOST_FAILED_BEFORE_EFFECT', message: 'boom' })

  const first = await handleDispatch(ctx, input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'partial' })
  assert.equal(first.envelope.data.phase, 'member_ready')
  assert.equal(first.envelope.data.member, 'rt-cross-check')

  const second = await handleDispatch(ctx, input())
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  assert.equal(team.callsFor('spawnTeammate').length, 1, '不得 spawn 第二个成员')
  assert.equal(team.snapshot().teammates, 1)
  assert.equal(team.snapshot().tasks.length, 1)
  assert.equal(second.envelope.data.task_id, team.snapshot().tasks[0].id)

  const file = await contractFile(project, second.envelope.data.contract_ref)
  assert.equal(file.json.dispatch_id, second.envelope.data.dispatch_id)
})

test('spawnTeammate 生效但响应丢失 → 按确定名字唯一关联，不重复 spawn', async (t) => {
  const { ctx, team, input } = setup(t)
  team.faults.afterHost('spawnTeammate', 1, { code: 'TEAM_RESPONSE_LOST', message: 'response lost after spawn' })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })
  assert.equal(team.callsFor('spawnTeammate').length, 1, '响应丢失后不应再 spawn 第二次')
  assert.equal(team.snapshot().teammates, 1)
  assert.equal(envelope.data.member, 'rt-cross-check')
  assert.equal(taskOf(team, envelope.data.task_id).status, 'in_progress')
})

test('createTask 生效但响应丢失 → 按摘要标记唯一关联，不建第二个任务', async (t) => {
  const { ctx, team, input } = setup(t)
  team.faults.dropResponse('createTask', 1, { code: 'TEAM_RESPONSE_LOST', message: 'response lost after create' })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })
  assert.equal(team.callsFor('createTask').length, 1)
  assert.equal(team.snapshot().tasks.length, 1, '不得建第二个任务')
  assert.equal(envelope.data.task_id, team.snapshot().tasks[0].id)
})

test('spawn 失败（席位被烧）→ partial + 记录 failed，且允许下一次用 -2 名字', async (t) => {
  const { ctx, team, input } = setup(t)
  team.failNextSpawn({ code: 'ACTIVATION_LIMIT_REACHED', message: 'subagent limit reached' })

  const first = await handleDispatch(ctx, input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'partial' })
  assert.equal(first.envelope.code, 'CAPACITY_EXHAUSTED')
  assert.equal(first.envelope.data.phase, 'member_ready')
  const failed = team.snapshot().members.find((row) => row.name === 'rt-cross-check')
  assert.equal(failed.status, 'failed', '失败成员占位（D12）')

  // 换一个 operation（新的派发）→ 必须用 rt-cross-check-2，绝不能同名重试
  const second = await handleDispatch(ctx, input({ operation_id: 'op-2' }))
  assertEnvelopeShape(second.envelope, { expectStatus: 'ok' })
  assert.equal(second.envelope.data.member, 'rt-cross-check-2')
  assert.equal(team.callsFor('spawnTeammate').length, 2)
  assert.deepEqual(
    team.callsFor('spawnTeammate').map((call) => call.args[1].name),
    ['rt-cross-check', 'rt-cross-check-2'],
  )
})

// ---------------------------------------------------------------------------
// retry_of
// ---------------------------------------------------------------------------

test('retry_of：恢复记录缺失 → blocked；核查后只新增 attempt、新目录、新 RUN ID', async (t) => {
  const { project, ctx, team, input } = setup(t)
  const first = await handleDispatch(ctx, input())
  assertEnvelopeShape(first.envelope, { expectStatus: 'ok' })
  const dispatchId = first.envelope.data.dispatch_id
  const oldTaskId = first.envelope.data.task_id
  const oldContract = await contractFile(project, first.envelope.data.contract_ref)
  const oldWorkDir = first.envelope.data.work_dir

  const missing = await handleDispatch(ctx, input({
    operation_id: 'op-2',
    retry_of: { dispatch_id: dispatchId, attempt_id: 'A-000001', recovery_ref: 're/team/recovery/nope.md' },
  }))
  assertEnvelopeShape(missing.envelope, { expectStatus: 'blocked' })
  assert.equal(missing.envelope.code, 'RECOVERY_REQUIRED')
  assert.equal(team.callsFor('createTask').length, 1, '未核查恢复时不得建新任务')

  project.write('re/team/recovery/D-recovery.md', '# 恢复核查\n旧成员已停止、后台任务已结束、资源已核实。\n')
  const retried = await handleDispatch(ctx, input({
    operation_id: 'op-2',
    retry_of: { dispatch_id: dispatchId, attempt_id: 'A-000001', recovery_ref: 're/team/recovery/D-recovery.md' },
  }))
  assertEnvelopeShape(retried.envelope, { expectStatus: 'ok' })
  assert.equal(retried.envelope.data.dispatch_id, dispatchId, '同一 dispatch')
  assert.equal(retried.envelope.data.attempt_id, 'A-000002')
  assert.notEqual(retried.envelope.data.task_id, oldTaskId, '必须是新任务')
  assert.notEqual(retried.envelope.data.work_dir, oldWorkDir, '必须是新目录')
  assert.equal(retried.envelope.data.work_dir, contract.workDirFor(dispatchId, 'A-000002'))

  const newContract = await contractFile(project, retried.envelope.data.contract_ref)
  assert.equal(retried.envelope.data.contract_ref, `re/team/dispatches/${dispatchId}.A-000002.json`)
  assert.equal(newContract.json.run_id_reservation, `RUN-${dispatchId}-A-000002`)
  assert.equal(newContract.json.objective, oldContract.json.objective)
  assert.deepEqual(newContract.json.targets, oldContract.json.targets)

  // 旧契约与旧任务不动；旧 attempt 记录被标记撤销
  assert.equal((await contractFile(project, oldContract.json.contract_ref)).sha256, oldContract.sha256)
  assert.equal(taskOf(team, oldTaskId).status, 'in_progress', '旧任务不入新结果，但也不被删/改')

  const oldAttempt = JSON.parse(
    await readFile(join(project.root, 're', 'team', 'attempts', `${dispatchId}.A-000001.json`), 'utf8'),
  )
  assert.equal(oldAttempt.phase, 'revoked')
  assert.equal(oldAttempt.revoked.recovery_ref, 're/team/recovery/D-recovery.md')
  assert.equal(oldAttempt.revoked.superseded_by.attempt_id, 'A-000002')

  assert.ok((await stat(join(project.root, ...retried.envelope.data.work_dir.split('/')))).isDirectory())
})

test('retry_of：问题改变 / 旧任务已收口 → STALE_ATTEMPT', async (t) => {
  const { project, ctx, team, input } = setup(t)
  const first = await handleDispatch(ctx, input())
  assert.equal(first.envelope.status, 'ok')
  const dispatchId = first.envelope.data.dispatch_id
  project.write('re/team/recovery/D-recovery.md', '# 恢复核查\n')

  const changed = await handleDispatch(ctx, input({
    operation_id: 'op-2',
    objective: '换了一个问题',
    retry_of: { dispatch_id: dispatchId, attempt_id: 'A-000001', recovery_ref: 're/team/recovery/D-recovery.md' },
  }))
  assertEnvelopeShape(changed.envelope, { expectStatus: 'blocked' })
  assert.equal(changed.envelope.code, 'STALE_ATTEMPT')
  assert.match(changed.envelope.diagnostics[0].reason, /objective/u)

  // 旧任务收口后不能重开
  const member = team.agentFor('rt-cross-check')
  await team.service.updateTask(member, {
    taskId: first.envelope.data.task_id,
    expectedRevision: taskOf(team, first.envelope.data.task_id).revision,
    action: 'complete',
  })
  const concluded = await handleDispatch(ctx, input({
    operation_id: 'op-3',
    retry_of: { dispatch_id: dispatchId, attempt_id: 'A-000001', recovery_ref: 're/team/recovery/D-recovery.md' },
  }))
  assertEnvelopeShape(concluded.envelope, { expectStatus: 'blocked' })
  assert.equal(concluded.envelope.code, 'STALE_ATTEMPT')
  assert.match(concluded.envelope.diagnostics[0].reason, /收口|completed|重开/u)
})

// ---------------------------------------------------------------------------
// 契约里冻结的规则版本（T14 缺陷 1：收口侧规则漂移守卫的输入）
// ---------------------------------------------------------------------------

test('派发把规则/脚本/目录摘要冻结进契约，且一次派发只探测一次兼容性', async (t) => {
  const { project, ctx, input } = setup(t)

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'ok' })

  const frozen = (await contractFile(project, envelope.data.contract_ref)).json
  for (const key of ['rule_digest', 'script_digest', 'catalog_digest']) {
    assert.match(frozen[key], /^[0-9a-f]{64}$/u, `契约必须冻结内容摘要 ${key}`)
  }
  // 值来自门 1 的兼容性探测（替身给出固定摘要），不是另算一份哈希。
  assert.equal(frozen.rule_digest, 'a'.repeat(64))
  assert.equal(frozen.script_digest, 'b'.repeat(64))
  assert.equal(frozen.catalog_digest, 'c'.repeat(64))
  assert.equal(ctx.fakes.project.callsFor('probe').length, 1, '一次派发只探测一次兼容性（不重复跑 Python）')
})

test('项目兼容性探测失败 → 不派发（冻结不了规则版本时保持零副作用）', async (t) => {
  const { project, ctx, team, input } = setup(t)
  ctx.fakes.project.queue('probe', {
    exitCode: 1,
    stdout: '',
    stderr: 'ERROR: skill copy missing',
    code: 'PROJECT_NOT_CONFIGURED',
  })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'PROJECT_NOT_CONFIGURED')
  assert.match(envelope.diagnostics[0].reason, /规则版本/u)
  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.deepEqual(await filesUnder(project.root, 're/team/dispatches'), [], '不得落下契约')
})

test('探测成功但拿不到规则摘要 → 不派发（SKILL_INCOMPATIBLE，而不是冻结一个空摘要）', async (t) => {
  const { project, ctx, team, input } = setup(t)
  ctx.fakes.project.queue('probe', {
    exitCode: 0,
    stdout: `${JSON.stringify({ ruleDigest: null, scriptDigest: null, catalogDigest: null })}\n`,
    stderr: '',
  })

  const { envelope } = await handleDispatch(ctx, input())
  assertEnvelopeShape(envelope, { expectStatus: 'blocked' })
  assert.equal(envelope.code, 'SKILL_INCOMPATIBLE')
  assert.match(envelope.diagnostics[0].reason, /规则摘要/u)
  assert.equal(team.callsFor('createTask').length, 0)
  assert.deepEqual(await filesUnder(project.root, 're/team/dispatches'), [])
})

// ---------------------------------------------------------------------------
// 入参形状
// ---------------------------------------------------------------------------

test('入参形状错误 → INVALID_ARGUMENT（status=error），且不碰宿主', async (t) => {
  const { ctx, team, input } = setup(t)

  const noTargets = await handleDispatch(ctx, input({ target_ids: [] }))
  assertEnvelopeShape(noTargets.envelope, { expectStatus: 'error' })
  assert.equal(noTargets.envelope.code, 'INVALID_ARGUMENT')

  const badOperation = await handleDispatch(ctx, input({ operation_id: 'Op 1!' }))
  assert.equal(badOperation.envelope.status, 'error')
  assert.equal(badOperation.envelope.code, 'INVALID_ARGUMENT')

  const badAnchor = await handleDispatch(ctx, input({ evidence_required: ['not_an_anchor'] }))
  assert.equal(badAnchor.envelope.status, 'error')

  assert.equal(team.callsFor('spawnTeammate').length, 0)
  assert.equal(team.callsFor('createTask').length, 0)
})
