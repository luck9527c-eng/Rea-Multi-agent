/**
 * T6 `rt_dispatch`：把一条**已在项目 skill 中建立的可执行路线**交给一个成员。
 *
 * 不变量顺序（编排契约「工具输入与输出」+ 协作契约「派发顺序的不变量」）：
 *
 * 1. 路线必须是 Lead 按 skill 建立、尚未收口的可执行问题（`readRoute` + `impact`）；
 *    `target_ids` 必须是该路线目标集合的非空子集，额外目标要先建新路线。
 * 2. 有效 `validated` 依赖、条件版本、open 争议、恢复待办逐项核查。
 * 3. 能力 = 岗位 `required` ∪ 任务 `capability_needs`（只追加）；缺通道/入口 → `CAPABILITY_MISSING`。
 * 4. 预算（D25 组装口径）+ `MEMBER_BUSY` + `DEPENDENCY_BLOCKED`。
 * 5. 资源在锁内检查/租用；别名归一、默认独占、`quarantined` 不再分配。
 *
 * 前置任一不过 → `status=blocked` **且零副作用**（不建成员、不建任务、不写 `re/team/`）。
 * 只有契约落盘、成员就绪、任务 `in_progress` 且 owner 正确、交付信封被宿主接收，
 * 才是 `phase='delivered'` 的成功派发；中间失败一律 `partial` 并带回已产生的身份。
 *
 * 操作阶段：`prepared → member_ready → task_created → assigned → delivered`，
 * 每步「先存意图、后存实际 ID」；同 `operation_id` 重入从已存阶段续做
 * （不重复 spawn、不建第二个 task），响应丢失时按确定的成员名 / 任务摘要标记唯一关联。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError, isErrorCode } from './errors.js'
import { toolNamesFromSchemas } from './capability.js'
import * as bindingModule from './binding.js'
import * as capacitySource from './capacity-source.js'
import type { CallCapacity, CapacitySource, EffectiveCapacity } from './capacity-source.js'
import { isRecord, recordOf, thrownCode, thrownMessage } from './guards.js'
import * as pathsModule from './paths.js'
import * as resourceDefaults from './resources.js'
import * as contractDefaults from './contract.js'
import type { BaselineRef, CatalogPost, ContractDigests, MergedRequirements, RouteRecord } from './contract.js'
import type { Deps, Diagnostic, Envelope, HandlerCtx, HandlerResult } from './types.js'

/** `$defs.id` */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/u
const ROUTE_ID = /^R-[A-Za-z0-9_-]+$/u
const TARGET_ID = /^T-[A-Za-z0-9_-]+$/u
const ATTEMPT_ID = /^A-[0-9]{6}$/u
const DISPATCH_ID = /^D-[a-z0-9][a-z0-9_-]{0,63}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RUN_ID = /^RUN-[A-Za-z0-9_-]+$/u

/** RUN 的 seal 文件（`re/seals/runs/<RUN>.json`）；目标封存 `re/seals/targets/T-*.json` 不带 RUN 身份。 */
const RUN_SEAL_PATH = /^re\/seals\/runs\/(RUN-[A-Za-z0-9_-]+)\.json$/u

/** `$defs.anchorKind` */
const ANCHOR_KINDS = Object.freeze([
  'binary_location', 'source_location', 'web_capture', 'runtime_event', 'evidence_export', 'artifact_locator',
])

/** 项目规则入口（bootstrap prompt 与交付信封都指向它）。 */
export const RULES_ENTRY = 'docs/agents/reverse-project-management.md'
/** 项目内 skill 副本（只读入口，不用全局副本覆盖历史）。 */
export const SKILL_COPY_ENTRY = '.agents/skills/reverse-project-management/SKILL.md'

/** `re/team/binding.json`（T5 的 owner；这里只读，缺席时不做跨会话判定）。 */
const BINDING_PATH = 're/team/binding.json'
/** 工具清单（D11：目前没有生产者，必须容忍缺失）。 */
const TOOL_INVENTORY_PATH = 're/env/tools.json'
/** 项目能力绑定（能力族的别名映射）。 */
const CAPABILITY_BINDINGS_PATH = 're/team/capabilities.json'

const NOTE_ZERO_SIDE_EFFECT = '前置拒绝不建成员、不建任务、不改路线（编排契约「稳定错误码」）'

// ---------------------------------------------------------------------------
// 本模块的形状
//
// 共享层（`types.ts`）只收 `Deps`/`HandlerCtx`/`Envelope`；派发自己的入参、计划与
// 台账视图都写在这里。跨模块边界一律按结构取（`typeof import('./x.js')`），
// 项目记录/适配器结果一律按字段读（`recordOf`），不假设一定存在。
// ---------------------------------------------------------------------------

/** `deps.envelope` 的形状（装配完整性检查通过后才拿得到）。 */
type EnvelopeModule = typeof import('./envelope.js')
/** `deps.paths` 的形状。 */
type PathsModule = typeof import('./paths.js')
/** `deps.atomic` 的形状。 */
type AtomicModule = typeof import('./atomic.js')
/** `deps.resources` 的形状。 */
type ResourcesModule = typeof import('./resources.js')
/** `deps.contract` 的形状。 */
type ContractModule = typeof import('./contract.js')
/** `deps.capacity` 的形状。 */
type CapacityModule = typeof import('./capacity.js')
/** 项目适配器实例（`deps.projectAdapter` 可为 `null`，调用方先判空）。 */
type ProjectAdapterLike = NonNullable<Deps['projectAdapter']>
/** 团队适配器实例（`deps.teamAdapter` 可为 `null`，调用方先判空）。 */
type TeamAdapterLike = NonNullable<Deps['teamAdapter']>
/** 操作台账（`deps.operation.createOperationLedger()` 的产物）。 */
type OperationLedger = ReturnType<typeof import('./operation.js').createOperationLedger>

/** 台账里的一条记录（本模块只读这几个键）。 */
interface OperationRecord {
  input_hash?: unknown
  phase?: string
  data?: { binding?: { team_id?: unknown } } & Record<string, unknown>
  /** 恢复时随 attempt 记录一起回写（`retry_of` 撤销过就带上原撤销块）。 */
  revoked?: unknown
}

/** 适配器绑定快照（`re/team/binding.json` 的三字段投影）。 */
interface BindingSnapshot {
  session_id: string | null
  team_id: string | null
  epoch: number | null
}

/** 规范化后的派发请求（形状校验已全部通过）。 */
interface DispatchRequest {
  project_root: string
  operation_id: string
  post_id: string
  route_id: string
  target_ids: string[]
  objective: string
  evidence_required: string[]
  prohibited: string[]
  capability_needs: string[]
  depends_on_tasks: string[]
  resource_needs: unknown[]
  timebox_ms: number
  delivery_timeout_ms: number
  retry_of: Record<string, unknown> | null
  /**
   * T18：本次调用声明的容量（优先级最高）。
   *
   * **可选**而不是 `null` 占位：`operationInputHash()` 会对整个请求对象求哈希，
   * 未声明时也不能凭空多出一个键 —— 否则升级前登记的 operation 在恢复时会被判
   * `OPERATION_CONFLICT`（输入哈希变了，但输入其实没变）。
   */
  capacity?: CallCapacity | null
}

/** `normalizeDispatchInput` 的结果：形状错误时 `value` 为空对象（调用方不会读它）。 */
type NormalizedDispatch =
  | { ok: true; value: DispatchRequest; issues: Diagnostic[]; operationId: string }
  | { ok: false; value: Record<string, never>; issues: Diagnostic[]; operationId: string | null }

/** 成员决策（`decideMember` 的产物）；`busy` 由 preflight 当场拒绝，不进计划。 */
type MemberDecision =
  | { action: 'reuse'; member: string }
  | { action: 'busy'; members: string[]; tasks: unknown[] }
  | { action: 'spawn'; member: string; failedBefore: string[] }

/** 交给锁内阶段的成员选择（只剩 reuse/spawn）。 */
type MemberChoice = { action: 'reuse' | 'spawn'; member: string; failedBefore?: string[] }

/** 锁内确定的成员身份（名字/宿主 id/复用方式）；字段来自适配器，按 `unknown` 收。 */
interface MemberIdentity {
  name: unknown
  id: unknown
  mode: string
}

/** 成员决策的「够用部分」：preflight 的计划，或台账里记下的意图。 */
interface MemberIntentLike {
  action: unknown
  member: unknown
  failedBefore?: unknown[]
}

/** 能力匹配结果里本模块用到的两个数组（`capability.matchCapabilities` 的形状）。 */
interface CapabilityMatchView {
  matched: readonly { capability: unknown }[]
  providers: readonly { capability?: unknown; tool_id?: unknown }[]
}

/** 能力匹配结果：缺口明细（preflight 直接拿它造诊断）。 */
interface CapabilityMatchResult extends CapabilityMatchView {
  missing: readonly { code: unknown; capability: unknown; reason: unknown; next_step: string }[]
}

/** 预算分配结果（`capacity.planBudget` 的产物里本模块用到的两个数组）。 */
interface BudgetPlan {
  assigned: readonly { post_id: unknown }[]
  gaps: readonly { code?: string; reason?: string; next_step?: string }[]
}

/** `capacity.planBudget` 的入参：本模块实际传的七个键。 */
interface PlanBudgetInput {
  candidates: readonly Record<string, unknown>[]
  remainingMemberSlots: unknown
  remainingActivations: unknown
  reuseCandidates: readonly Record<string, unknown>[]
  maxPosts: number
  reservedMemberSlots: number
  reservedActivations: number
}

/**
 * 取 `capacity.planBudget` 的调用视图。
 *
 * `capacity.PlanBudgetInput` 把每个字段都声明成可选 `unknown`，本模块的七个键逐字可赋值给它，
 * 所以这里**不需要断言**：直接取函数引用即可（运行期拿到的还是同一个函数）。
 */
function planBudgetOf(module: CapacityModule): (input: PlanBudgetInput) => BudgetPlan {
  return module.planBudget
}

/** `resources.normalizeResourceNeeds` 的 issues 形状（三字段诊断）。 */
interface ResourceIssue {
  code: string
  reason: string
  next_step: string
}

/** 锁内 `failure()` 的入参：阶段可覆盖，`extra` 追加进 failureData。 */
interface FailureOptions {
  reason: unknown
  nextStep: unknown
  phase?: unknown
  extra?: Record<string, unknown>
  resolvedCode?: string
  /** 覆盖默认的单条诊断（T18 的容量碰撞要一次说清成员名、hostCode 与观测值落点）。 */
  diagnostics?: readonly Diagnostic[]
}

/** preflight 的产物：已读记录的快照 + 派生身份 + 默认要求。 */
interface PreflightPlan {
  route: RouteRecord
  post: CatalogPost
  requirements: MergedRequirements
  match: CapabilityMatchView
  capacity: unknown
  budget: unknown
  memberDecision: MemberChoice
  resourcePlan: unknown
  baseline: unknown
  routeTargets: string[]
  gaps: unknown[]
  callerName: string
  /** T18：生效容量的来源、上限与诊断（unknown 会照派，但必须把风险说清楚）。 */
  capacitySource: CapacitySource
  capacityLimits: { max_members: number | null; max_active_subagents: number | null }
  capacityDiagnostics: Diagnostic[]
  /** 门 1 探测到的兼容性摘要：契约必须冻结它（收口侧的规则漂移守卫靠它）。 */
  digests: ContractDigests
}

/** `readFrozenDigests()` 的结果：失败带稳定码，成功带要写进契约的三个摘要。 */
type FrozenDigestsRead =
  | { ok: true; digests: ContractDigests }
  | { ok: false; code: string; reason: string; nextStep: string }

/** preflight 的结果：拒绝时带合法信封（零副作用），通过时带计划。 */
type PreflightResult = { ok: true; plan: PreflightPlan } | { ok?: false; envelope: Envelope }

/** `resolveRetry` 的结果：失败带状态与稳定码，成功带新 attempt 身份与旧契约摘要。 */
type RetryResult =
  | {
    ok: true
    status?: undefined
    dispatchId: string
    attemptIndex: number
    attemptId: string
    recoveryRef: string
    oldTaskId: string | null
    oldAttemptId: string
    oldContractRef: string
    objective: unknown
    routeId: unknown
    postId: unknown
    targetIds: unknown[]
  }
  | { ok: false; status?: 'error'; code: string; reason: string; next_step: string }

/** `preflight` 的入参。 */
interface PreflightParams {
  ctx: HandlerCtx
  deps: AssembledDeps
  envelope: EnvelopeModule
  request: DispatchRequest
  root: string
  dispatchId: string
  attemptId: string
  excludeTaskIds: readonly string[]
  resourcesMod: ResourcesModule
  contractMod: ContractModule
  callerName: string
  projectAdapter: ProjectAdapterLike
  teamAdapter: TeamAdapterLike
  /** T18：本会话身份（观测值按会话生效；`null` = 拿不到，观测值一律不套用）。 */
  capacitySessionId: string | null
}

/** `runLocked` 的入参。 */
interface RunLockedParams {
  ctx: HandlerCtx
  deps: AssembledDeps
  envelope: EnvelopeModule
  request: DispatchRequest
  root: string
  operationId: string
  inputHash: string
  ledger: OperationLedger
  dispatchId: string
  attemptId: string
  attemptIndex: number
  contractRef: string
  workDir: string
  runIdReservation: string
  retry: { recoveryRef?: string } | null
  excludeTaskIds: readonly string[]
  plan: PreflightPlan | null
  bindingSnap: BindingSnapshot | null
  callerName: string
  existing: OperationRecord | null
  resourcesMod: ResourcesModule
  contractMod: ContractModule
  atomic: AtomicModule
  paths: PathsModule
  projectAdapter: ProjectAdapterLike
  teamAdapter: TeamAdapterLike
  onPersisted: () => void
  /** T18：本会话身份（写观测值/判「观测中」标记时用；与 preflight 同一口径）。 */
  capacitySessionId: string | null
}

/** `resolveRetry` 的入参。 */
interface ResolveRetryParams {
  root: string
  request: DispatchRequest
  paths: PathsModule
  teamAdapter: TeamAdapterLike
  deps: AssembledDeps
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空文本判定（谓词形式：通过后调用方拿到 `string`）。 */
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 字符串数组：去空白、丢非字符串、按首次出现去重。 */
function uniqueStrings(value: unknown): string[] {
  const out: string[] = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * 把 baseline 采集结果投影成**契约里的 `baseline_ref`**（装配接缝，T12）。
 *
 * - `src/baseline.mjs`（T7，生产路径）：`{ok, ref, baseline}` → 内联**快照对象**。
 *   收口侧 `loadBaseline({ref, embedded})` 的 `embedded` 就是它（同时校验
 *   `schema_version`/`dispatch_id`/`targets[].target_id,path,sha256`）。
 * - `src/contract.mjs`（T6，仅 `deps.baseline` 缺席时的回退）：`{ok, baseline_ref}` 已是内联形状。
 *
 * 契约里的 target 记录沿用 `id`（T6 契约的既有形状，任务板/诊断都读它），
 * 同时保留快照的 `target_id`（T7 `validateBaselineShape` 读它）—— 同一个身份两个键名，
 * 由装配层显式对齐，不从任何一侧偷偷改形状。
 */
function baselineRefForContract(capture: unknown): BaselineRef | null {
  const view = recordOf(capture)
  if (isPlainObject(view.baseline)) {
    const snapshot = view.baseline
    const targets = (Array.isArray(snapshot.targets) ? snapshot.targets : []).map((target) => (
      isPlainObject(target) && typeof target.id !== 'string' && typeof target.target_id === 'string'
        ? { ...target, id: target.target_id }
        : target
    ))
    return { ...snapshot, targets }
  }
  if (isPlainObject(view.baseline_ref)) return view.baseline_ref
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

// ---------------------------------------------------------------------------
// 入参规范化（形状级；跨字段语义在 preflight 里判）
// ---------------------------------------------------------------------------

/**
 * 规范化 `dispatchInput`：填默认值、去重集合项、给出形状错误。
 *
 * 形状错误是调用方错误（`INVALID_ARGUMENT` / `status=error`），不是派发前置拒绝。
 */
export function normalizeDispatchInput(raw: unknown): NormalizedDispatch {
  const issues: Diagnostic[] = []
  const operationIdRaw = isPlainObject(raw) ? raw.operation_id : undefined
  const operationId = typeof operationIdRaw === 'string' ? operationIdRaw : null
  const push = (reason: string, nextStep: string): void => {
    issues.push({ code: 'INVALID_ARGUMENT', reason, next_step: nextStep })
  }

  if (!isPlainObject(raw)) {
    push('dispatch 输入必须是对象', '按 $defs.dispatchInput 传参')
    return { ok: false, value: {}, issues, operationId }
  }
  if (!nonEmpty(raw.project_root)) push('project_root 必须是非空字符串', '传入显式选择的本地分析目录绝对路径')
  if (!nonEmpty(raw.operation_id) || !ID_PATTERN.test(raw.operation_id)) {
    push(`operation_id 形状非法: ${JSON.stringify(raw.operation_id)}`, '使用 $defs.id 允许的小写字母/数字/下划线/短横线形状')
  }
  if (!nonEmpty(raw.post_id) || !ID_PATTERN.test(raw.post_id)) {
    push(`post_id 形状非法: ${JSON.stringify(raw.post_id)}`, '传岗位目录里的 ID')
  }
  if (!nonEmpty(raw.route_id) || !ROUTE_ID.test(raw.route_id)) {
    push(`route_id 形状非法: ${JSON.stringify(raw.route_id)}`, '传项目里已登记的 R-… 路线 ID')
  }
  const targetIds = Array.isArray(raw.target_ids) ? raw.target_ids : null
  if (targetIds === null || targetIds.length === 0) {
    push('target_ids 必须是非空数组', '传该路线目标集合的非空子集')
  } else {
    for (const id of targetIds) {
      if (!nonEmpty(id) || !TARGET_ID.test(id)) push(`target_ids 含非法目标 ID: ${JSON.stringify(id)}`, '目标 ID 形如 T-001')
    }
    if (new Set(targetIds).size !== targetIds.length) push('target_ids 不得重复', '去掉重复项')
  }
  if (!nonEmpty(raw.objective)) push('objective 必须是非空白文本', '写清本次要回答的具体问题')
  const evidence = Array.isArray(raw.evidence_required) ? raw.evidence_required : null
  if (evidence === null || evidence.length === 0) {
    push('evidence_required 必须是非空数组', `从 ${ANCHOR_KINDS.join('/')} 里选`)
  } else {
    for (const kind of evidence) {
      if (!ANCHOR_KINDS.includes(kind)) push(`evidence_required 含未知锚点类别: ${JSON.stringify(kind)}`, `只能取 ${ANCHOR_KINDS.join('/')}`)
    }
    if (new Set(evidence).size !== evidence.length) push('evidence_required 不得重复', '去掉重复项')
  }
  if (raw.prohibited !== undefined && !Array.isArray(raw.prohibited)) push('prohibited 必须是数组', '传禁止事项文本数组')
  if (raw.capability_needs !== undefined && !Array.isArray(raw.capability_needs)) push('capability_needs 必须是数组', '传能力族名数组')
  if (raw.depends_on_tasks !== undefined && !Array.isArray(raw.depends_on_tasks)) push('depends_on_tasks 必须是数组', '传当前团队任务 ID 数组')
  if (raw.resource_needs !== undefined && !Array.isArray(raw.resource_needs)) push('resource_needs 必须是数组', '传 [{resource_key, mode}]')
  // 先判 `typeof`：`Number.isInteger` 对非数字一律 false，判定结果与原来一致。
  if (raw.timebox_ms !== undefined
    && (typeof raw.timebox_ms !== 'number' || !Number.isInteger(raw.timebox_ms) || raw.timebox_ms < 1)) {
    push('timebox_ms 必须是 ≥1 的整数', '传毫秒数')
  }
  if (raw.delivery_timeout_ms !== undefined
    && (typeof raw.delivery_timeout_ms !== 'number'
      || !Number.isInteger(raw.delivery_timeout_ms)
      || raw.delivery_timeout_ms < 1)) {
    push('delivery_timeout_ms 必须是 ≥1 的整数', '传毫秒数')
  }
  const retryOf: unknown = raw.retry_of ?? null
  if (retryOf !== null) {
    if (!isPlainObject(retryOf)) {
      push('retry_of 必须是对象或 null', '传 {dispatch_id, attempt_id, recovery_ref}')
    } else {
      if (!nonEmpty(retryOf.dispatch_id) || !DISPATCH_ID.test(retryOf.dispatch_id)) {
        push(`retry_of.dispatch_id 形状非法: ${JSON.stringify(retryOf.dispatch_id)}`, '引用当前 attempt 的 dispatch_id')
      }
      if (!nonEmpty(retryOf.attempt_id) || !ATTEMPT_ID.test(retryOf.attempt_id)) {
        push(`retry_of.attempt_id 形状非法: ${JSON.stringify(retryOf.attempt_id)}`, '引用当前旧 attempt')
      }
      if (!nonEmpty(retryOf.recovery_ref)) {
        push('retry_of.recovery_ref 必须是非空路径', '传真实的恢复核查记录（项目内相对路径）')
      }
    }
  }
  // T18：按调用声明的容量（可选）。形状不合法是调用方错误，静默忽略会把「我声明了上限」变成谎话。
  const callCapacity = capacitySource.parseCallCapacity(raw.capacity)
  if (callCapacity.issue !== null) {
    push(callCapacity.issue, '按 $defs.dispatchInput.capacity 传 {max_members, max_active_subagents}（都必须是 >=1 的整数）')
  }

  if (issues.length > 0) return { ok: false, value: {}, issues, operationId }

  // 走到这里说明上面每一项形状检查都通过了：这几个字段必然是字符串，
  // `String()` 对字符串是恒等变换（只为收敛类型，不改变入参内容）。
  return {
    ok: true,
    operationId: String(operationIdRaw),
    issues: [],
    value: {
      project_root: String(raw.project_root),
      operation_id: String(raw.operation_id),
      post_id: String(raw.post_id),
      route_id: String(raw.route_id),
      target_ids: targetIds === null ? [] : [...targetIds],
      objective: String(raw.objective),
      evidence_required: evidence === null ? [] : [...evidence],
      prohibited: uniqueStrings(raw.prohibited),
      capability_needs: uniqueStrings(raw.capability_needs),
      depends_on_tasks: uniqueStrings(raw.depends_on_tasks),
      resource_needs: Array.isArray(raw.resource_needs) ? raw.resource_needs.map((need) => ({ ...need })) : [],
      timebox_ms: typeof raw.timebox_ms === 'number' ? raw.timebox_ms : 1800000,
      delivery_timeout_ms: typeof raw.delivery_timeout_ms === 'number' ? raw.delivery_timeout_ms : 60000,
      retry_of: retryOf === null ? null : { ...recordOf(retryOf) },
      // 没声明就不写这个键：输入哈希与升级前逐字一致（恢复旧 operation 不会被判冲突）。
      ...(callCapacity.value === null ? {} : { capacity: callCapacity.value }),
    },
  }
}

// ---------------------------------------------------------------------------
// 信封助手
// ---------------------------------------------------------------------------

/**
 * 诊断文本：判据与 `envelope.diagnostic` 的运行期检查逐字一致（不是非空字符串就抛
 * `INVALID_ARGUMENT`），因此这里只是把同一个检查提前，不改变可观察行为。
 */
function diagnosticText(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  throw new ContractError({ code: 'INVALID_ARGUMENT', message: `诊断缺少 ${field}` })
}

function diagnosticOf(envelope: EnvelopeModule, code: string, reason: unknown, nextStep: unknown): Diagnostic {
  return envelope.diagnostic(code, diagnosticText(reason, 'reason'), diagnosticText(nextStep, 'next_step'))
}

/** `blockedEnvelope` 的入参（`diagnostics` 缺席时用三字段诊断兜底）。 */
interface BlockedOptions {
  code: string
  operationId: unknown
  phase?: unknown
  data?: Record<string, unknown> | null
  reason: unknown
  nextStep: unknown
  diagnostics?: readonly Diagnostic[]
}

/** `partialEnvelope` 的入参（`retryable` 默认 true）。 */
interface PartialOptions {
  code: string
  operationId: unknown
  phase: unknown
  data?: Record<string, unknown> | null
  reason: unknown
  nextStep: unknown
  diagnostics?: readonly Diagnostic[]
  retryable?: boolean
}

/** `errorEnvelope` 的入参（没有 phase/data）。 */
interface ErrorOptions {
  code: string
  operationId: unknown
  reason: unknown
  nextStep: unknown
  diagnostics?: readonly Diagnostic[]
}

function blockedEnvelope(envelope: EnvelopeModule, {
  code,
  operationId,
  phase = 'preflight',
  data = null,
  reason,
  nextStep,
  diagnostics,
}: BlockedOptions): Envelope {
  const entries = diagnostics ?? [diagnosticOf(envelope, code, reason, nextStep)]
  return envelope.blocked({
    code,
    operationId,
    data: { phase, ...(data ?? {}) },
    diagnostics: entries,
    reason,
    nextStep,
  })
}

function partialEnvelope(envelope: EnvelopeModule, {
  code,
  operationId,
  phase,
  data,
  reason,
  nextStep,
  diagnostics,
  retryable = true,
}: PartialOptions): Envelope {
  const entries = diagnostics ?? [diagnosticOf(envelope, code, reason, nextStep)]
  return envelope.partial({
    code,
    operationId,
    data: { phase, ...(data ?? {}) },
    diagnostics: entries,
    reason,
    nextStep,
    retryable,
  })
}

function errorEnvelope(envelope: EnvelopeModule, {
  code,
  operationId,
  reason,
  nextStep,
  diagnostics,
}: ErrorOptions): Envelope {
  return envelope.error({
    code,
    operationId,
    diagnostics: diagnostics ?? [diagnosticOf(envelope, code, reason, nextStep)],
    reason,
    nextStep,
  })
}

/** 适配器码 → 契约码（适配器已经映射过一次；这里只兜底未登记码）。 */
function stableCode(code: unknown): string {
  return isErrorCode(code) ? code : 'RECOVERY_REQUIRED'
}

// ---------------------------------------------------------------------------
// 外部结果读取
//
// 适配器/模块结果是**别的模块推断或声明的联合**：`ok` 在未标注时会被宽化成 `boolean`
// （不能当判别式收窄），字段也只在部分分支上存在。本模块一律**按键读**，读取统一走
// `recordOf`：对对象是恒等变换，对 `null`/`undefined` 给 `{}` —— 判据仍是「读不到的键
// 就是 undefined」，与原代码的 `x.field` / `x?.field` 逐字等价。
// ---------------------------------------------------------------------------

/**
 * 资源/基准模块的失败诊断 → 契约三字段。
 *
 * 这三个字段在那些模块的失败分支里都由 `issue()` / `baselineFailure()` 构造，类型上的
 * 可选性来自各自的联合返回；这里按原值透传，只把缺字段补成空串
 * （`$defs.diagnostic` 是封闭三字段）。
 */
function diagnosticsOf(value: unknown): Diagnostic[] {
  const rows = Array.isArray(value) ? value : []
  const out: Diagnostic[] = []
  for (const row of rows) {
    const view = recordOf(row)
    out.push({
      code: typeof view.code === 'string' ? view.code : '',
      reason: typeof view.reason === 'string' ? view.reason : '',
      next_step: typeof view.next_step === 'string' ? view.next_step : '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 项目文件读取（宽容但损坏即恢复）
// ---------------------------------------------------------------------------

async function readJsonIfPresent(root: string, relative: string): Promise<unknown> {
  try {
    const text = await readFile(pathsModule.resolveInProject(root, relative), 'utf8')
    if (text.trim().length === 0) return null
    return JSON.parse(text)
  } catch (error) {
    if (thrownCode(error) === 'ENOENT') return null
    return null
  }
}

async function readBinding(root: string, deps: Partial<Deps>): Promise<Record<string, unknown> | null> {
  // `deps.binding` 也可能是注入的 `{ readBinding() }`，按结构取（模块本身没有这个导出）。
  const injected: unknown = deps?.binding
  if (isRecord(injected) && typeof injected.readBinding === 'function') {
    try {
      const record: unknown = await injected.readBinding(root)
      if (isRecord(record)) return record
    } catch {
      // 注入实现失败时退回直接读文件（只读）
    }
  }
  const raw = await readJsonIfPresent(root, BINDING_PATH)
  return isPlainObject(raw) ? raw : null
}

function bindingSnapshot(binding: unknown): BindingSnapshot | null {
  if (!binding) return null
  const view = recordOf(binding)
  return {
    session_id: nonEmpty(view.session_id) ? view.session_id : null,
    team_id: nonEmpty(view.team_id) ? view.team_id : null,
    epoch: typeof view.epoch === 'number' && Number.isInteger(view.epoch) ? view.epoch : null,
  }
}

/**
 * 已注册工具名（从实际执行者取，不猜）。
 *
 * `schemas()` 的返回值形状只在 `capability.toolNamesFromSchemas()` 一处解析：宿主真实形状是
 * **schema 对象数组**（名字在元素的 `.name` 上），对它做 `Object.keys` 只会拿到
 * `["0","1",…]`，真会话里每个能力族都据此判缺失（T15）。
 */
function toolNamesOf(ctx: unknown): string[] {
  const view = recordOf(ctx)
  const tools = recordOf(view.services).tools
  if (isRecord(tools) && typeof tools.schemas === 'function') {
    try {
      return toolNamesFromSchemas(tools.schemas(recordOf(view.exec).agent))
    } catch {
      return []
    }
  }
  return []
}

/** attempt 本地记录（dispatch/attempt → task/member 的恢复关联）。 */
export async function readAttemptRecord(
  root: string,
  dispatchId: unknown,
  attemptId: unknown,
  paths?: PathsModule,
): Promise<Record<string, unknown> | null> {
  const ref = contractDefaults.attemptRefFor(dispatchId, attemptId)
  const absolute = (paths ?? pathsModule).resolveInProject(root, ref)
  try {
    const text = await readFile(absolute, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function listAttemptRecords(root: string): Promise<Record<string, unknown>[]> {
  const dir = pathsModule.resolveInProject(root, contractDefaults.ATTEMPTS_DIR)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records: Record<string, unknown>[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (isPlainObject(parsed) && nonEmpty(parsed.dispatch_id) && nonEmpty(parsed.attempt_id)) records.push(parsed)
    } catch {
      // 损坏的 attempt 记录不参与关联；不要静默当作「没有记录」以外的语义
    }
  }
  return records
}

/** `writeAttemptRecord` 的入参。 */
interface WriteAttemptRecordInput {
  root: string
  atomic: AtomicModule
  paths: PathsModule
  record: Record<string, unknown>
}

async function writeAttemptRecord({ root, atomic, paths, record }: WriteAttemptRecordInput): Promise<string> {
  const ref = contractDefaults.attemptRefFor(record.dispatch_id, record.attempt_id)
  const absolute = typeof paths?.assertSafeWriteTarget === 'function'
    ? await paths.assertSafeWriteTarget(root, ref)
    : pathsModule.resolveInProject(root, ref)
  await atomic.writeJsonAtomic(absolute, record)
  return ref
}

// ---------------------------------------------------------------------------
// 派发决策（纯函数，便于单测与复用）
// ---------------------------------------------------------------------------

/** 名册行里本模块用到的字段（`role`/`name`/`status`）；其余键照旧可按名读。 */
type MemberRow = { role?: unknown; name: string; status?: unknown } & Record<string, unknown>

/** 名册行判定：只要有字符串 `name` 就算一行（其余字段按 `unknown` 读）。 */
function isMemberRow(value: unknown): value is MemberRow {
  return isRecord(value) && typeof value.name === 'string'
}

/** JSON 记录数组：非数组按空处理，数组里的非记录项丢掉（读字段时它们本来也取不到值）。 */
function recordRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** `decideMember` 的入参。 */
interface DecideMemberInput {
  postId: string
  members: unknown
  tasks: unknown
  excludeTaskIds?: readonly string[]
}

/**
 * 选成员：同岗空闲复用；忙碌 `MEMBER_BUSY`；否则用下一个没被用过的名字新建
 * （D12：失败/历史名字永久占用，不重试同名）。
 */
export function decideMember({
  postId,
  members,
  tasks,
  excludeTaskIds = [],
}: DecideMemberInput): MemberDecision {
  const prefix = `rt-${postId}`
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(?:-\\d+)?$`, 'u')
  const rows = recordRows(members)
  // 先按「有字符串 name」收窄，再判角色/名字形状：与原来一串 && 的判据等价。
  const named = rows.filter(isMemberRow)
  const taskRows = recordRows(tasks)
  const candidates = named.filter((member) => member.role === 'teammate' && pattern.test(member.name))
  const usable = candidates.filter((member) => member.status !== 'failed' && member.status !== 'provisioning')
  const busy = (name: string): boolean => taskRows.some((task) => task
    && task.status === 'in_progress'
    && task.owner === name
    && !(typeof task.id === 'string' && excludeTaskIds.includes(task.id)))
  const idle = usable
    .filter((member) => !busy(member.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  if (idle.length > 0) return { action: 'reuse', member: idle[0].name }
  if (usable.length > 0) {
    return {
      action: 'busy',
      members: usable.map((member) => member.name),
      tasks: taskRows.filter((task) => task && task.status === 'in_progress' && usable.some((member) => member.name === task.owner)),
    }
  }

  const taken = new Set(rows.map((member) => member?.name).filter(nonEmpty))
  let index = 1
  let name = prefix
  while (taken.has(name)) {
    index += 1
    name = `${prefix}-${index}`
  }
  return { action: 'spawn', member: name, failedBefore: candidates.map((member) => member.name) }
}

/** 影响报告里的一条待处理项。 */
interface ImpactProblem {
  kind: string
  field: string
  entry: unknown
}

/** 影响报告里与本路线相关的待处理项（open 争议 / 待复查 / 恢复待办）。 */
export function impactProblems(impactJson: unknown, routeId: unknown): ImpactProblem[] {
  const view = recordOf(impactJson)
  const problems: ImpactProblem[] = []
  const belongs = (entry: unknown): boolean => {
    if (!isPlainObject(entry)) return true
    const id = entry.route ?? entry.route_id ?? entry.routeId ?? null
    return id === null || id === routeId
  }
  for (const [field, kind] of [
    ['pending_reviews', 'review'],
    ['dispute_impacts', 'dispute'],
    ['open_disputes', 'dispute'],
    ['recovery_pending', 'recovery'],
    ['blocking_conditions', 'condition'],
    ['condition_conflicts', 'condition'],
  ]) {
    const value = view[field]
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!belongs(entry)) continue
        problems.push({ kind, field, entry })
      }
    } else if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      problems.push({ kind, field, entry: { count: value } })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// 装配完整性
// ---------------------------------------------------------------------------

/** 装配完整性检查通过后的 `deps` 视图：必需模块都在，其余接缝（适配器/clock/fs）仍可能缺席。 */
type AssembledDeps = Partial<Deps> & Required<Pick<Deps,
  'errors' | 'identity' | 'validate' | 'paths' | 'atomic' | 'lock' | 'operation'
  | 'audit' | 'catalog' | 'capability' | 'capacity'>>

/** handler 启动前必须先装好的内核模块（缺一个就是装配错误，不是业务分支）。 */
const REQUIRED_DEPS = [
  'errors', 'identity', 'validate', 'paths', 'atomic', 'lock', 'operation', 'audit',
  'catalog', 'capability', 'capacity',
] as const

/**
 * 装配完整性判定：`REQUIRED_DEPS` 全在才算通过。
 *
 * 判据与迁移前的 `keys.filter((key) => !deps[key]).length > 0` 逐字等价（非空对象即视为存在），
 * 额外的作用是把 `deps` 收窄成 `AssembledDeps`，后续读这些模块时不必再判空。
 */
function hasRequiredDeps(deps: Partial<Deps>, keys: readonly (keyof Deps)[]): deps is AssembledDeps {
  return keys.every((key) => Boolean(deps[key]))
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/**
 * `rt_dispatch` handler。永不 reject；成功返回 `{ envelope }`（`status=ok` 仅当交付完成）。
 *
 * `ctx` 是装配上下文（SEAMS 第 1 节）；`input` 是已通过 `$defs.dispatchInput` 校验的入参
 * （本函数仍做形状兜底）。缺装配时返回最小合法错误信封，不抛。
 */
export async function handleDispatch(ctx: HandlerCtx, input: unknown): Promise<HandlerResult> {
  // 装配骨架可能先建后挂适配器：这里按 `Partial<Deps>` 收，由下面的装配完整性检查统一拒绝，
  // 而不是在这一行假设每个模块都在。
  const deps: Partial<Deps> = ctx?.deps ?? {}
  const envelope = deps.envelope
  const rawOperationId = isPlainObject(input) && typeof input.operation_id === 'string' ? input.operation_id : null
  // 信封的 operation_id 只接受 `$defs.id` 形状；非法入参不能让它抛（fromError 也会经过 assemble）。
  const operationIdRaw = rawOperationId !== null && ID_PATTERN.test(rawOperationId) ? rawOperationId : null
  let persisted = false

  if (!envelope || typeof envelope.ok !== 'function') {
    // 没有信封模块就没有合法的返回形状；抛出会让宿主看到栈，所以给一个最小合法信封。
    return {
      envelope: {
        schema_version: 1,
        status: 'error',
        code: 'RECOVERY_REQUIRED',
        operation_id: null,
        replayed: false,
        retryable: false,
        diagnostics: [{
          code: 'RECOVERY_REQUIRED',
          reason: '装配上下文缺少 deps.envelope，无法构造合法信封',
          next_step: '检查 index.js 的 deps 装配（SEAMS 第 1 节）',
        }],
        data: null,
      },
    }
  }

  try {
    // ---- 0. 装配完整性（缺模块属于装配错误，不能当业务分支） ----
    if (!hasRequiredDeps(deps, REQUIRED_DEPS)) {
      const missingDeps = REQUIRED_DEPS.filter((key) => !deps[key])
      return {
        envelope: errorEnvelope(envelope, {
          code: 'RECOVERY_REQUIRED',
          operationId: operationIdRaw,
          reason: `装配上下文缺少 deps.${missingDeps.join('/deps.')}`,
          nextStep: '按 SEAMS 第 1 节补齐依赖装配（T2 的 index.js）；不要在没有装配的情况下派发',
        }),
      }
    }

    // ---- 1. 身份：只认可信执行上下文 ----
    const caller = await deps.identity.resolveCaller(ctx)
    if (!caller.ok) {
      return {
        envelope: errorEnvelope(envelope, {
          code: caller.code,
          operationId: operationIdRaw,
          diagnostics: [caller.diagnostic],
          reason: caller.diagnostic.reason,
          nextStep: caller.diagnostic.next_step,
        }),
      }
    }
    if (caller.role !== 'lead') {
      return {
        envelope: errorEnvelope(envelope, {
          code: 'ROLE_REQUIRED',
          operationId: operationIdRaw,
          reason: `rt_dispatch 只允许 Team Lead 调用；当前角色 ${caller.role}（${caller.name ?? '未知成员'}）`,
          nextStep: '由本团队 Lead 发起派发；成员只提交结果，不自己派活（入参自报角色一律忽略）',
        }),
      }
    }

    // ---- 2. 入参形状 ----
    const normalized = normalizeDispatchInput(input)
    if (!normalized.ok) {
      return {
        envelope: errorEnvelope(envelope, {
          code: 'INVALID_ARGUMENT',
          operationId: operationIdRaw,
          diagnostics: normalized.issues,
          reason: normalized.issues[0].reason,
          nextStep: normalized.issues[0].next_step,
        }),
      }
    }
    const request = normalized.value
    const operationId = request.operation_id

    // ---- 3. 项目根 ----
    let root: string
    try {
      root = await deps.paths.normalizeProjectRoot(request.project_root)
    } catch (error) {
      return { envelope: envelope.fromError(error, { operationId }) }
    }

    // ---- 4. 台账与输入哈希 ----
    const clock = deps.clock
    const ledger = deps.operation.createOperationLedger({ root, clock })
    const inputHash = deps.validate.operationInputHash(request, {
      tool: 'rt_dispatch',
      action: 'dispatch',
      project: root,
    })

    // 同一 ID 换内容 → OPERATION_CONFLICT（必须先于重放判定：重放不能掩盖内容冲突）
    const existing: OperationRecord | null = await ledger.findById(operationId)
    if (existing !== null && existing.input_hash !== inputHash) {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'OPERATION_CONFLICT',
          operationId,
          phase: existing.phase,
          reason: `同一 operation ID 的输入已改变: ${operationId}（已存阶段 ${existing.phase}）`,
          nextStep: '同一 ID 必须保持原输入；确实换了请求内容时用新的 operation_id，不要改写既有台账',
        }),
      }
    }
    if (existing !== null) {
      const replay = await ledger.replayResult(operationId)
      if (replay) return { envelope: replay }
    }

    const resourcesMod = deps.resources ?? resourceDefaults
    const contractMod = deps.contract ?? contractDefaults
    const atomic = deps.atomic
    const paths = deps.paths
    const projectAdapter = deps.projectAdapter
    const teamAdapter = deps.teamAdapter
    const callerName = caller.name ?? 'lead'
    // T18：容量观测值按会话生效（席位随会话重置），所以这一次调用只认本会话的身份。
    // 与下面锁用的 `sessionId`（binding 里的会话或占位串 `session-unbound`）分开：
    // 占位串不是真实会话 id，绝不能拿它去匹配观测值。
    const capacitySessionId = sessionIdOf(deps, caller.root, ctx)

    if (!projectAdapter) {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'PROJECT_NOT_CONFIGURED',
          operationId,
          reason: '没有可用的 projectAdapter，读不到路线/impact/seal',
          nextStep: '确认项目已按 skill 配置，且 index.js 装配了 projectAdapter',
        }),
      }
    }
    if (!teamAdapter || (typeof teamAdapter.hasService === 'function' && teamAdapter.hasService() === false)) {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'TEAM_SERVICE_UNAVAILABLE',
          operationId,
          reason: '宿主团队服务未挂载（ctx.services.agentTeams 缺席）',
          nextStep: '启用 @deepseek-ai/dsh-experimental-agent-team-profile，或运行 node <bundle-root>/bin/doctor.mjs 查看修复路径',
        }),
      }
    }

    const binding = await readBinding(root, deps)
    const bindingSnap = bindingSnapshot(binding)

    // 恢复：已存台账但团队变了 → 不能在同一 ID 上跨团队续做
    if (existing !== null) {
      const savedTeam = existing?.data?.binding?.team_id ?? null
      if (savedTeam !== null && bindingSnap?.team_id !== undefined && bindingSnap?.team_id !== null
        && savedTeam !== bindingSnap.team_id) {
        return {
          envelope: blockedEnvelope(envelope, {
            code: 'PROJECT_SESSION_MISMATCH',
            operationId,
            phase: existing.phase,
            reason: `operation ${operationId} 属于 team ${savedTeam}，当前绑定是 team ${bindingSnap.team_id}`,
            nextStep: '换回原会话继续该操作，或按 takeover 流程建立新绑定后另发新 operation',
          }),
        }
      }
      if (existing.phase === 'needs_recovery') {
        return {
          envelope: partialEnvelope(envelope, {
            code: 'RECOVERY_REQUIRED',
            operationId,
            phase: 'needs_recovery',
            data: identitiesOf(existing.data),
            reason: `operation ${operationId} 处于 needs_recovery：上一次宿主变更结果未确认`,
            nextStep: '按台账里的身份核对宿主任务板/成员名册，确认后再以同一 operation ID 重入；不要盲目重试',
          }),
        }
      }
    }

    // ---- 5. 派生身份 ----
    let dispatchId: string
    let attemptId: string
    let attemptIndex: number
    let retry: RetryResult | null = null
    const excludeTaskIds: string[] = []
    if (request.retry_of !== null) {
      retry = await resolveRetry({
        root, request, paths, teamAdapter, deps,
      })
      if (!retry.ok) {
        return {
          envelope: retry.status === 'error'
            ? errorEnvelope(envelope, { code: retry.code, operationId, reason: retry.reason, nextStep: retry.next_step })
            : blockedEnvelope(envelope, {
              code: retry.code,
              operationId,
              reason: retry.reason,
              nextStep: retry.next_step,
            }),
        }
      }
      dispatchId = retry.dispatchId
      attemptIndex = retry.attemptIndex
      attemptId = contractMod.attemptIdOf(attemptIndex)
      if (retry.oldTaskId !== null) excludeTaskIds.push(retry.oldTaskId)
    } else {
      dispatchId = contractMod.dispatchIdFor(operationId)
      attemptIndex = 1
      attemptId = contractMod.attemptIdOf(attemptIndex)
    }

    const contractRef = contractMod.contractRefFor(dispatchId, attemptId, attemptIndex)
    const workDir = contractMod.workDirFor(dispatchId, attemptId)
    const runIdReservation = contractMod.runIdReservationFor(dispatchId, attemptId)

    // ---- 6. 前置检查（只读；任一不过 → blocked 且零副作用） ----
    let plan: PreflightPlan | null = null
    if (existing === null) {
      const pre = await preflight({
        ctx, deps, envelope, request, root, dispatchId, attemptId, excludeTaskIds,
        resourcesMod, contractMod, callerName, projectAdapter, teamAdapter, capacitySessionId,
      })
      if (!pre.ok) return { envelope: pre.envelope }
      plan = pre.plan
    }

    // ---- 7. 锁内推进阶段 ----
    // 只用到 `lock.record.owner_nonce`（释放时回传）。
    const sessionId = bindingSnap !== null && nonEmpty(bindingSnap.session_id)
      ? bindingSnap.session_id
      : 'session-unbound'
    let lock: { record?: { owner_nonce?: string } } | undefined
    try {
      lock = await deps.lock.acquire(root, {
        session: sessionId,
        operation: operationId,
        now: typeof clock?.now === 'function' ? clock.now : Date.now,
        ttlMs: null,
      })
    } catch (error) {
      // 抛出物可能不是 Error：按字段读（等价于迁移前的 `error?.code` / `error?.message`）。
      const thrown = recordOf(error)
      const thrownCodeValue = thrown.code
      return { envelope: blockedEnvelope(envelope, {
        code: thrownCodeValue === 'PROJECT_BUSY' ? 'PROJECT_BUSY' : stableCode(thrownCodeValue),
        operationId,
        reason: thrown.message ?? '项目锁不可用',
        nextStep: thrown.nextStep ?? '等当前操作结束；只有核实原进程/Lead 不再写且恢复记录已保存后才显式清理锁',
      }) }
    }

    try {
      const run = await runLocked({
        ctx, deps, envelope, request, root, operationId, inputHash, ledger,
        dispatchId, attemptId, attemptIndex, contractRef, workDir, runIdReservation,
        retry, excludeTaskIds, plan, bindingSnap, callerName, existing,
        resourcesMod, contractMod, atomic, paths, projectAdapter, teamAdapter, capacitySessionId,
        onPersisted: () => { persisted = true },
      })
      return { envelope: run }
    } finally {
      await deps.lock.release(root, { ownerNonce: lock?.record?.owner_nonce }).catch(() => {})
    }
  } catch (error) {
    // 已写台账/已触及宿主 → partial；否则按契约错误映射。
    return {
      envelope: envelope.fromError(error, {
        operationId: operationIdRaw,
        ...(persisted ? { status: 'partial' } : {}),
        ...(persisted && error instanceof ContractError
          ? { data: { phase: 'needs_recovery' } }
          : {}),
      }),
    }
  }
}

/**
 * 本会话身份（T18）：`TeamId` = 团队根 Session id = Lead 会话 id，席位随会话重置。
 *
 * 与 `rt_roster` 同一条推导（`binding.sessionIdentityFrom`），只读可信执行上下文
 * （`identity.root` + `exec`/`config` 的显式会话字段）。拿不到就是 `null`：
 * 那时任何观测值都**不得**套用，也无法把新观测值归到某个会话上。
 */
function sessionIdOf(deps: Partial<Deps>, callerRoot: string | null, ctx: HandlerCtx): string | null {
  const injected = recordOf(deps.binding)
  const derive = typeof injected.sessionIdentityFrom === 'function'
    ? injected.sessionIdentityFrom
    : bindingModule.sessionIdentityFrom
  const derived: unknown = derive({
    identity: { role: 'lead', name: null, root: callerRoot },
    exec: recordOf(ctx).exec,
    config: recordOf(ctx).config,
  })
  const value = recordOf(derived).session_id
  return nonEmpty(value) ? value : null
}

/** 从台账 `data` 里挑出已知身份（缺席的键不写）。 */
function identitiesOf(data: unknown): Record<string, unknown> {
  const view = recordOf(data)
  const out: Record<string, unknown> = {}
  if (nonEmpty(view.dispatch_id)) out.dispatch_id = view.dispatch_id
  if (nonEmpty(view.attempt_id)) out.attempt_id = view.attempt_id
  if (nonEmpty(view.task_id)) out.task_id = view.task_id
  if (nonEmpty(view.member)) out.member = view.member
  if (nonEmpty(view.route_id)) out.route_id = view.route_id
  if (nonEmpty(view.contract_ref)) out.contract_ref = view.contract_ref
  if (nonEmpty(view.work_dir)) out.work_dir = view.work_dir
  return out
}

// ---------------------------------------------------------------------------
// retry_of
// ---------------------------------------------------------------------------

async function readContractFile(root: string, ref: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(pathsModule.resolveInProject(root, ref), 'utf8')
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 核查 `retry_of`：必须引用**当前**旧 attempt 与真实恢复记录，且旧 dispatch 尚未收口、
 * 问题/路线/目标未改变。通过后先撤销旧 attempt 的提交资格，再返回新 attempt 身份。
 */
async function resolveRetry({
  root,
  request,
  paths,
  teamAdapter,
  deps,
}: ResolveRetryParams): Promise<RetryResult> {
  const retryView = recordOf(request.retry_of)
  // 形状已由 `normalizeDispatchInput` 校验过；`String()` 对字符串是恒等变换。
  const oldDispatchId = String(retryView.dispatch_id)
  const oldAttemptId = String(retryView.attempt_id)
  const recoveryRef = retryView.recovery_ref

  let recoveryPath: string
  try {
    recoveryPath = paths.assertProjectRelative(recoveryRef)
  } catch (error) {
    return { ok: false, status: 'error', code: 'PATH_INVALID', reason: `retry_of.recovery_ref 不合法：${thrownMessage(error)}`, next_step: '传项目内相对路径的恢复核查记录' }
  }
  const recoveryAbsolute = paths.resolveInProject(root, recoveryPath)
  let recoveryInfo: Awaited<ReturnType<typeof import('node:fs/promises').stat>> | null = null
  try {
    const { stat } = await import('node:fs/promises')
    recoveryInfo = await stat(recoveryAbsolute)
  } catch {
    recoveryInfo = null
  }
  if (!recoveryInfo || !recoveryInfo.isFile() || recoveryInfo.size === 0) {
    return {
      ok: false,
      code: 'RECOVERY_REQUIRED',
      reason: `retry_of.recovery_ref 指向的恢复记录不存在或为空: ${recoveryPath}`,
      next_step: '先核实旧成员/后台任务/资源实际状态并保存真实恢复记录，再重试；没有核查记录不能重开',
    }
  }

  const oldAttemptIndex = Number.parseInt(oldAttemptId.slice(2), 10)
  const oldContractRef = contractDefaults.contractRefFor(oldDispatchId, oldAttemptId, oldAttemptIndex)
  const oldContract = await readContractFile(root, oldContractRef)
  if (oldContract === null) {
    return {
      ok: false,
      code: 'STALE_ATTEMPT',
      reason: `引用不到旧 attempt 的契约 ${oldContractRef}`,
      next_step: 'retry_of 必须引用当前旧 attempt 的契约；问题已变或已收口时另发新 dispatch',
    }
  }
  const record = await readAttemptRecord(root, oldDispatchId, oldAttemptId, paths)
  if (record === null) {
    return {
      ok: false,
      code: 'STALE_ATTEMPT',
      reason: `引用不到旧 attempt 的本地记录 ${contractDefaults.attemptRefFor(oldDispatchId, oldAttemptId)}`,
      next_step: '只恢复有真实本地记录的当前尝试；其它情况另发新 dispatch',
    }
  }
  if (record.revoked) {
    return {
      ok: false,
      code: 'STALE_ATTEMPT',
      reason: `旧 attempt ${oldDispatchId}/${oldAttemptId} 已撤销，不能重复恢复`,
      next_step: '引用最新的 attempt；已撤销的尝试只入历史',
    }
  }

  const oldTaskId = nonEmpty(record.task_id) ? record.task_id : null
  if (oldTaskId !== null) {
    const task = recordOf(await teamAdapter.getTask(oldTaskId))
    // 成功分支才带任务视图；读不到任务（`null`）按「未收口」处理，与原来的判据一致。
    const taskView = recordOf(task.task)
    if (task.ok === true && (taskView.status === 'completed' || taskView.status === 'deleted')) {
      return {
        ok: false,
        code: 'STALE_ATTEMPT',
        reason: `旧 dispatch 的任务 ${oldTaskId} 已是 ${taskView.status}，不能重开宿主已完成/删除的任务`,
        next_step: '另发新 dispatch（新 operation_id）；已收口的尝试只入历史',
      }
    }
  }

  const oldTargets = Array.isArray(oldContract.targets)
    ? oldContract.targets
      .map((target) => (typeof target === 'string' ? target : (isRecord(target) ? target.id : undefined)))
      .filter(nonEmpty)
      .sort()
    : []
  const newTargets = [...request.target_ids].sort()
  const oldRouteView = recordOf(oldContract.route)
  const oldPostView = recordOf(oldContract.post)
  const oldRouteId = oldContract.route_id ?? oldRouteView.id ?? oldRouteView.route_id ?? null
  const oldPostId = oldContract.post_id ?? oldPostView.id ?? null
  const oldObjective = oldContract.objective ?? null
  const changed: string[] = []
  if (oldRouteId !== request.route_id) changed.push('route_id')
  if (oldPostId !== request.post_id) changed.push('post_id')
  if (oldObjective !== request.objective) changed.push('objective')
  if (JSON.stringify(oldTargets) !== JSON.stringify(newTargets)) changed.push('target_ids')
  if (changed.length > 0) {
    return {
      ok: false,
      code: 'STALE_ATTEMPT',
      reason: `retry_of 只能恢复同一个问题；这些字段与原契约不一致：${changed.join(', ')}`,
      next_step: '问题/路线/目标变了就另发新 dispatch，不要重开旧尝试',
    }
  }

  const attemptIndex = oldAttemptIndex + 1
  const newAttemptId = contractDefaults.attemptIdOf(attemptIndex)
  const clock = deps?.clock
  const nowIso = (): string => (typeof clock?.isoNow === 'function' ? clock.isoNow() : new Date().toISOString())
  const revoked = {
    ...record,
    phase: 'revoked',
    updated_at: nowIso(),
    revoked: {
      at: nowIso(),
      recovery_ref: recoveryPath,
      reason: 'retry_superseded',
      superseded_by: { operation_id: request.operation_id, attempt_id: newAttemptId },
    },
  }
  await writeAttemptRecord({ root, atomic: deps.atomic, paths, record: revoked })

  return {
    ok: true,
    dispatchId: oldDispatchId,
    attemptIndex,
    attemptId: newAttemptId,
    recoveryRef: recoveryPath,
    oldTaskId,
    oldAttemptId,
    oldContractRef,
    objective: oldObjective,
    routeId: oldRouteId,
    postId: oldPostId,
    targetIds: oldTargets,
  }
}

// ---------------------------------------------------------------------------
// 前置检查
// ---------------------------------------------------------------------------

/**
 * 门 1 的兼容性探测 → 契约要冻结的三个内容摘要。
 *
 * 走**项目适配器**的 `probe()`（与收口侧 `checkPremises` 复核用的是同一个入口），所以两边看到的是
 * 同一份「项目副本指纹」：适配器换实现（替身/未来布局）时两侧仍然自洽，不会因为一边读模块、
 * 一边读适配器而必然不一致。`probe()` 内部已经算过 `computeDigests()`，这里只取结果，**不重复跑
 * Python**。摘要缺项（例如项目副本没有 `SKILL.md`）时按失败处理：冻结不了规则版本就不该派发，
 * 否则契约一落地就注定收不了口。
 */
async function readFrozenDigests(projectAdapter: ProjectAdapterLike, root: string): Promise<FrozenDigestsRead> {
  const probe = recordOf(await projectAdapter.probe({ projectRoot: root }))
  const compatibility = recordOf(probe.compatibility)
  const ruleDigest = typeof compatibility.ruleDigest === 'string' ? compatibility.ruleDigest : null
  const scriptDigest = typeof compatibility.scriptDigest === 'string' ? compatibility.scriptDigest : null
  const catalogDigest = typeof compatibility.catalogDigest === 'string' ? compatibility.catalogDigest : null
  if (probe.ok !== true) {
    return {
      ok: false,
      code: stableCode(probe.code ?? 'PROJECT_NOT_CONFIGURED'),
      reason: `项目兼容性探测失败，无法冻结规则版本：${probe.reason ?? probe.code ?? 'unknown'}`,
      nextStep: '先按 rt_roster 的接入检查确认项目副本完整（INDEX/配置/SKILL.md/references/team-coordination.md），再派发',
    }
  }
  if (ruleDigest === null) {
    return {
      ok: false,
      code: 'SKILL_INCOMPATIBLE',
      reason: '项目副本没有可冻结的规则摘要（SKILL.md 与 references/assets 的 Markdown 都读不到）',
      nextStep: '先按 rt_roster 的接入检查确认项目内 skill 副本完整；没有规则可冻结时不能派发（收口会无法核对规则版本）',
    }
  }
  return { ok: true, digests: { ruleDigest, scriptDigest, catalogDigest } }
}

// ---------------------------------------------------------------------------
// T17：冻结「所依赖的既有已封存产物的身份」
//
// 编排契约「锚点与封存绑定」要求派发前冻结三类东西：目标字节、相关既有 seal 的路径与字节，
// **以及所依赖产物的身份**。第三类以前从来没被填过（`baseline.artifacts` 恒为 `[]`），于是
// 「已封存产物被篡改」在收口侧没有任何比对能发现它 —— 只能等最后一步 `check --hashes`，
// 而那时路线已回写、INDEX 已刷新。这里就是那第三类的事实来源。
//
// 「依赖的 RUN」的判据（**路线域**，不是全项目）：
//   1. `route.dependency_runs` —— 插件扩展的显式依赖；
//   2. `route.evidence` —— skill 里路线自己登记的 RUN；
//   3. 本路线**自己**在该目标上已封存的 RUN —— 「目标已有 seal」背后的既有证据。
// 只冻结**已封存**的：未封存 RUN 的产物还不是不可变事实（封存前允许补正），冻它会让基准
// 无谓失效。也**不**扫别的路线的 RUN：契约要求「其他路线正常新增 seal 不使旧快照失效」。
// ---------------------------------------------------------------------------

/** 路线记录里声明的 RUN 引用（`dependency_runs` / `evidence` 都按未知形状读）。 */
function declaredRunIds(route: RouteRecord): string[] {
  const ids: string[] = []
  const lists: unknown[] = [route.dependency_runs, route.evidence]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    const values: unknown[] = list
    for (const value of values) {
      if (typeof value !== 'string') continue
      const id = value.trim()
      if (!RUN_ID.test(id) || ids.includes(id)) continue
      ids.push(id)
    }
  }
  return ids
}

/** 当前 seal 清单里的 RUN 封存（只认 `re/seals/runs/<RUN>.json`）。 */
function sealedRunIds(seals: unknown): string[] {
  const ids: string[] = []
  const list: unknown[] = Array.isArray(seals) ? seals : []
  for (const seal of list) {
    const sealPath = recordOf(seal).path
    if (typeof sealPath !== 'string') continue
    const matched = RUN_SEAL_PATH.exec(sealPath)
    if (matched === null || ids.includes(matched[1])) continue
    ids.push(matched[1])
  }
  return ids
}

/** RUN 记录声明的目标 ID（`target.id` 与 `target_ids` 两种写法都认）。 */
function runTargetIds(run: unknown): string[] {
  const view = recordOf(run)
  const ids: string[] = []
  const target = recordOf(view.target)
  if (typeof target.id === 'string' && target.id.length > 0) ids.push(target.id)
  if (Array.isArray(view.target_ids)) {
    const values: unknown[] = view.target_ids
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) ids.push(value)
    }
  }
  return ids
}

/** `dependedSealedRunIds()` 的入参：全是从已读记录投影出来的纯数据。 */
interface DependedRunInput {
  routeId: string
  /** 路线声明的 RUN（`dependency_runs` ∪ `evidence`）。 */
  declared: readonly string[]
  /** 当前 seal 清单里的 RUN 封存。 */
  sealed: readonly string[]
  targetIds: readonly string[]
  /** 已读到的 RUN 记录（只含已封存的，按 `run_id` 索引）。 */
  runs: ReadonlyArray<{ run_id: string, record: unknown }>
}

/**
 * 纯决策：本次派发真正要冻结的**已封存 RUN**。
 *
 * 只读已读到的记录，不做 I/O；`runs` 里没有的 RUN 一律当作「不冻结」（未封存/读不到）。
 */
export function dependedSealedRunIds(input: DependedRunInput): string[] {
  const sealed = new Set<string>(input.sealed)
  const declared = new Set<string>(input.declared)
  const targets = new Set<string>(input.targetIds)
  const picked: string[] = []
  for (const run of input.runs) {
    if (!sealed.has(run.run_id)) continue
    const isDeclared = declared.has(run.run_id)
    const belongsHere = recordOf(run.record).route_id === input.routeId
      && runTargetIds(run.record).some((targetId) => targets.has(targetId))
    if (!isDeclared && !belongsHere) continue
    picked.push(run.run_id)
  }
  return picked
}

/** 依赖产物身份的读取结果。 */
type DependentArtifactsRead =
  | { ok: true, artifacts: Array<{ path: string, sha256: string }> }
  | { ok: false, code: string, reason: string, nextStep: string }

/**
 * 读「本次派发依赖的既有已封存 RUN」，把它们 `run.json` 里声明的产物身份收成
 * `[{path, sha256}]`（`captureBaseline()` 的 `artifacts` 入参）。
 *
 * 失败一律 fail-closed：读不到 seal 清单、或**路线声明的**依赖 RUN 已封存但 `run.json`
 * 读不到/产物登记残缺 → 不能假装「没有依赖产物」，否则快照会静默少冻一项。
 */
async function dependentArtifacts(input: {
  projectAdapter: ProjectAdapterLike
  route: RouteRecord
  targetIds: readonly string[]
}): Promise<DependentArtifactsRead> {
  const declared = declaredRunIds(input.route)
  const sealsRead = recordOf(await input.projectAdapter.readSeals())
  if (sealsRead.ok !== true) {
    return {
      ok: false,
      code: 'RECOVERY_REQUIRED',
      reason: `读不了既有 seal 清单，无法判断哪些已封存 RUN 是本派发的依赖：${sealsRead.reason ?? sealsRead.code ?? 'unknown'}`,
      nextStep: '确认 re/seals 可读后再派发；读失败不能当作没有封存',
    }
  }
  const sealed = sealedRunIds(sealsRead.seals)
  const declaredSet = new Set<string>(declared)
  const runs: Array<{ run_id: string, record: unknown }> = []
  for (const runId of sealed) {
    const read = recordOf(await input.projectAdapter.readRun(runId))
    if (read.ok !== true) {
      if (!declaredSet.has(runId)) continue
      return {
        ok: false,
        code: 'RECOVERY_REQUIRED',
        reason: `路线声明的依赖 RUN ${runId} 已封存，但它的 run.json 读不到（${read.reason ?? read.code ?? 'unknown'}）：冻结不了产物身份`,
        nextStep: '按恢复流程核对 re/runs/<RUN>/run.json 后重新派发；不能把「读不到」当作「没有产物」',
      }
    }
    runs.push({ run_id: runId, record: read.run })
  }

  const runIds = dependedSealedRunIds({
    routeId: typeof input.route.id === 'string' ? input.route.id : '',
    declared,
    sealed,
    targetIds: input.targetIds,
    runs,
  })
  const artifacts: Array<{ path: string, sha256: string }> = []
  const seen = new Set<string>()
  for (const runId of runIds) {
    const record = runs.find((entry) => entry.run_id === runId)?.record
    const declaredArtifacts: unknown = recordOf(record).artifacts
    const listed: unknown[] = Array.isArray(declaredArtifacts) ? declaredArtifacts : []
    for (const entry of listed) {
      const artifact = recordOf(entry)
      const artifactPath = artifact.path
      const sha256Value = artifact.sha256
      if (typeof artifactPath !== 'string' || artifactPath.length === 0 || typeof sha256Value !== 'string') {
        return {
          ok: false,
          code: 'RECOVERY_REQUIRED',
          reason: `已封存 RUN ${runId} 的 run.json 里有一条产物没有 path/sha256：${JSON.stringify(entry).slice(0, 200)}`,
          nextStep: '按 skill 补全该 RUN 的产物登记（path + 字节 SHA256）后重新派发；不完整的清单不能当作产物身份',
        }
      }
      const key = `${artifactPath}\u0000${sha256Value}`
      if (seen.has(key)) continue
      seen.add(key)
      artifacts.push({ path: artifactPath, sha256: sha256Value })
    }
  }
  artifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { ok: true, artifacts }
}

async function preflight({
  ctx,
  deps,
  envelope,
  request,
  root,
  dispatchId,
  attemptId,
  excludeTaskIds,
  resourcesMod,
  contractMod,
  callerName,
  projectAdapter,
  teamAdapter,
  capacitySessionId,
}: PreflightParams): Promise<PreflightResult> {
  const def = (code: string, reason: string, nextStep: string): { code: string; reason: string; nextStep: string } => ({ code, reason, nextStep })

  // (1) 路线 + impact
  const routeRead = recordOf(await projectAdapter.readRoute(request.route_id))
  if (routeRead.ok !== true) {
    const code = stableCode(routeRead.code ?? 'PROJECT_NOT_CONFIGURED')
    const unbound = projectAdapter?.projectRoot === undefined
      ? '（projectAdapter 未绑定 projectRoot：这是装配问题，不是项目记录问题——检查 index.js 是否按本次调用的 project_root 装配了项目适配器）'
      : ''
    return {
      ok: false,
      envelope: blockedEnvelope(envelope, {
        code,
        operationId: request.operation_id,
        reason: `读不到路线 ${request.route_id}：${routeRead.reason ?? 'projectAdapter.readRoute 失败'}${unbound}`,
        nextStep: '先按项目 skill 建立该路线（问题/判据/预算/目标），再派发；工具不接受自由形状的路线草稿',
      }),
    }
  }
  // 路线记录按字段读（`RouteRecord` 就是 `Record<string, unknown>`）；非对象按空记录处理。
  const route = recordOf(routeRead.route)
  const routeId = typeof route.id === 'string' ? route.id : route.route_id
  if (routeId !== request.route_id) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: 'PROJECT_NOT_CONFIGURED',
        operationId: request.operation_id,
        reason: `读取到的路线记录 id=${JSON.stringify(routeId)} 与请求的 route_id=${request.route_id} 不一致`,
        nextStep: '核对 re/routes 下的路线文件；不要在错的记录上派发',
      }),
    }
  }
  const classified = contractMod.classifyRoute(route)
  if (!classified.dispatchable) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: classified.code,
        operationId: request.operation_id,
        reason: classified.reason,
        nextStep: classified.next_step,
      }),
    }
  }
  const routeTargets = contractMod.routeTargetIds(route)
  const outside = request.target_ids.filter((id) => !routeTargets.includes(id))
  if (outside.length > 0) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: 'PROJECT_NOT_CONFIGURED',
        operationId: request.operation_id,
        reason: `target_ids 必须是路线 ${request.route_id} 目标集合的子集；这些目标不在路线里：${outside.join(', ')}（路线目标：${routeTargets.join(', ')}）`,
        nextStep: '先在项目 skill 里把额外目标建进路线（或新建路线），再重新派发',
      }),
    }
  }

  const impact = recordOf(await projectAdapter.impact())
  if (impact.ok !== true) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(impact.code ?? 'CHECK_FAILED'),
        operationId: request.operation_id,
        reason: `读不到 impact：${impact.reason ?? impact.stderr ?? 'projectAdapter.impact 失败'}`,
        nextStep: '先修好项目记录/脚本（stderr 保留原文），再派发；不要跳过 impact 校验',
      }),
    }
  }
  const problems = impactProblems(impact.json, request.route_id)
  if (problems.length > 0) {
    const recoveryLike = problems.find((problem) => problem.kind === 'recovery')
    const code = recoveryLike ? 'RECOVERY_REQUIRED' : 'CHECK_FAILED'
    return {
      envelope: blockedEnvelope(envelope, {
        code,
        operationId: request.operation_id,
        reason: `路线 ${request.route_id} 有未处置的 ${problems.map((problem) => problem.field).join(', ')}：${problems
          .map((problem) => JSON.stringify(problem.entry).slice(0, 200))
          .join('；')}`,
        nextStep: recoveryLike
          ? '先按 skill 完成恢复待办（真实副作用、资源、旧成员核查），再派发；v0 不建等待队列'
          : '先按 skill 处置 open 争议/待复查/条件变更并记录原因，再派发',
      }),
    }
  }

  // (2) 路线依赖必须都是有效 validated
  const dependsOnRoutes = Array.isArray(route.depends_on) ? route.depends_on.filter(nonEmpty) : []
  for (const depId of dependsOnRoutes) {
    const dep = recordOf(await projectAdapter.readRoute(depId))
    if (dep.ok !== true) {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'DEPENDENCY_BLOCKED',
          operationId: request.operation_id,
          reason: `路线 ${request.route_id} 依赖的路线 ${depId} 读不到`,
          nextStep: `先按 skill 修正路线 ${depId} 的记录，或去掉错误的 depends_on`,
        }),
      }
    }
    const depRoute = recordOf(dep.route)
    if (depRoute.status !== 'validated') {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'DEPENDENCY_BLOCKED',
          operationId: request.operation_id,
          reason: `路线 ${request.route_id} 依赖的路线 ${depId} 状态是 ${JSON.stringify(depRoute.status)}，不是 validated`,
          nextStep: `先按 skill 把路线 ${depId} 做到有效 validated（或显式调整依赖），再派发`,
        }),
      }
    }
  }

  // 岗位目录
  const catalog = deps.catalog?.defaultCatalog ? deps.catalog.defaultCatalog() : null
  const post = catalog && deps.catalog.findPost ? deps.catalog.findPost(request.post_id, catalog) : null
  if (post === null) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: 'POST_DISABLED',
        operationId: request.operation_id,
        reason: `岗位 ${request.post_id} 不在岗位目录里`,
        nextStep: '用 rt_roster 查看可用岗位，或按目录里的 post_id 重新派发',
      }),
    }
  }
  if (post.enabled === false) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: 'POST_DISABLED',
        operationId: request.operation_id,
        reason: `岗位 ${request.post_id} 在目录中为 disabled${post.disabled_reason ? `：${post.disabled_reason}` : ''}`,
        nextStep: '改用已启用岗位；不要为未实现能力建岗',
      }),
    }
  }

  // (3) 能力：岗位 required ∪ 任务 capability_needs（只追加）
  const requirements = contractMod.mergeRequirements(post, request)
  const inventory = await readJsonIfPresent(root, TOOL_INVENTORY_PATH)
  const capabilityBindings = await readJsonIfPresent(root, CAPABILITY_BINDINGS_PATH)
  const toolNames = toolNamesOf(ctx)
  const match: CapabilityMatchResult = deps.capability.matchCapabilities(
    requirements.capability_needs,
    toolNames,
    inventory,
    capabilityBindings,
  )
  if (match.missing.length > 0) {
    const codes = match.missing.map((entry) => stableCode(entry.code))
    const code = codes.includes('CAPABILITY_NOT_READY')
      ? 'CAPABILITY_NOT_READY'
      : (codes.includes('UNKNOWN_CAPABILITY') ? 'UNKNOWN_CAPABILITY' : 'CAPABILITY_MISSING')
    return {
      envelope: blockedEnvelope(envelope, {
        code,
        operationId: request.operation_id,
        reason: `岗位 ${post.id} + 任务要求的必需能力无法满足：${match.missing.map((entry) => `${entry.capability}（${entry.reason}）`).join('；')}`,
        nextStep: match.missing[0].next_step,
        diagnostics: match.missing.map((entry) => envelope.diagnostic(
          stableCode(entry.code),
          `能力族 ${entry.capability}：${entry.reason}`,
          entry.next_step,
        )),
      }),
    }
  }

  // (4) 预算 / 成员 / 依赖任务
  const capacity = recordOf(await teamAdapter.capacity())
  if (capacity.ok !== true) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(capacity.code ?? 'TEAM_SERVICE_UNAVAILABLE'),
        operationId: request.operation_id,
        reason: `拿不到容量信息：${capacity.reason ?? 'teamAdapter.capacity() 失败'}`,
        nextStep: '先修好团队服务/身份；不要靠 spawn 试探余额（会烧名字与席位）',
      }),
    }
  }
  // `listMembers` 的形参是「可选 agent」：显式传 `undefined` 与不传等价（适配器内部再回落）。
  const members = recordOf(await teamAdapter.listMembers(undefined))
  if (members.ok !== true) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(members.code ?? 'TEAM_SERVICE_UNAVAILABLE'),
        operationId: request.operation_id,
        reason: `读不到成员名册：${members.reason ?? 'teamAdapter.listMembers() 失败'}`,
        nextStep: '先修好团队服务，再派发',
      }),
    }
  }
  const tasks = recordOf(await teamAdapter.listTasks())
  if (tasks.ok !== true) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(tasks.code ?? 'TEAM_SERVICE_UNAVAILABLE'),
        operationId: request.operation_id,
        reason: `读不到任务板：${tasks.reason ?? 'teamAdapter.listTasks() 失败'}`,
        nextStep: '先修好团队服务，再派发',
      }),
    }
  }
  const taskRows = recordRows(tasks.tasks)

  const memberDecision = decideMember({
    // 岗位 ID 来自目录条目：`decideMember` 只在 `rt-<post_id>` 名字模板里用它（模板本来就是 String）。
    postId: String(post.id),
    members: members.members,
    tasks: tasks.tasks,
    excludeTaskIds,
  })
  if (memberDecision.action === 'busy') {
    return {
      envelope: blockedEnvelope(envelope, {
        code: 'MEMBER_BUSY',
        operationId: request.operation_id,
        reason: `岗位 ${post.id} 的成员 ${memberDecision.members.join(', ')} 都有未收口任务（同一成员最多一个）`,
        nextStep: '先等该成员的任务收口（rt_conclude）或改派；v0 不排队、不抢占',
      }),
    }
  }

  // (4b) T18：生效容量 = 按调用 > 项目 > profile > 本会话观测 > unknown。
  // 适配器（D1）只回答「有没有声明」；这里再叠加「本次调用」与「本会话观测」。
  const observedRead = await capacitySource.readObservedCapacity(root, capacitySessionId)
  const effective: EffectiveCapacity = capacitySource.resolveCapacity({
    call: request.capacity ?? null,
    declared: capacity,
    observed: observedRead,
  })
  const capacityUnknown = effective.source === 'unknown'
  const capacityDiagnostics = capacityGapsToDiagnostics(effective.gaps)
  if (capacityUnknown) {
    // 并发保护（T18 §3）：无已知容量 + 已有「观测中」标记 → 明确拒绝，而不是一起冲。
    const guard = capacitySource.capacityMarkerGuard(await capacitySource.readObservationMarker(root), capacitySessionId)
    if (guard.blocked) {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'CAPACITY_UNKNOWN',
          operationId: request.operation_id,
          reason: guard.reason ?? '容量仍在观测中：拒绝再撞一次',
          nextStep: guard.next_step ?? '等这次观测结束再派发',
        }),
      }
    }
    if (guard.reason !== null) {
      // 标记属于别的会话：不挡，但要如实报告（不能静默丢一条事实）。
      capacityDiagnostics.push(envelope.diagnostic(
        'CAPACITY_OBSERVING_OTHER_SESSION',
        guard.reason,
        guard.next_step ?? '确认旧会话的那次派发已结束即可',
      ))
    }
    // 容量未声明**不再拒绝**：照派，但必须把「不保证有位置、最多损失一个名字与席位」说清楚。
    capacityDiagnostics.push(undeclaredCapacityWarning(
      effective.memberSlots.used,
      observedRead.gap?.detail ?? null,
    ))
  }

  const planBudget = planBudgetOf(deps.capacity)
  // 容量未知时**不做预算裁剪**：没有上限就没有可裁剪的对象，猜一个数才是 D1 明令禁止的事。
  const budget: BudgetPlan = capacityUnknown ? { assigned: [{ post_id: post.id }], gaps: [] } : planBudget({
    candidates: [{
      post_id: post.id,
      priority: post.priority,
      required: post.required,
      optional: post.optional,
      anchors_required: post.anchors_required,
      // `disabled` 已在上面早返回里拒绝过；`planBudget` 只按 `enabled === false` 判禁用，
      // 所以原值透传与原来的 `!== false` 分类一致（`undefined` 仍是「已启用」）。
      enabled: post.enabled,
      capability: { satisfied: true, missing: [] },
    }],
    remainingMemberSlots: effective.memberSlots.remaining,
    remainingActivations: effective.activations.known === true ? effective.activations.total : null,
    reuseCandidates: memberDecision.action === 'reuse'
      ? [{ post_id: post.id, member: memberDecision.member, activation_increment: 1 }]
      : [],
    maxPosts: 1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  })
  const planned = capacityUnknown
    ? { post_id: post.id }
    : budget.assigned.find((entry) => entry.post_id === post.id)
  if (!planned) {
    // 与迁移前的 `['CAPACITY_UNKNOWN','CAPACITY_EXHAUSTED'].includes(entry.code)` 等价。
    const gap = budget.gaps.find((entry) => entry.code === 'CAPACITY_UNKNOWN' || entry.code === 'CAPACITY_EXHAUSTED')
      ?? budget.gaps[0]
    const code = gap?.code === 'CAPACITY_EXHAUSTED' ? 'CAPACITY_EXHAUSTED' : 'CAPACITY_UNKNOWN'
    return {
      envelope: blockedEnvelope(envelope, {
        code,
        operationId: request.operation_id,
        reason: gap?.reason ?? `岗位 ${post.id} 不在当前预算内`,
        nextStep: gap?.next_step ?? '在 re/team/capacity.json 声明容量，或释放已有成员/activation 后重试',
      }),
    }
  }

  // depends_on_tasks → blockedBy：必须已存在且已完成，且只在当前绑定的 team/session 解析
  const currentTeamId = bindingSnapshot(await readBinding(root, deps))?.team_id ?? null
  for (const taskId of request.depends_on_tasks) {
    const existingTask = taskRows.find((task) => task.id === taskId)
    if (!existingTask) {
      const foreign = (await listAttemptRecords(root)).find((record) => record.task_id === taskId)
      const foreignBinding = recordOf(foreign?.binding)
      if (foreign && nonEmpty(foreignBinding.team_id)
        && (currentTeamId === null || foreignBinding.team_id !== currentTeamId)) {
        return {
          envelope: blockedEnvelope(envelope, {
            code: 'PROJECT_SESSION_MISMATCH',
            reason: `依赖任务 ${taskId} 属于 team ${foreignBinding.team_id}，当前绑定是 ${currentTeamId ?? '未绑定'}；跨团队任务 ID 不解析`,
            operationId: request.operation_id,
            nextStep: '只用当前绑定 team/session 的任务 ID；跨团队引用请由对应 Lead 自己派发',
          }),
        }
      }
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'DEPENDENCY_BLOCKED',
          operationId: request.operation_id,
          reason: `依赖任务 ${taskId} 在当前团队任务板里不存在`,
          nextStep: '先建好 blocker 任务并完成它，或在依赖里去掉这个 ID；v0 不建等待队列',
        }),
      }
    }
    if (existingTask.status !== 'completed') {
      return {
        envelope: blockedEnvelope(envelope, {
          code: 'DEPENDENCY_BLOCKED',
          operationId: request.operation_id,
          reason: `依赖任务 ${taskId} 的状态是 ${existingTask.status}，未完成`,
          nextStep: `先收口任务 ${taskId}（Lead 调 rt_conclude），再派发本次任务`,
        }),
      }
    }
  }

  // (5) 资源（只读检查；真正租用在锁内）
  const needsNormalized = resourcesMod.normalizeResourceNeeds(request.resource_needs)
  if (!needsNormalized.ok) {
    return {
      ok: false,
      envelope: errorEnvelope(envelope, {
        code: 'INVALID_ARGUMENT',
        operationId: request.operation_id,
        diagnostics: needsNormalized.issues
          .map((issue: ResourceIssue) => envelope.diagnostic(issue.code, issue.reason, issue.next_step)),
        reason: needsNormalized.issues[0].reason,
        nextStep: needsNormalized.issues[0].next_step,
      }),
    }
  }
  // 注册表形状由 `resources` 模块决定（本模块只透传）；用它的返回类型，不在这里猜。
  let registry: Awaited<ReturnType<ResourcesModule['readRegistry']>>
  try {
    registry = await resourcesMod.readRegistry(root)
  } catch (error) {
    // 抛出物可能不是 Error：按字段读（等价于迁移前的 `error?.code` / `error?.message`）。
    const thrown = recordOf(error)
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(thrown.code),
        operationId: request.operation_id,
        reason: thrown.message ?? '读不到资源记录',
        nextStep: thrown.nextStep ?? '按恢复流程核对资源归属后重试',
      }),
    }
  }
  const resourcePlan = recordOf(resourcesMod.planReservations({
    registry,
    needs: needsNormalized.needs,
    dispatchId,
    attemptId,
    now: typeof deps.clock?.isoNow === 'function' ? deps.clock.isoNow() : new Date().toISOString(),
  }))
  if (resourcePlan.ok !== true) {
    const resourceDiagnostics = diagnosticsOf(resourcePlan.diagnostics)
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(resourcePlan.code),
        operationId: request.operation_id,
        diagnostics: resourceDiagnostics,
        reason: resourceDiagnostics[0]?.reason ?? '资源无法租用',
        nextStep: resourceDiagnostics[0]?.next_step ?? '核对资源归属后以同一 operation ID 重入',
      }),
    }
  }

  // (6) 规则版本：契约必须冻结派发当时的副本摘要，收口侧才有东西可比对（D8）。
  // 放在 baseline 冻结之前：探测失败时不要先落下 `re/team/baselines/<dispatch>.json`。
  const frozen = await readFrozenDigests(projectAdapter, root)
  if (!frozen.ok) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: frozen.code,
        operationId: request.operation_id,
        reason: frozen.reason,
        nextStep: frozen.nextStep,
      }),
    }
  }

  // (7) 依赖产物身份（T17）：契约要求冻结「所依赖的既有已封存产物」，收口才能在写盘前比对。
  // 只读；失败一律 blocked（此时还没有任何 `re/team/` 正式产物）。
  const depended = await dependentArtifacts({ projectAdapter, route, targetIds: request.target_ids })
  if (depended.ok !== true) {
    return {
      envelope: blockedEnvelope(envelope, {
        code: depended.code,
        operationId: request.operation_id,
        reason: depended.reason,
        nextStep: depended.nextStep,
      }),
    }
  }

  // baseline：真实目标字节哈希 + 相关既有 seal + 所依赖产物的身份。
  //
  // **装配接缝（T12）**：`deps.baseline` 是 T7 的 `src/baseline.mjs`（SEAMS §7 规定基准快照归它），
  // 它的 `captureBaseline({dispatchId, attemptId, ...})` 会把快照写进
  // `re/team/baselines/<dispatch>.json` 并返回 `{ref, baseline}`。收口侧 `loadBaseline()`
  // 认的正是这个形状（`ref` = 项目内路径 / `embedded` = 快照对象），所以契约里必须冻**它**，
  // 而不是另造一份 T6 时代的 `{frozen_at, targets:[{id,…}]}` 内联对象 —— 那样收口会
  // 以「基准快照路径不是项目内相对路径」直接 RECOVERY_REQUIRED（T12 之前从未跑过这条缝）。
  const dependencyRunIds = Array.isArray(route.dependency_runs) ? route.dependency_runs.filter(nonEmpty) : []
  // 装配接缝的入参按对象传（两份 `captureBaseline` 的入参形状不同：`baseline` 认 clock/fs，
  // `contract` 认 dependencyRunIds；各取所需，这里不替它们裁剪）。
  const captureInput = {
    root,
    dispatchId,
    attemptId,
    targetIds: request.target_ids,
    artifacts: depended.artifacts,
    projectAdapter,
    now: typeof deps.clock?.isoNow === 'function' ? deps.clock.isoNow() : new Date().toISOString(),
    clock: deps.clock,
    atomic: deps.atomic,
    paths: deps.paths,
    fs: deps.fs,
  }
  const capture = deps.baseline && typeof deps.baseline.captureBaseline === 'function'
    ? await deps.baseline.captureBaseline(captureInput)
    : await contractMod.captureBaseline({
      root,
      targetIds: request.target_ids,
      artifacts: depended.artifacts,
      projectAdapter,
      atomic: deps.atomic,
      paths: deps.paths,
      now: typeof deps.clock?.isoNow === 'function' ? deps.clock.isoNow() : new Date().toISOString(),
      dependencyRunIds,
    })
  if (!capture || capture.ok !== true) {
    // 两条装配路径的失败分支字段不同（`baseline` 给 `issues`、`contract` 给三字段诊断）。
    const captureView = recordOf(capture)
    return {
      envelope: blockedEnvelope(envelope, {
        code: stableCode(captureView.code ?? 'BASELINE_MISMATCH'),
        operationId: request.operation_id,
        reason: captureView.reason ?? '冻结不了派发基准',
        nextStep: captureView.next_step ?? '先按 skill 登记目标字节哈希/样本路径，再派发',
      }),
    }
  }

  return {
    ok: true,
    plan: {
      route,
      post,
      requirements,
      match,
      capacity,
      budget,
      memberDecision,
      resourcePlan,
      baseline: capture,
      routeTargets,
      gaps: [...budget.gaps, ...effective.gaps],
      callerName,
      capacitySource: effective.source,
      capacityLimits: {
        max_members: effective.memberSlots.total,
        max_active_subagents: effective.activations.total,
      },
      capacityDiagnostics,
      digests: frozen.digests,
    },
  }
}

/** 容量缺口（`{code, detail, nextStep}`）→ 契约诊断（三字段）。 */
function capacityGapsToDiagnostics(value: unknown): Diagnostic[] {
  const rows = Array.isArray(value) ? value : []
  return rows.map((raw) => {
    const gap = recordOf(raw)
    return {
      code: nonEmpty(gap.code) ? gap.code : 'CAPACITY_UNKNOWN',
      reason: nonEmpty(gap.detail) ? gap.detail : '容量声明或计数不可用',
      next_step: nonEmpty(gap.nextStep)
        ? gap.nextStep
        : '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents 后重试',
    }
  })
}

/**
 * 未声明容量时的风险警告（T18 §3 逐条要求）：
 * 明说「容量未声明」「本次创建不保证有位置」「最多可能损失一个成员名与席位」。
 *
 * 这不是提示音，是**知情同意**：一次失败 spawn 会永久烧掉名字与席位（D1/D12），
 * 而宿主没有受支持的余额查询；Leader 选择照派，就必须看到这个代价。
 */
function undeclaredCapacityWarning(usedSeats: number | null, observedGap: string | null): Diagnostic {
  const used = usedSeats === null ? '数不到已用席位' : `当前已用席位 ${usedSeats}`
  const extra = observedGap === null ? '' : `（${observedGap}）`
  return {
    code: 'CAPACITY_UNDECLARED',
    reason:
      '容量未声明（capacity_source=unknown）：re/team/capacity.json 与 profile config.capacity 都没有声明，'
      + `本会话也还没有观测值，${used}${extra}。本次派发照派，但**不保证**有位置：`
      + '宿主若因上限拒绝创建，最多可能损失一个成员名与一个席位（该名字不会再用，D12）',
    next_step:
      '要么在 re/team/capacity.json（或本次调用传 capacity）声明 maxMembers/maxActiveSubagents，'
      + '要么接受这一次学费；命中宿主上限后会把观察到的上限写进 re/team/capacity-observed.json，'
      + '后续派发按它算。不要为了试探余额而派发（那是主动探测，不是被动观测）',
  }
}

// ---------------------------------------------------------------------------
// T18：锁内的容量闸门与「撞一次就学」
// ---------------------------------------------------------------------------

/** 台账里的 `capacity_source` 归一（不认识的键按 unknown，绝不猜来源）。 */
function storedCapacitySource(value: unknown): CapacitySource {
  return value === 'call' || value === 'project' || value === 'profile' || value === 'observed' ? value : 'unknown'
}

/** 当前已用席位（含失败成员；`listMembers` 失败时 `null`，绝不猜）。 */
async function usedSeatsNow(teamAdapter: TeamAdapterLike): Promise<number | null> {
  const listed = recordOf(await teamAdapter.listMembers(undefined))
  if (listed.ok !== true) return null
  return recordRows(listed.members).filter((row) => row.role === 'teammate').length
}

/** 闸门状态：本次是否写了「观测中」标记（决定 finally 里要不要删），以及写标记的失败原因。 */
interface CapacityGateState {
  source: CapacitySource
  markerWritten: boolean
  note: string | null
}

/** 闸门结论：拒绝时就地给出三字段（调用方只负责装信封）。 */
interface CapacityGateResult {
  refusal: { code: string; reason: string; nextStep: string } | null
  state: CapacityGateState
}

/** `openCapacityGate()` 的入参。 */
interface CapacityGateInput {
  root: string
  sessionId: string | null
  teamAdapter: TeamAdapterLike
  /** 台账里记下的生效来源（preflight 写、恢复时读回来）。 */
  capacitySource: unknown
  member: string
  operationId: string
  nowIso: string
}

/**
 * spawn 之前的容量闸门（锁内）。
 *
 * - 已知上限（call/project/profile/observed）→ 直接放行，不写标记（不改变既有行为）。
 * - 未知上限：先重读观测值（等锁期间别的派发可能已经学到了上限）；仍有「观测中」标记 →
 *   明确拒绝（并发保护）；都没有 → 写标记、放行，并在 spawn 结束后删除。
 */
async function openCapacityGate({
  root,
  sessionId,
  teamAdapter,
  capacitySource: sourceValue,
  member,
  operationId,
  nowIso,
}: CapacityGateInput): Promise<CapacityGateResult> {
  const source = storedCapacitySource(sourceValue)
  if (source !== 'unknown') return { refusal: null, state: { source, markerWritten: false, note: null } }

  const fresh = await capacitySource.readObservedCapacity(root, sessionId)
  if (fresh.record !== null && fresh.applies) {
    const used = await usedSeatsNow(teamAdapter)
    if (used !== null) {
      const remaining = Math.max(0, fresh.record.max_members - used)
      if (remaining < 1) {
        return {
          refusal: {
            code: 'CAPACITY_EXHAUSTED',
            reason:
              `本会话已观测到成员上限 maxMembers=${fresh.record.max_members}，当前已用 ${used} 席：到顶，`
              + '不再创建成员（避免再烧一个名字与席位）',
            nextStep:
              '复用已有成员或等一个成员释放；要放宽上限就在 re/team/capacity.json 显式声明（并在本次调用传 capacity）；'
              + '不要靠再撞一次去试探余额',
          },
          state: { source: 'observed', markerWritten: false, note: null },
        }
      }
      return { refusal: null, state: { source: 'observed', markerWritten: false, note: null } }
    }
  }

  const guard = capacitySource.capacityMarkerGuard(await capacitySource.readObservationMarker(root), sessionId)
  if (guard.blocked) {
    return {
      refusal: {
        code: 'CAPACITY_UNKNOWN',
        reason: guard.reason ?? '容量仍在观测中：拒绝再撞一次',
        nextStep: guard.next_step ?? '等这次观测结束再派发',
      },
      state: { source, markerWritten: false, note: null },
    }
  }

  try {
    await capacitySource.writeObservationMarker(root, { sessionId, member, operationId, startedAt: nowIso })
    return { refusal: null, state: { source, markerWritten: true, note: null } }
  } catch (error) {
    // 标记只是本地并发提示：写不了不改变「照派」的裁决，但必须把「这次没有第二道保护」记下来。
    return {
      refusal: null,
      state: {
        source,
        markerWritten: false,
        note: `写 ${capacitySource.OBSERVING_MARKER_PATH} 失败（${thrownMessage(error)}）：本次没有并发保护`,
      },
    }
  }
}

/** 一次被动观测的结果。`ref === null` 表示没落盘，`error` 说明原因。 */
interface CapacityObservationResult {
  ref: string | null
  used: number | null
  error: string | null
}

/**
 * 被动观测：宿主因上限拒绝了一次**真实需要**的创建之后，把「你已经到顶了」记下来。
 *
 * `max_members` 取**观测当时的已用席位数**（失败成员已计入）：真实上限只会 ≥ 这个数，
 * 所以它是保守下限 —— 宁可少开，也不靠猜多开。activation 占用不可观测（D25），
 * 同一个已用席位数只作为 `max_active_subagents` 的保守下限，不声称知道真实池大小。
 */
async function recordCapacityObservation(params: {
  root: string
  sessionId: string | null
  teamAdapter: TeamAdapterLike
  hostCode: string
  nowIso: string
}): Promise<CapacityObservationResult> {
  const used = await usedSeatsNow(params.teamAdapter)
  if (used === null) {
    return { ref: null, used: null, error: 'listMembers 失败，数不到已用席位' }
  }
  if (used < 1) {
    return { ref: null, used, error: `观测当时的已用席位是 ${used}，不能当作上限` }
  }
  if (params.sessionId === null) {
    return { ref: null, used, error: '拿不到本会话身份，观测值无法归到会话（未落盘）' }
  }
  try {
    const ref = await capacitySource.writeObservedCapacity(params.root, {
      schema_version: capacitySource.OBSERVED_SCHEMA_VERSION,
      session_id: params.sessionId,
      observed_at: params.nowIso,
      max_members: used,
      max_active_subagents: used,
      basis: { used_at_observation: used, host_code: params.hostCode },
    })
    return { ref, used, error: null }
  } catch (error) {
    return { ref: null, used, error: `写 ${capacitySource.OBSERVED_CAPACITY_PATH} 失败：${thrownMessage(error)}` }
  }
}

/** 容量碰撞的 failure 文案：点名被烧掉的成员、宿主原始码、观测值落点（D21：细节写进文本）。 */
function capacityFailureReason(
  member: string,
  hostCode: string | null,
  spawnReason: unknown,
  observed: CapacityObservationResult | null,
): string {
  const raw = nonEmpty(spawnReason) ? spawnReason : '宿主没有给原始文案'
  const host = hostCode === null ? '' : `，hostCode=${hostCode}`
  const head = `宿主因容量上限拒绝创建成员 ${member}（${raw}${host}）：该名字与席位已被烧掉，不得同名重试（D12）`
  if (observed === null) return `${head}。本次没能观测到上限`
  if (observed.ref === null) return `${head}。观测值没有落盘：${observed.error ?? '未知原因'}`
  return `${head}。已把观测到的上限写进 ${observed.ref}：`
    + `max_members=${String(observed.used)}（取失败那刻的已用席位数，失败成员已计入）、`
    + `max_active_subagents=${String(observed.used)}（activation 占用不可观测，同一个保守下限）`
}

/** 容量碰撞的下一步：只允许换名字重试，且先核对名册。 */
function capacityFailureNextStep(
  member: string,
  observed: CapacityObservationResult | null,
): string {
  const rename = `先核对成员名册确认 ${member} 是否已存在/失败；换名字重试（下一次派发会用 ${member}-2），不要用同名`
  if (observed !== null && observed.ref !== null) {
    return `${rename}。后续派发按 ${observed.ref} 的 observed 上限算（剩余 0 时不会再创建）；`
      + '要放宽上限就在 re/team/capacity.json 显式声明（或本次调用传 capacity）'
  }
  const why = observed === null ? '本次不是容量碰撞' : (observed.error ?? '未知原因')
  return `${rename}。在 re/team/capacity.json 显式声明 maxMembers/maxActiveSubagents 后再派发（观测值未落盘：${why}）`
}

/** 容量碰撞的两条诊断：一条说宿主拒绝，一条说观测值去了哪里（含 `hostCode`）。 */
function capacityFailureDiagnostics(
  code: string,
  member: string,
  hostCode: string | null,
  observed: CapacityObservationResult | null,
): Diagnostic[] {
  const host = hostCode === null ? code : hostCode
  const out: Diagnostic[] = [{
    code,
    reason: `宿主拒绝创建成员 ${member}（hostCode=${host}）：名字与席位已消耗`,
    next_step: '不要用同名重试（D12）；下一次派发会自动用下一个名字',
  }]
  if (observed !== null && observed.ref !== null) {
    out.push({
      code: 'CAPACITY_OBSERVED',
      reason:
        `已把观测到的上限写进 ${observed.ref}：max_members=${String(observed.used)}、`
        + `max_active_subagents=${String(observed.used)}（观测当时已用 ${String(observed.used)} 席，hostCode=${host}）`,
      next_step:
        '这是「你已经到顶了」的保守下限，不是宿主声明：要放宽就在 re/team/capacity.json 声明；不要靠再撞一次去试探',
    })
  } else {
    out.push({
      code: 'CAPACITY_OBSERVED_UNWRITTEN',
      reason: `观测值没有落盘：${observed?.error ?? '本次不是容量碰撞'}`,
      next_step: '先声明容量再派发；不要为了试探余额重复派发（D1）',
    })
  }
  return out
}

/** 台账里存下的容量诊断（成功回执要原样交回；恢复路径也一样）。 */
function capacityDiagnosticsFrom(data: Record<string, unknown>): Diagnostic[] {
  const rows = Array.isArray(data.capacity_diagnostics) ? data.capacity_diagnostics : []
  return rows.map((raw) => {
    const entry = recordOf(raw)
    return {
      code: nonEmpty(entry.code) ? entry.code : 'CAPACITY_UNKNOWN',
      reason: nonEmpty(entry.reason) ? entry.reason : '容量来源未记录',
      next_step: nonEmpty(entry.next_step) ? entry.next_step : '在 re/team/capacity.json 声明容量后重试',
    }
  })
}

// ---------------------------------------------------------------------------
// 锁内阶段推进
// ---------------------------------------------------------------------------

async function runLocked(params: RunLockedParams): Promise<Envelope> {
  const {
    ctx, deps, envelope, request, root, operationId, inputHash, ledger,
    dispatchId, attemptId, attemptIndex, contractRef, workDir, runIdReservation,
    retry, excludeTaskIds, plan, bindingSnap, callerName, existing,
    resourcesMod, contractMod, atomic, paths, projectAdapter, teamAdapter, onPersisted, capacitySessionId,
  } = params

  const clock = deps.clock
  const now = (): string => (typeof clock?.isoNow === 'function' ? clock.isoNow() : new Date().toISOString())
  const record = existing ?? null
  let data: Record<string, unknown> = record === null ? {} : { ...(record.data ?? {}) }
  let phase: string | null | undefined = record === null ? null : record.phase

  const advance = async (
    nextPhase: string | null | undefined,
    patch: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    // 恢复路径会把台账里的当前阶段原样再写一次（step 4 的 `advance(phase, …)`），运行期这里
    // 必是 OPERATION_PHASES 之一及非空字符串。显式守卫只为收窄类型：失败仍走台账层同一条
    // 失败路径（ContractError INVALID_ARGUMENT → 外层 fromError），不静默改写调用方传的值。
    if (!nonEmpty(nextPhase)) {
      throw new ContractError({
        code: 'INVALID_ARGUMENT',
        message: `派发阶段未确定，不能写台账: ${JSON.stringify(nextPhase)}`,
        nextStep: '阶段必须取 operation.OPERATION_PHASES 之一（prepared…completed/needs_recovery）',
      })
    }
    const updated = await ledger.advance(operationId, nextPhase, patch)
    data = { ...(updated.data ?? {}) }
    phase = updated.phase
    await syncAttemptRecord()
    return data
  }

  const syncAttemptRecord = async (): Promise<void> => {
    if (!nonEmpty(data.member) && phase !== 'prepared') return
    const attemptRecord = {
      schema_version: 1,
      dispatch_id: dispatchId,
      attempt_id: attemptId,
      attempt_index: attemptIndex,
      operation_id: operationId,
      route_id: request.route_id,
      post_id: request.post_id,
      target_ids: [...request.target_ids],
      objective_sha256: deps.atomic.sha256Bytes(Buffer.from(request.objective, 'utf8')),
      member: data.member ?? null,
      member_mode: data.member_mode ?? null,
      task_id: data.task_id ?? null,
      task_revision: Number.isInteger(data.task_revision) ? data.task_revision : null,
      task_status: data.task_status ?? null,
      contract_ref: data.contract_ref ?? null,
      contract_sha256: data.contract_sha256 ?? null,
      work_dir: workDir,
      run_id_reservation: runIdReservation,
      phase,
      binding: bindingSnap,
      updated_at: now(),
      revoked: record?.revoked ?? null,
    }
    await writeAttemptRecord({ root, atomic, paths, record: attemptRecord })
  }

  const failure = (code: string, {
    reason,
    nextStep,
    phase: failurePhase,
    extra = {},
    resolvedCode,
    diagnostics,
  }: FailureOptions): Envelope => partialEnvelope(envelope, {
    code: resolvedCode ?? stableCode(code),
    operationId,
    phase: failurePhase ?? phase ?? 'prepared',
    data: {
      dispatch_id: dispatchId,
      attempt_id: attemptId,
      route_id: request.route_id,
      contract_ref: data.contract_ref ?? contractRef,
      work_dir: workDir,
      ...identitiesOf(data),
      ...extra,
    },
    reason,
    nextStep,
    diagnostics: diagnostics ?? [diagnosticOf(envelope, resolvedCode ?? stableCode(code), reason, nextStep)],
  })

  // ---- step 1：登记操作（先存意图：身份先算好） ----
  if (phase === null) {
    await ledger.prepare(operationId, inputHash, 'prepared', {
      tool: 'rt_dispatch',
      dispatch_id: dispatchId,
      attempt_id: attemptId,
      attempt_index: attemptIndex,
      route_id: request.route_id,
      post_id: request.post_id,
      target_ids: [...request.target_ids],
      binding: bindingSnap,
      retry_of: request.retry_of,
      retry_recovery_ref: retry?.recoveryRef ?? null,
      // T18：出问题要能回答「当时它以为上限是多少」——来源与数字都进台账。
      capacity_source: plan?.capacitySource ?? 'unknown',
      capacity_max_members: plan?.capacityLimits?.max_members ?? null,
      capacity_max_active_subagents: plan?.capacityLimits?.max_active_subagents ?? null,
      capacity_session_id: capacitySessionId,
      capacity_diagnostics: (plan?.capacityDiagnostics ?? []).map((entry) => ({ ...entry })),
    })
    onPersisted()
    const reloaded = await ledger.findById(operationId)
    data = { ...(reloaded?.data ?? {}) }
    phase = reloaded?.phase ?? 'prepared'
  }

  // 恢复时重新计算派生值（台账里存了就不用重算）
  const storedDispatchId = nonEmpty(data.dispatch_id) ? data.dispatch_id : dispatchId
  const storedAttemptId = nonEmpty(data.attempt_id) ? data.attempt_id : attemptId
  if (storedDispatchId !== dispatchId || storedAttemptId !== attemptId) {
    return failure('RECOVERY_REQUIRED', {
      reason: `台账里的身份 ${storedDispatchId}/${storedAttemptId} 与本次派生 ${dispatchId}/${attemptId} 不一致`,
      nextStep: '按台账身份核对契约与宿主记录；不要用新身份覆盖既有操作',
      phase: 'needs_recovery',
    })
  }

  // ---- 恢复补水：没有 preflight 计划时，用当前只读记录补出契约/成员所需的输入 ----
  const postForPrompt: CatalogPost | null = plan?.post
    ?? (deps.catalog && typeof deps.catalog.findPost === 'function'
      ? deps.catalog.findPost(request.post_id)
      : null)
  if (!postForPrompt) {
    return failure('POST_DISABLED', {
      reason: `岗位 ${request.post_id} 不在岗位目录里，无法继续本 attempt`,
      nextStep: '核对岗位目录；岗位被移除时另发新 dispatch',
      phase: 'needs_recovery',
    })
  }
  const routeReadForContract = recordOf(await projectAdapter.readRoute(request.route_id))
  const routeForContract: RouteRecord | null = plan?.route
    ?? (isPlainObject(routeReadForContract.route) ? routeReadForContract.route : null)
  const requirementsForContract = plan?.requirements ?? contractMod.mergeRequirements(postForPrompt, request)
  const capabilityMatchForContract = plan
    ? {
      matched: plan.match.matched.map((entry) => entry.capability),
      providers: plan.match.providers
        .map((provider) => provider.capability ?? provider.tool_id ?? null)
        .filter(nonEmpty),
    }
    : null

  // ---- step 2：资源租用（锁内，幂等） ----
  if (data.resources === undefined) {
    const reserved = recordOf(await resourcesMod.reserveResources({
      root,
      needs: request.resource_needs,
      dispatchId,
      attemptId,
      clock,
      atomic,
    }))
    if (reserved.ok !== true) {
      // 资源复核失败不落盘；但 operation 台账已写，按「已持久化后失败」给 partial
      const code = stableCode(reserved.code)
      const reservedDiagnostics = diagnosticsOf(reserved.diagnostics)
      return partialEnvelope(envelope, {
        code,
        operationId,
        phase: 'prepared',
        data: { dispatch_id: dispatchId, attempt_id: attemptId },
        diagnostics: reservedDiagnostics,
        reason: reservedDiagnostics[0]?.reason ?? '资源无法租用（未建成员、未建任务）',
        nextStep: reservedDiagnostics[0]?.next_step ?? '核对资源归属后以同一 operation ID 重入',
      })
    }
    await advance('prepared', {
      resources: recordRows(reserved.reservations).map((reservation) => ({
        resource_key: reservation.resource_key,
        physical_identity: reservation.physical_identity,
        mode: reservation.mode,
        generation: reservation.generation,
      })),
      resources_revision: reserved.revision,
      resource_gaps: Array.isArray(reserved.gaps) ? reserved.gaps : [],
    })
  }

  // ---- step 3：baseline + 契约落盘 ----
  if (!nonEmpty(data.contract_ref)) {
    // 工作区契约：work_dir 必须恰好是本次尝试目录，submission_ref 必须在其内部；
    // 任何越界/绝对路径/反斜杠/ADS/junction 逃逸都是 PATH_INVALID（写契约前先拒绝）
    try {
      await contractMod.assertAttemptDir({ root, dispatchId, attemptId, candidate: workDir })
      await contractMod.assertAttemptPath({
        root,
        dispatchId,
        attemptId,
        candidate: contractMod.submissionRefFor(dispatchId, attemptId),
        label: 'submission_ref',
      })
    } catch (error) {
      return failure('PATH_INVALID', {
        // 抛出物可能不是 Error：按字段读（等价于迁移前的 `error?.message`）。
        reason: `工作区路径不合法：${recordOf(error).message ?? '未知路径错误'}`,
        nextStep: '把 re/team/work 恢复为项目内普通目录（不要 junction/symlink）；越界路径一律拒绝',
        phase: 'prepared',
      })
    }

    let baselineRef = isPlainObject(data.baseline_ref) ? data.baseline_ref : baselineRefForContract(plan?.baseline)
    if (baselineRef === null) {
      // 恢复路径没有 preflight 计划：依赖产物身份照样要冻（T17），否则这条回退分支又会写出
      // 一份没有 `artifacts` 的基准。
      const depended = await dependentArtifacts({
        projectAdapter,
        route: routeForContract ?? {},
        targetIds: request.target_ids,
      })
      if (depended.ok !== true) {
        return failure(depended.code, {
          reason: depended.reason,
          nextStep: depended.nextStep,
          phase: 'prepared',
        })
      }
      const capture = await contractMod.captureBaseline({
        root,
        targetIds: request.target_ids,
        artifacts: depended.artifacts,
        projectAdapter,
        atomic,
        paths,
        now: now(),
      })
      if (!capture.ok) {
        return failure(capture.code ?? 'BASELINE_MISMATCH', {
          reason: capture.reason ?? '冻结不了派发基准',
          nextStep: capture.next_step ?? '先按 skill 登记目标字节哈希后再派发',
          phase: 'prepared',
        })
      }
      baselineRef = capture.baseline_ref
    }

    // 规则摘要：门 1 已经探过就直接复用（不重复跑 Python）；恢复路径没有计划时补探一次。
    const frozen: FrozenDigestsRead = plan !== null
      ? { ok: true, digests: plan.digests }
      : await readFrozenDigests(projectAdapter, root)
    if (!frozen.ok) {
      return failure(frozen.code, {
        reason: frozen.reason,
        nextStep: frozen.nextStep,
        phase: 'prepared',
      })
    }

    const built = contractMod.buildContract({
      dispatchId,
      attemptId,
      attemptIndex,
      operationId,
      createdAt: now(),
      projectRoot: root,
      binding: bindingSnap,
      post: postForPrompt,
      route: routeForContract,
      // `buildContract` 先校验 `baselineRef.targets` 是非空数组（否则抛 BASELINE_MISMATCH），
      // 校验发生在用它之前；这里只把「非数组」的静态可能收掉，可观察行为不变。
      targets: Array.isArray(baselineRef.targets) ? baselineRef.targets : [],
      baselineRef,
      objective: request.objective,
      requirements: requirementsForContract,
      capabilityMatch: capabilityMatchForContract,
      resources: (data.resources ?? []),
      dependsOnTasks: [...request.depends_on_tasks],
      timeboxMs: request.timebox_ms,
      deliveryTimeoutMs: request.delivery_timeout_ms,
      workDir,
      runIdReservation,
      contractRef,
      retryOf: request.retry_of,
      caller: callerName,
      digests: frozen.digests,
    })
    const persisted = await contractMod.persistContract({
      root,
      ref: contractRef,
      text: built.text,
      atomic,
      paths,
    })
    await advance('prepared', {
      contract_ref: contractRef,
      contract_sha256: persisted.sha256,
      contract_bytes: persisted.bytes,
      baseline_ref: baselineRef,
      work_dir: workDir,
      run_id_reservation: runIdReservation,
    })
    await contractMod.ensureWorkDir({ root, dispatchId, attemptId, paths })
  }

  // 上面的落盘分支保证这两个键已写入（本 attempt 刚写或读自台账）；这里把台账的 `unknown`
  // 收成字符串。缺键只会出现在**部分写入的旧台账**：那时哈希按空串继续，交付信封会以
  // SHA256 形状拒绝（与原行为同样是 DELIVERY_FAILED，只是诊断文本里的哈希为空）。
  const contractRefFinal = nonEmpty(data.contract_ref) ? data.contract_ref : contractRef
  const contractSha256 = typeof data.contract_sha256 === 'string' ? data.contract_sha256 : ''

  // ---- step 4：成员（复用或新建；先存意图，响应丢失按确定名字关联） ----
  if (!nonEmpty(data.member)) {
    const memberIntent = recordOf(data.member_intent)
    const decision: MemberIntentLike | null = plan?.memberDecision
      ?? (isPlainObject(data.member_intent)
        ? { action: memberIntent.action, member: memberIntent.name }
        : null)
    if (decision === null) {
      return failure('RECOVERY_REQUIRED', {
        reason: '恢复时缺少成员决策（台账未记录成员意图），无法确定该复用还是新建',
        nextStep: '核对成员名册后重新派发；不要凭空 spawn 新成员',
        phase: 'prepared',
      })
    }
    if (!isPlainObject(data.member_intent)) {
      await advance(phase, {
        member_intent: {
          action: decision.action,
          name: decision.member,
          failed_before: decision.failedBefore ?? [],
        },
      })
    }
    // 台账里的意图（`advance` 刚写或恢复时读回）；字段一律按 `unknown` 读。
    const intent = recordOf(data.member_intent)
    // 成员名只用于拼文案/写标记；非字符串（损坏台账）按空串处理，形状由适配器拒绝。
    const intentName = nonEmpty(intent.name) ? intent.name : ''
    const membersNow = recordOf(await teamAdapter.listMembers(undefined))
    const rows = membersNow.ok === true ? recordRows(membersNow.members) : []
    const existingRow = rows.find((row) => row.name === intent.name) ?? null

    let member: MemberIdentity | null = null
    if (existingRow !== null && existingRow.status !== 'failed' && existingRow.status !== 'provisioning') {
      // 复用目标、或上次 spawn 已生效但响应丢失：按确定的名字唯一关联
      member = { name: existingRow.name, id: existingRow.id, mode: intent.action === 'reuse' ? 'reuse' : 'spawn-adopted' }
    } else if (existingRow !== null && existingRow.status === 'failed') {
      await advance(phase, { member_failed: { name: intent.name, code: 'RECOVERY_REQUIRED', at: now() } })
      return failure('RECOVERY_REQUIRED', {
        reason: `成员名 ${intent.name} 上次创建失败，名字与席位已被消耗（D12：不得同名重试）`,
        nextStep: `核对名册后用这个名字之外的新成员（下一次派发会用 ${intent.name}-2）；本次不要重复 spawn`,
        phase: 'member_ready',
        extra: { member: intent.name },
      })
    }

    if (member === null) {
      if (intent.action !== 'spawn') {
        return failure('RECOVERY_REQUIRED', {
          reason: `要复用的成员 ${intent.name} 已不在名册里（可能已失败/被移除）`,
          nextStep: '重新核对成员名册与席位；不要静默改成新建成员',
          phase: 'prepared',
        })
      }
      // T18：锁内复核容量（并发保护 + 观测值可能在本进程等锁期间落地）。
      const gate = await openCapacityGate({
        root,
        sessionId: capacitySessionId,
        teamAdapter,
        capacitySource: data.capacity_source,
        member: intentName,
        operationId,
        nowIso: now(),
      })
      if (gate.refusal !== null) {
        return failure(gate.refusal.code, {
          reason: gate.refusal.reason,
          nextStep: gate.refusal.nextStep,
          phase: 'prepared',
        })
      }
      if (gate.state.note !== null) {
        // 标记写失败不改变裁决，但必须留在台账里（否则「这次没有并发保护」就没人知道了）。
        await advance(phase, { capacity_marker_note: gate.state.note })
      }
      const prompt = contractMod.buildMemberPrompt({
        post: postForPrompt,
        rulesEntry: RULES_ENTRY,
        skillCopyPath: SKILL_COPY_ENTRY,
      })
      try {
        const spawned = recordOf(await teamAdapter.spawnTeammate({
          name: intentName,
          prompt,
          description: `rt_dispatch ${postForPrompt.id} ${request.route_id}`,
        }))
        // 成功分支带成员视图（可能是 `null`：适配器把非对象投影成 null）。
        const spawnedMember = recordOf(spawned.member)
        if (spawned.ok === true) {
          member = { name: spawnedMember.name ?? intent.name, id: spawnedMember.id ?? null, mode: 'spawn' }
        } else {
          const after = recordOf(await teamAdapter.listMembers(undefined))
          const appeared = after.ok === true
            ? recordRows(after.members).find((row) => row.name === intent.name && row.status !== 'failed' && row.status !== 'provisioning') ?? null
            : null
          if (appeared !== null) {
            member = { name: appeared.name, id: appeared.id, mode: 'spawn-adopted' }
          } else {
            const code = stableCode(spawned.code)
            const hostCode = nonEmpty(spawned.hostCode) ? spawned.hostCode : null
            // T18：宿主因上限拒绝一次**真实需要**的创建 → 被动观测（不是主动试探）。
            const observed = code === 'CAPACITY_EXHAUSTED'
              ? await recordCapacityObservation({
                root,
                sessionId: capacitySessionId,
                teamAdapter,
                hostCode: hostCode ?? code,
                nowIso: now(),
              })
              : null
            await advance(phase, {
              member_failed: { name: intent.name, code, host_code: hostCode, reason: spawned.reason ?? null, at: now() },
              ...(observed === null || observed.ref === null
                ? {}
                : {
                  capacity_observed: {
                    ref: observed.ref,
                    max_members: observed.used,
                    host_code: hostCode,
                    at: now(),
                  },
                }),
            })
            return failure(code, {
              reason: capacityFailureReason(intentName, hostCode, spawned.reason, observed),
              nextStep: capacityFailureNextStep(intentName, observed),
              phase: 'member_ready',
              extra: { member: intent.name },
              diagnostics: capacityFailureDiagnostics(code, intentName, hostCode, observed),
            })
          }
        }
      } finally {
        // 「观测中」标记只覆盖这一次 spawn：成功/失败/抛出都要收走，否则下一次派发会被自己挡住。
        if (gate.state.markerWritten) {
          await capacitySource.clearObservationMarker(root).catch(() => {})
        }
      }
    }

    await advance('member_ready', {
      member: member.name,
      member_id: member.id,
      member_mode: member.mode,
    })
  }

  const memberName = data.member

  // ---- step 5：任务（createTask → pending；先存意图，按摘要标记关联） ----
  if (!nonEmpty(data.task_id)) {
    const summary = contractMod.buildTaskSummary({
      postId: request.post_id,
      routeId: request.route_id,
      targetIds: request.target_ids,
      dispatchId,
      attemptId,
      attemptIndex,
      operationId,
      contractRef: contractRefFinal,
      contractSha256,
      workDir,
      objective: request.objective,
    })
    if (!isPlainObject(data.task_intent)) {
      await advance('member_ready', { task_intent: summary })
    }
    const marker = `dispatch=${dispatchId} attempt=${attemptId}`
    const before = recordOf(await teamAdapter.listTasks())
    const matched = before.ok === true
      ? recordRows(before.tasks).filter((row) => typeof row.description === 'string' && row.description.includes(marker))
      : []
    if (matched.length > 1) {
      return failure('RECOVERY_REQUIRED', {
        reason: `任务板上有多条带 ${marker} 标记的任务（${matched.map((task) => task.id).join(', ')}），无法唯一关联`,
        nextStep: '人工核对哪条是本 attempt 的任务，保留一条、把其余标记为历史后再重入',
        phase: 'member_ready',
      })
    }
    let task: Record<string, unknown> | null = matched[0] ?? null
    if (task === null) {
      const created = recordOf(await teamAdapter.createTask({
        subject: summary.subject,
        description: summary.description,
        blockedBy: [...request.depends_on_tasks],
      }))
      if (created.ok === true) {
        task = recordOf(created.task)
      } else {
        const after = recordOf(await teamAdapter.listTasks())
        const adopted = after.ok === true
          ? recordRows(after.tasks).filter((row) => typeof row.description === 'string' && row.description.includes(marker))
          : []
        if (adopted.length === 1) {
          task = adopted[0]
        } else {
          const code = stableCode(created.code)
          return failure(code, {
            reason: `创建任务失败：${created.reason ?? code}`,
            nextStep: '核对任务板与依赖（blockedBy 必须是已存在且已完成的任务），修好后以同一 operation ID 重入',
            phase: 'member_ready',
          })
        }
      }
    }
    await advance('task_created', {
      task_id: task.id,
      task_revision: task.revision,
      task_subject: summary.subject,
    })
  }

  // ---- step 6：指派（reassign → in_progress + owner） ----
  if (data.task_status !== 'in_progress') {
    const current = recordOf(await teamAdapter.getTask(data.task_id))
    const currentTask = recordOf(current.task)
    if (current.ok !== true) {
      return failure(stableCode(current.code), {
        reason: `读不到任务 ${data.task_id}：${current.reason ?? 'getTask 失败'}`,
        nextStep: '核对任务板；任务被删除时另发新 dispatch',
        phase: 'task_created',
      })
    }
    if (currentTask.status === 'completed' || currentTask.status === 'deleted') {
      return failure('STALE_ATTEMPT', {
        reason: `任务 ${data.task_id} 已是 ${currentTask.status}，不能作为本 attempt 的交付目标`,
        nextStep: '另发新 dispatch；已收口的任务不要重开',
        phase: 'task_created',
        extra: { task_id: data.task_id },
      })
    }
    if (currentTask.status === 'in_progress' && currentTask.owner === memberName) {
      await advance('assigned', { task_status: 'in_progress', task_revision: currentTask.revision })
    } else {
      if (!isPlainObject(data.assign_intent)) {
        await advance('task_created', {
          assign_intent: { owner: memberName, expected_revision: currentTask.revision },
        })
      }
      const assigned = recordOf(await teamAdapter.updateTask({
        taskId: data.task_id,
        expectedRevision: currentTask.revision,
        action: 'reassign',
        owner: memberName,
      }))
      if (assigned.ok === true) {
        await advance('assigned', { task_status: 'in_progress', task_revision: recordOf(assigned.task).revision })
      } else {
        const reread = recordOf(await teamAdapter.getTask(data.task_id))
        const rereadTask = recordOf(reread.task)
        if (reread.ok === true && rereadTask.status === 'in_progress' && rereadTask.owner === memberName) {
          await advance('assigned', { task_status: 'in_progress', task_revision: rereadTask.revision })
        } else {
          const code = stableCode(assigned.code)
          const actualRevision = assigned.actualRevision
          return failure(code, {
            reason: `指派任务 ${data.task_id} 给 ${memberName} 失败：${assigned.reason ?? code}`,
            nextStep: code === 'REVISION_CONFLICT'
              ? `任务被改到 revision ${actualRevision ?? '未知'}：先核对 owner 与依赖再续做，不要覆盖别人的决策`
              : '核对任务 owner/revision 与依赖状态后以同一 operation ID 重入',
            phase: 'task_created',
            extra: {
              ...(Number.isInteger(actualRevision) ? { actual_revision: actualRevision } : {}),
            },
          })
        }
      }
    }
  }

  // ---- step 7：交付信封（只发引用；重发同一份字节） ----
  let justDelivered = false
  if (phase !== 'delivered') {
    const built = contractMod.buildDeliveryEnvelope({
      callerName,
      member: memberName,
      dispatchId,
      attemptId,
      taskId: data.task_id,
      taskRevision: data.task_revision,
      routeId: request.route_id,
      postId: request.post_id,
      contractRef: contractRefFinal,
      contractSha256,
      workDir,
      runIdReservation,
      objective: request.objective,
      rulesEntry: RULES_ENTRY,
      skillCopyPath: SKILL_COPY_ENTRY,
    })
    if (!built.ok) {
      await advance('assigned', { delivery_failed: { code: built.code, reason: built.reason, at: now() } })
      return failure('DELIVERY_FAILED', {
        reason: built.reason,
        nextStep: '交付信封无法压到上限内：检查 dispatch/route 标识长度；契约本身不受消息长度限制，不需要截断',
        phase: 'assigned',
      })
    }
    if (!isPlainObject(data.delivery)) {
      await advance('assigned', {
        delivery: {
          envelope_id: built.envelope_id,
          bytes: built.bytes,
          dedupe_key: built.dedupe_key,
          prepared_at: now(),
        },
      })
    }
    const sent = recordOf(await teamAdapter.sendMessage({ target: memberName, content: built.blocks }))
    if (sent.ok !== true) {
      const code = stableCode(sent.code)
      await advance('assigned', {
        delivery_error: { code, reason: sent.reason ?? null, at: now(), envelope_id: built.envelope_id },
      })
      return failure('DELIVERY_FAILED', {
        reason: `${code === 'DELIVERY_FAILED' ? '投递交付信封失败' : `投递失败（${code}）`}：${sent.reason ?? '宿主拒绝了消息'}`,
        nextStep: `任务与成员身份已保留（task=${data.task_id} member=${memberName}）：以同一 operation ID 重入只会重发同一份信封，不会再建成员/任务；不要截断契约或把正文塞进消息`,
        phase: 'assigned',
        resolvedCode: 'DELIVERY_FAILED',
      })
    }
    justDelivered = true
    await advance('delivered', {
      delivered_at: now(),
      message_id: sent.messageId ?? null,
      delivery_bytes: built.bytes,
    })
  }

  // ---- step 8：审计 + 保存结果 ----
  // T18：容量来源与风险诊断在台账里（prepare 时写的），成功回执也要把它们交回给模型 ——
  // 「未知容量照派」如果只活在台账里，模型就看不见自己接受了什么代价。
  const diagnostics: Diagnostic[] = capacityDiagnosticsFrom(data)
  let auditWritten = data.audit_at !== undefined
  if (justDelivered && !auditWritten) {
    // `AuditEntry` 的列都是文本：台账里的任务是字符串（写进去的是字符串 ID），
    // 非字符串按「没有」处理 —— 审计是 best-effort 的记录，不改变派发判定。
    const audit = recordOf(deps.audit && typeof deps.audit.appendAudit === 'function'
      ? await deps.audit.appendAudit(root, {
        kind: 'dispatch',
        route: request.route_id,
        task: typeof data.task_id === 'string' ? data.task_id : null,
        member: typeof memberName === 'string' ? memberName : null,
        requester: callerName,
        verdict: 'delivered',
      }, { clock })
      : { written: false, error: '缺少 deps.audit' })
    auditWritten = audit.written === true
    if (!auditWritten) {
      diagnostics.push(envelope.diagnostic(
        'AUDIT_WRITE_FAILED',
        `审计写入失败：${audit.error ?? 'unknown'}（派发本身已交付）`,
        '补齐 re/team/audit.jsonl 的写权限；审计是 best-effort，不影响本次派发事实',
      ))
    } else {
      await advance('delivered', { audit_at: now() })
    }
  }

  // `started_at` 只认成员写下的 start.json：delivered 不等于已开始
  const startedAt = await contractMod.readStartAck({ root, dispatchId, attemptId })

  const resultEnvelope = envelope.ok({
    operationId,
    data: {
      dispatch_id: dispatchId,
      attempt_id: attemptId,
      task_id: data.task_id,
      member: memberName,
      route_id: request.route_id,
      revision: Number.isInteger(data.task_revision) ? data.task_revision : 0,
      phase: 'delivered',
      contract_ref: contractRefFinal,
      work_dir: workDir,
      started_at: startedAt,
    },
    diagnostics,
  })
  await ledger.saveResult(operationId, resultEnvelope)
  return resultEnvelope
}
