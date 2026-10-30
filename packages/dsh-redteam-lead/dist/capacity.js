// 岗位计划（原「席位 / activation 预算裁剪」；T23 起本模块**不做任何容量规划**）。
//
// 为什么只剩这些：宿主不提供任何上限读数 —— `maxMembers` 是 `TeamService` 的构造函数参数，
// 没有 getter 也没有 state 投影；`maxActiveSubagents` 在团队服务里根本不存在。它自己的强制执行
// 就是唯一的上限事实（拒绝时抛 `TEAM_MEMBER_LIMIT` / `ACTIVATION_LIMIT_REACHED`）。
// 所以「还能开几个」这个问题本模块不回答，也不猜；派不派只看**能力是否满足**与操作者给的 `max_posts`。
//
// 输入是候选岗位；不读宿主、不猜 8/16、不按常数假定余额。
// 选择顺序：priority 升序，同值按 post_id 升序；已运行岗位永远保留且占 max_posts。
import { isRecord, recordOf } from './guards.js';
const MAX_POSTS_NEXT_STEP = '提高 max_posts（本次调用或岗位目录 defaults.max_posts），或减少目标类别后重试';
function toNonNegativeInt(value, fallback) {
    if (value === null || value === undefined)
        return fallback === undefined ? null : fallback;
    // `Number.isFinite` 只对 number 为真，故这里的 typeof 判断与迁移前逐字等价。
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback === undefined ? null : fallback;
    }
    return Math.max(0, Math.floor(value));
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function gap(code, reason, nextStep) {
    return { code, reason, next_step: nextStep };
}
function postEntry(candidate, state, member, reason) {
    return {
        post_id: candidate.post_id,
        state,
        required: stringList(candidate.required),
        optional: stringList(candidate.optional),
        anchors_required: stringList(candidate.anchors_required),
        member,
        reason,
    };
}
function candidateId(candidate) {
    const record = recordOf(candidate);
    const postId = record.post_id;
    if (typeof postId === 'string' && postId.length > 0)
        return postId;
    const id = record.id;
    if (typeof id === 'string' && id.length > 0)
        return id;
    return null;
}
function normalizeCandidate(raw) {
    const candidate = recordOf(raw);
    const priority = candidate.priority;
    const member = candidate.member;
    return {
        post_id: candidateId(candidate),
        // `Number.isFinite` 只对 number 为真，故结果与迁移前一致。
        priority: typeof priority === 'number' && Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER,
        enabled: candidate.enabled !== false,
        disabled_reason: candidate.disabled_reason ?? null,
        required: candidate.required,
        optional: candidate.optional,
        anchors_required: candidate.anchors_required,
        running: candidate.running === true || candidate.state === 'assigned',
        member: typeof member === 'string' && member.length > 0 ? member : null,
        capability: candidate.capability ?? { satisfied: true, missing: [] },
    };
}
/**
 * 把候选岗位归类成计划。
 *
 * 只有三种理由会让岗位「不能立刻派」：岗位被禁用（disabled）、能力不满足（vacant）、
 * 超出操作者的 `max_posts`（deferred）。**没有**任何「剩余席位不足」这一类 —— 那件事宿主不说，
 * 我们也不猜。
 */
export function planPosts({ candidates = [], maxPosts = 6 } = {}) {
    const postLimit = toNonNegativeInt(maxPosts, 6);
    const assigned = [];
    const vacant = [];
    const deferred = [];
    const disabled = [];
    const gaps = [];
    const seen = new Set();
    let usedPosts = 0;
    const ordered = (Array.isArray(candidates) ? candidates : [])
        .map((raw, index) => ({ candidate: normalizeCandidate(raw), index }))
        .sort((left, right) => {
        if (left.candidate.priority !== right.candidate.priority) {
            return left.candidate.priority - right.candidate.priority;
        }
        const leftId = left.candidate.post_id ?? '';
        const rightId = right.candidate.post_id ?? '';
        if (leftId !== rightId)
            return leftId < rightId ? -1 : 1;
        return left.index - right.index;
    });
    for (const { candidate } of ordered) {
        if (!candidate.post_id) {
            gaps.push(gap('INVALID_ARGUMENT', '候选岗位缺少 post_id', '为每个候选岗位提供岗位目录中的 ID'));
            continue;
        }
        if (seen.has(candidate.post_id)) {
            gaps.push(gap('INVALID_ARGUMENT', `候选岗位 ${candidate.post_id} 重复出现，只处理一次`, '按 post_id 去重后再做岗位计划'));
            continue;
        }
        seen.add(candidate.post_id);
        if (candidate.enabled === false) {
            const reason = candidate.disabled_reason
                ? `岗位已禁用：${candidate.disabled_reason}`
                : '岗位在目录中为 disabled，不参与可用岗位计数';
            disabled.push(postEntry(candidate, 'disabled', null, reason));
            gaps.push(gap('POST_DISABLED', `岗位 ${candidate.post_id} ${reason}`, '改用已启用岗位；不要为未实现能力建岗'));
            continue;
        }
        if (candidate.running) {
            // 已运行岗位不因降低 max_posts 被取消；它占一个 max_posts 名额。
            assigned.push(postEntry(candidate, 'assigned', candidate.member, candidate.member
                ? `已运行岗位保留，成员 ${candidate.member}，计入 max_posts`
                : '已运行岗位保留，计入 max_posts'));
            usedPosts += 1;
            continue;
        }
        const capability = candidate.capability ?? { satisfied: true, missing: [] };
        if (isRecord(capability) && capability.satisfied === false) {
            const missing = Array.isArray(capability.missing)
                ? capability.missing.map((item) => recordOf(item))
                : [];
            const detail = missing.length > 0
                ? missing.map((item) => item.reason ?? item.capability ?? '能力缺失').join('；')
                : '岗位要求的能力无法满足';
            vacant.push(postEntry(candidate, 'vacant', null, `能力缺口：${detail}`));
            if (missing.length === 0) {
                gaps.push(gap('CAPABILITY_MISSING', `岗位 ${candidate.post_id} 能力不足：${detail}`, '补齐执行者可用的完整工具名或登记 provider'));
            }
            else {
                for (const item of missing) {
                    const nextStep = item.next_step;
                    gaps.push(gap(typeof item.code === 'string' ? item.code : 'CAPABILITY_MISSING', `岗位 ${candidate.post_id} 能力缺口：${item.reason ?? item.capability ?? detail}`, typeof nextStep === 'string' ? nextStep : '补齐执行者可用的完整工具名或登记 provider'));
                }
            }
            continue;
        }
        if (usedPosts >= postLimit) {
            deferred.push(postEntry(candidate, 'deferred', null, `超出 max_posts=${postLimit}，按 priority 延后`));
            gaps.push(gap('CAPACITY_EXHAUSTED', `岗位 ${candidate.post_id} 超出 max_posts=${postLimit}`, MAX_POSTS_NEXT_STEP));
            continue;
        }
        assigned.push(postEntry(candidate, 'assigned', null, '能力已满足，需要新建 1 名成员（能否建成由宿主决定）'));
        usedPosts += 1;
    }
    return { assigned, vacant, deferred, disabled, gaps };
}
