/** 适配器诊断（`code`/`detail` 必有，`nextStep` 视分支而定）。 */
export interface ProjectDiagnostic {
    code: string;
    detail: string;
    nextStep?: string;
}
/** `stderr` 里一行 `ERROR: <text>`（fail-fast，只有第一条）。 */
export interface FailureRow {
    kind: string;
    message: string;
    raw?: string;
}
/** 失败分支可能携带的上下文（不同方法的并集；不存在的一律缺席）。 */
export interface ProjectFailure {
    ok: false;
    code: string;
    /** `check` 的失败分支只有 `failures`，没有人读原因的句子，故可缺。 */
    reason?: string;
    nextStep?: string;
    notFound?: boolean;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    stage?: string;
    timedOut?: boolean;
    alreadySealed?: boolean;
    called?: boolean;
    reused?: boolean;
    failures?: FailureRow[];
    diagnostics?: ProjectDiagnostic[];
}
/**
 * 把成功分支的负载字段在失败分支上声明为可选。
 *
 * 失败时这些字段可能缺席，也可能带部分负载（例如 `check` 失败时仍带 `json`/`stderr`）；
 * `ok === true` 之后收窄成必有字段，下游不必到处写非空判断。
 */
export type FailureOf<P extends object> = ProjectFailure & {
    [K in keyof P]?: P[K];
};
/** `probe()` 的一个接入缺口。 */
export interface ProbeGap {
    code: string;
    detail: string;
    nextStep: string;
    blocking: boolean;
}
/** `probe()` 产出的项目接入实况（SEAMS §4 的 `compatibility`）。 */
export interface ProbeCompatibility {
    projectRoot: string;
    indexPresent: boolean;
    configPresent: boolean;
    skillCopyPresent: boolean;
    hasTeamRules: boolean;
    hasToolInventoryRules: boolean;
    pythonOk: boolean;
    projectPyPresent: boolean;
    versions: {
        adapter: number;
        python: string | null;
        pythonExe: string | null;
        pythonSource: string;
        projectPy: string | null;
        schemaVersion: unknown;
    };
    skillCopyPath: string;
    layoutKind: string;
    ruleDigest: string | null;
    scriptDigest: string | null;
    catalogDigest: string | null;
}
/** `probe()` 的负载。 */
export interface ProbePayload {
    compatibility: ProbeCompatibility;
    gaps: ProbeGap[];
}
/** `probe()` 的结果（`ok` 为「没有 blocking 缺口」，不是恒 true）。 */
export type ProbeResult = ({
    ok: boolean;
} & ProbePayload) | FailureOf<ProbePayload>;
/** `seal()` 的负载（一次性封存的三种成功形态共用）。 */
export interface SealPayload {
    alreadySealed: boolean;
    reused: boolean;
    called: boolean;
    /** CLI 没跑起来时（「已封存」竞态分支）没有实际输出，故可缺。 */
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    reason?: string;
}
/** `seal()` 的结果。 */
export type SealResult = ({
    ok: true;
} & SealPayload) | FailureOf<SealPayload>;
/** CLI 阶段（`impact`/`audit-scope`/`check`）的负载。 */
export interface CliStagePayload {
    json: unknown;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
/** `impact()`/`auditScope()` 的结果。 */
export type CliStageResult = ({
    ok: true;
} & CliStagePayload) | FailureOf<CliStagePayload>;
/** `index()` 的负载（`index` 是文本命令，`json` 恒为 null）。 */
export interface IndexPayload {
    json: null;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}
/** `index()` 的结果。 */
export type IndexResult = ({
    ok: true;
} & IndexPayload) | FailureOf<IndexPayload>;
/** `check()` 的负载（单行 JSON + 逐条失败）。 */
export interface CheckPayload extends CliStagePayload {
    failures: FailureRow[];
}
/** `check()` 的结果。 */
export type CheckResult = ({
    ok: true;
} & CheckPayload) | FailureOf<CheckPayload>;
/** `readSeals()` 的一条封存。 */
export interface SealRow {
    path: string;
    sha256: string;
    bytes: number;
}
/** `readSeals()` 的负载。 */
export interface SealsPayload {
    seals: SealRow[];
}
/** `readSeals()` 的结果。 */
export type ReadSealsResult = ({
    ok: true;
} & SealsPayload) | FailureOf<SealsPayload>;
/**
 * `readRoute()`/`readRun()` 的结果。
 *
 * 记录内容是 JSON，形状由 skill 定义，本适配器不解释；成功/失败用同一形状表达，
 * 下游一律先判 `ok` 再取 `route`/`run`（与原实现的用法一致）。
 */
export interface RecordReadResult {
    ok: boolean;
    route?: unknown;
    run?: unknown;
    code?: string;
    reason?: string;
    nextStep?: string;
    notFound?: boolean;
    diagnostics?: ProjectDiagnostic[];
}
/** `probe()` 的入参。 */
export interface ProbeInput {
    projectRoot?: unknown;
}
/** `seal()` 的入参。 */
export interface SealInput {
    runId?: unknown;
}
/** `check()` 的入参。 */
export interface CheckInput {
    hashes?: unknown;
    complete?: unknown;
}
/** 解释器探测来源（写进 `compatibility.versions.pythonSource`）。 */
export type PythonSource = 'explicit' | 'project-config' | 'path';
/** 一次解释器探测的结果。 */
export interface ProbedInterpreter {
    exe: string;
    version: string;
    source: string;
}
/** 实际选用的解释器。 */
export interface ResolvedPython {
    exe: string | null;
    version: string | null;
    source: string;
    ok: boolean;
}
/** CLI 产物里记下的解释器身份。 */
export interface PythonIdentity {
    exe: string;
    version: string | null;
    source: string;
}
/** `spawn` 的 options 子集（只声明本适配器真的传的四个键）。 */
export interface SpawnOptionsLike {
    cwd?: string;
    shell?: boolean;
    windowsHide?: boolean;
    env?: Record<string, string | undefined>;
}
/** 子进程的 stdout/stderr 流（只声明用到的两个方法）。 */
export interface SpawnStreamLike {
    setEncoding?: (encoding: BufferEncoding) => unknown;
    on: (event: string, listener: (chunk: unknown) => void) => unknown;
}
/** `child_process.spawn` 的返回值的可用子集。 */
export interface SpawnedChildLike {
    stdout?: SpawnStreamLike | null;
    stderr?: SpawnStreamLike | null;
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    kill: () => unknown;
}
/** 注入的 `spawn` 形状（测试替身与 `node:child_process.spawn` 共用）。 */
export type SpawnLike = (file: string, argv: string[], options: SpawnOptionsLike) => SpawnedChildLike;
/** 一次子进程的原始产物（不判定业务含义）。 */
export interface ProcessOutcome {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string;
    timedOut: boolean;
}
/** `python -B project.py` 的一次运行结果：要么是「跑不了」的失败，要么是原始三件套。 */
export interface CliFailure {
    ok: false;
    code: string;
    reason?: string;
    nextStep?: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
}
/** 解释器与脚本都就绪时的运行结果。 */
export interface CliSuccess {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    command: string;
    argv: Array<string | undefined>;
    python: PythonIdentity;
    reason?: string;
    timedOut?: boolean;
    code?: undefined;
    nextStep?: undefined;
}
/** `runCli()` 的结果（用 `code` 区分「跑不了」与「跑了」）。 */
export type CliRun = CliFailure | CliSuccess;
/** `parseJson()` 的结果。 */
export interface ParsedJson {
    parsed: unknown;
    error: string | null;
}
/** `createProjectAdapter()` 的入参（测试注入 + 装配层透传的键都在这里）。 */
export interface ProjectAdapterOptions {
    /** 项目根（必填才能跑 CLI）。 */
    projectRoot?: unknown;
    /** 显式解释器路径（优先于项目配置与 PATH）。 */
    python?: unknown;
    /** 显式 project.py 路径（默认项目副本路径）。 */
    projectPy?: unknown;
    /** 注入 `child_process.spawn` 形状的函数（测试用）。 */
    spawn?: unknown;
    /** 追加/覆盖环境变量。 */
    env?: Record<string, string>;
    /** 单次 CLI 超时（毫秒）。 */
    timeoutMs?: unknown;
    /** 岗位目录路径（默认包内副本 → 仓库 spec）。 */
    catalogPath?: string;
    /** 装配层会一并传下来的上下文；本适配器不解释它们。 */
    config?: unknown;
    ctx?: unknown;
    services?: unknown;
    exec?: unknown;
    deps?: unknown;
}
/** `createProjectAdapter()` 返回的实例（`types.ts` 的 `ProjectAdapter` 就是这个形状）。 */
export interface ProjectAdapterApi {
    contract_version: number;
    CONTRACT_VERSION: number;
    projectRoot: string | undefined;
    probe(input?: ProbeInput): Promise<ProbeResult>;
    seal(input?: SealInput): Promise<SealResult>;
    impact(): Promise<CliStageResult>;
    auditScope(): Promise<CliStageResult>;
    index(): Promise<IndexResult>;
    check(input?: CheckInput): Promise<CheckResult>;
    readRoute(routeId?: unknown): Promise<RecordReadResult>;
    readRun(runId?: unknown): Promise<RecordReadResult>;
    readSeals(): Promise<ReadSealsResult>;
}
/**
 * 建一个 projectAdapter。
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] 项目根（必填才能跑 CLI）
 * @param {string} [options.python] 显式解释器路径（优先于项目配置与 PATH）
 * @param {string} [options.projectPy] 显式 project.py 路径（默认项目副本路径）
 * @param {Function} [options.spawn] 注入 `child_process.spawn` 形状的函数（测试用）
 * @param {Record<string, string>} [options.env] 追加/覆盖环境变量
 * @param {number} [options.timeoutMs] 单次 CLI 超时（毫秒）
 * @param {string} [options.catalogPath] 岗位目录路径（默认包内副本 → 仓库 spec）
 */
export declare function createProjectAdapter(options?: ProjectAdapterOptions): ProjectAdapterApi;
