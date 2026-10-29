// 席位 / activation 预算裁剪（纯函数）。
//
// 输入是显式余额与候选岗位；不读宿主、不猜 8/16、不按常数假定余额。
// 选择顺序：priority 升序，同值按 post_id 升序；已运行岗位永远保留且占 max_posts。

const NEW_MEMBER_NEXT_STEP =
  '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents（或改 profile config），或释放已有成员/activation 后重试';
const UNKNOWN_NEXT_STEP =
  '在 re/team/capacity.json 显式声明 maxMembers/maxActiveSubagents（含 declared_at/declared_by），不要假定固定余额';

function toNonNegativeInt(value, fallback) {
  if (value === null || value === undefined) return fallback === undefined ? null : fallback;
  if (!Number.isFinite(value)) return fallback === undefined ? null : fallback;
  return Math.max(0, Math.floor(value));
}

function isInteger(value) {
  return Number.isInteger(value);
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
  if (typeof candidate?.post_id === 'string' && candidate.post_id.length > 0) return candidate.post_id;
  if (typeof candidate?.id === 'string' && candidate.id.length > 0) return candidate.id;
  return null;
}

function normalizeCandidate(raw) {
  const id = candidateId(raw);
  return {
    post_id: id,
    priority: Number.isFinite(raw?.priority) ? raw.priority : Number.MAX_SAFE_INTEGER,
    enabled: raw?.enabled !== false,
    disabled_reason: raw?.disabled_reason ?? null,
    required: raw?.required,
    optional: raw?.optional,
    anchors_required: raw?.anchors_required,
    running: raw?.running === true || raw?.state === 'assigned',
    member: typeof raw?.member === 'string' && raw.member.length > 0 ? raw.member : null,
    capability: raw?.capability ?? { satisfied: true, missing: [] },
  };
}

/**
 * 生成预算内的岗位计划。
 *
 * @param {object} input
 * @param {Array<object>} input.candidates 候选岗位（可含 enabled/running/member/capability）
 * @param {number|null} input.remainingMemberSlots 宿主报告的剩余成员席位；null=未知
 * @param {number|null} input.remainingActivations 宿主报告的剩余 activation；null=未知
 * @param {Array<{post_id?: string, id?: string, member: string, activation_increment?: number}>} [input.reuseCandidates]
 * @param {number} [input.maxPosts]
 * @param {number} [input.reservedMemberSlots]
 * @param {number} [input.reservedActivations]
 * @returns {{assigned: object[], vacant: object[], deferred: object[], disabled: object[],
 *   gaps: Array<{code: string, reason: string, next_step: string}>,
 *   recommended_members: number,
 *   capacity: object}}
 */
export function planBudget({
  candidates = [],
  remainingMemberSlots = null,
  remainingActivations = null,
  reuseCandidates = [],
  maxPosts = 6,
  reservedMemberSlots = 1,
  reservedActivations = 2,
} = {}) {
  const reservedSeats = toNonNegativeInt(reservedMemberSlots, 0);
  const reservedActs = toNonNegativeInt(reservedActivations, 0);
  const postLimit = toNonNegativeInt(maxPosts, 6);
  const remainingSeats = toNonNegativeInt(remainingMemberSlots, null);
  const remainingActs = toNonNegativeInt(remainingActivations, null);

  // 可新增成员数受「剩余席位 − 预留」与「剩余 activation − 预留」共同限制。
  const availableSeats = remainingSeats === null ? null : Math.max(0, remainingSeats - reservedSeats);
  const availableActs = remainingActs === null ? null : Math.max(0, remainingActs - reservedActs);

  const reuseByPost = new Map();
  for (const reuse of Array.isArray(reuseCandidates) ? reuseCandidates : []) {
    const id = candidateId(reuse);
    if (!id || typeof reuse.member !== 'string' || reuse.member.length === 0) continue;
    if (!reuseByPost.has(id)) reuseByPost.set(id, []);
    reuseByPost.get(id).push(reuse);
  }
  for (const list of reuseByPost.values()) {
    // 同一岗位有多个可用复用人选时，按成员名稳定取第一个，避免结果依赖输入顺序。
    list.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  }

  const assigned = [];
  const vacant = [];
  const deferred = [];
  const disabled = [];
  const gaps = [];
  const seen = new Set();
  let usedPosts = 0;
  let seatsLeft = availableSeats;
  let actsLeft = availableActs;
  let recommended = 0;

  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((raw, index) => ({ candidate: normalizeCandidate(raw), index }))
    .sort((left, right) => {
      if (left.candidate.priority !== right.candidate.priority) {
        return left.candidate.priority - right.candidate.priority;
      }
      const leftId = left.candidate.post_id ?? '';
      const rightId = right.candidate.post_id ?? '';
      if (leftId !== rightId) return leftId < rightId ? -1 : 1;
      return left.index - right.index;
    });

  for (const { candidate } of ordered) {
    if (!candidate.post_id) {
      gaps.push(gap('INVALID_ARGUMENT', '候选岗位缺少 post_id', '为每个候选岗位提供岗位目录中的 ID'));
      continue;
    }
    if (seen.has(candidate.post_id)) {
      gaps.push(gap(
        'INVALID_ARGUMENT',
        `候选岗位 ${candidate.post_id} 重复出现，只处理一次`,
        '按 post_id 去重后再做预算裁剪',
      ));
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
      // 已运行岗位不因降低预算被取消；它占一个 max_posts 名额。
      assigned.push(postEntry(
        candidate,
        'assigned',
        candidate.member,
        candidate.member
          ? `已运行岗位保留，成员 ${candidate.member}，计入 max_posts`
          : '已运行岗位保留，计入 max_posts',
      ));
      usedPosts += 1;
      continue;
    }

    const capability = candidate.capability ?? { satisfied: true, missing: [] };
    if (capability.satisfied === false) {
      const missing = Array.isArray(capability.missing) ? capability.missing : [];
      const detail = missing.length > 0
        ? missing.map((item) => item.reason ?? item.capability ?? '能力缺失').join('；')
        : '岗位要求的能力无法满足';
      vacant.push(postEntry(candidate, 'vacant', null, `能力缺口：${detail}`));
      if (missing.length === 0) {
        gaps.push(gap('CAPABILITY_MISSING', `岗位 ${candidate.post_id} 能力不足：${detail}`, '补齐执行者可用的完整工具名或登记 provider'));
      } else {
        for (const item of missing) {
          gaps.push(gap(
            typeof item.code === 'string' ? item.code : 'CAPABILITY_MISSING',
            `岗位 ${candidate.post_id} 能力缺口：${item.reason ?? item.capability ?? detail}`,
            item.next_step ?? '补齐执行者可用的完整工具名或登记 provider',
          ));
        }
      }
      continue;
    }

    if (usedPosts >= postLimit) {
      deferred.push(postEntry(
        candidate,
        'deferred',
        null,
        `超出 max_posts=${postLimit}，按 priority 延后`,
      ));
      gaps.push(gap(
        'CAPACITY_EXHAUSTED',
        `岗位 ${candidate.post_id} 超出 max_posts=${postLimit}`,
        '提高 max_posts 或释放已运行岗位后重试',
      ));
      continue;
    }

    const reuse = reuseByPost.get(candidate.post_id)?.[0];
    if (reuse) {
      const increment = reuse.activation_increment;
      if (!isInteger(increment) || increment < 0) {
        deferred.push(postEntry(
          candidate,
          'deferred',
          null,
          `复用成员 ${reuse.member} 的 activation 增量未知`,
        ));
        gaps.push(gap(
          'CAPACITY_UNKNOWN',
          `岗位 ${candidate.post_id} 复用成员 ${reuse.member} 时缺少宿主报告的 activation 增量`,
          '先由 teamAdapter 取得本次复用所需的 activation 增量，再重试；不要假定 inactive 成员自动释放额度',
        ));
        continue;
      }
      if (actsLeft === null) {
        deferred.push(postEntry(candidate, 'deferred', null, 'activation 余额未知，无法确认复用额度'));
        gaps.push(gap(
          'CAPACITY_UNKNOWN',
          `岗位 ${candidate.post_id} 需要复用成员 ${reuse.member}，但 activation 余额未知`,
          UNKNOWN_NEXT_STEP,
        ));
        continue;
      }
      if (increment > actsLeft) {
        deferred.push(postEntry(
          candidate,
          'deferred',
          null,
          `activation 不足：需要 ${increment}，可用 ${actsLeft}`,
        ));
        gaps.push(gap(
          'CAPACITY_EXHAUSTED',
          `岗位 ${candidate.post_id} 复用成员需要 ${increment} 个 activation，余额只剩 ${actsLeft}`,
          NEW_MEMBER_NEXT_STEP,
        ));
        continue;
      }
      actsLeft -= increment;
      assigned.push(postEntry(
        candidate,
        'assigned',
        reuse.member,
        `复用已有成员 ${reuse.member}：只消耗 ${increment} 个 activation，不扣新席位`,
      ));
      usedPosts += 1;
      continue;
    }

    // 新成员：一席 + 一次启动额度。
    if (seatsLeft === null || actsLeft === null) {
      deferred.push(postEntry(
        candidate,
        'deferred',
        null,
        `${seatsLeft === null ? '成员席位' : 'activation'}余额未知，不能盲目新建成员`,
      ));
      gaps.push(gap(
        'CAPACITY_UNKNOWN',
        `岗位 ${candidate.post_id} 需要新建成员，但${seatsLeft === null ? '剩余成员席位' : '剩余 activation'}未知`,
        UNKNOWN_NEXT_STEP,
      ));
      continue;
    }
    if (seatsLeft < 1 || actsLeft < 1) {
      deferred.push(postEntry(
        candidate,
        'deferred',
        null,
        `预算不足：剩余席位 ${seatsLeft}，剩余 activation ${actsLeft}`,
      ));
      gaps.push(gap(
        'CAPACITY_EXHAUSTED',
        `岗位 ${candidate.post_id} 需要新建成员，但剩余席位 ${seatsLeft}、剩余 activation ${actsLeft}`,
        NEW_MEMBER_NEXT_STEP,
      ));
      continue;
    }
    seatsLeft -= 1;
    actsLeft -= 1;
    recommended += 1;
    assigned.push(postEntry(
      candidate,
      'assigned',
      null,
      '预算内可选，需要新建 1 名成员',
    ));
    usedPosts += 1;
  }

  return {
    assigned,
    vacant,
    deferred,
    disabled,
    gaps,
    recommended_members: recommended,
    capacity: {
      known: remainingSeats !== null && remainingActs !== null,
      member_slots_known: remainingSeats !== null,
      activations_known: remainingActs !== null,
      remaining_member_slots: remainingSeats,
      remaining_activations: remainingActs,
      reserved_member_slots: reservedSeats,
      reserved_activations: reservedActs,
      available_member_slots: availableSeats,
      available_activations: availableActs,
    },
  };
}
