/**
 * T6 `src/resources.mjs`：`re/team/resources.json` 的资源租用与隔离。
 *
 * 契约（编排契约「路径、锁与资源」）：
 * - 相同物理实例的别名归一为同一 `resource_key`；默认独占。
 * - 只有登记为不可变读取且无状态写才 `shared_read`。
 * - 未知实例或缺映射 → `RESOURCE_BINDING_MISSING`；冲突 → `RESOURCE_BUSY`。
 * - `quarantined` 资源不可再分配（A22/A33）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as atomic from '../src/atomic.mjs'
import * as resources from '../src/resources.mjs'
import { ContractError } from '../src/errors.mjs'
import { makeTempProject } from './helpers/host.mjs'

const NOW = '2026-10-29T08:00:00.000Z'
const clock = { now: () => Date.parse(NOW), isoNow: () => NOW }

function aliasOf(physicalIdentity, immutableRead = false) {
  return { physical_identity: physicalIdentity, immutable_read: immutableRead }
}

async function registryOf(project, aliases = {}, leases = []) {
  const payload = { schema_version: 1, revision: 0, aliases, leases }
  await project.write('re/team/resources.json', payload)
  return payload
}

async function readRegistryFile(project) {
  return JSON.parse(await readFile(join(project.root, 're', 'team', 'resources.json'), 'utf8'))
}

test('别名归一：同一物理实例的两个别名第二次独占租用 → RESOURCE_BUSY', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, {
    'ghidra-a': aliasOf('pid:4242'),
    'ghidra-b': aliasOf('pid:4242'),
  })

  const first = await resources.reserveResources({
    root: project.root,
    needs: [{ resource_key: 'ghidra-a', mode: 'exclusive' }],
    dispatchId: 'D-1',
    attemptId: 'A-000001',
    clock,
    atomic,
  })
  assert.equal(first.ok, true)
  assert.equal(first.leases[0].physical_identity, 'pid:4242')
  assert.equal(first.leases[0].state, 'reserved')
  assert.equal(first.leases[0].mode, 'exclusive')
  assert.equal(first.leases[0].generation, 1)

  const second = await resources.reserveResources({
    root: project.root,
    needs: [{ resource_key: 'ghidra-b', mode: 'exclusive' }],
    dispatchId: 'D-2',
    attemptId: 'A-000001',
    clock,
    atomic,
  })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'RESOURCE_BUSY')
  assert.ok(second.diagnostics[0].reason.includes('pid:4242'), '诊断要点名物理实例')

  // 拒绝时不得写入任何租约
  const onDisk = await readRegistryFile(project)
  assert.equal(onDisk.leases.length, 1)
})

test('不同物理实例可以并行独占', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { 'a': aliasOf('pid:1'), 'b': aliasOf('pid:2') })

  const first = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'a', mode: 'exclusive' }],
    dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  const second = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'b', mode: 'exclusive' }],
    dispatchId: 'D-2', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  const onDisk = await readRegistryFile(project)
  assert.deepEqual(onDisk.leases.map((lease) => lease.resource_key).sort(), ['a', 'b'])
})

test('未知实例 / 缺别名映射 → RESOURCE_BINDING_MISSING，且不落租约', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, {})

  const result = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'unregistered-db', mode: 'exclusive' }],
    dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RESOURCE_BINDING_MISSING')
  assert.ok(result.diagnostics[0].next_step.length > 0)

  const onDisk = await readRegistryFile(project)
  assert.equal(onDisk.leases.length, 0)
})

test('默认独占：未登记为不可变读取的 shared_read 降级为独占并记 gap', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { 'db': aliasOf('pid:9', false) })

  const result = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'db', mode: 'shared_read' }],
    dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(result.ok, true)
  assert.equal(result.leases[0].mode, 'exclusive', '未登记不可变读取时不得共享读')
  assert.ok(result.gaps.some((gap) => gap.code === 'RESOURCE_MODE_DOWNGRADED'))
})

test('登记为不可变读取的 shared_read 可以并行', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { 'sample': aliasOf('file:T-001', true) })

  const first = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'sample', mode: 'shared_read' }],
    dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  const second = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'sample', mode: 'shared_read' }],
    dispatchId: 'D-2', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.leases[0].mode, 'shared_read')
  assert.equal(second.leases[0].mode, 'shared_read')

  // 独占请求与已存在的共享读冲突
  const exclusive = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'sample', mode: 'exclusive' }],
    dispatchId: 'D-3', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(exclusive.ok, false)
  assert.equal(exclusive.code, 'RESOURCE_BUSY')
})

test('quarantined 资源不可再分配（RESOURCE_BUSY），恢复依据后才回到 released', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { 'db': aliasOf('pid:77') }, [{
    resource_key: 'db',
    physical_identity: 'pid:77',
    mode: 'exclusive',
    dispatch_id: 'D-old',
    attempt_id: 'A-000001',
    generation: 1,
    state: 'quarantined',
    recovery_ref: 're/team/recovery/D-old.md',
    acquired_at: NOW,
  }])

  const blocked = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'db', mode: 'exclusive' }],
    dispatchId: 'D-new', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'RESOURCE_BUSY')
  assert.match(blocked.diagnostics[0].reason, /quarantined/u)

  const released = await resources.releaseResources({
    root: project.root, dispatchId: 'D-old', attemptId: 'A-000001', clock, atomic,
    note: '已核实端口与后台任务结束',
  })
  assert.equal(released.ok, true)

  const allowed = await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'db', mode: 'exclusive' }],
    dispatchId: 'D-new', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.leases[0].generation, 2, '同一 resource_key 的代次必须递增')
})

test('同一 dispatch/attempt 重复租用是幂等的', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { 'db': aliasOf('pid:5') })

  const need = [{ resource_key: 'db', mode: 'exclusive' }]
  const first = await resources.reserveResources({
    root: project.root, needs: need, dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  const again = await resources.reserveResources({
    root: project.root, needs: need, dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(first.ok, true)
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
  const onDisk = await readRegistryFile(project)
  assert.equal(onDisk.leases.length, 1)
  assert.equal(onDisk.leases[0].generation, 1)
})

test('registry JSON 损坏 → RECOVERY_REQUIRED（不能当作没有资源）', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/resources.json', '{not json')

  await assert.rejects(
    () => resources.reserveResources({
      root: project.root, needs: [{ resource_key: 'db', mode: 'exclusive' }],
      dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
    }),
    (error) => error instanceof ContractError && error.code === 'RECOVERY_REQUIRED',
  )
})

test('normalizeResourceNeeds：同 key 取最严模式，空需求合法', () => {
  const normalized = resources.normalizeResourceNeeds([
    { resource_key: 'db', mode: 'shared_read' },
    { resource_key: 'db', mode: 'exclusive' },
    { resource_key: 'sample', mode: 'shared_read' },
  ])
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.needs, [
    { resource_key: 'db', mode: 'exclusive' },
    { resource_key: 'sample', mode: 'shared_read' },
  ])

  assert.deepEqual(resources.normalizeResourceNeeds([]).needs, [])

  const bad = resources.normalizeResourceNeeds([{ resource_key: '', mode: 'exclusive' }])
  assert.equal(bad.ok, false)
  assert.equal(bad.issues[0].code, 'INVALID_ARGUMENT')

  const badMode = resources.normalizeResourceNeeds([{ resource_key: 'db', mode: 'mutate' }])
  assert.equal(badMode.ok, false)
})

test('releaseResources：只释放自己的租约，不碰别人的', async (t) => {
  const project = makeTempProject({ t })
  await registryOf(project, { a: aliasOf('pid:1'), b: aliasOf('pid:2') })

  await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'a', mode: 'exclusive' }],
    dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  await resources.reserveResources({
    root: project.root, needs: [{ resource_key: 'b', mode: 'exclusive' }],
    dispatchId: 'D-2', attemptId: 'A-000001', clock, atomic,
  })

  const released = await resources.releaseResources({
    root: project.root, dispatchId: 'D-1', attemptId: 'A-000001', clock, atomic,
  })
  assert.equal(released.ok, true)
  assert.deepEqual(released.released.map((lease) => lease.resource_key), ['a'])

  const onDisk = await readRegistryFile(project)
  assert.equal(onDisk.leases.find((lease) => lease.resource_key === 'a').state, 'released')
  assert.equal(onDisk.leases.find((lease) => lease.resource_key === 'b').state, 'reserved')
})
