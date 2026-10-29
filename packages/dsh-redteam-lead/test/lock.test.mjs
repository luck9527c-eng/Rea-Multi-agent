import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from '../dist/errors.js'
import { LOCK_PATH, acquire, isStale, ownProcessIdentity, readLock, release, staleReasons } from '../dist/lock.js'
import { makeTempProject } from './helpers/tmp.mjs'

/** 固定假时钟，用来断言「过期不等于自动解锁」。 */
const FIXED_NOW = Date.parse('2026-10-29T08:00:00.000Z')
const clock = () => FIXED_NOW

function lockFile(root) {
  return join(root, 're', 'team', 'lock')
}

test('acquire 原子创建锁，内容含 project/session/nonce/PID/启动身份/operation', async () => {
  const project = await makeTempProject()
  try {
    const { acquired, record } = await acquire(project.root, {
      session: 'session-1',
      operation: 'op-dispatch-1',
      ownerNonce: 'nonce-a',
      now: clock,
    })

    assert.equal(acquired, true)
    assert.equal(record.project, project.root)
    assert.equal(record.session, 'session-1')
    assert.equal(record.owner_nonce, 'nonce-a')
    assert.equal(record.operation, 'op-dispatch-1')
    assert.equal(typeof record.pid, 'number')
    assert.equal(typeof record.process_start_ms, 'number')
    assert.equal(record.acquired_at, new Date(FIXED_NOW).toISOString())

    const onDisk = JSON.parse(await readFile(lockFile(project.root), 'utf8'))
    assert.deepEqual(onDisk, record)
    assert.equal(LOCK_PATH, 're/team/lock')
  } finally {
    await project.dispose()
  }
})

test('并发第二次获取返回 PROJECT_BUSY，并报告持有者', async () => {
  const project = await makeTempProject()
  try {
    await acquire(project.root, { session: 'session-1', operation: 'op-a', ownerNonce: 'nonce-a', now: clock })

    await assert.rejects(
      () => acquire(project.root, { session: 'session-2', operation: 'op-b', ownerNonce: 'nonce-b', now: clock }),
      (error) => {
        assert.ok(error instanceof ContractError)
        assert.equal(error.code, 'PROJECT_BUSY')
        assert.equal(error.details.holder.session, 'session-1')
        assert.equal(error.details.holder.operation, 'op-a')
        return true
      },
    )

    const record = await readLock(project.root)
    assert.equal(record.owner_nonce, 'nonce-a', '被拒绝的获取不得改写既有锁')
  } finally {
    await project.dispose()
  }
})

test('release 只允许持有者释放，非持有者得到 PROJECT_BUSY', async () => {
  const project = await makeTempProject()
  try {
    await acquire(project.root, { session: 'session-1', ownerNonce: 'nonce-a', now: clock })

    await assert.rejects(
      () => release(project.root, { ownerNonce: 'nonce-b' }),
      (error) => error instanceof ContractError && error.code === 'PROJECT_BUSY',
    )

    const released = await release(project.root, { ownerNonce: 'nonce-a' })
    assert.equal(released.released, true)
    assert.equal(released.forced, false)
    assert.equal(await readLock(project.root), null)

    const again = await release(project.root, { ownerNonce: 'nonce-a' })
    assert.equal(again.released, false, '释放是幂等的')
  } finally {
    await project.dispose()
  }
})

test('release(force) 必须在显式恢复路径调用并带 recoveryRef', async () => {
  const project = await makeTempProject()
  try {
    await acquire(project.root, { session: 'session-1', ownerNonce: 'nonce-a', now: clock })

    await assert.rejects(
      () => release(project.root, { force: true }),
      (error) => error instanceof ContractError && error.code === 'INVALID_ARGUMENT',
    )

    const forced = await release(project.root, { force: true, recoveryRef: 're/team/recovery/op-a.md' })
    assert.equal(forced.released, true)
    assert.equal(forced.forced, true)
    assert.equal(forced.previous.owner_nonce, 'nonce-a')
    assert.equal(await readLock(project.root), null)
  } finally {
    await project.dispose()
  }
})

test('isStale 只报告不释放：过期 + 进程已死仍返回 PROJECT_BUSY', async () => {
  const project = await makeTempProject()
  try {
    await acquire(project.root, {
      session: 'session-1',
      ownerNonce: 'nonce-a',
      now: clock,
      ttlMs: 1000,
      pid: 424242,
      processStartMs: FIXED_NOW,
    })

    const later = () => FIXED_NOW + 60_000
    const record = await readLock(project.root)
    assert.deepEqual(staleReasons(record, { now: later, isAlive: () => false }).sort(), [
      'expired',
      'process_dead',
    ])
    assert.equal(isStale(record, { now: later, isAlive: () => false }), true)
    assert.equal(isStale(record, { now: () => FIXED_NOW, isAlive: () => true }), false)

    // 关键：即使 isStale 为真，acquire 也不会自动抢锁
    await assert.rejects(
      () => acquire(project.root, { session: 'session-2', ownerNonce: 'nonce-b', now: later }),
      (error) => error instanceof ContractError && error.code === 'PROJECT_BUSY',
    )
    assert.notEqual(await readLock(project.root), null, '锁必须仍然存在，等待显式恢复清理')
  } finally {
    await project.dispose()
  }
})

test('isStale 可结合进程启动身份识别 PID 复用', async () => {
  const record = { pid: 1000, process_start_ms: 5_000, expires_at: null }

  assert.deepEqual(staleReasons(record, { now: () => 0, isAlive: () => true, processStart: () => 5_000 }), [])
  assert.deepEqual(staleReasons(record, { now: () => 0, isAlive: () => true, processStart: () => 9_999 }), [
    'pid_reused',
  ])
})

test('readLock 对缺失返回 null，对损坏内容抛 RECOVERY_REQUIRED', async () => {
  const project = await makeTempProject()
  try {
    assert.equal(await readLock(project.root), null)

    await writeFile(lockFile(project.root), '{ 不是 JSON')
    await assert.rejects(
      () => readLock(project.root),
      (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
    )

    // 损坏的锁仍然阻止获取（不能当作没锁）
    await assert.rejects(
      () => acquire(project.root, { session: 's', ownerNonce: 'n', now: clock }),
      (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
    )
  } finally {
    await project.dispose()
  }
})

test('acquire 拒绝空的 session，并可用注入的进程身份落盘', async () => {
  const project = await makeTempProject()
  try {
    await assert.rejects(
      () => acquire(project.root, { session: '', ownerNonce: 'n', now: clock }),
      (error) => error instanceof ContractError && error.code === 'INVALID_ARGUMENT',
    )

    const { record } = await acquire(project.root, { session: 's-1', ownerNonce: 'n', now: clock, pid: 777, processStartMs: 123 })
    assert.equal(record.pid, 777)
    assert.equal(record.process_start_ms, 123)
    assert.equal((await stat(lockFile(project.root))).isFile(), true)
  } finally {
    await project.dispose()
  }
})

test('ownProcessIdentity 给出本进程 PID 与近似启动时刻', () => {
  const identity = ownProcessIdentity({ now: () => 1_000_000, uptime: () => 10 })
  assert.equal(identity.pid, process.pid)
  assert.equal(identity.start_ms, 990_000)
})
