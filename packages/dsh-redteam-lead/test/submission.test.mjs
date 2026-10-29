import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

import * as atomic from '../src/atomic.mjs'
import * as paths from '../src/paths.mjs'
import { makeTempProject } from './helpers/host.mjs'
import {
  SUBMISSION_FIELDS,
  attemptDir,
  readVerifiedSubmission,
  validateSubmission,
} from '../src/submission.mjs'

const SHA = (char) => char.repeat(64)

function validSubmission(overrides = {}) {
  return {
    schema_version: 1,
    dispatch_id: 'D-abc123',
    attempt_id: 'A-000001',
    task_id: 'task-7',
    contract_sha256: SHA('a'),
    outcome: 'finding',
    summary: '确认 COM 接口在外部进程可调用',
    run_ids: ['RUN-1'],
    artifacts: [{ path: 'out/result.json', sha256: SHA('b') }],
    anchor_refs: [],
    blocker: null,
    state_recovery_ref: null,
    submitted_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('合法 submission 通过', () => {
  const result = validateSubmission(validSubmission())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(SUBMISSION_FIELDS.includes('state_recovery_ref'), true)
})

test('必填字段缺一即拒，并指出字段名', () => {
  for (const field of SUBMISSION_FIELDS) {
    const broken = validSubmission()
    delete broken[field]
    const result = validateSubmission(broken)
    assert.equal(result.ok, false, `缺 ${field} 应被拒`)
    assert.equal(result.code, 'SUBMISSION_INVALID')
    assert.match(result.issues.map((issue) => issue.reason).join('\n'), new RegExp(field, 'u'))
  }
})

test('schema_version 不是 1 被拒', () => {
  const result = validateSubmission(validSubmission({ schema_version: 2 }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
})

test('outcome 不在七类里被拒', () => {
  const result = validateSubmission(validSubmission({ outcome: 'success' }))
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /outcome/u)
})

test('run_ids 重复或形状非法被拒', () => {
  assert.equal(validateSubmission(validSubmission({ run_ids: ['RUN-1', 'RUN-1'] })).ok, false)
  assert.equal(validateSubmission(validSubmission({ run_ids: ['run-1'] })).ok, false)
  assert.equal(validateSubmission(validSubmission({ run_ids: 'RUN-1' })).ok, false)
})

test('artifacts 条目必须给 path 与 sha256', () => {
  assert.equal(validateSubmission(validSubmission({ artifacts: [{ path: 'out/a.bin' }] })).ok, false)
  assert.equal(validateSubmission(validSubmission({ artifacts: [{ sha256: SHA('b') }] })).ok, false)
  assert.equal(
    validateSubmission(validSubmission({ artifacts: [{ path: '/abs/a.bin', sha256: SHA('b') }] })).ok,
    false,
  )
})

test('state_recovery_ref 必须是项目内相对路径或 null', () => {
  assert.equal(validateSubmission(validSubmission({ state_recovery_ref: 'C:/x/y.json' })).ok, false)
  assert.equal(validateSubmission(validSubmission({ state_recovery_ref: 're/team/work/D-abc123/A-000001/start.json' })).ok, true)
})

test('submitted_at 必须是 ISO 时间', () => {
  assert.equal(validateSubmission(validSubmission({ submitted_at: '2026-01-01' })).ok, false)
})

test('attemptDir 是 re/team/work/<dispatch>/<attempt>，且越界/绝对路径被拒', async (t) => {
  assert.equal(attemptDir('D-abc123', 'A-000001'), 're/team/work/D-abc123/A-000001')
  const project = makeTempProject({ t })
  const root = await paths.normalizeProjectRoot(project.root)

  const cases = [
    '/etc/passwd',
    're/team/work/D-abc123/A-000001/../../A-000002/submission.json',
    're/team/work/D-other/A-000001/submission.json',
    're/team/work/D-abc123/A-000002/submission.json',
  ]
  for (const ref of cases) {
    const result = await readVerifiedSubmission({
      root,
      submissionRef: ref,
      expectedSha256: SHA('a'),
      dispatchId: 'D-abc123',
      attemptId: 'A-000001',
      paths,
      fs: fsp,
      atomic,
    })
    assert.equal(result.ok, false, `${ref} 应被拒`)
    assert.equal(result.code, 'PATH_INVALID')
    assert.ok(result.issues.length > 0)
  }
})

test('submission_sha256 与文件字节不一致 → SUBMISSION_INVALID', async (t) => {
  const project = makeTempProject({ t })
  const root = await paths.normalizeProjectRoot(project.root)
  const ref = 're/team/work/D-abc123/A-000001/submission.json'
  project.write(ref, validSubmission())

  const result = await readVerifiedSubmission({
    root,
    submissionRef: ref,
    expectedSha256: SHA('c'),
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    paths,
    fs: fsp,
    atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
  assert.match(result.issues[0].reason, /sha256/u)
})

test('文件不存在 → SUBMISSION_INVALID', async (t) => {
  const project = makeTempProject({ t })
  const root = await paths.normalizeProjectRoot(project.root)
  const result = await readVerifiedSubmission({
    root,
    submissionRef: 're/team/work/D-abc123/A-000001/submission.json',
    expectedSha256: SHA('a'),
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    paths,
    fs: fsp,
    atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
})

test('校验通过后内容被换掉（swap after check）→ SUBMISSION_INVALID', async (t) => {
  const project = makeTempProject({ t })
  const root = await paths.normalizeProjectRoot(project.root)
  const ref = 're/team/work/D-abc123/A-000001/submission.json'
  const original = validSubmission()
  project.write(ref, original)

  const target = path.join(project.root, ...ref.split('/'))
  const expected = atomic.sha256Bytes(await fsp.readFile(target))
  let reads = 0
  const swappingFs = {
    ...fsp,
    async readFile(file, encoding) {
      const bytes = await fsp.readFile(file, encoding)
      reads += 1
      if (reads === 1) {
        await fsp.writeFile(target, JSON.stringify({ ...original, summary: '被换掉的内容' }), 'utf8')
      }
      return bytes
    },
  }

  const result = await readVerifiedSubmission({
    root,
    submissionRef: ref,
    expectedSha256: expected,
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    paths,
    fs: swappingFs,
    atomic,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
  assert.match(result.issues[0].reason, /读取后/u)
})

test('校验通过时返回原始字节（归档用的就是这份字节）', async (t) => {
  const project = makeTempProject({ t })
  const root = await paths.normalizeProjectRoot(project.root)
  const ref = 're/team/work/D-abc123/A-000001/submission.json'
  const submission = validSubmission()
  project.write(ref, submission)
  const target = path.join(project.root, ...ref.split('/'))
  const bytes = await fsp.readFile(target)

  const result = await readVerifiedSubmission({
    root,
    submissionRef: ref,
    expectedSha256: atomic.sha256Bytes(bytes),
    dispatchId: 'D-abc123',
    attemptId: 'A-000001',
    paths,
    fs: fsp,
    atomic,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.relative_path, ref)
  assert.equal(result.sha256, atomic.sha256Bytes(bytes))
  assert.deepEqual(Buffer.from(result.bytes), bytes)
  assert.deepEqual(result.submission, submission)
})
