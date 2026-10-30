// 岗位目录：加载校验与模板组合的行为测试。
// 断言的是「目录数据 → 候选岗位集合」的对外行为，不碰内部实现结构。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeTemplate,
  defaultCatalog,
  validateCatalog,
} from '../dist/catalog.js';

/** 把目录深拷贝一份，供「篡改后应被拒绝」的用例使用。 */
function cloneCatalog() {
  return structuredClone(defaultCatalog());
}

test('四个模板都给出非空候选岗位', () => {
  const cases = [
    ['binary', ['binary']],
    ['game', ['game']],
    ['webapp', ['webapp']],
    ['mixed', ['game', 'webapp']],
  ];
  for (const [templateId, targetKinds] of cases) {
    const result = composeTemplate(templateId, targetKinds);
    assert.equal(result.ok, true, `${templateId} 应可组合`);
    assert.ok(result.posts.length > 0, `${templateId} 候选岗位不应为空`);
    assert.equal(result.template_id, templateId);
  }
});

test('模板不含 disabled 岗位，web-attack 只出现在 reserved_posts', () => {
  for (const [templateId, targetKinds] of [
    ['binary', ['binary']],
    ['game', ['game']],
    ['webapp', ['webapp']],
    ['mixed', ['game', 'webapp']],
  ]) {
    const result = composeTemplate(templateId, targetKinds);
    assert.equal(result.ok, true);
    for (const post of result.posts) {
      assert.notEqual(post.enabled, false, `${templateId} 不应包含 disabled 岗 ${post.id}`);
      assert.notEqual(post.id, 'web-attack');
    }
    assert.deepEqual(
      result.reserved_posts.map((post) => post.id),
      ['web-attack'],
      '预留岗必须单列',
    );
    assert.equal(result.reserved_posts[0].enabled, false);
    assert.ok(result.reserved_posts[0].disabled_reason);
  }
});

test('game 模板是五岗，预留岗不参与可用岗位计数', () => {
  const result = composeTemplate('game', ['game']);
  assert.deepEqual(
    result.posts.map((post) => post.id),
    ['triage', 'binary-static', 'binary-dynamic', 'protocol', 'cross-check'],
  );
  // 目录里共 10 个岗位，其中 1 个 disabled 预留、1 个按需；可用候选只有模板里的 5 个。
  assert.equal(defaultCatalog().posts.length, 10);
  assert.equal(result.posts.length, 5);
});

test('mixed 给 game+webapp 得到按 post_id 去重的并集，各自专岗都在', () => {
  const game = composeTemplate('game', ['game']).posts.map((post) => post.id);
  const webapp = composeTemplate('webapp', ['webapp']).posts.map((post) => post.id);
  const mixed = composeTemplate('mixed', ['game', 'webapp']);

  assert.equal(mixed.ok, true);
  const ids = mixed.posts.map((post) => post.id);
  assert.equal(new Set(ids).size, ids.length, 'post_id 不得重复');
  assert.equal(ids.length, new Set([...game, ...webapp]).size, '并集不得少岗');
  assert.ok(ids.includes('protocol'), 'game 专岗必须在');
  assert.ok(ids.includes('web-api'), 'webapp 专岗必须在');
  assert.equal(ids.filter((id) => id === 'cross-check').length, 1, '共岗只出现一次');
  assert.deepEqual(new Set(ids), new Set([...game, ...webapp]));
});

test('mixed 组合是确定的：重复调用得到同一顺序', () => {
  const a = composeTemplate('mixed', ['webapp', 'game']);
  const b = composeTemplate('mixed', ['webapp', 'game']);
  assert.deepEqual(a.posts.map((p) => p.id), b.posts.map((p) => p.id));
});

test('mixed 只给 1 个 target_kind 或重复 kind 都被拒绝', () => {
  for (const kinds of [[], ['game'], ['game', 'game']]) {
    const result = composeTemplate('mixed', kinds);
    assert.equal(result.ok, false, `kinds=${JSON.stringify(kinds)} 应被拒绝`);
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.ok(result.reason && result.next_step, '拒绝必须带原因与下一步');
    assert.deepEqual(result.posts, []);
  }
});

test('mixed 拒绝未知或非法的 target_kind', () => {
  const result = composeTemplate('mixed', ['game', 'mobile']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('未知模板被拒绝', () => {
  const result = composeTemplate('nope', []);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('具体模板与调用者声明的 target_kinds 不一致时被拒绝', () => {
  const result = composeTemplate('binary', ['webapp']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
});

test('on_demand 岗位不因默认模板自动入模板', () => {
  const result = composeTemplate('binary', ['binary']);
  assert.equal(result.ok, true);
  assert.ok(!result.posts.some((post) => post.id === 'environment'));
  assert.deepEqual(result.on_demand_posts.map((post) => post.id), ['environment']);
});

test('enabled 缺省为 true；只有 web-attack 显式 disabled 并带原因', () => {
  const catalog = defaultCatalog();
  const disabled = catalog.posts.filter((post) => post.enabled === false);
  assert.deepEqual(disabled.map((post) => post.id), ['web-attack']);
  assert.ok(disabled[0].disabled_reason);
  for (const post of catalog.posts) {
    if (post.id !== 'web-attack') assert.equal(post.enabled, true);
  }
});

test('合法目录通过校验', () => {
  const result = validateCatalog(defaultCatalog());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('目录不变量被逐条校验（篡改即失败）', () => {
  const mutations = [
    ['重复岗位 ID', (catalog) => {
      catalog.posts.push({ ...catalog.posts[0] });
    }],
    ['模板引用不存在的岗位', (catalog) => {
      catalog.templates.binary.push('no-such-post');
    }],
    ['模板含 disabled 岗位', (catalog) => {
      catalog.templates.binary.push('web-attack');
    }],
    ['required 能力族不可解析', (catalog) => {
      catalog.posts[0].required.push('no-such-family');
    }],
    ['能力组合有环', (catalog) => {
      catalog.capabilities.cycleA = { all_capabilities: ['cycleB'], binding_required: false };
      catalog.capabilities.cycleB = { all_capabilities: ['cycleA'], binding_required: false };
    }],
    ['精确别名含通配符', (catalog) => {
      catalog.capabilities.shell.any_tool.push('pw*');
    }],
    ['同一能力族声明两种组合方式', (catalog) => {
      catalog.capabilities.shell.all_capabilities = ['fs'];
    }],
    ['能力族没有任何组合方式', (catalog) => {
      catalog.capabilities.shell = { binding_required: false };
    }],
    ['预留岗同时进了模板', (catalog) => {
      catalog.templates.game.push('web-attack');
    }],
    ['on_demand 岗位与预留岗位重叠', (catalog) => {
      catalog.on_demand_posts.push('web-attack');
    }],
  ];

  for (const [label, mutate] of mutations) {
    const catalog = cloneCatalog();
    mutate(catalog);
    const result = validateCatalog(catalog);
    assert.equal(result.ok, false, `${label} 应被拒绝`);
    assert.ok(result.errors.length > 0, `${label} 应给出错误`);
    assert.equal(result.errors[0].code, 'INVALID_ARGUMENT');
    assert.ok(result.errors[0].detail, `${label} 错误需带说明`);
  }
});
