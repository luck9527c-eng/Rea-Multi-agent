/**
 * L2 · 重放、阶段失败与迟到提交（A24 / A32）。
 *
 * 真实 CLI 侧的恢复语义：
 * - `seal` 已写但响应丢失 → 重放被拒绝，基线逐字节不变，history 不重复；
 * - `index` 收敛（重复执行字节不变）；
 * - 阶段失败不留半成品，同一 RUN ID 可以前向恢复（不删证据）；
 * - 重复应用同一条路线变更会被 history 链校验拒绝；
 * - 迟到 attempt 只留在隔离区，不影响正式记录；用已接受的 RUN ID 再归档被拒绝；
 * - 恢复评估（`state.recovery`）可在封存后补写，`execution_sha256` 不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, checkProject, parseCheck, expectCode, expectStderrIncludes,
  readJson, writeJson, writeText, sha256File, executionSha256, stateFixture,
} from './helpers.mjs'

const RUN = 'RUN-20261001T000000Z-r001-01'

test('seal 的响应丢失后重放：被拒绝、基线不变、history 不重复（A24）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)

    expectCode(seal(root, RUN), 0, '首次 seal')
    const sealPath = path.join(root, 're', 'seals', 'runs', `${RUN}.json`)
    const sealBytes = sha256File(sealPath)
    const routePath = path.join(root, 're', 'routes', 'R-001.json')
    const historyBefore = (await readJson(routePath)).history.length

    // 响应丢失：调用方不知道是否成功，于是用同一身份重放。
    const replay = seal(root, RUN)
    expectCode(replay, 1, '重放 seal')
    expectStderrIncludes(replay, 'refusing to overwrite sealed execution', '拒绝覆盖')
    assert.equal(sha256File(sealPath), sealBytes, '重放不改基线')
    assert.equal((await readJson(routePath)).history.length, historyBefore, '重放不追加 history')

    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')
  })
})

test('index 收敛：重复执行不改变 INDEX 字节（幂等）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'] })
    await writeProject(root)
    expectCode(index(root), 0, 'index #1')
    const first = sha256File(path.join(root, 'INDEX.md'))
    expectCode(index(root), 0, 'index #2')
    assert.equal(sha256File(path.join(root, 'INDEX.md')), first, 'index 是收敛操作')
  })
})

test('阶段失败不留半成品：seal 校验失败后不写基线，修正记录后同一 RUN 前向恢复（A24）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const created = await writeRun(root, { id: RUN, target, provenance: {} })
    // 路线缺 resume_when 会让 seal 的全项目校验失败（seal 不是只校验这个 RUN）。
    await writeRoute(root, { id: 'R-001', status: 'paused', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    const runBytes = sha256File(created.file)
    const historyBefore = (await readJson(path.join(root, 're', 'routes', 'R-001.json'))).history.length

    const failed = seal(root, RUN)
    expectCode(failed, 1, 'seal 阶段失败')
    expectStderrIncludes(failed, 'R-001: missing resume_when', '失败原因具体')
    assert.equal(existsSync(path.join(root, 're', 'seals')), false, '失败不写 re/seals')
    assert.equal(sha256File(created.file), runBytes, '失败不改执行记录（不删证据回滚）')

    // 修正记录（不是删除/重写证据），同一 RUN ID 前向恢复。
    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    route.resume_when = '补齐恢复条件后继续'
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    assert.equal(route.history.length, historyBefore, '修正不改 history 长度')
    expectCode(seal(root, RUN), 0, '修正后 seal 成功')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')
  })
})

test('同一条路线变更应用两次：真实 check 拒绝 broken history chain（A32）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await writeTargets(root)
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'] })
    await writeProject(root)
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, []), 0, '单次应用通过')

    // 幂等重放被误实现成"再追加一次同样的事件"。
    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    const applied = route.history.at(-1)
    route.history.push({ ...applied, at: '2026-10-01T00:10:00Z' })
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    const duplicate = checkProject(root, [])
    expectCode(duplicate, 1, '重复 history 事件')
    expectStderrIncludes(duplicate, 'R-001: broken history chain', 'history 链')
  })
})

test('迟到 attempt 只写隔离区：正式记录、基线、INDEX 都不受影响（A24/A32）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const first = await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal 已接受的尝试')
    expectCode(index(root), 0, 'index')

    const accepted = {
      run: sha256File(first.file),
      seal: sha256File(path.join(root, 're', 'seals', 'runs', `${RUN}.json`)),
      index: sha256File(path.join(root, 'INDEX.md')),
    }

    // 旧 attempt 的工作区在重新派发后仍然存在；它继续写（迟到提交）。
    const lateStaging = path.join(root, 're', 'team', 'work', 'D-001', 'A-01')
    await writeText(path.join(lateStaging, 'raw', 'late.txt'), '已撤销尝试的迟到产物\n')
    await writeJson(path.join(lateStaging, 'run-draft-late.json'), {
      run_id: RUN, attempt: 'A-01', note: '迟到提交，只入历史', at: '2026-10-01T02:00:00Z',
    })

    expectCode(checkProject(root, ['--hashes']), 0, '迟到写入后 check 仍通过')
    assert.equal(sha256File(first.file), accepted.run, '正式执行记录不被迟到提交改写')
    assert.equal(sha256File(path.join(root, 're', 'seals', 'runs', `${RUN}.json`)), accepted.seal, '基线不变')
    assert.equal(sha256File(path.join(root, 'INDEX.md')), accepted.index, '隔离区不进 INDEX')
    const checked = parseCheck(checkProject(root, ['--hashes']))
    assert.equal(checked.runs, 1, '迟到提交不产生新的正式 RUN')
  })
})

test('迟到 attempt 用已接受的 RUN ID 再归档：真实 check 拒绝身份冲突（不静默覆盖）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const accepted = await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal')

    // 迟到 attempt 把同一 RUN ID 的草案写到另一个目录：目录名必须等于 id。
    const duplicated = await readJson(accepted.file)
    await writeJson(path.join(root, 're', 'runs', 'RUN-20261001T000500Z-r001-99', 'run.json'), duplicated)
    expectCode(index(root), 0, 'index')

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 1, '重复 RUN 身份')
    expectStderrIncludes(checked, 'run identity/schema mismatch', '身份冲突')
    assert.equal(existsSync(path.join(root, 're', 'seals', 'runs', `${RUN}.json`)), true, '已接受基线仍在')
  })
})

test('封存后补写恢复评估：state.recovery 可更新，execution_sha256 不变（A24）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const created = await writeRun(root, {
      id: RUN, target, status: 'interrupted',
      state: stateFixture({ status: 'pending', recovery: { at: '2026-10-01T00:20:00Z', assessment: '进程被终止', next_step: '重跑' } }),
      provenance: {},
    })
    await writeRoute(root, { id: 'R-001', status: 'paused', targetIds: ['T-001'], resumeWhen: '恢复中断实验', evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal interrupted')
    const sealed = sha256File(path.join(root, 're', 'seals', 'runs', `${RUN}.json`))

    const run = await readJson(created.file)
    run.state.recovery = {
      at: '2026-10-01T00:40:00Z',
      assessment: '外部终止，已核对残留进程',
      next_step: '在新尝试中重跑并保留部分产物',
    }
    await writeJson(created.file, run)

    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '补写恢复评估后 check 通过')
    assert.equal(sha256File(path.join(root, 're', 'seals', 'runs', `${RUN}.json`)), sealed, '基线文件不变')
    assert.equal(
      (await readJson(path.join(root, 're', 'seals', 'runs', `${RUN}.json`))).execution_sha256,
      executionSha256(run),
      'state 不参与执行摘要',
    )
  })
})
