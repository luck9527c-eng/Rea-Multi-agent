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
 * 观测值的语义（T18 → T18b）：
 *
 * - 宿主在两条容量拒绝消息里**写着真实数字**（`active child limit: N` / `Team member limit N reached`，
 *   见 `docs/impl/UPSTREAM-API.md`）。解析到就用准确的 N 写对应维度（`parseHostCapacityLimit` +
 *   `observeCapacity`，纯函数，不做 IO）。
 * - 解析不到（宿主改措辞）才回落到 T18 的语义：取**观测当时的已用席位数**（失败成员已计入），
 *   即“你已经到顶了”，是真实上限的**保守下限**。
 * - 落下的是哪一路必须可查（`basis.parsed_limit` / `basis.message`），且**不得降级**：
 *   已经解析到准确值之后，一次不可解析的碰撞不得把它改回推断值。
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
/**
 * 观测值的来源（T18b 的并集，ticket 逐字规定）。
 *
 * 四个字段回答三件事：**谁拒的**（`host_code`）、**数字从哪来**（`parsed_limit` 为 `null`
 * 就是回落，非 `null` 就是宿主消息里的准确值）、**当时的现场**（`used_at_observation` 与原文 `message`）。
 * `parsed_limit` 作用在哪个维度由 `host_code` 决定：`TEAM_MEMBER_LIMIT` → `max_members`，
 * `ACTIVATION_LIMIT_REACHED` → `max_active_subagents`（两条消息各只讲一件事）。
 */
export interface ObservedCapacityBasis {
    host_code: string;
    /** 从宿主消息里解析出的真实上限；`null` = 消息里没有可解析的数字，对应维度回落。 */
    parsed_limit: number | null;
    /** 观测当时的已用席位数（失败成员已计入）。 */
    used_at_observation: number;
    /** 宿主原始文案（解析依据；宿主没给文案时是空串）。 */
    message: string;
}
/** `re/team/capacity-observed.json` 的形状（ticket 逐字规定）。 */
export interface ObservedCapacityRecord {
    schema_version: number;
    session_id: string;
    observed_at: string;
    max_members: number;
    max_active_subagents: number;
    basis: ObservedCapacityBasis;
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
    /**
     * 标记文件自身的 mtime（带时区 ISO）。
     *
     * `started_at` 是写标记时进程自己的声明，可能缺失、也可能是崩溃前最后一刻写的；mtime 是文件系统的，
     * 两者对上才说明那次观测确实刚刚开始。操作者判断「这是不是一次崩溃留下的残骸」靠这两个时间。
     */
    modified_at: string | null;
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
/** 解析命中的消息格式：一条消息只说一件事。 */
export type HostLimitPattern = 'active_child_limit' | 'team_member_limit';
/** `parseHostCapacityLimit()` 的结果（`limit: null` = 不认识，走回落）。 */
export interface HostLimitParse {
    pattern: HostLimitPattern | null;
    limit: number | null;
}
/**
 * 从宿主**自己抛出的**容量拒绝消息里读出准确上限（纯函数，不做 IO）。
 *
 * 只认这两条稳定码 —— 不把任意宿主消息拿去正则（T18b 边界）：文案是宿主私有实现细节，
 * 换个码就可能撞上同样的字样，届时语义并不相同。
 *
 * 读的是宿主抛给调用方的 `error.message`（被动观测），不碰任何私有字段（D1）。
 */
export declare function parseHostCapacityLimit(hostCode: string | null, message: string | null): HostLimitParse;
/** 观测值是从哪儿来的（诊断必须说得清）。 */
export type ObservationOrigin = 'parsed' | 'fallback' | 'retained';
/** `observeCapacity()` 的入参：一次**真实**碰撞的现场。 */
export interface CapacityObservationInput {
    sessionId: string;
    observedAt: string;
    /** 观测当时的已用席位数（失败成员已计入）。 */
    used: number;
    hostCode: string;
    /** 宿主原始文案；宿主没给文案时传 `null`。 */
    message: string | null;
    /** 同会话已有的观测值（别的会话的不要传进来：席位随会话重置）。 */
    existing: ObservedCapacityRecord | null;
}
/** `observeCapacity()` 的结论：要落盘的记录 + 数字的来源。 */
export interface CapacityObservation {
    record: ObservedCapacityRecord;
    origin: ObservationOrigin;
    /** 本次消息里解析出的数字（`retained`/`fallback` 为 `null`）。 */
    parsed_limit: number | null;
}
/**
 * 把一次容量碰撞折算成观测值（纯函数，不做 IO）。
 *
 * 三条规则：
 *
 * 1. **解析到就写准确值**，只写消息讲到的那个维度；另一个维度取
 *    `max(已有值, used)` —— 既保持 T18 的「used 是保守下限」，也不会因为一条只讲
 *    activation 的消息把已经解析出的 `max_members` 降级回去。
 * 2. **解析不到且已有解析值 → 原样沿用**（`origin: 'retained'`，连 `observed_at` 都不改）：
 *    准确值仍然成立，只是这一次没重新读到；把它改回推断值就是降级。
 * 3. **解析不到且没有解析值 → 回落**为 `used_at_observation`（T18 的语义，`parsed_limit: null`）。
 */
export declare function observeCapacity(input: CapacityObservationInput): CapacityObservation;
/** 读观测值文件；缺失返回「没有」，坏形状/别的会话返回缺口（绝不抛）。 */
export declare function readObservedCapacity(root: string, sessionId: string | null): Promise<ObservedRead>;
/** 原子写观测值；返回项目内相对路径。 */
export declare function writeObservedCapacity(root: string, record: ObservedCapacityRecord): Promise<string>;
/**
 * 读「观测中」标记（缺失/坏 JSON 都不抛）。
 *
 * 同时取该文件自身的 mtime（`modified_at`）：`started_at` 缺失或不可信时，操作者仍要能判断
 * 「这是不是上一次派发崩溃留下的残骸」——一个几小时前的 mtime 与一个刚写下的 mtime，处置完全不同。
 */
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
