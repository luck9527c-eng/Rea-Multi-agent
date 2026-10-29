// compatibility：项目 skill 副本的规则/脚本/岗位目录摘要，与 binding 里已存摘要比对。
// 摘要只是内容指纹，**不是**独立可信签名；不一致时必须给出「需要重新做兼容性检查」的信号，
// 不能静默换规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTRACT_VERSION,
  computeDigests,
  readBinding,
  checkCompatibility,
} from '../dist/compatibility.js';

const SKILL_ROOT = '.agents/skills/reverse-project-management';

function makeProject(t, { skill = {}, catalog = { name: 'roster', version: 1 }, extra = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rt4-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    [`${SKILL_ROOT}/SKILL.md`]: '# skill\n\n团队工作按团队规则。\n',
    [`${SKILL_ROOT}/references/team-coordination.md`]: '# 团队协作\n',
    [`${SKILL_ROOT}/references/layout.md`]: '# 布局\n',
    [`${SKILL_ROOT}/scripts/project.py`]: 'print("project")\n',
    [`${SKILL_ROOT}/scripts/governance.py`]: 'print("governance")\n',
    [`${SKILL_ROOT}/scripts/__pycache__/project.cpython-312.pyc`]: 'binary junk',
    'docs/agents/reverse-project-management.md': '# repo config\n',
    ...skill,
    ...extra,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  const catalogPath = path.join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
  return { root, catalogPath, write: (relative, content) => {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  } };
}

const SHA256 = /^[0-9a-f]{64}$/u;

test('三个摘要都是 64 位小写 sha256，且 contract_version=1', async (t) => {
  const { root, catalogPath } = makeProject(t);
  const digests = await computeDigests({ projectRoot: root, catalogPath });
  assert.match(digests.ruleDigest, SHA256);
  assert.match(digests.scriptDigest, SHA256);
  assert.match(digests.catalogDigest, SHA256);
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(digests.gaps, []);
  // 规则摘要覆盖 SKILL.md + references/*.md，不覆盖 scripts/
  assert.deepEqual(
    digests.files.rule.map((entry) => entry.path).sort(),
    ['SKILL.md', 'references/layout.md', 'references/team-coordination.md'],
  );
  // 脚本摘要覆盖 scripts/**，但排除 __pycache__
  assert.deepEqual(
    digests.files.script.map((entry) => entry.path).sort(),
    ['scripts/governance.py', 'scripts/project.py'],
  );
});

test('摘要随 SKILL.md / project.py / 岗位目录内容变化', async (t) => {
  const project = makeProject(t);
  const before = await computeDigests({ projectRoot: project.root, catalogPath: project.catalogPath });

  project.write(`${SKILL_ROOT}/SKILL.md`, '# skill v2\n');
  const afterRule = await computeDigests({ projectRoot: project.root, catalogPath: project.catalogPath });
  assert.notEqual(afterRule.ruleDigest, before.ruleDigest, 'SKILL.md 变化必须改变规则摘要');
  assert.equal(afterRule.scriptDigest, before.scriptDigest, '规则变化不影响脚本摘要');

  project.write(`${SKILL_ROOT}/scripts/project.py`, 'print("project v2")\n');
  const afterScript = await computeDigests({ projectRoot: project.root, catalogPath: project.catalogPath });
  assert.notEqual(afterScript.scriptDigest, afterRule.scriptDigest);
  assert.equal(afterScript.ruleDigest, afterRule.ruleDigest);

  writeFileSync(project.catalogPath, JSON.stringify({ name: 'roster', version: 2 }), 'utf8');
  const afterCatalog = await computeDigests({ projectRoot: project.root, catalogPath: project.catalogPath });
  assert.notEqual(afterCatalog.catalogDigest, afterScript.catalogDigest);
});

test('摘要对文件枚举顺序不敏感：同样的内容得到同样的摘要', async (t) => {
  const first = makeProject(t);
  const second = makeProject(t);
  // 在 second 里重写 references 文件（内容相同、写入顺序不同）
  second.write(`${SKILL_ROOT}/references/layout.md`, '# 布局\n');
  const a = await computeDigests({ projectRoot: first.root, catalogPath: first.catalogPath });
  const b = await computeDigests({ projectRoot: second.root, catalogPath: second.catalogPath });
  assert.equal(a.ruleDigest, b.ruleDigest);
  assert.equal(a.scriptDigest, b.scriptDigest);
  assert.equal(a.catalogDigest, b.catalogDigest);
});

test('没有 skill 副本时给出 null 摘要与明确 gap，不抛', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rt4-compat-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const digests = await computeDigests({ projectRoot: root });
  assert.equal(digests.ruleDigest, null);
  assert.equal(digests.scriptDigest, null);
  assert.ok(digests.gaps.some((gap) => gap.code === 'SKILL_COPY_MISSING'));
});

test('readBinding：缺失与坏 JSON 都不崩', async (t) => {
  const { root } = makeProject(t);
  const missing = await readBinding(root);
  assert.equal(missing.present, false);
  assert.equal(missing.binding, null);

  const broken = makeProject(t, { extra: { 're/team/binding.json': '{ not json' } });
  const parsed = await readBinding(broken.root);
  assert.equal(parsed.present, false);
  assert.match(parsed.reason, /JSON/u);
});

test('binding 摘要一致 → 不需要复查；不一致 → REBIND_REQUIRED 且列出差异', async (t) => {
  const { root, catalogPath } = makeProject(t);
  const digests = await computeDigests({ projectRoot: root, catalogPath });

  const matching = await checkCompatibility({
    projectRoot: root,
    catalogPath,
    binding: {
      schema_version: 1,
      adapter: { contract_version: 1 },
      rule_digest: digests.ruleDigest,
      script_digest: digests.scriptDigest,
      catalog_digest: digests.catalogDigest,
    },
  });
  assert.equal(matching.needsReview, false);
  assert.equal(matching.signal, 'BINDING_MATCH');
  assert.deepEqual(matching.differences, []);
  assert.equal(matching.contract_version, 1);

  const stale = await checkCompatibility({
    projectRoot: root,
    catalogPath,
    binding: {
      schema_version: 1,
      ruleDigest: 'a'.repeat(64),
      scriptDigest: digests.scriptDigest,
      catalogDigest: digests.catalogDigest,
    },
  });
  assert.equal(stale.needsReview, true);
  assert.equal(stale.signal, 'REBIND_REQUIRED');
  assert.deepEqual(stale.differences.map((entry) => entry.key), ['ruleDigest']);
  assert.match(stale.nextStep, /兼容性|复查|重做/u);
  assert.equal(stale.binding.matched, false);
});

test('没有 binding 时给出 BINDING_MISSING（首次 bind 前的正常状态）', async (t) => {
  const { root, catalogPath } = makeProject(t);
  const result = await checkCompatibility({ projectRoot: root, catalogPath });
  assert.equal(result.needsReview, true);
  assert.equal(result.signal, 'BINDING_MISSING');
  assert.equal(result.binding.present, false);
});
