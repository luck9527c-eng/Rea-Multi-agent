/** 岗位在计划里的去向（`$defs.post.state` 的子集）。 */
export type BudgetPostState = 'assigned' | 'vacant' | 'deferred' | 'disabled';
/** 一条预算缺口（`$defs.diagnostic` 的三字段）。 */
export interface BudgetGap {
    code: string;
    reason: string;
    next_step: string;
}
/** `assigned/vacant/deferred/disabled` 里的一项（`$defs.post` 的 7 字段形状）。 */
export interface BudgetPostEntry {
    post_id: string | null;
    state: BudgetPostState;
    required: string[];
    optional: string[];
    anchors_required: string[];
    member: string | null;
    reason: string;
}
/** 内部形状：投进 `rosterData.capacity` 前只能保留 schema 的 4 个字段（D19）。 */
export interface BudgetCapacity {
    known: boolean;
    member_slots_known: boolean;
    activations_known: boolean;
    remaining_member_slots: number | null;
    remaining_activations: number | null;
    reserved_member_slots: number;
    reserved_activations: number;
    available_member_slots: number | null;
    available_activations: number | null;
}
/** `planBudget()` 的返回。 */
export interface BudgetPlan {
    assigned: BudgetPostEntry[];
    vacant: BudgetPostEntry[];
    deferred: BudgetPostEntry[];
    disabled: BudgetPostEntry[];
    gaps: BudgetGap[];
    recommended_members: number;
    capacity: BudgetCapacity;
}
/**
 * `planBudget()` 的入参。
 *
 * 余额/上限一律按「调用方给什么就收什么」声明：`null`=未知，非法值按缺省处理
 * （裁剪前会再过一遍 `toNonNegativeInt`），所以这里写 `unknown` 而不是假装一定是 number。
 */
export interface PlanBudgetInput {
    /** 候选岗位（可含 enabled/running/member/capability）。 */
    candidates?: unknown;
    /** 宿主报告的剩余成员席位；null=未知。 */
    remainingMemberSlots?: unknown;
    /** 宿主报告的剩余 activation；null=未知。 */
    remainingActivations?: unknown;
    /** 复用项：`{post_id|id, member, activation_increment}`。 */
    reuseCandidates?: unknown;
    maxPosts?: unknown;
    reservedMemberSlots?: unknown;
    reservedActivations?: unknown;
}
/**
 * 生成预算内的岗位计划。
 */
export declare function planBudget({ candidates, remainingMemberSlots, remainingActivations, reuseCandidates, maxPosts, reservedMemberSlots, reservedActivations, }?: PlanBudgetInput): BudgetPlan;
