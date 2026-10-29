/**
 * T6 `src/contract.mjs`：派发契约的构建、持久化、摘要与交付信封。
 *
 * 这些测试只断言**对外的行为**：生成的标识形状、任务板摘要的长度与内容、
 * 交付信封的字节计量（含宿主前缀信封）、路径越界拒绝、`baseline_ref` 的真实哈希。
 * 不断言内部函数名或调用顺序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as atomic from '../dist/atomic.js'
import * as compatibility from '../dist/compatibility.js'
import * as contract from '../dist/contract.js'
import * as paths from '../dist/paths.js'
import { ContractError } from '../dist/errors.js'
import { makeTempProject } from './helpers/host.mjs'
import { createFakeProject } from './helpers/fake-project.mjs'

const RULES_ENTRY = 'docs/agents/reverse-project-management.md'
const SKILL_COPY = '.agents/skills/reverse-project-management/SKILL.md'

const POST = Object.freeze({
  id: 'cross-check',
  display_name: '证据交叉核查',
  focus: '检查已有证据的目标、来源、独立性和替代解释',
  priority: 10,
  enabled: true,
  required: ['fs', 'search'],
  optional: ['shell'],
  anchors_required: ['artifact_locator'],
  prohibited: ['把推断当事实'],
})

function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function deliveryArgs(over = {}) {
  return {
    callerName: 'lead',
    member: 'rt-cross-check',
    dispatchId: 'D-op-dispatch-1-0123abcd',
    attemptId: 'A-000001',
    taskId: 'task-1',
    taskRevision: 2,
    routeId: 'R-001',
    postId: 'cross-check',
    contractRef: 're/team/dispatches/D-op-dispatch-1-0123abcd.json',
    contractSha256: 'a'.repeat(64),
    workDir: 're/team/work/D-op-dispatch-1-0123abcd/A-000001',
    runIdReservation: 'RUN-D-op-dispatch-1-0123abcd-A-000001',
    objective: '确认样本导入表与可疑字符串，交回可核验定位',
    rulesEntry: RULES_ENTRY,
    skillCopyPath: SKILL_COPY,
    ...over,
  }
}

test('dispatch/attempt 标识由 operation_id 稳定派生，且符合 schema 形状', () => {
  const dispatchId = contract.dispatchIdFor('op-dispatch-1')
  assert.match(dispatchId, /^D-[a-z0-9][a-z0-9_-]{0,63}$/u)
  assert.equal(contract.dispatchIdFor('op-dispatch-1'), dispatchId, '同一 operation 必须稳定出同一 dispatch')
  assert.notEqual(contract.dispatchIdFor('op-dispatch-2'), dispatchId)
  assert.ok(dispatchId.length <= 64)
  // 长 operation_id 也不能把 dispatch_id 撑出 64 字符
  const long = contract.dispatchIdFor(`op-${'x'.repeat(90)}`)
  assert.ok(long.length <= 64)
  assert.match(long, /^D-[a-z0-9][a-z0-9_-]{0,63}$/u)

  assert.equal(contract.attemptIdOf(1), 'A-000001')
  assert.equal(contract.attemptIdOf(12), 'A-000012')
  assert.throws(() => contract.attemptIdOf(0))

  assert.equal(contract.workDirFor(dispatchId, 'A-000001'), `re/team/work/${dispatchId}/A-000001`)
  assert.match(contract.runIdReservationFor(dispatchId, 'A-000001'), /^RUN-[A-Za-z0-9_-]+$/u)
  assert.equal(contract.contractRefFor(dispatchId, 'A-000001', 1), `re/team/dispatches/${dispatchId}.json`)
  assert.equal(
    contract.contractRefFor(dispatchId, 'A-000002', 2),
    `re/team/dispatches/${dispatchId}.A-000002.json`,
  )
  assert.equal(contract.submissionRefFor(dispatchId, 'A-000001'), `re/team/work/${dispatchId}/A-000001/submission.json`)
})

test('prohibited / evidence_required 只追加：传空数组不会删掉岗位默认要求', () => {
  const merged = contract.mergeRequirements(POST, {
    evidence_required: [],
    prohibited: [],
    capability_needs: [],
  })

  assert.deepEqual(merged.prohibited, [...POST.prohibited], '岗位默认禁止事项必须保留')
  assert.deepEqual(merged.evidence_required, [...POST.anchors_required], '岗位默认锚点必须保留')
  assert.deepEqual(merged.capability_needs, [...POST.required], '岗位必需能力必须保留')
  assert.deepEqual(merged.optional, [...POST.optional])

  const additive = contract.mergeRequirements(POST, {
    evidence_required: ['binary_location'],
    prohibited: ['不要执行样本'],
    capability_needs: ['web'],
  })
  assert.deepEqual(additive.prohibited, [...POST.prohibited, '不要执行样本'])
  assert.deepEqual(additive.evidence_required, [...POST.anchors_required, 'binary_location'])
  assert.deepEqual(additive.capability_needs, [...POST.required, 'web'])

  const deduped = contract.mergeRequirements(POST, {
    evidence_required: ['artifact_locator'],
    prohibited: ['把推断当事实'],
    capability_needs: ['fs'],
  })
  assert.deepEqual(deduped.evidence_required, ['artifact_locator'])
  assert.deepEqual(deduped.prohibited, ['把推断当事实'])
  assert.deepEqual(deduped.capability_needs, ['fs', 'search'])
})

test('任务板摘要只放摘要：subject ≤200、description ≤16384，且不搬运契约正文', () => {
  const objective = `超长目标：${'证'.repeat(70000)}`
  const summary = contract.buildTaskSummary({
    postId: 'cross-check',
    routeId: 'R-001',
    targetIds: ['T-001', 'T-002'],
    dispatchId: 'D-x',
    attemptId: 'A-000001',
    operationId: 'op-dispatch-1',
    contractRef: contract.contractRefFor('D-x', 'A-000001', 1),
    contractSha256: 'b'.repeat(64),
    workDir: contract.workDirFor('D-x', 'A-000001'),
    objective,
  })

  assert.ok(summary.subject.length <= 200, 'subject 必须 ≤200（宿主 trim 后按 UTF-16 计）')
  assert.ok(summary.description.length <= 16384, 'description 必须 ≤16384')
  assert.match(summary.subject, /cross-check/u)
  assert.match(summary.description, /op-dispatch-1/u)
  assert.match(summary.description, /D-x/u)
  assert.match(summary.description, /A-000001/u)
  assert.match(summary.description, new RegExp('b{64}', 'u'), '摘要必须带契约摘要哈希')
  assert.ok(
    summary.description.length < 6000,
    `摘要不得搬运契约正文（实际 ${summary.description.length}）`,
  )
})

test('交付信封按字节计量：含 `Team message from <name>:` 前缀，超长契约不被搬运', () => {
  const objective = `超长目标：${'证'.repeat(70000)}`
  const built = contract.buildDeliveryEnvelope(deliveryArgs({ objective }))

  assert.equal(built.ok, true)
  assert.ok(built.bytes < contract.MAX_MESSAGE_BYTES, `信封字节必须 <${contract.MAX_MESSAGE_BYTES}`)
  assert.ok(built.bytes <= contract.MAX_MESSAGE_BYTES - contract.MESSAGE_HEADROOM_BYTES, '必须留余量')

  // 宿主计量方式：前缀块 + 内容块
  const measured = Buffer.byteLength(
    JSON.stringify([{ type: 'text', text: 'Team message from lead:' }, ...built.blocks]),
    'utf8',
  )
  assert.equal(built.bytes, measured, '返回的字节数必须等于宿主实际计量的字节数')
  assert.equal(contract.measureMessageBytes({ callerName: 'lead', blocks: built.blocks }), measured)

  const text = built.blocks.map((block) => block.text).join('\n')
  assert.match(text, /re\/team\/dispatches\/D-op-dispatch-1-0123abcd\.json/u, '必须带契约路径')
  assert.match(text, new RegExp('a{64}', 'u'), '必须带契约 SHA256')
  assert.match(text, /R-001/u)
  assert.match(text, /A-000001/u)
  assert.match(text, /docs\/agents\/reverse-project-management\.md/u, '必须带项目规则入口')
  assert.ok(!text.includes('证'.repeat(2000)), '消息里不得出现契约正文')
  assert.ok(text.length < 5000)
})

test('同一 attempt 重算得到同一份信封（成员可按 dispatch/attempt 去重）', () => {
  const first = contract.buildDeliveryEnvelope(deliveryArgs())
  const second = contract.buildDeliveryEnvelope(deliveryArgs())
  assert.deepEqual(second.blocks, first.blocks)
  assert.equal(second.envelope_id, first.envelope_id)
  assert.equal(first.dedupe_key, 'D-op-dispatch-1-0123abcd:A-000001')

  const otherAttempt = contract.buildDeliveryEnvelope(deliveryArgs({ attemptId: 'A-000002' }))
  assert.notEqual(otherAttempt.envelope_id, first.envelope_id)
})

test('assertAttemptPath：本 attempt 目录内的路径通过，绝对/.. /反斜杠/ADS/别处一律 PATH_INVALID', async (t) => {
  const project = makeTempProject({ t })
  const dispatchId = 'D-op-dispatch-1-0123abcd'
  const attempt = { root: project.root, dispatchId, attemptId: 'A-000001' }

  const inside = await contract.assertAttemptPath({ ...attempt, candidate: `${contract.workDirFor(dispatchId, 'A-000001')}/submission.json` })
  assert.equal(inside, `${contract.workDirFor(dispatchId, 'A-000001')}/submission.json`)

  const dir = await contract.assertAttemptDir({ ...attempt, candidate: contract.workDirFor(dispatchId, 'A-000001') })
  assert.equal(dir, contract.workDirFor(dispatchId, 'A-000001'))

  const rejected = [
    're/team/work/D-op-dispatch-1-0123abcd/A-000001/submission.json/../../../evil.json',
    'C:/Windows/system32/evil.json',
    '/etc/passwd',
    're\\team\\work\\evil.json',
    're/team/work/D-op-dispatch-1-0123abcd/A-000001/submission.json:stream',
    're/team/work/D-op-dispatch-1-0123abcd/A-000002/submission.json',
    '',
  ]
  for (const candidate of rejected) {
    await assert.rejects(
      () => contract.assertAttemptPath({ ...attempt, candidate }),
      (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
      `应拒绝 ${JSON.stringify(candidate)}`,
    )
  }

  // 本 attempt 目录本身不是「目录内路径」
  await assert.rejects(
    () => contract.assertAttemptPath({ ...attempt, candidate: contract.workDirFor(dispatchId, 'A-000001') }),
    (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
  )
  // 别的 attempt 目录也不算
  await assert.rejects(
    () => contract.assertAttemptDir({ ...attempt, candidate: contract.workDirFor(dispatchId, 'A-000002') }),
    (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
  )
})

test('assertAttemptPath：junction 逃逸同样 PATH_INVALID', async (t) => {
  const project = makeTempProject({ t })
  const dispatchId = 'D-op-dispatch-1-0123abcd'
  const attemptDir = join(project.root, ...contract.workDirFor(dispatchId, 'A-000001').split('/'))
  await mkdir(attemptDir, { recursive: true })

  const outside = join(project.root, '..', `outside-${process.pid}-${Date.now()}`)
  await mkdir(outside, { recursive: true })
  try {
    try {
      await symlink(outside, join(attemptDir, 'escape'), 'junction')
    } catch (error) {
      t.diagnostic(`本机建不了 junction，跳过逃逸用例：${error?.code ?? error?.message}`)
      return
    }
    await assert.rejects(
      () => contract.assertAttemptPath({
        root: project.root,
        dispatchId,
        attemptId: 'A-000001',
        candidate: `${contract.workDirFor(dispatchId, 'A-000001')}/escape/evil.json`,
      }),
      (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
    )
  } finally {
    await symlinkOutRemove(attemptDir, outside)
  }
})

async function symlinkOutRemove(attemptDir, outside) {
  const { rm } = await import('node:fs/promises')
  await rm(join(attemptDir, 'escape'), { force: true, recursive: false }).catch(() => {})
  await rm(outside, { recursive: true, force: true }).catch(() => {})
}

test('captureBaseline：冻结真实目标字节哈希，无 seal 时 preexisting_seals 为空数组', async (t) => {
  const bytes = 'SAMPLE-BYTES-0123456789'
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': bytes,
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', name: 'sample', path: 're/samples/sample.bin' }],
      }),
    },
  })
  const adapter = createFakeProject({ projectRoot: project.root, seals: [] })

  const captured = await contract.captureBaseline({
    root: project.root,
    targetIds: ['T-001'],
    projectAdapter: adapter,
    atomic,
    paths,
    now: '2026-10-29T08:00:00.000Z',
  })

  assert.equal(captured.ok, true)
  assert.deepEqual(captured.baseline_ref.preexisting_seals, [])
  assert.equal(captured.baseline_ref.targets.length, 1)
  assert.equal(captured.baseline_ref.targets[0].id, 'T-001')
  assert.equal(captured.baseline_ref.targets[0].sha256, sha256Of(bytes))
  assert.equal(captured.baseline_ref.frozen_at, '2026-10-29T08:00:00.000Z')
})

test('captureBaseline：登记哈希与实际字节不符 → BASELINE_MISMATCH', async (t) => {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': 'REAL-BYTES',
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', path: 're/samples/sample.bin', sha256: 'c'.repeat(64) }],
      }),
    },
  })
  const adapter = createFakeProject({ projectRoot: project.root, seals: [] })
  const captured = await contract.captureBaseline({
    root: project.root,
    targetIds: ['T-001'],
    projectAdapter: adapter,
    atomic,
    paths,
  })
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'BASELINE_MISMATCH')
})

test('captureBaseline：目标既无哈希也无可读路径 → BASELINE_MISMATCH（不能拿空清单代替目标身份）', async (t) => {
  const project = makeTempProject({
    t,
    files: {
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-009', name: 'no-bytes' }],
      }),
    },
  })
  const adapter = createFakeProject({ projectRoot: project.root, seals: [] })
  const captured = await contract.captureBaseline({
    root: project.root,
    targetIds: ['T-009'],
    projectAdapter: adapter,
    atomic,
    paths,
  })
  assert.equal(captured.ok, false)
  assert.equal(captured.code, 'BASELINE_MISMATCH')
  assert.ok(!('baseline_ref' in captured) || captured.baseline_ref === undefined)

  const missingTarget = await contract.captureBaseline({
    root: project.root,
    targetIds: ['T-404'],
    projectAdapter: adapter,
    atomic,
    paths,
  })
  assert.equal(missingTarget.ok, false)
  assert.equal(missingTarget.code, 'BASELINE_MISMATCH')
})

test('captureBaseline：只纳入与本次目标相关的既有 seal', async (t) => {
  const project = makeTempProject({
    t,
    files: {
      're/samples/sample.bin': 'X',
      're/targets.json': JSON.stringify({
        schema_version: 1,
        targets: [{ id: 'T-001', path: 're/samples/sample.bin' }],
      }),
    },
  })
  const adapter = createFakeProject({
    projectRoot: project.root,
    seals: [
      { path: 're/seals/targets/T-001.json', sha256: '1'.repeat(64), bytes: 120 },
      { path: 're/seals/targets/T-777.json', sha256: '2'.repeat(64), bytes: 90 },
      { path: 're/seals/runs/RUN-9.json', sha256: '3'.repeat(64), bytes: 200 },
    ],
  })
  const captured = await contract.captureBaseline({
    root: project.root,
    targetIds: ['T-001'],
    projectAdapter: adapter,
    atomic,
    paths,
  })
  assert.equal(captured.ok, true)
  const sealPaths = captured.baseline_ref.preexisting_seals.map((seal) => seal.path)
  assert.deepEqual(sealPaths, ['re/seals/targets/T-001.json'])
  assert.equal(captured.baseline_ref.preexisting_seals[0].sha256, '1'.repeat(64))
  assert.equal(captured.baseline_ref.preexisting_seals[0].bytes, 120)
})

test('persistContract：独占创建、同内容幂等、异内容 OPERATION_CONFLICT，哈希等于文件字节', async (t) => {
  const project = makeTempProject({ t })
  const dispatchId = 'D-op-dispatch-1-0123abcd'
  const ref = contract.contractRefFor(dispatchId, 'A-000001', 1)
  const built = contract.serializeContract({ dispatch_id: dispatchId, attempt_id: 'A-000001', objective: '目标' })
  assert.equal(built.sha256, sha256Of(built.text))

  const first = await contract.persistContract({ root: project.root, ref, text: built.text, atomic, paths })
  assert.equal(first.created, true)
  assert.equal(first.sha256, sha256Of(built.text))
  assert.equal(await atomic.sha256File(join(project.root, ...ref.split('/'))), first.sha256)

  const again = await contract.persistContract({ root: project.root, ref, text: built.text, atomic, paths })
  assert.equal(again.created, false, '同内容必须幂等')

  const other = contract.serializeContract({ dispatch_id: dispatchId, attempt_id: 'A-000001', objective: '改了' })
  await assert.rejects(
    () => contract.persistContract({ root: project.root, ref, text: other.text, atomic, paths }),
    (error) => error instanceof ContractError && error.code === 'OPERATION_CONFLICT',
  )

  // 不可变性：文件字节未被覆盖
  const onDisk = await readFile(join(project.root, ...ref.split('/')), 'utf8')
  assert.equal(onDisk, built.text)
})

test('classifyRoute：只有 planned/active 是可派发路线，其余点名下一步', () => {
  assert.deepEqual(
    Object.keys(contract.classifyRoute({ schema_version: 1, id: 'R-001', status: 'active', target_ids: ['T-001'] }))
      .includes('dispatchable'),
    true,
  )
  assert.equal(contract.classifyRoute({ id: 'R-001', status: 'planned', target_ids: ['T-001'] }).dispatchable, true)
  assert.equal(contract.classifyRoute({ id: 'R-001', status: 'active', target_ids: ['T-001'] }).dispatchable, true)

  const falsified = contract.classifyRoute({ id: 'R-001', status: 'falsified', target_ids: ['T-001'] })
  assert.equal(falsified.dispatchable, false)
  assert.equal(falsified.code, 'PROJECT_NOT_CONFIGURED')
  assert.ok(falsified.next_step.length > 0)

  assert.equal(contract.classifyRoute({ id: 'R-001', status: 'validated', target_ids: ['T-001'] }).dispatchable, false)
  assert.equal(contract.classifyRoute({ id: 'R-001', status: 'superseded', target_ids: ['T-001'] }).dispatchable, false)

  const paused = contract.classifyRoute({ id: 'R-001', status: 'paused', target_ids: ['T-001'] })
  assert.equal(paused.dispatchable, false)
  assert.equal(paused.code, 'RECOVERY_REQUIRED')

  const bad = contract.classifyRoute({ id: 'R-001', status: 'weird', target_ids: ['T-001'] })
  assert.equal(bad.dispatchable, false)
  assert.equal(bad.code, 'PROJECT_NOT_CONFIGURED')

  const noTargets = contract.classifyRoute({ id: 'R-001', status: 'active' })
  assert.equal(noTargets.dispatchable, false)
  assert.match(noTargets.reason, /目标/u)
})

test('routeTargetIds 兼容 target_ids / targets 两种登记形状', () => {
  assert.deepEqual(contract.routeTargetIds({ target_ids: ['T-001', 'T-002'] }), ['T-001', 'T-002'])
  assert.deepEqual(contract.routeTargetIds({ targets: ['T-003'] }), ['T-003'])
  assert.deepEqual(contract.routeTargetIds({ targets: [{ id: 'T-004' }] }), ['T-004'])
  assert.deepEqual(contract.routeTargetIds({}), [])
  assert.deepEqual(contract.routeTargetIds(null), [])
})

test('buildContract 冻结派发时的内容摘要：rule_digest 是 64-hex（收口侧规则漂移守卫的输入）', async (t) => {
  const project = makeTempProject({ t })
  const digests = await compatibility.computeDigests({ projectRoot: project.root })
  assert.match(digests.ruleDigest, /^[0-9a-f]{64}$/u, '项目副本应给出可冻结的规则摘要')

  const built = contract.buildContract({
    dispatchId: 'D-op-dispatch-1-0123abcd',
    attemptId: 'A-000001',
    attemptIndex: 1,
    operationId: 'op-dispatch-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    projectRoot: project.root,
    post: POST,
    route: { schema_version: 1, id: 'R-001', status: 'active', target_ids: ['T-001'] },
    targets: [{ id: 'T-001', path: 're/samples/sample.bin', sha256: 'c'.repeat(64) }],
    baselineRef: {
      ref: 're/team/baselines/D-op-dispatch-1-0123abcd.json',
      targets: [{ id: 'T-001', path: 're/samples/sample.bin', sha256: 'c'.repeat(64) }],
      preexisting_seals: [],
    },
    workDir: 're/team/work/D-op-dispatch-1-0123abcd/A-000001',
    runIdReservation: 'RUN-D-op-dispatch-1-0123abcd-A-000001',
    contractRef: 're/team/dispatches/D-op-dispatch-1-0123abcd.json',
    digests,
  })

  assert.match(built.contract.rule_digest, /^[0-9a-f]{64}$/u, '契约必须冻结 64-hex 规则摘要')
  assert.equal(built.contract.rule_digest, digests.ruleDigest, '冻结的必须是 computeDigests 的规则摘要')
  assert.equal(built.contract.script_digest, digests.scriptDigest)
  assert.equal(built.contract.catalog_digest, digests.catalogDigest)
})

test('契约里必带三条行为规矩与「你没有派发权」的授权声明', () => {
  assert.equal(contract.WORK_RULES.length, 3)
  const joined = contract.WORK_RULES.join('\n')
  assert.match(joined, /落盘/u)
  assert.match(joined, /具体问题/u)
  assert.match(joined, /缺工具|报缺/u)

  const rules = contract.buildWorkRules({ workDir: 're/team/work/D-x/A-000001' })
  assert.equal(rules.length, 3)
  assert.ok(rules.every((rule) => rule.length > 0))
})

test('成员 bootstrap prompt 只含角色、规则入口与「等待任务」，不含契约正文', () => {
  const prompt = contract.buildMemberPrompt({
    post: POST,
    rulesEntry: RULES_ENTRY,
    skillCopyPath: SKILL_COPY,
  })
  assert.match(prompt, /cross-check/u)
  assert.match(prompt, /docs\/agents\/reverse-project-management\.md/u)
  assert.match(prompt, /等待/u)
  assert.ok(!prompt.includes('{'), 'bootstrap prompt 不应内嵌契约 JSON')
  assert.ok(prompt.length < 4000)
})

test('readStartAck：只有合法的 start.json 才给出开始时间', async (t) => {
  const project = makeTempProject({ t })
  const dispatchId = 'D-op-dispatch-1-0123abcd'
  const attemptId = 'A-000001'
  const workDir = contract.workDirFor(dispatchId, attemptId)

  assert.equal(await contract.readStartAck({ root: project.root, dispatchId, attemptId }), null)

  project.write(`${workDir}/start.json`, JSON.stringify({ attempt: attemptId, at: '2026-10-29T08:30:00.000Z' }))
  assert.equal(
    await contract.readStartAck({ root: project.root, dispatchId, attemptId }),
    '2026-10-29T08:30:00.000Z',
  )

  project.write(`${workDir}/start.json`, JSON.stringify({ attempt: 'A-000002', at: '2026-10-29T08:30:00.000Z' }))
  assert.equal(await contract.readStartAck({ root: project.root, dispatchId, attemptId }), null, '别的 attempt 的开始确认不算')

  project.write(`${workDir}/start.json`, '{oops')
  assert.equal(await contract.readStartAck({ root: project.root, dispatchId, attemptId }), null, '损坏的开始确认不猜')
})

test('工作目录必须落在 re/team/work/<dispatch>/<attempt> 下，且不接受任意共享写路径', async (t) => {
  const project = makeTempProject({ t })
  const workDir = await contract.ensureWorkDir({
    root: project.root,
    dispatchId: 'D-op-dispatch-1-0123abcd',
    attemptId: 'A-000001',
    paths,
  })
  assert.equal(workDir, contract.workDirFor('D-op-dispatch-1-0123abcd', 'A-000001'))
  const info = await stat(join(project.root, ...workDir.split('/')))
  assert.equal(info.isDirectory(), true)

  // 该目录可写：写一个 start.json 骨架不越界
  await writeFile(join(project.root, ...workDir.split('/'), 'start.json'), '{}', 'utf8')
})
