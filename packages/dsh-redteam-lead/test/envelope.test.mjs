import test from 'node:test'
import assert from 'node:assert/strict'

import { ContractError, ERROR_CODES } from '../src/errors.mjs'
import {
  FAILURE_PHASES,
  RESULT_STATUSES,
  blocked,
  defaultStatusFor,
  diagnostic,
  error,
  fromError,
  ok,
  partial,
} from '../src/envelope.mjs'
import { validateInput } from '../src/validate.mjs'
import { loadSpecJson } from './helpers/tmp.mjs'

const OPERATION_ID = 'op-roster-1'
const REQUIRED_KEYS = [
  'schema_version',
  'status',
  'code',
  'operation_id',
  'replayed',
  'retryable',
  'diagnostics',
  'data',
].sort()

let spec = null
async function schema() {
  spec ??= await loadSpecJson('docs/specs/rt-tools.schema.json')
  return spec
}

/** 用规格自身的 `$defs/result` 判断信封是否合规（唯一形状来源）。 */
async function assertValidResult(result) {
  const checked = validateInput(await schema(), 'result', result)
  assert.deepEqual(checked.issues, [], `信封不合规: ${JSON.stringify(checked.issues)}`)
}

test('ok 信封字段齐全、code=null、data 为对象', async () => {
  const result = ok({ operationId: OPERATION_ID, data: { action: 'inspect' } })

  assert.deepEqual(Object.keys(result).sort(), REQUIRED_KEYS)
  assert.equal(result.schema_version, 1)
  assert.equal(result.status, 'ok')
  assert.equal(result.code, null)
  assert.equal(result.operation_id, OPERATION_ID)
  assert.equal(result.replayed, false)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.data, { action: 'inspect' })
  await assertValidResult(result)
})

test('ok 信封允许携带诊断（审计失败不改变成功判定）', async () => {
  const result = ok({
    operationId: OPERATION_ID,
    data: { action: 'bind' },
    diagnostics: [diagnostic('AUDIT_WRITE_FAILED', '审计文件写入失败', '检查 re/team 目录权限后重试')],
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.code, null)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].code, 'AUDIT_WRITE_FAILED')
  await assertValidResult(result)
})

test('ok 信封的 data 必须是对象；缺 data 直接拒绝构造', async () => {
  assert.throws(() => ok({ operationId: OPERATION_ID }), /data/)
  assert.throws(() => ok({ operationId: OPERATION_ID, data: null }), /data/)
  assert.throws(() => ok({ operationId: OPERATION_ID, data: 'text' }), /data/)
})

test('blocked 信封：前置拒绝无副作用，必须带稳定码与至少一条诊断', async () => {
  const result = blocked({
    code: 'PROJECT_BUSY',
    operationId: OPERATION_ID,
    reason: '项目锁被其他操作持有',
    nextStep: '等待持锁操作结束或按恢复记录显式清理后重试',
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.code, 'PROJECT_BUSY')
  assert.equal(result.data, null)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].code, 'PROJECT_BUSY')
  assert.ok(result.diagnostics[0].next_step.length > 0)
  await assertValidResult(result)
})

test('partial 信封：已产生副作用时带已知阶段', async () => {
  const result = partial({
    code: 'RECOVERY_REQUIRED',
    operationId: OPERATION_ID,
    reason: '宿主交付成功但响应丢失，无法唯一关联',
    nextStep: 'Lead 按 recovery_ref 核实后以同一 operation ID 恢复',
    data: { phase: 'assigned', dispatch_id: 'D-0001' },
    retryable: true,
  })

  assert.equal(result.status, 'partial')
  assert.equal(result.code, 'RECOVERY_REQUIRED')
  assert.deepEqual(result.data, { phase: 'assigned', dispatch_id: 'D-0001' })
  assert.equal(result.retryable, true)
  await assertValidResult(result)
})

test('error 信封：非法参数/角色', async () => {
  const result = error({
    code: 'INVALID_ARGUMENT',
    operationId: OPERATION_ID,
    diagnostics: [diagnostic('INVALID_ARGUMENT', 'target_ids 不能为空', '按路线目标集合重新填写 target_ids')],
  })

  assert.equal(result.status, 'error')
  assert.equal(result.code, 'INVALID_ARGUMENT')
  await assertValidResult(result)
})

test('三种非 ok 态都要求已登记稳定码', async () => {
  for (const factory of [blocked, partial, error]) {
    assert.throws(
      () => factory({ code: 'NOT_A_CODE', operationId: OPERATION_ID, reason: 'x', nextStep: 'y' }),
      TypeError,
    )
  }
})

test('非 ok 信封缺诊断也无 reason 时拒绝构造，避免空诊断返回', () => {
  assert.throws(() => error({ code: 'INVALID_ARGUMENT', operationId: OPERATION_ID }), /诊断/)
  assert.throws(
    () => blocked({ code: 'PROJECT_BUSY', operationId: OPERATION_ID, diagnostics: [] }),
    /诊断/,
  )
})

test('failureData 的 phase 只接受规格枚举', async () => {
  assert.throws(
    () => partial({ code: 'DELIVERY_FAILED', operationId: OPERATION_ID, reason: 'x', nextStep: 'y', data: { phase: 'bogus' } }),
    /phase/,
  )
  assert.deepEqual(FAILURE_PHASES, [
    'preflight',
    'prepared',
    'member_ready',
    'task_created',
    'assigned',
    'delivered',
    'integrating',
    'facts_committed',
    'needs_recovery',
  ])
})

test('operation_id 允许 null，也必须是契约 id 形状', async () => {
  const preflight = error({ code: 'INVALID_ARGUMENT', reason: '参数非法', nextStep: '修正入参' })
  assert.equal(preflight.operation_id, null)
  assert.equal(preflight.status, 'error')

  assert.throws(() => ok({ operationId: 'Op_Bad', data: {} }), /operation_id/)
})

test('diagnostic 三字段必填且不得为空', () => {
  assert.deepEqual(diagnostic('PROJECT_BUSY', '被占用', '稍后重试'), {
    code: 'PROJECT_BUSY',
    reason: '被占用',
    next_step: '稍后重试',
  })
  assert.throws(() => diagnostic('PROJECT_BUSY', '', '稍后重试'), ContractError)
  assert.throws(() => diagnostic('PROJECT_BUSY', '被占用'), ContractError)
})

test('默认状态推导：输入类=error、前置类=blocked、副作用后失败=partial', () => {
  assert.equal(defaultStatusFor('PATH_INVALID'), 'error')
  assert.equal(defaultStatusFor('ROLE_REQUIRED'), 'error')
  assert.equal(defaultStatusFor('PROJECT_BUSY'), 'blocked')
  assert.equal(defaultStatusFor('CAPACITY_EXHAUSTED'), 'blocked')
  assert.equal(defaultStatusFor('DELIVERY_FAILED'), 'partial')
  assert.equal(defaultStatusFor('RECOVERY_REQUIRED'), 'partial')
  assert.deepEqual([...RESULT_STATUSES].sort(), ['blocked', 'error', 'ok', 'partial'])
  for (const code of ERROR_CODES) assert.ok(['error', 'blocked', 'partial'].includes(defaultStatusFor(code)), code)
})

test('fromError 转换契约错误：保留码、原因与下一步', async () => {
  const thrown = new ContractError({
    code: 'PATH_INVALID',
    message: '路径越界：../etc',
    nextStep: '改用项目内相对路径',
  })
  const result = fromError(thrown, { operationId: OPERATION_ID })

  assert.equal(result.status, 'error')
  assert.equal(result.code, 'PATH_INVALID')
  assert.equal(result.diagnostics[0].reason, '路径越界：../etc')
  assert.equal(result.diagnostics[0].next_step, '改用项目内相对路径')
  await assertValidResult(result)
})

test('fromError 尊重契约错误自带的 status 覆盖（已持久化后失败→partial）', async () => {
  const thrown = new ContractError({
    code: 'REVISION_CONFLICT',
    message: 'revision 已变为 5',
    nextStep: '先读取实际 owner/revision 再续做',
    status: 'partial',
  })
  const result = fromError(thrown, { operationId: OPERATION_ID, data: { phase: 'integrating', actual_revision: 5 } })

  assert.equal(result.status, 'partial')
  assert.equal(result.code, 'REVISION_CONFLICT')
  assert.equal(result.data.actual_revision, 5)
  await assertValidResult(result)
})

test('fromError 对未知异常也返回合法信封且 status=error，不抛栈', async () => {
  const result = fromError(new Error('spawn ENOENT'), { operationId: OPERATION_ID })

  assert.equal(result.status, 'error')
  assert.equal(result.code, 'RECOVERY_REQUIRED')
  assert.equal(result.replayed, false)
  assert.ok(result.diagnostics.length >= 1)
  assert.ok(result.diagnostics[0].reason.includes('spawn ENOENT'))
  assert.ok(!JSON.stringify(result).includes('at '), '信封里不应出现栈帧')
  assert.equal(Object.hasOwn(result, 'stack'), false)
  await assertValidResult(result)
})

test('fromError 对非 Error 抛出物同样返回合法信封', async () => {
  for (const thrown of ['字符串异常', undefined, { message: '对象异常' }, 42]) {
    const result = fromError(thrown, { operationId: null })
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'RECOVERY_REQUIRED')
    await assertValidResult(result)
  }
})

test('fromError 允许调用方覆盖码与补充诊断', async () => {
  const result = fromError(new Error('team service down'), {
    operationId: OPERATION_ID,
    code: 'TEAM_SERVICE_UNAVAILABLE',
    diagnostics: [diagnostic('TEAM_SERVICE_UNAVAILABLE', '宿主未注入 agentTeams', '确认 bundle 已挂载后再试')],
  })

  assert.equal(result.code, 'TEAM_SERVICE_UNAVAILABLE')
  assert.equal(result.diagnostics.length, 2)
  await assertValidResult(result)
})

test('所有四态构造结果都能通过规格 result 定义（含诊断与 data 约束）', async () => {
  const samples = [
    ok({ operationId: OPERATION_ID, data: {} }),
    blocked({ code: 'CAPACITY_EXHAUSTED', operationId: OPERATION_ID, reason: 'r', nextStep: 'n' }),
    partial({ code: 'START_ACK_TIMEOUT', operationId: OPERATION_ID, reason: 'r', nextStep: 'n', data: { phase: 'delivered' } }),
    error({ code: 'ROLE_REQUIRED', operationId: OPERATION_ID, reason: 'r', nextStep: 'n' }),
    fromError(new Error('x'), { operationId: OPERATION_ID }),
  ]
  for (const sample of samples) await assertValidResult(sample)
})
