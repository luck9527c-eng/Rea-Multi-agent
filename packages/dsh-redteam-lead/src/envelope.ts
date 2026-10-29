/**
 * 结果信封：`ok | blocked | partial | error` 四态。
 *
 * 形状唯一来源是 `docs/specs/rt-tools.schema.json` 的 `$defs.result`：
 * 必带 `schema_version=1`、`status`、`code`、`operation_id`、`replayed`、`retryable`、
 * `diagnostics[]`、`data`，不得有多余字段。
 *
 * 规则（编排契约「版本、角色与通用返回」「稳定错误码」）：
 * - `ok` 的 `code` 必须为 `null`，`data` 必须是 object；允许带诊断（审计失败不改变成功判定）。
 * - 非 `ok` 必须给稳定码与至少一条诊断（每条含原因与具体下一步）；`data` 为
 *   `failureData`（含合法 `phase`）或 `null`。
 * - `status` 与错误码不是一一绑定：已持久化或触及宿主后的失败是 `partial`，
 *   前置拒绝是 `blocked`，非法参数/角色是 `error`。默认由码分组推导，可显式覆盖。
 *
 * 构造器是编程侧的最后一道闸：缺少诊断或码不合法属于调用方 bug，直接抛 `ContractError`，
 * 而不是产出一个看起来合法却无信息的信封。`fromError` 是唯一「绝不抛」的入口，
 * 用于把未捕获异常兜底成合法信封（不带栈）。
 */

import { ContractError, isContractError, isErrorCode } from './errors.js'
import { recordOf } from './guards.js'
import type { Diagnostic, Envelope, ResultStatus } from './types.js'

/** 契约版本号。 */
export const SCHEMA_VERSION = 1

/** 允许的四种状态。 */
export const RESULT_STATUSES: readonly ResultStatus[] = Object.freeze(['ok', 'blocked', 'partial', 'error'])

/** 非 ok 的三种状态（`defaultStatusFor` 的值域）。 */
export type FailureStatus = 'error' | 'blocked' | 'partial'

/**
 * `$defs.failureData` 的 phase 闭集（契约「操作阶段与部分失败」）。
 * 与 operation 台账的阶段相比多 `preflight`、不含 `completed`：失败时不可能已经是 completed。
 */
export const FAILURE_PHASES: readonly string[] = Object.freeze([
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

/** `$defs.id`：operation ID 的形状。 */
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/

/**
 * 按错误码推导默认状态。显式 `status` 永远优先。
 *
 * - `error`：输入与权限（非法参数/角色）。
 * - `blocked`：接入与派发前置，以及未触及宿主的收口校验拒绝 —— 无新成员/任务/正式路线变更。
 * - `partial`：交付与恢复阶段的失败 —— 副作用可能已发生。
 */
export function defaultStatusFor(code: string): FailureStatus {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'ROLE_REQUIRED':
    case 'PATH_INVALID':
      return 'error'
    case 'TEAM_SERVICE_UNAVAILABLE':
    case 'PROJECT_NOT_CONFIGURED':
    case 'SKILL_INCOMPATIBLE':
    case 'PROJECT_SESSION_MISMATCH':
    case 'PROJECT_BUSY':
    case 'UNKNOWN_CAPABILITY':
    case 'CAPABILITY_MISSING':
    case 'CAPABILITY_NOT_READY':
    case 'CAPACITY_UNKNOWN':
    case 'CAPACITY_EXHAUSTED':
    case 'POST_DISABLED':
    case 'MEMBER_BUSY':
    case 'DEPENDENCY_BLOCKED':
    case 'RESOURCE_BINDING_MISSING':
    case 'RESOURCE_BUSY':
    case 'OPERATION_CONFLICT':
    case 'SUBMISSION_INVALID':
    case 'BASELINE_MISMATCH':
    case 'CHECK_FAILED':
    case 'UNREVIEWED_COMPLETION':
      return 'blocked'
    case 'DELIVERY_FAILED':
    case 'START_ACK_TIMEOUT':
    case 'RECOVERY_REQUIRED':
    case 'REVISION_CONFLICT':
    case 'STALE_ATTEMPT':
      return 'partial'
    default:
      throw new TypeError(`未登记的稳定错误码: ${String(code)}`)
  }
}

function nonEmpty(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * 构造一条诊断。三个字段都是必填非空文本：`code`、`reason`（原因）、`next_step`（下一步）。
 *
 * 注意：`$defs.diagnostic` 的 `code` 是任意非空文本，不是 `errorCode` 枚举 ——
 * `ok` 信封里记录审计失败等旁路问题时可以用非稳定码（例如 `AUDIT_WRITE_FAILED`）。
 */
export function diagnostic(code: string, reason: string, nextStep: string): Diagnostic {
  if (!nonEmpty(code)) throw new ContractError({ code: 'INVALID_ARGUMENT', message: '诊断缺少 code' })
  if (!nonEmpty(reason)) throw new ContractError({ code: 'INVALID_ARGUMENT', message: '诊断缺少 reason（原因）' })
  if (!nonEmpty(nextStep)) {
    throw new ContractError({ code: 'INVALID_ARGUMENT', message: '诊断缺少 next_step（下一步）' })
  }
  return { code, reason, next_step: nextStep }
}

function normalizeOperationId(operationId: unknown): string | null {
  if (operationId === null || operationId === undefined) return null
  if (typeof operationId === 'string' && OPERATION_ID_PATTERN.test(operationId)) return operationId
  throw new ContractError({
    code: 'INVALID_ARGUMENT',
    message: `operation_id 形状非法: ${JSON.stringify(operationId)}`,
    nextStep: '使用 $defs.id 允许的小写字母/数字/下划线/短横线形状，或在不涉及操作时传 null',
  })
}

function assertFailureData(data: unknown): object | null {
  if (data === null || data === undefined) return null
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ContractError({ code: 'INVALID_ARGUMENT', message: '非 ok 信封的 data 只能是对象或 null' })
  }
  // 上一行已排除 null 与数组：这里按记录读单个字段是安全的，不做属性之外的假设。
  const record = data as Record<string, unknown>
  const phase = record.phase
  if (Object.hasOwn(record, 'phase') && !(typeof phase === 'string' && FAILURE_PHASES.includes(phase))) {
    throw new ContractError({
      code: 'INVALID_ARGUMENT',
      message: `data.phase 不在契约枚举内: ${JSON.stringify(phase)}`,
      nextStep: `phase 只能取 ${FAILURE_PHASES.join('|')}`,
    })
  }
  return data
}

/** `assemble` 的入参。 */
interface AssembleInput {
  code: string | null
  operationId: unknown
  replayed: boolean | undefined
  retryable: boolean | undefined
  diagnostics: Diagnostic[]
  data: object | null
}

/** 组装最终信封；字段顺序固定，便于人读与 diff。 */
function assemble(status: ResultStatus, input: AssembleInput): Envelope {
  const { code, operationId, replayed, retryable, diagnostics, data } = input
  return {
    schema_version: SCHEMA_VERSION,
    status,
    code,
    operation_id: normalizeOperationId(operationId),
    replayed: replayed === true,
    retryable: retryable === true,
    diagnostics,
    data,
  }
}

/** `ok()` 的入参：`data` 由运行期检查保证是对象，故这里先收 `unknown`。 */
export interface OkOptions {
  operationId?: unknown
  data?: unknown
  diagnostics?: readonly Diagnostic[]
  replayed?: boolean
  retryable?: boolean
}

/** `ok` 信封。 */
export function ok(options: OkOptions = {}): Envelope {
  const { operationId = null, data, diagnostics = [], replayed = false, retryable = false } = options
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ContractError({
      code: 'INVALID_ARGUMENT',
      message: 'ok 信封的 data 必须是对象（$defs.result 对 ok 的约束）',
      nextStep: '按工具的 ok data 形状返回对象，不要返回 null 或数组',
    })
  }
  return assemble('ok', {
    code: null,
    operationId,
    replayed,
    retryable,
    diagnostics: [...diagnostics],
    data,
  })
}

/** 三种非 ok 态的公共入参。 */
export interface FailOptions {
  code?: unknown
  operationId?: unknown
  reason?: unknown
  nextStep?: unknown
  diagnostics?: readonly Diagnostic[]
  data?: unknown
  replayed?: boolean
  retryable?: boolean
}

/** 三种非 ok 态的公共构造。 */
function fail(status: ResultStatus, options: FailOptions = {}): Envelope {
  const {
    code,
    operationId = null,
    reason,
    nextStep,
    diagnostics = [],
    data = null,
    replayed = false,
    retryable = false,
  } = options

  // 先确认码合法：未登记码属于编程错误（不会进到信封）。
  if (!isErrorCode(code)) {
    throw new TypeError(`未登记的稳定错误码: ${String(code)}`)
  }
  defaultStatusFor(code)

  const entries = [...diagnostics]
  if (entries.length === 0) {
    if (nonEmpty(reason) && nonEmpty(nextStep)) {
      entries.push(diagnostic(code, reason, nextStep))
    } else {
      throw new ContractError({
        code: 'INVALID_ARGUMENT',
        message: '非 ok 信封必须带至少一条诊断（code/reason/next_step），或同时给出 reason 与 nextStep',
        nextStep: '补上具体原因与下一步，不要返回空诊断',
      })
    }
  }

  return assemble(status, {
    code,
    operationId,
    replayed,
    retryable,
    diagnostics: entries,
    data: assertFailureData(data),
  })
}

/** `status=blocked`：前置拒绝，无新成员/任务/正式路线变更。 */
export function blocked(options: FailOptions = {}): Envelope {
  return fail('blocked', options)
}

/** `status=partial`：副作用可能已发生，`data` 应带已知的 dispatch/task/member/阶段。 */
export function partial(options: FailOptions = {}): Envelope {
  return fail('partial', options)
}

/** `status=error`：非法参数/角色等调用方错误。 */
export function error(options: FailOptions = {}): Envelope {
  return fail('error', options)
}

const UNKNOWN_EXCEPTION_NEXT_STEP =
  '按诊断中的原始异常定位宿主/脚本问题后，以同一 operation ID 重入；不要重试未修复的同一请求'

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message || thrown.name || '未知异常'
  if (thrown === undefined) return '未知异常（抛出物为 undefined）'
  if (thrown === null) return '未知异常（抛出物为 null）'
  if (typeof thrown === 'object') {
    const message = recordOf(thrown).message
    return typeof message === 'string' && message ? message : JSON.stringify(thrown)
  }
  return String(thrown)
}

/** `fromError()` 的入参。 */
export interface FromErrorOptions {
  operationId?: unknown
  code?: unknown
  status?: ResultStatus
  data?: unknown
  retryable?: boolean
  diagnostics?: readonly Diagnostic[]
}

/**
 * 异常 → 合法信封。**绝不抛出**，也不把栈写进返回体。
 *
 * - `ContractError`：沿用其码、原因、下一步；状态取 `options.status ?? error.status ?? 默认推导`。
 * - 其它异常：`options.code ?? 'RECOVERY_REQUIRED'`，`status` 固定为 `error`
 *   （未预期异常意味着状态未核实，按 SEAMS「无法映射时用 RECOVERY_REQUIRED」）。
 *
 * 注意：`ContractError.details` 无法进入信封 —— `$defs.diagnostic` 只有三个字段且
 * `additionalProperties=false`。需要机器消费的细节请放进 `options.data`（failureData 形状），
 * 需要人读的具体对象请写进 `message`。
 */
export function fromError(thrown: unknown, options: FromErrorOptions = {}): Envelope {
  const {
    operationId = null,
    code: codeOverride,
    status: statusOverride,
    data = null,
    retryable,
    diagnostics = [],
  } = options

  const isContract = isContractError(thrown)
  const requested = codeOverride ?? (isContract ? thrown.code : 'RECOVERY_REQUIRED')
  // 调用方可能传错码；兜底成已登记码，保证 fromError 本身绝不抛。
  const code = isErrorCode(requested) ? requested : 'RECOVERY_REQUIRED'

  let status: ResultStatus =
    statusOverride ?? (isContract && thrown.status ? thrown.status : isContract ? defaultStatusFor(code) : 'error')
  if (!RESULT_STATUSES.includes(status) || status === 'ok') status = 'error'

  const reason = isContract ? thrown.message : `未捕获异常：${describeThrown(thrown)}`
  const nextStep = isContract ? thrown.nextStep : UNKNOWN_EXCEPTION_NEXT_STEP
  const retryableValue = retryable ?? (isContract ? thrown.retryable : false)

  return fail(status, {
    code,
    operationId,
    diagnostics: [diagnostic(code, reason, nextStep), ...diagnostics],
    data,
    retryable: retryableValue,
  })
}
