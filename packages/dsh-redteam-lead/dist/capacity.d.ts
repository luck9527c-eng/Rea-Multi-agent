/** 岗位在计划里的去向（`$defs.post.state` 的子集）。 */
export type PostPlanState = 'assigned' | 'vacant' | 'deferred' | 'disabled';
/** 一条缺口（`$defs.diagnostic` 的三字段）。 */
export interface PostPlanGap {
    code: string;
    reason: string;
    next_step: string;
}
/** `assigned/vacant/deferred/disabled` 里的一项（`$defs.post` 的 7 字段形状）。 */
export interface PostPlanEntry {
    post_id: string | null;
    state: PostPlanState;
    required: string[];
    optional: string[];
    anchors_required: string[];
    member: string | null;
    reason: string;
}
/** `planPosts()` 的返回。 */
export interface PostPlan {
    assigned: PostPlanEntry[];
    vacant: PostPlanEntry[];
    deferred: PostPlanEntry[];
    disabled: PostPlanEntry[];
    gaps: PostPlanGap[];
}
/** `planPosts()` 的入参：候选岗位 + 操作者的岗位数上限。 */
export interface PlanPostsInput {
    /** 候选岗位（可含 enabled/running/member/capability）。 */
    candidates?: unknown;
    maxPosts?: unknown;
}
/**
 * 把候选岗位归类成计划。
 *
 * 只有三种理由会让岗位「不能立刻派」：岗位被禁用（disabled）、能力不满足（vacant）、
 * 超出操作者的 `max_posts`（deferred）。**没有**任何「剩余席位不足」这一类 —— 那件事宿主不说，
 * 我们也不猜。
 */
export declare function planPosts({ candidates, maxPosts }?: PlanPostsInput): PostPlan;
