// 席位/activation 预算裁剪：纯函数 planBudget。
// 关键行为：两余额交集、预留生效、复用只扣 activation、未知余额不猜、按 priority 稳定裁剪。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planBudget } from '../dist/capacity.js';
import { composeTemplate } from '../dist/catalog.js';
import { matchCapabilities } from '../dist/capability.js';

function post(id, priority, extra = {}) {
  return {
    post_id: id,
    priority,
    required: ['fs'],
    optional: [],
    anchors_required: ['artifact_locator'],
    ...extra,
  };
}

function budgets(overrides = {}) {
  return {
    candidates: [],
    remainingMemberSlots: 8,
    remainingActivations: 8,
    maxPosts: 6,
    reservedMemberSlots: 1,
    reservedActivations: 2,
    reuseCandidates: [],
    ...overrides,
  };
}

test('不同席位余额按 priority 稳定裁剪，超出预算的标 deferred', () => {
  const result = planBudget(budgets({
    candidates: [post('c', 30), post('a', 10), post('b', 20)],
    remainingMemberSlots: 2,
    remainingActivations: 2,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));

  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['c']);
  assert.equal(result.recommended_members, 2);
  assert.equal(result.capacity.available_member_slots, 2);
  assert.equal(result.capacity.available_activations, 2);
  assert.ok(result.deferred[0].reason);
});

test('同 priority 按 post_id 排序', () => {
  const result = planBudget(budgets({
    candidates: [post('z', 10), post('a', 10), post('m', 10)],
    remainingMemberSlots: 2,
    remainingActivations: 2,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'm']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['z']);
});

test('可新增成员数受两个余额的交集限制', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10), post('b', 20), post('c', 30)],
    remainingMemberSlots: 3,
    remainingActivations: 1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a']);
  assert.equal(result.recommended_members, 1);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['b', 'c']);
  assert.equal(result.deferred[0].reason.includes('activation'), true);
});

test('reserved 预留从余额里扣除，负预算按 0', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10), post('b', 20)],
    remainingMemberSlots: 3,
    remainingActivations: 3,
    reservedMemberSlots: 1,
    reservedActivations: 2,
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a']);
  assert.equal(result.capacity.available_member_slots, 2);
  assert.equal(result.capacity.available_activations, 1);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['b']);

  const negative = planBudget(budgets({
    candidates: [post('a', 10)],
    remainingMemberSlots: -5,
    remainingActivations: -1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  assert.equal(negative.assigned.length, 0);
  assert.equal(negative.capacity.available_member_slots, 0);
  assert.equal(negative.capacity.available_activations, 0);
  assert.equal(negative.gaps[0].code, 'CAPACITY_EXHAUSTED');
});

test('余额未知时返回 CAPACITY_UNKNOWN，且不新建成员', () => {
  for (const unknown of [
    { remainingMemberSlots: null },
    { remainingActivations: null },
  ]) {
    const result = planBudget(budgets({
      candidates: [post('a', 10)],
      reservedMemberSlots: 0,
      reservedActivations: 0,
      ...unknown,
    }));
    assert.equal(result.assigned.length, 0);
    assert.equal(result.recommended_members, 0);
    assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['a']);
    assert.equal(result.gaps[0].code, 'CAPACITY_UNKNOWN');
    assert.equal(result.capacity.known, false);
    assert.ok(result.gaps[0].next_step.includes('re/team/capacity.json'));
  }
});

test('历史失败成员占满席位（remaining=0）时不再新建', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10)],
    remainingMemberSlots: 0,
    remainingActivations: 5,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  assert.equal(result.assigned.length, 0);
  assert.equal(result.recommended_members, 0);
  assert.equal(result.gaps[0].code, 'CAPACITY_EXHAUSTED');
});

test('复用成员不扣新席位、只扣 activation，且不计入 recommended_members', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10), post('b', 20)],
    remainingMemberSlots: 0,
    remainingActivations: 2,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    reuseCandidates: [
      { post_id: 'a', member: 'rt-a', activation_increment: 1 },
      { post_id: 'b', member: 'rt-b', activation_increment: 2 },
    ],
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a']);
  assert.equal(result.assigned[0].member, 'rt-a');
  assert.equal(result.assigned[0].state, 'assigned');
  assert.equal(result.recommended_members, 0);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['b']);
  assert.equal(result.deferred[0].reason.includes('activation'), true);
});

test('复用成员的 activation 增量未知 → deferred + CAPACITY_UNKNOWN', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10)],
    remainingMemberSlots: 0,
    remainingActivations: 3,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    reuseCandidates: [{ post_id: 'a', member: 'rt-a' }],
  }));
  assert.equal(result.assigned.length, 0);
  assert.equal(result.deferred.length, 1);
  assert.equal(result.gaps[0].code, 'CAPACITY_UNKNOWN');
});

test('席位余额未知但有已验证增量的复用成员时，仍可只靠 activation 复用', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10)],
    remainingMemberSlots: null,
    remainingActivations: 1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    reuseCandidates: [{ post_id: 'a', member: 'rt-a', activation_increment: 1 }],
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a']);
  assert.equal(result.assigned[0].member, 'rt-a');
  assert.equal(result.recommended_members, 0);
  assert.equal(result.capacity.known, false);
});

test('已运行岗位保留为 assigned 且计入 max_posts', () => {
  const result = planBudget(budgets({
    candidates: [
      post('a', 10),
      post('b', 20, { running: true, member: 'rt-b' }),
      post('c', 30),
    ],
    remainingMemberSlots: 5,
    remainingActivations: 5,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    maxPosts: 2,
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b']);
  assert.equal(result.assigned[1].state, 'assigned');
  assert.equal(result.assigned[1].member, 'rt-b');
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['c']);
});

test('已运行岗位不因预算为 0 被取消', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 20, { running: true, member: 'rt-a' }), post('b', 10)],
    remainingMemberSlots: 0,
    remainingActivations: 0,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    maxPosts: 0,
  }));
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['b']);
});

test('vacant / deferred / disabled 三类分开返回，缺口码可区分', () => {
  const capabilityMissing = {
    satisfied: false,
    missing: [{
      capability: 'fs',
      code: 'CAPABILITY_MISSING',
      reason: '能力族 fs 需要 read、write',
      next_step: '补齐缺失工具',
    }],
  };
  const unknownFamily = {
    satisfied: false,
    missing: [{
      capability: 'no-such-family',
      code: 'UNKNOWN_CAPABILITY',
      reason: '未知能力族',
      next_step: '修正目录',
    }],
  };
  const result = planBudget(budgets({
    candidates: [
      post('vacant-tools', 10, { capability: capabilityMissing }),
      post('vacant-unknown', 15, { capability: unknownFamily }),
      post('fits', 20),
      post('over-budget', 30),
      post('disabled-post', 40, { enabled: false }),
    ],
    remainingMemberSlots: 1,
    remainingActivations: 1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    maxPosts: 2,
  }));

  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['fits']);
  assert.deepEqual(result.vacant.map((entry) => entry.post_id), ['vacant-tools', 'vacant-unknown']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['over-budget']);
  assert.deepEqual(result.disabled.map((entry) => entry.post_id), ['disabled-post']);

  const codes = result.gaps.map((gap) => gap.code);
  assert.ok(codes.includes('CAPABILITY_MISSING'));
  assert.ok(codes.includes('UNKNOWN_CAPABILITY'));
  assert.ok(codes.includes('CAPACITY_EXHAUSTED'));
  assert.ok(codes.includes('POST_DISABLED'));
  for (const gap of result.gaps) {
    assert.ok(gap.reason && gap.next_step, '缺口必须带原因与下一步');
  }
});

test('返回的岗位条目符合 posts 契约的字段形状', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10)],
    remainingMemberSlots: 1,
    remainingActivations: 1,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  const entry = result.assigned[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    'anchors_required',
    'member',
    'optional',
    'post_id',
    'reason',
    'required',
    'state',
  ]);
  assert.equal(entry.state, 'assigned');
  assert.equal(entry.member, null);
  assert.ok(entry.reason.length > 0);
  assert.deepEqual(entry.required, ['fs']);
});

test('重复岗位 ID 只处理一次并报 INVALID_ARGUMENT', () => {
  const result = planBudget(budgets({
    candidates: [post('a', 10), post('a', 20)],
    remainingMemberSlots: 2,
    remainingActivations: 2,
    reservedMemberSlots: 0,
    reservedActivations: 0,
  }));
  assert.equal(result.assigned.length, 1);
  assert.equal(result.gaps.filter((gap) => gap.code === 'INVALID_ARGUMENT').length, 1);
});

test('没有候选岗位时返回空计划而不是默认建岗', () => {
  const result = planBudget(budgets({ candidates: [] }));
  assert.deepEqual(result.assigned, []);
  assert.deepEqual(result.vacant, []);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.disabled, []);
  assert.equal(result.recommended_members, 0);
});

test('A06 场景：mixed 并集、缺工具、预算只够两岗时稳定裁剪且保留专岗缺口', () => {
  const composed = composeTemplate('mixed', ['game', 'webapp']);
  assert.equal(composed.ok, true);
  // 执行者只有通用 shell/fs/search 工具；jobs 与 web 不可用。
  const toolNames = ['read', 'write', 'glob', 'grep', 'pwsh', 'bash'];
  const candidates = composed.posts.map((post) => {
    const match = matchCapabilities(post.required, toolNames, null, null);
    return {
      ...post,
      capability: { satisfied: match.missing.length === 0, missing: match.missing },
    };
  });

  const result = planBudget({
    candidates,
    remainingMemberSlots: 2,
    remainingActivations: 2,
    reservedMemberSlots: 0,
    reservedActivations: 0,
    maxPosts: 6,
  });

  // 预算两岗：priority 10 的 cross-check 与 20 的 triage 先保留。
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['cross-check', 'triage']);
  assert.equal(result.recommended_members, 2);
  // 覆盖缺口：web-recon / web-api 缺 web，binary-dynamic 缺 jobs 与动态 provider。
  assert.deepEqual(
    result.vacant.map((entry) => entry.post_id),
    ['web-recon', 'binary-static', 'binary-dynamic', 'web-api'],
  );
  // 工具满足但被预算裁掉的两岗。
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['web-bundle', 'protocol']);
  // 每个候选岗位都恰好出现在一个状态桶里，既没被静默丢弃，也没被造出来。
  const all = [...result.assigned, ...result.vacant, ...result.deferred, ...result.disabled];
  assert.equal(all.length, composed.posts.length);
  assert.deepEqual(new Set(all.map((entry) => entry.post_id)), new Set(composed.posts.map((entry) => entry.id)));
});
