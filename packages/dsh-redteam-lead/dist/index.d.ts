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
import type { Deps, Envelope, HandlerCtx } from './types.js';
/** 插件名（插件清单/日志用）。 */
export declare const name = "redteam-lead-tools";
/**
 * 硬依赖只有工具注册表。`agentTeams` / `agentPresets` / `subagents` 都是**可选**能力：
 * 本 Cordis 没有 `inject: { optional }`，只能在用点 `ctx.get('x')` 探针并降级。
 */
export declare const inject: string[];
/**
 * 三个工具的静态定义。`parameters` 是**自包含**的原始 JSON Schema（`$ref` 已就地展开），
 * 注册进 `ctx.tools.register` 后直接进模型上下文。
 *
 * `defName` 是 `$defs` 里的名字，用于本文件自己的入参校验与诊断（本包校验用**完整规格**
 * schema，不是注册用的展开副本）。
 */
export declare const TOOLS: readonly {
    name: string;
    handler: string;
    defName: string;
    parameters: unknown;
    title: string;
    description: string;
}[];
/**
 * 从入参里取一个**可以放进信封**的 operation id：形状不合法就当没有，
 * 免得「入参非法」这个分支自己再抛异常。
 * @param {unknown} args
 * @returns {string | null}
 */
export declare function operationIdOf(args: unknown): string | null;
/** 宿主可选注入的服务：`agentTeams` / `tools`，缺就是 `undefined`。 */
interface ProbeServices {
    agentTeams: unknown;
    tools: unknown;
}
/** `createDeps` 的选项：当次调用的服务探针、exec、部署配置与已解析的项目根。 */
interface CreateDepsOptions {
    services: ProbeServices;
    exec: unknown;
    config: Record<string, unknown>;
    ctx?: unknown;
    /** 已 `normalizeProjectRoot` 的真实根；`undefined` = 本次没有可用根。 */
    projectRoot?: string;
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
export declare function createDeps({ services, exec, config, ctx, projectRoot }: CreateDepsOptions): Deps;
/** `handlerContext` 的入参。 */
interface HandlerContextOptions {
    deps: Deps;
    exec: unknown;
    services: ProbeServices;
    config: unknown;
}
/**
 * 组装交给 handler 的上下文（SEAMS 第 1 节的 `HandlerCtx`）。
 * @param {{ deps: object, exec: unknown, services: object, config: object }} options
 */
export declare function handlerContext({ deps, exec, services, config }: HandlerContextOptions): HandlerCtx;
/** `invokeTool` 的入参（测试会传假 handler 验收接缝）。 */
interface InvokeToolOptions {
    tool: string;
    args: unknown;
    exec?: unknown;
    ctx?: unknown;
    config?: Record<string, unknown>;
    handlers?: Record<string, Function>;
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
export declare function invokeTool(options: InvokeToolOptions): Promise<Envelope>;
/** `render` 的返回元素（宿主只接受文本块）。 */
interface TextBlock {
    type: 'text';
    text: string;
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
export declare function renderResult(label: string, value: unknown): TextBlock[];
/**
 * 宿主注册表的**最小面**：本包只用到 `register`（返回值是 fiber 的 disposer，本包不接）。
 *
 * 这几个 `interface` 只是给 `apply` 里那个对象字面量一个上下文类型，好让
 * `render` / `execute` / `presentCall` 的形参不必写 `any`。字段名与既有注册对象逐字一致，
 * 多一个少一个都会在下面报错 —— 所以它同时也是「注册形状不许漂移」的静态钉子。
 */
interface ToolRegistry {
    register(definition: RegisteredTool): unknown;
}
/** 一个注册进宿主的工具定义。 */
interface RegisteredTool {
    name: string;
    description: string;
    /** 原始 JSON Schema（自包含、无 `$ref`）；宿主不做入参校验，由 `invokeTool` 自己校验。 */
    parameters: unknown;
    output: {
        /** 宿主支持子集里的 schema（`$defs.result` 的投影）。 */
        schema: unknown;
        render: (args: unknown, value: unknown) => TextBlock[];
    };
    execute: (args: unknown, exec: unknown) => Promise<Envelope>;
    /** UI-only、必须纯。 */
    presentCall: (args: unknown) => {
        card: string;
        title: string;
        kind: string;
        rawInput: unknown;
    };
}
/** `apply` 的上下文：至少要有工具注册表（可选服务一律走 `ctx.get` 探针）。 */
interface PluginContext {
    tools: ToolRegistry;
}
/**
 * 注册三个工具。在 `apply` 里调用，让 fiber 拥有 disposer。
 * @param {object} ctx Cordis 上下文（需要 `ctx.tools.register` 与可选的 `ctx.get`）
 * @param {object} [config] 本包行的 `config`（可带 `defaults`）
 */
export declare function apply(ctx: PluginContext, config?: Record<string, unknown>): void;
export {};
