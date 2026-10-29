/**
 * L2 · seal / index / check 的真实 CLI 行为（A19 / A35）。
 *
 * 这里断言的是**真实** `project.py` 的判定，不是替身：
 * - seal 只写一次；已有封存只校验复用，不覆盖；
 * - `execution_sha256` 独立复算（规范 JSON 去掉 `state`）；
 * - 篡改已封存产物或执行事实必须被拒绝；
 * - `seal` 不刷新 INDEX（所以顺序必须是 seal → index → check）；
 * - `check --hashes --complete` 在验收/复查/活动路线缺口存在时失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, checkProject, parseCheck, expectCode, expectStderrIncludes,
  readJson, executionSha256, sha256File, writeJson, writeAuditFromCli, stateFixture,
} from './helpers.mjs'
import { createFakeProject } from '../helpers/fake-project.mjs'

const RUN = 'RUN-20261001T000000Z-r001-01'

/** 最小合法项目：一个目标、一条 planned 路线、一次 completed RUN。 */
async function fixture(root, options = {}) {
  const target = await writeTargets(root)
  const created = await writeRun(root, {
    id: options.runId ?? RUN,
    target,
    status: 'completed',
    provenance: {},
  })
  await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
  await writeProject(root)
  return { target, ...created }
}

test('未封存 RUN：seal 成功写出目标/执行基线，execution_sha256 与独立复算一致', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { target } = await fixture(root)

    const result = seal(root, RUN)
    expectCode(result, 0, 'seal')
    assert.equal(
      result.stdout.trim(),
      `Sealed ${RUN}; preserve re/seals in reviewed version control; refresh INDEX.`,
    )
    assert.equal(result.stderr, '')

    const runSeal = await readJson(path.join(root, 're', 'seals', 'runs', `${RUN}.json`))
    assert.equal(runSeal.schema_version, 1)
    assert.equal(runSeal.run_id, RUN)
    // 独立复算：不读 CLI 的实现，按文档算法（run.json 去掉 state 的规范 JSON sha256）算。
    const written = await readJson(path.join(root, 're', 'runs', RUN, 'run.json'))
    assert.equal(runSeal.execution_sha256, executionSha256(written))

    const targetSeal = await readJson(path.join(root, 're', 'seals', 'targets', 'T-001.json'))
    assert.equal(targetSeal.schema_version, 1)
    const { path: targetPath, ...identity } = target
    assert.deepEqual(targetSeal.identity, identity)
    assert.equal(targetPath, 're/samples/T-001.txt', '夹具目标用项目内相对路径')
    assert.equal(Object.hasOwn(targetSeal.identity, 'path'), false, '目标基线不固化 path（交接可换路径）')
  })
})

test('已封存 RUN：重复 seal 被拒绝，基线字节不变（只校验复用，不重封存）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await fixture(root)
    expectCode(seal(root, RUN), 0, '首次 seal')
    const sealPath = path.join(root, 're', 'seals', 'runs', `${RUN}.json`)
    const before = sha256File(sealPath)

    const again = seal(root, RUN)
    expectCode(again, 1, '重复 seal')
    expectStderrIncludes(again, 'refusing to overwrite sealed execution', '重复 seal')
    assert.equal(sha256File(sealPath), before, '拒绝覆盖时基线必须逐字节不变')
  })
})

test('顺序不可换：seal 不刷新 INDEX，check 先报 INDEX 导航过期；index 后 check --hashes 通过', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await fixture(root)

    const stale = checkProject(root, ['--hashes'])
    expectCode(stale, 1, 'seal 后未 index 的 check')
    expectStderrIncludes(stale, 'INDEX navigation stale; run index', 'INDEX 导航过期')

    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, 'check --hashes')
    const json = parseCheck(checked)
    assert.equal(json.runs, 1)
    assert.equal(json.targets, 1)
    assert.equal(json.routes, 1)
    assert.equal(json.hashes_verified, true)
    assert.equal(json.completion_checked, false, '未传 --complete 且项目未标记 completed')
  })
})

test('同一目标的第二个 RUN：目标基线复用不重写，执行基线各自一份', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const first = await writeRun(root, { id: RUN, target, provenance: {} })
    const second = await writeRun(root, { id: 'RUN-20261001T000100Z-r001-02', target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [first.run.id, second.run.id] })
    await writeProject(root)

    expectCode(seal(root, first.run.id), 0, 'seal 第一个 RUN')
    const targetSealPath = path.join(root, 're', 'seals', 'targets', 'T-001.json')
    const targetSealBefore = sha256File(targetSealPath)

    expectCode(seal(root, second.run.id), 0, 'seal 第二个 RUN（同目标）')
    assert.equal(sha256File(targetSealPath), targetSealBefore, '目标基线写一次后只复用')

    const seals = await readJson(path.join(root, 're', 'seals', 'runs', `${second.run.id}.json`))
    assert.equal(seals.execution_sha256, executionSha256((await readJson(second.file))))

    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check --hashes')
  })
})

test('篡改已封存产物：替身会通过，真实 check --hashes 失败', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { run } = await fixture(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '篡改前 check')

    const artifact = path.join(root, ...run.artifacts[0].path.split('/'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(artifact, 'tampered bytes\n', 'utf8')

    // 替身：默认成功响应，永远看不到字节变化。
    const fake = createFakeProject({ projectRoot: root })
    const fakeResult = await fake.check({ hashes: true })
    assert.equal(fakeResult.ok, true, '替身按同一项目返回成功（正是本用例要对比的差异）')

    // 真实 CLI：重算哈希，判定失败并给出具体产物路径。
    const real = checkProject(root, ['--hashes'])
    expectCode(real, 1, '篡改产物后的 check --hashes')
    expectStderrIncludes(real, 'artifact/script hash mismatch', '产物哈希')
    expectStderrIncludes(real, run.artifacts[0].path, '失败消息点名产物路径')

    // 关键差异：不带 --hashes 时只查结构，同一份被篡改的项目仍然通过。
    expectCode(checkProject(root, []), 0, '不带 --hashes 的 check 放过字节篡改')
  })
})

test('改写已封存 run.json 的执行事实被拒绝；只改 state 是允许的恢复通道', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { run } = await fixture(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    assert.equal(checkProject(root, ['--hashes']).code, 0)

    const runJsonPath = path.join(root, 're', 'runs', RUN, 'run.json')
    const original = await readJson(runJsonPath)

    await writeJson(runJsonPath, { ...original, command: '被改写后的命令' })
    expectCode(index(root), 0, 'index')
    const tampered = checkProject(root, ['--hashes'])
    expectCode(tampered, 1, '执行事实被改写')
    expectStderrIncludes(tampered, 'sealed execution changed or removed; preserve it and create a correction run', '执行基线漂移')

    // 唯一允许的封存后写入：state（恢复评估在封存之后记录）。
    await writeJson(runJsonPath, { ...original, state: stateFixture({ status: 'restored' }) })
    const recovered = checkProject(root, ['--hashes'])
    expectCode(recovered, 0, '只改 state 后 check --hashes')
    assert.equal(
      (await readJson(path.join(root, 're', 'seals', 'runs', `${RUN}.json`))).execution_sha256,
      executionSha256(original),
      'state 不参与 execution_sha256',
    )
  })
})

test('验收缺口存在时 check --hashes --complete 失败（A35）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await fixture(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    // 普通 check 通过：它不判断项目是否完成。
    expectCode(checkProject(root, ['--hashes']), 0, 'check --hashes')

    const incomplete = checkProject(root, ['--hashes', '--complete'])
    expectCode(incomplete, 1, 'check --hashes --complete')
    expectStderrIncludes(incomplete, 'completion: acceptance criteria missing or unmet', '验收缺口')

    // 登记一条 pending 验收也一样失败：缺口不是"没有验收项"而已。
    await writeProject(root, {
      acceptance: [{
        id: 'A-001',
        requirement: '待复核的锚点',
        target_ids: ['T-001'],
        status: 'pending',
        evidence: [RUN],
        min_independent_sources: 1,
        deliverables: [],
      }],
    })
    // INDEX 的导航区包含"验收待办"摘要，所以改 project.json 后必须重新 index。
    expectCode(index(root), 0, '改验收后 index')
    const pending = checkProject(root, ['--hashes', '--complete'])
    expectCode(pending, 1, 'pending 验收')
    expectStderrIncludes(pending, 'completion: acceptance criteria missing or unmet', 'pending 验收')
  })
})

test('任务全部完成但仍有活动路线：check --hashes --complete 仍失败（A35 语义）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const done = await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, {
      id: 'R-001', status: 'validated', targetIds: ['T-001'], evidence: [done.run.id],
      closure: { summary: '占位目标只含文本', scope: 'T-001', limitations: '仅静态读取', evidence: [done.run.id] },
    })
    // 第二条路线仍在执行中：交付都处理完了，但项目没完成。
    await writeRoute(root, { id: 'R-002', status: 'active', targetIds: ['T-001'], evidence: [done.run.id] })
    await writeProject(root, {
      acceptance: [{
        id: 'A-001', requirement: '锚点可复算', target_ids: ['T-001'], status: 'met',
        evidence: [done.run.id], min_independent_sources: 1,
        deliverables: [{ path: done.run.artifacts[0].path, sha256: done.run.artifacts[0].sha256 }],
        reason: '哈希一致',
      }],
    })
    expectCode(seal(root, RUN), 0, 'seal')
    await writeAuditFromCli(root)
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check --hashes')

    const complete = checkProject(root, ['--hashes', '--complete'])
    expectCode(complete, 1, 'check --hashes --complete')
    expectStderrIncludes(complete, 'completion: active route needs closure or explicit pause/disposition', '活动路线阻止完成')
  })
})

test('同时改写目标与清单：目标封存仍拒绝（旧项变化不允许）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { target } = await fixture(root)
    expectCode(seal(root, RUN), 0, 'seal')
    // seal 新增了 re/seals/**，INDEX 导航区需要刷新一次作为基线。
    expectCode(index(root), 0, 'seal 后 index')
    expectCode(checkProject(root, ['--hashes']), 0, '改动前 check')

    // 同时把目标字节、targets.json 的哈希、run.json 的 target.sha256 改成一致的新值。
    const { writeFile } = await import('node:fs/promises')
    const targetFile = path.join(root, ...target.path.split('/'))
    await writeFile(targetFile, 'rewritten target bytes\n', 'utf8')
    const newSha = sha256File(targetFile)
    await writeJson(path.join(root, 're', 'targets.json'), {
      schema_version: 1,
      targets: [{ ...target, sha256: newSha }],
    })
    const runJsonPath = path.join(root, 're', 'runs', RUN, 'run.json')
    const run = await readJson(runJsonPath)
    await writeJson(runJsonPath, { ...run, target: { ...run.target, sha256: newSha } })

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 1, '同时改目标与清单')
    expectStderrIncludes(checked, 'T-001: sealed target identity changed or removed', '目标基线漂移')
  })
})
