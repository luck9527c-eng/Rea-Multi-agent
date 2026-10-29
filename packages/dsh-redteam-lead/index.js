/**
 * `@local/dsh-redteam-lead` 的宿主插件入口。
 *
 * 一个 preset（见 `cordis.patch.yml` 的 `preset-redteam-lead`）在 agent 作用域内注册三个工具：
 *
 * | 工具 | handler（本 ticket 是占位） |
 * |---|---|
 * | `rt_roster` | `src/roster.mjs` → `handleRoster` |
 * | `rt_dispatch` | `src/dispatch.mjs` → `handleDispatch` |
 * | `rt_conclude` | `src/conclude.mjs` → `handleConclude` |
 *
 * 形状约束（E1 笔记 §C、DECISIONS D15/D17）：
 * - 只用具名导出：`name` / `inject` / `apply`（+ 本文件导出的纯函数接缝），没有 default export。
 * - `inject` 只放**硬依赖** `tools`；`agentTeams` 用 `ctx.get('agentTeams')` 探针 + 降级。
 * - 现代码里**不 import 任何 `@deepseek-ai/*`**：本地 `link:` 的 bundle 按自身真实路径解析裸包名，
 *   这类 import 会 `ERR_MODULE_NOT_FOUND`，整行插件直接不激活。
 * - 入参是**原始 JSON Schema**（`src/tool-schema.mjs` 的副本），宿主不为 raw-schema 工具做入参校验，
 *   所以校验由本文件在**产生任何副作用之前**做完。
 * - `execute` 只返回**一个规范 JSON 值**（就是 `$defs.result` 信封）；宿主快照 → 校验 → 冻结 →
 *   `render(args, value)`。`render` 必须纯、必须全能、绝不抛。
 * - handler 抛异常一律转成 `error` 信封（`envelope.fromError`），不把栈抛给注册表。
 *
 * @module @local/dsh-redteam-lead
 */

import * as fsPromises from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// —— 内核（T1）：信封、错误码、校验、路径、原子写、锁、身份、操作台账、审计 ——
import * as envelope from './src/envelope.mjs'
import * as errors from './src/errors.mjs'
import * as validate from './src/validate.mjs'
import * as paths from './src/paths.mjs'
import * as atomic from './src/atomic.mjs'
import * as lock from './src/lock.mjs'
import * as identity from './src/identity.mjs'
import * as operation from './src/operation.mjs'
import * as audit from './src/audit.mjs'

// —— 岗位目录 / 能力 / 预算（T3）——
import * as catalog from './src/catalog.mjs'
import * as capability from './src/capability.mjs'
import * as capacity from './src/capacity.mjs'

// —— 适配器（T4）：团队服务、项目 skill CLI、兼容性摘要 ——
import { createTeamAdapter } from './src/team-adapter.mjs'
import { createProjectAdapter } from './src/project-adapter.mjs'
import * as compatibility from './src/compatibility.mjs'

// —— 本包的 handler（T5/T6/T7 整体替换这三个文件，不改本文件）——
import { handleRoster } from './src/roster.mjs'
import { handleDispatch } from './src/dispatch.mjs'
import { handleConclude } from './src/conclude.mjs'

// —— 包内 schema 副本（与 docs/specs/rt-tools.schema.json 有漂移测试）——
// `*Parameters` 是展开 `$ref` 后的自包含入参 schema；`resultOutput` 是宿主支持子集里的
// `$defs.result` 投影（`assertSupportedJsonSchema` 不认 `$ref`/`allOf`/类型数组）。
import { schemaDefs, rosterParameters, dispatchParameters, concludeParameters, resultOutput } from './src/tool-schema.mjs'

/** 插件名（插件清单/日志用）。 */
export const name = 'redteam-lead-tools'

/**
 * 硬依赖只有工具注册表。`agentTeams` / `agentPresets` / `subagents` 都是**可选**能力：
 * 本 Cordis 没有 `inject: { optional }`，只能在用点 `ctx.get('x')` 探针并降级。
 */
export const inject = ['tools']

/** 本包根目录（doctor 入口与 `config.bundleRoot` 共用）。 */
const BUNDLE_ROOT = dirname(fileURLToPath(import.meta.url))

/** `config.presetId`：本包只服务这一个 preset。 */
const PRESET_ID = 'redteam-lead'

/** 默认 handler 表；T5/T6/T7 只替换 `src/*.mjs` 的实现。 */
const DEFAULT_HANDLERS = Object.freeze({
  roster: handleRoster,
  dispatch: handleDispatch,
  conclude: handleConclude,
})

/**
 * 三个工具的静态定义。`parameters` 是**自包含**的原始 JSON Schema（`$ref` 已就地展开），
 * 注册进 `ctx.tools.register` 后直接进模型上下文。
 *
 * `defName` 是 `$defs` 里的名字，用于本文件自己的入参校验与诊断（本包校验用**完整规格**
 * schema，不是注册用的展开副本）。
 */
export const TOOLS = Object.freeze([
  {
    name: 'rt_roster',
    handler: 'roster',
    defName: 'rosterInput',
    parameters: rosterParameters,
    title: 'Inspect or bind the red-team roster',
    description:
      'Read-only roster diagnosis for a reverse-engineering project (action=inspect, default), or bind/takeover ' +
      'the project+session binding (Lead only). Reports project-skill compatibility gaps, candidate posts, ' +
      'capacity, recommended members and a proposal hash. Action=bind/takeover additionally needs operation_id, ' +
      'proposal_hash and at least one target_kind; takeover also needs recovery_ref.',
  },
  {
    name: 'rt_dispatch',
    handler: 'dispatch',
    defName: 'dispatchInput',
    parameters: dispatchParameters,
    title: 'Dispatch one contract to a teammate',
    description:
      'Lead only. Persist one dispatch contract for a route and target set, spawn or reuse the teammate for a ' +
      'post, create and assign the host task, then deliver the contract envelope. Returns dispatch/attempt/task/' +
      'member identities plus the contract and work-directory references. A partial envelope means side effects ' +
      'may already exist — resume with the same operation_id.',
  },
  {
    name: 'rt_conclude',
    handler: 'conclude',
    defName: 'concludeInput',
    parameters: concludeParameters,
    title: 'Conclude one dispatch and complete its task',
    description:
      'Lead only. Validate one submission against its dispatch baseline and anchor set, run the project-skill ' +
      'checks (impact / seal / index / check --hashes), write the receipt, then complete the host task. ' +
      'Repeat with the same operation_id returns the original receipt.',
  },
])

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** `$defs.id` 的形状（`operation_id`）。校验失败时也要能安全地放进信封。 */
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/

/**
 * 信封构造器的 operation id 参数名，在 `docs/impl/UPSTREAM-API.md`（`operation_id`）与
 * `src/envelope.mjs` 当前实现（`operationId`）之间不一致。这里两个键都传：
 * 任一形状都能取到，**不会把 operation id 悄悄丢成 null**。等 T1 统一成一处后可以收成一个键。
 * @param {string | null} operationId
 */
function envelopeIds(operationId) {
  return { operationId, operation_id: operationId }
}

/**
 * 从入参里取一个**可以放进信封**的 operation id：形状不合法就当没有，
 * 免得「入参非法」这个分支自己再抛异常。
 * @param {unknown} args
 * @returns {string | null}
 */
export function operationIdOf(args) {
  if (args === null || typeof args !== 'object') return null
  const value = args.operation_id
  return typeof value === 'string' && OPERATION_ID.test(value) ? value : null
}

/** 探针：宿主可选注入的服务，缺就是 undefined（不要让缺服务把插件拖垮）。 */
function probeServices(ctx) {
  const get = typeof ctx?.get === 'function' ? (service) => ctx.get(service) : () => undefined
  return { agentTeams: get('agentTeams'), tools: get('tools') }
}

/** `fs/promises` 的薄封装：SEAMS 要求测试可以注入内存实现。 */
function fileSystem() {
  return {
    readFile: fsPromises.readFile,
    writeFile: fsPromises.writeFile,
    rename: fsPromises.rename,
    mkdir: fsPromises.mkdir,
    stat: fsPromises.stat,
    lstat: fsPromises.lstat,
    readdir: fsPromises.readdir,
    unlink: fsPromises.unlink,
    open: fsPromises.open,
  }
}

/**
 * 装配一次调用用的依赖表。**键名与 SEAMS.md 第 1 节逐字一致**。
 *
 * `binding` / `contract` / `resources` / `submission` / `anchors` / `baseline` 属于 T5/T6/T7，
 * 本 ticket 只给 `null`：那六个模块尚未存在，提前静态 import 会让本文件整体加载失败。
 *
 * 适配器工厂的入参形状由 T4 最终确定；这里把当次调用能拿到的上下文**原样**给出
 * （`services` / `exec` / `config` / `ctx` / `deps`），工厂取自己需要的字段即可。
 *
 * @param {{ services: object, exec: unknown, config: object, ctx?: unknown }} options
 * @returns {object} `ctx.deps`
 */
export function createDeps({ services, exec, config, ctx = undefined }) {
  const clock = {
    now: () => Date.now(),
    isoNow: () => new Date(clock.now()).toISOString(),
  }
  const deps = {
    envelope, errors, validate, paths, atomic, lock, identity, operation, audit,
    catalog, capability, capacity,
    teamAdapter: null,
    projectAdapter: null,
    compatibility,
    binding: null,
    contract: null,
    resources: null,
    submission: null,
    anchors: null,
    baseline: null,
    clock,
    fs: fileSystem(),
  }
  // 适配器是薄封装宿主服务的有状态对象：每次调用按当次的 exec/config 装配一次。
  const adapterOptions = { services, exec, config, ctx, deps }
  deps.teamAdapter = createTeamAdapter(adapterOptions)
  deps.projectAdapter = createProjectAdapter(adapterOptions)
  return deps
}

/** `ctx.config`：handler 能看到的部署配置（defaults 来自 patch 里的本包行）。 */
function configView(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const defaults = raw.defaults !== null && typeof raw.defaults === 'object' ? raw.defaults : {}
  return { defaults, presetId: PRESET_ID, bundleRoot: BUNDLE_ROOT }
}

/** 把校验 issue 压成一句人读的原因（不堆几十行）。 */
function describeIssues(issues) {
  const shown = issues.slice(0, 8).map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
  const more = issues.length > shown.length ? `（另有 ${issues.length - shown.length} 项）` : ''
  return `入参不符合契约：${shown.join('；')}${more}`
}

/**
 * 组装交给 handler 的上下文（SEAMS 第 1 节的 `HandlerCtx`）。
 * @param {{ deps: object, exec: unknown, services: object, config: object }} options
 */
export function handlerContext({ deps, exec, services, config }) {
  return {
    deps,
    exec,
    services,
    config: configView(config),
    now: deps.clock.now,
  }
}

/**
 * 把一次工具调用走完：解析入参 → 校验 → 分发到 handler → 返回信封。**绝不抛**。
 *
 * 这是本包真正拥有的那段逻辑（校验/路由/错误兜底），单独导出以便测试用假 handler 验收接缝。
 *
 * @param {{
 *   tool: string,
 *   args: unknown,
 *   exec?: unknown,
 *   ctx?: unknown,
 *   config?: object,
 *   handlers?: Record<string, Function>,
 * }} options
 * @returns {Promise<object>} `$defs.result` 信封
 */
export async function invokeTool(options) {
  const { tool, args, exec = undefined, ctx = undefined, config = {}, handlers = DEFAULT_HANDLERS } = options
  const spec = TOOL_BY_NAME.get(tool)
  if (spec === undefined) {
    // 只有编程错误会走到这里（注册表按本文件声明的名字调用）。
    throw new TypeError(`未知工具名：${String(tool)}`)
  }

  const services = probeServices(ctx)
  // 先装配 deps：handler 需要它，INVALID_ARGUMENT 分支也需要用它造信封。
  let deps
  try {
    deps = createDeps({ services, exec, config, ctx })
  } catch (thrown) {
    // 适配器工厂炸了：仍然要给注册表一个合法信封。
    return errorEnvelopeWithoutDeps(LOCAL_FALLBACK_CODES.adapter, thrown)
  }

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return deps.envelope.error({
      code: 'INVALID_ARGUMENT',
      ...envelopeIds(null),
      reason: `${spec.name} 的入参必须是对象，实际是 ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`,
      nextStep: `按 docs/specs/rt-tools.schema.json 的 $defs.${spec.defName} 传对象；本包在产生任何副作用前完成校验`,
      data: null,
    })
  }

  // 「解出 action」：roster 的默认 action 是 inspect（schema 的 default 只是注解，这里显式填）。
  const input = { ...args }
  if (spec.handler === 'roster' && input.action === undefined) input.action = 'inspect'

  const checked = deps.validate.validateInput(schemaDefs, spec.defName, input)
  if (!checked.ok) {
    return deps.envelope.error({
      code: 'INVALID_ARGUMENT',
      ...envelopeIds(null),
      reason: describeIssues(checked.issues),
      nextStep: `按 docs/specs/rt-tools.schema.json 的 $defs.${spec.defName} 修正入参（字段形状、必填项与枚举以该 schema 为准）；本次调用未产生任何副作用`,
      data: null,
    })
  }

  const operationId = operationIdOf(input)
  const handler = handlers[spec.handler]
  if (typeof handler !== 'function') {
    return deps.envelope.error({
      code: 'INVALID_ARGUMENT',
      ...envelopeIds(operationId),
      reason: `${spec.name} 的 handler 未装配（${spec.handler}）`,
      nextStep: '这是本包的装配错误：检查 index.js 的 DEFAULT_HANDLERS 是否包含该 handler',
      data: null,
    })
  }

  try {
    const produced = await handler(handlerContext({ deps, exec, services, config }), input)
    const shell = produced?.envelope
    // handler 的信封仍要自己验一遍：不合规就转成 error 信封，绝不把 INVALID_TOOL_OUTPUT 抛给注册表。
    const verdict = deps.validate.validateInput(schemaDefs, 'result', shell)
    if (!verdict.ok) {
      return deps.envelope.error({
        code: 'RECOVERY_REQUIRED',
        ...envelopeIds(operationId),
        reason: `${spec.name} 的 handler 返回的信封不符合 $defs.result：${describeIssues(verdict.issues)}`,
        nextStep: '按 docs/specs/rt-tools.schema.json 的 $defs.result 构造信封（八字段齐全；ok 的 code 必须是 null）',
        data: null,
      })
    }
    return shell
  } catch (thrown) {
    // ContractError 沿用其码；未知异常 → RECOVERY_REQUIRED + status=error（DECISIONS D22），且不把栈写进信封。
    return deps.envelope.fromError(thrown, { ...envelopeIds(operationId) })
  }
}

/** 连 `deps` 都装配不出来时的兜底码（仍然只用契约表里的稳定码）。 */
const LOCAL_FALLBACK_CODES = Object.freeze({ adapter: 'TEAM_SERVICE_UNAVAILABLE' })

/**
 * 极端兜底：适配器装配失败时，手工构造一个合法信封。
 * 只在这里出现字面构造 —— 正常路径一律经 `src/envelope.mjs`。
 * @param {string} code
 * @param {unknown} thrown
 */
function errorEnvelopeWithoutDeps(code, thrown) {
  const message = thrown instanceof Error ? thrown.message : String(thrown)
  return {
    schema_version: 1,
    status: 'error',
    code,
    operation_id: null,
    replayed: false,
    retryable: false,
    diagnostics: [
      {
        code,
        reason: `依赖装配失败：${message}`,
        next_step: '这是本包与环境装配的错误：检查 ctx.get 的服务形状与 scripts；团队服务未启用时先跑 bin/doctor.mjs',
      },
    ],
    data: null,
  }
}

/** 状态标签。 */
const STATUS_LABEL = Object.freeze({
  ok: '成功',
  blocked: '前置拒绝',
  partial: '部分完成（可能已有副作用）',
  error: '失败',
})

function textLine(text) {
  return { type: 'text', text }
}

/**
 * `output.render` 的唯一实现：把信封投影成一段人读文本。
 *
 * 契约要求它是**纯函数且全能**：宿主对每次成功调用都跑它，抛一次就是 `INVALID_TOOL_OUTPUT`。
 * 所以这里对每个字段都做类型判断，并在最外层兜住异常。
 *
 * @param {string} label 工具名
 * @param {unknown} value 宿主校验并冻结后的信封
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function renderResult(label, value) {
  try {
    if (value === null || typeof value !== 'object') return [textLine(`${label}：没有可读的返回值。`)]

    const status = typeof value.status === 'string' ? value.status : 'unknown'
    const code = value.code === null || value.code === undefined ? '—' : String(value.code)
    const lines = [`${label}：${STATUS_LABEL[status] ?? status}（code ${code}）`]

    if (value.replayed === true) lines.push('这是同一 operation 的重放结果（replayed=true）。')
    if (value.retryable === true) lines.push('允许以同一 operation_id 重入（retryable=true），但不代表自动重试。')

    const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : []
    if (diagnostics.length > 0) {
      lines.push('诊断：')
      for (const entry of diagnostics) {
        const reason = typeof entry?.reason === 'string' ? entry.reason : String(entry?.reason ?? '')
        const nextStep = typeof entry?.next_step === 'string' ? entry.next_step : String(entry?.next_step ?? '')
        const entryCode = typeof entry?.code === 'string' ? entry.code : String(entry?.code ?? '')
        lines.push(`- [${entryCode}] ${reason}`)
        if (nextStep.length > 0) lines.push(`  下一步：${nextStep}`)
      }
    }

    lines.push(...summarizeData(label, value.data))
    return [textLine(lines.join('\n'))]
  } catch {
    return [textLine(`${label}：结果无法渲染（render 兜底）。`)]
  }
}

/** 按工具给 data 一段摘要；字段一律先判类型，缺就跳过。 */
function summarizeData(label, data) {
  if (data === null || data === undefined || typeof data !== 'object') return ['data：无']
  const lines = []
  const push = (key, value) => {
    if (value !== undefined && value !== null) lines.push(`${key}：${String(value)}`)
  }

  if (label === 'rt_roster') {
    push('action', data.action)
    push('project_root', data.project_root)
    push('compatibility', data.compatibility)
    if (Array.isArray(data.posts)) push('posts', data.posts.length)
    if (Array.isArray(data.gaps)) push('gaps', data.gaps.length)
    push('recommended_members', data.recommended_members)
    push('proposal_hash', data.proposal_hash)
    push('binding_ref', data.binding_ref)
  } else if (label === 'rt_dispatch') {
    push('dispatch_id', data.dispatch_id)
    push('attempt_id', data.attempt_id)
    push('task_id', data.task_id)
    push('member', data.member)
    push('route_id', data.route_id)
    push('revision', data.revision)
    push('phase', data.phase)
    push('contract_ref', data.contract_ref)
    push('work_dir', data.work_dir)
    lines.push(`started_at：${data.started_at === null || data.started_at === undefined ? '未开始（等待成员 start.json）' : String(data.started_at)}`)
  } else if (label === 'rt_conclude') {
    push('dispatch_id', data.dispatch_id)
    push('attempt_id', data.attempt_id)
    push('task_id', data.task_id)
    push('phase', data.phase)
    push('outcome', data.outcome)
    push('route_status', data.route_status)
    push('receipt_ref', data.receipt_ref)
    push('audit_written', data.audit_written)
    if (Array.isArray(data.checks)) push('checks', data.checks.length)
  } else {
    push('phase', data.phase)
  }

  return lines.length === 0 ? ['data：无'] : lines
}

/**
 * 注册三个工具。在 `apply` 里调用，让 fiber 拥有 disposer。
 * @param {object} ctx Cordis 上下文（需要 `ctx.tools.register` 与可选的 `ctx.get`）
 * @param {object} [config] 本包行的 `config`（可带 `defaults`）
 */
export function apply(ctx, config = {}) {
  for (const spec of TOOLS) {
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      // 原始 JSON Schema（自包含、无 $ref）：`defineTool` 的类型 DSL 在 link: 安装的 bundle 里不可用。
      parameters: spec.parameters,
      output: {
        // 必须是宿主支持子集里的 schema（$defs.result 的投影），否则 register() 直接抛 UNSUPPORTED_SCHEMA
        schema: resultOutput,
        render: (_args, value) => renderResult(spec.name, value),
      },
      async execute(args, exec) {
        return invokeTool({ tool: spec.name, args, exec, ctx, config })
      },
      // UI-only、必须纯；Web Client 目前不消费它（E1 §C.3），但保留与既有包一致的可展示字段。
      presentCall: (args) => ({ card: 'generic', title: spec.title, kind: 'other', rawInput: args }),
    })
  }
}
