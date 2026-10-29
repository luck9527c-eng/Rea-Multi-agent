/**
 * operation 台账：按 operation ID 重放与续做。
 *
 * 契约（「操作阶段与部分失败」「稳定错误码」）：
 * - operation ID 在项目内唯一，绑定**规范化输入的哈希**。
 * - 相同 ID + 相同哈希 → 恢复或重放，不重复创建成员/任务/封存/历史。
 * - 相同 ID + 不同哈希 → `OPERATION_CONFLICT`，绝不覆盖既有台账。
 * - 阶段闭集与契约表逐字一致：`prepared → member_ready → task_created → assigned →
 *   delivered → integrating → facts_committed → completed`，外加 `needs_recovery`。
 * - 每步「先存意图、后存实际 ID」由调用方保证；本模块只负责原子落盘与冲突判定。
 *
 * 台账文件：`re/team/operations/<operation_id>.json`（`$defs.id` 保证文件名安全）。
 * 并发由项目锁协调（调用方持有 `re/team/lock`），本模块只做读-改-写。
 */
import type { Envelope } from './types.js';
/** 项目内台账目录。 */
export declare const OPERATIONS_DIR = "re/team/operations";
/**
 * 操作阶段闭集，按契约表顺序（含 `completed`；失败态用 `needs_recovery`）。
 * 注意 `$defs.failureData` 的阶段集合另有 `preflight` 且不含 `completed`（见 envelope.mjs）。
 */
export declare const OPERATION_PHASES: readonly string[];
/** 一条台账历史记录。 */
export interface OperationHistoryEntry {
    phase: string;
    at: string;
}
/**
 * 台账记录。
 *
 * 写出去的是固定形状；读回来时只核对 `operation_id` 与 `phase`（见 `readRecord`），
 * 其余字段按写入形状使用 —— 台账是本模块自己写的文件，不是外部输入。
 */
export interface OperationRecord extends Record<string, unknown> {
    schema_version: number;
    operation_id: string;
    input_hash: string;
    phase: string;
    created_at: string;
    updated_at: string;
    history: OperationHistoryEntry[];
    data: Record<string, unknown>;
    result: unknown;
}
/** `prepare()` 的结果：`resumed` 表示复用既有台账，`replayed` 由响应丢失后的重放路径置位。 */
export interface PreparedOperation {
    record: OperationRecord;
    resumed: boolean;
    replayed: boolean;
}
/**
 * 可注入的时钟：`Clock` 形状。
 *
 * `now` 必填（`isoNow` 缺省时用它构造 ISO 时间戳）；`isoNow` 可缺省。
 */
export interface OperationClock {
    now: () => number;
    isoNow?: () => string;
}
/** `createOperationLedger()` 的入参。 */
export interface OperationLedgerOptions {
    root?: string;
    /** `Clock` 形状或 `() => number`；缺省用系统时钟。 */
    clock?: OperationClock | (() => number) | null;
}
/** 绑定到项目根的台账。 */
export interface OperationLedger {
    prepare: (operationId: string, inputHash: string, phase?: string, data?: unknown) => Promise<PreparedOperation>;
    findById: (operationId: string) => Promise<OperationRecord | null>;
    advance: (operationId: string, phase: string, data?: unknown) => Promise<OperationRecord>;
    saveResult: (operationId: string, result: unknown) => Promise<OperationRecord>;
    /** 重放的是**信封**（`saveResult()` 存进去的就是 `envelope.ok()` 等构造的 `$defs.result`）。 */
    replayResult: (operationId: string) => Promise<Envelope | null>;
    recordPath: (operationId: string) => string;
}
/**
 * 台账文件绝对路径。
 * @param root 已规范化的绝对根
 */
export declare function operationRecordPath(root: string, operationId: string): string;
/**
 * 创建绑定到某个项目根的 operation 台账。
 */
export declare function createOperationLedger(options?: OperationLedgerOptions): OperationLedger;
