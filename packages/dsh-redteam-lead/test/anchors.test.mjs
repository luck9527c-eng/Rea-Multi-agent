import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ANCHOR_KINDS,
  mergeRequiredKinds,
  parseLocator,
  validateAnchorRef,
  validateAnchorSet,
} from '../src/anchors.mjs'

const SHA = (char) => char.repeat(64)
const RUN = 'RUN-1'
const ARTIFACT = 're/runs/RUN-1/raw/out.bin'

/** 六类锚点的**有效** locator（每类都齐备最低定位字段）。 */
const VALID_LOCATORS = {
  binary_location:
    `target_id=T-001;sha256=${SHA('a')};module=app.dll;va=0x140001000;base=0x140000000;process_id=4242`,
  source_location: `sha256=${SHA('b')};path=re/samples/src/main.c;line=42`,
  web_capture:
    `captured_at=2026-01-01T00:00:00.000Z;url=https://example.test/api;` +
    `path=re/runs/RUN-1/raw/http.json;sha256=${SHA('c')};response_locator=body:0-64`,
  runtime_event:
    `target_id=T-001;process_id=4242;event=decode_buffer;at=2026-01-01T00:00:03.000Z;` +
    `trigger=breakpoint;window_start=2026-01-01T00:00:03.000Z;window_end=2026-01-01T00:00:04.000Z;` +
    `log_sha256=${SHA('d')}`,
  evidence_export:
    `service=rea;version=1.2.0;session_id=session-1;evidence_id=ev_abc;` +
    `path=re/runs/RUN-1/raw/evidence.zip;sha256=${SHA('e')};package_locator=evidence/ev_abc.json`,
  artifact_locator: `sha256=${SHA('f')};line=17`,
}

function refOf(kind, overrides = {}) {
  return {
    kind,
    run_id: RUN,
    path: ARTIFACT,
    locator: VALID_LOCATORS[kind],
    ...overrides,
  }
}

function context(extra = {}) {
  return {
    runIds: [RUN],
    artifactsForRun: (runId) => (runId === RUN ? [ARTIFACT, 're/runs/RUN-1/raw/http.json'] : []),
    ...extra,
  }
}

test('六类锚点各一例：齐备最低定位字段时全部通过', () => {
  assert.deepEqual([...ANCHOR_KINDS].sort(), Object.keys(VALID_LOCATORS).sort())
  for (const kind of ANCHOR_KINDS) {
    const result = validateAnchorRef(refOf(kind), context())
    assert.equal(result.ok, true, `${kind} 应通过：${JSON.stringify(result)}`)
  }
})

test('locator 也接受 JSON 对象文本（键值等价）', () => {
  const locator = JSON.stringify({ target_id: 'T-001', sha256: SHA('a'), module: 'app.dll', rva: '0x1000' })
  const result = validateAnchorRef(refOf('binary_location', { locator }), context())
  assert.equal(result.ok, true)
  assert.equal(parseLocator(locator).fields.rva, '0x1000')
})

test('binary_location 缺 sha256 的地址锚点必须被拒', () => {
  const locator = 'target_id=T-001;module=app.dll;va=0x140001000;base=0x140000000;process_id=4242'
  const result = validateAnchorRef(refOf('binary_location', { locator }), context())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
  assert.match(result.issues[0].reason, /sha256/u)
})

test('binary_location 用 va 时必须另含基址与进程实例/捕获时间', () => {
  const locator = `target_id=T-001;sha256=${SHA('a')};module=app.dll;va=0x140001000`
  const result = validateAnchorRef(refOf('binary_location', { locator }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.reason).join('\n'), /base|process_id|captured_at/u)
})

test('binary_location 只有函数名不成立', () => {
  const result = validateAnchorRef(refOf('binary_location', { locator: 'function=main' }), context())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
})

test('source_location 缺行号或字节范围必须被拒', () => {
  const locator = `sha256=${SHA('b')};path=re/samples/src/main.c`
  const result = validateAnchorRef(refOf('source_location', { locator }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /line|byte/u)
})

test('web_capture 只有 URL 不成立', () => {
  const result = validateAnchorRef(
    refOf('web_capture', { locator: 'url=https://example.test/api' }),
    context(),
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
})

test('web_capture 缺保存响应 path/sha256 必须被拒', () => {
  const locator =
    `captured_at=2026-01-01T00:00:00.000Z;url=https://example.test/api;response_locator=body:0-8`
  const result = validateAnchorRef(refOf('web_capture', { locator }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.reason).join('\n'), /path|sha256/u)
})

test('runtime_event 缺观测窗口或日志身份必须被拒', () => {
  const locator = `target_id=T-001;process_id=4242;event=decode_buffer;at=2026-01-01T00:00:03.000Z;trigger=breakpoint`
  const result = validateAnchorRef(refOf('runtime_event', { locator }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.reason).join('\n'), /window|log_sha256/u)
})

test('evidence_export 只有 evidence ID 不成立（必须有导出包 path/sha256 与包内定位）', () => {
  const locator = 'service=rea;version=1.2.0;session_id=session-1;evidence_id=ev_abc'
  const result = validateAnchorRef(refOf('evidence_export', { locator }), context())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
  assert.match(result.issues.map((issue) => issue.reason).join('\n'), /path|sha256/u)
})

test('artifact_locator 缺具体行/事件/偏移必须被拒', () => {
  const result = validateAnchorRef(refOf('artifact_locator', { locator: `sha256=${SHA('f')}` }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /line|event|offset/u)
})

test('sha256 必须是 64 位小写十六进制', () => {
  const locator = 'sha256=deadbeef;path=re/samples/src/main.c;line=1'
  const result = validateAnchorRef(refOf('source_location', { locator }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /sha256/u)
})

test('未知 kind 被拒', () => {
  const result = validateAnchorRef({ ...refOf('source_location'), kind: 'function_name' }, context())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
})

test('anchor 的 path 必须登记在该 RUN 的 artifacts 里', () => {
  const result = validateAnchorRef(
    refOf('source_location', { path: 're/runs/RUN-1/raw/other.bin' }),
    context(),
  )
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /artifacts/u)
})

test('anchor 的 run_id 必须是本次交付声明的 RUN', () => {
  const result = validateAnchorRef(refOf('source_location', { run_id: 'RUN-9' }), context())
  assert.equal(result.ok, false)
  assert.match(result.issues[0].reason, /RUN-9/u)
})

test('anchor 的 path 必须是项目内相对路径（拒绝对路径与越界）', () => {
  for (const bad of ['/etc/passwd', 're/../outside.bin', 're\\runs\\RUN-1\\raw\\out.bin']) {
    const result = validateAnchorRef(refOf('artifact_locator', { path: bad }), context())
    assert.equal(result.ok, false, `${bad} 应被拒`)
  }
})

test('闭集：缺少 requiredKinds 里的任何一类都拒绝', () => {
  const refs = [refOf('source_location'), refOf('artifact_locator')]
  const result = validateAnchorSet({
    refs,
    requiredKinds: ['source_location', 'artifact_locator', 'web_capture'],
    ...context(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SUBMISSION_INVALID')
  assert.match(result.issues.map((issue) => issue.reason).join('\n'), /web_capture/u)
})

test('闭集：全部 kind 齐备时通过', () => {
  const refs = ANCHOR_KINDS.map((kind) => refOf(kind))
  const result = validateAnchorSet({ refs, requiredKinds: [...ANCHOR_KINDS], ...context() })
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('mergeRequiredKinds：岗位默认 ∪ 契约 evidence_required，去重且稳定排序', () => {
  assert.deepEqual(
    mergeRequiredKinds({
      anchorsRequired: ['binary_location', 'artifact_locator'],
      evidenceRequired: ['artifact_locator', 'runtime_event'],
    }),
    { kinds: ['artifact_locator', 'binary_location', 'runtime_event'], issues: [] },
  )
  assert.deepEqual(mergeRequiredKinds({}), { kinds: [], issues: [] })
})

test('mergeRequiredKinds：未知 kind 归入 issues，不静默丢弃', () => {
  const merged = mergeRequiredKinds({ anchorsRequired: ['binary_location'], evidenceRequired: ['function_name'] })
  assert.deepEqual(merged.kinds, ['binary_location'])
  assert.equal(merged.issues.length, 1)
  assert.equal(merged.issues[0].code, 'UNKNOWN_ANCHOR_KIND')
})
