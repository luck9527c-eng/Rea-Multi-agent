// 静态契约校验：零依赖地元校验 rt-tools.schema.json，并检查岗位目录不变量与包内副本漂移。
// 这些都是「数据源是否自洽」的断言，不依赖 ajv，也不启动任何宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { defaultCatalog, validateCatalog } from '../src/catalog.mjs';

const schemaUrl = new URL('../../../docs/specs/rt-tools.schema.json', import.meta.url);
const catalogUrl = new URL('../../../docs/specs/roster-catalog.json', import.meta.url);
const contractUrl = new URL('../../../docs/specs/orchestration-contract.md', import.meta.url);
const packageCatalogUrl = new URL('../src/catalog.data.json', import.meta.url);

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const readText = (url) => readFileSync(url, 'utf8');

const schema = readJson(schemaUrl);
const catalog = readJson(catalogUrl);
const contract = readText(contractUrl);

/** 深度遍历 JSON Schema，对每个节点调用 visitor(node, jsonPointer)。 */
function walkSchema(node, visitor, pointer = '#') {
  visitor(node, pointer);
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, visitor, `${pointer}/${index}`));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'enum' || key === 'required' || key === 'type') continue;
    walkSchema(value, visitor, `${pointer}/${key}`);
  }
}

/** 取一个 `##` 章节的正文（到下一个 `##` 为止）。 */
function section(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  assert.notEqual(start, -1, `契约缺少章节：${title}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** 从 Markdown 表格里按列取值；`column` 从 0 开始。 */
function tableColumn(markdown, column) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length > column)
    .map((cells) => cells[column]);
}

test('schema 的 $defs 齐备，且所有 $ref 都能解析', () => {
  const expected = [
    'text', 'id', 'sha256', 'path', 'root', 'routeId', 'runId', 'dispatchId', 'attemptId',
    'strings', 'kinds', 'date', 'routeStatus', 'outcome', 'errorCode', 'anchorKind',
    'resource', 'anchorRef', 'rosterInput', 'retryOf', 'dispatchInput', 'review',
    'concludeInput', 'request', 'diagnostic', 'failureData', 'result', 'post',
    'rosterData', 'dispatchData', 'concludeData', 'response',
  ];
  assert.ok(schema.$defs && typeof schema.$defs === 'object');
  for (const name of expected) {
    assert.ok(Object.hasOwn(schema.$defs, name), `$defs 缺少 ${name}`);
  }
  const defined = new Set(Object.keys(schema.$defs));
  walkSchema(schema, (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.$ref !== 'string') return;
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
    assert.ok(match, `非法 $ref：${node.$ref}`);
    assert.ok(defined.has(match[1]), `$ref 指向不存在的定义：${node.$ref}`);
  });
  assert.equal(schema.$ref, '#/$defs/request');
  assert.equal(schema.$defs.request.required.includes('tool'), true);
  assert.equal(schema.$defs.response.required.includes('output'), true);
});

test('每个封闭对象都声明了全部 required 属性，且 object 类型确实封闭', () => {
  walkSchema(schema, (node, pointer) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const type = Array.isArray(node.type) ? node.type : [node.type];
    if (type.includes('object') && node.properties) {
      assert.equal(
        node.additionalProperties,
        false,
        `${pointer} 是对象且有 properties，必须 additionalProperties:false`,
      );
    }
    if (node.additionalProperties === false) {
      assert.ok(node.properties && typeof node.properties === 'object', `${pointer} 封闭却没有 properties`);
      for (const name of node.required ?? []) {
        assert.ok(
          Object.hasOwn(node.properties, name),
          `${pointer} 的 required.${name} 不在 properties 中`,
        );
      }
    }
  });
});

test('errorCode 枚举与契约「稳定错误码」表逐项一致', () => {
  const table = section(contract, '稳定错误码');
  const codes = tableColumn(table, 1)
    .flatMap((cell) => cell.split('、'))
    .map((code) => code.trim())
    .filter((code) => /^[A-Z][A-Z0-9_]+$/.test(code));
  assert.ok(codes.length > 0, '未能从契约表解析错误码');
  assert.deepEqual([...schema.$defs.errorCode.enum].sort(), [...new Set(codes)].sort());
});

test('anchorKind 枚举与契约锚点表一致', () => {
  const table = section(contract, '锚点与封存绑定');
  const kinds = tableColumn(table, 0).filter((cell) => /^[a-z][a-z0-9_]+$/.test(cell) && cell !== 'kind');
  assert.ok(kinds.length > 0, '未能从契约表解析锚点类型');
  assert.deepEqual([...schema.$defs.anchorKind.enum].sort(), [...new Set(kinds)].sort());
});

test('outcome 枚举与契约结果分类表一致', () => {
  const table = section(contract, '交付、开始和结果分类');
  const outcomes = tableColumn(table, 0).filter((cell) => /^[a-z][a-z0-9_]+$/.test(cell) && cell !== 'outcome');
  assert.ok(outcomes.length > 0);
  assert.deepEqual([...schema.$defs.outcome.enum].sort(), [...new Set(outcomes)].sort());
});

test('result.status 枚举与契约「通用返回」一致', () => {
  const common = section(contract, '版本、角色与通用返回');
  const match = /status=(ok\|blocked\|partial\|error)/.exec(common);
  assert.ok(match, '契约未声明 status 取值');
  assert.deepEqual(
    [...schema.$defs.result.properties.status.enum].sort(),
    match[1].split('|').sort(),
  );
});

test('岗位状态至少覆盖契约要求的 assigned/vacant/deferred/disabled', () => {
  const states = new Set(schema.$defs.post.properties.state.enum);
  for (const required of ['assigned', 'vacant', 'deferred', 'disabled']) {
    assert.ok(states.has(required), `岗位状态缺少 ${required}`);
  }
  const allowed = new Set(['ready', 'assigned', 'vacant', 'deferred', 'disabled']);
  for (const state of states) assert.ok(allowed.has(state), `未知岗位状态 ${state}`);
  assert.deepEqual([...schema.$defs.kinds.items.enum], ['binary', 'game', 'webapp']);
});

test('岗位目录不变量：ID 唯一、模板引用存在且不含 disabled', () => {
  assert.equal(catalog.schema_version, 1);
  const ids = catalog.posts.map((post) => post.id);
  assert.equal(new Set(ids).size, ids.length, '岗位 ID 必须唯一');
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9_-]{0,95}$/);

  const byId = new Map(catalog.posts.map((post) => [post.id, post]));
  for (const templateId of ['binary', 'game', 'webapp']) {
    const list = catalog.templates[templateId];
    assert.ok(Array.isArray(list) && list.length > 0, `模板 ${templateId} 不能为空`);
    assert.equal(new Set(list).size, list.length, `模板 ${templateId} 不得重复岗位`);
    for (const postId of list) {
      const post = byId.get(postId);
      assert.ok(post, `模板 ${templateId} 引用不存在的岗位 ${postId}`);
      assert.notEqual(post.enabled, false, `模板 ${templateId} 含 disabled 岗位 ${postId}`);
    }
  }
  assert.equal(catalog.templates.mixed.composition, 'union_by_post_id');
  assert.ok(catalog.templates.mixed.min_target_kinds >= 2);
});

test('岗位目录不变量：能力族恰一种组合方式、别名精确、组合无环', () => {
  const capabilities = catalog.capabilities;
  for (const [name, definition] of Object.entries(capabilities)) {
    const combinators = ['any_tool', 'any_provider', 'all_capabilities'].filter(
      (key) => definition[key] !== undefined,
    );
    assert.equal(combinators.length, 1, `能力族 ${name} 必须且只能声明一种组合方式`);
    assert.equal(typeof definition.binding_required, 'boolean', `能力族 ${name} 缺 binding_required`);
    if (combinators[0] === 'any_tool') {
      assert.ok(Array.isArray(definition.any_tool));
      for (const alias of definition.any_tool) {
        assert.ok(alias.length > 0);
        assert.ok(!/[*?[\]{}|\\]/.test(alias), `能力族 ${name} 的别名 ${alias} 含通配/模式语法`);
      }
      if (definition.any_tool.length === 0) {
        assert.equal(definition.binding_required, true, `空别名的能力族 ${name} 必须要求显式绑定`);
      }
    }
    if (combinators[0] === 'all_capabilities') {
      assert.ok(definition.all_capabilities.length > 0);
      for (const child of definition.all_capabilities) {
        assert.ok(Object.hasOwn(capabilities, child), `能力族 ${name} 引用不存在的子能力 ${child}`);
      }
    }
  }

  // 无环：DFS 的递归栈上再次遇到同名能力即为环。
  const visiting = new Set();
  const done = new Set();
  const visit = (name) => {
    assert.ok(!visiting.has(name), `能力组合存在环：${name}`);
    if (done.has(name)) return;
    visiting.add(name);
    for (const child of capabilities[name]?.all_capabilities ?? []) visit(child);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of Object.keys(capabilities)) visit(name);
});

test('岗位目录不变量：required 族可解析、enabled 缺省 true、预留与按需单列', () => {
  const capabilities = new Set(Object.keys(catalog.capabilities));
  const posts = new Map(catalog.posts.map((post) => [post.id, post]));
  const templateIds = new Set(
    ['binary', 'game', 'webapp'].flatMap((templateId) => catalog.templates[templateId]),
  );

  for (const post of catalog.posts) {
    if (post.enabled === false) {
      assert.ok(typeof post.disabled_reason === 'string' && post.disabled_reason.length > 0);
    } else {
      assert.equal(post.enabled ?? true, true);
    }
    for (const capability of [...post.required, ...(post.optional ?? [])]) {
      assert.ok(capabilities.has(capability), `岗位 ${post.id} 的 required/optional 引用了未知能力族 ${capability}`);
    }
    assert.equal(Number.isFinite(post.priority), true, `岗位 ${post.id} 缺 priority`);
  }

  for (const listName of ['on_demand_posts', 'reserved_posts']) {
    const list = catalog[listName];
    assert.ok(Array.isArray(list));
    assert.equal(new Set(list).size, list.length, `${listName} 不得重复`);
    for (const postId of list) {
      assert.ok(posts.has(postId), `${listName} 引用不存在的岗位 ${postId}`);
      assert.ok(!templateIds.has(postId), `${listName} 的 ${postId} 不得进入模板`);
    }
  }
  for (const postId of catalog.on_demand_posts) {
    assert.ok(!catalog.reserved_posts.includes(postId), `${postId} 不能同时按需与预留`);
  }
  // web-attack 必须显式 disabled 且只作为预留岗，不参与可用岗位计数。
  const webAttack = posts.get('web-attack');
  assert.equal(webAttack.enabled, false);
  assert.ok(webAttack.disabled_reason);
  assert.deepEqual(catalog.reserved_posts, ['web-attack']);
  assert.deepEqual(catalog.on_demand_posts, ['environment']);

  // 每个已启用岗位都必须有归属，避免出现造出来但永不被模板使用的岗位。
  for (const post of catalog.posts) {
    if (post.enabled === false) continue;
    if (catalog.on_demand_posts.includes(post.id) || catalog.reserved_posts.includes(post.id)) continue;
    assert.ok(templateIds.has(post.id), `已启用岗位 ${post.id} 不属于任何模板`);
  }

  // 默认预算与契约「最多六岗、一席失败替换预留、两个 activation」一致。
  assert.equal(catalog.defaults.max_posts, 6);
  assert.equal(catalog.defaults.reserved_member_slots, 1);
  assert.equal(catalog.defaults.reserved_activations, 2);
});

test('包内目录副本与 docs/specs/roster-catalog.json 字节一致（漂移即失败）', () => {
  const docsBytes = readFileSync(catalogUrl);
  const copyBytes = readFileSync(packageCatalogUrl);
  assert.equal(Buffer.compare(docsBytes, copyBytes), 0, 'src/catalog.data.json 与数据源字节不一致');
  assert.deepEqual(JSON.parse(copyBytes.toString('utf8')), catalog);
});

test('defaultCatalog() 读取的是同一份目录且通过全部不变量', () => {
  const loaded = defaultCatalog();
  assert.equal(loaded.catalog_version, catalog.catalog_version);
  assert.deepEqual(loaded.posts.map((post) => post.id), catalog.posts.map((post) => post.id));
  assert.deepEqual(loaded.templates.binary, catalog.templates.binary);
  assert.deepEqual(loaded.templates.game, catalog.templates.game);
  assert.deepEqual(loaded.templates.webapp, catalog.templates.webapp);
  assert.deepEqual(loaded.reserved_posts, catalog.reserved_posts);
  assert.deepEqual(loaded.on_demand_posts, catalog.on_demand_posts);
  assert.equal(validateCatalog(loaded).ok, true);
});
