/**
 * L2 · 跨路线影响（A30）。
 *
 * 场景：工兵 B 的 RUN 把共享条件 C-001 升到新版本；真实 `impact` 必须报出
 * 直接消费方 B 与下游路线 A（含 `via` 路径），且**不**清除 A 的旧 closure。
 * 未复核的影响不阻止普通 `check`，但阻止 `check --hashes --complete`。
 * 另外覆盖：open 争议对活动路线的硬门，以及 `impact` 不做结构校验（skill 事实）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject, writeCondition,
  seal, index, checkProject, parseCheck, parseJsonOutput, expectCode, expectStderrIncludes,
  readJson, writeJson, sha256File, projectCli, writeAuditFromCli,
} from './helpers.mjs'

const RUN_A = 'RUN-20261001T000000Z-ra01-01'
const RUN_B = 'RUN-20261001T000300Z-rb01-01'

/** 两条 validated 路线：B 消费 C-001，A 依赖 B（下游）。 */
async function conditionFixture(root) {
  const target = await writeTargets(root)
  const runA = await writeRun(root, { id: RUN_A, routeId: 'R-A', target, provenance: {},
    startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:10:00Z' })
  const runB = await writeRun(root, { id: RUN_B, routeId: 'R-B', target, provenance: {},
    startedAt: '2026-10-01T00:20:00Z', endedAt: '2026-10-01T00:30:00Z' })
  await writeRoute(root, {
    id: 'R-A', status: 'validated', targetIds: ['T-001'], dependsOn: ['R-B'],
    evidence: [RUN_A],
    closure: { summary: 'A 结论', scope: 'T-001', limitations: '仅静态', evidence: [RUN_A] },
  })
  await writeRoute(root, {
    id: 'R-B', status: 'validated', targetIds: ['T-001'], conditionIds: ['C-001'],
    evidence: [RUN_B],
    closure: { summary: 'B 结论', scope: 'T-001', limitations: '仅静态', evidence: [RUN_B] },
  })
  return { target, runA, runB }
}

test('B 的 RUN 更新 C：真实 impact 报出 B（direct）与 A（downstream），旧 closure 原样保留（A30）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    await conditionFixture(root)
    // 条件升到第 2 版（由 B 的 RUN 支撑）。
    await writeCondition(root, { id: 'C-001', revision: 2, state: 'satisfied', evidence: [RUN_B] })
    await writeProject(root)

    const routeAPath = path.join(root, 're', 'routes', 'R-A.json')
    const routeBPath = path.join(root, 're', 'routes', 'R-B.json')
    const aBefore = sha256File(routeAPath)
    const bBefore = sha256File(routeBPath)
    const aClosureBefore = (await readJson(routeAPath)).closure

    const result = projectCli(root, ['impact', root])
    expectCode(result, 0, 'impact')
    const report = parseJsonOutput(result, 'impact')

    const rows = report.pending_reviews
    assert.equal(rows.length, 2, '每条受影响路线一行')
    const byRoute = Object.fromEntries(rows.map((row) => [row.route_id, row]))
    assert.deepEqual(byRoute['R-B'], {
      condition_id: 'C-001',
      revision: 2,
      condition_state: 'satisfied',
      route_id: 'R-B',
      route_status: 'validated',
      relation: 'direct',
      via: ['R-B'],
      last_reviewed_revision: null,
      review_outcome: 'unreviewed',
      trigger_evidence: [RUN_B],
      next_step: 'Assess scope and define the minimal retest',
    })
    assert.equal(byRoute['R-A'].relation, 'downstream', 'A 通过 depends_on 被波及')
    assert.deepEqual(byRoute['R-A'].via, ['R-B', 'R-A'], 'via 给出影响路径')
    assert.equal(byRoute['R-A'].condition_state, 'satisfied')
    assert.equal(byRoute['R-A'].trigger_evidence[0], RUN_B)

    // impact 是纯读：路线字节不变，A 的旧 closure 仍保留（不得因新条件而被清空）。
    assert.equal(sha256File(routeAPath), aBefore, 'impact 不改路线文件')
    assert.equal(sha256File(routeBPath), bBefore)
    const aAfter = await readJson(routeAPath)
    assert.equal(aAfter.status, 'validated', '旧判定保留，等待人工处置')
    assert.deepEqual(aAfter.closure, aClosureBefore, '旧 closure 原样保留')
  })
})

test('未复核的影响不阻止 check --hashes，但阻止 check --hashes --complete（A30/A35）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const { runA } = await conditionFixture(root)
    await writeCondition(root, { id: 'C-001', revision: 2, state: 'satisfied', evidence: [RUN_B] })
    await writeProject(root, {
      acceptance: [{
        id: 'A-001', requirement: 'A 路线有可复算锚点', target_ids: ['T-001'], status: 'met',
        evidence: [RUN_A], min_independent_sources: 1,
        deliverables: [{ path: runA.run.artifacts[0].path, sha256: runA.run.artifacts[0].sha256 }],
        reason: '哈希一致',
      }],
    })
    expectCode(seal(root, RUN_A), 0, 'seal A')
    expectCode(seal(root, RUN_B), 0, 'seal B')
    // 审计覆盖当前范围，把失败点隔离到"待复查"本身。
    await writeAuditFromCli(root)
    expectCode(index(root), 0, 'index')

    const plain = checkProject(root, ['--hashes'])
    expectCode(plain, 0, 'check --hashes')
    assert.equal(parseCheck(plain).pending_reviews, 2, 'check 自己报告待复查数量')

    const complete = checkProject(root, ['--hashes', '--complete'])
    expectCode(complete, 1, 'check --hashes --complete')
    expectStderrIncludes(complete, 'completion: association audit/reviews pending', '待复查阻止完成')
  })
})

test('open 争议影响活动路线：真实 check 拒绝；impact 给出 dispute_impacts；处置后放行（A30）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const supporting = await writeRun(root, { id: RUN_A, routeId: 'R-001', target, provenance: {},
      startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:10:00Z' })
    const contradicting = await writeRun(root, { id: RUN_B, routeId: 'R-001', target, provenance: {},
      startedAt: '2026-10-01T00:20:00Z', endedAt: '2026-10-01T00:30:00Z' })
    await writeRoute(root, { id: 'R-001', status: 'active', targetIds: ['T-001'], evidence: [RUN_A, RUN_B] })
    // 证据先按顺序封存（seal 会跑全项目校验，所以争议必须在事实稳定之后再登记）。
    expectCode(seal(root, RUN_A), 0, 'seal 支撑证据')
    expectCode(seal(root, RUN_B), 0, 'seal 反证')
    await writeProject(root, {
      disputes: [{
        id: 'D-001', claim: '两次采集结论互相矛盾', scope: 'T-001 的占位读取',
        route_ids: ['R-001'], critical: true,
        supporting: [RUN_A], contradicting: [RUN_B], status: 'open',
      }],
    })
    expectCode(index(root), 0, 'index')

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 1, 'open 争议 + 活动路线')
    expectStderrIncludes(checked, 'open dispute affects this active route/dependency; block or pause it pending review', '争议门')

    const impact = projectCli(root, ['impact', root])
    expectCode(impact, 0, 'impact')
    const report = parseJsonOutput(impact, 'impact')
    assert.deepEqual(report.dispute_impacts, [{
      dispute_id: 'D-001', route_id: 'R-001', route_status: 'active', via: ['R-001'], relation: 'direct',
    }])

    // 处置：把路线暂停（须写 resume_when），争议保留但不再阻挡当前状态。
    const route = await readJson(path.join(root, 're', 'routes', 'R-001.json'))
    route.status = 'paused'
    route.resume_when = '争议核实后恢复'
    route.history.push({
      at: '2026-10-01T01:00:00Z', from: 'active', to: 'paused',
      reason: 'open 争议 D-001 待复核，先暂停', evidence: [RUN_B],
    })
    await writeJson(path.join(root, 're', 'routes', 'R-001.json'), route)
    expectCode(index(root), 0, 'index')
    expectCode(checkProject(root, ['--hashes']), 0, '处理争议后 check 通过')
  })
})

test('impact 不做结构校验：依赖未 validated 时 check 失败、impact 仍成功（skill 事实）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const run = await writeRun(root, { id: RUN_A, routeId: 'R-002', target, provenance: {} })
    await writeRoute(root, { id: 'R-002', status: 'planned', targetIds: ['T-001'], evidence: [RUN_A] })
    await writeRoute(root, { id: 'R-003', status: 'planned', targetIds: ['T-001'] })
    await writeProject(root)
    expectCode(seal(root, RUN_A), 0, 'seal')

    // 事实变化后再评：R-002 进入 active 且依赖仍未 validated 的 R-003。
    const route = await readJson(path.join(root, 're', 'routes', 'R-002.json'))
    route.status = 'active'
    route.depends_on = ['R-003']
    route.history.push({
      at: '2026-10-01T00:20:00Z', from: 'planned', to: 'active', reason: '开始执行（依赖尚未满足）', evidence: [RUN_A],
    })
    await writeJson(path.join(root, 're', 'routes', 'R-002.json'), route)
    expectCode(index(root), 0, 'index')

    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 1, 'check 拒绝未满足的依赖')
    expectStderrIncludes(checked, 'R-002: dependency R-003 not validated', '依赖门')

    // E3 §4.7：impact / audit-scope 是纯派生，不调用 validate()，结构坏了也照常输出。
    const impact = projectCli(root, ['impact', root])
    expectCode(impact, 0, 'impact 不校验结构')
    assert.deepEqual(parseJsonOutput(impact, 'impact').pending_reviews, [])
    expectCode(projectCli(root, ['audit-scope', root]), 0, 'audit-scope 不校验结构')
  })
})
