/**
 * `rt_conclude`：提交校验 → 锚点闭集 → 归档 → 基准比对 + 一次性 seal → 更新事实 →
 * impact → index → `check --hashes` → 完成宿主任务 → 回执。
 *
 * 契约来源：编排契约「工具输入与输出」「交付、开始和结果分类」「锚点与封存绑定」
 * 「操作阶段与部分失败」，规格「双账本」「证据基线」「锚点闭集」，
 * 协作契约「工兵交回与 rt_conclude」「记录与写入归属」。
 *
 * 顺序**不可换**（ticket T7 的硬要求）：
 * `核对身份与前提 → 校验提交 → 锚点闭集 → 归档 → 基准比对 + seal → 更新事实 → impact →
 *  index → check --hashes`
 *
 * **seal 顺序裁决（DECISIONS D29）**：编排契约 §135 提到「seal 前先按事实解除会令全项目校验
 * 失败的旧状态」，但这里**保持 seal 在「更新事实」之前** —— 反过来会让 seal 封存的是
 * **尚未更新的旧事实**，比它想解决的问题更严重。若旧状态确实挡住 seal，如实返回
 * `CHECK_FAILED`，由 Lead 先按 skill 修好记录再以同一 operation ID 重入：不降门槛、不静默改序。
 *
 * 关键不变量：
 * - 只有 Lead 可调；工兵/裸子代理 `ROLE_REQUIRED` 且零副作用（身份先于任何写）。
 * - 同 `operation_id` 重放返回原回执（`replayed=true`），内容冲突 `OPERATION_CONFLICT`；
 *   **不同 operation ID 指向同一 dispatch/attempt** 也按业务身份去重，不重复封存/追加 history。
 * - `index` 必须在 `check` 之前（`check` 校验 INDEX 导航区字节相等）。
 * - `seal` 一次性：已有封存只校验复用，绝不重封存、绝不覆盖。
 * - 任何脚本失败 → `CHECK_FAILED`，保留 stdout/stderr/exitCode/阶段，**不完成任务、不降门槛**。
 * - 回执写不成 → `partial`；审计写失败 → `ok` + `audit_written=false`。
 * - 原生提前 `complete` 且无回执 → 标记 `UNREVIEWED_COMPLETION`：全部检查照跑，
 *   最后核对完成态而**不再调 complete**。
 *
 * handler 形状：`export async function handleConclude(ctx, input)` → `{ envelope }`，绝不 reject。
 */
import type { Diagnostic, HandlerCtx, HandlerResult } from './types.js';
/**
 * `$defs.review` 的八个必填字段。
 *
 * 只把「后续按字符串用」的字段写成具体类型；其余保持 `unknown` —— 本文件读到就按未知处理
 * （`closureForStatus` / `buildRouteUpdate` 里逐处 `typeof` 收窄）。
 */
interface ConcludeReview {
    outcome: string;
    summary: unknown;
    reason: unknown;
    proposed_route_status: string;
    evidence_run_ids: string[];
    anchor_refs: readonly unknown[];
    limitations: string[];
    next_step: string | null;
}
/**
 * `$defs.concludeInput` 的有效形状。
 *
 * **只在 `checkInputShape()` 返回 `ok: true` 之后成立**：那一步逐字段核对了八个必填项与
 * `review` 的八字段（`checkInputShape` 是唯一把入参从 `unknown` 收成这个形状的地方）。
 */
interface ConcludeInput {
    project_root: string;
    operation_id: string;
    dispatch_id: string;
    attempt_id: string;
    task_id: string;
    expected_revision: number;
    submission_ref: string;
    submission_sha256: string;
    review: ConcludeReview;
}
/** 路线记录（`re/routes/<R>.json`，项目 skill 写；本文件读判据后整体回写）。 */
interface RouteRecord {
    id?: string;
    status?: string;
    state_reason?: unknown;
    resume_when?: string;
    closure?: unknown;
    target_ids?: unknown[];
    evidence?: unknown[];
    history?: unknown[];
    [key: string]: unknown;
}
/** 七类结果允许的路线变化与成功依赖（编排契约的七行表，数据驱动）。 */
export declare const OUTCOME_RULES: Readonly<{
    finding: Readonly<{
        route_statuses: readonly string[];
        requires_runs: true;
        requires_anchors: true;
        success_dependency: "validated_only";
    }>;
    no_finding: Readonly<{
        route_statuses: readonly string[];
        requires_runs: true;
        requires_anchors: true;
        success_dependency: "validated_only";
    }>;
    refuted: Readonly<{
        route_statuses: readonly string[];
        requires_runs: true;
        requires_anchors: true;
        success_dependency: "never";
    }>;
    blocked: Readonly<{
        route_statuses: readonly string[];
        requires_runs: false;
        requires_anchors: false;
        success_dependency: "never";
    }>;
    budget_exhausted: Readonly<{
        route_statuses: readonly string[];
        requires_runs: false;
        requires_anchors: false;
        success_dependency: "never";
    }>;
    failed: Readonly<{
        route_statuses: readonly string[];
        requires_runs: true;
        requires_anchors: true;
        success_dependency: "never";
    }>;
    cancelled: Readonly<{
        route_statuses: readonly string[];
        requires_runs: false;
        requires_anchors: false;
        success_dependency: "never";
    }>;
}>;
/** `$defs.routeStatus`。 */
export declare const ROUTE_STATUSES: readonly string[];
/** 收口回执目录（业务身份 = dispatch + attempt）。 */
export declare const RECEIPTS_DIR = "re/team/receipts";
/** 派发记录目录（T6 写、T7 读）。 */
export declare const DISPATCHES_DIR = "re/team/dispatches";
/** attempt 关联记录目录（T6 写、T7 读：task/member/契约摘要在契约落盘之后才存在）。 */
export declare const ATTEMPTS_DIR = "re/team/attempts";
/**
 * 入参形状检查（schema 之外的最后一道防线：测试与直接调用都可能绕过宿主校验）。
 * @returns {{ok: true, value: object} | {ok: false, issues: object[]}}
 */
export declare function checkInputShape(input: unknown): {
    ok: true;
    value: ConcludeInput;
} | {
    ok: false;
    issues: Diagnostic[];
};
/** `effectiveRequiredKinds()` 的入参。 */
interface RequiredKindsInput {
    outcome: string;
    runIds?: string[];
    requiredKinds?: string[];
}
/**
 * 实际生效的锚点要求：未开始即阻塞/取消的交付不强制补造成功锚点
 * （模板的成功锚点要求只适用于 `requires_runs` 的结果行）。
 *
 * @param {{ outcome: string, runIds?: string[], requiredKinds?: string[] }} input
 * @returns {string[]}
 */
export declare function effectiveRequiredKinds(input: RequiredKindsInput): string[];
/** `evaluateDelivery()` 的入参。 */
interface DeliveryInput {
    outcome: string;
    proposedRouteStatus: string;
    runIds: string[];
    evidenceRunIds: string[];
    requiredKinds: string[];
    anchorKinds: string[];
    stateRecoveryRef: unknown;
    submissionOutcome: unknown;
}
/** `evaluateDelivery()` 的判定。 */
type DeliveryVerdict = {
    ok: true;
    successDependency: boolean;
} | {
    ok: false;
    code: 'CHECK_FAILED' | 'SUBMISSION_INVALID';
    issues: Diagnostic[];
};
/**
 * 按七类结果检查交付门槛（成功/反证型合并后的锚点要求、未开始即阻塞的诊断依据）。
 *
 * @param {object} input
 * @param {string} input.outcome
 * @param {string} input.proposedRouteStatus
 * @param {string[]} input.runIds
 * @param {string[]} input.evidenceRunIds
 * @param {string[]} input.requiredKinds 已经过 `effectiveRequiredKinds`
 * @param {string[]} input.anchorKinds
 * @param {string|null} input.stateRecoveryRef
 * @param {string} input.submissionOutcome
 * @returns {{ok:true, successDependency:boolean} | {ok:false, code:'CHECK_FAILED'|'SUBMISSION_INVALID', issues:object[]}}
 */
export declare function evaluateDelivery(input: DeliveryInput): DeliveryVerdict;
/** `buildRouteUpdate()` 的入参。 */
interface RouteUpdateInput {
    route: RouteRecord;
    review: ConcludeReview;
    nextStatus: string;
    at: string;
}
/** `buildRouteUpdate()` 的结果：改后的路线，或拒绝理由。 */
type RouteUpdateResult = {
    ok: true;
    route: RouteRecord;
    changed: boolean;
    historyAppended: boolean;
} | {
    ok: false;
    code: 'CHECK_FAILED';
    issues: Diagnostic[];
};
/**
 * 依据 review 生成路线更新（history / closure / evidence / state_reason）。
 *
 * 只写 review 有依据的判定：不臆造 closure 里的实验事实（缺就拒绝，见 `closureForStatus`）。
 *
 * @returns {{ok:true, route:object, changed:boolean, historyAppended:boolean}
 *   | {ok:false, code:'CHECK_FAILED', issues:object[]}}
 */
export declare function buildRouteUpdate({ route, review, nextStatus, at }: RouteUpdateInput): RouteUpdateResult;
/** `routeImpactOf()` 的结果（四个清单都只按「影响本路线的条目」筛出）。 */
interface RouteImpact {
    pendingReviews: unknown[];
    disputeImpacts: unknown[];
    recovery: unknown[];
    items: unknown[];
}
/**
 * 从 `impact` 报告里挑出影响本路线的条目。
 * @returns {{items: object[], pendingReviews: object[], disputeImpacts: object[], recovery: object[]}}
 */
export declare function routeImpactOf(impactJson: unknown, routeId: unknown): RouteImpact;
/**
 * @param {object} ctx HandlerCtx（SEAMS §1）
 * @param {object} rawInput 已通过 `$defs.concludeInput` 校验（本文件不信任这一点）
 * @returns {Promise<{ envelope: object }>}
 */
export declare function handleConclude(ctx: HandlerCtx, rawInput: unknown): Promise<HandlerResult>;
export {};
