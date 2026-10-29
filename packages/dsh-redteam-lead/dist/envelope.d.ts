/**
 * 结果信封：`ok | blocked | partial | error` 四态。
 *
 * 形状唯一来源是 `docs/specs/rt-tools.schema.json` 的 `$defs.result`：
 * 必带 `schema_version=1`、`status`、`code`、`operation_id`、`replayed`、`retryable`、
 * `diagnostics[]`、`data`，不得有多余字段。
 *
 * 规则（编排契约「版本、角色与通用返回」「稳定错误码」）：
 * - `ok` 的 `code` 必须为 `null`，`data` 必须是 object；允许带诊断（审计失败不改变成功判定）。
 * - 非 `ok` 必须给稳定码与至少一条诊断（每条含原因与具体下一步）；`data` 为
 *   `failureData`（含合法 `phase`）或 `null`。
 * - `status` 与错误码不是一一绑定：已持久化或触及宿主后的失败是 `partial`，
 *   前置拒绝是 `blocked`，非法参数/角色是 `error`。默认由码分组推导，可显式覆盖。
 *
 * 构造器是编程侧的最后一道闸：缺少诊断或码不合法属于调用方 bug，直接抛 `ContractError`，
 * 而不是产出一个看起来合法却无信息的信封。`fromError` 是唯一「绝不抛」的入口，
 * 用于把未捕获异常兜底成合法信封（不带栈）。
 */
import type { Diagnostic, Envelope, ResultStatus } from './types.js';
/** 契约版本号。 */
export declare const SCHEMA_VERSION = 1;
/** 允许的四种状态。 */
export declare const RESULT_STATUSES: readonly ResultStatus[];
/** 非 ok 的三种状态（`defaultStatusFor` 的值域）。 */
export type FailureStatus = 'error' | 'blocked' | 'partial';
/**
 * `$defs.failureData` 的 phase 闭集（契约「操作阶段与部分失败」）。
 * 与 operation 台账的阶段相比多 `preflight`、不含 `completed`：失败时不可能已经是 completed。
 */
export declare const FAILURE_PHASES: readonly string[];
/**
 * 按错误码推导默认状态。显式 `status` 永远优先。
 *
 * - `error`：输入与权限（非法参数/角色）。
 * - `blocked`：接入与派发前置，以及未触及宿主的收口校验拒绝 —— 无新成员/任务/正式路线变更。
 * - `partial`：交付与恢复阶段的失败 —— 副作用可能已发生。
 */
export declare function defaultStatusFor(code: string): FailureStatus;
/**
 * 构造一条诊断。三个字段都是必填非空文本：`code`、`reason`（原因）、`next_step`（下一步）。
 *
 * 注意：`$defs.diagnostic` 的 `code` 是任意非空文本，不是 `errorCode` 枚举 ——
 * `ok` 信封里记录审计失败等旁路问题时可以用非稳定码（例如 `AUDIT_WRITE_FAILED`）。
 */
export declare function diagnostic(code: string, reason: string, nextStep: string): Diagnostic;
/** `ok()` 的入参：`data` 由运行期检查保证是对象，故这里先收 `unknown`。 */
export interface OkOptions {
    operationId?: unknown;
    data?: unknown;
    diagnostics?: readonly Diagnostic[];
    replayed?: boolean;
    retryable?: boolean;
}
/** `ok` 信封。 */
export declare function ok(options?: OkOptions): Envelope;
/** 三种非 ok 态的公共入参。 */
export interface FailOptions {
    code?: unknown;
    operationId?: unknown;
    reason?: unknown;
    nextStep?: unknown;
    diagnostics?: readonly Diagnostic[];
    data?: unknown;
    replayed?: boolean;
    retryable?: boolean;
}
/** `status=blocked`：前置拒绝，无新成员/任务/正式路线变更。 */
export declare function blocked(options?: FailOptions): Envelope;
/** `status=partial`：副作用可能已发生，`data` 应带已知的 dispatch/task/member/阶段。 */
export declare function partial(options?: FailOptions): Envelope;
/** `status=error`：非法参数/角色等调用方错误。 */
export declare function error(options?: FailOptions): Envelope;
/** `fromError()` 的入参。 */
export interface FromErrorOptions {
    operationId?: unknown;
    code?: unknown;
    status?: ResultStatus;
    data?: unknown;
    retryable?: boolean;
    diagnostics?: readonly Diagnostic[];
}
/**
 * 异常 → 合法信封。**绝不抛出**，也不把栈写进返回体。
 *
 * - `ContractError`：沿用其码、原因、下一步；状态取 `options.status ?? error.status ?? 默认推导`。
 * - 其它异常：`options.code ?? 'RECOVERY_REQUIRED'`，`status` 固定为 `error`
 *   （未预期异常意味着状态未核实，按 SEAMS「无法映射时用 RECOVERY_REQUIRED」）。
 *
 * 注意：`ContractError.details` 无法进入信封 —— `$defs.diagnostic` 只有三个字段且
 * `additionalProperties=false`。需要机器消费的细节请放进 `options.data`（failureData 形状），
 * 需要人读的具体对象请写进 `message`。
 */
export declare function fromError(thrown: unknown, options?: FromErrorOptions): Envelope;
