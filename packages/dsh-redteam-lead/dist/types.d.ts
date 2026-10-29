/**
 * 跨模块共享的**类型**（本文件不产生任何运行时代码）。
 *
 * 只放那些真正横跨模块边界的东西：
 * - 契约 wire shape：`Diagnostic` / `Envelope`（`$defs.diagnostic` / `$defs.result`）；
 * - 装配接缝：`Deps` / `HandlerCtx`（SEAMS §1，键名逐字一致）；
 * - 由测试注入、但生产上是真实现的薄接口：`Clock` / `FsLike`。
 *
 * 各模块自己的内部形状仍写在该模块里的局部 `interface` —— 共享层只收「多方都要认识」的那几个。
 */
/** 契约诊断：`$defs.diagnostic` 是封闭的三字段（DECISIONS D21）。 */
export interface Diagnostic {
    code: string;
    reason: string;
    next_step: string;
}
/** 四种信封状态。 */
export type ResultStatus = 'ok' | 'blocked' | 'partial' | 'error';
/**
 * `$defs.result` 的八字段信封。
 *
 * `data` 保持 `object | null`：ok 时必然是非数组对象，非 ok 时是 `failureData` 或 `null`，
 * 具体形状由各工具的 schema 决定，共享层不猜（也不把它写成 `any`）。
 */
export interface Envelope {
    schema_version: number;
    status: ResultStatus;
    code: string | null;
    operation_id: string | null;
    replayed: boolean;
    retryable: boolean;
    diagnostics: Diagnostic[];
    data: object | null;
}
/** 可注入的时钟（`deps.clock`；测试塞假时钟）。 */
export interface Clock {
    now(): number;
    isoNow(): string;
}
/**
 * `deps.fs`：`fs/promises` 的薄封装。
 *
 * 用 `Pick` 而不是完整模块类型：SEAMS §1 只承诺这九个函数，测试也只需要实现这九个。
 */
export type FsLike = Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'stat' | 'lstat' | 'readdir' | 'unlink' | 'open'>;
/** 团队适配器实例（T4 工厂的返回值）。 */
export type TeamAdapter = ReturnType<typeof import('./team-adapter.js').createTeamAdapter>;
/** 项目适配器实例（T4 工厂的返回值）。 */
export type ProjectAdapter = ReturnType<typeof import('./project-adapter.js').createProjectAdapter>;
/**
 * `ctx.deps`（SEAMS §1）。键名逐字一致，两种形状：
 * - 模块命名空间：直接用其导出函数；
 * - 适配器：工厂返回的实例（每次工具调用新建）。
 *
 * 适配器可为 `null`：`index.ts` 先建 `deps` 骨架再挂适配器，handler 一律先判空再降级 ——
 * 这条空值语义是代码里本来就有、也必须保留的分支。
 */
export interface Deps {
    envelope: typeof import('./envelope.js');
    errors: typeof import('./errors.js');
    validate: typeof import('./validate.js');
    paths: typeof import('./paths.js');
    atomic: typeof import('./atomic.js');
    lock: typeof import('./lock.js');
    identity: typeof import('./identity.js');
    operation: typeof import('./operation.js');
    audit: typeof import('./audit.js');
    catalog: typeof import('./catalog.js');
    capability: typeof import('./capability.js');
    capacity: typeof import('./capacity.js');
    compatibility: typeof import('./compatibility.js');
    binding: typeof import('./binding.js');
    contract: typeof import('./contract.js');
    resources: typeof import('./resources.js');
    submission: typeof import('./submission.js');
    anchors: typeof import('./anchors.js');
    baseline: typeof import('./baseline.js');
    teamAdapter: TeamAdapter | null;
    projectAdapter: ProjectAdapter | null;
    clock: Clock;
    fs: FsLike;
}
/** handler 能看到的部署配置（`configView` 的产物）。 */
export interface HandlerConfig {
    defaults: Record<string, unknown>;
    presetId: string;
    bundleRoot: string;
}
/** SEAMS §1 的 `HandlerCtx`：一次工具调用的装配上下文。 */
export interface HandlerCtx {
    deps: Deps;
    /** 宿主执行上下文原样携带；身份只能从它取（本包不解释它的形状）。 */
    exec: unknown;
    /** 宿主可选注入的服务；缺就是 `undefined`。 */
    services: {
        agentTeams?: unknown;
        tools?: unknown;
    };
    config: HandlerConfig;
    now: () => number;
}
/** handler 的返回：三个 handler 都 resolve 为 `{ envelope }`，绝不 reject。 */
export interface HandlerResult {
    envelope: Envelope;
}
