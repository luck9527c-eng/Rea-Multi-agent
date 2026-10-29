/**
 * L2 · 整合锁与唯一整合者（A21）。
 *
 * skill 自己**不提供**任何锁或事务（E3 §8.4：`re/team/lock` 由插件提供），
 * 所以这里验证插件锁与真实 CLI 的组合：
 * - 两个 Lead 并发 → 只有一个取得整合锁，另一个 `PROJECT_BUSY`；
 * - 锁持有者崩溃（过期 + 进程死亡）→ **只报告** stale，不自动夺锁；
 *   显式恢复必须给 `recoveryRef`，之后才能重新取得；
 * - 串行窗口：两个整合任务在锁内各跑一次真实 `seal`，最终 `check --hashes` 通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  environment, withProject, writeTargets, writeRoute, writeRun, writeProject,
  seal, index, checkProject, parseCheck, readJson, expectCode,
} from './helpers.mjs'
import { acquire, isStale, readLock, release, staleReasons } from '../../dist/lock.js'

const RUN_A = 'RUN-20261001T000000Z-r001-01'
const RUN_B = 'RUN-20261001T000100Z-r001-02'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 断言被拒绝的 Promise 带指定契约码，并返回错误对象。 */
async function rejectionCode(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `${label}: 期望 ${code}，实际 ${error.code}（${error.message}）`)
    return error
  }
  throw new Error(`${label}: 期望被拒绝（${code}），实际成功`)
}

test('两个 Lead 并发取得整合锁：只有一个成功，另一个 PROJECT_BUSY（A21）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const results = await Promise.allSettled([
      acquire(root, { session: 'lead-a', ownerNonce: 'nonce-a', pid: process.pid, ttlMs: 60_000 }),
      acquire(root, { session: 'lead-b', ownerNonce: 'nonce-b', pid: process.pid, ttlMs: 60_000 }),
    ])
    const winners = results.filter((result) => result.status === 'fulfilled')
    const losers = results.filter((result) => result.status === 'rejected')
    assert.equal(winners.length, 1, '同一时刻只允许一个整合者')
    assert.equal(losers.length, 1)
    assert.equal(losers[0].reason.code, 'PROJECT_BUSY')

    const record = await readLock(root)
    assert.equal(record.owner_nonce, winners[0].value.record.owner_nonce)
    assert.equal(record.project, root)
    assert.equal(record.expires_at !== null, true, 'TTL 必须写进锁记录')

    // 同一持有者重入也要走显式路径：锁不是可重入互斥量。
    await rejectionCode(
      acquire(root, { session: 'lead-a', ownerNonce: 'nonce-a', pid: process.pid }),
      'PROJECT_BUSY',
      '重复 acquire',
    )
  })
})

test('锁持有者崩溃：只报告 stale，不因过期夺锁；显式恢复必须给 recoveryRef（A21）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const past = Date.now() - 60_000
    await acquire(root, {
      session: 'lead-crashed',
      ownerNonce: 'nonce-dead',
      pid: 999_999, // 不存在的进程：模拟持有者崩溃
      operation: 'op-l2-crash',
      ttlMs: 1_000,
      now: past,
    })
    const record = await readLock(root)
    assert.deepEqual(staleReasons(record, { now: Date.now() }), ['expired', 'process_dead'])
    assert.equal(isStale(record, { now: Date.now() }), true)

    // 关键：stale 只是报告，acquire 不得因此抢锁。
    const busy = await rejectionCode(
      acquire(root, { session: 'lead-next', ownerNonce: 'nonce-next', pid: process.pid, ttlMs: 60_000 }),
      'PROJECT_BUSY',
      'stale 后 acquire',
    )
    assert.equal(busy.details?.stale, true, '诊断必须说明持锁者已疑似失效')
    assert.equal((await readLock(root)).owner_nonce, 'nonce-dead', '未显式恢复前锁的持有者不变')

    // 显式恢复：强制释放必须带 recoveryRef（恢复核查记录的路径）。
    await rejectionCode(
      release(root, { force: true }),
      'INVALID_ARGUMENT',
      '无 recoveryRef 的强制释放',
    )
    const forced = await release(root, { force: true, recoveryRef: 're/team/receipts/recovery-001.json' })
    assert.equal(forced.released, true)
    assert.equal(forced.forced, true)
    assert.equal(forced.previous?.session, 'lead-crashed')

    const acquired = await acquire(root, { session: 'lead-next', ownerNonce: 'nonce-next', pid: process.pid, ttlMs: 60_000 })
    assert.equal(acquired.acquired, true)
    await release(root, { ownerNonce: 'nonce-next' })
    assert.equal(await readLock(root), null)
  })
})

test('串行整合窗口：两个任务在锁内各 seal 一次，真实 check --hashes 通过（A21）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    await writeRun(root, { id: RUN_A, target, provenance: {},
      startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:10:00Z' })
    await writeRun(root, { id: RUN_B, target, provenance: {},
      startedAt: '2026-10-01T00:20:00Z', endedAt: '2026-10-01T00:30:00Z' })
    await writeRoute(root, { id: 'R-001', status: 'planned', targetIds: ['T-001'], evidence: [RUN_A, RUN_B] })
    await writeProject(root)

    let holders = 0
    let maxHolders = 0
    const sealCalls = []
    /** 每个整合任务：拿锁 → 真实 seal → 释放；拿不到锁就等（不抢）。 */
    async function integrate(runId, session, nonce) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        let locked = false
        try {
          await acquire(root, { session, ownerNonce: nonce, operation: `op-l2-${nonce}`, pid: process.pid, ttlMs: 30_000 })
          locked = true
        } catch (error) {
          if (error.code !== 'PROJECT_BUSY') throw error
          await sleep(10)
          continue
        }
        try {
          holders += 1
          maxHolders = Math.max(maxHolders, holders)
          assert.equal(holders, 1, '整合窗口内只能有一个写入者')
          const result = seal(root, runId)
          sealCalls.push({ runId, result })
          return result
        } finally {
          holders -= 1
          if (locked) await release(root, { ownerNonce: nonce })
        }
      }
      throw new Error(`${session}: 在重试上限内没有取得整合锁`)
    }

    const results = await Promise.all([
      integrate(RUN_A, 'lead-1', 'nonce-1'),
      integrate(RUN_B, 'lead-2', 'nonce-2'),
    ])
    for (const result of results) expectCode(result, 0, '锁内 seal')
    assert.equal(sealCalls.length, 2, '两个 RUN 各封存一次（不重复）')
    assert.equal(maxHolders, 1, '从未有两个整合者同时持锁')
    assert.equal(await readLock(root), null, '两个任务都释放了锁')

    expectCode(index(root), 0, 'index')
    const checked = checkProject(root, ['--hashes'])
    expectCode(checked, 0, 'check --hashes')
    assert.equal(parseCheck(checked).runs, 2)
    const sealedA = await readJson(path.join(root, 're', 'seals', 'runs', `${RUN_A}.json`))
    const sealedB = await readJson(path.join(root, 're', 'seals', 'runs', `${RUN_B}.json`))
    assert.equal(sealedA.run_id, RUN_A)
    assert.equal(sealedB.run_id, RUN_B)
  })
})
