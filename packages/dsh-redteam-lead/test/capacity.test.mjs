// 岗位计划：纯函数 planPosts（原「席位/activation 预算裁剪」，T23 起不做任何容量规划）。
//
// 关键行为：按 priority 稳定排序、`max_posts` 上限、能力缺口 → vacant、disabled 单列、
// **没有**「余额不足」这一类判定（宿主上限读不到，也不猜）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planPosts } from '../dist/capacity.js';
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

function plan(overrides = {}) {
  return planPosts({ candidates: [], maxPosts: 6, ...overrides });
}

test('超出 max_posts 的岗位标 deferred，按 priority 稳定裁剪', () => {
  const result = plan({ candidates: [post('c', 30), post('a', 10), post('b', 20)], maxPosts: 2 });

  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['c']);
  assert.ok(result.deferred[0].reason.includes('max_posts=2'));
  assert.equal(result.gaps[0].code, 'CAPACITY_EXHAUSTED');
});

test('同 priority 按 post_id 排序', () => {
  const result = plan({ candidates: [post('z', 10), post('a', 10), post('m', 10)], maxPosts: 2 });
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'm']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['z']);
});

test('没有余额概念：没有任何 remaining/reserved 输入，也不产生它的判定', () => {
  const result = plan({ candidates: [post('a', 10), post('b', 20), post('c', 30)], maxPosts: 6 });
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b', 'c']);
  assert.deepEqual(result.deferred, []);
  for (const entry of result.assigned) {
    assert.equal(Object.hasOwn(entry, 'capacity'), false, '岗位条目里没有余额字段');
  }
  assert.equal(Object.hasOwn(result, 'capacity'), false, '计划里没有余额投影');
  assert.equal(Object.hasOwn(result, 'recommended_members'), false, '计划不再给「建议几人」');
});

test('非法 maxPosts 与非数字按默认 6 处理（不猜余额，只兜底上限）', () => {
  const result = plan({
    candidates: [post('a', 10), post('b', 20)],
    maxPosts: 'many',
  });
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b']);
  const negative = plan({ candidates: [post('a', 10), post('b', 20)], maxPosts: -3 });
  assert.deepEqual(negative.assigned, []);
  assert.equal(negative.deferred.length, 2);
});

test('已运行岗位保留为 assigned 且计入 max_posts', () => {
  const result = plan({
    candidates: [
      post('a', 10),
      post('b', 20, { running: true, member: 'rt-b' }),
      post('c', 30),
    ],
    maxPosts: 2,
  });
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['a', 'b']);
  assert.equal(result.assigned[1].state, 'assigned');
  assert.equal(result.assigned[1].member, 'rt-b');
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['c']);
});

test('已运行岗位不因 max_posts 为 0 被取消', () => {
  const result = plan({
    candidates: [post('a', 20, { running: true, member: 'rt-a' }), post('b', 10)],
    maxPosts: 0,
  });
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
  const result = plan({
    candidates: [
      post('vacant-tools', 10, { capability: capabilityMissing }),
      post('vacant-unknown', 15, { capability: unknownFamily }),
      post('fits', 20),
      post('over-limit', 30),
      post('disabled-post', 40, { enabled: false }),
    ],
    maxPosts: 1,
  });

  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['fits']);
  assert.deepEqual(result.vacant.map((entry) => entry.post_id), ['vacant-tools', 'vacant-unknown']);
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['over-limit']);
  assert.deepEqual(result.disabled.map((entry) => entry.post_id), ['disabled-post']);

  const codes = result.gaps.map((gap) => gap.code);
  assert.ok(codes.includes('CAPABILITY_MISSING'));
  assert.ok(codes.includes('UNKNOWN_CAPABILITY'));
  assert.ok(codes.includes('CAPACITY_EXHAUSTED'));
  assert.ok(codes.includes('POST_DISABLED'));
  assert.equal(codes.includes('CAPACITY_UNKNOWN'), false, 'T23：容量未知不再是缺口');
  for (const gap of result.gaps) {
    assert.ok(gap.reason && gap.next_step, '缺口必须带原因与下一步');
  }
});

test('返回的岗位条目符合 posts 契约的字段形状', () => {
  const result = plan({ candidates: [post('a', 10)], maxPosts: 1 });
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
  const result = plan({ candidates: [post('a', 10), post('a', 20)], maxPosts: 2 });
  assert.equal(result.assigned.length, 1);
  assert.equal(result.gaps.filter((gap) => gap.code === 'INVALID_ARGUMENT').length, 1);
});

test('没有候选岗位时返回空计划而不是默认建岗', () => {
  const result = plan({ candidates: [] });
  assert.deepEqual(result.assigned, []);
  assert.deepEqual(result.vacant, []);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.disabled, []);
  assert.deepEqual(result.gaps, []);
});

test('A06 场景：mixed 并集、缺工具、max_posts 只够两岗时稳定裁剪且保留专岗缺口', () => {
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

  const result = planPosts({ candidates, maxPosts: 2 });

  // 两岗：priority 10 的 cross-check 与 20 的 triage 先保留。
  assert.deepEqual(result.assigned.map((entry) => entry.post_id), ['cross-check', 'triage']);
  // 覆盖缺口：web-recon / web-api 缺 web，binary-static / binary-dynamic 缺专有 provider。
  assert.deepEqual(
    result.vacant.map((entry) => entry.post_id),
    ['web-recon', 'binary-static', 'binary-dynamic', 'web-api'],
  );
  // 工具满足但被 max_posts 裁掉的两岗。
  assert.deepEqual(result.deferred.map((entry) => entry.post_id), ['web-bundle', 'protocol']);
  // 每个候选岗位都恰好出现在一个状态桶里，既没被静默丢弃，也没被造出来。
  const all = [...result.assigned, ...result.vacant, ...result.deferred, ...result.disabled];
  assert.equal(all.length, composed.posts.length);
  assert.deepEqual(new Set(all.map((entry) => entry.post_id)), new Set(composed.posts.map((entry) => entry.id)));
});
