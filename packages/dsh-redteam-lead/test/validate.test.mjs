import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaults,
  canonicalJson,
  detectDuplicateSetItems,
  normalizeInput,
  operationInputHash,
  sortSetArrays,
  validateInput,
} from '../dist/validate.js'
import { loadSpecJson } from './helpers/tmp.mjs'

/** 规格里的 `$defs` 是唯一形状来源；测试直接读真文件，不自造 schema。 */
let spec = null
async function schema() {
  spec ??= await loadSpecJson('docs/specs/rt-tools.schema.json')
  return spec
}

/** 合法的 rosterInput（inspect，最小必填）。 */
function rosterValid() {
  return { project_root: 'D:\\workSpace\\case01', action: 'inspect', target_kinds: ['game', 'binary'] }
}

/** 合法的 dispatchInput（含全部必填）。 */
function dispatchValid() {
  return {
    project_root: 'D:\\workSpace\\case01',
    operation_id: 'op-dispatch-1',
    post_id: 'binary-diff',
    route_id: 'R-0001',
    target_ids: ['T-0001', 'T-0002'],
    objective: '定位启动校验函数的输入来源',
    evidence_required: ['binary_location'],
    prohibited: ['不得联网'],
  }
}

/** 合法的 concludeInput。 */
function concludeValid() {
  return {
    project_root: 'D:\\workSpace\\case01',
    operation_id: 'op-conclude-1',
    dispatch_id: 'D-0001',
    attempt_id: 'A-000001',
    task_id: 'task-1',
    expected_revision: 3,
    submission_ref: 're/team/dispatches/D-0001/attempts/A-000001/submission.json',
    submission_sha256: 'a'.repeat(64),
    review: {
      outcome: 'finding',
      summary: '确认校验入口',
      reason: '交叉引用与运行时一致',
      proposed_route_status: 'validated',
      evidence_run_ids: ['RUN-0001'],
      anchor_refs: [
        {
          kind: 'binary_location',
          run_id: 'RUN-0001',
          path: 're/runs/RUN-0001/facts.json',
          locator: '0x401000',
        },
      ],
      limitations: ['未覆盖网络路径'],
      next_step: '补验证网络分支',
    },
  }
}

/** 收集 issues 的关键词，便于断言“因为什么被拒”。 */
function keywords(result) {
  return result.issues.map((issue) => issue.keyword)
}

test('rosterInput：合法样例通过', async () => {
  const result = validateInput(await schema(), 'rosterInput', rosterValid())
  assert.deepEqual(result.issues, [])
  assert.equal(result.ok, true)
})

test('rosterInput：缺必填 project_root 被拒，问题指向该字段', async () => {
  const result = validateInput(await schema(), 'rosterInput', { action: 'inspect' })
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['required'])
  assert.equal(result.issues[0].path, '/project_root')
})

test('rosterInput：未知字段被拒（additionalProperties=false）', async () => {
  const result = validateInput(await schema(), 'rosterInput', { ...rosterValid(), role: 'lead' })
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['additionalProperties'])
  assert.equal(result.issues[0].path, '/role')
})

test('T25：capacity / reserved_* 不再是规格字段，传了就是未知字段', async () => {
  const s = await schema()
  for (const extra of [
    { capacity: { max_members: 2, max_active_subagents: 2 } },
    { reserved_member_slots: 0 },
    { reserved_activations: 0 },
  ]) {
    const [name] = Object.keys(extra)
    const result = validateInput(s, 'rosterInput', { ...rosterValid(), ...extra })
    assert.equal(result.ok, false, `${name} 必须被拒`)
    assert.deepEqual(keywords(result), ['additionalProperties'], `${name} 应因未知字段被拒：${JSON.stringify(result.issues)}`)
    assert.equal(result.issues[0].path, `/${name}`)
  }

  // dispatch 侧同样只剩 additionalProperties 一条：没有为已废除的参数写专用诊断。
  const dispatch = validateInput(s, 'dispatchInput', {
    ...dispatchValid(),
    capacity: { max_members: 2, max_active_subagents: 2 },
  })
  assert.equal(dispatch.ok, false)
  assert.deepEqual(keywords(dispatch), ['additionalProperties'])
  assert.equal(dispatch.issues[0].path, '/capacity')
})

test('rosterInput：action=bind 缺 operation_id 被拒（if/then 条件约束）', async () => {
  const result = validateInput(await schema(), 'rosterInput', {
    project_root: 'D:\\workSpace\\case01',
    action: 'bind',
    target_kinds: ['game'],
    proposal_hash: 'b'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.path === '/operation_id' && issue.keyword === 'required'))
})

test('rosterInput：inspect 携带 operation_id 被拒（else 分支的 not 约束）', async () => {
  const result = validateInput(await schema(), 'rosterInput', {
    ...rosterValid(),
    operation_id: 'op-inspect',
  })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.keyword === 'not'), JSON.stringify(result.issues))
})

test('rosterInput：未知 action（含 skill 侧的清单刷新动作）被拒，不静默当成 inspect', async () => {
  const s = await schema()
  for (const action of ['refresh_tools', 'refresh', 'list']) {
    const result = validateInput(s, 'rosterInput', { ...rosterValid(), action })
    assert.equal(result.ok, false, `${action} 不应被接受`)
    assert.ok(
      result.issues.some((issue) => issue.path === '/action' && issue.keyword === 'enum'),
      JSON.stringify(result.issues),
    )
  }
})

test('rosterInput：bind/takeover 的 target_kinds 不能为空（then 分支 minItems）', async () => {
  const result = validateInput(await schema(), 'rosterInput', {
    project_root: 'D:\\workSpace\\case01',
    action: 'bind',
    operation_id: 'op-bind-1',
    proposal_hash: 'b'.repeat(64),
    target_kinds: [],
  })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.path === '/target_kinds' && issue.keyword === 'minItems'))
})

test('rosterInput：takeover 缺 recovery_ref 被拒（const 条件），带齐则通过', async () => {
  const s = await schema()
  const takeover = {
    project_root: 'D:\\workSpace\\case01',
    action: 'takeover',
    operation_id: 'op-takeover-1',
    proposal_hash: 'b'.repeat(64),
    target_kinds: ['game'],
  }

  const missing = validateInput(s, 'rosterInput', takeover)
  assert.equal(missing.ok, false)
  assert.ok(missing.issues.some((issue) => issue.path === '/recovery_ref' && issue.keyword === 'required'))

  const complete = validateInput(s, 'rosterInput', {
    ...takeover,
    recovery_ref: 'docs/agents/reverse-project-management.md',
  })
  assert.deepEqual(complete.issues, [])
})

test('dispatchInput：合法样例通过', async () => {
  const result = validateInput(await schema(), 'dispatchInput', dispatchValid())
  assert.deepEqual(result.issues, [])
})

test('dispatchInput：缺必填 objective 被拒', async () => {
  const input = dispatchValid()
  delete input.objective
  const result = validateInput(await schema(), 'dispatchInput', input)
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['required'])
  assert.equal(result.issues[0].path, '/objective')
})

test('dispatchInput：未知字段被拒', async () => {
  const result = validateInput(await schema(), 'dispatchInput', { ...dispatchValid(), context: 'fresh' })
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['additionalProperties'])
  assert.equal(result.issues[0].path, '/context')
})

test('dispatchInput：target_ids 为空、重复或格式非法都被拒', async () => {
  const s = await schema()

  const empty = validateInput(s, 'dispatchInput', { ...dispatchValid(), target_ids: [] })
  assert.equal(empty.ok, false)
  assert.ok(keywords(empty).includes('minItems'))

  const duplicated = validateInput(s, 'dispatchInput', { ...dispatchValid(), target_ids: ['T-0001', 'T-0001'] })
  assert.equal(duplicated.ok, false)
  assert.ok(keywords(duplicated).includes('uniqueItems'))

  const malformed = validateInput(s, 'dispatchInput', { ...dispatchValid(), target_ids: ['T0001'] })
  assert.equal(malformed.ok, false)
  assert.ok(malformed.issues.some((issue) => issue.keyword === 'pattern' && issue.path === '/target_ids/0'))
})

test('dispatchInput：正整数下界与空白文本被拒', async () => {
  const s = await schema()

  const zero = validateInput(s, 'dispatchInput', { ...dispatchValid(), timebox_ms: 0 })
  assert.equal(zero.ok, false)
  assert.ok(keywords(zero).includes('minimum'))

  const blank = validateInput(s, 'dispatchInput', { ...dispatchValid(), objective: '   ' })
  assert.equal(blank.ok, false)
  assert.ok(blank.issues.some((issue) => issue.path === '/objective' && issue.keyword === 'pattern'))
})

test('concludeInput：合法样例通过', async () => {
  const result = validateInput(await schema(), 'concludeInput', concludeValid())
  assert.deepEqual(result.issues, [])
})

test('concludeInput：缺必填 review 被拒', async () => {
  const input = concludeValid()
  delete input.review
  const result = validateInput(await schema(), 'concludeInput', input)
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['required'])
  assert.equal(result.issues[0].path, '/review')
})

test('concludeInput：未知字段被拒', async () => {
  const result = validateInput(await schema(), 'concludeInput', { ...concludeValid(), override: true })
  assert.equal(result.ok, false)
  assert.deepEqual(keywords(result), ['additionalProperties'])
})

test('concludeInput：review 条件约束按 outcome 生效', async () => {
  const s = await schema()

  const findingBlocked = concludeValid()
  findingBlocked.review.proposed_route_status = 'blocked'
  const badStatus = validateInput(s, 'concludeInput', findingBlocked)
  assert.equal(badStatus.ok, false)
  assert.ok(badStatus.issues.some((issue) => issue.path === '/review/proposed_route_status'))

  const findingNoEvidence = concludeValid()
  findingNoEvidence.review.evidence_run_ids = []
  findingNoEvidence.review.anchor_refs = []
  const badEvidence = validateInput(s, 'concludeInput', findingNoEvidence)
  assert.equal(badEvidence.ok, false)
  assert.ok(keywords(badEvidence).filter((keyword) => keyword === 'minItems').length === 2)
})

test('issue 结构齐全：path/keyword/message 都在，且 path 定位到出错节点', async () => {
  const result = validateInput(await schema(), 'concludeInput', {
    ...concludeValid(),
    review: { ...concludeValid().review, outcome: 'not-an-outcome' },
  })
  assert.equal(result.ok, false)
  const issue = result.issues[0]
  assert.equal(issue.path, '/review/outcome')
  assert.equal(issue.keyword, 'enum')
  assert.equal(typeof issue.message, 'string')
  assert.ok(issue.message.length > 0)
})

test('validateInput 接受 $defs 映射本身或整份 schema 两种入参', async () => {
  const s = await schema()
  assert.deepEqual(validateInput(s.$defs, 'rosterInput', rosterValid()).issues, [])
})

test('validateInput 对未定义定义名直接报错，不静默放行', async () => {
  assert.throws(() => validateInput({ $defs: {} }, 'nope', {}), TypeError)
})

test('集合语义数组在规范化后排序且保持成员完整', async () => {
  const s = await schema()
  const normalized = sortSetArrays(s, 'rosterInput', { ...rosterValid(), target_kinds: ['webapp', 'binary', 'game'] })
  assert.deepEqual(normalized.target_kinds, ['binary', 'game', 'webapp'])
})

test('规范化先拒绝重复集合项', async () => {
  const s = await schema()
  const issues = detectDuplicateSetItems(s, 'rosterInput', {
    project_root: 'D:\\workSpace\\case01',
    target_kinds: ['game', 'game'],
  })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].keyword, 'uniqueItems')

  const result = await normalizeInput({
    schemaDefs: s,
    defName: 'rosterInput',
    input: { project_root: 'D:\\workSpace\\case01', target_kinds: ['game', 'game'] },
  })
  assert.equal(result.ok, false)
  assert.equal(result.issues[0].keyword, 'uniqueItems')
})

test('规范化填默认值且不改写显式值', async () => {
  const s = await schema()

  const defaults = applyDefaults(s, 'rosterInput', { project_root: 'D:\\p' })
  assert.equal(defaults.action, 'inspect')
  assert.equal(defaults.max_posts, 6)
  // T25：reserved_* 已随容量子系统从规格删除，不再有默认值。
  assert.equal(Object.hasOwn(defaults, 'reserved_member_slots'), false)
  assert.equal(Object.hasOwn(defaults, 'reserved_activations'), false)
  assert.deepEqual(defaults.target_kinds, [])

  const dispatch = applyDefaults(s, 'dispatchInput', dispatchValid())
  assert.equal(dispatch.timebox_ms, 1800000)
  assert.equal(dispatch.delivery_timeout_ms, 60000)
  assert.deepEqual(dispatch.capability_needs, [])
  assert.deepEqual(dispatch.depends_on_tasks, [])
  assert.deepEqual(dispatch.resource_needs, [])
  assert.equal(dispatch.retry_of, null)

  const explicit = applyDefaults(s, 'rosterInput', { project_root: 'D:\\p', max_posts: 3 })
  assert.equal(explicit.max_posts, 3)
})

test('applyDefaults 不修改调用方对象', async () => {
  const s = await schema()
  const input = { project_root: 'D:\\p' }
  applyDefaults(s, 'rosterInput', input)
  assert.deepEqual(input, { project_root: 'D:\\p' })
})

test('normalizeInput 依次做校验、填默认、规范化 root、排序集合并返回哈希可用输入', async () => {
  const s = await schema()
  const seen = []
  const result = await normalizeInput({
    schemaDefs: s,
    defName: 'rosterInput',
    input: { project_root: 'D:/workSpace/case01/', target_kinds: ['webapp', 'binary'] },
    normalizeRoot: (raw) => {
      seen.push(raw)
      return 'D:\\workSpace\\case01'
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.project_root, 'D:\\workSpace\\case01')
  assert.equal(result.value.action, 'inspect')
  assert.deepEqual(result.value.target_kinds, ['binary', 'webapp'])
  assert.deepEqual(seen, ['D:/workSpace/case01/'])
})

test('normalizeInput 在 root 规范化失败时返回 issue 而不是抛异常', async () => {
  const s = await schema()
  const result = await normalizeInput({
    schemaDefs: s,
    defName: 'rosterInput',
    input: { project_root: 'relative/dir' },
    normalizeRoot: () => {
      throw new Error('不是目录')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.issues[0].path, '/project_root')
  assert.match(result.issues[0].message, /不是目录/)
})

test('canonicalJson 按 key 排序，正文内容原样保留', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(canonicalJson({ text: ' 前后空格 与换行\n' }), '{"text":" 前后空格 与换行\\n"}')
})

test('operation 输入哈希稳定：键序无关、上下文与输入变化都会改变哈希', () => {
  const context = {
    tool: 'rt_dispatch',
    action: 'dispatch',
    project: 'D:\\workSpace\\case01',
    session: 'session-1',
    epoch: 1,
  }
  const input = { b: 2, a: 1, note: '正文保留' }
  const hash = operationInputHash(input, context)

  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(operationInputHash({ a: 1, note: '正文保留', b: 2 }, context), hash, '键序不应影响哈希')
  assert.notEqual(operationInputHash(input, { ...context, epoch: 2 }), hash)
  assert.notEqual(operationInputHash(input, { ...context, tool: 'rt_conclude' }), hash)
  assert.notEqual(operationInputHash({ ...input, a: 9 }, context), hash)
  assert.equal(
    operationInputHash(input, context),
    operationInputHash({ ...input }, { ...context }),
    '相同内容必须得到相同哈希',
  )
})
