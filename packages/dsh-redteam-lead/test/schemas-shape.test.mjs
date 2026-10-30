// `tools.schemas(agent)` 的返回值 → 工具名集合（T15）。
//
// 宿主真实形状（`_dsh-tools.js` 的 `schemas(scope)`）：
//
//   return [...view(scope).visible.values()].map((definition) => this.schemaOf(definition, true))
//
// 也就是**schema 对象数组**，名字在元素的 `.name` 上。旧实现把它当「按名字为键的对象」，
// 于是 `Object.keys()` 只拿到 `["0","1",…]`；真会话里每个能力族都判缺失，任何派发都被
// `CAPABILITY_MISSING` 拒（L3 证据 s3-rt_dispatch.txt）。这里钉住取值契约本身：
// 数组（主路径）、`{function:{name}}` 变体、按名字为键的旧形状、任意可迭代，以及「认不出来
// 就退化成空集、不抛」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolNamesFromSchemas } from '../dist/capability.js';

/** 宿主 `schemaOf()` 投影出的一条 schema（`{name, description, parameters}`）。 */
function schema(name) {
  return { name, description: `${name} 的描述`, parameters: { type: 'object', properties: {} } };
}

const REAL_SESSION_TOOLS = ['pwsh', 'read', 'write', 'glob', 'grep', 'job_list', 'web_search'];

test('数组形状（宿主真实形状）：取每个元素的 .name', () => {
  const names = toolNamesFromSchemas(REAL_SESSION_TOOLS.map(schema));
  assert.deepEqual(names, [...REAL_SESSION_TOOLS].sort());
});

test('数组形状：绝不把数组下标当工具名', () => {
  const names = toolNamesFromSchemas(REAL_SESSION_TOOLS.map(schema));
  for (const index of ['0', '1', '2', '3', '4', '5', '6']) {
    assert.equal(names.includes(index), false, `工具名里不得出现数组下标 ${JSON.stringify(index)}`);
  }
  assert.equal(names.some((name) => /^\d+$/u.test(name)), false, '工具名不得是纯数字下标');
});

test('数组里的 {function:{name}} 变体也取得到名字（以 .name 为准）', () => {
  const names = toolNamesFromSchemas([
    { function: { name: 'pwsh', parameters: {} } },
    { name: 'read', function: { name: 'legacy-read' } },
  ]);
  assert.deepEqual(names, ['pwsh', 'read']);
});

test('按名字为键的旧形状（测试替身/老宿主）仍然支持', () => {
  // 优先级：对象自身带字符串 `name` → 当作单条 schema（见下面「单条 schema 对象」用例）；
  // 否则按名字为键解释。
  const names = toolNamesFromSchemas({ grep: { type: 'object' }, glob: {} });
  assert.deepEqual(names, ['glob', 'grep']);
});

test('任意可迭代对象：退化成逐项取 .name', () => {
  const names = toolNamesFromSchemas(new Set([schema('write'), schema('read')]));
  assert.deepEqual(names, ['read', 'write']);
});

test('单条 schema 对象（`schemaOf()` 的投影本身）→ 只取它自己的名字，不把字段名当工具名', () => {
  assert.deepEqual(toolNamesFromSchemas(schema('pwsh')), ['pwsh']);
});

test('认不出来的形状 → 空集（保持「未核对」降级，不抛）', () => {
  const cases = [null, undefined, 42, true, 'pwsh', [], [null, 7, {}, ['pwsh']], {}];
  for (const value of cases) {
    assert.deepEqual(toolNamesFromSchemas(value), [], `形状 ${JSON.stringify(value) ?? 'undefined'} 必须退化成空集`);
  }
});

test('名字去重且排序稳定（键序无关）', () => {
  assert.deepEqual(toolNamesFromSchemas([schema('b'), schema('a'), schema('b')]), ['a', 'b']);
  assert.deepEqual(toolNamesFromSchemas({ b: {}, a: {} }), ['a', 'b']);
});
