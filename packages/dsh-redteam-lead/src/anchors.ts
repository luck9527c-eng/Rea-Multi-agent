/**
 * 锚点闭集校验（六类）。
 *
 * 契约（编排契约「锚点与封存绑定」、规格「锚点闭集」）：
 * - `anchor_ref` 统一指向 `run_id/path/locator`；`path` 必须登记在该 RUN 的 `artifacts`。
 * - 完整类型信息记录在所指产物里，插件只读校验 —— 这里校验的是**产物内最低定位字段**的投影，
 *   即 `locator` 里必须齐备的键。`locator` 是 `$defs.text`，因此本模块把文本解析成键值表：
 *   支持 `k=v; k2=v2` 与 JSON 对象两种写法（两者等价）。
 * - **函数名、URL、evidence ID 单独不成立**：每类都有 missing-required 拒绝路径。
 *
 * 本模块是纯函数（`parseLocator` / `validateAnchorRef` / `validateAnchorSet` / `mergeRequiredKinds`），
 * 不读文件、不碰 adapter；调用方负责取 RUN 的 artifacts 清单。
 */

import { isProjectRelative } from './paths.js'
import { recordOf } from './guards.js'
import type { Diagnostic } from './types.js'

/** 六类锚点，顺序与 `$defs.anchorKind` 一致。 */
export const ANCHOR_KINDS: readonly string[] = Object.freeze([
  'binary_location',
  'source_location',
  'web_capture',
  'runtime_event',
  'evidence_export',
  'artifact_locator',
])

const SHA256 = /^[0-9a-f]{64}$/
const LOCATOR_KEY = /^[a-z][a-z0-9_]*$/

/**
 * 每类的最低定位字段（编排契约表逐行落地）。
 *
 * - `all`：必须齐备的键。
 * - `anyOf`：**至少有一组**键要齐备（例如 va/rva/file_offset 三选一；行号或字节范围二选一）。
 * - `conditional`：`when` 存在时追加要求。
 * - `hashes`：值必须是 64 位小写十六进制（目标/内容身份，不允许占位符）。
 */

/** 一类锚点的最低定位字段规则（上表的一行）。 */
interface KindRule {
  all?: readonly string[]
  anyOf?: readonly (readonly string[])[]
  conditional?: ReadonlyArray<{ when: string, all?: readonly string[], anyOf?: readonly (readonly string[])[] }>
  hashes?: readonly string[]
}

export const REQUIRED_FIELDS_BY_KIND: Readonly<Record<string, KindRule>> = Object.freeze({
  binary_location: {
    all: ['target_id', 'sha256', 'module'],
    anyOf: [['va'], ['rva'], ['file_offset']],
    conditional: [{ when: 'va', all: ['base'], anyOf: [['process_id'], ['captured_at']] }],
    hashes: ['sha256'],
  },
  source_location: {
    all: ['sha256', 'path'],
    anyOf: [['line'], ['line_start', 'line_end'], ['byte_start', 'byte_end']],
    hashes: ['sha256'],
  },
  web_capture: {
    all: ['captured_at', 'url', 'path', 'sha256'],
    anyOf: [['request_locator'], ['response_locator']],
    hashes: ['sha256'],
  },
  runtime_event: {
    all: ['target_id', 'process_id', 'event', 'trigger', 'log_sha256'],
    anyOf: [['at'], ['time_offset'], ['window_start', 'window_end']],
    conditional: [
      { when: 'window_start', all: ['window_end'] },
      { when: 'window_end', all: ['window_start'] },
    ],
    hashes: ['log_sha256'],
  },
  evidence_export: {
    all: ['service', 'version', 'session_id', 'evidence_id', 'path', 'sha256', 'package_locator'],
    hashes: ['sha256'],
  },
  artifact_locator: {
    all: ['sha256'],
    anyOf: [['line'], ['event'], ['offset']],
    hashes: ['sha256'],
  },
})

function issue(code: string, reason: string, nextStep: string): Diagnostic {
  return { code, reason, next_step: nextStep }
}

const NEXT_STEP_LOCATOR =
  '在产物里记录该锚点的最低定位字段，并在 anchor_ref.locator 里给出同一组键值（例如 k=v;k2=v2）；缺项不能靠函数名/URL/evidence ID 替代'

/** `parseLocator` 的结果：可解析就给键值表，否则给一句人读原因。 */
type ParsedLocator = { ok: true, fields: Record<string, string> } | { ok: false, reason: string }

/**
 * 解析 `locator` 文本为键值表。
 *
 * @param {unknown} locator
 * @returns {{ ok: true, fields: Record<string, string> } | { ok: false, reason: string }}
 */
export function parseLocator(locator: unknown): ParsedLocator {
  if (typeof locator !== 'string' || locator.trim().length === 0) {
    return { ok: false, reason: 'locator 是非空文本，必须是键值表（k=v;k2=v2 或 JSON 对象）' }
  }
  const text = locator.trim()
  const fields: Record<string, string> = {}

  if (text.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { ok: false, reason: `locator 的 JSON 对象无法解析：${error instanceof Error ? error.message : String(error)}` }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'locator 的 JSON 必须是对象' }
    }
    for (const [key, value] of Object.entries(recordOf(parsed))) {
      if (value === null || value === undefined) continue
      fields[key] = String(value)
    }
    return { ok: true, fields }
  }

  for (const chunk of text.split(';')) {
    const part = chunk.trim()
    if (part.length === 0) continue
    const index = part.indexOf('=')
    if (index <= 0) {
      return { ok: false, reason: `locator 片段缺少 key=value 形状：${JSON.stringify(part)}` }
    }
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!LOCATOR_KEY.test(key)) {
      return { ok: false, reason: `locator 的键名非法（只允许小写字母/数字/下划线，且以字母开头）：${JSON.stringify(key)}` }
    }
    if (value.length === 0) continue
    fields[key] = value
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, reason: 'locator 没有解析出任何键值' }
  }
  return { ok: true, fields }
}

function requiredIssues(kind: string, fields: Record<string, string>): Diagnostic[] {
  const rule = REQUIRED_FIELDS_BY_KIND[kind]
  const issues: Diagnostic[] = []

  for (const key of rule.all ?? []) {
    if (!Object.hasOwn(fields, key)) {
      issues.push(
        issue(
          'ANCHOR_FIELD_MISSING',
          `${kind} 缺少最低定位字段 ${key}（缺项不成立）`,
          NEXT_STEP_LOCATOR,
        ),
      )
    }
  }

  const anyOf = rule.anyOf ?? []
  if (anyOf.length > 0 && !anyOf.some((group) => group.every((key) => Object.hasOwn(fields, key)))) {
    issues.push(
      issue(
        'ANCHOR_FIELD_MISSING',
        `${kind} 需要 ${anyOf.map((group) => group.join('+')).join(' / ')} 之一作为位置值`,
        NEXT_STEP_LOCATOR,
      ),
    )
  }

  for (const conditional of rule.conditional ?? []) {
    if (!Object.hasOwn(fields, conditional.when)) continue
    for (const key of conditional.all ?? []) {
      if (!Object.hasOwn(fields, key)) {
        issues.push(
          issue(
            'ANCHOR_FIELD_MISSING',
            `${kind} 使用 ${conditional.when} 时必须同时给出 ${key}`,
            NEXT_STEP_LOCATOR,
          ),
        )
      }
    }
    const conditionalAny = conditional.anyOf ?? []
    if (
      conditionalAny.length > 0
      && !conditionalAny.some((group) => group.every((key) => Object.hasOwn(fields, key)))
    ) {
      issues.push(
        issue(
          'ANCHOR_FIELD_MISSING',
          `${kind} 使用 ${conditional.when} 时必须同时给出 `
            + `${conditionalAny.map((group) => group.join('+')).join(' / ')} 之一（进程实例或捕获时间）`,
          NEXT_STEP_LOCATOR,
        ),
      )
    }
  }

  for (const key of rule.hashes ?? []) {
    const value = fields[key]
    if (value !== undefined && !SHA256.test(value)) {
      issues.push(
        issue(
          'ANCHOR_HASH_INVALID',
          `${kind} 的 ${key} 必须是 64 位小写十六进制（收到 ${JSON.stringify(value)}）`,
          '重算内容/目标的 SHA256 并写进 locator；不要用占位符或截断哈希',
        ),
      )
    }
  }

  return issues
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** `validateAnchorRef` 的调用方上下文（`runIds` 缺省表示不校验 RUN 归属）。 */
interface AnchorRefContext {
  runIds?: string[]
  artifactsForRun?: (runId: string) => string[]
}

/** 单条锚点的校验结果。 */
type AnchorRefVerdict = { ok: true } | { ok: false, code: 'SUBMISSION_INVALID', issues: Diagnostic[] }

/**
 * 校验单条 `anchor_ref`。
 *
 * @param {unknown} ref
 * @param {{ runIds?: string[], artifactsForRun?: (runId: string) => string[] }} [context]
 * @returns {{ ok: true } | { ok: false, code: 'SUBMISSION_INVALID', issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export function validateAnchorRef(ref: unknown, context: AnchorRefContext = {}): AnchorRefVerdict {
  const issues: Diagnostic[] = []

  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    return {
      ok: false,
      code: 'SUBMISSION_INVALID',
      issues: [issue('ANCHOR_INVALID', 'anchor_ref 必须是对象', '按 $defs.anchorRef 给 kind/run_id/path/locator')],
    }
  }

  const anchor = recordOf(ref)
  const kind = anchor.kind
  if (typeof kind !== 'string' || !ANCHOR_KINDS.includes(kind)) {
    return {
      ok: false,
      code: 'SUBMISSION_INVALID',
      issues: [
        issue(
          'UNKNOWN_ANCHOR_KIND',
          `未知锚点类型 ${JSON.stringify(kind)}`,
          `kind 只能取 ${ANCHOR_KINDS.join('|')}；函数名/URL 不是锚点类型`,
        ),
      ],
    }
  }

  // run_id
  const runIds = context.runIds === undefined ? null : asStringArray(context.runIds)
  if (typeof anchor.run_id !== 'string' || anchor.run_id.length === 0) {
    issues.push(issue('ANCHOR_RUN_MISSING', `${kind} 缺少 run_id`, '锚点必须指向本次交付声明的 RUN'))
  } else if (runIds !== null && !runIds.includes(anchor.run_id)) {
    issues.push(
      issue(
        'ANCHOR_RUN_UNKNOWN',
        `${kind} 指向的 ${anchor.run_id} 不在本次交付声明的 RUN 清单里（${runIds.join(', ') || '空'}）`,
        '锚点只能引用本次提交的 RUN；其他 RUN 的证据要另走新提交',
      ),
    )
  }

  // path 必须是项目内相对路径，且登记在该 RUN 的 artifacts
  if (typeof anchor.path !== 'string' || anchor.path.length === 0) {
    issues.push(issue('ANCHOR_PATH_MISSING', `${kind} 缺少 path`, 'path 必须是该项目内、且登记在 RUN artifacts 的相对路径'))
  } else if (!isProjectRelative(anchor.path)) {
    issues.push(
      issue(
        'ANCHOR_PATH_INVALID',
        `${kind} 的 path 不是合法的项目内相对路径：${JSON.stringify(anchor.path)}`,
        '改用 / 分隔的项目内相对路径，不要传绝对路径、盘符、反斜杠或 ..',
      ),
    )
  } else if (typeof context.artifactsForRun === 'function' && typeof anchor.run_id === 'string') {
    const registered = asStringArray(context.artifactsForRun(anchor.run_id))
    if (!registered.includes(anchor.path)) {
      issues.push(
        issue(
          'ANCHOR_ARTIFACT_UNREGISTERED',
          `${kind} 的 path 未在 ${anchor.run_id} 的 artifacts 登记：${anchor.path}`,
          '先在该 RUN 的 artifacts 里登记产物 path/sha256（正式记录），再引用它做锚点',
        ),
      )
    }
  }

  const parsed = parseLocator(anchor.locator)
  if (parsed.ok !== true) {
    issues.push(issue('ANCHOR_LOCATOR_INVALID', `${kind} 的 locator 不可解析：${parsed.reason}`, NEXT_STEP_LOCATOR))
  } else {
    issues.push(...requiredIssues(kind, parsed.fields))
  }

  if (issues.length > 0) return { ok: false, code: 'SUBMISSION_INVALID', issues }
  return { ok: true }
}

/** `validateAnchorSet` 的入参（`refs` 保持 `unknown[]`：逐条再收窄）。 */
interface AnchorSetInput {
  refs?: unknown[]
  requiredKinds?: string[]
  runIds?: string[]
  artifactsForRun?: (runId: string) => string[]
}

/** 锚点集合的校验结果。 */
type AnchorSetVerdict = { ok: true } | { ok: false, code: 'SUBMISSION_INVALID', issues: Diagnostic[] }

/**
 * 校验一组锚点：逐条 + 闭集（requiredKinds 必须全部出现）。
 *
 * @param {{ refs?: unknown[], requiredKinds?: string[], runIds?: string[],
 *           artifactsForRun?: (runId: string) => string[] }} input
 */
export function validateAnchorSet(input: AnchorSetInput = {}): AnchorSetVerdict {
  const issues: Diagnostic[] = []
  const refs = Array.isArray(input.refs) ? input.refs : null
  if (refs === null) {
    return {
      ok: false,
      code: 'SUBMISSION_INVALID',
      issues: [issue('ANCHOR_LIST_INVALID', 'anchor_refs 必须是数组', '按 $defs.review.anchor_refs 给数组（没有锚点也要给空数组）')],
    }
  }

  const merged = mergeRequiredKinds({
    anchorsRequired: input.requiredKinds,
    evidenceRequired: [],
  })
  issues.push(...merged.issues)

  const present = new Set<string>()
  for (const ref of refs) {
    const result = validateAnchorRef(ref, { runIds: input.runIds, artifactsForRun: input.artifactsForRun })
    if (result.ok === true) {
      // 这一条已被 validateAnchorRef 判为合法锚点，kind 必是已知字符串（见其 UNKNOWN_ANCHOR_KIND 分支）。
      const kindOfRef = recordOf(ref).kind
      if (typeof kindOfRef === 'string') present.add(kindOfRef)
      continue
    }
    issues.push(...result.issues)
  }

  for (const kind of merged.kinds) {
    if (!present.has(kind)) {
      issues.push(
        issue(
          'ANCHOR_REQUIRED_KIND_MISSING',
          `本次交付要求 ${kind} 锚点，但没有任何有效的该类锚点`,
          `按 $defs.anchorRef 提交一条 ${kind}（岗位默认要求 ∪ 契约 evidence_required）`,
        ),
      )
    }
  }

  if (issues.length > 0) return { ok: false, code: 'SUBMISSION_INVALID', issues }
  return { ok: true }
}

/** `mergeRequiredKinds` 的入参：两组可能缺省/形状不对的要求清单。 */
interface RequiredKindsInput {
  anchorsRequired?: unknown
  evidenceRequired?: unknown
}

/** 合并后的要求：去重排序的 kind 与被跳过的未知 kind 诊断。 */
interface MergedKinds {
  kinds: string[]
  issues: Diagnostic[]
}

/**
 * 合并锚点要求：岗位默认 ∪ 契约 `evidence_required`，去重并稳定排序。
 *
 * 未知 kind **不静默丢弃**：进入 `issues`，由调用方决定拒绝。
 *
 * @param {{ anchorsRequired?: unknown, evidenceRequired?: unknown }} input
 * @returns {{ kinds: string[], issues: Array<{code:string, reason:string, next_step:string}> }}
 */
export function mergeRequiredKinds(input: RequiredKindsInput = {}): MergedKinds {
  const issues: Diagnostic[] = []
  const kinds = new Set<string>()
  for (const source of [input.anchorsRequired, input.evidenceRequired]) {
    for (const kind of asStringArray(source)) {
      if (ANCHOR_KINDS.includes(kind)) {
        kinds.add(kind)
        continue
      }
      issues.push(
        issue(
          'UNKNOWN_ANCHOR_KIND',
          `锚点要求里出现未知类型 ${JSON.stringify(kind)}`,
          `锚点类型只能取 ${ANCHOR_KINDS.join('|')}`,
        ),
      )
    }
  }
  return { kinds: [...kinds].sort(), issues }
}
