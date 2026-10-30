/**
 * T6 `rt_dispatch`：把一条**已在项目 skill 中建立的可执行路线**交给一个成员。
 *
 * 不变量顺序（编排契约「工具输入与输出」+ 协作契约「派发顺序的不变量」）：
 *
 * 1. 路线必须是 Lead 按 skill 建立、尚未收口的可执行问题（`readRoute` + `impact`）；
 *    `target_ids` 必须是该路线目标集合的非空子集，额外目标要先建新路线。
 * 2. 有效 `validated` 依赖、条件版本、open 争议、恢复待办逐项核查。
 * 3. 能力 = 岗位 `required` ∪ 任务 `capability_needs`（只追加）；缺通道/入口 → `CAPABILITY_MISSING`。
 * 4. 成员占用（`MEMBER_BUSY`）+ `DEPENDENCY_BLOCKED`。**不做容量规划**（T23 / D41）：
 *    宿主的上限读不到，派发直接调 `spawnTeammate`；宿主拒绝时按它的原话报 `CAPACITY_EXHAUSTED`。
 * 5. 资源在锁内检查/租用；别名归一、默认独占、`quarantined` 不再分配。
 *
 * 前置任一不过 → `status=blocked` **且零副作用**（不建成员、不建任务、不写 `re/team/`）。
 * 只有契约落盘、成员就绪、任务 `in_progress` 且 owner 正确、交付信封被宿主接收，
 * 才是 `phase='delivered'` 的成功派发；中间失败一律 `partial` 并带回已产生的身份。
 *
 * 操作阶段：`prepared → member_ready → task_created → assigned → delivered`，
 * 每步「先存意图、后存实际 ID」；同 `operation_id` 重入从已存阶段续做
 * （不重复 spawn、不建第二个 task），响应丢失时按确定的成员名 / 任务摘要标记唯一关联。
 */
import type { Diagnostic, HandlerCtx, HandlerResult } from './types.js';
/** 项目规则入口（bootstrap prompt 与交付信封都指向它）。 */
export declare const RULES_ENTRY = "docs/agents/reverse-project-management.md";
/** 项目内 skill 副本（只读入口，不用全局副本覆盖历史）。 */
export declare const SKILL_COPY_ENTRY = ".agents/skills/reverse-project-management/SKILL.md";
/** `deps.paths` 的形状。 */
type PathsModule = typeof import('./paths.js');
/** 规范化后的派发请求（形状校验已全部通过）。 */
interface DispatchRequest {
    project_root: string;
    operation_id: string;
    post_id: string;
    route_id: string;
    target_ids: string[];
    objective: string;
    evidence_required: string[];
    prohibited: string[];
    capability_needs: string[];
    depends_on_tasks: string[];
    resource_needs: unknown[];
    timebox_ms: number;
    delivery_timeout_ms: number;
    retry_of: Record<string, unknown> | null;
}
/** `normalizeDispatchInput` 的结果：形状错误时 `value` 为空对象（调用方不会读它）。 */
type NormalizedDispatch = {
    ok: true;
    value: DispatchRequest;
    issues: Diagnostic[];
    operationId: string;
} | {
    ok: false;
    value: Record<string, never>;
    issues: Diagnostic[];
    operationId: string | null;
};
/** 成员决策（`decideMember` 的产物）；`busy` 由 preflight 当场拒绝，不进计划。 */
type MemberDecision = {
    action: 'reuse';
    member: string;
} | {
    action: 'busy';
    members: string[];
    tasks: unknown[];
} | {
    action: 'spawn';
    member: string;
    failedBefore: string[];
};
/**
 * 规范化 `dispatchInput`：填默认值、去重集合项、给出形状错误。
 *
 * 形状错误是调用方错误（`INVALID_ARGUMENT` / `status=error`），不是派发前置拒绝。
 */
export declare function normalizeDispatchInput(raw: unknown): NormalizedDispatch;
/** attempt 本地记录（dispatch/attempt → task/member 的恢复关联）。 */
export declare function readAttemptRecord(root: string, dispatchId: unknown, attemptId: unknown, paths?: PathsModule): Promise<Record<string, unknown> | null>;
/** `decideMember` 的入参。 */
interface DecideMemberInput {
    postId: string;
    members: unknown;
    tasks: unknown;
    excludeTaskIds?: readonly string[];
}
/**
 * 选成员：同岗空闲复用；忙碌 `MEMBER_BUSY`；否则用下一个没被用过的名字新建
 * （D12：失败/历史名字永久占用，不重试同名）。
 */
export declare function decideMember({ postId, members, tasks, excludeTaskIds, }: DecideMemberInput): MemberDecision;
/** 影响报告里的一条待处理项。 */
interface ImpactProblem {
    kind: string;
    field: string;
    entry: unknown;
}
/** 影响报告里与本路线相关的待处理项（open 争议 / 待复查 / 恢复待办）。 */
export declare function impactProblems(impactJson: unknown, routeId: unknown): ImpactProblem[];
/**
 * `rt_dispatch` handler。永不 reject；成功返回 `{ envelope }`（`status=ok` 仅当交付完成）。
 *
 * `ctx` 是装配上下文（SEAMS 第 1 节）；`input` 是已通过 `$defs.dispatchInput` 校验的入参
 * （本函数仍做形状兜底）。缺装配时返回最小合法错误信封，不抛。
 */
export declare function handleDispatch(ctx: HandlerCtx, input: unknown): Promise<HandlerResult>;
/** `dependedSealedRunIds()` 的入参：全是从已读记录投影出来的纯数据。 */
interface DependedRunInput {
    routeId: string;
    /** 路线声明的 RUN（`dependency_runs` ∪ `evidence`）。 */
    declared: readonly string[];
    /** 当前 seal 清单里的 RUN 封存。 */
    sealed: readonly string[];
    targetIds: readonly string[];
    /** 已读到的 RUN 记录（只含已封存的，按 `run_id` 索引）。 */
    runs: ReadonlyArray<{
        run_id: string;
        record: unknown;
    }>;
}
/**
 * 纯决策：本次派发真正要冻结的**已封存 RUN**。
 *
 * 只读已读到的记录，不做 I/O；`runs` 里没有的 RUN 一律当作「不冻结」（未封存/读不到）。
 */
export declare function dependedSealedRunIds(input: DependedRunInput): string[];
export {};
