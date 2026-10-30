/**
 * 生效容量的解析（T18）：按调用声明 > 项目声明 > profile 声明 > 本会话观测值 > unknown。
 *
 * 三条硬规则（DECISIONS D1/D12/D25 + T18 的裁决）：
 *
 * 1. **上限只能来自显式声明或宿主拒绝的被动观测**：本模块不猜 8/16、不读宿主私有字段、
 *    也**不为了试探余额而派发**。`CAPACITY_EXHAUSTED` 观测值只在一次**真实需要**的派发
 *    被宿主拒绝后落盘（`re/team/capacity-observed.json`）。
 * 2. **观测值按会话生效**：`TeamId` 就是 Lead 会话 id，席位随会话重置，所以
 *    `session_id` 与当前会话不一致（或无法确定当前会话）的观测值**不得**套用。
 * 3. **「上限未知」与「占用不可观测」是两件事**（D25）：这里只回答“有没有上限”，
 *    activation 的占用仍然恒为 `null`，由派发/收口的 gap 如实报告。
 *
 * 观测值的语义在 ticket 里写死了：`max_members` 取**观测当时的已用席位数**（失败成员已计入），
 * 即“你已经到顶了”。因此它是真实上限的**保守下限**：宁可少开，也不靠猜多开。
 */
import type { ActivationSlots, CapacityGap, MemberSlots } from './team-adapter.js';
/** 观测值文件（本插件唯一写它的地方：派发撞到宿主上限之后）。 */
export declare const OBSERVED_CAPACITY_PATH = "re/team/capacity-observed.json";
/** 「观测中」标记：容量未知时，一次真实派发在 spawn 之前写下、结束后删除。 */
export declare const OBSERVING_MARKER_PATH = "re/team/capacity-observing.json";
/** 观测值文件的 schema 版本。 */
export declare const OBSERVED_SCHEMA_VERSION = 1;
/** 生效上限的来源（ticket 要求的 `capacity_source`）。 */
export type CapacitySource = 'call' | 'project' | 'profile' | 'observed' | 'unknown';
/** 按调用声明的容量。 */
export interface CallCapacity {
    max_members: number;
    max_active_subagents: number;
}
/** `re/team/capacity-observed.json` 的形状（ticket 逐字规定）。 */
export interface ObservedCapacityRecord {
    schema_version: number;
    session_id: string;
    observed_at: string;
    max_members: number;
    max_active_subagents: number;
    basis: {
        used_at_observation: number;
        host_code: string;
    };
}
/** 团队适配器 `capacity()` 里本模块真正读到的部分（其它键原样忽略）。 */
export interface DeclaredCapacityView {
    memberSlots?: unknown;
    activations?: unknown;
    evidence?: unknown;
    gaps?: unknown;
}
/** 解析后的生效容量：形状与 `TeamCapacityResult` 的容量投影一致，便于直接喂 `planBudget`。 */
export interface EffectiveCapacity {
    source: CapacitySource;
    /** 更高层（调用/观测）是否盖掉了声明缺口：诊断里要说得清“为什么上限是这样”。 */
    evidence_source: string;
    memberSlots: MemberSlots;
    activations: ActivationSlots;
    /** 非阻塞缺口（`{code, detail, nextStep}`，与 `teamAdapter.capacity()` 同形状）。 */
    gaps: CapacityGap[];
    /** 被读到的观测值（即使不适用于本会话也保留，便于诊断“为什么不套用”）。 */
    observed: ObservedCapacityRecord | null;
}
/** `readObservedCapacity()` 的结果。 */
export interface ObservedRead {
    record: ObservedCapacityRecord | null;
    /** 只有「文件在、但用不了」时才给缺口；文件不存在不算异常。 */
    gap: CapacityGap | null;
    /** 观测值是否适用于本会话（会话一致才为 true）。 */
    applies: boolean;
}
/** 「观测中」标记的投影。 */
export interface ObservationMarker {
    present: boolean;
    session_id: string | null;
    member: string | null;
    started_at: string | null;
    operation_id: string | null;
    /** 文件在但不是合法 JSON 对象：按「无法证明它属于别的会话」保守处理。 */
    malformed: boolean;
}
/** `parseCallCapacity()` 的结果：`present:false` 表示调用方没传。 */
export interface CallCapacityParse {
    present: boolean;
    value: CallCapacity | null;
    issue: string | null;
}
/**
 * 解析按调用声明的 `capacity`。
 *
 * 校验在 `index.ts` 已按 wire schema 做过一遍；这里再判一次是因为 handler 也会被直接调用
 * （测试、恢复路径），而且 `dispatch` 自己实现了 `normalizeDispatchInput`。
 */
export declare function parseCallCapacity(raw: unknown): CallCapacityParse;
/** 读观测值文件；缺失返回「没有」，坏形状/别的会话返回缺口（绝不抛）。 */
export declare function readObservedCapacity(root: string, sessionId: string | null): Promise<ObservedRead>;
/** 原子写观测值；返回项目内相对路径。 */
export declare function writeObservedCapacity(root: string, record: ObservedCapacityRecord): Promise<string>;
/** 读「观测中」标记（缺失/坏 JSON 都不抛）。 */
export declare function readObservationMarker(root: string): Promise<ObservationMarker>;
/** 写「观测中」标记（spawn 之前；结束/失败后由调用方删除）。 */
export declare function writeObservationMarker(root: string, marker: {
    sessionId: string | null;
    member: string;
    operationId: string;
    startedAt: string;
}): Promise<void>;
/** 删「观测中」标记（不存在不算错）。 */
export declare function clearObservationMarker(root: string): Promise<void>;
/** 「观测中」标记是否应该挡住本次派发。 */
export interface MarkerGuard {
    blocked: boolean;
    reason: string | null;
    next_step: string | null;
    /** 标记属于别的会话（不挡，但要如实报告）。 */
    foreign: boolean;
}
/**
 * 并发保护（ticket 第 3 节最后一条）：
 * 无已知容量 + 已有「观测中」标记 → 明确拒绝，避免并行撞出 N 个不可逆损失。
 *
 * 会话判定与观测值同口径：只有能证明「这是别的会话的标记」时才放行；证明不了（无 session_id、
 * 坏 JSON、本调用没有会话身份）一律按本会话处理 —— 拒绝的代价是多等一次，放行的代价是烧名字。
 */
export declare function capacityMarkerGuard(marker: ObservationMarker, sessionId: string | null): MarkerGuard;
/** `resolveCapacity()` 的入参：上层只给「适配器读到的声明」与「本次调用声明」。 */
export interface ResolveCapacityInput {
    call: CallCapacity | null;
    declared: DeclaredCapacityView;
    observed: ObservedRead;
}
/** 容量来源的缺口（诊断用；`capacity_source` 必须出现在 reason 里）。 */
export declare function capacitySourceGap(source: CapacitySource, limits: {
    max_members: number | null;
    max_active_subagents: number | null;
}, observed: ObservedCapacityRecord | null): CapacityGap;
/**
 * 解析生效容量（纯函数，不做 IO）。
 *
 * 优先级：`call` > `project` > `profile` > `observed`（同会话）> `unknown`。
 * 适配器已经把「项目声明 > profile 声明」合过一次，`evidence.source` 只是来源标签。
 */
export declare function resolveCapacity({ call, declared, observed }: ResolveCapacityInput): EffectiveCapacity;
