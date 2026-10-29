// 岗位目录：加载、静态校验与模板组合。
//
// 数据源只有 `src/catalog.data.json`（`docs/specs/roster-catalog.json` 的字节级副本，
// 漂移由 test/schema-static.test.mjs 断言）。本模块不读宿主、不写磁盘，决策函数可离线调用。
import { readFileSync } from 'node:fs';

/** 合法目标类别；与 rt-tools.schema.json 的 `$defs.kinds` 一致。 */
export const TARGET_KINDS = Object.freeze(['binary', 'game', 'webapp']);
/** 具体模板 ID；mixed 是组合规则，不是岗位列表。 */
export const CONCRETE_TEMPLATES = Object.freeze(['binary', 'game', 'webapp']);

const POST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
// 精确工具名不允许任何通配或模式语法；族名/插件 ID 不参与匹配由 capability.mjs 保证。
const NON_EXACT_PATTERN = /[*?[\]{}|\\]/;
const COMBINATORS = ['any_tool', 'any_provider', 'all_capabilities'];
const PROVIDER_REQUIRED = [
  'tool_id',
  'entrypoint_id',
  'inventory_revision',
  'snapshot_ref',
  'snapshot_sha256',
  'transport_tools',
  'invocation_ref',
  'readiness_ref',
  'resource_needs',
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizePost(raw) {
  const enabled = raw.enabled !== false;
  return {
    id: raw.id,
    display_name: raw.display_name,
    priority: raw.priority,
    focus: raw.focus,
    enabled,
    disabled_reason: enabled ? null : (raw.disabled_reason ?? null),
    required: [...(raw.required ?? [])],
    optional: [...(raw.optional ?? [])],
    anchors_required: [...(raw.anchors_required ?? [])],
    prohibited: [...(raw.prohibited ?? [])],
  };
}

/**
 * 规范化并冻结一份目录。调用者应只通过本函数取得目录，避免拿到可变数据源。
 * @param {object} raw 已解析的目录 JSON
 */
export function normalizeCatalog(raw) {
  const templates = raw.templates ?? {};
  return deepFreeze({
    schema_version: raw.schema_version,
    catalog_version: raw.catalog_version,
    defaults: { ...(raw.defaults ?? {}) },
    capabilities: Object.fromEntries(
      Object.entries(raw.capabilities ?? {}).map(([name, definition]) => [
        name,
        {
          binding_required: definition?.binding_required === true,
          ...(definition?.any_tool === undefined ? {} : { any_tool: [...definition.any_tool] }),
          ...(definition?.any_provider === undefined
            ? {}
            : { any_provider: structuredClone(definition.any_provider) }),
          ...(definition?.all_capabilities === undefined
            ? {}
            : { all_capabilities: [...definition.all_capabilities] }),
          ...(definition?.source_ref === undefined ? {} : { source_ref: definition.source_ref }),
          ...(definition?.readiness_ref === undefined
            ? {}
            : { readiness_ref: definition.readiness_ref }),
        },
      ]),
    ),
    posts: (raw.posts ?? []).map(normalizePost),
    templates: {
      binary: [...(templates.binary ?? [])],
      game: [...(templates.game ?? [])],
      webapp: [...(templates.webapp ?? [])],
      mixed: templates.mixed === undefined
        ? undefined
        : {
            composition: templates.mixed.composition,
            min_target_kinds: templates.mixed.min_target_kinds,
          },
    },
    on_demand_posts: [...(raw.on_demand_posts ?? [])],
    reserved_posts: [...(raw.reserved_posts ?? [])],
    capability_defaults_source: raw.capability_defaults_source === undefined
      ? null
      : structuredClone(raw.capability_defaults_source),
  });
}

/** 包内自带副本。每次调用都重新读取，避免模块级可变缓存。 */
export function defaultCatalog() {
  const text = readFileSync(new URL('./catalog.data.json', import.meta.url), 'utf8');
  return loadCatalog(JSON.parse(text));
}

/**
 * 校验并加载目录。目录是数据源而不是用户输入，坏了属于包缺陷，因此抛错而不是返回信封。
 * @param {object} source 已解析对象
 */
export function loadCatalog(source) {
  const result = validateCatalog(source);
  if (!result.ok) {
    const error = new Error(`岗位目录不合法：${result.errors.map((item) => item.detail).join('；')}`);
    error.code = 'INVALID_ARGUMENT';
    error.errors = result.errors;
    throw error;
  }
  return normalizeCatalog(source);
}

/**
 * 对目录做全部静态不变量校验。纯函数：不修改入参，返回错误清单而不是抛异常。
 * @param {object} catalog
 * @returns {{ok: boolean, errors: Array<{code: string, invariant: string, detail: string}>}}
 */
export function validateCatalog(catalog) {
  const errors = [];
  const fail = (invariant, detail) => errors.push({ code: 'INVALID_ARGUMENT', invariant, detail });

  if (!catalog || typeof catalog !== 'object') {
    fail('catalog.shape', '目录必须是对象');
    return { ok: false, errors };
  }
  if (catalog.schema_version !== 1) fail('catalog.schema_version', 'schema_version 必须为 1');
  if (!Number.isInteger(catalog.catalog_version) || catalog.catalog_version < 1) {
    fail('catalog.catalog_version', 'catalog_version 必须是正整数');
  }

  const defaults = catalog.defaults;
  if (!defaults || typeof defaults !== 'object') {
    fail('catalog.defaults', 'defaults 必须存在');
  } else {
    for (const key of [
      'max_posts',
      'reserved_member_slots',
      'reserved_activations',
      'timebox_ms',
      'delivery_timeout_ms',
      'wait_timeout_ms',
    ]) {
      if (!Number.isInteger(defaults[key]) || defaults[key] < 0) {
        fail('catalog.defaults', `defaults.${key} 必须是非负整数`);
      }
    }
    if (Number.isInteger(defaults.max_posts) && defaults.max_posts < 1) {
      fail('catalog.defaults', 'defaults.max_posts 至少为 1');
    }
  }

  const capabilities = catalog.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    fail('catalog.capabilities', 'capabilities 必须是对象');
    return { ok: false, errors };
  }
  if (Object.keys(capabilities).length === 0) fail('catalog.capabilities', 'capabilities 不能为空');

  for (const [name, definition] of Object.entries(capabilities)) {
    if (!definition || typeof definition !== 'object') {
      fail('capability.shape', `能力族 ${name} 必须是对象`);
      continue;
    }
    if (typeof definition.binding_required !== 'boolean') {
      fail('capability.binding_required', `能力族 ${name} 必须显式声明 binding_required 布尔值`);
    }
    const present = COMBINATORS.filter((key) => definition[key] !== undefined);
    if (present.length !== 1) {
      fail(
        'capability.combinator',
        `能力族 ${name} 必须且只能声明 any_tool/any_provider/all_capabilities 之一，实际：${present.join(',') || '无'}`,
      );
      continue;
    }
    const combinator = present[0];
    const value = definition[combinator];
    if (combinator === 'any_tool') {
      if (!isStringArray(value)) {
        fail('capability.any_tool', `能力族 ${name} 的 any_tool 必须是精确工具名数组`);
        continue;
      }
      if (new Set(value).size !== value.length) {
        fail('capability.any_tool', `能力族 ${name} 的 any_tool 不得重复`);
      }
      for (const alias of value) {
        if (NON_EXACT_PATTERN.test(alias) || alias !== alias.trim()) {
          fail(
            'capability.exact_alias',
            `能力族 ${name} 的别名 "${alias}" 不是精确工具名（不允许通配符/模式语法）`,
          );
        }
      }
      if (value.length === 0 && definition.binding_required !== true) {
        fail(
          'capability.any_tool',
          `能力族 ${name} 没有任何默认工具名，必须声明 binding_required: true（否则永不可满足）`,
        );
      }
    } else if (combinator === 'all_capabilities') {
      if (!isStringArray(value) || value.length === 0) {
        fail('capability.all_capabilities', `能力族 ${name} 的 all_capabilities 必须是非空能力名数组`);
        continue;
      }
      for (const child of value) {
        if (!Object.hasOwn(capabilities, child)) {
          fail('capability.all_capabilities', `能力族 ${name} 引用了不存在的子能力 ${child}`);
        }
      }
    } else {
      if (!Array.isArray(value) || value.length === 0) {
        fail('capability.any_provider', `能力族 ${name} 的 any_provider 必须是非空 provider 数组`);
        continue;
      }
      for (const provider of value) {
        if (!provider || typeof provider !== 'object') {
          fail('capability.any_provider', `能力族 ${name} 的 provider 必须是对象`);
          continue;
        }
        for (const field of PROVIDER_REQUIRED) {
          if (provider[field] === undefined) {
            fail('capability.any_provider', `能力族 ${name} 的 provider 缺少字段 ${field}`);
          }
        }
        if (provider.transport_tools !== undefined && !isStringArray(provider.transport_tools)) {
          fail('capability.any_provider', `能力族 ${name} 的 provider.transport_tools 必须是字符串数组`);
        }
        if (provider.transport_tools !== undefined
          && Array.isArray(provider.transport_tools)
          && provider.transport_tools.length === 0) {
          fail('capability.any_provider', `能力族 ${name} 的 provider.transport_tools 不能为空`);
        }
        if (provider.snapshot_sha256 !== undefined
          && !/^[0-9a-f]{64}$/.test(String(provider.snapshot_sha256))) {
          fail('capability.any_provider', `能力族 ${name} 的 provider.snapshot_sha256 必须是 sha256`);
        }
      }
    }
  }

  // 组合能力不得成环：只在 all_capabilities 边上做 DFS。
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      fail('capability.acyclic', `能力组合存在环：${[...trail, name].join(' → ')}`);
      return;
    }
    state.set(name, 'visiting');
    const definition = capabilities[name];
    if (definition && Array.isArray(definition.all_capabilities)) {
      for (const child of definition.all_capabilities) {
        if (Object.hasOwn(capabilities, child)) visit(child, [...trail, name]);
      }
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(capabilities)) visit(name, []);

  const posts = catalog.posts;
  if (!Array.isArray(posts) || posts.length === 0) {
    fail('catalog.posts', 'posts 必须是非空数组');
    return { ok: false, errors };
  }
  const postsById = new Map();
  const seenIds = new Set();
  for (const post of posts) {
    if (!post || typeof post !== 'object') {
      fail('post.shape', '岗位必须是对象');
      continue;
    }
    if (typeof post.id !== 'string' || !POST_ID_PATTERN.test(post.id)) {
      fail('post.id', `岗位 ID "${post.id}" 不符合 ^[a-z0-9][a-z0-9_-]{0,95}$`);
      continue;
    }
    if (seenIds.has(post.id)) fail('post.id.unique', `岗位 ID 重复：${post.id}`);
    seenIds.add(post.id);
    postsById.set(post.id, post);
    if (!isNonEmptyString(post.display_name)) fail('post.display_name', `岗位 ${post.id} 缺 display_name`);
    if (!Number.isFinite(post.priority)) fail('post.priority', `岗位 ${post.id} 的 priority 必须是数字`);
    if (post.enabled !== undefined && typeof post.enabled !== 'boolean') {
      fail('post.enabled', `岗位 ${post.id} 的 enabled 必须是布尔值`);
    }
    if (post.enabled === false && !isNonEmptyString(post.disabled_reason)) {
      fail('post.enabled', `岗位 ${post.id} 是 disabled，必须给出 disabled_reason`);
    }
    for (const field of ['required', 'optional', 'anchors_required', 'prohibited']) {
      if (!Array.isArray(post[field])) {
        fail('post.fields', `岗位 ${post.id} 的 ${field} 必须是数组`);
      } else if (!post[field].every((item) => typeof item === 'string')) {
        fail('post.fields', `岗位 ${post.id} 的 ${field} 必须是字符串数组`);
      }
    }
    const capabilitiesUsed = [...(post.required ?? []), ...(post.optional ?? [])];
    if (new Set(capabilitiesUsed).size !== capabilitiesUsed.length) {
      fail('post.capability.unique', `岗位 ${post.id} 的 required/optional 能力不得重复`);
    }
    for (const capability of capabilitiesUsed) {
      if (!Object.hasOwn(capabilities, capability)) {
        fail('post.capability.resolvable', `岗位 ${post.id} 引用了不存在的能力族 ${capability}`);
      }
    }
  }

  const templates = catalog.templates;
  if (!templates || typeof templates !== 'object') {
    fail('catalog.templates', 'templates 必须存在');
    return { ok: false, errors };
  }
  const templatePostIds = new Set();
  for (const templateId of CONCRETE_TEMPLATES) {
    const list = templates[templateId];
    if (!Array.isArray(list) || list.length === 0) {
      fail('template.shape', `模板 ${templateId} 必须是非空岗位 ID 数组`);
      continue;
    }
    if (new Set(list).size !== list.length) fail('template.unique', `模板 ${templateId} 不得重复岗位`);
    for (const postId of list) {
      templatePostIds.add(postId);
      const post = postsById.get(postId);
      if (!post) {
        fail('template.reference', `模板 ${templateId} 引用了不存在的岗位 ${postId}`);
        continue;
      }
      if (post.enabled === false) {
        fail('template.enabled', `模板 ${templateId} 不得包含 disabled 岗位 ${postId}`);
      }
    }
  }
  if (!templates.mixed || typeof templates.mixed !== 'object') {
    fail('template.mixed', 'mixed 模板必须存在');
  } else {
    if (templates.mixed.composition !== 'union_by_post_id') {
      fail('template.mixed', 'mixed.composition 必须是 union_by_post_id');
    }
    if (!Number.isInteger(templates.mixed.min_target_kinds) || templates.mixed.min_target_kinds < 2) {
      fail('template.mixed', 'mixed.min_target_kinds 必须是 >=2 的整数');
    }
  }

  const onDemand = catalog.on_demand_posts;
  const reserved = catalog.reserved_posts;
  for (const [label, list] of [['on_demand_posts', onDemand], ['reserved_posts', reserved]]) {
    if (!isStringArray(list)) {
      fail('catalog.post_lists', `${label} 必须是岗位 ID 数组`);
      continue;
    }
    if (new Set(list).size !== list.length) fail('catalog.post_lists', `${label} 不得重复`);
    for (const postId of list) {
      const post = postsById.get(postId);
      if (!post) fail('catalog.post_lists', `${label} 引用了不存在的岗位 ${postId}`);
      if (templatePostIds.has(postId)) {
        fail('catalog.post_lists', `${label} 中的 ${postId} 不得出现在模板里`);
      }
    }
  }
  if (isStringArray(onDemand) && isStringArray(reserved)) {
    for (const postId of onDemand) {
      if (reserved.includes(postId)) {
        fail('catalog.post_lists', `${postId} 不能同时是 on_demand 与 reserved`);
      }
    }
  }

  // 没有归属的已启用岗位会让目录出现「造出来但永不使用」的岗位，视为漂移。
  for (const post of postsById.values()) {
    if (post.enabled === false) continue;
    if ((onDemand ?? []).includes(post.id) || (reserved ?? []).includes(post.id)) continue;
    if (!templatePostIds.has(post.id)) {
      fail('post.orphan', `已启用岗位 ${post.id} 不属于任何模板也不在按需/预留清单`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function invalid(reason, nextStep) {
  return {
    ok: false,
    code: 'INVALID_ARGUMENT',
    reason,
    next_step: nextStep,
    posts: [],
    reserved_posts: [],
    on_demand_posts: [],
    available_post_count: 0,
  };
}

function clonePost(post) {
  return {
    id: post.id,
    display_name: post.display_name,
    priority: post.priority,
    focus: post.focus,
    enabled: post.enabled,
    disabled_reason: post.disabled_reason,
    required: [...post.required],
    optional: [...post.optional],
    anchors_required: [...post.anchors_required],
    prohibited: [...post.prohibited],
  };
}

/**
 * 组合模板，返回候选岗位集合（不造岗、不去重之外的任何补充）。
 *
 * - 具体模板：`binary | game | webapp`；若调用者给了 target_kinds，必须与模板一致。
 * - mixed：至少两个**不同** target_kinds，取各自模板岗位的并集，按 post_id 去重。
 * - on_demand_posts 不自动入模板；reserved_posts 单列且不计入可用岗位数。
 *
 * @param {string} templateId
 * @param {string[]} [targetKinds]
 * @param {object} [catalog] 已加载/未加载的目录；默认读包内副本
 */
export function composeTemplate(templateId, targetKinds = [], catalog = defaultCatalog()) {
  const validated = validateCatalog(catalog);
  if (!validated.ok) {
    return {
      ...invalid('岗位目录不合法，拒绝组合模板', '先修正岗位目录并重跑漂移测试'),
      errors: validated.errors,
    };
  }
  const normalized = Object.isFrozen(catalog) ? catalog : normalizeCatalog(catalog);
  const kinds = Array.isArray(targetKinds) ? [...targetKinds] : null;
  if (kinds === null) {
    return invalid('target_kinds 必须是数组', '传入 binary/game/webapp 的子集');
  }
  if (new Set(kinds).size !== kinds.length) {
    return invalid('target_kinds 不得重复', '每个目标类别只声明一次');
  }
  for (const kind of kinds) {
    if (!TARGET_KINDS.includes(kind)) {
      return invalid(
        `未知 target_kind：${String(kind)}`,
        `target_kinds 只能取 ${TARGET_KINDS.join(' / ')}`,
      );
    }
  }

  const templates = normalized.templates;
  const mixed = templates.mixed;
  let templatePostIds;

  if (templateId === 'mixed') {
    const minimum = mixed?.min_target_kinds ?? 2;
    if (kinds.length < minimum) {
      return invalid(
        `mixed 模板需要至少 ${minimum} 个不同的 target_kinds，实际 ${kinds.length} 个`,
        '同时给出两个以上目标类别，或改用具体模板',
      );
    }
    templatePostIds = [];
    const seen = new Set();
    for (const kind of kinds) {
      for (const postId of templates[kind]) {
        if (seen.has(postId)) continue;
        seen.add(postId);
        templatePostIds.push(postId);
      }
    }
  } else if (CONCRETE_TEMPLATES.includes(templateId)) {
    if (kinds.length > 0 && !kinds.includes(templateId)) {
      return invalid(
        `模板 ${templateId} 与 target_kinds（${kinds.join(',')}）不一致`,
        '按 target_kinds 选择对应模板；多类别用 mixed',
      );
    }
    templatePostIds = [...templates[templateId]];
  } else {
    return invalid(
      `未知模板：${String(templateId)}`,
      `template 只能取 ${[...CONCRETE_TEMPLATES, 'mixed'].join(' / ')}`,
    );
  }

  const postsById = new Map(normalized.posts.map((post) => [post.id, post]));
  const posts = [];
  for (const postId of templatePostIds) {
    const post = postsById.get(postId);
    // validateCatalog 已保证引用存在；这里保留防御，避免静默造岗或漏岗。
    if (!post) {
      return invalid(`模板 ${templateId} 引用了不存在的岗位 ${postId}`, '修正岗位目录后重试');
    }
    posts.push(clonePost(post));
  }

  return {
    ok: true,
    template_id: templateId,
    target_kinds: kinds,
    posts,
    reserved_posts: normalized.reserved_posts.map((postId) => clonePost(postsById.get(postId))),
    on_demand_posts: normalized.on_demand_posts.map((postId) => clonePost(postsById.get(postId))),
    available_post_count: posts.length,
  };
}

/** 按 ID 取岗位（含 disabled / on_demand / reserved），目录缺该 ID 时返回 null。 */
export function findPost(postId, catalog = defaultCatalog()) {
  const normalized = Object.isFrozen(catalog) ? catalog : normalizeCatalog(catalog);
  const post = normalized.posts.find((item) => item.id === postId);
  return post ? clonePost(post) : null;
}
