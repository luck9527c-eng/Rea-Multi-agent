/**
 * `submission.json` 校验：形状、身份、路径与「读取后再核对」。
 *
 * 契约（编排契约「交付、开始和结果分类」「路径、锁与资源」）：
 * - 提交统一为 `submission.json`，必填：`schema_version`、dispatch/attempt/task、
 *   `contract_sha256`、`outcome`、`summary`、`run_ids`、`artifacts[{path,sha256}]`、
 *   `anchor_refs`、`blocker`、`state_recovery_ref`、`submitted_at`。
 * - `submission_ref` 必须位于**当前 attempt** 的工作目录（`re/team/work/<dispatch>/<attempt>/`）；
 *   越界/绝对路径是 `PATH_INVALID`，内容/哈希/身份不符是 `SUBMISSION_INVALID`。
 * - 重算 `submission_sha256` 与传入值比对，**读取后再核对一次**（防止校验后换内容）。
 *
 * 本模块是 I/O 边界之一（由调用方注入 `fs`/`atomic`/`paths`），但判定部分（`validateSubmission`）
 * 是纯函数，可单独测试。
 */

import { isProjectRelative } from './paths.mjs'

/** 提交记录版本。 */
export const SUBMISSION_SCHEMA_VERSION = 1

/** 提交文件固定名。 */
export const SUBMISSION_FILE = 'submission.json'

/** attempt 工作区的根（`re/team/work/<dispatch>/<attempt>/`）。 */
export const WORK_DIR = 're/team/work'

/** 七类 outcome（`$defs.outcome`）。 */
export const OUTCOMES = Object.freeze([
  'finding',
  'no_finding',
  'refuted',
  'blocked',
  'budget_exhausted',
  'failed',
  'cancelled',
])

/** 交付分类里需要「已完成运行」的几类（岗位成功锚点要求适用）。 */
export const RUN_BEARING_OUTCOMES = Object.freeze(['finding', 'no_finding', 'refuted', 'failed'])

/** `submission.json` 的必填字段（契约逐字）。 */
export const SUBMISSION_FIELDS = Object.freeze([
  'schema_version',
  'dispatch_id',
  'attempt_id',
  'task_id',
  'contract_sha256',
  'outcome',
  'summary',
  'run_ids',
  'artifacts',
  'anchor_refs',
  'blocker',
  'state_recovery_ref',
  'submitted_at',
])

const SHA256 = /^[0-9a-f]{64}$/
const DISPATCH_ID = /^D-[a-z0-9][a-z0-9_-]{0,63}$/
const ATTEMPT_ID = /^A-[0-9]{6}$/
const RUN_ID = /^RUN-[A-Za-z0-9_-]+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function issue(code, reason, nextStep) {
  return { code, reason, next_step: nextStep }
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * attempt 工作区相对路径。
 * @param {string} dispatchId
 * @param {string} attemptId
 * @returns {string}
 */
export function attemptDir(dispatchId, attemptId) {
  return `${WORK_DIR}/${dispatchId}/${attemptId}`
}

/**
 * 相对路径是否位于该 attempt 的工作目录内（不含目录本身）。
 * @param {string} relativePath
 * @param {string} dispatchId
 * @param {string} attemptId
 * @returns {boolean}
 */
export function isInsideAttempt(relativePath, dispatchId, attemptId) {
  if (!isProjectRelative(relativePath)) return false
  return relativePath.startsWith(`${attemptDir(dispatchId, attemptId)}/`)
}

/**
 * 纯校验：形状、字段、枚举与内部一致性（不读盘，不做跨文件核对）。
 *
 * @param {unknown} value
 * @returns {{ ok: true, submission: object } | { ok: false, code: 'SUBMISSION_INVALID',
 *   issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export function validateSubmission(value) {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      code: 'SUBMISSION_INVALID',
      issues: [issue('SUBMISSION_INVALID', 'submission 必须是 JSON 对象', '按契约提交 submission.json')],
    }
  }

  const issues = []
  const missing = (field) => {
    issues.push(
      issue(
        'SUBMISSION_FIELD_MISSING',
        `submission 缺少必填字段 ${field}`,
        `补齐 ${field}（$defs 之外由编排契约「交付、开始和结果分类」规定）后重新提交；不要用空值代替`,
      ),
    )
  }

  for (const field of SUBMISSION_FIELDS) {
    if (!Object.hasOwn(value, field)) missing(field)
  }

  if (Object.hasOwn(value, 'schema_version') && value.schema_version !== SUBMISSION_SCHEMA_VERSION) {
    issues.push(
      issue(
        'SUBMISSION_INVALID',
        `submission.schema_version 必须是 ${SUBMISSION_SCHEMA_VERSION}（收到 ${JSON.stringify(value.schema_version)}）`,
        '用当前版本的提交模板重写 submission.json',
      ),
    )
  }

  if (Object.hasOwn(value, 'dispatch_id') && (typeof value.dispatch_id !== 'string' || !DISPATCH_ID.test(value.dispatch_id))) {
    issues.push(issue('SUBMISSION_INVALID', `submission.dispatch_id 形状非法：${JSON.stringify(value.dispatch_id)}`, '使用 D-<小写字母数字-> 形状'))
  }
  if (Object.hasOwn(value, 'attempt_id') && (typeof value.attempt_id !== 'string' || !ATTEMPT_ID.test(value.attempt_id))) {
    issues.push(issue('SUBMISSION_INVALID', `submission.attempt_id 形状非法：${JSON.stringify(value.attempt_id)}`, '使用 A-<六位数字> 形状'))
  }
  if (Object.hasOwn(value, 'task_id') && !text(value.task_id)) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.task_id 必须是非空文本', '填写派发时的宿主 task id'))
  }
  if (Object.hasOwn(value, 'contract_sha256') && (typeof value.contract_sha256 !== 'string' || !SHA256.test(value.contract_sha256))) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.contract_sha256 必须是 64 位小写十六进制', '重算派发契约的 SHA256'))
  }
  if (Object.hasOwn(value, 'outcome') && !OUTCOMES.includes(value.outcome)) {
    issues.push(
      issue(
        'SUBMISSION_INVALID',
        `submission.outcome 不在七类结果里：${JSON.stringify(value.outcome)}`,
        `outcome 只能取 ${OUTCOMES.join('|')}`,
      ),
    )
  }
  if (Object.hasOwn(value, 'summary') && !text(value.summary)) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.summary 必须是非空文本', '给出具体结论摘要（区分观察与推断）'))
  }

  if (Object.hasOwn(value, 'run_ids')) {
    if (!Array.isArray(value.run_ids)) {
      issues.push(issue('SUBMISSION_INVALID', 'submission.run_ids 必须是数组（未开始可为空数组）', '未实验即阻塞时给 []，并保存就绪/中断核查'))
    } else {
      const seen = new Set()
      for (const runId of value.run_ids) {
        if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
          issues.push(issue('SUBMISSION_INVALID', `submission.run_ids 含非法 RUN 标识：${JSON.stringify(runId)}`, '使用 RUN-<字母数字_-> 形状'))
          continue
        }
        if (seen.has(runId)) {
          issues.push(issue('SUBMISSION_INVALID', `submission.run_ids 重复：${runId}`, '每个 RUN 只出现一次'))
        }
        seen.add(runId)
      }
    }
  }

  if (Object.hasOwn(value, 'artifacts')) {
    if (!Array.isArray(value.artifacts)) {
      issues.push(issue('SUBMISSION_INVALID', 'submission.artifacts 必须是数组', '每项给 {path, sha256}；没有产物时给 []'))
    } else {
      value.artifacts.forEach((artifact, index) => {
        if (!isPlainObject(artifact)) {
          issues.push(issue('SUBMISSION_INVALID', `submission.artifacts[${index}] 必须是对象`, '给 {path, sha256}'))
          return
        }
        if (!isProjectRelative(artifact.path)) {
          issues.push(
            issue(
              'SUBMISSION_INVALID',
              `submission.artifacts[${index}].path 不是项目内相对路径：${JSON.stringify(artifact.path)}`,
              'artifacts 只能指向本 attempt 分配目录内的项目相对路径',
            ),
          )
        }
        if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
          issues.push(
            issue(
              'SUBMISSION_INVALID',
              `submission.artifacts[${index}].sha256 必须是 64 位小写十六进制`,
              '重新计算产物字节哈希，不要用占位符',
            ),
          )
        }
      })
    }
  }

  if (Object.hasOwn(value, 'anchor_refs') && !Array.isArray(value.anchor_refs)) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.anchor_refs 必须是数组', '没有锚点时给 []；每项按 $defs.anchorRef'))
  }

  if (Object.hasOwn(value, 'blocker') && value.blocker !== null && !text(value.blocker)) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.blocker 只能是 null 或非空文本', '具体缺口写进 blocker；没有阻塞给 null'))
  }

  if (Object.hasOwn(value, 'state_recovery_ref')) {
    const ref = value.state_recovery_ref
    if (ref !== null && !isProjectRelative(ref)) {
      issues.push(
        issue(
          'SUBMISSION_INVALID',
          `submission.state_recovery_ref 必须是项目内相对路径或 null：${JSON.stringify(ref)}`,
          '把就绪检查/中断核查记录保存进项目，并引用其项目内路径',
        ),
      )
    }
  }

  if (Object.hasOwn(value, 'submitted_at') && (typeof value.submitted_at !== 'string' || !ISO_DATE.test(value.submitted_at))) {
    issues.push(issue('SUBMISSION_INVALID', 'submission.submitted_at 必须是带时区的 ISO 8601 时间', '用 UTC ISO 时间（例如 2026-01-01T00:00:00.000Z）'))
  }

  if (issues.length > 0) return { ok: false, code: 'SUBMISSION_INVALID', issues }
  return { ok: true, submission: value }
}

function failure(code, issues) {
  return { ok: false, code, issues }
}

/**
 * 读取并核对提交：路径归属 → 字节哈希 → 形状 → **再读一次**核对字节未变。
 *
 * @param {object} input
 * @param {string} input.root 已规范化的项目根
 * @param {string} input.submissionRef 项目内相对路径
 * @param {string} input.expectedSha256 调用方传入的 submission_sha256
 * @param {string} input.dispatchId
 * @param {string} input.attemptId
 * @param {object} input.paths `src/paths.mjs`（或等价实现）
 * @param {object} input.fs `fs/promises` 形状（需 readFile）
 * @param {object} input.atomic `src/atomic.mjs`
 * @returns {Promise<{ ok: true, submission: object, bytes: Buffer, sha256: string, relative_path: string }
 *   | { ok: false, code: 'PATH_INVALID' | 'SUBMISSION_INVALID', issues: Array<object> }>}
 */
export async function readVerifiedSubmission(input) {
  const { root, submissionRef, expectedSha256, dispatchId, attemptId } = input

  let relative
  try {
    relative = input.paths.assertProjectRelative(submissionRef)
  } catch (error) {
    return failure('PATH_INVALID', [
      issue(
        'PATH_INVALID',
        `submission_ref 不是合法的项目内相对路径：${JSON.stringify(submissionRef)}（${error?.message ?? error}）`,
        'submission_ref 必须是当前 attempt 工作目录内的项目相对路径',
      ),
    ])
  }

  if (typeof dispatchId !== 'string' || !DISPATCH_ID.test(dispatchId)
    || typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    return failure('PATH_INVALID', [
      issue('PATH_INVALID', `dispatch/attempt 标识形状非法：${JSON.stringify(dispatchId)}/${JSON.stringify(attemptId)}`, '使用契约规定的标识形状'),
    ])
  }

  const dir = attemptDir(dispatchId, attemptId)
  if (!relative.startsWith(`${dir}/`)) {
    return failure('PATH_INVALID', [
      issue(
        'PATH_INVALID',
        `submission_ref 不在当前 attempt 的工作目录 ${dir}/ 内：${relative}`,
        '提交只能来自当前 dispatch/attempt 的分配目录；迟到或别的 attempt 的提交只入历史',
      ),
    ])
  }

  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) {
    return failure('SUBMISSION_INVALID', [
      issue('SUBMISSION_INVALID', 'submission_sha256 必须是 64 位小写十六进制', '重算提交文件字节哈希'),
    ])
  }

  let absolute
  try {
    absolute = input.paths.resolveInProject(root, relative)
  } catch (error) {
    return failure('PATH_INVALID', [
      issue('PATH_INVALID', `submission_ref 解析失败：${error?.message ?? error}`, '确认路径仍在项目根内'),
    ])
  }

  let bytes
  try {
    bytes = await input.fs.readFile(absolute)
  } catch (error) {
    const missing = error && typeof error === 'object' && error.code === 'ENOENT'
    return failure('SUBMISSION_INVALID', [
      issue(
        'SUBMISSION_INVALID',
        missing ? `提交文件不存在：${relative}` : `提交文件读不了：${relative}（${error?.code ?? error?.message ?? 'unknown'}）`,
        '确认工兵已把 submission.json 写进本次 attempt 的工作目录并停止改写',
      ),
    ])
  }

  const sha256 = input.atomic.sha256Bytes(bytes)
  if (sha256 !== expectedSha256) {
    return failure('SUBMISSION_INVALID', [
      issue(
        'SUBMISSION_INVALID',
        `提交字节与传入的 submission_sha256 不一致：${relative}（实际 ${sha256}）`,
        '重新读取工兵提交的原始字节并核对摘要；不要用当前文件继续收口',
      ),
    ])
  }

  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return failure('SUBMISSION_INVALID', [
      issue('SUBMISSION_INVALID', `提交不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, '按提交模板重写并重新发布'),
    ])
  }

  const shape = validateSubmission(parsed)
  if (shape.ok !== true) return failure('SUBMISSION_INVALID', shape.issues)

  if (parsed.dispatch_id !== dispatchId || parsed.attempt_id !== attemptId) {
    return failure('SUBMISSION_INVALID', [
      issue(
        'SUBMISSION_INVALID',
        `提交身份与本 attempt 不符：submission=${parsed.dispatch_id}/${parsed.attempt_id}，调用=${dispatchId}/${attemptId}`,
        '用当前 attempt 的提交；别的 attempt 的提交只入历史',
      ),
    ])
  }

  // 读取后再核对一次：校验与使用之间被换内容必须暴露。
  let again
  try {
    again = await input.fs.readFile(absolute)
  } catch (error) {
    return failure('SUBMISSION_INVALID', [
      issue('SUBMISSION_INVALID', `提交在读取后不可再读：${relative}（${error?.code ?? 'unknown'}）`, '确认文件稳定后再收口'),
    ])
  }
  const secondSha = input.atomic.sha256Bytes(again)
  if (secondSha !== sha256) {
    return failure('SUBMISSION_INVALID', [
      issue(
        'SUBMISSION_INVALID',
        `提交在读取后被改写：${relative}（读取后 ${secondSha} ≠ 校验时 ${sha256}）`,
        '工兵必须先停止改写该版本；重新核对原始字节后再收口',
      ),
    ])
  }

  return { ok: true, submission: parsed, bytes: Buffer.from(bytes), sha256, relative_path: relative }
}
