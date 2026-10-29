import test from 'node:test'
import assert from 'node:assert/strict'

import { ContractError, ERROR_CODES, ERROR_GROUPS, isContractError, isErrorCode } from '../src/errors.mjs'
import { loadSpecJson } from './helpers/tmp.mjs'

/** 契约表逐字顺序（orchestration-contract.md「稳定错误码」）。 */
const CONTRACT_ORDER = [
  'INVALID_ARGUMENT',
  'ROLE_REQUIRED',
  'PATH_INVALID',
  'TEAM_SERVICE_UNAVAILABLE',
  'PROJECT_NOT_CONFIGURED',
  'SKILL_INCOMPATIBLE',
  'PROJECT_SESSION_MISMATCH',
  'PROJECT_BUSY',
  'UNKNOWN_CAPABILITY',
  'CAPABILITY_MISSING',
  'CAPABILITY_NOT_READY',
  'CAPACITY_UNKNOWN',
  'CAPACITY_EXHAUSTED',
  'POST_DISABLED',
  'MEMBER_BUSY',
  'DEPENDENCY_BLOCKED',
  'RESOURCE_BINDING_MISSING',
  'RESOURCE_BUSY',
  'DELIVERY_FAILED',
  'START_ACK_TIMEOUT',
  'RECOVERY_REQUIRED',
  'OPERATION_CONFLICT',
  'REVISION_CONFLICT',
  'STALE_ATTEMPT',
  'SUBMISSION_INVALID',
  'BASELINE_MISMATCH',
  'CHECK_FAILED',
  'UNREVIEWED_COMPLETION',
]

test('错误码按契约表顺序逐字列出且无重复', () => {
  assert.deepEqual([...ERROR_CODES], CONTRACT_ORDER)
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length)
  assert.ok(Object.isFrozen(ERROR_CODES), 'ERROR_CODES 应冻结')
})

test('错误码集合与 rt-tools.schema.json 的 errorCode 枚举完全一致', async () => {
  const schema = await loadSpecJson('docs/specs/rt-tools.schema.json')
  const specCodes = schema.$defs.errorCode.enum
  assert.deepEqual([...ERROR_CODES].sort(), [...specCodes].sort())
})

test('分组覆盖全部错误码且互不重叠', () => {
  const grouped = Object.values(ERROR_GROUPS).flat()
  assert.equal(grouped.length, ERROR_CODES.length)
  assert.deepEqual([...grouped].sort(), [...ERROR_CODES].sort())
  assert.deepEqual(Object.keys(ERROR_GROUPS), ['inputPermission', 'access', 'dispatch', 'delivery', 'conclude'])
})

test('isErrorCode 只认已登记稳定码', () => {
  assert.equal(isErrorCode('PROJECT_BUSY'), true)
  assert.equal(isErrorCode('project_busy'), false)
  assert.equal(isErrorCode('ENOENT'), false)
  assert.equal(isErrorCode(undefined), false)
  assert.equal(isErrorCode(null), false)
})

test('ContractError 保留 code/message/nextStep/details，可被 isContractError 识别', () => {
  const error = new ContractError({
    code: 'PATH_INVALID',
    message: '路径越界',
    nextStep: '改用项目内相对路径',
    details: { path: '../etc' },
  })

  assert.equal(error.name, 'ContractError')
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'PATH_INVALID')
  assert.equal(error.message, '路径越界')
  assert.equal(error.nextStep, '改用项目内相对路径')
  assert.deepEqual(error.details, { path: '../etc' })
  assert.equal(isContractError(error), true)
})

test('isContractError 不把普通异常或宿主错误码当契约错误', () => {
  assert.equal(isContractError(new Error('boom')), false)
  assert.equal(isContractError({ code: 'PATH_INVALID', message: '鸭子类型' }), false)
  assert.equal(isContractError(null), false)

  const hostError = new Error('spawn failed')
  hostError.code = 'ENOENT'
  assert.equal(isContractError(hostError), false)
})

test('ContractError 拒绝未登记的 code，避免拼错码流到信封', () => {
  assert.throws(
    () => new ContractError({ code: 'PROJECT_BUSYY', message: 'x', nextStep: 'y' }),
    (error) => error instanceof TypeError && /PROJECT_BUSYY/.test(error.message),
  )
})

test('ContractError 缺 nextStep 时也给出可诊断的默认说明', () => {
  const error = new ContractError({ code: 'PROJECT_BUSY', message: '项目锁被占用' })
  assert.equal(typeof error.nextStep, 'string')
  assert.ok(error.nextStep.length > 0)
  assert.deepEqual(error.details, {})
})
