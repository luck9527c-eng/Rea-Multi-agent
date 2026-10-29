/**
 * L2 · 七类 outcome 的真实门槛（A16 / A18）。
 *
 * 编排契约的七类 outcome（finding / no_finding / refuted / blocked / budget_exhausted /
 * failed / cancelled）在这里各取一例，用真实 `check` / `seal` 判定 skill 侧的记录门槛：
 * - 交付已处理 ≠ 路线 validated；失败不自动证死；
 * - 未开始的阻塞可以没有 RUN；
 * - 中断必须有恢复评估；
 * - 依赖/收口门槛不因"任务完成"而放宽。
 *
 * 最后一个用例证明门槛**可达成**（闭环项目真的能通过 `--complete`），避免整套断言
 * 因为永远失败而失去意义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, checkProject, expectCode, expectStderrIncludes, readJson, writeJson,
  stateFixture, writeAuditFromCli,
} from './helpers.mjs'

const RUN = 'RUN-20261001T000000Z-r001-01'
const PASSED = { trigger: 'L2 触发', window: '2026-10-01T00:00Z..00:10Z', coverage: '占位目标全部字节', control: '同一文件二次读取', chain_status: 'passed' }

test('finding：completed RUN 不等于 validated —— check 通过但路线状态不被自动提升', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const run = await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')

    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    assert.equal(route.status, 'active', '有 completed RUN 也不自动 validated（交付已处理 ≠ 成功依赖）')
    assert.equal(route.closure, null)
    assert.equal(run.run.status, 'completed')
  })
})

test('no_finding / budget_exhausted：paused 必须写 resume_when，补上后 check 通过', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRun(root, { id: RUN, target, provenance: {} })
    // 先在合法状态封存（seal 会跑全项目校验），再引入 paused 缺口。
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '基线 check')

    await writeRoute(root, { id: 'R-001', status: 'paused', targetIds: ['T-001'], evidence: [RUN] })
    expectCode(index(root), 0, 'index')
    const rejected = checkProject(root, ['--hashes'])
    expectCode(rejected, 1, 'paused 缺 resume_when')
    expectStderrIncludes(rejected, 'R-001: missing resume_when', '恢复条件')

    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    route.resume_when = '预算恢复或优先级提升后继续'
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '补齐恢复条件后 check 通过')
  })
})

test('refuted：falsified 需要完整 closure 与 passed 观测链；失败 RUN 不会自动证死', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const obs = await writeRun(root, { id: 'RUN-20261001T000000Z-r001-01', target, provenance: {}, observation: PASSED })
    const ctl = await writeRun(root, { id: 'RUN-20261001T000000Z-r001-02', target, provenance: {}, observation: PASSED })
    // 证据先封存（此时路线仍是 active），再依次引入 falsified 的缺口。
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [obs.run.id, ctl.run.id] })
    await writeProject(root)
    expectCode(seal(root, obs.run.id), 0, 'seal 观测')
    expectCode(seal(root, ctl.run.id), 0, 'seal 对照')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '基线 check')

    await writeRoute(root, { id: 'R-001', status: 'falsified', targetIds: ['T-001'], evidence: [obs.run.id, ctl.run.id] })
    expectCode(index(root), 0, 'index')
    const noClosure = checkProject(root, ['--hashes'])
    expectCode(noClosure, 1, 'falsified 缺 closure')
    expectStderrIncludes(noClosure, 'R-001: closure required for falsified', 'closure 必需')

    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    // 只补齐文字字段、故意缺 observation/control 引用：验证 fail-fast 的第二道门槛。
    route.closure = {
      summary: '假设被否定', scope: 'T-001 占位读取', criterion: '哈希不一致',
      coverage: '占位文件全部字节', control: '同一文件二次读取一致',
      limitations: '仅静态', reopen_when: '出现新解析路径时重开', evidence: [obs.run.id],
    }
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    const partial = checkProject(root, ['--hashes'])
    expectCode(partial, 1, '证死缺观测/对照引用')
    expectStderrIncludes(partial, 'falsification needs observation/control references', '观测/对照引用')

    route.closure = {
      summary: '假设被否定',
      scope: 'T-001 占位读取',
      criterion: '预登记的反证条件：哈希不一致',
      coverage: '占位文件全部字节',
      control: '同一文件二次读取一致',
      limitations: '仅静态读取；未运行样本',
      reopen_when: '出现新的解析路径时重开',
      evidence: [obs.run.id],
      observation_refs: [{ run_id: obs.run.id, path: obs.run.artifacts[0].path, locator: '行 1-2' }],
      control_refs: [{ run_id: ctl.run.id, path: ctl.run.artifacts[0].path, locator: '行 1-2' }],
    }
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '完整证死 closure 通过')
  })
})

test('failed：failed/timed_out 运行可以封存，但不会自动把路线判为 falsified', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const failed = await writeRun(root, {
      id: RUN, target, status: 'failed', provenance: {},
      exitCode: 1, acceptedExitCodes: [0], state: stateFixture({ status: 'not_needed' }),
    })
    const timedOut = await writeRun(root, { id: 'RUN-20261001T000100Z-r001-02', target, status: 'timed_out', exitCode: null })
    await writeRoute(root, { id: 'R-001', status: 'blocked', targetIds: ['T-001'], resumeWhen: '排除失败原因后重试', evidence: [RUN] })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal failed')
    expectCode(seal(root, timedOut.run.id), 0, 'seal timed_out')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')

    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    assert.equal(route.status, 'blocked', '失败运行不会自动证死（仍由 Lead 判定）')
    assert.equal(route.closure, null)
  })
})

test('failed（中断）：interrupted 必须有恢复评估，否则 check 给出具体拒绝（A18）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    // 完全没有 state：validator 的干净诊断是 "interrupted run needs recovery state"。
    await writeRun(root, { id: RUN, target, status: 'interrupted', state: null, provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'paused', targetIds: ['T-001'], resumeWhen: '恢复中断实验', evidence: [RUN] })
    await writeProject(root)
    expectCode(index(root), 0, 'index')

    const rejected = checkProject(root, ['--hashes'])
    expectCode(rejected, 1, 'interrupted 无 state')
    expectStderrIncludes(rejected, 'interrupted run needs recovery state', '中断恢复状态')

    // 补上 state + recovery 后仍要先过 seal（终态 RUN 必须封存）。
    const run = await readJson(path.join(root, 're', 'runs', RUN, 'run.json'))
    run.state = stateFixture({ status: 'pending', recovery: { at: '2026-10-01T00:30:00Z', assessment: '进程被外部终止', next_step: '重新采集并保留部分产物' } })
    await writeJson(path.join(root, 're', 'runs', RUN, 'run.json'), run)
    expectCode(seal(root, RUN), 0, '补恢复评估后 seal')
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, 'check')
  })
})

test('blocked（未开始）：没有 RUN 也可以成立，缺 resume_when 才拒绝（A18）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await writeTargets(root)
    await writeRoute(root, { id: 'R-001', status: 'blocked', targetIds: ['T-001'] })
    await writeProject(root)
    expectCode(index(root), 0, 'index')

    const rejected = checkProject(root, [])
    expectCode(rejected, 1, 'blocked 缺 resume_when')
    expectStderrIncludes(rejected, 'R-001: missing resume_when', '阻塞恢复条件')

    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    route.resume_when = '取得样本后恢复'
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, '未开始的阻塞可无 RUN')
    assert.equal(JSON.parse(checked.stdout).runs, 0)
  })
})

test('cancelled：取消的运行或未开始的取消都能成立（视是否发生过实验）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const cancelled = await writeRun(root, { id: RUN, target, status: 'cancelled', provenance: {} })
    await writeRoute(root, { id: 'R-001', status: 'paused', targetIds: ['T-001'], resumeWhen: '需求重启时恢复', evidence: [RUN] })
    await writeRoute(root, { id: 'R-002', status: 'blocked', targetIds: ['T-001'], resumeWhen: '问题被替代前的阻塞' })
    await writeProject(root)
    expectCode(seal(root, RUN), 0, 'seal cancelled')
    expectCode(index(root), 0, 'index')
    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, 'check')
    assert.equal(JSON.parse(checked.stdout).runs, 1, '未开始的取消没有 RUN')
    assert.equal(cancelled.run.status, 'cancelled')
  })
})

test('门槛可达成：闭环项目真的能通过 check --hashes --complete', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const run = await writeRun(root, { id: RUN, target, provenance: {} })
    await writeRoute(root, {
      id: 'R-001', status: 'validated', targetIds: ['T-001'], evidence: [RUN],
      closure: { summary: '占位目标只含文本', scope: 'T-001', limitations: '仅静态读取', evidence: [RUN] },
    })
    await writeProject(root, {
      goal: 'L2 验证完成门槛可达',
      scope: '仅临时项目与非可执行测试数据',
      acceptance: [{
        id: 'A-001', requirement: '目标身份与内容有可复算锚点', target_ids: ['T-001'], status: 'met',
        evidence: [RUN], min_independent_sources: 1,
        deliverables: [{ path: run.run.artifacts[0].path, sha256: run.run.artifacts[0].sha256 }],
        reason: '独立复算 sha256 一致',
      }],
    })
    expectCode(seal(root, RUN), 0, 'seal')
    await writeAuditFromCli(root)
    expectCode(index(root), 0, 'index')

    const checked = checkProject(root, ['--hashes', '--complete'])
    expectCode(checked, 0, 'check --hashes --complete')
    const json = JSON.parse(checked.stdout)
    assert.equal(json.completion_checked, true)
    assert.equal(json.audit_pending, false)
    assert.equal(json.pending_reviews, 0)
  })
})
