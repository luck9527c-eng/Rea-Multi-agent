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
import type { Diagnostic, FsLike } from './types.js';
/** 本模块用到的 `src/paths.mjs` 面（与 `deps.paths` 同一命名空间类型）。 */
type PathsModule = typeof import('./paths.js');
/** 注入的时钟：`isoNow` 缺省时退回 `now`。 */
interface ClockLike {
    isoNow?: () => string;
    now: () => number;
}
/**
 * 只声明本模块用到的那两个适配器方法。
 *
 * 结构上比 `ProjectAdapter` 更宽（返回值按 `unknown` 收），适配器实现怎么演进都能传进来；
 * 具体字段在本文件里用 `recordOf` 逐个收窄。
 */
interface ProjectAdapterLike {
    readSeals?: () => Promise<unknown>;
    seal?: (input: {
        runId: string;
    }) => Promise<unknown>;
}
/** 基准快照目录（本插件所有，见 SEAMS §7）。 */
export declare const BASELINE_DIR = "re/team/baselines";
/** 快照版本。 */
export declare const BASELINE_SCHEMA_VERSION = 1;
/** 目标清单（skill 所有，只读）。 */
export declare const TARGETS_PATH = "re/targets.json";
/** skill 的终端 RUN 状态（`project.py` 的 `TERMINAL_RUNS`）。 */
export declare const TERMINAL_RUNS: readonly string[];
/** 快照文件的项目内路径。 */
export declare function baselineRefFor(dispatchId: unknown): string;
/** seal 文件的项目内路径（`seal` 命令 O_EXCL 写的就是这两个目录之一）。 */
export declare function sealPathFor(runId: string): string;
/** 快照形状校验结果。 */
type BaselineShapeVerdict = {
    ok: true;
} | {
    ok: false;
    issues: Diagnostic[];
};
/**
 * 校验快照形状。
 * @returns {{ ok: true } | { ok: false, issues: Array<object> }}
 */
export declare function validateBaselineShape(baseline: unknown): BaselineShapeVerdict;
/** `captureBaseline` 的入参（`fs`/`paths`/`atomic`/`clock` 可注入，缺省用真实实现）。 */
interface CaptureBaselineInput {
    /** 规范根。 */
    root: string;
    dispatchId?: unknown;
    attemptId?: unknown;
    /** 本次派发的目标 ID（非空）。 */
    targetIds?: unknown;
    /** 依赖产物身份。 */
    artifacts?: unknown;
    /** 用来读既有 seal（缺失则视为没有既有 seal）。 */
    projectAdapter?: ProjectAdapterLike | null;
    clock?: ClockLike;
    fs?: FsLike;
    paths?: PathsModule;
    atomic?: typeof import('./atomic.js');
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
export declare function captureBaseline(input: CaptureBaselineInput): Promise<{
    ok: boolean;
    code: string;
    issues: Diagnostic[];
    ref?: undefined;
    baseline?: undefined;
} | {
    ok: boolean;
    ref: string;
    baseline: {
        schema_version: number;
        dispatch_id: string;
        attempt_id: string;
        captured_at: string;
        targets: Record<string, unknown>[];
        preexisting_seals: Record<string, unknown>[];
        artifacts: Record<string, unknown>[];
    };
    code?: undefined;
    issues?: undefined;
}>;
/** `loadBaseline` 的入参：`ref`/`embedded` 都是契约里可能缺失的 `unknown`。 */
interface LoadBaselineInput {
    /** 规范根（缺省时下游 `resolveInProject` 自己会拒）。 */
    root?: string;
    dispatchId?: unknown;
    ref?: unknown;
    embedded?: unknown;
    fs?: FsLike;
    paths?: PathsModule;
}
/**
 * 读回基准快照：优先用契约里记的 `ref`，否则用默认位置；也接受契约内联的 `embedded`。
 */
export declare function loadBaseline(input?: LoadBaselineInput): Promise<{
    ok: boolean;
    code: string;
    issues: Diagnostic[];
    ref?: undefined;
    baseline?: undefined;
} | {
    ok: boolean;
    ref: {};
    baseline: import("./guards.js").AnyRecord;
    code?: undefined;
    issues?: undefined;
}>;
/** `compareBaseline` 的入参。 */
interface CompareBaselineInput {
    /** 规范根（缺省时下游 `resolveInProject` 自己会拒）。 */
    root?: string;
    baseline?: unknown;
    projectAdapter?: ProjectAdapterLike | null;
    fs?: FsLike;
    paths?: PathsModule;
    atomic?: typeof import('./atomic.js');
}
/**
 * 与冻结快照比较：目标、既有 seal、依赖产物的删除/不可读/内容变化都是 `BASELINE_MISMATCH`。
 */
export declare function compareBaseline(input?: CompareBaselineInput): Promise<{
    ok: boolean;
    code: string;
    issues: Diagnostic[];
    mismatches?: undefined;
    compared?: undefined;
} | {
    ok: boolean;
    code: string;
    mismatches: Record<string, unknown>[];
    issues: Diagnostic[];
    compared?: undefined;
} | {
    ok: boolean;
    compared: {
        targets: number;
        preexisting_seals: number;
        artifacts: number;
    };
    code?: undefined;
    issues?: undefined;
    mismatches?: undefined;
}>;
/** `sealRunSet` 的入参（`runs`/`seals` 来自适配器或调用方，形状由本函数兜底）。 */
interface SealRunSetInput {
    projectAdapter?: ProjectAdapterLike | null;
    runs?: unknown;
    seals?: unknown;
}
/**
 * 封存尚未封存的终态 RUN：已有 seal 只校验复用。
 *
 * @param {{ projectAdapter: object, runs: Array<{run_id: string, status: string}>,
 *           seals: Array<{path: string, sha256?: string}> }} input
 * @returns {Promise<{ok:true, results: Array<object>} | {ok:false, code:'CHECK_FAILED', stage:'seal', run_id:string,
 *   exit_code: number|null, stdout: string, stderr: string}>}
 */
export declare function sealRunSet(input?: SealRunSetInput): Promise<{
    ok: boolean;
    code: string;
    stage: string;
    run_id: string;
    exit_code: {} | null;
    stdout: string;
    stderr: string;
    issues: Diagnostic[];
    results?: undefined;
} | {
    ok: boolean;
    results: Record<string, unknown>[];
    code?: undefined;
    stage?: undefined;
    run_id?: undefined;
    exit_code?: undefined;
    stdout?: undefined;
    stderr?: undefined;
    issues?: undefined;
}>;
export {};
