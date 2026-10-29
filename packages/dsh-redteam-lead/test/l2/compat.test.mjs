/**
 * L2 · 兼容性检查（A05 / A36）。
 *
 * 用**真实 skill 副本字节**跑插件自己的兼容性接缝（`dist/project-adapter.js` probe 与
 * `dist/compatibility.js` 摘要/比对）：
 * - 完整副本无缺口，摘要与独立复算一致；
 * - 旧副本缺团队规则 → blocking 缺口，且不覆盖副本/INDEX/历史（D8）；
 * - 缺 Python → blocking 缺口，点名解释器；
 * - 克隆到新根 → 摘要不变（内容指纹与路径无关），改规则/脚本后要求重新做兼容检查（A36）；
 * - probe 是只读检查，不落盘。
 *
 * 非默认布局：真实 CLI 会以具体错误拒绝，但 `probe()` 目前**不**给布局缺口 —— 这是
 * T8 报告的实现缺陷；这里既断言"不会假称可用"的可观察行为，也用 skip 记录未满足的 A05 要求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, readJson, writeJson, sha256, sha256File, SKILL_COPY_RELATIVE, expectCode,
} from './helpers.mjs'
import { createProjectAdapter } from '../../dist/project-adapter.js'
import { checkCompatibility, computeDigests } from '../../dist/compatibility.js'

const RUN = 'RUN-20261001T000000Z-r001-01'

/** 独立复算摘要：`path<TAB>sha256` 行按路径排序拼接后再 sha256（与实现同规格，独立实现）。 */
async function independentDigest(skillRoot, subdirectories) {
  const rows = []
  async function walk(relative) {
    const absolute = path.join(skillRoot, ...relative.split('/'))
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name === '.git') continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) rows.push({ path: child, sha256: sha256File(path.join(skillRoot, ...child.split('/'))) })
    }
  }
  for (const subdirectory of subdirectories) {
    if (existsSync(path.join(skillRoot, ...subdirectory.split('/')))) await walk(subdirectory)
  }
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256(Buffer.from(rows.map((row) => `${row.path}\t${row.sha256}\n`).join(''), 'utf8'))
}

/** 独立复算规则摘要：`SKILL.md` + `references/*.md` + `assets/*.md`，同规格。 */
async function independentRuleDigest(skillRoot) {
  const rows = [{ path: 'SKILL.md', sha256: sha256File(path.join(skillRoot, 'SKILL.md')) }]
  for (const directory of ['references', 'assets']) {
    for (const name of await readdir(path.join(skillRoot, directory))) {
      if (!name.toLowerCase().endsWith('.md')) continue
      const relative = `${directory}/${name}`
      rows.push({ path: relative, sha256: sha256File(path.join(skillRoot, ...relative.split('/'))) })
    }
  }
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256(Buffer.from(rows.map((row) => `${row.path}\t${row.sha256}\n`).join(''), 'utf8'))
}

/** 整棵树的 `相对路径 → sha256` 快照（判断只读检查有没有写盘）。 */
async function snapshotTree(root) {
  const snapshot = new Map()
  async function walk(relative) {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'))
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) snapshot.set(child, sha256File(path.join(root, ...child.split('/'))))
    }
  }
  await walk('')
  return snapshot
}

/** 把临时项目整棵复制到新根（模拟"克隆到另一个根/会话"）。 */
async function cloneProject(root) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-rt-l2-clone-'))
  const clone = path.join(parent, 'project')
  await cp(root, clone, { recursive: true })
  return { clone, dispose: () => rm(parent, { recursive: true, force: true }) }
}

/** 一个已初始化的最小项目（含一次已完成 RUN，使记录真实可读）。 */
async function project(root) {
  const target = await writeTargets(root)
  await writeRun(root, { id: 'RUN-20261001T000000Z-r001-01', target, provenance: {} })
  await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
  await writeProject(root)
  // init 之后又写了记录，先刷新 INDEX 作为基线。
  assert.equal(index(root).code, 0, 'index 应成功')
  return target
}

test('完整副本：probe 无缺口，团队规则在场，脚本摘要与独立复算一致（A05）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await project(root)
    const adapter = createProjectAdapter({ projectRoot: root })

    const before = await snapshotTree(root)
    const probe = await adapter.probe()
    const after = await snapshotTree(root)
    assert.deepEqual([...after.keys()], [...before.keys()], 'probe 不新增文件')
    for (const [file, digest] of before) assert.equal(after.get(file), digest, `probe 不改写 ${file}`)

    assert.equal(probe.ok, true)
    assert.deepEqual(probe.gaps, [], '完整副本不应有缺口')
    const compatibility = probe.compatibility
    assert.equal(compatibility.indexPresent, true)
    assert.equal(compatibility.configPresent, true)
    assert.equal(compatibility.skillCopyPresent, true)
    assert.equal(compatibility.hasTeamRules, true, '权威副本带 references/team-coordination.md')
    assert.equal(compatibility.hasToolInventoryRules, true)
    assert.equal(compatibility.pythonOk, true)
    assert.equal(compatibility.versions.schemaVersion, 1)
    assert.equal(
      compatibility.versions.projectPy,
      path.join(root, ...SKILL_COPY_RELATIVE.split('/'), 'scripts', 'project.py'),
      '脚本路径必须落在项目副本内（不用全局路径）',
    )
    assert.match(String(compatibility.versions.python), /^\d+\.\d+\.\d+$/u)
    assert.ok(['path', 'project-config', 'explicit'].includes(compatibility.versions.pythonSource))

    const skillRoot = path.join(root, ...SKILL_COPY_RELATIVE.split('/'))
    assert.equal(compatibility.scriptDigest, await independentDigest(skillRoot, ['scripts']))
    assert.equal(compatibility.ruleDigest, await independentRuleDigest(skillRoot))
    assert.equal(compatibility.catalogDigest, (await computeDigests({ projectRoot: root })).catalogDigest)
  })
})

test('旧副本缺团队规则：blocking 缺口 + 具体下一步，且不覆盖副本/INDEX/历史（A05 / D8）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  // dropTeamRules 复刻"从 HEAD 初始化的真实项目副本"：脚本相同、Markdown 规则缺团队段。
  await withProject(t, async ({ root }) => {
    await project(root)
    const skillRoot = path.join(root, ...SKILL_COPY_RELATIVE.split('/'))
    const indexPath = path.join(root, 'INDEX.md')
    const indexBefore = sha256File(indexPath)
    const routeBefore = sha256File(path.join(root, 're', 'routes', 'R-001.json'))
    assert.equal(existsSync(path.join(skillRoot, 'references', 'team-coordination.md')), false)

    const adapter = createProjectAdapter({ projectRoot: root })
    const probe = await adapter.probe()
    assert.equal(probe.ok, false, 'blocking 缺口存在时 probe 必须报 not ok')
    const teamGap = probe.gaps.find((gap) => gap.code === 'TEAM_RULES_MISSING')
    assert.ok(teamGap, '必须报 TEAM_RULES_MISSING')
    assert.equal(teamGap.blocking, true)
    assert.match(teamGap.detail, /references[\\/]team-coordination\.md/u)
    assert.match(teamGap.nextStep, /不要用全局副本覆盖/u, '下一步不得建议覆盖项目副本（D8）')
    assert.equal(probe.compatibility.hasTeamRules, false)

    const toolGap = probe.gaps.find((gap) => gap.code === 'TOOL_INVENTORY_RULES_MISSING')
    assert.ok(toolGap, '工具清单规则缺失也必须报缺口')
    assert.equal(toolGap.blocking, false, '工具清单规则缺失不阻塞（D11）')

    // 不静默修复：副本仍然缺规则文件，INDEX 与正式记录字节不变。
    assert.equal(existsSync(path.join(skillRoot, 'references', 'team-coordination.md')), false)
    assert.equal(sha256File(indexPath), indexBefore, '不覆盖 INDEX')
    assert.equal(sha256File(path.join(root, 're', 'routes', 'R-001.json')), routeBefore, '不覆盖历史')
  }, { dropTeamRules: true, dropToolInventoryRules: true })
})

test('缺 Python：PYTHON_MISSING（blocking）点名解释器，check 明确失败而不是假装成功（A05）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await project(root)
    const missing = path.join(root, 'no-such-python.exe')
    const adapter = createProjectAdapter({ projectRoot: root, python: missing })

    const probe = await adapter.probe()
    assert.equal(probe.ok, false, '缺解释器是 blocking 缺口')
    const gap = probe.gaps.find((item) => item.code === 'PYTHON_MISSING')
    assert.ok(gap, '必须报 PYTHON_MISSING')
    assert.equal(gap.blocking, true)
    assert.match(gap.detail, /no-such-python\.exe/u, '诊断必须点名实际使用的解释器')
    assert.equal(probe.compatibility.pythonOk, false)
    assert.equal(probe.compatibility.versions.pythonSource, 'explicit')

    const checked = await adapter.check({ hashes: true })
    assert.equal(checked.ok, false, '没有可用解释器时 check 不得返回成功')
    assert.notEqual(checked.exitCode, 0)
  })
})

test('非默认布局：真实 CLI 以具体错误拒绝，插件不会假称项目可用（A05）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await project(root)
    // 把正式记录目录从 re/ 挪到 records/（skill 只支持 re/，属于非默认布局）。
    await rename(path.join(root, 're'), path.join(root, 'records'))

    const adapter = createProjectAdapter({ projectRoot: root })
    const probe = await adapter.probe()
    t.diagnostic(
      '实现缺陷（T8 报告）：probe() 把 layoutKind 恒置为 "default"，移动 re/ 后仍无布局缺口；'
      + 'A05 要求的"非默认布局给出具体缺口"目前只能由 check 的硬失败兜住。',
    )
    assert.equal(probe.ok, true)

    const checked = await adapter.check({ hashes: true })
    assert.equal(checked.ok, false, '非默认布局下不得返回 check 成功')
    assert.equal(checked.exitCode, 1)
    assert.match(
      `${checked.stderr}${checked.stdout}`,
      /INDEX navigation stale|re[\\/]targets\.json/u,
      '真实 CLI 的诊断必须点出缺失的默认布局路径',
    )
  })
})

test('非默认布局：probe 应给出布局缺口（A05 未满足，记录为 skip）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  return t.skip(
    '实现缺陷：src/project-adapter.ts 的 probe() 把 compatibility.layoutKind 恒置为 "default"，'
    + '并把 re/ 之外的记录目录当作无缺口；A05 要求的"非默认布局返回可读缺口"尚未实现。'
    + '本用例保留为验收缺口（不伪造通过）。',
  )
})

test('克隆到新根：摘要与路径无关；改规则/脚本后要求重新做兼容检查，旧绑定保留（A36）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await project(root)
    const original = await computeDigests({ projectRoot: root })
    const binding = {
      schema_version: 1,
      adapter: { contract_version: 1 },
      ruleDigest: original.ruleDigest,
      scriptDigest: original.scriptDigest,
      catalogDigest: original.catalogDigest,
    }
    await writeJson(path.join(root, 're', 'team', 'binding.json'), binding)

    const matched = await checkCompatibility({ projectRoot: root })
    assert.equal(matched.signal, 'BINDING_MATCH')
    assert.equal(matched.needsReview, false)
    assert.equal(matched.binding.matched, true)

    const { clone, dispose } = await cloneProject(root)
    try {
      const cloned = await computeDigests({ projectRoot: clone })
      assert.equal(cloned.ruleDigest, original.ruleDigest, '规则摘要与绝对路径无关')
      assert.equal(cloned.scriptDigest, original.scriptDigest, '脚本摘要与绝对路径无关')
      const clonedCheck = await checkCompatibility({ projectRoot: clone })
      assert.equal(clonedCheck.signal, 'BINDING_MATCH', '同内容克隆仍匹配旧摘要')

      // 克隆内改规则（追加一段说明）：必须要求重新做兼容性检查。
      const skillMd = path.join(clone, ...SKILL_COPY_RELATIVE.split('/'), 'SKILL.md')
      await writeFile(skillMd, `${await readFile(skillMd, 'utf8')}\n\nL2 漂移测试段。\n`, 'utf8')
      const drifted = await checkCompatibility({ projectRoot: clone })
      assert.equal(drifted.signal, 'REBIND_REQUIRED')
      assert.equal(drifted.needsReview, true)
      assert.deepEqual(drifted.differences.map((item) => item.key), ['ruleDigest'])
      assert.match(drifted.nextStep, /不要用全局副本覆盖项目副本/u, 'D8：不得覆盖项目副本')

      // 改脚本（保持可执行）→ scriptDigest 也要变。
      const projectPy = path.join(clone, ...SKILL_COPY_RELATIVE.split('/'), 'scripts', 'project.py')
      const originalScript = await readFile(projectPy, 'utf8')
      await writeFile(projectPy, `${originalScript}\n# L2 漂移：脚本内容变化\n`, 'utf8')
      const scriptDrift = await checkCompatibility({ projectRoot: clone })
      assert.equal(scriptDrift.signal, 'REBIND_REQUIRED')
      assert.deepEqual(scriptDrift.differences.map((item) => item.key).sort(), ['ruleDigest', 'scriptDigest'])

      // 旧绑定原样保留；原项目摘要不受克隆改动影响。
      const stored = await readJson(path.join(root, 're', 'team', 'binding.json'))
      assert.deepEqual(stored, binding, '不静默改写旧绑定')
      assert.deepEqual(await computeDigests({ projectRoot: root }), original, '原项目摘要不变')
    } finally {
      await dispose()
    }
  })
})

test('重做兼容检查的最小闭环：修正记录后 probe/check 仍能给出确定结论（A36）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await project(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    const adapter = createProjectAdapter({ projectRoot: root })
    expectOk(await adapter.check({ hashes: true }), '首次 check')

    // 与会话无关地重做兼容检查：probe 必须仍然无缺口，且摘要稳定。
    const first = await adapter.probe()
    const second = await adapter.probe()
    assert.deepEqual(second.compatibility, first.compatibility, '同一根上重复 probe 摘要稳定')

    // 正式记录被新 RUN 改变后，check 仍然工作（不需要重新 init）。
    await seal(root, RUN)
    await index(root)
    expectOk(await adapter.check({ hashes: true }), '封存后 check')
    const third = await adapter.probe()
    assert.equal(third.compatibility.ruleDigest, first.compatibility.ruleDigest, '封存不改规则摘要')
  })
})

/** 适配器结果的极简成功断言（保留原始诊断）。 */
function expectOk(result, label) {
  assert.equal(
    result.ok,
    true,
    `${label}: 期望成功，实际 exit=${result.exitCode} code=${result.code ?? ''} stderr=${String(result.stderr ?? '').trim()}`,
  )
}
