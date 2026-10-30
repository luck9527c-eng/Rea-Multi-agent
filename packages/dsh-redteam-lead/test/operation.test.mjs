import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from '../dist/errors.js'
import { ok } from '../dist/envelope.js'
import {
  OPERATION_PHASES,
  OPERATIONS_DIR,
  createOperationLedger,
  operationRecordPath,
} from '../dist/operation.js'
import { makeTempProject } from './helpers/tmp.mjs'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** 固定时钟，断言时间戳可复现。 */
const clock = {
  now: () => Date.parse('2026-10-29T08:00:00.000Z'),
  isoNow: () => '2026-10-29T08:00:00.000Z',
}

function ledgerFor(root) {
  return createOperationLedger({ root, clock })
}

test('阶段枚举与契约表逐字一致（prepared…needs_recovery）', () => {
  assert.deepEqual(
    [...OPERATION_PHASES],
    [
      'prepared',
      'member_ready',
      'task_created',
      'assigned',
      'delivered',
      'integrating',
      'facts_committed',
      'completed',
      'needs_recovery',
    ],
  )
  assert.equal(OPERATIONS_DIR, 're/team/operations')
})

test('prepare 首次登记：落盘契约快照、阶段与空结果', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    const { record, resumed, replayed } = await ledger.prepare('op-1', HASH_A, 'prepared', {
      contract_ref: 're/team/dispatches/D-0001/contract.json',
    })

    assert.equal(resumed, false)
    assert.equal(replayed, false)
    assert.equal(record.operation_id, 'op-1')
    assert.equal(record.input_hash, HASH_A)
    assert.equal(record.phase, 'prepared')
    assert.deepEqual(record.data, { contract_ref: 're/team/dispatches/D-0001/contract.json' })
    assert.equal(record.result, null)
    assert.deepEqual(record.history, [{ phase: 'prepared', at: clock.isoNow() }])

    const onDisk = JSON.parse(await readFile(operationRecordPath(project.root, 'op-1'), 'utf8'))
    assert.deepEqual(onDisk, record)
    assert.equal(operationRecordPath(project.root, 'op-1'), join(project.root, 're', 'team', 'operations', 'op-1.json'))
  } finally {
    await project.dispose()
  }
})

test('prepare 同 ID 同哈希：恢复既有台账，不重复追加历史', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-2', HASH_A, 'prepared')
    await ledger.advance('op-2', 'task_created', { task_id: 'task-1' })

    const resumed = await ledger.prepare('op-2', HASH_A, 'prepared')
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.record.phase, 'task_created')
    assert.equal(resumed.record.data.task_id, 'task-1')
    assert.equal(resumed.record.history.length, 2, '恢复不得追加重复历史')

    const reread = await ledgerFor(project.root).findById('op-2')
    assert.equal(reread.phase, 'task_created')
  } finally {
    await project.dispose()
  }
})

test('prepare 同 ID 不同哈希：OPERATION_CONFLICT 且不改写台账', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-3', HASH_A)

    await assert.rejects(
      () => ledger.prepare('op-3', HASH_B),
      (error) => {
        assert.ok(error instanceof ContractError)
        assert.equal(error.code, 'OPERATION_CONFLICT')
        assert.equal(error.details.input_hash, HASH_A)
        assert.equal(error.details.conflicting_input_hash, HASH_B)
        return true
      },
    )

    const record = await ledger.findById('op-3')
    assert.equal(record.input_hash, HASH_A)
  } finally {
    await project.dispose()
  }
})

test('advance 持久化阶段与数据，并累积历史', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-4', HASH_A)

    const afterTask = await ledger.advance('op-4', 'task_created', { task_id: 'task-9' })
    assert.equal(afterTask.phase, 'task_created')

    const afterAssigned = await ledger.advance('op-4', 'assigned', { owner: 'rt-binary-diff', revision: 1 })
    assert.equal(afterAssigned.phase, 'assigned')
    assert.deepEqual(afterAssigned.data, { task_id: 'task-9', owner: 'rt-binary-diff', revision: 1 })
    assert.deepEqual(
      afterAssigned.history.map((entry) => entry.phase),
      ['prepared', 'task_created', 'assigned'],
    )

    // 换一个台账实例重读：阶段与数据都要在盘上
    const reread = await ledgerFor(project.root).findById('op-4')
    assert.equal(reread.phase, 'assigned')
    assert.equal(reread.data.owner, 'rt-binary-diff')
  } finally {
    await project.dispose()
  }
})

test('advance 拒绝未登记阶段与未知 operation', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-5', HASH_A)

    await assert.rejects(
      () => ledger.advance('op-5', 'almost_done'),
      (error) => error instanceof ContractError && error.code === 'INVALID_ARGUMENT',
    )

    await assert.rejects(
      () => ledger.advance('op-unknown', 'assigned'),
      (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
    )
  } finally {
    await project.dispose()
  }
})

test('台账支持 needs_recovery 阶段（失败点可记录、可继续）', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-6', HASH_A, 'prepared')
    await ledger.advance('op-6', 'needs_recovery', { failed_at: 'assigned', last_known_task: 'task-1' })

    const record = await ledger.findById('op-6')
    assert.equal(record.phase, 'needs_recovery')
    assert.equal(record.data.last_known_task, 'task-1')

    // 恢复路径可以回到更早阶段继续（前向修复，不回滚证据）
    const resumed = await ledger.advance('op-6', 'assigned', { owner: 'rt-binary-diff' })
    assert.equal(resumed.phase, 'assigned')
    assert.equal(resumed.data.failed_at, 'assigned', '前序数据保留')
  } finally {
    await project.dispose()
  }
})

test('replayResult 返回原结果并标记 replayed=true', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-7', HASH_A)

    const original = ok({ operationId: 'op-7', data: { action: 'bind', binding_ref: 're/team/binding.json' } })
    await ledger.saveResult('op-7', original)

    const replayed = await ledger.replayResult('op-7')
    assert.deepEqual(replayed, { ...original, replayed: true })

    const stored = await ledgerFor(project.root).replayResult('op-7')
    assert.equal(stored.replayed, true)
    assert.deepEqual(stored.data, original.data)
  } finally {
    await project.dispose()
  }
})

test('replayResult 对未完成操作返回 null', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await ledger.prepare('op-8', HASH_A)
    assert.equal(await ledger.replayResult('op-8'), null)
    assert.equal(await ledger.replayResult('op-missing'), null)
  } finally {
    await project.dispose()
  }
})

test('损坏的台账文件抛 RECOVERY_REQUIRED，不静默当成新操作', async () => {
  const project = await makeTempProject()
  try {
    const dir = join(project.root, 're', 'team', 'operations')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'op-9.json'), '{ 坏掉的 JSON')

    const ledger = ledgerFor(project.root)
    await assert.rejects(
      () => ledger.findById('op-9'),
      (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
    )
    await assert.rejects(
      () => ledger.prepare('op-9', HASH_A),
      (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
    )
  } finally {
    await project.dispose()
  }
})

test('prepare 拒绝非法 operation id 与非法哈希', async () => {
  const project = await makeTempProject()
  try {
    const ledger = ledgerFor(project.root)
    await assert.rejects(
      () => ledger.prepare('Op Bad', HASH_A),
      (error) => error instanceof ContractError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => ledger.prepare('op-10', 'not-a-hash'),
      (error) => error instanceof ContractError && error.code === 'INVALID_ARGUMENT',
    )
  } finally {
    await project.dispose()
  }
})
