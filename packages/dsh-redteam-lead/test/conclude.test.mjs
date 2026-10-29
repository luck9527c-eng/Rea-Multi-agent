import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

import * as atomic from '../dist/atomic.js'
import * as baseline from '../dist/baseline.js'
import * as paths from '../dist/paths.js'
import * as validate from '../dist/validate.js'
import { schemaDefs } from '../dist/tool-schema.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'
import { createFakeProject } from './helpers/fake-project.mjs'
import { createFakeTeam } from './helpers/fake-team.mjs'
import { handleConclude } from '../dist/conclude.js'

const SHA = (char) => char.repeat(64)
/** 派发侧冻结的规则摘要（与 `fake-project` 的默认探测结果一致，代表「副本没被改过」）。 */
const FROZEN_RULE = 'a'.repeat(64)

const DISPATCH = 'D-abc123'
const ATTEMPT = 'A-000001'
const TASK = 'task-7'
const ROUTE = 'R-001'
const RUN = 'RUN-1'
const WORK = `re/team/work/${DISPATCH}/${ATTEMPT}`
const SUBMISSION_REF = `${WORK}/submission.json`
const WORK_ARTIFACT = `${WORK}/out/result.json`
const RUN_ARTIFACT = `re/runs/${RUN}/out/result.json`
const RECEIPT_DIR = `re/team/receipts/${DISPATCH}-${ATTEMPT}`
const RECEIPT_REF = `${RECEIPT_DIR}/receipt.json`

const ARTIFACT_BYTES = '{"probe":"ok","value":42}'

function routeFixture({ status = 'active', evidence = [RUN], closure = null, id = ROUTE } = {}) {
  return {
    schema_version: 1,
    id,
    status,
    question: 'COM 接口能否在外部进程里调用？',
    hypothesis: '通过 CoCreateInstance 可以调用',
    target_ids: ['T-001'],
    depends_on: [],
    condition_ids: [],
    condition_reviews: [],
    prerequisites: [],
    experiment: {
      action: '注入测试 DLL 并调用接口',
      expected: '调用返回 S_OK',
      falsifier: '调用返回 E_NOINTERFACE 且对照通过',
    },
    budget: { limit: '2 小时', stop_when: '预算耗尽' },
    evidence,
    state_reason: '等待收口',
    resume_when: '',
    closure,
    history: [{ at: '2026-01-01T00:00:00.000Z', from: null, to: status, reason: '初始建立', evidence: [] }],
  }
}

function reviewFixture({ outcome = 'finding', proposed = 'validated', runIds = [RUN], anchors, overrides = {} } = {}) {
  const defaultAnchors = runIds.length === 0
    ? []
    : [
      {
        kind: 'source_location',
        run_id: RUN,
        path: RUN_ARTIFACT,
        locator: `sha256=${SHA('a')};path=re/samples/app.exe;line=12`,
      },
      {
        kind: 'artifact_locator',
        run_id: RUN,
        path: RUN_ARTIFACT,
        locator: `sha256=${SHA('b')};line=0`,
      },
    ]
  return {
    outcome,
    summary: 'COM 接口在外部进程调用成功',
    reason: '观测到 S_OK，并有对照实验',
    proposed_route_status: proposed,
    evidence_run_ids: runIds,
    anchor_refs: anchors ?? defaultAnchors,
    limitations: ['只覆盖 Windows x64 单进程'],
    next_step: '继续验证依赖 DLL 的加载顺序',
    ...overrides,
  }
}

/**
 * 搭一个「可收口」的项目状态：目标、基准、dispatch、提交、RUN、路线、任务板。
 */
async function setup(t, options = {}) {
  const project = makeTempProject({ t })
  project.write('re/samples/app.exe', 'MZ-目标样本')
  const targetHash = atomic.sha256Bytes(await fsp.readFile(path.join(project.root, 're/samples/app.exe')))
  project.write('re/targets.json', {
    schema_version: 1,
    targets: [
      {
        id: 'T-001',
        path: 're/samples/app.exe',
        sha256: targetHash,
        version: '1.0',
        platform: 'windows',
        arch: 'x64',
        source: 'sample',
      },
    ],
  })

  project.write(WORK_ARTIFACT, ARTIFACT_BYTES)
  const artifactHash = atomic.sha256Bytes(Buffer.from(ARTIFACT_BYTES, 'utf8'))

  const run = {
    schema_version: 1,
    id: RUN,
    route_id: ROUTE,
    status: options.runStatus ?? 'completed',
    started_at: '2026-01-01T00:00:10.000Z',
    ended_at: '2026-01-01T00:01:00.000Z',
    target: { id: 'T-001', sha256: targetHash },
    command: 'C:/tools/probe.exe --json',
    cwd: '/work/attempt',
    artifacts: [{ path: RUN_ARTIFACT, sha256: artifactHash }],
    result: 'S_OK',
    limitations: '单进程',
  }
  project.write(`re/runs/${RUN}/run.json`, run)
  const runJsonBefore = await project.read(`re/runs/${RUN}/run.json`)

  const route = options.routeOverride === undefined
    ? routeFixture({ status: options.routeStatus ?? 'active', closure: options.routeClosure ?? null })
    : options.routeOverride
  const fakeProject = createFakeProject({
    projectRoot: project.root,
    routes: { [ROUTE]: route, ...(options.extraRoutes ?? {}) },
    runs: { [RUN]: run },
    seals: options.seals ?? [],
    ...(options.projectResponses === undefined ? {} : { responses: options.projectResponses }),
  })

  const baselineCaptured = await baseline.captureBaseline({
    root: project.root,
    dispatchId: DISPATCH,
    attemptId: ATTEMPT,
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: fakeProject,
    clock: { isoNow: () => '2026-01-01T00:00:00.000Z', now: () => Date.UTC(2026, 0, 1) },
    fs: fsp,
    paths: paths,
    atomic,
  })
  assert.equal(baselineCaptured.ok, true, JSON.stringify(baselineCaptured))

  // 派发记录按「T6 契约本体」的形状造：`anchors_required` 在 `post` 里，
  // `evidence_required` 在顶层。传 `null` 表示**省略该键**（旧记录 / 被剥掉字段的形状）。
  project.write(`re/team/dispatches/${DISPATCH}.json`, {
    schema_version: 1,
    dispatch_id: DISPATCH,
    attempt_id: ATTEMPT,
    task_id: TASK,
    route_id: ROUTE,
    member: 'rt-scout',
    contract_sha256: options.contractSha ?? SHA('c'),
    // 新派发一定带 rule_digest（派发侧冻结）；`null` 表示**省略该键**，模拟旧记录/被剥掉字段。
    ...(options.ruleDigest === null ? {} : { rule_digest: options.ruleDigest ?? FROZEN_RULE }),
    baseline_ref: baselineCaptured.ref,
    target_ids: ['T-001'],
    ...(options.anchorsRequired === null ? {} : { anchors_required: options.anchorsRequired ?? ['source_location'] }),
    ...(options.evidenceRequired === null ? {} : { evidence_required: options.evidenceRequired ?? ['artifact_locator'] }),
    ...(options.dispatchPost === undefined ? {} : { post: options.dispatchPost }),
    work_dir: WORK,
  })

  const submission = {
    schema_version: 1,
    dispatch_id: DISPATCH,
    attempt_id: ATTEMPT,
    task_id: TASK,
    contract_sha256: options.contractSha ?? SHA('c'),
    outcome: options.outcome ?? 'finding',
    summary: 'COM 接口在外部进程调用成功',
    run_ids: options.runIds ?? [RUN],
    artifacts: options.submissionArtifacts
      ?? ((options.runIds ?? [RUN]).length === 0 ? [] : [{ path: WORK_ARTIFACT, sha256: artifactHash }]),
    anchor_refs: [],
    blocker: options.blocker ?? null,
    state_recovery_ref: options.stateRecoveryRef ?? null,
    submitted_at: '2026-01-01T00:02:00.000Z',
    ...(options.submissionOverrides ?? {}),
  }
  project.write(SUBMISSION_REF, submission)
  const submissionSha = atomic.sha256Bytes(await fsp.readFile(path.join(project.root, ...SUBMISSION_REF.split('/'))))

  const taskStatus = options.taskStatus ?? 'in_progress'
  const team = createFakeTeam({
    role: options.role ?? 'lead',
    members: [{ name: 'rt-scout' }],
    tasks: [
      {
        id: TASK,
        subject: '验证 COM 接口',
        description: `dispatch ${DISPATCH} attempt ${ATTEMPT}`,
        status: taskStatus,
        ...(taskStatus === 'pending' ? {} : { owner: 'rt-scout' }),
        revision: options.taskRevision ?? 3,
      },
    ],
  })

  // 夹具搭完再清空调用流水：断言里只看 conclude 自己触发的 adapter 调用。
  fakeProject.reset()

  const ctx = makeCtx({
    role: options.role ?? 'lead',
    projectRoot: project.root,
    team,
    project: fakeProject,
    t,
  })

  const input = {
    project_root: project.root,
    operation_id: options.operationId ?? 'op-conclude-1',
    dispatch_id: DISPATCH,
    attempt_id: ATTEMPT,
    task_id: TASK,
    expected_revision: options.expectedRevision ?? 3,
    submission_ref: options.submissionRef ?? SUBMISSION_REF,
    submission_sha256: options.submissionSha ?? submissionSha,
    review: options.review ?? reviewFixture({
      outcome: options.outcome ?? 'finding',
      proposed: options.proposed ?? 'validated',
      runIds: options.runIds ?? [RUN],
      anchors: options.anchors,
      overrides: options.reviewOverrides,
    }),
  }

  return {
    ctx,
    input,
    project,
    team,
    fakeProject,
    runJsonBefore,
    artifactHash,
    targetHash,
    submissionSha,
    baselineRef: baselineCaptured.ref,
    writeSubmission(overrides) {
      const next = { ...submission, ...overrides }
      project.write(SUBMISSION_REF, next)
      return atomic.sha256Bytes(Buffer.from(JSON.stringify(next, null, 2), 'utf8'))
    },
  }
}

function auditLines(project) {
  return project
    .read('re/team/audit.jsonl')
    .then((text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => [])
}

test('工兵调用 → ROLE_REQUIRED，且零副作用', async (t) => {
  for (const role of ['teammate', 'none']) {
    const fx = await setup(t, { role })
    const before = fx.fakeProject.calls.length
    const { envelope } = await handleConclude(fx.ctx, fx.input)
    assert.equal(envelope.status, 'error')
    assert.equal(envelope.code, 'ROLE_REQUIRED')
    assert.equal(fx.fakeProject.calls.length, before, '不应触碰项目 adapter')
    assert.equal(fx.team.callsFor('updateTask').length, 0)
    assert.equal(fx.team.callsFor('getTask').length, 0)
    const exists = await fsp.stat(path.join(fx.project.root, 're/team/receipts')).then(() => true).catch(() => false)
    assert.equal(exists, false, '角色拒绝不得写回执')
    const lockExists = await fsp.stat(path.join(fx.project.root, 're/team/lock')).then(() => true).catch(() => false)
    assert.equal(lockExists, false, '角色拒绝不得取锁')
    assert.deepEqual(await auditLines(fx.project), [])
  }
})

test('正常 finding 交付：readRoute→probe→impact→readRun→readSeals→seal→impact→index→check，任务完成并落回执', async (t) => {
  const fx = await setup(t)
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(envelope.code, null)
  assert.deepEqual(validate.validateInput(schemaDefs, 'result', envelope).issues, [], '返回信封必须通过 $defs.result')
  assert.deepEqual(
    validate.validateInput(schemaDefs, 'concludeData', envelope.data).issues,
    [],
    'ok 的 data 必须通过 $defs.concludeData',
  )
  // `probe` 是 T14 之后**每次**收口都必跑的一步：派发记录冻结了规则摘要，就要拿当前副本复核一次。
  assert.deepEqual(fx.fakeProject.order(), [
    'readRoute',
    'probe',
    'impact',
    'readRun',
    'readSeals',
    'seal',
    'impact',
    'index',
    'check',
  ])
  const checkCall = fx.fakeProject.callsFor('check').at(-1)
  assert.equal(checkCall.args.hashes, true, 'check 必须带 --hashes')

  const data = envelope.data
  assert.equal(data.phase, 'completed')
  assert.equal(data.outcome, 'finding')
  assert.equal(data.route_status, 'validated')
  assert.equal(data.receipt_ref, RECEIPT_REF)
  assert.equal(data.audit_written, true)
  assert.ok(data.checks.length >= 1)
  for (const check of data.checks) {
    assert.equal(check.status, 'pass')
    const stat = await fsp.stat(path.join(fx.project.root, ...check.output_ref.split('/')))
    assert.ok(stat.isFile(), `${check.name} 的 output_ref 必须落盘`)
  }

  const completed = fx.team.snapshot().tasks.find((task) => task.id === TASK)
  assert.equal(completed.status, 'completed')
  assert.ok(completed.ownerId !== undefined, 'completed 保留 owner')
  assert.equal(fx.team.callsFor('updateTask').length, 1)
  assert.equal(fx.team.callsFor('updateTask')[0].args[1].action, 'complete')

  const receipt = JSON.parse(await fx.project.read(RECEIPT_REF))
  assert.equal(receipt.outcome, 'finding')
  assert.equal(receipt.route_status, 'validated')
  assert.equal(receipt.success_dependency_satisfied, true)
  assert.equal(receipt.unreviewed_completion, false)
  assert.equal(receipt.business_key.dispatch_id, DISPATCH)
  assert.equal(receipt.result.status, 'ok')
  assert.deepEqual(receipt.seals, [{ run_id: RUN, action: 'sealed', path: `re/seals/runs/${RUN}.json` }])

  const submissionCopy = await fx.project.read(`${RECEIPT_DIR}/submission.json`)
  assert.equal(atomic.sha256Bytes(Buffer.from(submissionCopy, 'utf8')), fx.submissionSha)

  const mapping = JSON.parse(await fx.project.read(`${RECEIPT_DIR}/mapping.json`))
  assert.equal(mapping.artifacts[0].source_path, WORK_ARTIFACT)
  assert.equal(mapping.artifacts[0].archived_path, RUN_ARTIFACT)
  assert.equal(mapping.artifacts[0].sha256, fx.artifactHash)
  assert.equal(mapping.execution.command, 'C:/tools/probe.exe --json')
  assert.equal(mapping.execution.cwd, '/work/attempt')

  assert.equal(atomic.sha256Bytes(Buffer.from(await fx.project.read(`re/runs/${RUN}/run.json`), 'utf8')),
    atomic.sha256Bytes(Buffer.from(fx.runJsonBefore, 'utf8')), '归档不得改写执行事实')

  const route = JSON.parse(await fx.project.read(`re/routes/${ROUTE}.json`))
  assert.equal(route.status, 'validated')
  assert.equal(route.history.at(-1).from, 'active')
  assert.equal(route.history.at(-1).to, 'validated')
  assert.deepEqual(route.history.at(-1).evidence, [RUN])
  assert.equal(route.closure.summary, 'COM 接口在外部进程调用成功')

  const audits = await auditLines(fx.project)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].kind, 'conclude')
  assert.equal(audits[0].route, ROUTE)
  assert.equal(audits[0].task, TASK)
  assert.equal(audits[0].member, 'rt-scout')
  assert.equal(audits[0].requester, 'lead')
  assert.equal(audits[0].verdict, 'finding')

  const lockHeld = await fsp.stat(path.join(fx.project.root, 're/team/lock')).then(() => true).catch(() => false)
  assert.equal(lockHeld, false, '收口结束后必须释放项目锁')
  const ledger = JSON.parse(await fx.project.read(`re/team/operations/op-conclude-1.json`))
  assert.equal(ledger.phase, 'completed')
  assert.equal(ledger.data.receipt_ref, RECEIPT_REF)
})

test('check --hashes 失败 → CHECK_FAILED + partial，任务不完成，保留 stdout/stderr/exitCode/阶段', async (t) => {
  const fx = await setup(t, {
    projectResponses: {
      check: { exitCode: 1, stdout: '{"targets":1}', stderr: 'ERROR: R-001: history/status mismatch', code: 'CHECK_FAILED' },
    },
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  // 走到 check 时归档/seal/index 都已完成：按编排契约这是「已持久化后失败」，必须报 partial。
  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.equal(envelope.data.phase, 'integrating')
  assert.deepEqual(validate.validateInput(schemaDefs, 'result', envelope).issues, [], '失败信封也必须通过 $defs.result')
  assert.match(envelope.diagnostics[0].reason, /history\/status mismatch/u)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
  assert.equal(fx.team.callsFor('updateTask').length, 0)
  const failed = JSON.parse(await fx.project.read(`${RECEIPT_DIR}/failed-op-conclude-1.json`))
  assert.equal(failed.stage, 'check')
  assert.equal(failed.exit_code, 1)
  assert.match(failed.stderr, /history\/status mismatch/u)
  const exists = await fsp.stat(path.join(fx.project.root, ...RECEIPT_REF.split('/'))).then(() => true).catch(() => false)
  assert.equal(exists, false, '失败不得写最终回执')
})

test('index 失败 → CHECK_FAILED + partial，且不调用 check', async (t) => {
  const fx = await setup(t, {
    projectResponses: { index: { exitCode: 1, stdout: '', stderr: 'ERROR: INDEX nav write failed' } },
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(envelope.data.phase, 'integrating')
  assert.match(envelope.diagnostics[0].reason, /INDEX nav write failed/u)
  assert.equal(fx.fakeProject.callsFor('check').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('seal 失败 → CHECK_FAILED + partial，且不再继续 impact/index/check', async (t) => {
  const fx = await setup(t, {
    projectResponses: { seal: { exitCode: 1, stdout: '', stderr: 'ERROR: RUN-1: target hash mismatch' } },
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(envelope.data.phase, 'integrating')
  assert.match(envelope.diagnostics[0].reason, /target hash mismatch/u)
  assert.equal(fx.fakeProject.callsFor('index').length, 0)
  assert.equal(fx.fakeProject.callsFor('check').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('已有封存只校验复用：不调用 seal', async (t) => {
  const fx = await setup(t, {
    seals: [{ path: `re/seals/runs/${RUN}.json`, sha256: SHA('7'), bytes: 120 }],
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(fx.fakeProject.callsFor('seal').length, 0, '已封存的 RUN 不得重封存')
  const receipt = JSON.parse(await fx.project.read(RECEIPT_REF))
  assert.deepEqual(receipt.seals, [{ run_id: RUN, action: 'reused', path: `re/seals/runs/${RUN}.json` }])
})

test('基准失效：目标字节被改动 → BASELINE_MISMATCH（归档后才发现副作用 → partial），且不封存', async (t) => {
  const fx = await setup(t)
  fx.project.write('re/samples/app.exe', '被换掉的目标')
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'BASELINE_MISMATCH')
  // 基准比对排在步骤 4 归档之后：正式 re/runs 字节可能已经落盘，所以不是「什么都没发生」。
  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('基准失效：既有 seal 被删除 → BASELINE_MISMATCH', async (t) => {
  const fx = await setup(t, { seals: [{ path: 're/seals/runs/RUN-0.json', sha256: SHA('8'), bytes: 10 }] })
  fx.fakeProject.seals.length = 0
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'BASELINE_MISMATCH')
  assert.match(envelope.diagnostics[0].reason, /seal_missing/u)
})

test('同一 operation_id 重放 → 原回执 replayed=true，不重复 seal/完成/审计', async (t) => {
  const fx = await setup(t)
  const first = await handleConclude(fx.ctx, fx.input)
  assert.equal(first.envelope.status, 'ok')
  const callsAfterFirst = fx.fakeProject.calls.length
  const bytesAfterFirst = await fx.project.read(RECEIPT_REF)

  const second = await handleConclude(fx.ctx, fx.input)
  assert.equal(second.envelope.status, 'ok')
  assert.equal(second.envelope.replayed, true)
  assert.equal(second.envelope.data.receipt_ref, first.envelope.data.receipt_ref)
  assert.equal(fx.fakeProject.calls.length, callsAfterFirst, '重放不得再触碰 adapter')
  assert.equal(fx.team.callsFor('updateTask').length, 1, '重放不得重复 complete')
  assert.equal((await auditLines(fx.project)).length, 1)
  assert.equal(await fx.project.read(RECEIPT_REF), bytesAfterFirst, '重放不得改写回执')
})

test('不同 operation_id 指向同一 attempt → 业务身份去重，不重复 seal/history/审计', async (t) => {
  const fx = await setup(t)
  await handleConclude(fx.ctx, fx.input)
  const callsAfterFirst = fx.fakeProject.calls.length
  const routeAfterFirst = await fx.project.read(`re/routes/${ROUTE}.json`)

  const second = await handleConclude(fx.ctx, { ...fx.input, operation_id: 'op-conclude-2' })
  assert.equal(second.envelope.status, 'ok')
  assert.equal(second.envelope.replayed, true)
  assert.equal(fx.fakeProject.calls.length, callsAfterFirst, '不同 ID 同一 attempt 不得重复封存/校验')
  assert.equal(fx.team.callsFor('updateTask').length, 1)
  assert.equal((await auditLines(fx.project)).length, 1)
  assert.equal(await fx.project.read(`re/routes/${ROUTE}.json`), routeAfterFirst, '不得重复追加 history')
})

test('同一 operation_id 改内容 → OPERATION_CONFLICT（不覆盖既有台账）', async (t) => {
  const fx = await setup(t)
  await handleConclude(fx.ctx, fx.input)
  const callsAfterFirst = fx.fakeProject.calls.length

  const conflict = await handleConclude(fx.ctx, {
    ...fx.input,
    review: { ...fx.input.review, summary: '换了结论内容' },
  })
  assert.equal(conflict.envelope.code, 'OPERATION_CONFLICT')
  assert.equal(fx.fakeProject.calls.length, callsAfterFirst)
  assert.equal(fx.team.callsFor('updateTask').length, 1)
})

test('expected_revision 过期 → REVISION_CONFLICT 并带实际 revision，不覆盖他人决定', async (t) => {
  const fx = await setup(t, { expectedRevision: 2, taskRevision: 5 })
  const callsBefore = fx.fakeProject.calls.length
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'REVISION_CONFLICT')
  assert.equal(envelope.data.actual_revision, 5)
  assert.match(envelope.diagnostics[0].reason, /5/u)
  assert.equal(fx.fakeProject.calls.length, callsBefore, 'CAS 冲突前不得动正式记录')
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).revision, 5)
})

test('task 仍 pending → 拒绝收口，零副作用', async (t) => {
  const fx = await setup(t, { taskStatus: 'pending' })
  const callsBefore = fx.fakeProject.calls.length
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'STALE_ATTEMPT')
  assert.equal(fx.fakeProject.calls.length, callsBefore)
  assert.equal(fx.team.callsFor('updateTask').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'pending')
})

test('submission_ref 指向别的 attempt → PATH_INVALID', async (t) => {
  const fx = await setup(t, { submissionRef: 're/team/work/D-abc123/A-000002/submission.json' })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'PATH_INVALID')
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('submission_ref 越界（绝对路径）→ PATH_INVALID', async (t) => {
  const fx = await setup(t)
  const { envelope } = await handleConclude(fx.ctx, { ...fx.input, submission_ref: 'C:/tmp/submission.json' })
  assert.equal(envelope.code, 'PATH_INVALID')
  assert.equal(fx.team.callsFor('updateTask').length, 0)
})

test('submission_sha256 不符 → SUBMISSION_INVALID，不完成', async (t) => {
  const fx = await setup(t, { submissionSha: SHA('f') })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
})

test('锚点缺必要类型 → SUBMISSION_INVALID（缺 sha256 的地址锚点 / 无导出路径的 evidence_id 都不成立）', async (t) => {
  const fx = await setup(t, {
    anchors: [
      {
        kind: 'source_location',
        run_id: RUN,
        path: RUN_ARTIFACT,
        locator: 'function=main',
      },
    ],
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.match(envelope.diagnostics.map((item) => item.reason).join('\n'), /artifact_locator|sha256/u)
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
})

test('七类 outcome：路线允许变化符合七行表；failed 不自动证死；未开始即阻塞可 run_ids=[]', async (t) => {
  const cases = [
    { outcome: 'finding', proposed: 'validated', success: true },
    { outcome: 'finding', proposed: 'active', success: false },
    { outcome: 'no_finding', proposed: 'active', success: false },
    { outcome: 'no_finding', proposed: 'paused', success: false },
    { outcome: 'failed', proposed: 'blocked', success: false },
    { outcome: 'failed', proposed: 'paused', success: false },
    { outcome: 'budget_exhausted', proposed: 'paused', success: false },
    { outcome: 'cancelled', proposed: 'paused', success: false },
  ]

  for (const item of cases) {
    const runIds = ['budget_exhausted', 'cancelled', 'blocked'].includes(item.outcome) ? [] : [RUN]
    const fx = await setup(t, {
      outcome: item.outcome,
      proposed: item.proposed,
      runIds,
      ...(runIds.length === 0 ? { stateRecoveryRef: `${WORK}/readiness.json` } : {}),
    })
    if (runIds.length === 0) fx.project.write(`${WORK}/readiness.json`, { checked: true })
    const { envelope } = await handleConclude(fx.ctx, fx.input)
    assert.equal(envelope.status, 'ok', `${item.outcome}/${item.proposed}: ${JSON.stringify(envelope)}`)
    assert.equal(envelope.data.route_status, item.proposed)
    const receipt = JSON.parse(await fx.project.read(RECEIPT_REF))
    assert.equal(receipt.success_dependency_satisfied, item.success, `${item.outcome}/${item.proposed} 的成功依赖`)
    assert.notEqual(receipt.route_status, 'falsified', 'failed/blocked 不得自动证死')
  }
})

test('blocked 且 run_ids=[] 可以在没有 RUN 的情况下收口（须有保存的就绪/中断核查）', async (t) => {
  const fx = await setup(t, { outcome: 'blocked', proposed: 'blocked', runIds: [] })
  const missing = await handleConclude(fx.ctx, fx.input)
  assert.equal(missing.envelope.code, 'SUBMISSION_INVALID', '没有就绪核查记录必须拒绝')
  assert.match(missing.envelope.diagnostics[0].reason, /state_recovery_ref/u)
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
})

test('越界路线变化（refuted 却想 active）→ CHECK_FAILED，且不改路线', async (t) => {
  const fx = await setup(t, { outcome: 'refuted', proposed: 'active', runIds: [RUN] })
  const routeBefore = await fx.fakeProject.readRoute(ROUTE)
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.match(envelope.diagnostics[0].reason, /refuted.*falsified|proposed_route_status/u)
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
  assert.deepEqual(await fx.fakeProject.readRoute(ROUTE), routeBefore)
})

test('refuted 且路线已有 skill 反证闭包 → 落成 falsified（不自动证死：closure 缺项就拒绝）', async (t) => {
  const closure = {
    summary: '预先登记的反证闭包',
    scope: 'targets: T-001',
    criterion: '调用返回 E_NOINTERFACE 且对照通过',
    coverage: '3 次对照调用',
    control: '对照组返回 S_OK',
    limitations: '单进程',
    reopen_when: '出现新的调用路径',
    evidence: [RUN],
    observation_refs: [{ run_id: RUN, path: RUN_ARTIFACT, locator: 'line=1' }],
    control_refs: [{ run_id: RUN, path: RUN_ARTIFACT, locator: 'line=2' }],
  }
  const fx = await setup(t, { outcome: 'refuted', proposed: 'falsified', runIds: [RUN], routeClosure: closure })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(envelope.data.route_status, 'falsified')
  const route = JSON.parse(await fx.project.read(`re/routes/${ROUTE}.json`))
  assert.equal(route.status, 'falsified')
  assert.equal(route.closure.criterion, closure.criterion, '封闭必须保留 Lead 已记录的反证条件')
  assert.equal(route.history.at(-1).to, 'falsified')

  // 缺 coverage/control 等必须拒绝落成 falsified
  const broken = await setup(t, {
    outcome: 'refuted',
    proposed: 'falsified',
    runIds: [RUN],
    routeClosure: { ...closure, coverage: '', control: '' },
  })
  const refused = await handleConclude(broken.ctx, broken.input)
  assert.equal(refused.envelope.code, 'CHECK_FAILED')
  assert.match(refused.envelope.diagnostics[0].reason, /coverage|control/u)
})

test('cancelled → superseded：缺替代路线时拒绝，记录替代后可落成', async (t) => {
  const missing = await setup(t, {
    outcome: 'cancelled',
    proposed: 'superseded',
    runIds: [],
    stateRecoveryRef: `${WORK}/interrupt-check.json`,
  })
  const refused = await handleConclude(missing.ctx, missing.input)
  assert.equal(refused.envelope.code, 'CHECK_FAILED')
  assert.match(refused.envelope.diagnostics[0].reason, /replacement/u)

  const ok = await setup(t, {
    outcome: 'cancelled',
    proposed: 'superseded',
    runIds: [],
    stateRecoveryRef: `${WORK}/interrupt-check.json`,
    extraRoutes: { 'R-002': routeFixture({ id: 'R-002', status: 'active' }) },
    routeClosure: { summary: '问题被 R-002 替代', replacement: 'R-002' },
  })
  const { envelope } = await handleConclude(ok.ctx, ok.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(envelope.data.route_status, 'superseded')
  const route = JSON.parse(await ok.project.read(`re/routes/${ROUTE}.json`))
  assert.equal(route.closure.replacement, 'R-002')
})

test('原生提前 complete（无回执）→ UNREVIEWED_COMPLETION：全部检查照跑、不再调 complete', async (t) => {
  const fx = await setup(t, { taskStatus: 'completed' })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.ok(envelope.diagnostics.some((item) => item.code === 'UNREVIEWED_COMPLETION'))
  assert.equal(fx.team.callsFor('updateTask').length, 0, '不得重复 complete')
  assert.equal(fx.fakeProject.callsFor('check').length, 1, '全部检查照跑')
  const receipt = JSON.parse(await fx.project.read(RECEIPT_REF))
  assert.equal(receipt.unreviewed_completion, true)
})

test('原生提前 complete 但补验失败 → 失败码，不放行且不改任务', async (t) => {
  const fx = await setup(t, {
    taskStatus: 'completed',
    projectResponses: { check: { exitCode: 1, stdout: '', stderr: 'ERROR: INDEX navigation stale', code: 'CHECK_FAILED' } },
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.equal(fx.team.callsFor('updateTask').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'completed')
})

test('回执写失败 → partial（不伪称成功，也不完成任务）', async (t) => {
  const fx = await setup(t)
  // 用同名文件挡住回执目录，制造「必需回执写不成」
  fx.project.write(`${RECEIPT_DIR}`, 'not a directory')
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'partial')
  assert.ok(['RECOVERY_REQUIRED', 'CHECK_FAILED'].includes(envelope.code))
  assert.equal(fx.team.callsFor('updateTask').length, 0, '回执未落盘前不得 complete')
})

test('审计写失败 → ok + audit_written=false 且有诊断', async (t) => {
  const fx = await setup(t)
  fx.project.write('re/team/audit.jsonl/x', 'blocking directory entry')
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(envelope.data.audit_written, false)
  assert.ok(envelope.diagnostics.some((item) => item.code === 'AUDIT_WRITE_FAILED'))
  const receipt = JSON.parse(await fx.project.read(RECEIPT_REF))
  assert.equal(receipt.audit_written, false)
})

test('契约摘要在提交与派发之间不一致 → SUBMISSION_INVALID', async (t) => {
  const fx = await setup(t, { submissionOverrides: { contract_sha256: SHA('d') } })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.match(envelope.diagnostics[0].reason, /contract_sha256|契约/u)
})

test('提交 outcome 与 review outcome 不一致 → SUBMISSION_INVALID', async (t) => {
  const fx = await setup(t, { outcome: 'finding' })
  const { envelope } = await handleConclude(fx.ctx, {
    ...fx.input,
    review: { ...fx.input.review, outcome: 'no_finding', proposed_route_status: 'active' },
  })
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.match(envelope.diagnostics[0].reason, /outcome/u)
})

test('artifact 未在该 RUN 的 artifacts 登记 → SUBMISSION_INVALID（正式证据不能只躺在编排目录）', async (t) => {
  const fx = await setup(t)
  fx.project.write(`${WORK}/out/extra.bin`, 'unregistered')
  const extraSha = atomic.sha256Bytes(Buffer.from('unregistered', 'utf8'))
  const submissionSha = fx.writeSubmission({
    artifacts: [
      { path: `${WORK}/out/extra.bin`, sha256: extraSha },
    ],
  })
  const { envelope } = await handleConclude(fx.ctx, { ...fx.input, submission_sha256: submissionSha })
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.match(envelope.diagnostics[0].reason, /artifacts 登记/u)
})

test('规则版本：派发冻结的规则摘要与当前副本不一致 → SKILL_INCOMPATIBLE', async (t) => {
  const frozen = 'a'.repeat(64)
  const same = await setup(t, {
    ruleDigest: frozen,
    projectResponses: { probe: { exitCode: 0, stdout: `${JSON.stringify({ ruleDigest: frozen })}\n`, stderr: '' } },
  })
  const okResult = await handleConclude(same.ctx, same.input)
  assert.equal(okResult.envelope.status, 'ok', JSON.stringify(okResult.envelope))

  const changed = await setup(t, {
    ruleDigest: 'b'.repeat(64),
    projectResponses: { probe: { exitCode: 0, stdout: `${JSON.stringify({ ruleDigest: frozen })}\n`, stderr: '' } },
  })
  const callsBefore = changed.fakeProject.calls.length
  const refused = await handleConclude(changed.ctx, changed.input)
  assert.equal(refused.envelope.code, 'SKILL_INCOMPATIBLE')
  assert.match(refused.envelope.diagnostics[0].reason, /规则副本/u)
  assert.equal(changed.fakeProject.callsFor('seal').length, 0)
  assert.deepEqual(changed.fakeProject.order(), ['readRoute', 'probe'], '只做路线与规则版本复核')
})

test('路线记录 id 与派发绑定的路线不一致 → RECOVERY_REQUIRED', async (t) => {
  const fx = await setup(t, { routeOverride: routeFixture({ id: 'R-999' }) })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /R-999/u)
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
})

// ---------------------------------------------------------------------------
// T14：三处 fail-open 缺陷
// ---------------------------------------------------------------------------

test('派发记录没有冻结规则摘要 → RECOVERY_REQUIRED（规则漂移守卫不得静默跳过）', async (t) => {
  const fx = await setup(t, { ruleDigest: null })
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /规则摘要/u)
  assert.equal(fx.fakeProject.callsFor('probe').length, 0, '缺摘要时不能用一次探测假装核对过')
  assert.equal(fx.team.callsFor('updateTask').length, 0, '拒绝收口不得完成任务')
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('派发记录带规则摘要且与当前副本一致 → 照常收口，并真的复核一次', async (t) => {
  const fx = await setup(t)
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(fx.fakeProject.callsFor('probe').length, 1, '有摘要时必须真的探测一次当前副本')
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'completed')
})

test('派发记录指向岗位却没有任何锚点要求 → RECOVERY_REQUIRED（finding 不能零锚点放行）', async (t) => {
  const fx = await setup(t, {
    anchorsRequired: null,
    dispatchPost: { id: 'rt-scout', anchors_required: undefined },
    evidenceRequired: [],
    anchors: [],
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /锚点/u)
  assert.equal(fx.team.callsFor('updateTask').length, 0, '零锚点不得完成任务')
})

test('契约形状的 post.anchors_required 承重：缺该类锚点照常拒绝，带齐照常放行', async (t) => {
  // 顶层没有 anchors_required，只能回退到 post 里的那一份。
  const missing = await setup(t, {
    anchorsRequired: null,
    dispatchPost: { id: 'rt-scout', anchors_required: ['web_capture'] },
  })
  const refused = await handleConclude(missing.ctx, missing.input)
  assert.equal(refused.envelope.code, 'SUBMISSION_INVALID', JSON.stringify(refused.envelope))
  assert.match(refused.envelope.diagnostics[0].reason, /web_capture/u)

  const satisfied = await setup(t, {
    anchorsRequired: null,
    dispatchPost: { id: 'rt-scout', anchors_required: ['source_location'] },
  })
  const accepted = await handleConclude(satisfied.ctx, satisfied.input)
  assert.equal(accepted.envelope.status, 'ok', JSON.stringify(accepted.envelope))
})

test('派发记录缺 evidence_required → RECOVERY_REQUIRED（允许为空，但必须显式存在）', async (t) => {
  const fx = await setup(t, { evidenceRequired: null })
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /evidence_required/u)
  assert.equal(fx.team.callsFor('updateTask').length, 0)
})

test('宿主 getTask 返回 ok 但 task=null → 可读的 blocked，不是未捕获异常', async (t) => {
  const fx = await setup(t)
  fx.ctx.deps.teamAdapter = {
    ...fx.ctx.deps.teamAdapter,
    async getTask() {
      return { ok: true, task: null }
    },
  }
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /任务.*记录为空|记录为空.*任务/u)
  assert.equal(envelope.data.phase, 'preflight')
  assert.equal(fx.team.callsFor('updateTask').length, 0)
})

test('路线记录被写成 null → 可读的 blocked，不是未捕获异常', async (t) => {
  const fx = await setup(t, { routeOverride: null })
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /路线.*记录为空|记录为空.*路线/u)
  assert.equal(envelope.data.phase, 'preflight')
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
})

test('更新事实后的 impact 仍有待复查/争议且路线保持 active/validated → CHECK_FAILED，任务不完成', async (t) => {
  const fx = await setup(t)
  fx.fakeProject.queue('impact', { exitCode: 0, stdout: '{"pending_reviews":[],"dispute_impacts":[]}\n', stderr: '' })
  fx.fakeProject.queue('impact', {
    exitCode: 0,
    stdout: `${JSON.stringify({ pending_reviews: [{ route_id: ROUTE, revision: 2, route_status: 'active' }], dispute_impacts: [] })}\n`,
    stderr: '',
  })
  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.code, 'CHECK_FAILED')
  assert.match(envelope.diagnostics[0].reason, /待复查|争议/u)
  assert.equal(fx.fakeProject.callsFor('index').length, 0)
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

test('F1 分界线之后：未捕获异常也不报 blocked（归档已发生 → partial）', async (t) => {
  const fx = await setup(t)
  const original = fx.ctx.deps.baseline
  fx.ctx.deps.baseline = {
    ...original,
    loadBaseline() {
      throw new Error('boom after archive')
    },
  }
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.match(envelope.diagnostics[0].reason, /boom after archive/u)
  // 归档先于这次抛错，所以正式映射已经在盘上。
  const mapping = JSON.parse(await fx.project.read(`${RECEIPT_DIR}/mapping.json`))
  assert.equal(mapping.operation_id, 'op-conclude-1')
})

// ---------------------------------------------------------------------------
// F1：`blocked` 只给「前置拒绝」，第一个持久副作用之后一律 `partial`
//
// 编排契约：前置拒绝 status=blocked 且无新成员/任务/正式路线变更；
// 已持久化或触及宿主后失败 status=partial。
// 分界线就是步骤 4 的 `archiveAttempt()`（它把核对过的产物复制进正式 re/runs/**，
// 并在回执目录写下 submission.json/mapping.json）。
// 台账记录（re/team/operations/**）是插件自己的幂等簿记，不算「正式事实」。
// ---------------------------------------------------------------------------

test('F1 分界线之前：归档前拒绝 → blocked（尚未写任何正式证据）', async (t) => {
  const fx = await setup(t)
  // 提交哈希对不上：在步骤 4 归档之前就被拒。
  const { envelope } = await handleConclude(fx.ctx, { ...fx.input, submission_sha256: SHA('9') })

  assert.equal(envelope.status, 'blocked', JSON.stringify(envelope))
  assert.equal(envelope.code, 'SUBMISSION_INVALID')
  assert.equal(envelope.data.phase, 'integrating')
  assert.equal(fx.fakeProject.callsFor('seal').length, 0)
  const archived = await fsp
    .stat(path.join(fx.project.root, 're', 'team', 'receipts', `${DISPATCH}-${ATTEMPT}`, 'mapping.json'))
    .then(() => true)
    .catch(() => false)
  assert.equal(archived, false, '归档前失败不得留下归档映射')
})

// ---------------------------------------------------------------------------
// 路线回写的判据：`changed` = 「受管字段与磁盘上的路线不同」，不是「状态变了」。
//
// L3 实测暴露的缺陷（见 docs/verify/records/20261029-session-040cb6df.md 第 6 步第二轮）：
// finding 落在已经是 active 的路线上时状态不变，但 `evidence` 仍要补进本 RUN。
// 早期实现按 `from === nextStatus` 判 `changed=false`，调用方于是不写文件 ——
// 内存里合并好的 evidence 永远不落盘，路线停在 `evidence: []`，而 RUN 已经 seal 并回了回执。
// 反过来，把 `changed` 一律改成 true 会让每次收口都给路线打戳，所以第三条用例守着「无变化不写」。
// ---------------------------------------------------------------------------

/** `reviewFixture()` 的默认 reason：用来造一条「除 evidence 外没有任何字段会变」的路线。 */
const REVIEW_REASON = '观测到 S_OK，并有对照实验'

test('finding 落在已是 active 的路线上 → 已落盘路线补上该 RUN，history 不增长', async (t) => {
  // 除了 `evidence` 之外，路线的受管字段都与本次 review 一致：
  // 于是这条用例唯一能变的就是「把 RUN 追加进 evidence」。
  const route = { ...routeFixture({ status: 'active', evidence: [] }), state_reason: REVIEW_REASON }
  const fx = await setup(t, {
    routeOverride: route,
    proposed: 'active',
    reviewOverrides: { reason: REVIEW_REASON },
  })
  // L3 现场就是「磁盘上已有一条 active + evidence: [] 的路线」。
  fx.project.write(`re/routes/${ROUTE}.json`, route)

  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))
  assert.equal(envelope.data.route_status, 'active')

  const persisted = JSON.parse(await fx.project.read(`re/routes/${ROUTE}.json`))
  assert.equal(persisted.status, 'active')
  assert.deepEqual(persisted.evidence, [RUN], '状态没变也必须把本 RUN 落进路线证据')
  assert.equal(persisted.history.length, route.history.length, '状态没变不得追加 history')
})

test('真实状态迁移 → 证据与 history 都落盘', async (t) => {
  const route = routeFixture({ status: 'active', evidence: [] })
  const fx = await setup(t, { routeOverride: route })
  fx.project.write(`re/routes/${ROUTE}.json`, route)

  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))

  const persisted = JSON.parse(await fx.project.read(`re/routes/${ROUTE}.json`))
  assert.equal(persisted.status, 'validated')
  assert.deepEqual(persisted.evidence, [RUN])
  assert.equal(persisted.history.length, route.history.length + 1, '状态真的变了才追加 history')
  assert.deepEqual(
    {
      from: persisted.history.at(-1).from,
      to: persisted.history.at(-1).to,
      evidence: persisted.history.at(-1).evidence,
    },
    { from: 'active', to: 'validated', evidence: [RUN] },
  )
})

test('无变化的收口不重写路线文件（不无条件打戳）', async (t) => {
  const route = { ...routeFixture({ status: 'active', evidence: [RUN] }), state_reason: REVIEW_REASON }
  const fx = await setup(t, {
    routeOverride: route,
    proposed: 'active',
    reviewOverrides: { reason: REVIEW_REASON },
  })
  // `writeJsonAtomic()` 落盘时会在末尾补一个换行；这里故意写成**没有**结尾换行，
  // 于是「字节没变且仍然没有结尾换行」就是「这一次没有重写路线」的判据。
  fx.project.write(`re/routes/${ROUTE}.json`, route)
  const before = await fx.project.read(`re/routes/${ROUTE}.json`)

  const { envelope } = await handleConclude(fx.ctx, fx.input)
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope))

  const after = await fx.project.read(`re/routes/${ROUTE}.json`)
  assert.equal(after, before, '没有任何受管字段变化时不得重写路线文件')
  assert.equal(JSON.parse(after).history.length, route.history.length)
})

test('F1 分界线之后：归档完成、seal 之前失败 → partial（正式 re/runs/** 字节已落）', async (t) => {
  const fx = await setup(t)
  // 归档是步骤 4；删掉派发时冻结的基准快照，让紧随其后的 loadBaseline 失败。
  fx.project.remove(fx.baselineRef)
  const { envelope } = await handleConclude(fx.ctx, fx.input)

  assert.equal(envelope.code, 'RECOVERY_REQUIRED', JSON.stringify(envelope))
  assert.equal(envelope.status, 'partial', JSON.stringify(envelope))
  assert.equal(envelope.data.phase, 'integrating')
  // 归档确实已经发生——这正是不能报 blocked 的理由。
  const mapping = JSON.parse(await fx.project.read(`${RECEIPT_DIR}/mapping.json`))
  assert.equal(mapping.dispatch_id, DISPATCH)
  assert.equal(mapping.attempt_id, ATTEMPT)
  assert.equal(fx.fakeProject.callsFor('seal').length, 0, '失败发生在 seal 之前')
  assert.equal(fx.team.snapshot().tasks.find((task) => task.id === TASK).status, 'in_progress')
})

