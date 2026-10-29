/**
 * L2 · Windows 路径边界（A20）。
 *
 * 真实 CLI 与插件路径接缝一起验证：
 * - 绝对路径 / `..` 越界产物被 check 拒绝；
 * - junction 指向项目外：产物经 junction 解析越界被拒绝，`seal` 拒绝写入链接目录；
 * - Windows ADS（`file.txt:stream`）：CLI 视作缺失文件，插件显式拒绝（`PATH_INVALID`）；
 * - 大小写碰撞：CLI **不**检测（同一文件两条路径都能过 --hashes），插件 `findCaseCollision` 必须检测；
 * - 检查后改提交：改产物 → 再 check 失败；新增未 index 的记录 → 导航过期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, checkProject, expectCode, expectStderrIncludes, readJson, writeJson,
  sha256File,
} from './helpers.mjs'
import { assertProjectRelative, findCaseCollision } from '../../dist/paths.js'

const RUN = 'RUN-20261001T000000Z-r001-01'

/** 一个已封存 + index 的可通过项目。 */
async function sealedProject(root) {
  const target = await writeTargets(root)
  const created = await writeRun(root, { id: RUN, target, provenance: {} })
  await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [RUN] })
  await writeProject(root)
  expectCode(seal(root, RUN), 0, 'seal')
  expectCode(index(root), 0, 'index')
  expectCode(checkProject(root, ['--hashes']), 0, '基线 check')
  return { target, created }
}

test('绝对路径与 .. 越界产物：真实 check 拒绝，诊断逐条点名', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { created } = await sealedProject(root)
    const runJsonPath = created.file
    const original = await readJson(runJsonPath)

    await writeJson(runJsonPath, { ...original, artifacts: [{ ...original.artifacts[0], path: 'C:\\Windows\\win.ini' }] })
    const absolute = checkProject(root, ['--hashes'])
    expectCode(absolute, 1, '绝对路径产物')
    expectStderrIncludes(absolute, 'expected project-relative path', '绝对路径')

    await writeJson(runJsonPath, { ...original, artifacts: [{ ...original.artifacts[0], path: '..\\..\\escape.txt' }] })
    const escape = checkProject(root, ['--hashes'])
    expectCode(escape, 1, '越界产物')
    expectStderrIncludes(escape, 'path escapes project', '越界')

    // 验收交付物走另一条判定路径（governance 侧），绝对路径同样被拒。
    await writeJson(runJsonPath, original)
    const project = await readJson(path.join(root, 're', 'project.json'))
    project.acceptance = [{
      id: 'A-001', requirement: '锚点', target_ids: ['T-001'], status: 'pending',
      evidence: [], min_independent_sources: 1,
      deliverables: [{ path: 'C:\\Windows\\win.ini', sha256: 'a'.repeat(64) }],
    }]
    await writeJson(path.join(root, 're', 'project.json'), project)
    expectCode(index(root), 0, 'index')
    const deliverable = checkProject(root, ['--hashes'])
    expectCode(deliverable, 1, '绝对交付物')
    expectStderrIncludes(deliverable, 'A-001: invalid deliverable path', '交付物路径')
  })
})

test('junction 指向项目外：产物越界被拒；seal 拒绝写入链接目录（A20）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-rt-l2-outside-'))
    const linked = path.join(root, 're', 'linked')
    const linkedSeals = path.join(root, 're', 'seals')
    try {
      await writeFile(path.join(outside, 'artifact.txt'), '外部文件，不应被项目记录引用\n', 'utf8')
      await symlink(outside, linked, 'junction')
      assert.equal(existsSync(path.join(linked, 'artifact.txt')), true, 'junction 已建立')

      const target = await writeTargets(root)
      const created = await writeRun(root, { id: RUN, target, provenance: {} })
      const original = await readJson(created.file)
      await writeJson(created.file, {
        ...original,
        artifacts: [{ path: 're/linked/artifact.txt', sha256: sha256File(path.join(outside, 'artifact.txt')) }],
      })
      await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
      await writeProject(root)
      expectCode(index(root), 0, 'index')
      const escaped = checkProject(root, ['--hashes'])
      expectCode(escaped, 1, '经 junction 的产物路径')
      expectStderrIncludes(escaped, 'path escapes project', 'junction 越界')

      // 写入侧：re/seals 是 junction 时，seal 必须拒绝写入（checked_path）。
      await writeJson(created.file, original)
      await rm(linked, { force: true })
      await symlink(outside, linkedSeals, 'junction')
      expectCode(index(root), 0, 'index')
      const sealResult = seal(root, RUN)
      expectCode(sealResult, 1, 're/seals 为 junction 时的 seal')
      expectStderrIncludes(sealResult, 'refusing linked project write path', '链接写入路径')
      assert.deepEqual(readdirSync(outside), ['artifact.txt'], '外部目录没有被写入任何基线')
    } finally {
      // 先摘掉 junction，再清理项目（rm 递归删除 junction 本身，不跟随目标）。
      await rm(linked, { force: true, recursive: false })
      await rm(linkedSeals, { force: true, recursive: false })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('Windows ADS：CLI 视作缺失文件，插件路径接缝显式拒绝（A20）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { created } = await sealedProject(root)
    const original = await readJson(created.file)
    const streamPath = `${original.artifacts[0].path}:l2stream`
    await writeJson(created.file, { ...original, artifacts: [{ ...original.artifacts[0], path: streamPath }] })

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 1, 'ADS 产物路径')
    expectStderrIncludes(checked, 'missing file', 'ADS 被当作缺失文件')

    // 插件侧的路径判定必须直接拒绝（不等文件系统解释），错误码 PATH_INVALID。
    assert.throws(
      () => assertProjectRelative(streamPath),
      (error) => error.code === 'PATH_INVALID' && /ADS|冒号/u.test(error.message),
      '插件必须显式拒绝 ADS 路径',
    )
    assert.throws(
      () => assertProjectRelative('C:\\Windows\\win.ini'),
      (error) => error.code === 'PATH_INVALID',
      '插件必须拒绝绝对路径',
    )
    assert.throws(
      () => assertProjectRelative('../escape.txt'),
      (error) => error.code === 'PATH_INVALID',
      '插件必须拒绝 .. 段',
    )
  })
})

test('大小写碰撞：CLI 不检测（同一文件两条路径都能封存通过），插件 findCaseCollision 必须检测（A20）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const created = await writeRun(root, { id: RUN, target, provenance: {} })
    const original = await readJson(created.file)
    const lower = original.artifacts[0].path
    const upper = lower.replace(/artifact-1\.txt$/u, 'ARTIFACT-1.TXT')
    assert.notEqual(lower, upper)

    // Windows 不区分大小写：两条路径指向同一个文件。碰撞必须在**封存前**写进记录。
    await writeJson(created.file, {
      ...original,
      artifacts: [...original.artifacts, { path: upper, sha256: original.artifacts[0].sha256 }],
    })
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, '含大小写重复路径的记录照样能封存')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '真实 CLI 不检测大小写碰撞（这正是插件必须自己检测的理由）')

    const collision = findCaseCollision([lower], upper)
    assert.equal(collision, lower, '插件必须报出与既有条目仅大小写不同的候选路径')
    assert.equal(findCaseCollision([lower], lower), null, '完全相同的路径不算碰撞')
    assert.equal(findCaseCollision([lower], 're/runs/other/raw/artifact-2.txt'), null)
  })
})

test('检查后改提交：改产物 → check --hashes 失败；新增未 index 的记录 → 导航过期（A20）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { target, created } = await sealedProject(root)
    const indexHash = sha256File(path.join(root, 'INDEX.md'))

    // 纯读命令不改 INDEX。
    expectCode(checkProject(root, ['--hashes']), 0, 'check #2')
    assert.equal(sha256File(path.join(root, 'INDEX.md')), indexHash, 'check 不改 INDEX')

    // 检查之后又改了产物字节：哈希校验必须发现。
    const artifact = path.join(root, ...created.run.artifacts[0].path.split('/'))
    await writeFile(artifact, '提交之后又被改写的内容\n', 'utf8')
    const tampered = checkProject(root, ['--hashes'])
    expectCode(tampered, 1, '检查后改产物')
    expectStderrIncludes(tampered, 'artifact/script hash mismatch', '产物哈希')

    // 新增正式记录但没刷新 INDEX：先报导航过期（fail-fast 的第一条）。
    await writeRun(root, { id: 'RUN-20261001T000200Z-r001-02', routeId: 'R-001', target, provenance: {} })
    const stale = checkProject(root, ['--hashes'])
    expectCode(stale, 1, '未 index 的新增记录')
    expectStderrIncludes(stale, 'INDEX navigation stale; run index', '导航过期')

    // 刷新 INDEX 后不再报导航，但篡改过的产物仍然被抓住：fail-fast 只往前走一步。
    expectCode(index(root), 0, 'index')
    const afterIndex = checkProject(root, ['--hashes'])
    expectCode(afterIndex, 1, 'index 后仍有产物篡改')
    assert.equal(afterIndex.stderr.includes('INDEX navigation stale'), false, '导航已刷新')
    expectStderrIncludes(afterIndex, created.run.artifacts[0].path, '失败消息点名被改写的产物')
  })
})
