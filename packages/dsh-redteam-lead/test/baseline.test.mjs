import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

import * as atomic from '../dist/atomic.js'
import * as paths from '../dist/paths.js'
import { makeClock, makeTempProject } from './helpers/host.mjs'
import { createFakeProject } from './helpers/fake-project.mjs'
import {
  BASELINE_DIR,
  baselineRefFor,
  captureBaseline,
  compareBaseline,
  loadBaseline,
  sealRunSet,
} from '../dist/baseline.js'

const SHA = (char) => char.repeat(64)

async function projectWithTargets(t, { targetBytes = 'MZ-原始样本', sealEntries = [] } = {}) {
  const project = makeTempProject({ t })
  project.write('re/samples/app.exe', targetBytes)
  const targetHash = atomic.sha256Bytes(await fsp.readFile(path.join(project.root, 're/samples/app.exe')))
  project.write('re/targets.json', {
    schema_version: 1,
    targets: [
      {
        id: 'T-001',
        path: 're/samples/app.exe',
        sha256: targetHash,
        version: '1.0',
        platform: 'windows',
        arch: 'x64',
        source: 'sample',
      },
    ],
  })
  const root = await paths.normalizeProjectRoot(project.root)
  const adapter = createFakeProject({ projectRoot: root, seals: sealEntries })
  return { project, root, adapter, targetHash }
}

test('captureBaseline 拒绝空目标清单（首次派发仍须冻结真实目标哈希）', async (t) => {
  const { root, adapter } = await projectWithTargets(t)
  const result = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: [],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVALID_ARGUMENT')
})

test('captureBaseline 记录目标字节哈希、既有 seal（可为空）与依赖产物，并落盘', async (t) => {
  const { root, adapter, targetHash, project } = await projectWithTargets(t)
  const result = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [{ path: 're/team/dispatches/D-abc123.json', sha256: SHA('d') }],
    projectAdapter: adapter,
    clock: makeClock(Date.UTC(2026, 0, 1)),
    fs: fsp,
    paths,
    atomic,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ref, baselineRefFor('D-abc123'))
  assert.equal(result.ref, `${BASELINE_DIR}/D-abc123.json`)
  assert.deepEqual(result.baseline.targets, [{ target_id: 'T-001', path: 're/samples/app.exe', sha256: targetHash }])
  assert.deepEqual(result.baseline.preexisting_seals, [])
  assert.equal(result.baseline.captured_at, '2026-01-01T00:00:00.000Z')

  const stored = JSON.parse(await project.read(result.ref))
  assert.deepEqual(stored.targets, result.baseline.targets)
})

test('captureBaseline 把既有 seal 的路径与字节哈希冻进快照', async (t) => {
  const { root, adapter } = await projectWithTargets(t, {
    sealEntries: [{ path: 're/seals/targets/T-001.json', sha256: SHA('1'), bytes: 10 }],
  })
  const result = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.baseline.preexisting_seals, [{ path: 're/seals/targets/T-001.json', sha256: SHA('1') }])
})

test('captureBaseline 遇到目标字节与 targets.json 声明不符时拒绝冻结', async (t) => {
  const { root, adapter, project } = await projectWithTargets(t)
  project.write('re/samples/app.exe', '被换掉的样本')
  const result = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BASELINE_MISMATCH')
})

test('loadBaseline：缺失快照 → RECOVERY_REQUIRED；写好后可读回', async (t) => {
  const { root, adapter } = await projectWithTargets(t)
  const missing = await loadBaseline({ root, dispatchId: 'D-abc123', fs: fsp, paths })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'RECOVERY_REQUIRED')

  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  const loaded = await loadBaseline({ root, dispatchId: 'D-abc123', ref: captured.ref, fs: fsp, paths })
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  assert.deepEqual(loaded.baseline, captured.baseline)
})

test('compareBaseline：未变化时通过，并回报实际比较了哪些项', async (t) => {
  const { root, adapter } = await projectWithTargets(t)
  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  const result = await compareBaseline({ root, baseline: captured.baseline, projectAdapter: adapter, fs: fsp, paths })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.compared.targets, 1)
  assert.equal(result.compared.preexisting_seals, 0)
})

test('compareBaseline：目标字节被改动 → BASELINE_MISMATCH', async (t) => {
  const { root, adapter, project } = await projectWithTargets(t)
  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  project.write('re/samples/app.exe', '改了')
  const result = await compareBaseline({ root, baseline: captured.baseline, projectAdapter: adapter, fs: fsp, paths })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BASELINE_MISMATCH')
  assert.equal(result.mismatches[0].reason, 'changed')
})

test('compareBaseline：既有 seal 被删除 → BASELINE_MISMATCH（不能因为“没找到”就漏过）', async (t) => {
  const { root, adapter } = await projectWithTargets(t, {
    sealEntries: [{ path: 're/seals/runs/RUN-0.json', sha256: SHA('2'), bytes: 8 }],
  })
  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  adapter.seals.length = 0
  const result = await compareBaseline({ root, baseline: captured.baseline, projectAdapter: adapter, fs: fsp, paths })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BASELINE_MISMATCH')
  assert.equal(result.mismatches[0].reason, 'seal_missing')
})

test('compareBaseline：既有 seal 内容被改 → BASELINE_MISMATCH', async (t) => {
  const { root, adapter } = await projectWithTargets(t, {
    sealEntries: [{ path: 're/seals/runs/RUN-0.json', sha256: SHA('3'), bytes: 8 }],
  })
  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  adapter.seals[0].sha256 = SHA('4')
  const result = await compareBaseline({ root, baseline: captured.baseline, projectAdapter: adapter, fs: fsp, paths })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BASELINE_MISMATCH')
  assert.equal(result.mismatches[0].reason, 'seal_changed')
})

test('compareBaseline：依赖产物被篡改 → BASELINE_MISMATCH', async (t) => {
  const { root, adapter, project } = await projectWithTargets(t)
  project.write('re/docs/evidence.json', '{"a":1}')
  const artifactHash = atomic.sha256Bytes(await fsp.readFile(path.join(project.root, 're/docs/evidence.json')))
  const captured = await captureBaseline({
    root,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    targetIds: ['T-001'],
    artifacts: [{ path: 're/docs/evidence.json', sha256: artifactHash }],
    projectAdapter: adapter,
    clock: makeClock(),
    fs: fsp,
    paths,
    atomic,
  })
  assert.equal(captured.ok, true, JSON.stringify(captured))
  project.write('re/docs/evidence.json', '{"a":2}')
  const result = await compareBaseline({ root, baseline: captured.baseline, projectAdapter: adapter, fs: fsp, paths })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BASELINE_MISMATCH')
  assert.equal(result.mismatches[0].kind, 'artifact')
})

test('sealRunSet：终端且未封存的 RUN 才调用 seal；已封存只校验复用', async (t) => {
  const { adapter } = await projectWithTargets(t, {
    sealEntries: [{ path: 're/seals/runs/RUN-1.json', sha256: SHA('5'), bytes: 12 }],
  })
  const result = await sealRunSet({
    projectAdapter: adapter,
    runs: [
      { run_id: 'RUN-1', status: 'completed' },
      { run_id: 'RUN-2', status: 'completed' },
      { run_id: 'RUN-3', status: 'running' },
    ],
    seals: [{ path: 're/seals/runs/RUN-1.json', sha256: SHA('5'), bytes: 12 }],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.results.map((item) => [item.run_id, item.action]), [
    ['RUN-1', 'reused'],
    ['RUN-2', 'sealed'],
    ['RUN-3', 'skipped'],
  ])
  assert.equal(adapter.callsFor('seal').length, 1)
  assert.equal(adapter.callsFor('seal')[0].args.runId, 'RUN-2')
})

test('sealRunSet：适配器回答 alreadySealed 时按复用记录，不当作失败', async (t) => {
  const { adapter } = await projectWithTargets(t)
  adapter.queue('seal', { exitCode: 0, alreadySealed: true, reused: true, stdout: 'Sealed RUN-2; ...', stderr: '' })
  const result = await sealRunSet({
    projectAdapter: adapter,
    runs: [{ run_id: 'RUN-2', status: 'completed' }],
    seals: [],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.results[0].action, 'reused')
})

test('sealRunSet：seal 失败 → CHECK_FAILED，保留 stdout/stderr/exitCode/阶段', async (t) => {
  const { adapter } = await projectWithTargets(t)
  adapter.queue('seal', { exitCode: 1, stdout: 'partial', stderr: 'ERROR: RUN-2: target hash mismatch', code: 'CHECK_FAILED' })
  const result = await sealRunSet({
    projectAdapter: adapter,
    runs: [{ run_id: 'RUN-2', status: 'completed' }],
    seals: [],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CHECK_FAILED')
  assert.equal(result.stage, 'seal')
  assert.equal(result.run_id, 'RUN-2')
  assert.equal(result.exit_code, 1)
  assert.equal(result.stdout, 'partial')
  assert.match(result.stderr, /target hash mismatch/u)
})
