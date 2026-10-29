/**
 * 项目锁 `re/team/lock`。
 *
 * 契约（「路径、锁与资源」）：
 * - 用**原子独占创建**取得锁；内容含 project/session、owner nonce、PID/进程启动身份和 operation。
 * - 冲突返回 `PROJECT_BUSY`，并带持有者信息与是否过期（只报告）。
 * - **过期时间不作为自动解锁理由**：`isStale()` 只报告，`acquire()` 永远不会抢锁。
 *   只有当原进程/Lead 确认不再写、恢复记录已保存后，才能走 `release({ force: true, recoveryRef })`。
 * - 锁只协调遵守协议的插件/Lead，不声称限制通用 shell 或文件工具。
 *
 * 崩溃后未完成操作先恢复；损坏的锁内容视为 `RECOVERY_REQUIRED`，不能当「没锁」继续。
 */
/** 锁记录（wire 形状：已知字段可选，其余按索引读取）。 */
export interface LockRecord {
    schema_version?: number;
    project?: string;
    session?: string;
    owner_nonce?: string;
    pid?: number;
    process_start_ms?: number;
    operation?: string | null;
    acquired_at?: string;
    expires_at?: string | null;
    [key: string]: unknown;
}
/** `ownProcessIdentity()` 可注入的时钟。 */
export interface OwnProcessOptions {
    now?: () => number;
    uptime?: () => number;
}
/** 过期/失联判定可注入的探针（测试用假进程表）。 */
export interface StaleOptions {
    now?: number | (() => number);
    isAlive?: (pid: number) => boolean;
    processStart?: (pid: number) => number | null;
}
/** `acquire()` 的入参。 */
export interface AcquireOptions {
    session?: string;
    operation?: string | null;
    ownerNonce?: string;
    now?: number | (() => number);
    ttlMs?: number | null;
    pid?: number;
    processStartMs?: number;
    isAlive?: (pid: number) => boolean;
    processStart?: (pid: number) => number | null;
}
/** `release()` 的入参。 */
export interface ReleaseOptions {
    ownerNonce?: string;
    force?: boolean;
    recoveryRef?: string;
}
/** 项目内锁路径（统一 `/`）。 */
export declare const LOCK_PATH = "re/team/lock";
/**
 * 本进程的 PID 与近似启动时刻。
 *
 * 启动时刻用 `now - uptime` 估算（跨平台可用），精度足够识别「PID 被新进程复用」。
 *
 * @param {{ now?: () => number, uptime?: () => number }} [options]
 * @returns {{ pid: number, start_ms: number }}
 */
export declare function ownProcessIdentity(options?: OwnProcessOptions): {
    pid: number;
    start_ms: number;
};
/**
 * 进程是否仍存在（`kill(pid, 0)`；EPERM 表示存在但无权限）。
 * @param {number} pid
 * @returns {boolean}
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * 过期/失联的具体理由（纯报告，不产生任何副作用）。
 *
 * @param {object | null} record 锁记录
 * @param {{ now?: number | (() => number), isAlive?: (pid: number) => boolean, processStart?: (pid: number) => number | null }} [options]
 * @returns {string[]} `expired` / `process_dead` / `pid_reused`
 */
export declare function staleReasons(record: LockRecord | null, options?: StaleOptions): string[];
/**
 * 是否疑似过期/失联。**只报告**——调用方不得据此自动释放或抢锁。
 * @param {object | null} record
 * @param {object} [options] 同 `staleReasons`
 * @returns {boolean}
 */
export declare function isStale(record: LockRecord | null, options?: StaleOptions): boolean;
/**
 * 读取锁记录。
 * @param {string} root 已规范化的绝对根
 * @returns {Promise<object | null>} 无锁返回 null
 * @throws {ContractError} 内容损坏时 `RECOVERY_REQUIRED`
 */
export declare function readLock(root: string): Promise<LockRecord | null>;
/**
 * 取得项目锁（原子独占创建）。
 *
 * @param {string} root 已规范化的绝对根
 * @param {{
 *   session: string,
 *   operation?: string | null,
 *   ownerNonce?: string,
 *   now?: number | (() => number),
 *   ttlMs?: number | null,
 *   pid?: number,
 *   processStartMs?: number,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {Promise<{ acquired: true, record: object }>}
 * @throws {ContractError} `PROJECT_BUSY`（已被持有）或 `RECOVERY_REQUIRED`（锁损坏）
 */
export declare function acquire(root: string, options?: AcquireOptions): Promise<{
    acquired: true;
    record: LockRecord;
}>;
/**
 * 释放项目锁。
 *
 * - 默认只允许 `ownerNonce` 匹配的持有者释放（幂等：无锁返回 `released=false`）。
 * - `force` 只允许在显式恢复路径调用，必须给 `recoveryRef`（恢复核查记录的项目内路径）。
 *
 * @param {string} root 已规范化的绝对根
 * @param {{ ownerNonce?: string, force?: boolean, recoveryRef?: string }} [options]
 * @returns {Promise<{ released: boolean, forced: boolean, previous: object | null }>}
 */
export declare function release(root: string, options?: ReleaseOptions): Promise<{
    released: boolean;
    forced: boolean;
    previous: LockRecord | null;
}>;
