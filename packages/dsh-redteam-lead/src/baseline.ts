/**
 * 派发基准快照、封存复用与基准比对。
 *
 * 契约（编排契约「锚点与封存绑定」「操作阶段与部分失败」，规格「证据基线」）：
 * - 派发前冻结本次目标 ID/字节哈希、相关既有 seal 的**路径与字节哈希**、以及依赖产物的身份，
 *   保存为契约的 `baseline_ref`。首次目标尚无 seal 时 `preexisting_seals=[]`，
 *   但仍必须有真实目标哈希（不允许用空清单代替目标身份）。
 * - 收口先与该快照比较：既存项**删除/读取失败/内容变化**都是 `BASELINE_MISMATCH`，
 *   不能因为遍历当前目录时「没找到」而漏过。
 * - seal 是**一次性**的：已有封存只校验复用，绝不重封存、不覆盖旧 seal；
 *   封存用 skill 自己的基线与目标身份，**不以本次提交的新哈希替换旧期望值**。
 *
 * 本模块不跑 skill 算法：seal 走 `projectAdapter.seal`，读记录读文件。所有失败都返回
 * `{ok:false, code, ...}`，不抛异常。
 */

import { isAbsolute } from 'node:path'
import * as fsp from 'node:fs/promises'

import * as atomicModule from './atomic.js'
import * as defaultPaths from './paths.js'
import { isProjectRelative } from './paths.js'
import { recordOf, thrownCode, thrownMessage } from './guards.js'
import type { Diagnostic, FsLike } from './types.js'

/** 本模块用到的 `src/paths.mjs` 面（与 `deps.paths` 同一命名空间类型）。 */
type PathsModule = typeof import('./paths.js')

/** 注入的时钟：`isoNow` 缺省时退回 `now`。 */
interface ClockLike {
  isoNow?: () => string
  now: () => number
}

/**
 * 只声明本模块用到的那两个适配器方法。
 *
 * 结构上比 `ProjectAdapter` 更宽（返回值按 `unknown` 收），适配器实现怎么演进都能传进来；
 * 具体字段在本文件里用 `recordOf` 逐个收窄。
 */
interface ProjectAdapterLike {
  readSeals?: () => Promise<unknown>
  seal?: (input: { runId: string }) => Promise<unknown>
}

/** 基准快照目录（本插件所有，见 SEAMS §7）。 */
export const BASELINE_DIR = 're/team/baselines'

/** 快照版本。 */
export const BASELINE_SCHEMA_VERSION = 1

/** 目标清单（skill 所有，只读）。 */
export const TARGETS_PATH = 're/targets.json'

/** skill 的终端 RUN 状态（`project.py` 的 `TERMINAL_RUNS`）。 */
export const TERMINAL_RUNS: readonly string[] = Object.freeze(['completed', 'failed', 'timed_out', 'cancelled', 'interrupted'])

const SHA256 = /^[0-9a-f]{64}$/
const DISPATCH_ID = /^D-[a-z0-9][a-z0-9_-]{0,63}$/
const ATTEMPT_ID = /^A-[0-9]{6}$/

function issue(code: string, reason: string, nextStep: string): Diagnostic {
  return { code, reason, next_step: nextStep }
}

function failure(code: string, reason: string, nextStep: string): { ok: false, code: string, issues: Diagnostic[] } {
  return { ok: false, code, issues: [issue(code, reason, nextStep)] }
}

/**
 * `code` 优先、其次 `message`、再退回 `'unknown'` 的细节文本。
 *
 * 与原写法 `error?.code ?? error?.message ?? 'unknown'` 等价。
 */
function thrownDetail(thrown: unknown): string {
  const record = recordOf(thrown)
  const value = record.code ?? record.message
  return value === undefined || value === null ? 'unknown' : String(value)
}

/** 快照文件的项目内路径。 */
export function baselineRefFor(dispatchId: unknown): string {
  return `${BASELINE_DIR}/${dispatchId}.json`
}

/** seal 文件的项目内路径（`seal` 命令 O_EXCL 写的就是这两个目录之一）。 */
export function sealPathFor(runId: string): string {
  return `re/seals/runs/${runId}.json`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把「应该是对象数组」的值收成对象数组（非数组 → 空）。 */
function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item: unknown) => recordOf(item)) : []
}

/** 快照形状校验结果。 */
type BaselineShapeVerdict = { ok: true } | { ok: false, issues: Diagnostic[] }

/**
 * 校验快照形状。
 * @returns {{ ok: true } | { ok: false, issues: Array<object> }}
 */
export function validateBaselineShape(baseline: unknown): BaselineShapeVerdict {
  const issues: Diagnostic[] = []
  const bad = (reason: string, nextStep: string): void => { issues.push(issue('BASELINE_INVALID', reason, nextStep)) }

  if (!isPlainObject(baseline)) return { ok: false, issues: [issue('BASELINE_INVALID', '基准快照必须是对象', '重新冻结派发基准')] }
  if (baseline.schema_version !== BASELINE_SCHEMA_VERSION) bad(`基准快照 schema_version 必须是 ${BASELINE_SCHEMA_VERSION}`, '重新冻结派发基准')
  if (typeof baseline.dispatch_id !== 'string' || !DISPATCH_ID.test(baseline.dispatch_id)) bad('基准快照缺少合法 dispatch_id', '重新冻结派发基准')

  const targets = baseline.targets
  if (!Array.isArray(targets) || targets.length === 0) {
    bad(
      '基准快照必须至少冻结一个目标的真实字节哈希（不能用空清单代替目标身份）',
      '首次派发时把 target_ids 对应的 targets.json 条目（path + 实际 SHA256）冻进快照',
    )
  } else {
    targets.forEach((target: unknown, index: number) => {
      if (!isPlainObject(target) || typeof target.target_id !== 'string' || target.target_id.length === 0) {
        bad(`基准快照 targets[${index}] 缺少 target_id`, '重新冻结派发基准')
      }
      if (!isPlainObject(target) || typeof target.path !== 'string' || target.path.length === 0) {
        bad(`基准快照 targets[${index}] 缺少 path`, '重新冻结派发基准')
      }
      if (!isPlainObject(target) || typeof target.sha256 !== 'string' || !SHA256.test(target.sha256)) {
        bad(`基准快照 targets[${index}] 缺少 64 位 sha256`, '重新冻结派发基准')
      }
    })
  }

  for (const field of ['preexisting_seals', 'artifacts']) {
    const list = baseline[field]
    if (!Array.isArray(list)) {
      bad(`基准快照 ${field} 必须是数组（没有就写 []）`, '重新冻结派发基准')
      continue
    }
    list.forEach((entry: unknown, index: number) => {
      if (!isPlainObject(entry) || typeof entry.path !== 'string' || entry.path.length === 0) {
        bad(`基准快照 ${field}[${index}] 缺少 path`, '重新冻结派发基准')
      }
      if (!isPlainObject(entry) || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
        bad(`基准快照 ${field}[${index}] 缺少 64 位 sha256`, '重新冻结派发基准')
      }
    })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true }
}

/** `hashFile` 的结果：成功给字节，失败给「是否不存在」与原因码。 */
type HashVerdict = { ok: true, bytes: Buffer } | { ok: false, missing: boolean, code: string }

async function hashFile(fs: FsLike, absolute: string): Promise<HashVerdict> {
  try {
    const bytes = await fs.readFile(absolute)
    return { ok: true, bytes }
  } catch (error) {
    const missing = thrownCode(error) === 'ENOENT'
    return { ok: false, missing, code: thrownCode(error) ?? 'unknown' }
  }
}

function resolveTargetPath(root: string | undefined, relativeOrAbsolute: string, pathsModule: PathsModule): string {
  if (isAbsolute(relativeOrAbsolute)) return relativeOrAbsolute
  return pathsModule.resolveInProject(root, relativeOrAbsolute)
}

/** `captureBaseline` 的入参（`fs`/`paths`/`atomic`/`clock` 可注入，缺省用真实实现）。 */
interface CaptureBaselineInput {
  /** 规范根。 */
  root: string
  dispatchId?: unknown
  attemptId?: unknown
  /** 本次派发的目标 ID（非空）。 */
  targetIds?: unknown
  /** 依赖产物身份。 */
  artifacts?: unknown
  /** 用来读既有 seal（缺失则视为没有既有 seal）。 */
  projectAdapter?: ProjectAdapterLike | null
  clock?: ClockLike
  fs?: FsLike
  paths?: PathsModule
  atomic?: typeof import('./atomic.js')
}

/**
 * 取条目里声明的路径。
 *
 * 原实现把 `entry.path` 直接交给 `path.isAbsolute`：非字符串会在那里抛 TypeError，
 * 由调用方的 catch 统一转成 INVALID_ARGUMENT。这里保持**同一条失败路径**与同一个值，
 * 只把静态类型收成 `string`。
 */
function declaredPath(entry: Record<string, unknown>): string {
  // 断言成立的理由：运行期不做任何转换（原实现对非字符串本来就抛），只是让 TS 接受这行调用。
  return entry.path as string
}

/**
 * 冻结派发基准：目标字节、既有 seal（路径+字节哈希）、依赖产物。
 *
 * @param {object} input
 * @param {string} input.root 规范根
 * @param {string} input.dispatchId
 * @param {string} input.attemptId
 * @param {string[]} input.targetIds 本次派发的目标 ID（非空）
 * @param {Array<{path:string, sha256:string}>} [input.artifacts] 依赖产物身份
 * @param {object} [input.projectAdapter] 用来读既有 seal（缺失则视为没有既有 seal）
 * @param {object} input.clock `{isoNow()}` 或 `() => number`
 * @param {object} input.fs `fs/promises` 形状
 * @param {object} input.paths `src/paths.mjs`
 * @param {object} input.atomic `src/atomic.mjs`
 */
export async function captureBaseline(input: CaptureBaselineInput) {
  const { root, dispatchId, attemptId, targetIds, projectAdapter } = input
  const fs: FsLike = input.fs ?? fsp
  const atomic: typeof import('./atomic.js') = input.atomic ?? atomicModule
  const paths: PathsModule = input.paths ?? defaultPaths
  const clock: ClockLike = input.clock ?? { isoNow: () => new Date().toISOString(), now: () => Date.now() }

  if (typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)) {
    return failure('INVALID_ARGUMENT', `dispatch_id 形状非法：${JSON.stringify(dispatchId)}`, '使用 D-<小写字母数字-> 形状')
  }
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    return failure('INVALID_ARGUMENT', `attempt_id 形状非法：${JSON.stringify(attemptId)}`, '使用 A-<六位数字> 形状')
  }
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    return failure(
      'INVALID_ARGUMENT',
      '冻结派发基准需要非空的 target_ids：首次目标尚无 seal 时仍须有真实目标哈希',
      '按路线目标集把 target_ids 对应条目（path + 实际 SHA256）写进 targets.json 后再派发',
    )
  }

  let manifest: unknown
  try {
    const absolute = paths.resolveInProject(root, TARGETS_PATH)
    manifest = JSON.parse(await fs.readFile(absolute, 'utf8'))
  } catch (error) {
    return failure(
      'INVALID_ARGUMENT',
      `读不到 ${TARGETS_PATH}：${thrownDetail(error)}`,
      '先按 skill 建立目标清单（targets.json）并写入真实 SHA256',
    )
  }
  const entries = asRecords(recordOf(manifest).targets)
  const targets: Array<Record<string, unknown>> = []
  // `Array.isArray` 收窄给的是 `any[]`，这里落到 `unknown[]` 再逐个判形状。
  const targetIdList: unknown[] = targetIds
  for (const targetId of targetIdList) {
    const entry = entries.find((candidate) => candidate?.id === targetId)
    if (entry === undefined) {
      return failure('INVALID_ARGUMENT', `targets.json 里没有目标 ${targetId}`, '先按 skill 登记该目标（path/sha256/version/platform/arch/source）')
    }
    let absolute: string
    try {
      absolute = resolveTargetPath(root, declaredPath(entry), paths)
    } catch (error) {
      return failure('INVALID_ARGUMENT', `目标 ${targetId} 的 path 无法解析：${thrownMessage(error)}`, '目标 path 必须是项目内相对路径或明确登记的外部绝对样本')
    }
    const hashed = await hashFile(fs, absolute)
    if (hashed.ok !== true) {
      return failure(
        'BASELINE_MISMATCH',
        `目标 ${targetId} 的字节读不了（${hashed.code}）：${entry.path}`,
        '目标不存在或不可读时不能冻结基准；先恢复真实样本',
      )
    }
    const actual = atomic.sha256Bytes(hashed.bytes)
    if (typeof entry.sha256 === 'string' && SHA256.test(entry.sha256) && entry.sha256 !== actual) {
      return failure(
        'BASELINE_MISMATCH',
        `目标 ${targetId} 的字节与 targets.json 声明不符（声明 ${entry.sha256}，实际 ${actual}）`,
        '先按 skill 修正目标身份或恢复原始样本；不要用新哈希替换旧期望值',
      )
    }
    targets.push({ target_id: targetId, path: entry.path, sha256: actual })
  }

  const artifacts: Array<Record<string, unknown>> = []
  for (const artifact of Array.isArray(input.artifacts) ? input.artifacts : []) {
    if (!isPlainObject(artifact) || !isProjectRelative(artifact.path) || typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      return failure('INVALID_ARGUMENT', `依赖产物身份不合法：${JSON.stringify(artifact)}`, '给 {path, sha256}（path 为项目内相对路径）')
    }
    artifacts.push({ path: artifact.path, sha256: artifact.sha256 })
  }

  let preexisting: Array<Record<string, unknown>> = []
  if (projectAdapter && typeof projectAdapter.readSeals === 'function') {
    const seals = recordOf(await projectAdapter.readSeals())
    if (seals.ok !== true) {
      return failure(
        'RECOVERY_REQUIRED',
        `读不了既有 seal 清单：${seals.reason ?? seals.code ?? 'unknown'}`,
        '先确认 re/seals 可读后再冻结基准；不能把读失败当作没有封存',
      )
    }
    preexisting = asRecords(seals.seals).map((seal) => ({ path: seal.path, sha256: seal.sha256 }))
  }

  const baseline = {
    schema_version: BASELINE_SCHEMA_VERSION,
    dispatch_id: dispatchId,
    attempt_id: attemptId,
    captured_at: typeof clock.isoNow === 'function' ? clock.isoNow() : new Date(clock.now()).toISOString(),
    targets,
    preexisting_seals: preexisting,
    artifacts,
  }

  const shape = validateBaselineShape(baseline)
  if (shape.ok !== true) return { ok: false, code: 'BASELINE_INVALID', issues: shape.issues }

  const ref = baselineRefFor(dispatchId)
  const absolute = paths.resolveInProject(root, ref)
  await atomic.writeJsonAtomic(absolute, baseline)
  return { ok: true, ref, baseline }
}

/** `loadBaseline` 的入参：`ref`/`embedded` 都是契约里可能缺失的 `unknown`。 */
interface LoadBaselineInput {
  /** 规范根（缺省时下游 `resolveInProject` 自己会拒）。 */
  root?: string
  dispatchId?: unknown
  ref?: unknown
  embedded?: unknown
  fs?: FsLike
  paths?: PathsModule
}

/**
 * 读回基准快照：优先用契约里记的 `ref`，否则用默认位置；也接受契约内联的 `embedded`。
 */
export async function loadBaseline(input: LoadBaselineInput = {}) {
  const { root, dispatchId, ref, embedded } = input
  const fs: FsLike = input.fs ?? fsp
  const paths: PathsModule = input.paths ?? defaultPaths
  const source: unknown = embedded ?? null

  if (source !== null && source !== undefined) {
    const shape = validateBaselineShape(source)
    if (shape.ok !== true) return { ok: false, code: 'RECOVERY_REQUIRED', issues: shape.issues }
    const sourceRecord = recordOf(source)
    if (typeof sourceRecord.dispatch_id === 'string' && sourceRecord.dispatch_id !== dispatchId) {
      return failure('RECOVERY_REQUIRED', `基准快照属于 ${sourceRecord.dispatch_id}，不是 ${dispatchId}`, '核对 dispatch_id，不要用别的派发的基准收口')
    }
    return { ok: true, ref: ref ?? baselineRefFor(dispatchId), baseline: sourceRecord }
  }

  const relative = ref ?? baselineRefFor(dispatchId)
  if (!isProjectRelative(relative)) {
    return failure('RECOVERY_REQUIRED', `基准快照路径不是项目内相对路径：${JSON.stringify(relative)}`, '契约里的 baseline_ref 必须是项目内路径')
  }
  let text: string
  try {
    text = await fs.readFile(paths.resolveInProject(root, relative), 'utf8')
  } catch (error) {
    return failure(
      'RECOVERY_REQUIRED',
      `读不到派发时冻结的基准快照 ${relative}（${thrownCode(error) ?? 'unknown'}）`,
      '核实派发时是否冻结了 baseline；缺失就不能沿用旧判定，需要重新派发或人工恢复',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return failure('RECOVERY_REQUIRED', `基准快照不是合法 JSON：${relative}（${error instanceof Error ? error.message : String(error)}）`, '按恢复流程核对快照来源；不要静默当作没有基准')
  }
  const shape = validateBaselineShape(parsed)
  if (shape.ok !== true) return { ok: false, code: 'RECOVERY_REQUIRED', issues: shape.issues }
  return { ok: true, ref: relative, baseline: recordOf(parsed) }
}

/** `compareBaseline` 的入参。 */
interface CompareBaselineInput {
  /** 规范根（缺省时下游 `resolveInProject` 自己会拒）。 */
  root?: string
  baseline?: unknown
  projectAdapter?: ProjectAdapterLike | null
  fs?: FsLike
  paths?: PathsModule
  atomic?: typeof import('./atomic.js')
}

/**
 * 与冻结快照比较：目标、既有 seal、依赖产物的删除/不可读/内容变化都是 `BASELINE_MISMATCH`。
 */
export async function compareBaseline(input: CompareBaselineInput = {}) {
  const { root, baseline, projectAdapter } = input
  const fs: FsLike = input.fs ?? fsp
  const paths: PathsModule = input.paths ?? defaultPaths
  const atomic: typeof import('./atomic.js') = input.atomic ?? atomicModule
  const shape = validateBaselineShape(baseline)
  if (shape.ok !== true) return { ok: false, code: 'RECOVERY_REQUIRED', issues: shape.issues }
  const baselineRecord = recordOf(baseline)

  const mismatches: Array<Record<string, unknown>> = []
  const hashEntry = async (kind: string, entry: Record<string, unknown>): Promise<void> => {
    const absolute = resolveTargetPath(root, declaredPath(entry), paths)
    const hashed = await hashFile(fs, absolute)
    if (hashed.ok !== true) {
      mismatches.push({
        kind,
        path: entry.path,
        reason: hashed.missing ? 'missing' : 'unreadable',
        expected_sha256: entry.sha256,
        actual_sha256: null,
      })
      return
    }
    const actual = atomic.sha256Bytes(hashed.bytes)
    if (actual !== entry.sha256) {
      mismatches.push({ kind, path: entry.path, reason: 'changed', expected_sha256: entry.sha256, actual_sha256: actual })
    }
  }

  for (const target of asRecords(baselineRecord.targets)) await hashEntry('target', target)
  for (const artifact of asRecords(baselineRecord.artifacts)) await hashEntry('artifact', artifact)

  const preexistingSeals = asRecords(baselineRecord.preexisting_seals)
  if (preexistingSeals.length > 0) {
    const seals = recordOf(projectAdapter && typeof projectAdapter.readSeals === 'function'
      ? await projectAdapter.readSeals()
      : { ok: false, reason: '没有 projectAdapter' })
    if (seals.ok !== true) {
      return failure(
        'RECOVERY_REQUIRED',
        `读不了当前 seal 清单：${seals.reason ?? seals.code ?? 'unknown'}`,
        '确认 re/seals 可读后重试；读失败不能当作既有 seal 仍然有效',
      )
    }
    const current = new Map<unknown, unknown>(asRecords(seals.seals).map((seal): [unknown, unknown] => [seal.path, seal.sha256]))
    for (const seal of preexistingSeals) {
      if (!current.has(seal.path)) {
        mismatches.push({ kind: 'seal', path: seal.path, reason: 'seal_missing', expected_sha256: seal.sha256, actual_sha256: null })
        continue
      }
      if (current.get(seal.path) !== seal.sha256) {
        mismatches.push({
          kind: 'seal',
          path: seal.path,
          reason: 'seal_changed',
          expected_sha256: seal.sha256,
          actual_sha256: current.get(seal.path),
        })
      }
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      code: 'BASELINE_MISMATCH',
      mismatches,
      issues: [
        issue(
          'BASELINE_MISMATCH',
          `派发基准已失效：${mismatches.map((item) => `${item.kind} ${item.path} ${item.reason}`).join('；')}`,
          '按 skill 核对原始来源：删除/改动的既有项必须恢复或由 Lead 显式处置；不要覆盖旧 seal，也不要用新哈希替换旧期望值',
        ),
      ],
    }
  }

  return {
    ok: true,
    compared: {
      targets: asRecords(baselineRecord.targets).length,
      preexisting_seals: preexistingSeals.length,
      artifacts: asRecords(baselineRecord.artifacts).length,
    },
  }
}

/** `sealRunSet` 的入参（`runs`/`seals` 来自适配器或调用方，形状由本函数兜底）。 */
interface SealRunSetInput {
  projectAdapter?: ProjectAdapterLike | null
  runs?: unknown
  seals?: unknown
}

/**
 * 封存尚未封存的终态 RUN：已有 seal 只校验复用。
 *
 * @param {{ projectAdapter: object, runs: Array<{run_id: string, status: string}>,
 *           seals: Array<{path: string, sha256?: string}> }} input
 * @returns {Promise<{ok:true, results: Array<object>} | {ok:false, code:'CHECK_FAILED', stage:'seal', run_id:string,
 *   exit_code: number|null, stdout: string, stderr: string}>}
 */
export async function sealRunSet(input: SealRunSetInput = {}) {
  const { projectAdapter, runs, seals } = input
  const sealList: Array<{ path?: unknown }> = Array.isArray(seals) ? seals : []
  const existing = new Set<unknown>(sealList.map((seal) => seal.path))
  const results: Array<Record<string, unknown>> = []

  const runList: Array<{ run_id?: unknown, status?: unknown }> = Array.isArray(runs) ? runs : []
  for (const run of runList) {
    const runId = run?.run_id
    const status = run?.status
    if (typeof runId !== 'string') continue
    // 非字符串状态在原实现里也走 `includes` 为 false 的分支；这里显式表达同一个判断。
    if (typeof status !== 'string' || !TERMINAL_RUNS.includes(status)) {
      results.push({ run_id: runId, action: 'skipped', reason: `RUN 状态 ${status ?? 'unknown'} 不是终态，不能封存` })
      continue
    }
    const sealPath = sealPathFor(runId)
    if (existing.has(sealPath)) {
      results.push({ run_id: runId, action: 'reused', path: sealPath, reason: '已有封存，只校验复用，不重封存' })
      continue
    }
    if (!projectAdapter || typeof projectAdapter.seal !== 'function') {
      return {
        ok: false,
        code: 'PROJECT_NOT_CONFIGURED',
        stage: 'seal',
        run_id: runId,
        exit_code: null,
        stdout: '',
        stderr: '',
        issues: [issue('PROJECT_NOT_CONFIGURED', '没有 projectAdapter，无法调用 seal', '先完成项目接入（rt_roster bind）')],
      }
    }
    const sealed = recordOf(await projectAdapter.seal({ runId }))
    if (sealed.ok !== true) {
      return {
        ok: false,
        code: 'CHECK_FAILED',
        stage: 'seal',
        run_id: runId,
        exit_code: sealed.exitCode ?? null,
        stdout: typeof sealed.stdout === 'string' ? sealed.stdout : '',
        stderr: typeof sealed.stderr === 'string' ? sealed.stderr : '',
        issues: [
          issue(
            'CHECK_FAILED',
            `seal 失败（RUN ${runId}）：${typeof sealed.stderr === 'string' && sealed.stderr.trim().length > 0 ? sealed.stderr.trim() : (sealed.reason ?? sealed.code ?? 'unknown')}`,
            '保留原始诊断与阶段；按 skill 修正项目记录后以同一 operation ID 重入，不得跳过后继续完成任务',
          ),
        ],
      }
    }
    results.push({
      run_id: runId,
      action: sealed.alreadySealed === true ? 'reused' : 'sealed',
      path: sealPath,
      exit_code: sealed.exitCode ?? null,
      stdout: typeof sealed.stdout === 'string' ? sealed.stdout : '',
      stderr: typeof sealed.stderr === 'string' ? sealed.stderr : '',
    })
  }

  return { ok: true, results }
}
