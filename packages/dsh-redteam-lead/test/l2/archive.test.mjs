/**
 * L2 · 归档顺序与执行事实（A28 / A29）。
 *
 * 场景：两个工兵在**各自独立暂存区**写产物与运行草稿，Lead 串行归档到正式位置，
 * 再跑真实 `seal` / `index` / `check --hashes`。
 *
 * 断言重点：
 * - 正式产物与暂存字节一致（sha256 相等），且暂存区原样保留；
 * - 执行事实（命令 / cwd / 时间 / 来源）**不因移动存储而改写**；
 * - 路径映射被保留（归档回执）；
 * - 一个工兵继续写隔离区时，Lead 对另一个提交的 seal/check 仍然通过，正式记录稳定；
 * - 未核对的提交不能被 seal（不降门槛）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import {
  environment, withProject, writeTargets, writeRoute, writeProject, writeRun,
  writeEnvSnapshot, seal, index, checkProject, parseCheck, expectCode, expectStderrIncludes,
  readJson, writeJson, writeText, sha256File, sha256, projectCli,
} from './helpers.mjs'

/**
 * 工兵写独立暂存区（测试侧模拟 submission：原始产物 + 运行草稿 + 计划）。
 * 返回归档需要的全部事实。
 */
async function stage(root, options) {
  const {
    dispatch, attempt, runId, target,
    artifacts = [{ name: '01-notes.txt', bytes: `worker ${dispatch}/${attempt} notes\n` }],
    command = `python -B ${attempt}.py --read-only`,
    startedAt = '2026-10-01T00:00:00Z',
    endedAt = '2026-10-01T00:20:00Z',
    source = 'worker workspace',
  } = options
  const workDir = `re/team/work/${dispatch}/${attempt}`
  const stagedArtifacts = []
  for (const artifact of artifacts) {
    const stagedPath = `${workDir}/raw/${artifact.name}`
    await writeText(path.join(root, ...stagedPath.split('/')), artifact.bytes)
    stagedArtifacts.push({ name: artifact.name, stagedPath, sha256: sha256(artifact.bytes) })
  }
  const draft = {
    schema_version: 1,
    dispatch_id: dispatch,
    attempt_id: attempt,
    run_id: runId,
    route_id: 'R-001',
    target_id: target.id,
    target_sha256: target.sha256,
    command,
    cwd: path.join(root, ...workDir.split('/')),
    started_at: startedAt,
    ended_at: endedAt,
    source,
    tools: [{ name: 'python', version: '3.15.2' }],
    artifacts: stagedArtifacts.map((item) => ({ path: item.stagedPath, sha256: item.sha256 })),
    plan: `计划：只读读取占位目标（${attempt}）`,
  }
  await writeJson(path.join(root, ...workDir.split('/'), 'run-draft.json'), draft)
  await writeText(path.join(root, ...workDir.split('/'), 'plan.md'), `# 计划 ${attempt}\n\n仅静态读取。\n`)
  return { dispatch, attempt, runId, workDir, draft, stagedArtifacts, target }
}

/**
 * Lead 归档：把暂存产物搬进正式 RUN 目录，写出执行事实不变的 `run.json`，
 * 并保留原提交路径映射（`re/team/receipts/`）。
 *
 * @param {{ tamperRunJson?: boolean }} [options]
 *   `tamperRunJson` 模拟"未核对哈希"的错误归档：run.json 声明的产物哈希与字节不符。
 */
async function archive(root, staged, options = {}) {
  const runDir = `re/runs/${staged.runId}`
  const mappings = []
  const payloads = []
  for (const item of staged.stagedArtifacts) {
    const formalPath = `${runDir}/raw/${item.name}`
    const bytes = await readFile(path.join(root, ...item.stagedPath.split('/')))
    await writeText(path.join(root, ...formalPath.split('/')), bytes)
    payloads.push({ path: formalPath, bytes })
    mappings.push({
      source_path: item.stagedPath,
      formal_path: formalPath,
      sha256: sha256File(path.join(root, ...formalPath.split('/'))),
    })
  }
  await writeJson(path.join(root, 're/team/receipts', `archive-${staged.runId}.json`), {
    schema_version: 1,
    run_id: staged.runId,
    dispatch_id: staged.dispatch,
    attempt_id: staged.attempt,
    archived_at: '2026-10-01T00:30:00Z',
    source_work_dir: staged.workDir,
    artifacts: mappings,
  })
  const snapshot = await writeEnvSnapshot(root, {
    name: `ENV-${staged.runId.replace(/^RUN-/, '')}.json`,
    collectedAt: staged.draft.startedAt,
  })
  const run = await writeRun(root, {
    id: staged.runId,
    target: staged.target,
    status: 'completed',
    startedAt: staged.draft.started_at,
    endedAt: staged.draft.ended_at,
    // 执行事实原样搬运：命令与 cwd 来自工兵草稿，不因归档改写。
    command: staged.draft.command,
    cwd: staged.draft.cwd,
    tools: staged.draft.tools,
    environment: snapshot,
    artifacts: payloads,
    provenance: {
      kind: 'acquisition',
      capture_id: `CAP-${staged.runId}`,
      note: `归档自 ${staged.workDir}（原提交与映射见 re/team/receipts）`,
    },
    result: `worker ${staged.attempt} 完成只读读取`,
  })
  if (options.tamperRunJson === true) {
    // run.json 声明了一个与正式产物字节不符的哈希（未核对原始字节就落盘）。
    const written = await readJson(run.file)
    written.artifacts[0].sha256 = 'f'.repeat(64)
    await writeJson(run.file, written)
    run.run.artifacts[0].sha256 = 'f'.repeat(64)
  }
  return { run, mappings }
}

test('两个工兵并行写独立暂存区，Lead 串行归档：正式产物与暂存字节一致、执行事实原样保留（A28）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
    await writeProject(root)

    // 两个工兵并发写各自的隔离目录（互不共享文件）。
    const [a, b] = await Promise.all([
      stage(root, { dispatch: 'D-001', attempt: 'A-01', runId: 'RUN-20261001T000000Z-r001-01', target }),
      stage(root, { dispatch: 'D-002', attempt: 'A-01', runId: 'RUN-20261001T000100Z-r001-02', target }),
    ])
    const stagedHashes = {
      a: sha256File(path.join(root, ...a.stagedArtifacts[0].stagedPath.split('/'))),
      b: sha256File(path.join(root, ...b.stagedArtifacts[0].stagedPath.split('/'))),
    }

    // Lead 串行归档（顺序与并发无关，但同一时刻只有一个整合者写正式记录）。
    const archivedA = await archive(root, a)
    const archivedB = await archive(root, b)

    // 正式产物与暂存字节一致；暂存区原样保留。
    for (const [staged, archived] of [[a, archivedA], [b, archivedB]]) {
      assert.equal(archived.mappings.length, 1)
      assert.equal(archived.mappings[0].sha256, staged.stagedArtifacts[0].sha256)
      assert.equal(
        sha256File(path.join(root, ...archived.mappings[0].formal_path.split('/'))),
        staged.stagedArtifacts[0].sha256,
      )
      assert.equal(sha256File(path.join(root, ...staged.stagedArtifacts[0].stagedPath.split('/'))),
        staged.stagedArtifacts[0].sha256, '暂存原件在归档后仍保留同样字节')
      assert.equal(existsSync(path.join(root, ...staged.workDir.split('/'), 'run-draft.json')), true)
    }
    assert.notEqual(a.stagedArtifacts[0].sha256, b.stagedArtifacts[0].sha256, '两个工兵的产物确实不同')
    assert.equal(stagedHashes.a, a.stagedArtifacts[0].sha256)

    // 执行事实不被改写：命令 / cwd / 起止时间 / 来源逐字段相等。
    for (const [staged, archived] of [[a, archivedA], [b, archivedB]]) {
      const written = await readJson(archived.run.file)
      assert.equal(written.command, staged.draft.command)
      assert.equal(written.cwd, staged.draft.cwd)
      assert.equal(written.started_at, staged.draft.started_at)
      assert.equal(written.ended_at, staged.draft.ended_at)
      assert.deepEqual(written.tools, staged.draft.tools)
      assert.equal(written.provenance.note.includes(staged.workDir), true, '来源指向原提交')
      // 归档回执保留原路径映射。
      const receipt = await readJson(path.join(root, 're/team/receipts', `archive-${staged.runId}.json`))
      assert.equal(receipt.source_work_dir, staged.workDir)
      assert.equal(receipt.artifacts[0].source_path, staged.stagedArtifacts[0].stagedPath)
    }

    expectCode(seal(root, a.runId), 0, 'seal A')
    expectCode(seal(root, b.runId), 0, 'seal B')
    expectCode(index(root), 0, 'index')
    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, 'check --hashes')
    assert.equal(parseCheck(checked).runs, 2)
  })
})

test('工兵继续写隔离区时，Lead 对另一提交执行 seal/index/check：正式记录稳定、隔离区不被索引（A29）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [] })
    await writeProject(root)

    const a = await stage(root, { dispatch: 'D-001', attempt: 'A-01', runId: 'RUN-20261001T000000Z-r001-01', target })
    const archived = await archive(root, a)
    const runJsonPath = archived.run.file
    const sealedBefore = sha256File(runJsonPath)

    // B 仍在自己的隔离区持续写（尚未提交）。
    const b = await stage(root, { dispatch: 'D-002', attempt: 'A-01', runId: 'RUN-20261001T000100Z-r001-02', target })

    expectCode(seal(root, a.runId), 0, 'seal A')
    await writeText(path.join(root, ...b.workDir.split('/'), 'raw', '02-more.txt'), 'late worker output\n')
    expectCode(index(root), 0, 'index')

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, 'check --hashes')
    assert.equal(parseCheck(checked).runs, 1, '未提交的 B 不出现在正式记录里')
    assert.equal(sha256File(runJsonPath), sealedBefore, 'A 的执行事实在 seal/check 期间保持稳定')

    // re/team/** 对 skill 不可见：既不在 INDEX 导航区，也不影响 check。
    const indexPath = path.join(root, 'INDEX.md')
    const indexText = await readFile(indexPath, 'utf8')
    assert.equal(indexText.includes('re/team'), false, 'INDEX 导航区不索引 re/team（skill 固定分组）')

    // B 之后提交仍可正常归档并封存。
    const archivedB = await archive(root, b)
    expectCode(seal(root, archivedB.run.run.id), 0, 'seal B')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'final check')
  })
})

test('未核对哈希的提交：真实 seal 拒绝且不写任何基线（不降门槛，A29）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
    await writeProject(root)
    const staged = await stage(root, { dispatch: 'D-001', attempt: 'A-01', runId: 'RUN-20261001T000000Z-r001-01', target })
    // 故意用错误的产物哈希归档（模拟 Lead 没有核对原始字节）。
    await archive(root, staged, { tamperRunJson: true })

    const attempt = seal(root, staged.runId)
    expectCode(attempt, 1, 'seal 未核实提交')
    expectStderrIncludes(attempt, 'artifact/script hash mismatch', '哈希不符')
    assert.equal(existsSync(path.join(root, 're', 'seals')), false, '校验失败时 seal 不写任何基线')

    // seal 校验全项目并带哈希，所以未核实的提交永远封不上；check 也就过不去。
    expectCode(index(root), 0, 'index')
    const blocked = checkProject(root, [])
    expectCode(blocked, 1, '未封存终态 RUN 无法通过 check')
    expectStderrIncludes(blocked, 'unsealed execution/target; verify the original acquisition then run seal', '未封存')

    // 更正路径：把 run.json 的期望哈希改成核对过的真实字节，再走 seal → index → check。
    const repaired = await readJson(path.join(root, 're/runs', staged.runId, 'run.json'))
    repaired.artifacts[0].sha256 = sha256File(path.join(root, ...repaired.artifacts[0].path.split('/')))
    await writeJson(path.join(root, 're/runs', staged.runId, 'run.json'), repaired)
    expectCode(seal(root, staged.runId), 0, '核对字节后 seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check --hashes')
  })
})

test('归档后 check/impact/audit-scope 是纯读：不改 INDEX、执行记录与基线', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const staged = await stage(root, { dispatch: 'D-001', attempt: 'A-01', runId: 'RUN-20261001T000000Z-r001-01', target })
    await archive(root, staged)
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
    await writeProject(root)
    expectCode(seal(root, staged.runId), 0, 'seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')

    // CLI 的写策略：只有 init/index/seal/probe --output 会写文件；check/impact/audit-scope 是纯读。
    const before = {
      index: sha256File(path.join(root, 'INDEX.md')),
      run: sha256File(path.join(root, 're/runs', staged.runId, 'run.json')),
      seal: sha256File(path.join(root, 're/seals/runs', `${staged.runId}.json`)),
    }
    expectCode(checkProject(root, ['--hashes']), 0, 'check again')
    expectCode(projectCli(root, ['impact', root]), 0, 'impact')
    expectCode(projectCli(root, ['audit-scope', root]), 0, 'audit-scope')
    assert.equal(sha256File(path.join(root, 'INDEX.md')), before.index, 'check/impact/audit-scope 不改 INDEX')
    assert.equal(sha256File(path.join(root, 're/runs', staged.runId, 'run.json')), before.run)
    assert.equal(sha256File(path.join(root, 're/seals/runs', `${staged.runId}.json`)), before.seal)
  })
})
