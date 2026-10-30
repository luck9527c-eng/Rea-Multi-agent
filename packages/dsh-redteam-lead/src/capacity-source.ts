/**
 * 生效容量的解析（T18）：按调用声明 > 项目声明 > profile 声明 > 本会话观测值 > unknown。
 *
 * 三条硬规则（DECISIONS D1/D12/D25 + T18 的裁决）：
 *
 * 1. **上限只能来自显式声明或宿主拒绝的被动观测**：本模块不猜 8/16、不读宿主私有字段、
 *    也**不为了试探余额而派发**。`CAPACITY_EXHAUSTED` 观测值只在一次**真实需要**的派发
 *    被宿主拒绝后落盘（`re/team/capacity-observed.json`）。
 * 2. **观测值按会话生效**：`TeamId` 就是 Lead 会话 id，席位随会话重置，所以
 *    `session_id` 与当前会话不一致（或无法确定当前会话）的观测值**不得**套用。
 * 3. **「上限未知」与「占用不可观测」是两件事**（D25）：这里只回答“有没有上限”，
 *    activation 的占用仍然恒为 `null`，由派发/收口的 gap 如实报告。
 *
 * 观测值的语义在 ticket 里写死了：`max_members` 取**观测当时的已用席位数**（失败成员已计入），
 * 即“你已经到顶了”。因此它是真实上限的**保守下限**：宁可少开，也不靠猜多开。
 */

import { readFile, unlink } from 'node:fs/promises'

import { writeJsonAtomic } from './atomic.js'
import { isRecord, recordOf, thrownCode, thrownMessage } from './guards.js'
import { resolveInProject } from './paths.js'
import type { ActivationSlots, CapacityGap, MemberSlots } from './team-adapter.js'

/** 观测值文件（本插件唯一写它的地方：派发撞到宿主上限之后）。 */
export const OBSERVED_CAPACITY_PATH = 're/team/capacity-observed.json'
/** 「观测中」标记：容量未知时，一次真实派发在 spawn 之前写下、结束后删除。 */
export const OBSERVING_MARKER_PATH = 're/team/capacity-observing.json'
/** 观测值文件的 schema 版本。 */
export const OBSERVED_SCHEMA_VERSION = 1

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
/** `capacity` 入参只允许这两个键（wire schema 是封闭对象）。 */
const CALL_CAPACITY_KEYS = ['max_members', 'max_active_subagents'] as const

/** 生效上限的来源（ticket 要求的 `capacity_source`）。 */
export type CapacitySource = 'call' | 'project' | 'profile' | 'observed' | 'unknown'

/** 按调用声明的容量。 */
export interface CallCapacity {
  max_members: number
  max_active_subagents: number
}

/** `re/team/capacity-observed.json` 的形状（ticket 逐字规定）。 */
export interface ObservedCapacityRecord {
  schema_version: number
  session_id: string
  observed_at: string
  max_members: number
  max_active_subagents: number
  basis: {
    used_at_observation: number
    host_code: string
  }
}

/** 团队适配器 `capacity()` 里本模块真正读到的部分（其它键原样忽略）。 */
export interface DeclaredCapacityView {
  memberSlots?: unknown
  activations?: unknown
  evidence?: unknown
  gaps?: unknown
}

/** 解析后的生效容量：形状与 `TeamCapacityResult` 的容量投影一致，便于直接喂 `planBudget`。 */
export interface EffectiveCapacity {
  source: CapacitySource
  /** 更高层（调用/观测）是否盖掉了声明缺口：诊断里要说得清“为什么上限是这样”。 */
  evidence_source: string
  memberSlots: MemberSlots
  activations: ActivationSlots
  /** 非阻塞缺口（`{code, detail, nextStep}`，与 `teamAdapter.capacity()` 同形状）。 */
  gaps: CapacityGap[]
  /** 被读到的观测值（即使不适用于本会话也保留，便于诊断“为什么不套用”）。 */
  observed: ObservedCapacityRecord | null
}

/** `readObservedCapacity()` 的结果。 */
export interface ObservedRead {
  record: ObservedCapacityRecord | null
  /** 只有「文件在、但用不了」时才给缺口；文件不存在不算异常。 */
  gap: CapacityGap | null
  /** 观测值是否适用于本会话（会话一致才为 true）。 */
  applies: boolean
}

/** 「观测中」标记的投影。 */
export interface ObservationMarker {
  present: boolean
  session_id: string | null
  member: string | null
  started_at: string | null
  operation_id: string | null
  /** 文件在但不是合法 JSON 对象：按「无法证明它属于别的会话」保守处理。 */
  malformed: boolean
}

/** `parseCallCapacity()` 的结果：`present:false` 表示调用方没传。 */
export interface CallCapacityParse {
  present: boolean
  value: CallCapacity | null
  issue: string | null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function gap(code: string, detail: string, nextStep: string): CapacityGap {
  return { code, detail, nextStep }
}

/**
 * 解析按调用声明的 `capacity`。
 *
 * 校验在 `index.ts` 已按 wire schema 做过一遍；这里再判一次是因为 handler 也会被直接调用
 * （测试、恢复路径），而且 `dispatch` 自己实现了 `normalizeDispatchInput`。
 */
export function parseCallCapacity(raw: unknown): CallCapacityParse {
  if (raw === undefined || raw === null) return { present: false, value: null, issue: null }
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { present: true, value: null, issue: 'capacity 必须是对象 {max_members, max_active_subagents}' }
  }
  const extra = Object.keys(raw).filter((key) => !CALL_CAPACITY_KEYS.some((allowed) => allowed === key))
  if (extra.length > 0) {
    return { present: true, value: null, issue: `capacity 只接受 ${CALL_CAPACITY_KEYS.join('/')}，多余的字段：${extra.join(', ')}` }
  }
  if (!isPositiveInteger(raw.max_members) || !isPositiveInteger(raw.max_active_subagents)) {
    return {
      present: true,
      value: null,
      issue: 'capacity.max_members 与 capacity.max_active_subagents 都必须是 >=1 的整数',
    }
  }
  return { present: true, value: { max_members: raw.max_members, max_active_subagents: raw.max_active_subagents }, issue: null }
}

/** 读观测值文件；缺失返回「没有」，坏形状/别的会话返回缺口（绝不抛）。 */
export async function readObservedCapacity(root: string, sessionId: string | null): Promise<ObservedRead> {
  let text: string
  try {
    text = await readFile(resolveInProject(root, OBSERVED_CAPACITY_PATH), 'utf8')
  } catch (error) {
    if (thrownCode(error) === 'ENOENT') return { record: null, gap: null, applies: false }
    return {
      record: null,
      gap: gap(
        'CAPACITY_OBSERVED_UNREADABLE',
        `读不了 ${OBSERVED_CAPACITY_PATH}：${thrownMessage(error)}`,
        '确认文件权限/编码后重试；读不到观测值时按「容量未知」处理，不猜上限',
      ),
      applies: false,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      record: null,
      gap: gap(
        'CAPACITY_OBSERVED_INVALID',
        `${OBSERVED_CAPACITY_PATH} 不是合法 JSON：${thrownMessage(error)}`,
        `按 T18 的形状重写该文件（schema_version/session_id/observed_at/max_members/max_active_subagents/basis），或删掉它按「容量未知」处理`,
      ),
      applies: false,
    }
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return {
      record: null,
      gap: gap('CAPACITY_OBSERVED_INVALID', `${OBSERVED_CAPACITY_PATH} 必须是 JSON 对象`, '按 T18 的形状重写该文件'),
      applies: false,
    }
  }

  const basis = recordOf(parsed.basis)
  const observedSessionId = nonEmptyString(parsed.session_id) ? parsed.session_id : null
  const observedAt = nonEmptyString(parsed.observed_at) && ISO_WITH_ZONE.test(parsed.observed_at) ? parsed.observed_at : null
  const maxMembers = isPositiveInteger(parsed.max_members) ? parsed.max_members : null
  const maxActiveSubagents = isPositiveInteger(parsed.max_active_subagents) ? parsed.max_active_subagents : null
  const usedAtObservation = isNonNegativeInteger(basis.used_at_observation) ? basis.used_at_observation : null
  const hostCode = nonEmptyString(basis.host_code) ? basis.host_code : null
  const problems: string[] = []
  if (parsed.schema_version !== OBSERVED_SCHEMA_VERSION) problems.push(`schema_version 必须是 ${OBSERVED_SCHEMA_VERSION}`)
  if (observedSessionId === null) problems.push('session_id 必须是非空字符串')
  if (observedAt === null) problems.push('observed_at 必须是带时区的 ISO 8601 时间')
  if (maxMembers === null) problems.push('max_members 必须是 >=1 的整数')
  if (maxActiveSubagents === null) problems.push('max_active_subagents 必须是 >=1 的整数')
  if (usedAtObservation === null) problems.push('basis.used_at_observation 必须是 >=0 的整数')
  if (hostCode === null) problems.push('basis.host_code 必须是非空字符串')
  if (problems.length > 0
    || observedSessionId === null || observedAt === null || maxMembers === null
    || maxActiveSubagents === null || usedAtObservation === null || hostCode === null) {
    return {
      record: null,
      gap: gap(
        'CAPACITY_OBSERVED_INVALID',
        `${OBSERVED_CAPACITY_PATH} 字段不合法：${problems.join('；')}`,
        '按 T18 的形状重写该文件，或删掉它按「容量未知」处理；不要手改出一个没观测过的上限',
      ),
      applies: false,
    }
  }

  const record: ObservedCapacityRecord = {
    schema_version: OBSERVED_SCHEMA_VERSION,
    session_id: observedSessionId,
    observed_at: observedAt,
    max_members: maxMembers,
    max_active_subagents: maxActiveSubagents,
    basis: {
      used_at_observation: usedAtObservation,
      host_code: hostCode,
    },
  }

  // 会话不一致或无法确定当前会话 → 不套用（席位随会话重置）。
  if (sessionId === null || sessionId !== record.session_id) {
    const mine = sessionId === null ? '当前调用拿不到会话身份' : `当前会话是 ${sessionId}`
    return {
      record,
      applies: false,
      gap: gap(
        'CAPACITY_OBSERVED_OTHER_SESSION',
        `${OBSERVED_CAPACITY_PATH} 记录的会话是 ${record.session_id}（${mine}）：席位随会话重置，这个观测值不套用`,
        '在本会话里重新声明容量（re/team/capacity.json 或本次调用传 capacity），或让本会话的一次真实派发撞出上限；不要复用旧会话的观测值',
      ),
    }
  }
  return { record, gap: null, applies: true }
}

/** 原子写观测值；返回项目内相对路径。 */
export async function writeObservedCapacity(root: string, record: ObservedCapacityRecord): Promise<string> {
  await writeJsonAtomic(resolveInProject(root, OBSERVED_CAPACITY_PATH), record)
  return OBSERVED_CAPACITY_PATH
}

/** 读「观测中」标记（缺失/坏 JSON 都不抛）。 */
export async function readObservationMarker(root: string): Promise<ObservationMarker> {
  let text: string
  try {
    text = await readFile(resolveInProject(root, OBSERVING_MARKER_PATH), 'utf8')
  } catch {
    // 缺失（以及任何读失败）都按「没有标记」处理：标记是本地并发提示，不是宿主事实。
    return { present: false, session_id: null, member: null, started_at: null, operation_id: null, malformed: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { present: true, session_id: null, member: null, started_at: null, operation_id: null, malformed: true }
  }
  const view = recordOf(parsed)
  return {
    present: true,
    session_id: nonEmptyString(view.session_id) ? view.session_id : null,
    member: nonEmptyString(view.member) ? view.member : null,
    started_at: nonEmptyString(view.started_at) ? view.started_at : null,
    operation_id: nonEmptyString(view.operation_id) ? view.operation_id : null,
    malformed: !isRecord(parsed),
  }
}

/** 写「观测中」标记（spawn 之前；结束/失败后由调用方删除）。 */
export async function writeObservationMarker(
  root: string,
  marker: { sessionId: string | null; member: string; operationId: string; startedAt: string },
): Promise<void> {
  await writeJsonAtomic(resolveInProject(root, OBSERVING_MARKER_PATH), {
    schema_version: 1,
    session_id: marker.sessionId,
    started_at: marker.startedAt,
    member: marker.member,
    operation_id: marker.operationId,
  })
}

/** 删「观测中」标记（不存在不算错）。 */
export async function clearObservationMarker(root: string): Promise<void> {
  try {
    await unlink(resolveInProject(root, OBSERVING_MARKER_PATH))
  } catch (error) {
    if (thrownCode(error) !== 'ENOENT') throw error
  }
}

/** 「观测中」标记是否应该挡住本次派发。 */
export interface MarkerGuard {
  blocked: boolean
  reason: string | null
  next_step: string | null
  /** 标记属于别的会话（不挡，但要如实报告）。 */
  foreign: boolean
}

/**
 * 并发保护（ticket 第 3 节最后一条）：
 * 无已知容量 + 已有「观测中」标记 → 明确拒绝，避免并行撞出 N 个不可逆损失。
 *
 * 会话判定与观测值同口径：只有能证明「这是别的会话的标记」时才放行；证明不了（无 session_id、
 * 坏 JSON、本调用没有会话身份）一律按本会话处理 —— 拒绝的代价是多等一次，放行的代价是烧名字。
 */
export function capacityMarkerGuard(marker: ObservationMarker, sessionId: string | null): MarkerGuard {
  if (!marker.present) return { blocked: false, reason: null, next_step: null, foreign: false }
  const sameSession = sessionId !== null && marker.session_id !== null && marker.session_id === sessionId
  const provablyForeign = sessionId !== null && marker.session_id !== null && marker.session_id !== sessionId
  if (provablyForeign) {
    return {
      blocked: false,
      reason: `${OBSERVING_MARKER_PATH} 是会话 ${marker.session_id} 留下的（当前会话 ${sessionId}）：席位随会话重置，本次不按「观测中」拒绝`,
      next_step: '确认旧会话的那次派发已结束；这个标记只会被本会话的下一次观测覆盖，不参与宿主判定',
      foreign: true,
    }
  }
  const who = sameSession ? `当前会话 ${String(sessionId)}` : '当前会话（标记里没有可用的 session_id）'
  const member = marker.member ?? '（未记录成员名）'
  const startedAt = marker.started_at ?? '（未记录时间）'
  return {
    blocked: true,
    reason:
      `容量仍未声明，但 ${OBSERVING_MARKER_PATH} 显示上一次派发正在观测宿主上限`
      + `（成员 ${member}，开始于 ${startedAt}，${who}）：现在再派发可能再撞一次、再烧一个成员名与席位`,
    next_step:
      `等那次派发结束（它会把观测值写进 ${OBSERVED_CAPACITY_PATH} 并删除标记）后再派发；`
      + `若确认那次派发已经死了，先核对成员名册里 ${member} 是否已存在/失败，再手工删除 ${OBSERVING_MARKER_PATH} 重试`,
    foreign: false,
  }
}

/** `resolveCapacity()` 的入参：上层只给「适配器读到的声明」与「本次调用声明」。 */
export interface ResolveCapacityInput {
  call: CallCapacity | null
  declared: DeclaredCapacityView
  observed: ObservedRead
}

/** 容量来源的缺口（诊断用；`capacity_source` 必须出现在 reason 里）。 */
export function capacitySourceGap(
  source: CapacitySource,
  limits: { max_members: number | null; max_active_subagents: number | null },
  observed: ObservedCapacityRecord | null,
): CapacityGap {
  if (source === 'call') {
    return gap(
      'CAPACITY_SOURCE',
      `容量来源 capacity_source=call：本次调用声明 maxMembers=${String(limits.max_members)}、`
      + `maxActiveSubagents=${String(limits.max_active_subagents)}（优先于 re/team/capacity.json 与 profile config.capacity）`,
      '换一个上限就用新的 capacity 重新 inspect（提议与生效上限绑定）；要让项目长期按这个上限跑，把它写进 re/team/capacity.json',
    )
  }
  if (source === 'observed') {
    const basis = observed === null
      ? ''
      : `（观测于 ${observed.observed_at}，宿主码 ${observed.basis.host_code}，观测当时已用 ${String(observed.basis.used_at_observation)} 席）`
    return gap(
      'CAPACITY_SOURCE',
      `容量来源 capacity_source=observed：本会话上一次派发撞到宿主上限时观测到的保守上限 `
      + `maxMembers=${String(limits.max_members)}、maxActiveSubagents=${String(limits.max_active_subagents)}${basis}`,
      `这是「你已经到顶了」的下限，不是宿主的真实声明：要放宽或写死上限请在 re/team/capacity.json（或本次调用传 capacity）声明；`
      + `不要靠再撞一次去试探余额`,
    )
  }
  return gap(
    'CAPACITY_SOURCE',
    '容量来源 capacity_source=unknown：re/team/capacity.json 与 profile config.capacity 都没有声明，本会话也还没有观测值',
    '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents（或本次调用传 capacity）；'
    + '未声明时 rt_dispatch 会照派，并在宿主拒绝时学一次上限（最多烧一个成员名与席位）',
  )
}

/**
 * 解析生效容量（纯函数，不做 IO）。
 *
 * 优先级：`call` > `project` > `profile` > `observed`（同会话）> `unknown`。
 * 适配器已经把「项目声明 > profile 声明」合过一次，`evidence.source` 只是来源标签。
 */
export function resolveCapacity({ call, declared, observed }: ResolveCapacityInput): EffectiveCapacity {
  const memberSlotsView = recordOf(declared.memberSlots)
  const activationsView = recordOf(declared.activations)
  const evidenceView = recordOf(declared.evidence)
  const used = typeof memberSlotsView.used === 'number' && Number.isSafeInteger(memberSlotsView.used)
    ? memberSlotsView.used
    : null
  const declaredSource = nonEmptyString(evidenceView.source) ? evidenceView.source : 'unavailable'
  const declaredMembers = typeof memberSlotsView.total === 'number' ? memberSlotsView.total : null
  const declaredActivations = typeof activationsView.total === 'number' ? activationsView.total : null

  let source: CapacitySource = 'unknown'
  let maxMembers: number | null = null
  let maxActiveSubagents: number | null = null
  let evidenceSource = declaredSource

  if (call !== null) {
    source = 'call'
    maxMembers = call.max_members
    maxActiveSubagents = call.max_active_subagents
    evidenceSource = 'call'
  } else if (declaredSource === 'declared:re/team/capacity.json' || declaredSource === 'declared:profile-config') {
    source = declaredSource === 'declared:profile-config' ? 'profile' : 'project'
    maxMembers = declaredMembers
    maxActiveSubagents = declaredActivations
  } else if (observed.record !== null && observed.applies) {
    source = 'observed'
    maxMembers = observed.record.max_members
    maxActiveSubagents = observed.record.max_active_subagents
    evidenceSource = 'observed'
  }

  const remaining = maxMembers !== null && used !== null ? Math.max(0, maxMembers - used) : null
  const memberSlots: MemberSlots = {
    known: remaining !== null,
    remaining,
    total: maxMembers,
    used,
  }
  // D25：activation 的当前占用没有受支持的只读查询 —— `remaining` 恒为 null，只声明上限。
  const activations: ActivationSlots = {
    known: maxActiveSubagents !== null,
    remaining: null,
    total: maxActiveSubagents,
  }

  const gaps: CapacityGap[] = []
  for (const raw of Array.isArray(declared.gaps) ? declared.gaps : []) {
    const entry = recordOf(raw)
    const code = nonEmptyString(entry.code) ? entry.code : 'CAPACITY_UNKNOWN'
    // 高层已经给出上限时，「没有声明」这条已经过时（否则诊断会自相矛盾）。
    if (source !== 'project' && source !== 'profile'
      && (code === 'CAPACITY_DECLARATION_MISSING' || code === 'CAPACITY_DECLARATION_INVALID')) {
      continue
    }
    gaps.push(gap(
      code,
      nonEmptyString(entry.detail) ? entry.detail : '容量声明或计数不可用',
      nonEmptyString(entry.nextStep) ? entry.nextStep : '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents 后重试',
    ))
  }
  if (observed.gap !== null) gaps.push(observed.gap)
  // 项目/profile 声明是既有行为（D1）：不加新诊断，保证已声明容量的项目输出逐字不变。
  if (source === 'call' || source === 'observed' || source === 'unknown') {
    gaps.push(capacitySourceGap(source, { max_members: maxMembers, max_active_subagents: maxActiveSubagents }, observed.record))
  }

  return {
    source,
    evidence_source: evidenceSource,
    memberSlots,
    activations,
    gaps,
    observed: observed.record,
  }
}
