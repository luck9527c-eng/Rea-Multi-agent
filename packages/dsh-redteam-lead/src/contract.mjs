/**
 * T6 派发契约：构建、持久化、任务板摘要与交付信封。
 *
 * 契约（编排契约「交付、开始和结果分类」「锚点与封存绑定」「操作阶段与部分失败」）：
 *
 * - **完整契约先落盘**：`re/team/dispatches/<dispatch-id>.json`，不可变、独占创建。
 *   文件字节的 SHA256 就是 `contract_sha256`（因此契约文件**不**内嵌自己的哈希）。
 *   重试（`retry_of`）新增 attempt 时写 `<dispatch-id>.<attempt-id>.json`，不改旧文件。
 * - **任务板只放摘要**：`subject` ≤200、`description` ≤16384（宿主按 trim 后 UTF-16 计）。
 * - **交付信封按引用**：消息里只有 dispatch/attempt/task/revision、契约路径 + SHA256、
 *   工作目录与项目规则入口；正文永不进消息。计量口径是宿主实际那一串
 *   `[{type:'text',text:'Team message from <name>:'}, ...content]` 的 UTF-8 字节（D9），
 *   上限 65536，实现按字节算并留余量（超长契约通过引用交付，不截断）。
 * - **本 attempt 的工作目录**：`re/team/work/<dispatch-id>/<attempt-id>`；任何越界、
 *   绝对路径、`..`、反斜杠、ADS、junction 逃逸都是 `PATH_INVALID`。
 * - **baseline_ref 必须有真实目标字节哈希**：首次目标尚无 seal 时 `preexisting_seals=[]`，
 *   但不能拿空清单代替目标身份。
 *
 * 本模块是纯构建 + 少量明确的 I/O 边界（`persistContract` / `ensureWorkDir` /
 * `captureBaseline` / attempt 记录），I/O 一律走 `atomic` / `paths`。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from './errors.mjs'
import * as defaultPaths from './paths.mjs'

/** 不可变契约目录。 */
export const DISPATCHES_DIR = 're/team/dispatches'
/** attempt 本地记录目录（dispatch/attempt → task/member 的恢复关联）。 */
export const ATTEMPTS_DIR = 're/team/attempts'
/** 成员工作区根。 */
export const WORK_DIR_BASE = 're/team/work'

/** 宿主任务板字段上限（编排契约「派发契约字段」）。 */
export const MAX_SUBJECT_CHARS = 200
export const MAX_DESCRIPTION_CHARS = 16384

/** `send_message` 单条上限与余量（D9：计量含 `Team message from <name>:` 前缀，比较是 `>`）。 */
export const MAX_MESSAGE_BYTES = 65536
export const MESSAGE_HEADROOM_BYTES = 4096

/** 路线状态枚举（`$defs.routeStatus`）。 */
export const ROUTE_STATUSES = Object.freeze([
  'planned',
  'active',
  'blocked',
  'paused',
  'validated',
  'falsified',
  'superseded',
])

/** 只有这两种状态是「已建立、尚未收口的可执行问题」。 */
export const DISPATCHABLE_ROUTE_STATUSES = Object.freeze(['planned', 'active'])

/** 契约里必须写死的三条行为规矩（编排契约「派发契约字段」）。 */
export const WORK_RULES = Object.freeze([
  '边干边落盘：每次观察/结论立刻写进本 attempt 工作区，别攒到最后一次性交回。',
  '卡住就交具体问题：不要交「没搞出来」，交可执行的技术问题、已排除的路径和所需条件。',
  '缺工具就报缺：所需通道/入口缺失时立即报回 Lead，不要自己找替代方案或静默降级。',
])

const DISPATCH_ID = /^D-[a-z0-9][a-z0-9_-]{0,63}$/u
const ATTEMPT_ID = /^A-[0-9]{6}$/u
const ROUTE_ID = /^R-[A-Za-z0-9_-]+$/u
const SHA256 = /^[0-9a-f]{64}$/u

const PATH_NEXT_STEP =
  '只使用本次尝试分配目录 re/team/work/<dispatch-id>/<attempt-id>/ 内的相对路径，不要传绝对路径、.. 、反斜杠或 ADS'

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 键排序后的稳定 JSON（用于摘要与去重，不用于人读文件）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function pathInvalid(message, details) {
  return new ContractError({ code: 'PATH_INVALID', message, nextStep: PATH_NEXT_STEP, details })
}

function invalid(message, nextStep) {
  return new ContractError({ code: 'INVALID_ARGUMENT', message, nextStep })
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

// ---------------------------------------------------------------------------
// 标识推导
// ---------------------------------------------------------------------------

/**
 * 由 operation_id 稳定派生 dispatch_id（`^D-[a-z0-9][a-z0-9_-]{0,63}$`）。
 *
 * 同一 operation 必须得到同一 dispatch（否则重入会写第二份契约）；不同 operation
 * 用 8 位摘要区分，避免截断后撞名。
 *
 * @param {string} operationId
 * @returns {string}
 */
export function dispatchIdFor(operationId) {
  if (!nonEmpty(operationId)) {
    throw invalid('dispatch ID 需要一个非空的 operation_id', '传入 $defs.id 形状的 operation_id')
  }
  const slug = operationId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 40) || 'op'
  const id = `D-${slug}-${sha256Text(operationId).slice(0, 8)}`
  if (!DISPATCH_ID.test(id)) {
    throw invalid(`派生出的 dispatch_id 不合法: ${id}`, '检查 operation_id 的字符集')
  }
  return id
}

/**
 * 尝试序号 → `A-000001`（`$defs.attemptId`）。
 * @param {number} index 从 1 开始
 */
export function attemptIdOf(index) {
  if (!Number.isInteger(index) || index < 1 || index > 999999) {
    throw invalid(`attempt 序号必须是 1..999999 的整数: ${JSON.stringify(index)}`, '从 1 开始按序递增')
  }
  return `A-${String(index).padStart(6, '0')}`
}

/**
 * 契约文件的项目内路径。第 1 次尝试沿用 `<dispatch-id>.json`（ticket 的固定路径），
 * 重试追加 attempt 后缀，绝不覆盖首份契约。
 */
export function contractRefFor(dispatchId, attemptId, attemptIndex = 1) {
  if (!DISPATCH_ID.test(String(dispatchId))) {
    throw invalid(`dispatch_id 不合法: ${JSON.stringify(dispatchId)}`, '用 dispatchIdFor() 派生')
  }
  if (!ATTEMPT_ID.test(String(attemptId))) {
    throw invalid(`attempt_id 不合法: ${JSON.stringify(attemptId)}`, '用 attemptIdOf() 生成')
  }
  return Number(attemptIndex) <= 1
    ? `${DISPATCHES_DIR}/${dispatchId}.json`
    : `${DISPATCHES_DIR}/${dispatchId}.${attemptId}.json`
}

/** attempt 本地记录路径（dispatch/attempt → task/member 的恢复关联）。 */
export function attemptRefFor(dispatchId, attemptId) {
  return `${ATTEMPTS_DIR}/${dispatchId}.${attemptId}.json`
}

/** 本次尝试的工作目录（项目内相对路径，无尾随 `/`：`$defs.path` 不允许空段）。 */
export function workDirFor(dispatchId, attemptId) {
  if (!DISPATCH_ID.test(String(dispatchId))) {
    throw invalid(`dispatch_id 不合法: ${JSON.stringify(dispatchId)}`, '用 dispatchIdFor() 派生')
  }
  if (!ATTEMPT_ID.test(String(attemptId))) {
    throw invalid(`attempt_id 不合法: ${JSON.stringify(attemptId)}`, '用 attemptIdOf() 生成')
  }
  return `${WORK_DIR_BASE}/${dispatchId}/${attemptId}`
}

/** 提交清单的默认落点（必须在本 attempt 目录内）。 */
export function submissionRefFor(dispatchId, attemptId) {
  return `${workDirFor(dispatchId, attemptId)}/submission.json`
}

/** RUN ID 预留（`^RUN-[A-Za-z0-9_-]+$`）；真正封存由 Lead 在收口时做。 */
export function runIdReservationFor(dispatchId, attemptId) {
  return `RUN-${dispatchId}-${attemptId}`
}

// ---------------------------------------------------------------------------
// 路线投影
// ---------------------------------------------------------------------------

/**
 * 路线的目标集合。项目 skill 的记录允许 `target_ids` 或 `targets`（字符串或对象）两种登记，
 * 两种都认；都不存在时返回空数组（由调用方拒绝）。
 *
 * @param {unknown} route
 * @returns {string[]}
 */
export function routeTargetIds(route) {
  if (!route || typeof route !== 'object') return []
  const raw = Array.isArray(route.target_ids)
    ? route.target_ids
    : (Array.isArray(route.targets) ? route.targets : [])
  const ids = []
  for (const item of raw) {
    const id = typeof item === 'string' ? item : (item && typeof item.id === 'string' ? item.id : null)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 路线内容摘要（完整内容的 SHA256，用于契约里的「路线版本」）。 */
export function routeDigest(route) {
  return sha256Text(canonicalJson(route ?? null))
}

/**
 * 判定一条路线是否是「已由 Lead 按 skill 建立、尚未收口的可执行问题」。
 *
 * 不是真值判定：这里只读记录，不推断结论；返回的 `code` 是 caller 用来无副作用拒绝的稳定码。
 *
 * @param {unknown} route `projectAdapter.readRoute()` 的内容
 * @returns {{ dispatchable: boolean, code: string|null, reason: string, next_step: string,
 *             status?: string, target_ids?: string[] }}
 */
export function classifyRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return {
      dispatchable: false,
      code: 'PROJECT_NOT_CONFIGURED',
      reason: '路线记录不是对象，无法确认它是 skill 建立的可执行问题',
      next_step: '先按项目 skill 建立 re/routes/<id>.json（路线、问题、判据、目标、预算）',
    }
  }
  const id = typeof route.id === 'string' ? route.id : (typeof route.route_id === 'string' ? route.route_id : null)
  if (id === null || !ROUTE_ID.test(id)) {
    return {
      dispatchable: false,
      code: 'PROJECT_NOT_CONFIGURED',
      reason: `路线记录缺少合法的 id（实际 ${JSON.stringify(route.id)}）`,
      next_step: '按 skill 修正路线记录的 id（^R-[A-Za-z0-9_-]+$）',
    }
  }
  const status = route.status
  if (!ROUTE_STATUSES.includes(status)) {
    return {
      dispatchable: false,
      code: 'PROJECT_NOT_CONFIGURED',
      reason: `路线 ${id} 的状态不在 skill 枚举内: ${JSON.stringify(status)}`,
      next_step: `按 skill 把路线状态改成 ${ROUTE_STATUSES.join('|')} 之一，再重新派发`,
    }
  }
  if (!DISPATCHABLE_ROUTE_STATUSES.includes(status)) {
    const recoverable = status === 'blocked' || status === 'paused'
    return {
      dispatchable: false,
      code: recoverable ? 'RECOVERY_REQUIRED' : 'PROJECT_NOT_CONFIGURED',
      reason: `路线 ${id} 的状态是 ${status}，不是可派发的可执行问题`,
      next_step: recoverable
        ? `先按 skill 处置路线 ${id} 的阻塞/暂停与恢复待办，再重新派发；v0 不建等待派发队列`
        : `路线 ${id} 已是 ${status}：结论类状态请另开新路线，或修正状态后重新派发`,
    }
  }
  const targetIds = routeTargetIds(route)
  if (targetIds.length === 0) {
    return {
      dispatchable: false,
      code: 'PROJECT_NOT_CONFIGURED',
      reason: `路线 ${id} 没有登记任何目标，无法确认本次派发的目标属于它`,
      next_step: '按 skill 在路线记录里登记 targets/target_ids，再重新派发',
    }
  }
  return { dispatchable: true, code: null, reason: '', next_step: '', status, target_ids: targetIds }
}

/** 契约里的路线投影：版本（摘要）+ 问题/判据/预算 + 依赖，不复制事实层。 */
export function routeProjection(route) {
  const projected = {
    id: route?.id ?? route?.route_id ?? null,
    status: route?.status ?? null,
    digest: routeDigest(route),
    target_ids: routeTargetIds(route),
  }
  for (const key of ['problem', 'hypothesis', 'criteria', 'budget', 'depends_on', 'closure', 'conditions']) {
    if (route && route[key] !== undefined) projected[key] = route[key]
  }
  return projected
}

// ---------------------------------------------------------------------------
// 要求合并（只追加）
// ---------------------------------------------------------------------------

function unionOf(base, extra) {
  const out = []
  for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (typeof value !== 'string' || value.trim().length === 0) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 岗位目录默认要求 ∪ 任务追加要求。**只追加**：传空数组不会删掉模板需求
 * （编排契约「工具输入与输出」：`evidence_required`/`prohibited`/`capability_needs` 都只追加）。
 *
 * @param {object} post 岗位目录条目（`required`/`optional`/`anchors_required`/`prohibited`）
 * @param {object} input 任务输入
 */
export function mergeRequirements(post, input = {}) {
  return {
    evidence_required: unionOf(post?.anchors_required, input?.evidence_required),
    prohibited: unionOf(post?.prohibited, input?.prohibited),
    capability_needs: unionOf(post?.required, input?.capability_needs),
    optional: unionOf(post?.optional, []),
  }
}

// ---------------------------------------------------------------------------
// 任务板摘要
// ---------------------------------------------------------------------------

/**
 * 任务板 `subject`/`description`：只放摘要（路线/派发/尝试标记、契约摘要哈希、operation_id）。
 *
 * 长度按 trim 后的 UTF-16 长度计算；objective 只截取开头，正文永远留在契约文件里。
 */
export function buildTaskSummary({
  postId,
  routeId,
  targetIds,
  dispatchId,
  attemptId,
  operationId,
  contractRef,
  contractSha256,
  workDir,
  objective,
  attemptIndex = 1,
}) {
  const targets = Array.isArray(targetIds) ? targetIds.join(',') : String(targetIds ?? '')
  const subject = `[rt_dispatch] ${postId} ${routeId} ${targets}`.slice(0, MAX_SUBJECT_CHARS)
  const lines = [
    'rt_dispatch 摘要：完整契约在文件里，本条只用于任务板关联，不要凭它开工。',
    `dispatch=${dispatchId} attempt=${attemptId} attempt_index=${attemptIndex} operation=${operationId}`,
    `route=${routeId} post=${postId} targets=${targets}`,
    `contract_ref=${contractRef}`,
    `contract_sha256=${contractSha256}`,
    `work_dir=${workDir}`,
    `objective: ${String(objective ?? '').slice(0, 600)}`,
    '先读契约文件核对 SHA256、身份与资源分配，再在 work_dir 写 start.json；收到任务身份前不要开始实验。',
  ]
  return {
    subject,
    description: lines.join('\n').slice(0, MAX_DESCRIPTION_CHARS),
  }
}

// ---------------------------------------------------------------------------
// 交付信封
// ---------------------------------------------------------------------------

/**
 * 宿主实际计量的字节数：`[{type:'text',text:'Team message from <name>:'}, ...blocks]` 的 UTF-8 字节（D9）。
 *
 * @param {{ callerName: string, blocks: object[] }} input
 * @returns {number}
 */
export function measureMessageBytes({ callerName, blocks }) {
  const content = [
    { type: 'text', text: `Team message from ${callerName}:` },
    ...(Array.isArray(blocks) ? blocks : []),
  ]
  return Buffer.byteLength(JSON.stringify(content), 'utf8')
}

const DELIVERY_INSTRUCTIONS = Object.freeze([
  '读完契约文件、核对 contract_sha256 与自己的身份/资源分配，再在工作区写 start.json；收到任务身份前不要开始实验。',
  '契约正文在文件里，本消息只是引用；不要凭消息内容开工，也不要改写契约。',
  '边干边落盘；卡住就交回具体技术问题；缺工具就报缺。',
  '你没有派发权：缺人手或需要更多 activation 时报回 Lead，不要自己开下一层。',
])

/**
 * 组装交付信封。消息只含引用与摘要，超长契约不受消息长度限制：
 * 依次尝试带 objective 摘录、更短的摘录、只留身份与哈希；仍然超限才 `DELIVERY_FAILED`。
 *
 * @param {object} input 见 `deliveryArgs()`（内部使用）
 * @returns {{ ok: true, blocks: object[], text: string, bytes: number, envelope_id: string,
 *             dedupe_key: string, limit: number, headroom: number, trimmed: string[] }
 *           | { ok: false, code: 'DELIVERY_FAILED', bytes: number, limit: number, reason: string }}
 */
export function buildDeliveryEnvelope(input = {}) {
  const {
    callerName,
    member,
    dispatchId,
    attemptId,
    taskId,
    taskRevision,
    routeId,
    postId,
    contractRef,
    contractSha256,
    workDir,
    runIdReservation,
    objective = '',
    rulesEntry,
    skillCopyPath,
    maxBytes = MAX_MESSAGE_BYTES,
    headroomBytes = MESSAGE_HEADROOM_BYTES,
  } = input

  const required = {
    callerName, member, dispatchId, attemptId, taskId, contractRef, contractSha256, workDir, rulesEntry,
  }
  for (const [field, value] of Object.entries(required)) {
    if (!nonEmpty(value)) {
      throw invalid(`交付信封缺少 ${field}`, '由 handleDispatch 组装完整信封后再发送')
    }
  }
  if (!SHA256.test(contractSha256)) {
    throw invalid(`contract_sha256 必须是 64 位小写十六进制: ${contractSha256}`, '用契约文件字节的 SHA256')
  }

  const base = {
    schema_version: 1,
    kind: 'rt_dispatch_delivery',
    from: callerName,
    to: member,
    dispatch_id: dispatchId,
    attempt_id: attemptId,
    task_id: taskId,
    task_revision: taskRevision,
    route_id: routeId,
    post_id: postId,
    contract_ref: contractRef,
    contract_sha256: contractSha256,
    work_dir: workDir,
    run_id_reservation: runIdReservation,
    dedupe_key: `${dispatchId}:${attemptId}`,
    project_rules: { entry: rulesEntry, ...(nonEmpty(skillCopyPath) ? { skill: skillCopyPath } : {}) },
    instructions: [...DELIVERY_INSTRUCTIONS],
  }

  const variants = [
    { payload: { ...base, objective_excerpt: String(objective ?? '').slice(0, 1200) }, tag: 'full' },
    { payload: { ...base, objective_excerpt: String(objective ?? '').slice(0, 240) }, tag: 'short' },
    { payload: base, tag: 'hashes-only' },
  ]

  const limit = maxBytes
  const budget = limit - Math.max(0, headroomBytes)
  const trimmed = []
  let lastBytes = 0
  for (const variant of variants) {
    const envelopeId = sha256Text(canonicalJson(variant.payload))
    const payload = { ...variant.payload, envelope_id: envelopeId }
    const text = JSON.stringify(payload)
    const blocks = [{ type: 'text', text }]
    const bytes = measureMessageBytes({ callerName, blocks })
    lastBytes = bytes
    if (bytes <= budget) {
      return {
        ok: true,
        blocks,
        text,
        bytes,
        envelope_id: envelopeId,
        dedupe_key: base.dedupe_key,
        limit,
        headroom: limit - bytes,
        trimmed,
        variant: variant.tag,
      }
    }
    trimmed.push(variant.tag)
  }

  return {
    ok: false,
    code: 'DELIVERY_FAILED',
    bytes: lastBytes,
    limit,
    reason: `交付信封 ${lastBytes} 字节仍超上限 ${limit}（已去掉正文摘录）：检查 dispatch_id/contract_ref 长度`,
  }
}

/** 组成成员 bootstrap prompt：只载入角色、项目规则入口与「等待任务」，不载契约。 */
export function buildMemberPrompt({ post, rulesEntry, skillCopyPath }) {
  const display = post?.display_name ?? post?.id ?? '团队成员'
  const postId = post?.id ?? 'unknown'
  const focus = nonEmpty(post?.focus) ? post.focus : '按 Lead 派发的契约执行本岗位工作'
  const lines = [
    `你是「${display}」岗位的团队成员（post=${postId}）。`,
    `职责：${focus}`,
    `项目规则入口：${rulesEntry}`,
  ]
  if (nonEmpty(skillCopyPath)) lines.push(`项目 skill 副本：${skillCopyPath}`)
  lines.push(
    '现在只做三件事：读项目规则、确认自己的身份、然后等待 Lead 的任务交付。',
    '在收到任务身份与契约之前不要开始任何实验，不要写产物，不要读取目标。',
    '你没有派发权：缺人手、缺工具或需要更多 activation 时报回 Lead，不要自己开下一层。',
  )
  return lines.join('\n')
}

/** 契约里的三条行为规矩（含本次工作目录）。 */
export function buildWorkRules({ workDir }) {
  return WORK_RULES.map((rule) => (nonEmpty(workDir) ? `${rule}（工作目录 ${workDir}）` : rule))
}

// ---------------------------------------------------------------------------
// 路径校验（本 attempt 目录）
// ---------------------------------------------------------------------------

/**
 * 校验 `work_dir` 恰好是本次尝试的分配目录。
 *
 * @param {{ root: string, dispatchId: string, attemptId: string, candidate: unknown }} input
 * @returns {Promise<string>}
 */
export async function assertAttemptDir({ root, dispatchId, attemptId, candidate }) {
  const expected = workDirFor(dispatchId, attemptId)
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw pathInvalid(`work_dir 缺失或不是字符串: ${JSON.stringify(candidate)}`)
  }
  // 先做通用校验，好让「绝对路径/反斜杠/ADS」得到准确的拒绝理由
  try {
    defaultPaths.assertProjectRelative(candidate)
  } catch (error) {
    throw pathInvalid(`work_dir 不合法: ${error.message}`)
  }
  if (candidate !== expected) {
    throw pathInvalid(
      `work_dir 必须是本次尝试的分配目录 ${expected}，实际 ${candidate}；不接受任意共享写入路径`,
    )
  }
  await defaultPaths.assertSafeWriteTarget(root, expected)
  await defaultPaths.assertNoCaseCollision(root, expected)
  return expected
}

/**
 * 校验任意路径（典型是 `submission_ref`）严格落在本次尝试目录内。
 *
 * @param {{ root: string, dispatchId: string, attemptId: string, candidate: unknown,
 *           label?: string }} input
 * @returns {Promise<string>} 通过校验的项目内相对路径
 */
export async function assertAttemptPath({ root, dispatchId, attemptId, candidate, label = 'path' }) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw pathInvalid(`${label} 缺失或不是字符串: ${JSON.stringify(candidate)}`)
  }
  let relative
  try {
    relative = defaultPaths.assertProjectRelative(candidate)
  } catch (error) {
    throw pathInvalid(`${label} 不是合法的项目内相对路径: ${error.message}`)
  }
  const dir = workDirFor(dispatchId, attemptId)
  if (!relative.startsWith(`${dir}/`)) {
    throw pathInvalid(
      `${label} 必须落在本次尝试目录 ${dir}/ 内，实际 ${relative}；禁止越界或指向别的 attempt`,
    )
  }
  await defaultPaths.assertSafeWriteTarget(root, relative)
  return relative
}

/** 建（或复用）本次尝试的工作目录，返回项目内相对路径。 */
export async function ensureWorkDir({ root, dispatchId, attemptId, paths = defaultPaths }) {
  const dir = workDirFor(dispatchId, attemptId)
  await paths.assertSafeWriteTarget(root, dir)
  await paths.assertNoCaseCollision(root, dir)
  await mkdir(join(root, ...dir.split('/')), { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 契约组装
// ---------------------------------------------------------------------------

/**
 * 组装完整派发契约（不可变文件的内容）。
 *
 * 契约**不内嵌自己的 `contract_sha256`** —— 哈希就是文件字节的 SHA256，
 * 回执/交付信封/台账里引用它，因此「回执里的哈希与文件字节一致」永远成立。
 *
 * @param {object} input
 * @returns {{ contract: object, ref: string, text: string, sha256: string, bytes: number }}
 */
export function buildContract(input = {}) {
  const {
    dispatchId,
    attemptId,
    attemptIndex = 1,
    operationId,
    createdAt,
    projectRoot,
    binding = null,
    post,
    route,
    targets = [],
    baselineRef,
    objective,
    requirements = {},
    capabilityMatch = null,
    resources = [],
    dependsOnTasks = [],
    timeboxMs = 1800000,
    deliveryTimeoutMs = 60000,
    workDir,
    runIdReservation,
    contractRef,
    retryOf = null,
    caller = null,
  } = input

  for (const [field, value] of Object.entries({ post, route, baselineRef, workDir, runIdReservation, contractRef })) {
    if (value === null || value === undefined) {
      throw invalid(`组装契约缺少 ${field}`, '由 handleDispatch 的 preflight 结果补齐后再落盘')
    }
  }
  if (!Array.isArray(baselineRef.targets) || baselineRef.targets.length === 0) {
    throw new ContractError({
      code: 'BASELINE_MISMATCH',
      message: '契约的 baseline_ref 没有冻结任何目标字节哈希',
      nextStep: '先按 skill 登记目标字节哈希/样本路径；不能用空清单代替目标身份',
    })
  }
  if (!Array.isArray(baselineRef.preexisting_seals)) {
    throw invalid('契约的 baseline_ref.preexisting_seals 必须是数组（首次无 seal 时为 []）', '重跑 captureBaseline')
  }

  const contract = {
    schema_version: 1,
    contract_kind: 'rt_dispatch',
    contract_version: 1,
    dispatch_id: dispatchId,
    attempt_id: attemptId,
    attempt_index: attemptIndex,
    operation_id: operationId,
    created_at: createdAt,
    created_by: caller,
    retry_of: retryOf,
    route_id: route?.id ?? route?.route_id ?? null,
    post_id: post.id,
    target_ids: targets.map((target) => (typeof target === 'string' ? target : target?.id)).filter(Boolean),
    project: { root: projectRoot, binding },
    post: {
      id: post.id,
      display_name: post.display_name ?? post.id,
      focus: post.focus ?? null,
      priority: post.priority ?? null,
      required: [...(post.required ?? [])],
      optional: [...(post.optional ?? [])],
      anchors_required: [...(post.anchors_required ?? [])],
    },
    route: routeProjection(route),
    targets,
    objective,
    question: route?.problem ?? null,
    hypothesis: route?.hypothesis ?? null,
    criteria: route?.criteria ?? null,
    budget: {
      timebox_ms: timeboxMs,
      delivery_timeout_ms: deliveryTimeoutMs,
      route_budget: route?.budget ?? null,
      stop_conditions: [
        '前提失效（目标字节/条件/争议变化）立即停手并交回具体问题',
        `超过 timebox_ms=${timeboxMs} 或无法在 ${deliveryTimeoutMs}ms 内确认开始时报回 Lead`,
      ],
    },
    evidence_required: [...(requirements.evidence_required ?? [])],
    prohibited: [...(requirements.prohibited ?? [])],
    capability_needs: [...(requirements.capability_needs ?? [])],
    capability_optional: [...(requirements.optional ?? [])],
    capability_match: capabilityMatch,
    resources,
    depends_on_tasks: [...dependsOnTasks],
    baseline_ref: baselineRef,
    work_dir: workDir,
    run_id_reservation: runIdReservation,
    contract_ref: contractRef,
    work_rules: buildWorkRules({ workDir }),
    authority: {
      dispatchable: false,
      reason: '你没有派发权：缺人手、缺工具或需要更多 activation 时报回 Lead，不要自己开下一层（D5）',
    },
    submission: {
      ref: submissionRefFor(dispatchId, attemptId),
      confine_to: workDir,
      required_fields: [
        'schema_version', 'dispatch', 'attempt', 'task', 'contract_sha256', 'outcome',
        'summary', 'run_ids', 'artifacts', 'anchor_refs', 'blocker', 'state_recovery_ref', 'submitted_at',
      ],
    },
    delivery: {
      by_reference: true,
      max_message_bytes: MAX_MESSAGE_BYTES,
      dedupe_key: `${dispatchId}:${attemptId}`,
      note: '完整契约只存文件；成员按 dispatch/attempt 去重，一次任务最多启动一次',
    },
    start_ack: {
      file: `${workDir}/start.json`,
      note: 'delivered 只表示宿主收到消息；成员写 start.json 后 Lead 下一轮才记录 started_at',
    },
  }

  const serialized = serializeContract(contract)
  return { contract, ref: contractRef, ...serialized }
}

/**
 * 读回成员写下的 `start.json`（`delivered` 不代表已开始）。
 *
 * 只有文件存在、能解析、`attempt` 与本次一致且 `at` 是带时区的 ISO 时间时，才返回该时间；
 * 其余一律 `null`（尚未开始，或确认书不合法）。
 *
 * @param {{ root: string, dispatchId: string, attemptId: string }} input
 * @returns {Promise<string | null>}
 */
export async function readStartAck({ root, dispatchId, attemptId }) {
  const relative = `${workDirFor(dispatchId, attemptId)}/start.json`
  let parsed
  try {
    const text = await readFile(join(root, ...relative.split('/')), 'utf8')
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (nonEmpty(parsed.attempt) && parsed.attempt !== attemptId) return null
  if (!nonEmpty(parsed.at)) return null
  const stamp = Date.parse(parsed.at)
  if (Number.isNaN(stamp)) return null
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(parsed.at)) return null
  return parsed.at
}

// ---------------------------------------------------------------------------
// 契约序列化与持久化
// ---------------------------------------------------------------------------

/**
 * 序列化契约：2 空格缩进 + 结尾换行，返回文本与**文件字节**的 SHA256。
 *
 * 契约文件不内嵌 `contract_sha256` —— 否则无法满足「回执里的哈希与文件字节一致」。
 */
export function serializeContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw invalid('契约必须是对象', '由 buildContract 组装')
  }
  const text = `${JSON.stringify(contract, null, 2)}\n`
  const bytes = Buffer.byteLength(text, 'utf8')
  return { text, bytes, sha256: sha256Text(text) }
}

/**
 * 不可变写入契约：独占创建；同内容幂等；异内容 `OPERATION_CONFLICT`（不覆盖既有证据）。
 *
 * @returns {Promise<{ ref: string, path: string, sha256: string, bytes: number, created: boolean }>}
 */
export async function persistContract({ root, ref, text, atomic, paths = defaultPaths }) {
  const absolute = await paths.assertSafeWriteTarget(root, ref)
  await paths.assertNoCaseCollision(root, ref)
  const bytes = Buffer.from(text, 'utf8')
  const sha256 = atomic.sha256Bytes(bytes)
  const result = await atomic.createExclusive(absolute, bytes)
  // 落盘后再核对一次，防止「校验后换内容」
  const verified = await atomic.verifyFileHash(absolute, sha256)
  return { ref, path: absolute, sha256, bytes: verified.bytes, created: result.created }
}

// ---------------------------------------------------------------------------
// baseline_ref
// ---------------------------------------------------------------------------

async function readProjectJson(root, relative) {
  try {
    const text = await readFile(join(root, ...relative.split('/')), 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error instanceof SyntaxError) {
      throw new ContractError({
        code: 'RECOVERY_REQUIRED',
        message: `${relative} 不是合法 JSON，无法冻结派发基准`,
        nextStep: '按恢复流程核对项目记录；不要当作「没有登记」继续派发',
      })
    }
    throw new ContractError({
      code: 'RECOVERY_REQUIRED',
      message: `读取 ${relative} 失败：${error?.code ?? error?.message ?? 'unknown'}`,
      nextStep: '确认项目根可读后重试；读取失败的既存项必须报错',
    })
  }
}

function targetRecordsOf(registry) {
  if (!registry || typeof registry !== 'object') return []
  if (Array.isArray(registry.targets)) return registry.targets
  if (Array.isArray(registry)) return registry
  return []
}

function hashOfTargetRecord(record) {
  for (const field of ['sha256', 'byte_sha256', 'bytes_sha256', 'hash']) {
    if (typeof record?.[field] === 'string' && SHA256.test(record[field])) return record[field]
  }
  return null
}

function pathOfTargetRecord(record) {
  for (const field of ['path', 'sample_path', 'file', 'artifact_path']) {
    if (nonEmpty(record?.[field])) return record[field]
  }
  return null
}

function sealTargetId(sealPath) {
  const matched = /^re\/seals\/targets\/(T-[A-Za-z0-9_-]+)\.json$/u.exec(String(sealPath))
  return matched === null ? null : matched[1]
}

function baselineFailure(reason, nextStep) {
  return {
    ok: false,
    code: 'BASELINE_MISMATCH',
    reason,
    next_step: nextStep,
    diagnostics: [{ code: 'BASELINE_MISMATCH', reason, next_step: nextStep }],
  }
}

/**
 * 冻结本次派发的基准：目标 ID + 真实字节哈希、相关既有 seal 的路径与哈希、依赖产物身份。
 *
 * 「真实目标哈希」优先用**实际字节**算出（并核对登记值），登记值与字节不一致即
 * `BASELINE_MISMATCH`；既没登记哈希也没有可读样本时同样拒绝 ——
 * `preexisting_seals=[]` 只表示「首次目标尚无 seal」，不表示「没有目标身份」。
 *
 * @param {{ root: string, targetIds: string[], projectAdapter: object, atomic: object,
 *           paths: object, now?: string, dependencyRunIds?: string[] }} input
 */
export async function captureBaseline(input) {
  const { root, targetIds, projectAdapter, atomic, dependencyRunIds = [] } = input
  const paths = input.paths ?? defaultPaths
  const now = nonEmpty(input.now) ? input.now : new Date().toISOString()
  const ids = [...new Set((Array.isArray(targetIds) ? targetIds : []).filter(nonEmpty))]
  if (ids.length === 0) {
    return baselineFailure('本次派发没有目标 ID，无法冻结基准', '在 target_ids 里给出该路线目标集合的非空子集')
  }

  const registry = await readProjectJson(root, 're/targets.json')
  const records = targetRecordsOf(registry)
  if (records.length === 0) {
    return baselineFailure(
      '项目没有 re/targets.json 目标登记，冻结不了任何目标身份',
      '先按项目 skill 登记目标（id + 字节哈希或可读样本路径），再派发',
    )
  }

  const frozen = []
  for (const targetId of ids) {
    const record = records.find((item) => item && (item.id === targetId || item.target_id === targetId))
    if (!record) {
      return baselineFailure(
        `目标 ${targetId} 未在 re/targets.json 登记`,
        `先按 skill 登记目标 ${targetId}（含字节哈希或可读样本路径），再派发`,
      )
    }
    const declared = hashOfTargetRecord(record)
    const relativePath = pathOfTargetRecord(record)
    if (relativePath === null) {
      if (declared === null) {
        return baselineFailure(
          `目标 ${targetId} 既没有登记字节哈希，也没有可读的样本路径：不能拿空清单代替目标身份`,
          `为 ${targetId} 登记 sha256，或在 re/targets.json 里给出可读的样本 path`,
        )
      }
      frozen.push({ id: targetId, sha256: declared, source: 'declared' })
      continue
    }

    let absolute
    if (/^[A-Za-z]:[\\/]/u.test(relativePath) || relativePath.startsWith('/')) {
      // 明确登记的外部样本：只读
      absolute = relativePath
    } else {
      const relative = paths.assertProjectRelative(relativePath)
      absolute = paths.resolveInProject(root, relative)
    }
    let actual
    try {
      actual = await atomic.sha256File(absolute)
    } catch (error) {
      if (declared !== null) {
        frozen.push({ id: targetId, sha256: declared, source: 'declared', path: relativePath, unreadable: true })
        continue
      }
      return baselineFailure(
        `目标 ${targetId} 的样本 ${relativePath} 读不到（${error?.code ?? 'unknown'}），也没有登记哈希`,
        `确认样本仍存在且可读，或为 ${targetId} 登记 sha256 后再派发`,
      )
    }
    const size = (await stat(absolute)).size
    if (declared !== null && declared !== actual) {
      return baselineFailure(
        `目标 ${targetId} 的登记哈希与样本实际字节不一致（登记 ${declared}，实际 ${actual}）`,
        `核对 ${relativePath} 是否被替换；按 skill 更新目标登记后再派发`,
      )
    }
    frozen.push({ id: targetId, sha256: actual, source: 'hashed', path: relativePath, bytes: size })
  }

  const sealsResult = await projectAdapter.readSeals()
  if (!sealsResult || sealsResult.ok !== true) {
    return {
      ok: false,
      code: sealsResult?.code ?? 'RECOVERY_REQUIRED',
      reason: `读取 re/seals 失败：${sealsResult?.reason ?? sealsResult?.code ?? 'unknown'}`,
      next_step: '确认项目根与 re/seals 可读；读取失败的既存项必须报错，不能当作没有 seal',
      diagnostics: [{
        code: sealsResult?.code ?? 'RECOVERY_REQUIRED',
        reason: `读取 re/seals 失败：${sealsResult?.reason ?? sealsResult?.code ?? 'unknown'}`,
        next_step: '确认项目根与 re/seals 可读后重试',
      }],
    }
  }

  const wantedRunSeals = new Set(dependencyRunIds.filter(nonEmpty))
  const preexisting = []
  for (const seal of Array.isArray(sealsResult.seals) ? sealsResult.seals : []) {
    if (!seal || !nonEmpty(seal.path)) continue
    const targetId = sealTargetId(seal.path)
    if (targetId !== null && ids.includes(targetId)) {
      preexisting.push({ path: seal.path, sha256: seal.sha256, bytes: seal.bytes })
      continue
    }
    const runMatched = /^re\/seals\/runs\/(RUN-[A-Za-z0-9_-]+)\.json$/u.exec(String(seal.path))
    if (runMatched !== null && wantedRunSeals.has(runMatched[1])) {
      preexisting.push({ path: seal.path, sha256: seal.sha256, bytes: seal.bytes })
    }
  }
  preexisting.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  return {
    ok: true,
    baseline_ref: {
      frozen_at: now,
      targets: frozen,
      preexisting_seals: preexisting,
      dependency_runs: [...wantedRunSeals].sort(),
      seal_scan: {
        total: Array.isArray(sealsResult.seals) ? sealsResult.seals.length : 0,
        matched: preexisting.length,
      },
    },
  }
}
