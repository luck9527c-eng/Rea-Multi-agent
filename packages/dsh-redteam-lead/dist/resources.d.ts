/**
 * T6 资源租用与隔离：`re/team/resources.json`。
 *
 * 契约（编排契约「路径、锁与资源」，验收 A22/A33）：
 *
 * - 资源记录每项含 `resource_key`、`physical_identity`、`mode`、owner（dispatch/attempt）、
 *   `generation`、`state`、`recovery_ref`。
 * - **检查和租用必须在项目锁内完成**（由调用方持 `re/team/lock`；本模块只做读-改-写）。
 * - 相同物理实例的别名归一为同一 `resource_key`；**默认独占**，只有登记为不可变读取
 *   且无状态写才 `shared_read`（未登记时降级为独占并给一条非阻塞 gap）。
 * - 未知实例或缺映射 → `RESOURCE_BINDING_MISSING`；冲突 → `RESOURCE_BUSY`。
 * - `quarantined` 的资源不可再分配：恢复依据（`recovery_ref`）核实后先 `release`，
 *   才允许新的 generation。
 * - 同一 dispatch/attempt 重复租用是幂等的（重入不产生第二份租约、不涨代次）。
 *
 * `resources.json` 形状（本模块的权威形状，项目/操作者也可以手写 `aliases`）：
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "revision": 3,
 *   "aliases": { "<别名或 resource_key>": { "physical_identity": "pid:4242", "immutable_read": false } },
 *   "leases": [
 *     { "resource_key": "...", "physical_identity": "...", "mode": "exclusive",
 *       "dispatch_id": "D-...", "attempt_id": "A-000001", "generation": 1,
 *       "state": "reserved", "recovery_ref": null, "acquired_at": "..." }
 *   ]
 * }
 * ```
 */
import type { Diagnostic } from './types.js';
/** 一条资源租约（`resources.json` 的权威形状）。 */
interface Lease {
    resource_key: string;
    physical_identity: string;
    mode: string;
    dispatch_id: string | null;
    attempt_id: string | null;
    generation: number;
    state: string;
    recovery_ref: string | null;
    acquired_at: string | null;
}
/** 别名表的一项：物理身份 + 是否不可变读取。 */
interface AliasEntry {
    physical_identity: string;
    immutable_read: boolean;
}
/** 资源注册表（本模块的权威形状）。 */
interface ResourceRegistry {
    schema_version: number;
    revision: number;
    aliases: Record<string, AliasEntry>;
    leases: Lease[];
}
/** 项目内资源记录路径（统一 `/`）。 */
export declare const RESOURCES_PATH = "re/team/resources.json";
/** 资源模式闭集（`$defs.resource.mode`）。 */
export declare const RESOURCE_MODES: readonly string[];
/** 资源状态闭集（编排契约）。 */
export declare const RESOURCE_STATES: readonly string[];
/** 空注册表。 */
export declare function emptyRegistry(): ResourceRegistry;
/**
 * 归一 `resource_needs`：按 `resource_key` 去重，同一 key 取**更严**的模式（exclusive 胜）。
 *
 * @param {unknown} needs `$defs.resource[]`
 * @returns {{ ok: boolean, needs: Array<{resource_key: string, mode: string}>, issues: object[] }}
 */
export declare function normalizeResourceNeeds(needs: unknown): {
    ok: boolean;
    needs: {
        resource_key: string;
        mode: string;
    }[];
    issues: Diagnostic[];
};
/**
 * 注册表归一（容忍手写的最小形状，也接受字符串别名）。
 * @param {unknown} raw
 */
export declare function normalizeRegistry(raw: unknown): ResourceRegistry;
/** 单个 `resource_key` 的物理身份解析结果。 */
type ResourceResolution = {
    ok: true;
    resource_key: string;
    physical_identity: string;
    immutable_read: boolean;
    source: 'alias' | 'lease';
} | {
    ok: false;
    code: 'RESOURCE_BINDING_MISSING';
    resource_key: string;
    reason: string;
    next_step: string;
};
/**
 * 解析一个 resource_key 的物理身份。
 *
 * 别名表优先；其次用既有租约里已记录的物理身份（同一 key 的自洽历史）。
 * 都查不到 → `RESOURCE_BINDING_MISSING`（未知实例不能凭空独占）。
 *
 * @param {object} registry
 * @param {string} resourceKey
 */
export declare function resolveResource(registry: ResourceRegistry, resourceKey: string): ResourceResolution;
/** `planReservations` 的入参。 */
interface PlanReservationsInput {
    registry: ResourceRegistry;
    needs: Array<{
        resource_key: string;
        mode: string;
    }>;
    dispatchId: string;
    attemptId: string;
    now?: string;
}
/** 资源冲突条目：除诊断两字段外还带持有者/实例信息（wire 上给调用方看）。 */
interface ResourceConflict extends Record<string, unknown> {
    reason: string;
    next_step: string;
}
/** 纯规划结果：可租用时给新租约与预留，否则给冲突与诊断。 */
type PlannedReservations = {
    ok: true;
    leases: Lease[];
    reservations: Array<Record<string, unknown>>;
    reused: boolean;
    gaps: Diagnostic[];
} | {
    ok: false;
    code: string;
    conflicts: ResourceConflict[];
    diagnostics: Diagnostic[];
};
/**
 * 纯规划：决定本次派发要新增/复用哪些租约，或为什么不能。
 *
 * @param {{ registry: object, needs: Array<{resource_key: string, mode: string}>,
 *           dispatchId: string, attemptId: string, now?: string }} input
 * @returns {{ ok: true, leases: object[], reservations: object[], reused: boolean,
 *             gaps: object[] }
 *           | { ok: false, code: string, diagnostics: object[], conflicts?: object[] }}
 */
export declare function planReservations({ registry, needs, dispatchId, attemptId, now }: PlanReservationsInput): PlannedReservations;
/**
 * 读取注册表。文件缺失 → 空注册表；JSON 损坏/形状不对 → `RECOVERY_REQUIRED`
 * （不能当作「没有资源」继续租用）。
 *
 * @param {string} root 已规范化的绝对根
 * @returns {Promise<object>}
 */
export declare function readRegistry(root: string): Promise<ResourceRegistry>;
/** `reserveResources` 的入参。 */
interface ReserveResourcesInput {
    root: string;
    needs?: unknown;
    dispatchId: string;
    attemptId: string;
    clock?: {
        isoNow?: () => string;
    };
    atomic: typeof import('./atomic.js');
    now?: string;
}
/**
 * 在**项目锁内**检查并租用资源。冲突/缺映射时**不落盘**。
 *
 * @param {{ root: string, needs: unknown, dispatchId: string, attemptId: string,
 *           clock?: { isoNow?: () => string }, atomic: object, now?: string }} input
 */
export declare function reserveResources(input: ReserveResourcesInput): Promise<{
    ok: false;
    code: string;
    conflicts: ResourceConflict[];
    diagnostics: Diagnostic[];
} | {
    ok: boolean;
    code: string;
    issues: Diagnostic[];
    diagnostics: {
        code: string;
        reason: string;
        next_step: string;
    }[];
    leases?: undefined;
    reservations?: undefined;
    reused?: undefined;
    gaps?: undefined;
    revision?: undefined;
} | {
    ok: boolean;
    leases: never[];
    reservations: never[];
    reused: boolean;
    gaps: never[];
    revision: null;
    code?: undefined;
    issues?: undefined;
    diagnostics?: undefined;
} | {
    ok: boolean;
    leases: {
        state: string;
    }[];
    reservations: Record<string, unknown>[];
    reused: boolean;
    gaps: Diagnostic[];
    revision: number;
    code?: undefined;
    issues?: undefined;
    diagnostics?: undefined;
}>;
/** `releaseResources` 的入参（`recoveryRef`/`note` 由调用方按需给）。 */
interface ReleaseResourcesInput {
    root: string;
    dispatchId: string;
    attemptId: string;
    atomic: typeof import('./atomic.js');
    clock?: {
        isoNow?: () => string;
    };
    /** 恢复依据（项目内相对路径）；给的话写进 released 的租约。 */
    recoveryRef?: unknown;
    note?: unknown;
}
/**
 * 释放某个 dispatch/attempt 名下的全部租约（只动自己的）。
 *
 * @param {{ root: string, dispatchId: string, attemptId: string, atomic: object,
 *           clock?: object, note?: string }} input
 */
export declare function releaseResources(input: ReleaseResourcesInput): Promise<{
    ok: boolean;
    released: {
        resource_key: string;
        generation: number;
    }[];
    revision: number;
}>;
/** `quarantineResources` 的入参。 */
interface QuarantineResourcesInput {
    root: string;
    dispatchId: string;
    attemptId: string;
    /** 恢复依据（必填）；只接受非空字符串。 */
    recoveryRef?: unknown;
    atomic: typeof import('./atomic.js');
    clock?: {
        isoNow?: () => string;
    };
}
/**
 * 把某个 dispatch/attempt 的资源置为 `quarantined`（失败/中断/失联，A22/A33）。
 * 必须给恢复依据（`recovery_ref`），否则只能是普通 `release`。
 */
export declare function quarantineResources(input: QuarantineResourcesInput): Promise<{
    ok: boolean;
    quarantined: {
        resource_key: string;
        generation: number;
    }[];
    revision: number;
}>;
export {};
