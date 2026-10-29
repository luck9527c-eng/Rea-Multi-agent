/**
 * T12 装配接缝：`createDeps` 接齐、`projectRoot` 绑定、派发↔收口端到端。
 *
 * 这份测试只做一件事：**证明三块拼在一起能用**。T5/T6/T7 各自只对自己的替身证明过，
 * 装配层（`index.js`）与两侧字段形状从来没有被一起跑过 —— 这里就是那个缺口。
 *
 * 断言只看可观察结果：`deps` 的键与真实模块、`projectAdapter.readRoute` 是否真读文件、
 * 三个工具的返回信封、`re/team/` 下的落盘产物、宿主任务板状态与成员调用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { createDeps, handlerContext, invokeTool } from '../index.js'
import * as anchorsModule from '../src/anchors.mjs'
import * as baselineModule from '../src/baseline.mjs'
import * as bindingModule from '../src/binding.mjs'
import * as contractModule from '../src/contract.mjs'
import * as resourcesModule from '../src/resources.mjs'
import * as submissionModule from '../src/submission.mjs'
import { handleConclude } from '../src/conclude.mjs'
import { handleDispatch } from '../src/dispatch.mjs'
import { handleRoster } from '../src/roster.mjs'
import { validateInput } from '../src/validate.mjs'
import { schemaDefs } from '../src/tool-schema.mjs'
import { DEP_KEYS, makeFakeTools, makeTempProject } from './helpers/host.mjs'
import { createFakeProject } from './helpers/fake-project.mjs'
import { createFakeTeam } from './helpers/fake-team.mjs'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SAMPLE_BYTES = 'SAMPLE-BYTES-0123456789'
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE_BYTES, 'utf8').digest('hex')
const ARTIFACT_BYTES = '{"probe":"ok","value":42}'
const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT_BYTES, 'utf8').digest('hex')
const RUN_ID = 'RUN-1'

/** 六个「曾经是 null」的模块键 → 真实命名空间。 */
const MODULE_NAMESPACES = Object.freeze({
  binding: bindingModule,
  contract: contractModule,
  resources: resourcesModule,
  submission: submissionModule,
  anchors: anchorsModule,
  baseline: baselineModule,
})

/** 每个键上必须存在的具体导出（防止有人用空对象糊过去）。 */
const REQUIRED_EXPORTS = Object.freeze({
  binding: ['readJsonIfPresent', 'writeBinding', 'projectIdFor', 'sessionIdentityFrom'],
  contract: ['buildContract', 'persistContract', 'captureBaseline'],
  resources: ['readRegistry', 'planReservations'],
  submission: ['readVerifiedSubmission', 'validateSubmission'],
  anchors: ['mergeRequiredKinds', 'validateAnchorSet'],
  baseline: ['captureBaseline', 'loadBaseline', 'compareBaseline', 'sealRunSet'],
})

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
  evidence: [RUN_ID],
})

const BASE_TOOLS = { default: { read: {}, write: {}, glob: {}, grep: {} } }

/**
 * 宿主形状的服务与执行上下文（与 `makeCtx` 同一套，但**不**装配 deps）：
 * 装配必须由 `createDeps` 自己做，否则测不到装配。
 */
function makeHost(t, options = {}) {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': SAMPLE_BYTES,
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', path: 're/samples/sample.bin', sha256: SAMPLE_SHA256 }],
      }),
      're/team/capacity.json': JSON.stringify({
        schema_version: 1,
        declared_at: '2026-01-01T00:00:00.000Z',
        declared_by: 't12-assembly-test',
        maxMembers: 6,
        maxActiveSubagents: 4,
      }),
      're/routes/R-001.json': JSON.stringify(ROUTE),
      ...(options.files ?? {}),
    },
  })

  const clock = { now: () => Date.UTC(2026, 0, 1), isoNow: () => '2026-01-01T00:00:00.000Z' }
  const team = createFakeTeam({
    role: options.role ?? 'lead',
    members: options.members ?? [],
    tasks: options.tasks ?? [],
    clock: () => clock.now(),
  })
  const services = {
    agentTeams: team.service,
    tools: makeFakeTools(options.tools ?? BASE_TOOLS),
  }
  const exec = { agent: team.agent, signal: new AbortController().signal, cwd: project.root }
  const config = { defaults: {}, presetId: 'redteam-lead', bundleRoot: undefined, projectRoot: project.root }

  return { project, team, services, exec, config, clock }
}

function assertModuleNamespace(deps, key, module) {
  assert.equal(deps[key], module, `deps.${key} 必须是真实模块命名空间（不是 null 或占位对象）`)
  for (const name of REQUIRED_EXPORTS[key]) {
    assert.equal(typeof deps[key][name], 'function', `deps.${key}.${name} 必须存在`)
  }
}

/**
 * 完整装配的 ctx：`createDeps` 是真装配（六个模块 + 两个适配器），只把
 * **会 spawn python 的那一层**（project skill CLI）换成替身 —— 门禁不能依赖本机 Python，
 * 而 `readRoute/readRun/readSeals` 的真实现本来就是直接读文件（另有专门的用例覆盖）。
 */
function makeAssembled(t, options = {}) {
  const host = makeHost(t, options)
  const deps = createDeps({ ...host, projectRoot: host.project.root })
  const runs = { ...(options.runs ?? {}) }
  const fakeProject = createFakeProject({
    projectRoot: host.project.root,
    routes: { 'R-001': ROUTE, ...(options.routes ?? {}) },
    runs,
    seals: options.seals ?? [],
  })
  deps.projectAdapter = fakeProject
  deps.clock = host.clock
  const ctx = handlerContext({ deps, exec: host.exec, services: host.services, config: host.config })
  return { ...host, deps, fakeProject, runs, ctx }
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 一次交付要求「岗位锚点 ∪ 任务追加锚点」两类都有。 */
const REVIEW = Object.freeze({
  outcome: 'finding',
  summary: '导入表指向的 API 构成触发链',
  reason: '观测到定位与调用序列，并有对照',
  proposed_route_status: 'validated',
  evidence_run_ids: [RUN_ID],
  anchor_refs: [], // 锚点由提交给出，review 不重复声明
  limitations: ['只覆盖单进程'],
  next_step: null,
})

// ---------------------------------------------------------------------------
// 1. createDeps：六个占位键接齐真实模块
// ---------------------------------------------------------------------------

test('createDeps 接齐六个模块命名空间（不再是占位 null）', (t) => {
  const host = makeHost(t)
  const deps = createDeps({ ...host, projectRoot: host.project.root })

  for (const [key, module] of Object.entries(MODULE_NAMESPACES)) {
    assertModuleNamespace(deps, key, module)
  }

  // 键集合与 SEAMS §1 的 `deps` 逐字一致：多一个少一个都是装配漂移。
  assert.deepEqual(Object.keys(deps).sort(), [...DEP_KEYS].sort(), 'deps 的键必须与 SEAMS §1 一致')
  for (const key of DEP_KEYS) {
    assert.notEqual(deps[key], undefined, `deps.${key} 不得缺席`)
  }
  assert.equal(typeof deps.teamAdapter.readRoute, 'undefined', 'teamAdapter 是适配器实例，不是模块')
  assert.equal(typeof deps.teamAdapter.getTask, 'function')
  assert.equal(typeof deps.projectAdapter.readRoute, 'function')
})

test('projectRoot 真的传进 createProjectAdapter：readRoute 读文件而不是 PROJECT_NOT_CONFIGURED', async (t) => {
  const host = makeHost(t)
  const bound = createDeps({ ...host, projectRoot: host.project.root })

  const read = await bound.projectAdapter.readRoute('R-001')
  assert.equal(read.ok, true, `绑定 projectRoot 后必须真的读到 re/routes/R-001.json：${JSON.stringify(read)}`)
  assert.equal(read.route.id, 'R-001')
  assert.equal(read.route.status, 'active')

  // 对照：同一个适配器工厂不传 projectRoot（config 里也没有）时只能返回「项目未配置」。
  const blindConfig = { defaults: {}, presetId: 'redteam-lead' }
  const unbound = createDeps({ ...host, config: blindConfig })
  const missing = await unbound.projectAdapter.readRoute('R-001')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'PROJECT_NOT_CONFIGURED')

  // 已绑定 root 但记录不存在 → 同样是 PROJECT_NOT_CONFIGURED，但带 notFound 标记（不是「未配置」）。
  const notFound = await bound.projectAdapter.readRoute('R-404')
  assert.equal(notFound.ok, false)
  assert.equal(notFound.code, 'PROJECT_NOT_CONFIGURED')
  assert.equal(notFound.notFound, true)
})

test('projectRoot 也绑到 teamAdapter：容量来源是项目声明而不是 unavailable', async (t) => {
  const host = makeHost(t)
  const bound = createDeps({ ...host, projectRoot: host.project.root })

  const capacity = await bound.teamAdapter.capacity()
  assert.equal(capacity.evidence.source, 'declared:re/team/capacity.json', '必须读到项目里的容量声明（D1）')
  assert.equal(capacity.memberSlots.known, true)
  assert.equal(capacity.memberSlots.total, 6)

  const unbound = createDeps({ ...host, config: { defaults: {}, presetId: 'redteam-lead' } })
  const blind = await unbound.teamAdapter.capacity()
  assert.equal(blind.evidence.source, 'unavailable', '没有 root 时容量只能是未声明（不要猜余额）')
})

// ---------------------------------------------------------------------------
// 2. invokeTool：先解析/校验出 project_root → 规范化 → 再建两个适配器 → 交给 handler
// ---------------------------------------------------------------------------

test('invokeTool 交给 handler 的 deps 是完整装配，且已绑定本次 project_root', async (t) => {
  const host = makeHost(t)
  let seen = null
  const handlers = {
    roster: async (ctx, input) => {
      seen = { deps: ctx.deps, input }
      return { envelope: ctx.deps.envelope.ok({ operationId: null, data: {} }) }
    },
  }

  const value = await invokeTool({
    tool: 'rt_roster',
    args: { project_root: host.project.root },
    exec: host.exec,
    ctx: { get: (service) => host.services[service] },
    config: host.config,
    handlers,
  })

  assert.equal(value.status, 'ok', JSON.stringify(value))
  assert.ok(seen !== null, 'handler 必须被调用')
  assert.equal(seen.input.action, 'inspect', 'roster 的默认 action 由入口填')
  for (const [key, module] of Object.entries(MODULE_NAMESPACES)) {
    assertModuleNamespace(seen.deps, key, module)
  }
  const read = await seen.deps.projectAdapter.readRoute('R-001')
  assert.equal(read.ok, true, '交给 handler 的 projectAdapter 必须已经绑定本次 project_root')
})

test('project_root 非法时不绑定适配器，但 handler 仍能返回可读错误信封', async (t) => {
  const host = makeHost(t)
  const missingRoot = join(host.project.root, 'no-such-project')

  // roster 的真实 handler 自己在 normalizeProjectRoot 上失败：必须得到 PATH_INVALID，不是崩溃。
  const viaRealHandler = await invokeTool({
    tool: 'rt_roster',
    args: { project_root: missingRoot },
    exec: host.exec,
    ctx: { get: (service) => host.services[service] },
    config: host.config,
  })
  assert.equal(viaRealHandler.status, 'error', JSON.stringify(viaRealHandler))
  assert.equal(viaRealHandler.code, 'PATH_INVALID')
  assert.equal(validateInput(schemaDefs, 'result', viaRealHandler).ok, true)

  // 装配层不因为 root 非法就吞掉调用：handler 仍被调用（stub 证明这一点）。
  let called = 0
  const value = await invokeTool({
    tool: 'rt_roster',
    args: { project_root: missingRoot },
    exec: host.exec,
    ctx: { get: (service) => host.services[service] },
    config: host.config,
    handlers: {
      roster: async (ctx) => {
        called += 1
        const read = await ctx.deps.projectAdapter.readRoute('R-001')
        assert.equal(read.ok, false, '没有绑定 root 时读不到项目记录')
        assert.equal(read.code, 'PROJECT_NOT_CONFIGURED')
        return {
          envelope: ctx.deps.envelope.blocked({
            code: 'PROJECT_NOT_CONFIGURED',
            operationId: null,
            reason: '本次调用没有可用的 project_root（由 handler 自己给出可读错误）',
            nextStep: '传入已存在、可访问的分析项目绝对路径',
            data: { phase: 'preflight' },
          }),
        }
      },
    },
  })
  assert.equal(called, 1, 'root 非法时 handler 仍要被调用，由它给出可读错误')
  assert.equal(value.status, 'blocked')
  assert.equal(value.code, 'PROJECT_NOT_CONFIGURED')
})

// ---------------------------------------------------------------------------
// 3. 派发 ↔ 收口：同一份派发记录的两个方向
//
// 这条接缝从来没有被端到端跑过：T6 只证明了自己的契约文件，T7 只证明了自己造出来的
// 派发记录。两边对**同一个文件**的字段读法必须真的对得上。
// ---------------------------------------------------------------------------

test('rt_dispatch → rt_conclude：同一份派发记录能被收口按原样读回', async (t) => {
  const asm = makeAssembled(t)
  const { project, deps, ctx, team, fakeProject } = asm

  // —— 3.1 rt_roster inspect：容量来自项目声明（projectRoot 绑到了 teamAdapter） ——
  const roster = await handleRoster(ctx, { project_root: project.root, action: 'inspect' })
  assert.equal(roster.envelope.status, 'ok', JSON.stringify(roster.envelope.diagnostics))
  const capacity = await deps.teamAdapter.capacity()
  assert.equal(capacity.evidence.source, 'declared:re/team/capacity.json', '容量来源必须是项目声明，不能是 unavailable')
  assert.equal(typeof roster.envelope.data.capacity.remaining_member_slots, 'number', '声明可用时余额必须是数字（D19：known 不上线）')

  // —— 3.2 rt_dispatch ——
  const dispatched = await handleDispatch(ctx, {
    project_root: project.root,
    operation_id: 'op-dispatch-1',
    post_id: 'cross-check',
    route_id: 'R-001',
    target_ids: ['T-001'],
    objective: '确认样本导入表与可疑字符串，交回可核验定位',
    evidence_required: ['source_location'],
    prohibited: ['不要执行样本'],
  })
  assert.equal(dispatched.envelope.status, 'ok', JSON.stringify(dispatched.envelope))
  const data = dispatched.envelope.data
  assert.equal(data.phase, 'delivered')
  assert.equal(data.started_at, null, 'delivered 不等于已开始')
  assert.match(data.dispatch_id, /^D-/u)
  assert.equal(data.attempt_id, 'A-000001')

  const task = team.snapshot().tasks.find((row) => row.id === data.task_id)
  assert.equal(task.status, 'in_progress', '任务必须被指派成 in_progress')
  assert.equal(team.snapshot().members.find((row) => row.id === task.ownerId)?.name, data.member, 'owner 必须是本次派发的成员')

  // —— 3.3 落盘的派发记录：契约 + attempt 关联记录 ——
  const contractText = await project.read(data.contract_ref)
  const contractRecord = JSON.parse(contractText)
  assert.deepEqual(contractRecord.baseline_ref.targets.map((row) => row.sha256), [SAMPLE_SHA256], 'baseline_ref 必须有真实目标字节哈希')
  assert.deepEqual(contractRecord.baseline_ref.preexisting_seals, [], '首次目标无 seal 时是空数组，但不能拿空清单代替目标身份')
  // T6 的字段形状：岗位锚点在 post 下、任务追加的在顶层；task/member 只在 attempt 记录里。
  assert.deepEqual(contractRecord.post.anchors_required, ['artifact_locator'])
  assert.deepEqual(contractRecord.evidence_required, ['artifact_locator', 'source_location'])
  assert.equal(contractRecord.task_id, undefined, '契约先于任务落盘：task 身份不在契约里')

  const attemptRef = `re/team/attempts/${data.dispatch_id}.${data.attempt_id}.json`
  const attemptRecord = JSON.parse(await project.read(attemptRef))
  assert.equal(attemptRecord.task_id, data.task_id)
  assert.equal(attemptRecord.member, data.member)
  assert.equal(attemptRecord.contract_sha256, sha256Text(contractText), 'attempt 记录里的契约摘要必须等于契约文件字节的 SHA256')

  // —— 3.4 成员交回：run + 产物 + submission ——
  const workDir = data.work_dir
  const workArtifact = `${workDir}/out/result.json`
  const runArtifact = `re/runs/${RUN_ID}/out/result.json`
  project.write(workArtifact, ARTIFACT_BYTES)
  const runRecord = {
    schema_version: 1,
    id: RUN_ID,
    route_id: 'R-001',
    status: 'completed',
    started_at: '2026-01-01T00:00:10.000Z',
    ended_at: '2026-01-01T00:01:00.000Z',
    target: { id: 'T-001', sha256: SAMPLE_SHA256 },
    command: 'probe.exe --json',
    cwd: '/attempt',
    artifacts: [{ path: runArtifact, sha256: ARTIFACT_SHA256 }],
    result: 'observed',
  }
  project.write(`re/runs/${RUN_ID}/run.json`, JSON.stringify(runRecord, null, 2))
  asm.runs[RUN_ID] = runRecord

  const submission = {
    schema_version: 1,
    dispatch_id: data.dispatch_id,
    attempt_id: data.attempt_id,
    task_id: data.task_id,
    contract_sha256: sha256Text(contractText),
    outcome: 'finding',
    summary: '导入表指向的 API 构成触发链',
    run_ids: [RUN_ID],
    artifacts: [{ path: workArtifact, sha256: ARTIFACT_SHA256 }],
    anchor_refs: [
      {
        kind: 'source_location',
        run_id: RUN_ID,
        path: runArtifact,
        locator: `sha256=${ARTIFACT_SHA256};path=re/samples/sample.bin;line=12`,
      },
      {
        kind: 'artifact_locator',
        run_id: RUN_ID,
        path: runArtifact,
        locator: `sha256=${ARTIFACT_SHA256};line=0`,
      },
    ],
    blocker: null,
    state_recovery_ref: null,
    submitted_at: '2026-01-01T00:02:00.000Z',
  }
  project.write(`${workDir}/submission.json`, JSON.stringify(submission, null, 2))
  const submissionSha = sha256Text(await project.read(`${workDir}/submission.json`))

  const concludeInput = (over) => ({
    project_root: project.root,
    operation_id: 'op-conclude-1',
    dispatch_id: data.dispatch_id,
    attempt_id: data.attempt_id,
    task_id: data.task_id,
    expected_revision: data.revision,
    submission_ref: `${workDir}/submission.json`,
    submission_sha256: submissionSha,
    review: REVIEW,
    ...over,
  })

  // 反面：收口必须读得到派发记录绑定的 task_id（它只在 attempt 记录里）。
  const wrongTask = await handleConclude(ctx, concludeInput({ operation_id: 'op-conclude-wrong', task_id: 'task-999' }))
  assert.equal(wrongTask.envelope.status, 'blocked', JSON.stringify(wrongTask.envelope))
  assert.equal(wrongTask.envelope.code, 'STALE_ATTEMPT', '任务身份必须来自派发记录（attempt 记录），不能从提交自证')

  // —— 3.5 正常收口：读同一份记录的 anchors_required / evidence_required / baseline_ref ——
  const concluded = await handleConclude(ctx, concludeInput())
  assert.equal(concluded.envelope.status, 'ok', JSON.stringify(concluded.envelope))
  assert.equal(concluded.envelope.data.phase, 'completed')
  assert.equal(concluded.envelope.data.outcome, 'finding')

  // seal 恰好一次；index 在 check 之前（check 校验 INDEX 导航区字节相等）
  assert.equal(fakeProject.callsFor('seal').length, 1, 'seal 必须恰好调用一次')
  const order = fakeProject.order()
  const indexAt = order.indexOf('index')
  const checkAt = order.indexOf('check')
  assert.ok(indexAt >= 0, `必须调用 index：${order.join('→')}`)
  assert.ok(checkAt > indexAt, `index 必须在 check 之前：${order.join('→')}`)
  assert.equal(fakeProject.callsFor('check').at(-1).args.hashes, true, 'check 必须带 --hashes')

  // 回执证明收口确实读了派发记录：锚点要求 = 岗位锚点 ∪ 契约 evidence_required；基准 = 同一份快照
  const receipt = JSON.parse(await project.read(`re/team/receipts/${data.dispatch_id}-${data.attempt_id}/receipt.json`))
  assert.deepEqual([...receipt.anchors.required_kinds].sort(), ['artifact_locator', 'source_location'])
  assert.equal(receipt.anchors.total, 2)
  assert.equal(receipt.baseline.compared.targets, 1, '基准必须真的比对了冻结的目标')
  assert.equal(receipt.baseline.ref, `re/team/baselines/${data.dispatch_id}.json`, 'baseline_ref 必须指向派发时冻结的快照')
  assert.deepEqual(receipt.seals.map((row) => row.run_id), [RUN_ID])
  assert.equal(receipt.submission.sha256, submissionSha)

  // 任务收口完成
  const concludedTask = team.snapshot().tasks.find((row) => row.id === data.task_id)
  assert.equal(concludedTask.status, 'completed')
  assert.equal(team.callsFor('updateTask').filter((call) => call.args[1]?.action === 'complete').length, 1)
})
