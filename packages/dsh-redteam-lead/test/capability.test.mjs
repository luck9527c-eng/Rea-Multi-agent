// 能力匹配：显式注册名 + 清单快照 + 项目绑定 → matched/missing/providers。
// 关键行为：只认完整、区分大小写的工具名；族名/插件 ID/子串/前缀都不算命中。
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCapabilities } from '../src/capability.mjs';

const SHA = 'a'.repeat(64);
const REGISTRY = [
  'pwsh',
  'bash',
  'read',
  'write',
  'glob',
  'grep',
  'job_list',
  'job_output',
  'job_kill',
  'web_fetch',
  'web_search',
  'skill',
];

function provider(overrides = {}) {
  return {
    tool_id: 'ida-local',
    entrypoint_id: 'ida64',
    inventory_revision: 7,
    snapshot_ref: 're/env/ENV-tools-20261029.json',
    snapshot_sha256: SHA,
    transport_tools: ['pwsh'],
    invocation_ref: 're/env/ENV-tools-20261029.json#ida64',
    readiness_ref: 're/env/ENV-tools-20261029.json#checks',
    resource_needs: [],
    ...overrides,
  };
}

function inventory(overrides = {}) {
  return {
    schema_version: 1,
    inventory_revision: 7,
    snapshot_ref: 're/env/ENV-tools-20261029.json',
    tools: [
      { id: 'ida-local', name: 'IDA', entrypoints: [{ id: 'ida64', kind: 'cli' }] },
    ],
    ...overrides,
  };
}

function bindingsFor(families) {
  return { schema_version: 1, revision: 1, registry_sha256: SHA, families };
}

test('fs 由 read+write 共同满足', () => {
  const result = matchCapabilities(['fs'], REGISTRY, null, null);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.matched.map((entry) => entry.capability), ['fs']);
  assert.equal(result.matched[0].via, 'all_capabilities');
  assert.deepEqual(result.providers, []);
});

test('只有 read 时 fs 缺失，且缺口指向组合里没满足的子能力', () => {
  const result = matchCapabilities(['fs'], ['read'], null, null);
  assert.deepEqual(result.matched, []);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].capability, 'fs');
  assert.equal(result.missing[0].code, 'CAPABILITY_MISSING');
  assert.ok(result.missing[0].reason.includes('write'));
  assert.ok(result.missing[0].next_step);
  assert.ok(result.missing[0].missing_capabilities.includes('file-write'));
});

test('族名本身、插件 ID、子串与前缀都不算命中', () => {
  const decoys = [
    'fs',
    'search',
    'jobs',
    'web',
    'file-read',
    'file-write',
    'path-search',
    'text-search',
    '@local/dsh-rea-plugin',
    'read_file',
    'write_file',
    'glob_search',
    'grep_search',
    'job_list_all',
    'web_fetch_v2',
    'pwsh2',
    'bash_like',
    'ida',
    'binary-static',
    'mcp__rea__decompile',
  ];
  for (const need of ['fs', 'search', 'jobs', 'web', 'shell']) {
    const result = matchCapabilities([need], decoys, null, null);
    assert.equal(result.matched.length, 0, `${need} 不应被族名或近似名满足`);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].code, 'CAPABILITY_MISSING');
  }
});

test('工具名区分大小写', () => {
  const upper = matchCapabilities(['fs'], ['Read', 'Write'], null, null);
  assert.equal(upper.matched.length, 0);
  assert.equal(upper.missing[0].code, 'CAPABILITY_MISSING');

  const exact = matchCapabilities(['fs'], ['read', 'write'], null, null);
  assert.equal(exact.matched.length, 1);
});

test('any_tool 族是 OR：pwsh 或 bash 任一即可', () => {
  const bashOnly = matchCapabilities(['shell'], ['bash'], null, null);
  assert.equal(bashOnly.matched.length, 1);
  assert.equal(bashOnly.matched[0].tool, 'bash');

  const missing = matchCapabilities(['shell'], ['sh'], null, null);
  assert.equal(missing.missing[0].capability, 'shell');
  assert.equal(missing.missing[0].code, 'CAPABILITY_MISSING');
});

test('未知能力族返回 UNKNOWN_CAPABILITY', () => {
  const result = matchCapabilities(['no-such-family'], REGISTRY, null, null);
  assert.deepEqual(result.matched, []);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].capability, 'no-such-family');
  assert.equal(result.missing[0].code, 'UNKNOWN_CAPABILITY');
  assert.ok(result.missing[0].next_step.includes('岗位目录'));
});

test('绑定新增的非 mcp 能力族仍视为未知，不因写在 capabilities.json 就放行', () => {
  const bindings = bindingsFor({ 'custom-family': { any_tool: ['read'] } });
  const result = matchCapabilities(['custom-family'], ['read'], null, bindings);
  assert.equal(result.missing[0].code, 'UNKNOWN_CAPABILITY');
});

test('web-recon 组合必须 web、fs、search 全部满足', () => {
  const full = matchCapabilities(['web-recon'], REGISTRY, null, null);
  assert.equal(full.matched.length, 1);
  assert.equal(full.missing.length, 0);

  const noTextSearch = matchCapabilities(
    ['web-recon'],
    REGISTRY.filter((tool) => tool !== 'grep'),
    null,
    null,
  );
  assert.equal(noTextSearch.matched.length, 0);
  assert.equal(noTextSearch.missing[0].capability, 'web-recon');
  assert.ok(noTextSearch.missing[0].missing_capabilities.includes('text-search'));
});

test('mcp:<server> 未绑定即缺口，不能凭工具名猜归属', () => {
  const unbound = matchCapabilities(
    ['mcp:ida'],
    ['mcp__ida__decompile', 'mcp__ida__list'],
    null,
    null,
  );
  assert.equal(unbound.matched.length, 0);
  assert.equal(unbound.missing[0].code, 'CAPABILITY_MISSING');
  assert.ok(unbound.missing[0].reason.includes('未绑定'));
});

test('mcp:<server> 绑定后按精确工具名匹配', () => {
  const bindings = bindingsFor({ 'mcp:ida': { any_tool: ['mcp__ida__decompile'] } });
  const matched = matchCapabilities(['mcp:ida'], ['mcp__ida__decompile'], null, bindings);
  assert.equal(matched.matched.length, 1);
  assert.equal(matched.missing.length, 0);

  const missing = matchCapabilities(['mcp:ida'], ['mcp__ida__list'], null, bindings);
  assert.equal(missing.matched.length, 0);
  assert.equal(missing.missing[0].code, 'CAPABILITY_MISSING');
});

test('binary-static 没有任何默认工具名：存在 REA/MCP 名也不放行', () => {
  const result = matchCapabilities(
    ['binary-static'],
    ['mcp__rea__decompile', 'mcp__rea__list_procedures', 'ida', 'binary-static', 'REA'],
    null,
    null,
  );
  assert.equal(result.matched.length, 0);
  assert.equal(result.missing[0].capability, 'binary-static');
  assert.equal(result.missing[0].code, 'CAPABILITY_MISSING');
});

test('binary-static 可用显式登记的工具名绑定满足', () => {
  const bindings = bindingsFor({ 'binary-static': { any_tool: ['mcp__rea__decompile'] } });
  const result = matchCapabilities(
    ['binary-static'],
    ['mcp__rea__decompile'],
    null,
    bindings,
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.missing.length, 0);
});

test('any_provider 完整登记且清单可核验时匹配，并返回 provider 引用', () => {
  const bindings = bindingsFor({ 'binary-static': { any_provider: [provider()] } });
  const result = matchCapabilities(['binary-static'], ['pwsh'], inventory(), bindings);

  assert.equal(result.missing.length, 0);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].via, 'any_provider');
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].tool_id, 'ida-local');
  assert.equal(result.providers[0].entrypoint_id, 'ida64');
  assert.equal(result.providers[0].inventory_revision, 7);
  assert.equal(result.providers[0].snapshot_sha256, SHA);
  assert.deepEqual(result.providers[0].transport_tools, ['pwsh']);
});

test('any_provider 缺 snapshot_sha256 被拒', () => {
  const incomplete = provider();
  delete incomplete.snapshot_sha256;
  const bindings = bindingsFor({ 'binary-static': { any_provider: [incomplete] } });
  const result = matchCapabilities(['binary-static'], ['pwsh'], inventory(), bindings);

  assert.equal(result.matched.length, 0);
  assert.equal(result.missing[0].code, 'CAPABILITY_MISSING');
  assert.ok(result.missing[0].reason.includes('snapshot_sha256'));
});

test('any_provider 的清单 revision / 工具归属对不上时不算就绪', () => {
  const bindings = bindingsFor({ 'binary-static': { any_provider: [provider()] } });

  const staleRevision = matchCapabilities(
    ['binary-static'],
    ['pwsh'],
    inventory({ inventory_revision: 8 }),
    bindings,
  );
  assert.equal(staleRevision.matched.length, 0);
  assert.equal(staleRevision.missing[0].code, 'CAPABILITY_NOT_READY');

  const unknownTool = matchCapabilities(
    ['binary-static'],
    ['pwsh'],
    inventory({ tools: [{ id: 'ghidra', entrypoints: [{ id: 'ghidra-run' }] }] }),
    bindings,
  );
  assert.equal(unknownTool.matched.length, 0);
  assert.equal(unknownTool.missing[0].code, 'CAPABILITY_NOT_READY');

  const noInventory = matchCapabilities(['binary-static'], ['pwsh'], null, bindings);
  assert.equal(noInventory.matched.length, 0);
  assert.equal(noInventory.missing[0].code, 'CAPABILITY_NOT_READY');
});

test('any_provider 依赖的 transport_tools 必须在执行者注册表中', () => {
  const bindings = bindingsFor({ 'binary-static': { any_provider: [provider()] } });
  const result = matchCapabilities(['binary-static'], ['bash'], inventory(), bindings);
  assert.equal(result.matched.length, 0);
  assert.equal(result.missing[0].code, 'CAPABILITY_MISSING');
  assert.ok(result.missing[0].reason.includes('pwsh'));
});

test('any_provider 支持 OR：第二个 provider 可满足', () => {
  const broken = provider({ tool_id: 'missing-tool' });
  const good = provider({ tool_id: 'ida-local', entrypoint_id: 'ida64' });
  const bindings = bindingsFor({ 'binary-static': { any_provider: [broken, good] } });
  const result = matchCapabilities(['binary-static'], ['pwsh'], inventory(), bindings);
  assert.equal(result.matched.length, 1);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].tool_id, 'ida-local');
});

test('空需求返回空结果；重复需求只算一次', () => {
  assert.deepEqual(matchCapabilities([], REGISTRY, null, null), {
    matched: [],
    missing: [],
    providers: [],
  });
  const duplicated = matchCapabilities(['shell', 'shell'], ['pwsh'], null, null);
  assert.equal(duplicated.matched.length, 1);
});

test('同一能力族同时声明两种组合方式时按非法绑定拒绝', () => {
  const bindings = bindingsFor({
    shell: { any_tool: ['pwsh'], all_capabilities: ['fs'] },
  });
  const result = matchCapabilities(['shell'], ['pwsh'], null, bindings);
  assert.equal(result.matched.length, 0);
  assert.equal(result.missing[0].code, 'INVALID_ARGUMENT');
});

test('绑定里的组合能力成环会被拒绝而不是无限递归', () => {
  const bindings = bindingsFor({
    'mcp:a': { all_capabilities: ['mcp:b'] },
    'mcp:b': { all_capabilities: ['mcp:a'] },
  });
  const result = matchCapabilities(['mcp:a'], REGISTRY, null, bindings);
  assert.ok(result.missing.length >= 1);
  assert.equal(result.missing[0].code, 'INVALID_ARGUMENT');
  assert.ok(result.missing[0].reason.includes('环'));
});
