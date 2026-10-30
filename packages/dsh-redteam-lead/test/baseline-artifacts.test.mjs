/**
 * T17：派发基准必须冻结「**所依赖的既有已封存产物**的身份」，收口必须在**写盘之前**比对。
 *
 * 缺口（DECISIONS D37 / 验收总表 G3）：`captureBaseline()` 从来没收到 `artifacts`，所以
 * `re/team/baselines/<D>.json` 的 `artifacts` 恒为 `[]`；`compareBaseline()` 因此只比目标字节与
 * seal 文件自身。篡改**已封存 RUN 的产物**时，唯一的检测点是收口最后一刻的 `check --hashes`——
 * 那时路线已回写、INDEX 已刷新，项目停在半整合状态。
 *
 * 三条用例正好覆盖契约的三句话：
 * 1. 派发前冻结「所依赖产物的身份」，且**只冻被依赖的**（别的路线的 RUN 不扫进来）；
 * 2. 既存项内容变化 → 收口在归档/回写/index/完成任务之前 `BASELINE_MISMATCH`；
 * 3. 其他路线正常新增 seal **不**使旧快照失效（不误伤）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

import { createDeps, handlerContext } from '../dist/index.js'
import { baselineRefFor } from '../dist/baseline.js'
import { handleConclude } from '../dist/conclude.js'
import { handleDispatch } from '../dist/dispatch.js'
import { makeFakeTools, makeTempProject } from './helpers/host.mjs'
import { createFakeProject } from './helpers/fake-project.mjs'
import { createFakeTeam } from './helpers/fake-team.mjs'

const SAMPLE_BYTES = 'SAMPLE-BYTES-0123456789'
const SAMPLE_SHA256 = sha256(SAMPLE_BYTES)
const ARTIFACT_BYTES = '{"probe":"ok","value":42}'
const ARTIFACT_SHA256 = sha256(ARTIFACT_BYTES)

/** 路线 `evidence` 声明的既有 RUN（已封存）。 */
const DEP_RUN = 'RUN-DEP'
/** 路线 `dependency_runs` 声明的既有 RUN（已封存，跨路线）。 */
const DEP_RUN_2 = 'RUN-DEP-2'
/** 本路线、同目标、已封存但路线没显式声明（「目标已有 seal 背后的既有证据」）。 */
const SAME_TARGET_RUN = 'RUN-SEALED-ROUTE'
/** **别的路线**、同目标、已封存 —— 不许冻进本次快照。 */
const OTHER_RUN = 'RUN-OTHER'
/** 路线声明但**尚未封存** —— 产物身份还不是不可变事实，不冻结。 */
const OPEN_RUN = 'RUN-OPEN'
/** 本次交付的 RUN。 */
const NEW_RUN = 'RUN-NEW'

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
  dependency_runs: [DEP_RUN_2],
  evidence: [DEP_RUN, OPEN_RUN],
})

const BASE_TOOLS = { default: { read: {}, write: {}, glob: {}, grep: {} } }

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function artifactPath(runId) {
  return `re/runs/${runId}/artifacts/evidence.txt`
}

/** 一个「已封存的既有 RUN」：目标/路线/产物都写清楚。 */
function existingRun(runId, { routeId = 'R-001', targetId = 'T-001', bytes = `${runId}-ARTIFACT` } = {}) {
  return {
    schema_version: 1,
    id: runId,
    route_id: routeId,
    status: 'completed',
    started_at: '2026-01-01T00:00:10.000Z',
    ended_at: '2026-01-01T00:01:00.000Z',
    target: { id: targetId, sha256: SAMPLE_SHA256 },
    command: 'probe.exe --json',
    cwd: '/attempt',
    artifacts: [{ path: artifactPath(runId), sha256: sha256(bytes) }],
    result: 'observed',
  }
}

/** 宿主形状的服务与执行上下文（与 `makeCtx` 同源，但 `deps` 由 `createDeps` 真装配）。 */
function makeHost(t, options = {}) {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': SAMPLE_BYTES,
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', path: 're/samples/sample.bin', sha256: SAMPLE_SHA256 }],
      }),
      // T23：本包不再读/写容量声明；这个文件已无消费方，故意不再放。
      're/routes/R-001.json': JSON.stringify(ROUTE),
    },
  })
  const clock = { now: () => Date.UTC(2026, 0, 1), isoNow: () => '2026-01-01T00:00:00.000Z' }
  const team = createFakeTeam({ role: 'lead', members: [], tasks: [], clock: () => clock.now() })
  const services = { agentTeams: team.service, tools: makeFakeTools(options.tools ?? BASE_TOOLS) }
  const exec = { agent: team.agent, signal: new AbortController().signal, cwd: project.root }
  const config = { defaults: {}, presetId: 'redteam-lead', bundleRoot: undefined, projectRoot: project.root }
  return { project, team, services, exec, config, clock }
}

/**
 * 真装配（`createDeps`）+ 契约级项目替身：只有 project skill 的 CLI 层是替身，`deps.baseline`
 * 是**真实模块**——这正是生产路径，也是 T17 缺口所在的那条缝。
 */
function makeAssembled(t, options = {}) {
  const host = makeHost(t, options)
  const deps = createDeps({ ...host, projectRoot: host.project.root })
  const runs = { ...(options.runs ?? {}) }
  const seals = options.seals ?? []
  const fakeProject = createFakeProject({
    projectRoot: host.project.root,
    routes: { 'R-001': ROUTE },
    runs,
    seals,
  })
  deps.projectAdapter = fakeProject
  deps.clock = host.clock
  const ctx = handlerContext({ deps, exec: host.exec, services: host.services, config: host.config })
  return { ...host, deps, fakeProject, runs, seals, ctx }
}

function dispatchInput(over = {}) {
  return {
    project_root: '',
    operation_id: 'op-dispatch-1',
    post_id: 'cross-check',
    route_id: 'R-001',
    target_ids: ['T-001'],
    objective: '确认样本导入表与可疑字符串，交回可核验定位',
    evidence_required: ['source_location'],
    prohibited: ['不要执行样本'],
    ...over,
  }
}

/** 三个既有封存 RUN 的物理产物落盘（内容 = 各自声明哈希对应的字节）。 */
function writeExistingArtifacts(project, runs) {
  for (const run of Object.values(runs)) {
    for (const artifact of run.artifacts ?? []) {
      const bytes = `${run.id}-ARTIFACT`
      project.write(artifact.path, bytes)
    }
  }
}

function sealRow(runId) {
  return { path: `re/seals/runs/${runId}.json`, sha256: sha256(`SEAL-${runId}`), bytes: 64 }
}

/** 一次成功派发 + 一份可收口的提交；返回收口所需的一切。 */
async function dispatchAndSubmit(t, options = {}) {
  const depRun = existingRun(DEP_RUN)
  const depRun2 = existingRun(DEP_RUN_2, { routeId: 'R-002', targetId: 'T-002' })
  const sameTargetRun = existingRun(SAME_TARGET_RUN)
  const otherRun = existingRun(OTHER_RUN, { routeId: 'R-002' })
  const runs = {
    [DEP_RUN]: depRun,
    [DEP_RUN_2]: depRun2,
    [SAME_TARGET_RUN]: sameTargetRun,
    [OTHER_RUN]: otherRun,
    ...(options.runs ?? {}),
  }
  const sealList = options.seals ?? [
    { path: 're/seals/targets/T-001.json', sha256: sha256('SEAL-T-001'), bytes: 96 },
    sealRow(DEP_RUN),
    sealRow(DEP_RUN_2),
    sealRow(SAME_TARGET_RUN),
    sealRow(OTHER_RUN),
  ]
  const asm = makeAssembled(t, { runs, seals: sealList })
  writeExistingArtifacts(asm.project, runs)

  const dispatched = await handleDispatch(asm.ctx, dispatchInput({
    project_root: asm.project.root,
    ...(options.dispatch ?? {}),
  }))
  assert.equal(dispatched.envelope.status, 'ok', JSON.stringify(dispatched.envelope))

  const data = dispatched.envelope.data
  const contractText = await asm.project.read(data.contract_ref)
  const workDir = data.work_dir
  const workArtifact = `${workDir}/out/result.json`
  const runArtifact = `re/runs/${NEW_RUN}/out/result.json`
  asm.project.write(workArtifact, ARTIFACT_BYTES)
  const newRun = {
    schema_version: 1,
    id: NEW_RUN,
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
  asm.project.write(`re/runs/${NEW_RUN}/run.json`, JSON.stringify(newRun, null, 2))
  asm.runs[NEW_RUN] = newRun

  const submission = {
    schema_version: 1,
    dispatch_id: data.dispatch_id,
    attempt_id: data.attempt_id,
    task_id: data.task_id,
    contract_sha256: sha256(contractText),
    outcome: 'finding',
    summary: '导入表指向的 API 构成触发链',
    run_ids: [NEW_RUN],
    artifacts: [{ path: workArtifact, sha256: ARTIFACT_SHA256 }],
    anchor_refs: [
      {
        kind: 'source_location',
        run_id: NEW_RUN,
        path: runArtifact,
        locator: `sha256=${ARTIFACT_SHA256};path=re/samples/sample.bin;line=12`,
      },
      {
        kind: 'artifact_locator',
        run_id: NEW_RUN,
        path: runArtifact,
        locator: `sha256=${ARTIFACT_SHA256};line=0`,
      },
    ],
    blocker: null,
    state_recovery_ref: null,
    submitted_at: '2026-01-01T00:02:00.000Z',
  }
  asm.project.write(`${workDir}/submission.json`, JSON.stringify(submission, null, 2))
  const submissionSha = sha256(await asm.project.read(`${workDir}/submission.json`))

  const review = {
    outcome: 'finding',
    summary: '导入表指向的 API 构成触发链',
    reason: '观测到定位与调用序列，并有对照',
    proposed_route_status: 'validated',
    evidence_run_ids: [NEW_RUN],
    anchor_refs: [],
    limitations: ['只覆盖单进程'],
    next_step: null,
  }

  const concludeInput = (over = {}) => ({
    project_root: asm.project.root,
    operation_id: 'op-conclude-1',
    dispatch_id: data.dispatch_id,
    attempt_id: data.attempt_id,
    task_id: data.task_id,
    expected_revision: data.revision,
    submission_ref: `${workDir}/submission.json`,
    submission_sha256: submissionSha,
    review,
    ...over,
  })

  return {
    ...asm,
    taskId: data.task_id,
    dispatchId: data.dispatch_id,
    attemptId: data.attempt_id,
    receiptDir: `re/team/receipts/${data.dispatch_id}-${data.attempt_id}`,
    concludeInput,
  }
}

function baselinePathOf(dispatchId) {
  return baselineRefFor(dispatchId)
}

async function exists(target) {
  return fsp.stat(target).then(() => true).catch(() => false)
}

// ---------------------------------------------------------------------------
// 1. 派发侧：真的把「所依赖的既有已封存产物」冻进快照，且只冻被依赖的
// ---------------------------------------------------------------------------

test('派发冻结被依赖的已封存 RUN 产物；别的路线/未封存的一律不进快照', async (t) => {
  const fx = await dispatchAndSubmit(t)

  const baseline = JSON.parse(await fx.project.read(baselinePathOf(fx.dispatchId)))
  assert.ok(Array.isArray(baseline.artifacts), '基准快照必须有 artifacts 数组')
  assert.deepEqual(
    baseline.artifacts.map((entry) => entry.path),
    [artifactPath(DEP_RUN), artifactPath(DEP_RUN_2), artifactPath(SAME_TARGET_RUN)].sort(),
    '只冻结：路线 evidence 声明 ∧ 已封存、路线 dependency_runs 声明 ∧ 已封存、本路线同目标已封存；'
      + '别的路线（RUN-OTHER）与未封存（RUN-OPEN）都不许进快照',
  )
  for (const entry of baseline.artifacts) {
    const matched = /^re\/runs\/([^/]+)\//u.exec(entry.path)
    assert.ok(matched, `产物路径必须落在 RUN 目录下：${entry.path}`)
    assert.equal(entry.sha256, sha256(`${matched[1]}-ARTIFACT`), '冻结的必须是 run.json 声明的字节哈希')
  }
  // 契约里带着同一份快照：收口读的就是它。
  const contract = JSON.parse(await fx.project.read(`re/team/dispatches/${fx.dispatchId}.json`))
  assert.deepEqual(contract.baseline_ref.artifacts, baseline.artifacts)
})

// ---------------------------------------------------------------------------
// 2. 收口侧：篡改被依赖的已封存产物 → 写盘之前 BASELINE_MISMATCH（零写盘）
// ---------------------------------------------------------------------------

test('篡改被依赖的已封存产物 → BASELINE_MISMATCH，且路线/index/任务都没动', async (t) => {
  const fx = await dispatchAndSubmit(t)
  const routeBefore = await fx.project.read('re/routes/R-001.json')
  const callsBefore = fx.fakeProject.calls.length

  // 改一个字节就够：这不是本次提交自报的产物（那条走 SUBMISSION_INVALID），
  // 而是「依赖的既有证据变了」——只有基准快照里的产物身份能发现。
  const original = await fx.project.read(artifactPath(DEP_RUN))
  fx.project.write(artifactPath(DEP_RUN), `X${original.slice(1)}`)

  const { envelope } = await handleConclude(fx.ctx, fx.concludeInput())

  assert.equal(envelope.code, 'BASELINE_MISMATCH', JSON.stringify(envelope))
  assert.equal(envelope.status, 'blocked', '写盘前拒绝：没有任何成员/任务/正式路线/正式证据变更')
  assert.match(envelope.diagnostics[0].reason, /artifact/u)
  assert.match(envelope.diagnostics[0].reason, /changed/u)

  // 零写盘：路线字节不变、index 未刷新、没有归档（回执目录都不该存在）、任务未完成。
  assert.equal(await fx.project.read('re/routes/R-001.json'), routeBefore, '路线文件必须逐字节不变')
  const after = fx.fakeProject.calls.slice(callsBefore).map((call) => call.command)
  assert.ok(!after.includes('index'), `拒绝时不得刷新 INDEX：${after.join('→')}`)
  assert.ok(!after.includes('seal'), `拒绝时不得封存：${after.join('→')}`)
  assert.ok(!after.includes('check'), `拒绝时不得跑到最后的 check --hashes：${after.join('→')}`)
  assert.equal(
    await exists(path.join(fx.project.root, ...`${fx.receiptDir}/mapping.json`.split('/'))),
    false,
    '归档发生在基准比对之后：拒绝时不得留下归档映射',
  )
  const task = fx.team.snapshot().tasks.find((row) => row.id === fx.taskId)
  assert.equal(task.status, 'in_progress', '任务不得被完成')
  const completes = fx.team.callsFor('updateTask').filter((call) => call.args[1]?.action === 'complete')
  assert.equal(completes.length, 0, '拒绝时不得完成任务')
})

// ---------------------------------------------------------------------------
// 3. 反例（不许误伤）：别的路线新增 seal 不使旧快照失效
// ---------------------------------------------------------------------------

test('别的路线新增 seal 后，旧派发收口仍然通过（快照只比它自己冻结的项）', async (t) => {
  const fx = await dispatchAndSubmit(t)

  // 派发之后，另一条路线正常封存了一个新 RUN（同目标，但不是本派发依赖的）。
  const lateRun = existingRun('RUN-LATE-OTHER', { routeId: 'R-002' })
  fx.project.write(artifactPath('RUN-LATE-OTHER'), 'RUN-LATE-OTHER-ARTIFACT')
  fx.runs['RUN-LATE-OTHER'] = lateRun
  fx.fakeProject.seals.push(sealRow('RUN-LATE-OTHER'))

  const { envelope } = await handleConclude(fx.ctx, fx.concludeInput())
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))

  const receipt = JSON.parse(await fx.project.read(`${fx.receiptDir}/receipt.json`))
  assert.deepEqual(
    receipt.baseline.compared,
    { targets: 1, preexisting_seals: 5, artifacts: 3 },
    '快照只比它自己冻结的项：新 seal 既不进比对数量，也不让旧快照失效',
  )
  assert.equal(
    fx.fakeProject.callsFor('seal').filter((call) => call.args.runId === 'RUN-LATE-OTHER').length,
    0,
    '别的路线自己的 RUN 不由本次收口封存',
  )
})
