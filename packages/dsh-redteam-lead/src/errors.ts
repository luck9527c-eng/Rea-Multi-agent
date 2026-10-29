/**
 * 稳定错误码与契约错误。
 *
 * 错误码集合只有唯一来源：`docs/specs/orchestration-contract.md` 的「稳定错误码」表，
 * 与 `docs/specs/rt-tools.schema.json` 的 `$defs.errorCode` 枚举逐字一致。
 * 任何新增码都必须先改规格；本模块不接受自造码，也不把宿主异常码（如 `ENOENT`）当契约码。
 *
 * 本模块无 I/O、无副作用，可被任何上层模块直接引用。
 */

/** 稳定错误码的五个分组（只用于生成人读诊断与默认状态推导，不改变码本身）。 */
export const ERROR_GROUPS: Readonly<{
  inputPermission: readonly string[]
  access: readonly string[]
  dispatch: readonly string[]
  delivery: readonly string[]
  conclude: readonly string[]
}> = Object.freeze({
  inputPermission: Object.freeze(['INVALID_ARGUMENT', 'ROLE_REQUIRED', 'PATH_INVALID']),
  access: Object.freeze([
    'TEAM_SERVICE_UNAVAILABLE',
    'PROJECT_NOT_CONFIGURED',
    'SKILL_INCOMPATIBLE',
    'PROJECT_SESSION_MISMATCH',
    'PROJECT_BUSY',
  ]),
  dispatch: Object.freeze([
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
  ]),
  delivery: Object.freeze([
    'DELIVERY_FAILED',
    'START_ACK_TIMEOUT',
    'RECOVERY_REQUIRED',
    'OPERATION_CONFLICT',
    'REVISION_CONFLICT',
    'STALE_ATTEMPT',
  ]),
  conclude: Object.freeze(['SUBMISSION_INVALID', 'BASELINE_MISMATCH', 'CHECK_FAILED', 'UNREVIEWED_COMPLETION']),
})

/**
 * 全部稳定错误码，按契约表原顺序（输入与权限 → 接入 → 派发前置 → 交付与恢复 → 收口）。
 */
export const ERROR_CODES: readonly string[] = Object.freeze([
  ...ERROR_GROUPS.inputPermission,
  ...ERROR_GROUPS.access,
  ...ERROR_GROUPS.dispatch,
  ...ERROR_GROUPS.delivery,
  ...ERROR_GROUPS.conclude,
])

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES)

/** 缺省 `next_step`：仅在调用方漏填时兜底，保证诊断文本不为空。 */
const DEFAULT_NEXT_STEP = '按契约「稳定错误码」表核对本码的前置条件与具体对象后，以同一 operation ID 重入'

/** 由码推导的默认状态（信封层用）。 */
export type EnvelopeStatus = 'error' | 'blocked' | 'partial'

/** `ContractError` 的构造入参。`code` 由构造函数在运行期校验，故此处标成可选。 */
export interface ContractErrorInput {
  code?: string
  message?: string
  nextStep?: string
  details?: Record<string, unknown> | null
  status?: EnvelopeStatus | null
  retryable?: boolean
  cause?: unknown
}

/**
 * 判断是否为已登记的稳定错误码。
 */
export function isErrorCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_SET.has(value)
}

/**
 * 契约错误：内部各层抛它，由信封层转成 `status=error|blocked|partial` 的合法结果。
 *
 * 字段与契约表一致：`code`（稳定码）、`message`（原因）、`nextStep`（下一步）、`details`（具体对象）。
 * 另带两个可选字段供信封层使用：`status`（覆盖由码推导的默认状态）与 `retryable`
 * （仅表示允许以同一 operation ID 重入，不代表自动重试）。
 */
export class ContractError extends Error {
  /** 稳定错误码（构造时已校验）。 */
  readonly code: string
  /** 下一步（永不为空）。 */
  nextStep: string
  /** 进程内机读的具体对象；**不可上 wire**（$defs.diagnostic 是封闭三字段）。 */
  details: Record<string, unknown>
  /** 覆盖由码推导的默认状态；`null` 表示沿用默认。 */
  status: EnvelopeStatus | null
  /** 允许以同一 operation ID 重入（不代表自动重试）。 */
  retryable: boolean

  constructor(input: ContractErrorInput = {}) {
    const { code } = input
    // 运行期同样是「非字符串或未登记 ⇒ TypeError」，与迁移前的 CODE_SET.has 判定等价。
    if (typeof code !== 'string' || !CODE_SET.has(code)) {
      throw new TypeError(`未知的稳定错误码: ${String(code)}`)
    }
    const message = typeof input.message === 'string' && input.message.trim() ? input.message : code
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.message = message
    this.nextStep =
      typeof input.nextStep === 'string' && input.nextStep.trim() ? input.nextStep : DEFAULT_NEXT_STEP
    this.details = input.details && typeof input.details === 'object' ? input.details : {}
    this.status = input.status ?? null
    this.retryable = input.retryable ?? false
    if (input.cause !== undefined) this.cause = input.cause
  }
}

/**
 * 识别本模块定义的契约错误（不认鸭子类型的普通对象，也不认带 `code` 的宿主异常）。
 */
export function isContractError(value: unknown): value is ContractError {
  return value instanceof ContractError
}
