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
import * as envelope from './envelope.js'
import * as errors from './errors.js'
import * as validate from './validate.js'
import * as paths from './paths.js'
import * as atomic from './atomic.js'
import * as lock from './lock.js'
import * as identity from './identity.js'
import * as operation from './operation.js'
import * as audit from './audit.js'

// —— 岗位目录 / 能力 / 预算（T3）——
import * as catalog from './catalog.js'
import * as capability from './capability.js'
import * as capacity from './capacity.js'

// —— 项目/会话记录（T5–T7）：绑定、派发契约、资源、提交、锚点、基准 ——
// 这六个都是**纯模块命名空间**（SEAMS §1 的第一种形状），由 handler 直接调用其导出函数。
import * as binding from './binding.js'
import * as contract from './contract.js'
import * as resources from './resources.js'
import * as submission from './submission.js'
import * as anchors from './anchors.js'
import * as baseline from './baseline.js'

// —— 适配器（T4）：团队服务、项目 skill CLI、兼容性摘要 ——
import { createTeamAdapter } from './team-adapter.js'
import { createProjectAdapter } from './project-adapter.js'
import * as compatibility from './compatibility.js'

// —— 本包的 handler（T5/T6/T7 整体替换这三个文件，不改本文件）——
import { handleRoster } from './roster.js'
import { handleDispatch } from './dispatch.js'
import { handleConclude } from './conclude.js'

// —— 包内 schema 副本（与 docs/specs/rt-tools.schema.json 有漂移测试）——
// `*Parameters` 是展开 `$ref` 后的自包含入参 schema；`resultOutput` 是宿主支持子集里的
// `$defs.result` 投影（`assertSupportedJsonSchema` 不认 `$ref`/`allOf`/类型数组）。
import { schemaDefs, rosterParameters, dispatchParameters, concludeParameters, resultOutput } from './tool-schema.js'
import { recordOf } from './guards.js'
import type { Deps, Envelope, HandlerConfig, HandlerCtx, HandlerResult } from './types.js'

/** 插件名（插件清单/日志用）。 */
export const name = 'redteam-lead-tools'

/**
 * 硬依赖只有工具注册表。`agentTeams` / `agentPresets` / `subagents` 都是**可选**能力：
 * 本 Cordis 没有 `inject: { optional }`，只能在用点 `ctx.get('x')` 探针并降级。
 */
export const inject = ['tools']

/** 本包根目录（doctor 入口与 `config.bundleRoot` 共用；`dist/` 的上一级就是包根）。 */
const BUNDLE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** `config.presetId`：本包只服务这一个 preset。 */
const PRESET_ID = 'redteam-lead'

/**
 * 默认 handler 表；T5/T6/T7 只替换 `src/*.mjs` 的实现。
 *
 * 显式标成索引签名表（键就是各工具声明里的 `handler` 名，运行期按名取）：不标的话
 * `Object.freeze` 的字面量类型会与 `invokeTool` 的 `handlers` 选项类型并成一个
 * 没有索引签名的联合，`handlers[spec.handler]` 就取不出来。
 */
const DEFAULT_HANDLERS: Record<string, Function> = Object.freeze({
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
function envelopeIds(operationId: string | null): { operationId: string | null, operation_id: string | null } {
  return { operationId, operation_id: operationId }
}

/**
 * 从入参里取一个**可以放进信封**的 operation id：形状不合法就当没有，
 * 免得「入参非法」这个分支自己再抛异常。
 * @param {unknown} args
 * @returns {string | null}
 */
export function operationIdOf(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const value = recordOf(args).operation_id
  return typeof value === 'string' && OPERATION_ID.test(value) ? value : null
}

/** 宿主可选注入的服务：`agentTeams` / `tools`，缺就是 `undefined`。 */
interface ProbeServices {
  agentTeams: unknown
  tools: unknown
}

/** 探针：宿主可选注入的服务，缺就是 undefined（不要让缺服务把插件拖垮）。 */
function probeServices(ctx: unknown): ProbeServices {
  const context = recordOf(ctx)
  // 等价于原来的 `(service) => ctx.get(service)`：有 `get` 就以 `ctx` 为 this 调用，没有就恒 undefined。
  const get: (service: string) => unknown = typeof context.get === 'function'
    ? context.get.bind(context)
    : () => undefined
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

/** `createDeps` 的选项：当次调用的服务探针、exec、部署配置与已解析的项目根。 */
interface CreateDepsOptions {
  services: ProbeServices
  exec: unknown
  config: Record<string, unknown>
  ctx?: unknown
  /** 已 `normalizeProjectRoot` 的真实根；`undefined` = 本次没有可用根。 */
  projectRoot?: string
}

/**
 * 装配一次调用用的依赖表。**键名与 SEAMS.md 第 1 节逐字一致**（`DEP_KEYS`）。
 *
 * 两种形状（SEAMS §1）：
 * - `envelope` … `baseline` 与 `compatibility` 是**模块命名空间**，handler 直接用其导出函数；
 * - `teamAdapter` / `projectAdapter` 是**每次调用新建**的适配器实例，把当次的
 *   exec/services/config 与 `projectRoot` 绑进去（不跨调用复用）。
 *
 * `projectRoot` 必须由调用方（`invokeTool`）先解析入参、`normalizeProjectRoot` 之后再传进来：
 * 适配器只有在拿到真实根时才能读 `re/routes/**`、`re/team/capacity.json`。传 `undefined`
 * 表示本次没有可用根（入参非法），适配器仍会装配但不绑定 —— 由 handler 返回可读错误。
 *
 * @param {{ services: object, exec: unknown, config: object, ctx?: unknown,
 *           projectRoot?: string }} options
 * @returns {object} `ctx.deps`
 */
export function createDeps({ services, exec, config, ctx = undefined, projectRoot = undefined }: CreateDepsOptions): Deps {
  const clock = {
    now: () => Date.now(),
    isoNow: () => new Date(clock.now()).toISOString(),
  }
  const deps: Deps = {
    envelope, errors, validate, paths, atomic, lock, identity, operation, audit,
    catalog, capability, capacity,
    teamAdapter: null,
    projectAdapter: null,
    compatibility,
    binding,
    contract,
    resources,
    submission,
    anchors,
    baseline,
    clock,
    fs: fileSystem(),
  }
  // 适配器是薄封装宿主服务的有状态对象：每次调用按当次的 exec/config/projectRoot 装配一次。
  const adapterOptions = { services, exec, config, ctx, deps, projectRoot }
  deps.teamAdapter = createTeamAdapter(adapterOptions)
  deps.projectAdapter = createProjectAdapter(adapterOptions)
  return deps
}

/** `ctx.config`：handler 能看到的部署配置（defaults 来自 patch 里的本包行）。 */
function configView(config: unknown): HandlerConfig {
  const raw = recordOf(config)
  const defaults = recordOf(raw.defaults)
  return { defaults, presetId: PRESET_ID, bundleRoot: BUNDLE_ROOT }
}

/** 校验 issue 的可读面（`validate.validateInput()` 的 `issues` 元素）。 */
interface ValidationIssue {
  path: string
  message: string
}

/** 把校验 issue 压成一句人读的原因（不堆几十行）。 */
function describeIssues(issues: readonly ValidationIssue[]): string {
  const shown = issues.slice(0, 8).map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
  const more = issues.length > shown.length ? `（另有 ${issues.length - shown.length} 项）` : ''
  return `入参不符合契约：${shown.join('；')}${more}`
}

/** `handlerContext` 的入参。 */
interface HandlerContextOptions {
  deps: Deps
  exec: unknown
  services: ProbeServices
  config: unknown
}

/**
 * 组装交给 handler 的上下文（SEAMS 第 1 节的 `HandlerCtx`）。
 * @param {{ deps: object, exec: unknown, services: object, config: object }} options
 */
export function handlerContext({ deps, exec, services, config }: HandlerContextOptions): HandlerCtx {
  return {
    deps,
    exec,
    services,
    config: configView(config),
    now: deps.clock.now,
  }
}

/** handler 的契约形状（SEAMS §1）：`(ctx, 已校验入参)` → `{envelope}`，绝不 reject。 */
type ToolHandler = (ctx: HandlerCtx, input: Record<string, unknown>) => Promise<HandlerResult>

/** `invokeTool` 的入参（测试会传假 handler 验收接缝）。 */
interface InvokeToolOptions {
  tool: string
  args: unknown
  exec?: unknown
  ctx?: unknown
  config?: Record<string, unknown>
  handlers?: Record<string, Function>
}

/**
 * 把一次工具调用走完：解析入参 → 校验 → 规范化 `project_root` → 建两个适配器 → 交给 handler → 返回信封。
 * **绝不抛**（未知工具名是唯一的编程错误）。
 *
 * 顺序是硬要求（T12）：`projectRoot` 是适配器的构造参数，必须在装配**之前**从入参里解出来并
 * `normalizeProjectRoot`；否则 `readRoute/impact/readSeals` 在生产里一律 `PROJECT_NOT_CONFIGURED`。
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
export async function invokeTool(options: InvokeToolOptions): Promise<Envelope> {
  const { tool, args, exec = undefined, ctx = undefined, config = {}, handlers = DEFAULT_HANDLERS } = options
  const spec = TOOL_BY_NAME.get(tool)
  if (spec === undefined) {
    // 只有编程错误会走到这里（注册表按本文件声明的名字调用）。
    throw new TypeError(`未知工具名：${String(tool)}`)
  }

  const services = probeServices(ctx)

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return envelope.error({
      code: 'INVALID_ARGUMENT',
      ...envelopeIds(null),
      reason: `${spec.name} 的入参必须是对象，实际是 ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`,
      nextStep: `按 docs/specs/rt-tools.schema.json 的 $defs.${spec.defName} 传对象；本包在产生任何副作用前完成校验`,
      data: null,
    })
  }

  // 「解出 action」：roster 的默认 action 是 inspect（schema 的 default 只是注解，这里显式填）。
  // 仍是一次浅拷贝（`args` 在上面已收窄为非 null 对象；`recordOf` 对它是**恒等**，
  // 只是把副本标成索引签名记录，好让后面的 `input.action` 读成 `unknown`）。
  const input: Record<string, unknown> = { ...recordOf(args) }
  if (spec.handler === 'roster' && input.action === undefined) input.action = 'inspect'

  // 1) 校验：产生任何副作用（含建适配器）之前完成。
  const checked = validate.validateInput(schemaDefs, spec.defName, input)
  if (!checked.ok) {
    return envelope.error({
      code: 'INVALID_ARGUMENT',
      ...envelopeIds(null),
      reason: describeIssues(checked.issues),
      nextStep: `按 docs/specs/rt-tools.schema.json 的 $defs.${spec.defName} 修正入参（字段形状、必填项与枚举以该 schema 为准）；本次调用未产生任何副作用`,
      data: null,
    })
  }

  // 2) 规范化本次的 project_root —— **必须在建适配器之前**。
  //    适配器是「薄封装本次项目」的有状态对象：projectRoot 是它的构造参数，事后补不了
  //    （T5/T6 各自报过 `readRoute/impact/readSeals` 一律 PROJECT_NOT_CONFIGURED）。
  //    规范化失败时不绑定根：适配器照旧装配，但 handler 仍会被调用并给出可读错误
  //    （handler 自己也会 normalizeProjectRoot，抛出的 ContractError 由下面统一转信封）。
  const rootAttempt = await resolveProjectRoot(input)

  // 3) 装配：键名与 SEAMS §1 一致，六个 T5–T7 模块是真实命名空间。
  let deps: Deps
  try {
    deps = createDeps({ services, exec, config, ctx, projectRoot: rootAttempt })
  } catch (thrown) {
    // 适配器工厂炸了：仍然要给注册表一个合法信封。
    return errorEnvelopeWithoutDeps(LOCAL_FALLBACK_CODES.adapter, thrown)
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

/**
 * 解析并规范化入参里的 `project_root`。**绝不抛**：失败返回 `undefined`（本次不绑定根）。
 *
 * 失败原因**不在这里吞掉**：三个 handler 自己第一步就 `normalizeProjectRoot`，会把
 * `PATH_INVALID` 的原话与下一步放进信封（`test/assembly.test.mjs` 有用例钉住这一点）。
 * 这里只决定「适配器建不建得上根」。
 *
 * @param {{ project_root?: unknown }} input
 * @returns {Promise<string | undefined>}
 */
async function resolveProjectRoot(input: { project_root?: unknown }): Promise<string | undefined> {
  try {
    return await paths.normalizeProjectRoot(input?.project_root)
  } catch {
    return undefined
  }
}

/** 连 `deps` 都装配不出来时的兜底码（仍然只用契约表里的稳定码）。 */
const LOCAL_FALLBACK_CODES = Object.freeze({ adapter: 'TEAM_SERVICE_UNAVAILABLE' })

/**
 * 极端兜底：适配器装配失败时，手工构造一个合法信封。
 * 只在这里出现字面构造 —— 正常路径一律经 `src/envelope.mjs`。
 *
 * 返回类型写死成 `Envelope` 是**契约要求**（`$defs.result` 八字段），不是装饰：
 * 字面量在这里必须按信封收窄，否则 `status: 'error'` 会被推成 `string`。
 * @param {string} code
 * @param {unknown} thrown
 */
function errorEnvelopeWithoutDeps(code: string, thrown: unknown): Envelope {
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

/**
 * 状态标签。标成 `string | undefined` 的查表：`status` 来自宿主快照，可能是四种之外的
 * 值，`STATUS_LABEL[status] ?? status` 的兜底就是为此而写。
 */
const STATUS_LABEL: Readonly<Record<string, string | undefined>> = Object.freeze({
  ok: '成功',
  blocked: '前置拒绝',
  partial: '部分完成（可能已有副作用）',
  error: '失败',
})

/** `render` 的返回元素（宿主只接受文本块）。 */
interface TextBlock {
  type: 'text'
  text: string
}

function textLine(text: string): TextBlock {
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
export function renderResult(label: string, value: unknown): TextBlock[] {
  try {
    if (value === null || typeof value !== 'object') return [textLine(`${label}：没有可读的返回值。`)]
    // `value` 到这里已是非 null 对象；`recordOf` 对它是**恒等**，只把字段读成 `unknown`。
    const view = recordOf(value)

    const status = typeof view.status === 'string' ? view.status : 'unknown'
    const code = view.code === null || view.code === undefined ? '—' : String(view.code)
    const lines = [`${label}：${STATUS_LABEL[status] ?? status}（code ${code}）`]

    if (view.replayed === true) lines.push('这是同一 operation 的重放结果（replayed=true）。')
    if (view.retryable === true) lines.push('允许以同一 operation_id 重入（retryable=true），但不代表自动重试。')

    const diagnostics: unknown[] = Array.isArray(view.diagnostics) ? view.diagnostics : []
    if (diagnostics.length > 0) {
      lines.push('诊断：')
      for (const entry of diagnostics) {
        // 与原来的 `entry?.reason` 逐字等价：非记录（含 null/原语）读出来就是 undefined。
        const item = recordOf(entry)
        const reason = typeof item.reason === 'string' ? item.reason : String(item.reason ?? '')
        const nextStep = typeof item.next_step === 'string' ? item.next_step : String(item.next_step ?? '')
        const entryCode = typeof item.code === 'string' ? item.code : String(item.code ?? '')
        lines.push(`- [${entryCode}] ${reason}`)
        if (nextStep.length > 0) lines.push(`  下一步：${nextStep}`)
      }
    }

    lines.push(...summarizeData(label, view.data))
    return [textLine(lines.join('\n'))]
  } catch {
    return [textLine(`${label}：结果无法渲染（render 兜底）。`)]
  }
}

/**
 * `render` 写进文本的标量：只接受字符串/数字/布尔/大整数。
 *
 * 对象、数组、`null`/`undefined` 一律返回 `''`（「无值」），由调用方决定降级成什么 ——
 * 这样病态 data 不会把 `[object Object]`/`undefined` 写进模型看到的那段文本。
 */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return ''
}

/** 折叠换行/连续空白但不截断（比对用；显示时再截断）。 */
function flatText(value: unknown): string {
  return scalarText(value).replace(/\s+/gu, ' ').trim()
}

/** 截断到 `max` 个字符（`…` 表示后面还有）；`reason` 契约上是一行，渲染也不允许它把版面撑开。 */
function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 一行文本：折叠空白 + 截断。 */
function oneLineText(value: unknown, max: number): string {
  return clipText(flatText(value), max)
}

/** 「要么有值、要么未知」的字段：缺失/异常形状一律写 `null`（与 D19 的 capacity 口径一致）。 */
function scalarOrNull(value: unknown): string {
  const text = oneLineText(value, 200)
  return text.length > 0 ? text : 'null'
}

/**
 * D19：wire `capacity` 恰好 4 个字段（没有 `known`）。未知写 `null`，不猜、不省略字段 ——
 * A09 的判据就是「未知显示 null，声明后显示数值」，渲染层必须把这两态都摆出来。
 */
const CAPACITY_FIELDS = Object.freeze([
  'remaining_member_slots',
  'remaining_activations',
  'reserved_member_slots',
  'reserved_activations',
] as const)

/** `capacity` 一行：`remaining_member_slots=7，remaining_activations=null，…`。 */
function capacityLine(capacity: unknown): string {
  const view = recordOf(capacity)
  const parts = CAPACITY_FIELDS.map((field) => {
    const value = view[field]
    const known = typeof value === 'number' && Number.isFinite(value)
    return `${field}=${known ? String(value) : 'null'}`
  })
  return `capacity：${parts.join('，')}`
}

/**
 * `posts` 摘要：一行一个岗位（`post_id` + `state` + 成员/所需能力族/一行 reason），不整段 JSON。
 *
 * `required` 是岗位**要求**的能力族（含 `shell`/`fs` 这类已被满足的），所以只标「要求」而不标
 * 「缺失」：真正缺哪一族写在岗位自己的 `reason` 与 `gaps` 条目里，渲染层不替数据下结论。
 *
 * `gapReasons` 是 `gaps` 段已经打印过的 reason：容量模块把同一条缺口拼成 `岗位 <post_id> <reason>`
 * 投进 gaps，这里就不再逐字重复一遍 —— 岗位行保持摘要，细节仍在下面 `gaps` 段可读。
 */
function postsLines(posts: unknown, gapReasons: ReadonlySet<string>): string[] {
  if (!Array.isArray(posts)) return ['posts：无法读取（不是数组）']
  const lines = [`posts（${posts.length}）：`]
  for (const entry of posts) {
    const view = recordOf(entry)
    const postId = oneLineText(view.post_id, 64) || '(未命名岗位)'
    const state = oneLineText(view.state, 32) || '(状态未知)'
    const details: string[] = []
    const member = oneLineText(view.member, 64)
    if (member.length > 0) details.push(`成员 ${member}`)
    // 显式收成 `unknown[]`：`Array.isArray` 的窄化是 `any[]`，到回调里就成了隐式 any。
    const requiredNames: unknown[] = Array.isArray(view.required) ? view.required : []
    const required = requiredNames.map((name) => oneLineText(name, 48)).filter((name) => name.length > 0)
    if (required.length > 0) details.push(`要求 ${required.join('／')}`)
    const reason = flatText(view.reason)
    if (reason.length > 0 && !gapReasons.has(`岗位 ${postId} ${reason}`)) details.push(clipText(reason, 160))
    lines.push(`- ${postId}：${state}${details.length > 0 ? `；${details.join('；')}` : ''}`)
  }
  return lines
}

/** `gaps` 段将要打印的 reason 原文（`posts` 去重用；只折叠空白，不截断）。 */
function gapReasonSet(gaps: unknown): ReadonlySet<string> {
  const reasons = new Set<string>()
  if (!Array.isArray(gaps)) return reasons
  for (const entry of gaps) {
    const reason = flatText(recordOf(entry).reason)
    if (reason.length > 0) reasons.add(reason)
  }
  return reasons
}

/**
 * `gaps` 摘要：每条 `code` + 一行 `reason`（A38 要读的就是这里的 code）。
 *
 * `next_step` 不在这里重复 —— 它与诊断段同源，条目多了会淹掉重点；缺口的下一步仍可从诊断段读到。
 */
function gapsLines(gaps: unknown): string[] {
  if (!Array.isArray(gaps)) return ['gaps：无法读取（不是数组）']
  const lines = [`gaps（${gaps.length}）：`]
  for (const entry of gaps) {
    const view = recordOf(entry)
    const code = oneLineText(view.code, 64) || '(未命名诊断)'
    const reason = oneLineText(view.reason, 200)
    lines.push(reason.length > 0 ? `- [${code}] ${reason}` : `- [${code}]`)
  }
  return lines
}

/** 按工具给 data 一段摘要；字段一律先判类型，缺就跳过。 */
function summarizeData(label: string, data: unknown): string[] {
  if (data === null || data === undefined || typeof data !== 'object') return ['data：无']
  // 同上：`data` 已是非 null 对象，`recordOf` 恒等，只为把字段读成 `unknown`。
  const view = recordOf(data)
  const lines: string[] = []
  const push = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null) lines.push(`${key}：${String(value)}`)
  }

  if (label === 'rt_roster') {
    push('action', view.action)
    push('project_root', view.project_root)
    // A40：「本会话」与「同一个根」这两件事要能直接读到，否则只能翻 `re/team/operations/*.json`。
    lines.push(`project_id：${scalarOrNull(view.project_id)}`)
    lines.push(`session_id：${scalarOrNull(view.session_id)}`)
    lines.push(`team_id：${scalarOrNull(view.team_id)}`)
    push('compatibility', view.compatibility)
    // A09：4 个容量字段（未知写 null）；A38：每条缺口带 code 与一行 reason。
    lines.push(capacityLine(view.capacity))
    lines.push(...postsLines(view.posts, gapReasonSet(view.gaps)))
    lines.push(...gapsLines(view.gaps))
    push('recommended_members', view.recommended_members)
    push('proposal_hash', view.proposal_hash)
    push('binding_ref', view.binding_ref)
  } else if (label === 'rt_dispatch') {
    push('dispatch_id', view.dispatch_id)
    push('attempt_id', view.attempt_id)
    push('task_id', view.task_id)
    push('member', view.member)
    push('route_id', view.route_id)
    push('revision', view.revision)
    push('phase', view.phase)
    push('contract_ref', view.contract_ref)
    push('work_dir', view.work_dir)
    lines.push(`started_at：${view.started_at === null || view.started_at === undefined ? '未开始（等待成员 start.json）' : String(view.started_at)}`)
  } else if (label === 'rt_conclude') {
    push('dispatch_id', view.dispatch_id)
    push('attempt_id', view.attempt_id)
    push('task_id', view.task_id)
    push('phase', view.phase)
    push('outcome', view.outcome)
    push('route_status', view.route_status)
    push('receipt_ref', view.receipt_ref)
    push('audit_written', view.audit_written)
    if (Array.isArray(view.checks)) push('checks', view.checks.length)
  } else {
    push('phase', view.phase)
  }

  return lines.length === 0 ? ['data：无'] : lines
}

/**
 * 宿主注册表的**最小面**：本包只用到 `register`（返回值是 fiber 的 disposer，本包不接）。
 *
 * 这几个 `interface` 只是给 `apply` 里那个对象字面量一个上下文类型，好让
 * `render` / `execute` / `presentCall` 的形参不必写 `any`。字段名与既有注册对象逐字一致，
 * 多一个少一个都会在下面报错 —— 所以它同时也是「注册形状不许漂移」的静态钉子。
 */
interface ToolRegistry {
  register(definition: RegisteredTool): unknown
}

/** 一个注册进宿主的工具定义。 */
interface RegisteredTool {
  name: string
  description: string
  /** 原始 JSON Schema（自包含、无 `$ref`）；宿主不做入参校验，由 `invokeTool` 自己校验。 */
  parameters: unknown
  output: {
    /** 宿主支持子集里的 schema（`$defs.result` 的投影）。 */
    schema: unknown
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  execute: (args: unknown, exec: unknown) => Promise<Envelope>
  /** UI-only、必须纯。 */
  presentCall: (args: unknown) => { card: string, title: string, kind: string, rawInput: unknown }
}

/** `apply` 的上下文：至少要有工具注册表（可选服务一律走 `ctx.get` 探针）。 */
interface PluginContext {
  tools: ToolRegistry
}

/**
 * 注册三个工具。在 `apply` 里调用，让 fiber 拥有 disposer。
 * @param {object} ctx Cordis 上下文（需要 `ctx.tools.register` 与可选的 `ctx.get`）
 * @param {object} [config] 本包行的 `config`（可带 `defaults`）
 */
export function apply(ctx: PluginContext, config: Record<string, unknown> = {}): void {
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
