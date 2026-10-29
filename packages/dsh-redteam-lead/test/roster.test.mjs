/**
 * `rt_roster` 行为测试（T5）：`action=inspect|bind|takeover` 的端到端形状。
 *
 * 断言的是**行为与状态**：信封（status/code/data 字段）、`re/team/` 里到底写了什么、
 * 宿主替身收到了哪些调用。不断言内部函数名或日志文案。
 *
 * 覆盖 T5 验收清单：
 * 1. inspect 三类身份分支 + 拒绝时零副作用（`spawnTeammate`/`createTask` 零调用、`re/team/` 无新文件）；
 * 2. 未传 target_kinds 不猜类别、recommended_members=0；
 * 3. gaps 区分缺工具（vacant）/未知能力/预算延后（deferred）/disabled；
 * 4. 工具可见性取自实际执行者（Lead 与 teammate 看到不同工具集 → vacant 不同）；
 * 5. bind 前必须 inspect 且 proposal_hash 匹配；过期/篡改被拒且不写盘；
 * 6. bind 成功写 binding+roster、字段齐备、成员仍为 0；重放 replayed=true 不追加历史；
 * 7. 锁被占 → PROJECT_BUSY；崩溃锁不因过期被抢；
 * 8. takeover 无有效 recovery_ref 被拒；成功后 epoch+1、旧 binding 归档、旧 epoch 操作被拒；
 * 9. 缺团队服务 → TEAM_SERVICE_UNAVAILABLE 且不写项目文件；
 * 10. 项目副本不兼容 → SKILL_INCOMPATIBLE / PROJECT_NOT_CONFIGURED 并给具体缺口；
 * 11. 审计多一条；审计写失败仍 ok 但给出 audit_written=false 诊断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { handleRoster } from '../dist/roster.js'
import { createTeamAdapter } from '../dist/team-adapter.js'
import { validateInput } from '../dist/validate.js'
import { makeCtx, makeTempProject } from './helpers/host.mjs'

const SHA256 = /^[0-9a-f]{64}$/u
const FULL_TOOLS = {
  pwsh: {},
  read: {},
  write: {},
  glob: {},
  grep: {},
  job_list: {},
  job_output: {},
  job_kill: {},
  web_fetch: {},
  web_search: {},
  skill: {},
}
const CAPACITY = { known: true, maxMembers: 8, maxActiveSubagents: 8, via: 'project' }

const GOOD_RECOVERY = `# 旧 Lead 停止核查

- 旧 Lead 会话已停止并隔离，确认不再写入项目。
- 遗留进程处置：后台进程已 terminate，端口 9222 已释放。
- 剩余风险：两个 attempt 目录保留未清理，可能含未归档产物。
`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `re/team/**` 的文件 → 内容哈希快照，用来证明「没写别的」。 */
async function teamState(root) {
  const base = path.join(root, 're', 'team')
  const state = {}
  async function walk(prefix) {
    let entries
    try {
      entries = await readdir(path.join(base, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(relative)
        continue
      }
      state[relative] = sha256(await readFile(path.join(base, ...relative.split('/'))))
    }
  }
  await walk('')
  return state
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8'))
}

async function readText(root, relative) {
  return readFile(path.join(root, ...relative.split('/')), 'utf8')
}

function input(projectRoot, extra = {}) {
  return { project_root: projectRoot, ...extra }
}

/** 建一个可用的 Lead ctx：声明容量 + 完整工具集。 */
function leadCtx(t, project, options = {}) {
  return makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { lead: FULL_TOOLS },
    ...options,
  })
}

// ---------------------------------------------------------------------------
// action=inspect：身份分支与零副作用
// ---------------------------------------------------------------------------

test('inspect 作为 Lead：给出可核对提议，且不创建成员/任务、不写 binding 与 roster', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))

  assert.equal(envelope.status, 'ok')
  assert.equal(envelope.code, null)
  assert.equal(envelope.replayed, false)
  assert.equal(envelope.data.action, 'inspect')
  assert.equal(envelope.data.compatibility, 'compatible')
  assert.equal(envelope.data.project_root, await realpath(project.root))
  assert.match(envelope.data.project_id, /^proj-[0-9a-f]{12}$/u)
  assert.equal(typeof envelope.data.team_id, 'string')
  assert.equal(envelope.data.session_id, envelope.data.team_id)
  assert.match(envelope.data.proposal_hash, SHA256)
  assert.equal(envelope.data.binding_ref, null)

  const posts = new Map(envelope.data.posts.map((post) => [post.post_id, post]))
  assert.deepEqual([...posts.keys()].sort(), [
    'binary-dynamic', 'binary-static', 'cross-check', 'triage', 'web-attack',
  ])
  assert.equal(posts.get('triage').state, 'assigned')
  assert.equal(posts.get('cross-check').state, 'assigned')
  assert.equal(posts.get('binary-static').state, 'vacant')
  assert.equal(posts.get('web-attack').state, 'disabled')

  // 每个 post 条目恰好是 $defs.post 的 7 个字段。
  for (const post of envelope.data.posts) {
    assert.deepEqual(Object.keys(post).sort(), [
      'anchors_required', 'member', 'optional', 'post_id', 'reason', 'required', 'state',
    ])
  }

  assert.equal(envelope.data.recommended_members, 2)
  assert.deepEqual(envelope.data.capacity, {
    remaining_member_slots: 7,
    remaining_activations: 6,
    reserved_member_slots: 1,
    reserved_activations: 2,
  })
  assert.equal(JSON.stringify(envelope.data).includes('"known"'), false, 'D19：known 不得上线')

  // 零副作用：宿主没有被要求建人/建任务；re/team 里只允许新增审计。
  assert.equal(ctx.fakes.team.callsFor('spawnTeammate').length, 0)
  assert.equal(ctx.fakes.team.callsFor('createTask').length, 0)
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'roster.json')))
})

test('inspect 允许真实 teammate；裸子代理被拒且零副作用', async (t) => {
  const project = makeTempProject({ t })
  const teammate = makeCtx({
    t,
    role: 'teammate',
    agentName: 'rt-scout',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { 'rt-scout': FULL_TOOLS },
  })
  const before = await teamState(project.root)

  const allowed = await handleRoster(teammate, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(allowed.envelope.status, 'ok')
  assert.equal(teammate.fakes.team.callsFor('spawnTeammate').length, 0)

  const bare = makeCtx({ t, role: 'none', projectRoot: project.root })
  const rejected = await handleRoster(bare, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(rejected.envelope.status, 'error')
  assert.equal(rejected.envelope.code, 'ROLE_REQUIRED')
  assert.ok(rejected.envelope.diagnostics.length >= 1)
  assert.equal(bare.fakes.team.callsFor('spawnTeammate').length, 0)
  assert.equal(bare.fakes.team.callsFor('createTask').length, 0)
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
})

test('入参自报 role 一律忽略：裸子代理带 role=lead 仍被拒', async (t) => {
  const project = makeTempProject({ t })
  const bare = makeCtx({ t, role: 'none', projectRoot: project.root })

  const { envelope } = await handleRoster(
    bare,
    input(project.root, { target_kinds: ['binary'], role: 'lead', agentName: 'lead' }),
  )
  assert.equal(envelope.status, 'error')
  assert.equal(envelope.code, 'ROLE_REQUIRED')
})

test('inspect 未传 target_kinds：只做环境检查，不猜类别、不提议班底、不给 proposal_hash', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(ctx, input(project.root))

  assert.equal(envelope.status, 'ok')
  assert.equal(envelope.data.action, 'inspect')
  assert.equal(envelope.data.compatibility, 'compatible')
  assert.deepEqual(envelope.data.posts, [])
  assert.equal(envelope.data.recommended_members, 0)
  assert.equal(envelope.data.proposal_hash, null)
  assert.equal(envelope.data.binding_ref, null)
  assert.deepEqual(Object.keys(envelope.data.capacity).sort(), [
    'remaining_activations', 'remaining_member_slots', 'reserved_activations', 'reserved_member_slots',
  ])
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
})

test('inspect 的 gaps 区分：缺工具、未就绪 provider、预算延后、disabled', async (t) => {
  const project = makeTempProject({ t })
  // 只给 shell/fs/search，binary-static/binary-dynamic 这类无默认别名族自然缺通道；
  // 席位只剩 1 且预留 1 → 新成员岗位全部延后。
  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: { known: true, maxMembers: 1, maxActiveSubagents: 4, via: 'project' },
    tools: { lead: { pwsh: {}, read: {}, write: {}, glob: {}, grep: {} } },
  })

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'ok')

  const codes = new Set(envelope.data.gaps.map((gap) => gap.code))
  assert.ok(codes.has('CAPABILITY_MISSING'), '缺注册工具 → CAPABILITY_MISSING')
  assert.ok(codes.has('POST_DISABLED'), 'web-attack → POST_DISABLED')
  assert.ok(codes.has('CAPACITY_EXHAUSTED') || codes.has('CAPACITY_UNKNOWN'), '预算不足 → 容量缺口')
  for (const gap of envelope.data.gaps) {
    assert.deepEqual(Object.keys(gap).sort(), ['code', 'next_step', 'reason'])
    assert.match(gap.reason, /\S/u)
    assert.match(gap.next_step, /\S/u)
  }

  const posts = new Map(envelope.data.posts.map((post) => [post.post_id, post]))
  assert.equal(posts.get('binary-static').state, 'vacant')
  assert.equal(posts.get('web-attack').state, 'disabled')
  assert.ok([...posts.values()].some((post) => post.state === 'deferred'), '容量不足的岗位应被延后')
  assert.equal(envelope.data.recommended_members, 0)
})

test('inspect 工具可见性取自实际执行者：Lead 与 teammate 的 vacant 不同', async (t) => {
  const projectA = makeTempProject({ t })
  const projectB = makeTempProject({ t })
  const lead = leadCtx(t, projectA)
  const teammate = makeCtx({
    t,
    role: 'teammate',
    agentName: 'rt-scout',
    projectRoot: projectB.root,
    capacity: CAPACITY,
    // teammate 只有 shell；其他作用域（lead）里可见的 fs/search 不算它可调用。
    tools: { lead: FULL_TOOLS, 'rt-scout': { pwsh: {} } },
  })

  const leadResult = await handleRoster(lead, input(projectA.root, { target_kinds: ['binary'] }))
  const teammateResult = await handleRoster(teammate, input(projectB.root, { target_kinds: ['binary'] }))

  const leadPosts = new Map(leadResult.envelope.data.posts.map((post) => [post.post_id, post]))
  const teammatePosts = new Map(teammateResult.envelope.data.posts.map((post) => [post.post_id, post]))

  assert.equal(leadPosts.get('triage').state, 'assigned')
  assert.equal(teammatePosts.get('triage').state, 'vacant')
  assert.ok(
    teammateResult.envelope.data.gaps.length > leadResult.envelope.data.gaps.length,
    'teammate 的缺口必须严格更多',
  )
})

test('mixed 模板按并集出岗（game+webapp）', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['game', 'webapp'] }))
  assert.equal(envelope.status, 'ok')
  const ids = new Set(envelope.data.posts.map((post) => post.post_id))
  assert.ok(ids.has('protocol'))
  assert.ok(ids.has('web-recon'))
  assert.ok(ids.has('triage'))
  assert.equal(new Set(envelope.data.posts.map((post) => post.post_id)).size, envelope.data.posts.length)
})

test('inspect 复用已有成员时不计入 recommended_members', async (t) => {
  const project = makeTempProject({ t })
  // 宿主里已有一个空闲成员 rt-triage，且 roster 把它挂在 triage 岗位上。
  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { lead: FULL_TOOLS },
    teamOpts: { members: [{ name: 'rt-triage', status: 'running' }] },
  })
  const teamId = ctx.fakes.team.snapshot().teamId
  project.write('re/team/roster.json', {
    schema_version: 1,
    epoch: 1,
    team_id: teamId,
    posts: [{ post_id: 'triage', state: 'assigned', member: 'rt-triage' }],
    members: [{ name: 'rt-triage', posts: ['triage'] }],
    tasks: [],
  })

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'ok')

  const posts = new Map(envelope.data.posts.map((post) => [post.post_id, post]))
  assert.equal(posts.get('triage').state, 'assigned')
  assert.equal(posts.get('triage').member, 'rt-triage')
  // 只有 cross-check 需要新建成员；triage 是复用。
  assert.equal(envelope.data.recommended_members, 1)
  assert.equal(envelope.data.capacity.remaining_member_slots, 6, '已用席位要计入余额')
})

// ---------------------------------------------------------------------------
// action=bind
// ---------------------------------------------------------------------------

test('bind：proposal_hash 匹配时写 binding + roster，成员仍为 0，INDEX 有指针', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)

  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const hash = inspected.envelope.data.proposal_hash

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-1',
    proposal_hash: hash,
  }))

  assert.equal(envelope.status, 'ok', JSON.stringify(envelope.diagnostics))
  assert.equal(envelope.code, null)
  assert.equal(envelope.replayed, false)
  assert.equal(envelope.operation_id, 'op-bind-1')
  assert.equal(envelope.data.action, 'bind')
  assert.equal(envelope.data.binding_ref, 're/team/binding.json')
  assert.equal(envelope.data.proposal_hash, hash)

  const binding = await readJson(project.root, 're/team/binding.json')
  assert.equal(binding.schema_version, 1)
  assert.equal(binding.canonical_root, await realpath(project.root))
  assert.equal(binding.project_id, envelope.data.project_id)
  assert.equal(binding.session_id, envelope.data.session_id)
  assert.equal(binding.team_id, envelope.data.team_id)
  assert.equal(binding.epoch, 1)
  // 摘要来自项目探测（替身给出固定值），证明 rule/script/catalog 三类摘要真的被记下来了。
  assert.equal(binding.ruleDigest, 'r'.repeat(64))
  assert.equal(binding.scriptDigest, 's'.repeat(64))
  assert.equal(binding.catalogDigest, 'c'.repeat(64))
  assert.equal(binding.bindingDigest, hash)
  assert.equal(binding.adapter.contract_version, 1)
  assert.ok(Object.hasOwn(binding, 'capability'), 'binding 必须记录能力映射版本')
  assert.ok(Object.hasOwn(binding.capability, 'present'))

  const roster = await readJson(project.root, 're/team/roster.json')
  assert.equal(roster.schema_version, 1)
  assert.equal(roster.epoch, 1)
  assert.equal(roster.binding_ref, 're/team/binding.json')
  assert.deepEqual(roster.members, [])
  assert.deepEqual(roster.tasks, [])
  assert.ok(roster.posts.length > 0)
  assert.ok(roster.posts.some((post) => post.state === 'vacant'))

  const index = await readText(project.root, 'INDEX.md')
  assert.match(index, /re\/team\/binding\.json/u)
  assert.match(index, /re\/team\/roster\.json/u)
  assert.ok(index.startsWith('# 逆向项目 INDEX\n'), 'INDEX 既有内容不得被重写')

  // 只建立绑定：宿主侧不建成员、不建任务。
  assert.equal(ctx.fakes.team.callsFor('spawnTeammate').length, 0)
  assert.equal(ctx.fakes.team.callsFor('createTask').length, 0)
  assert.equal(ctx.fakes.team.snapshot().teammates, 0)

  // 审计：inspect 一条 + bind 一条。
  const audit = (await readText(project.root, 're/team/audit.jsonl')).trim().split('\n')
  assert.equal(audit.length, 2)
  const entry = JSON.parse(audit[1])
  assert.equal(entry.kind, 'roster_bind')
  assert.equal(entry.verdict, 'bound')
  assert.equal(entry.requester, 'lead')
})

test('bind 重放同一 operation_id：返回原结果 replayed=true，不重复追加历史/审计', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const request = input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-replay',
    proposal_hash: inspected.envelope.data.proposal_hash,
  })

  const first = await handleRoster(ctx, request)
  const bindingBytes = await readFile(path.join(project.root, 're', 'team', 'binding.json'))
  const auditAfterBind = (await readText(project.root, 're/team/audit.jsonl')).trim().split('\n')

  const second = await handleRoster(ctx, request)
  assert.equal(second.envelope.status, 'ok')
  assert.equal(second.envelope.replayed, true)
  assert.deepEqual(second.envelope.data, first.envelope.data)
  assert.deepEqual(await readFile(path.join(project.root, 're', 'team', 'binding.json')), bindingBytes)

  const ledger = await readJson(project.root, 're/team/operations/op-bind-replay.json')
  assert.equal(ledger.history.filter((step) => step.phase === 'completed').length, 1)
  const audit = (await readText(project.root, 're/team/audit.jsonl')).trim().split('\n')
  assert.equal(audit.length, auditAfterBind.length, '重放不得追加第二条审计')
})

test('同一 operation_id 换了提议内容 → OPERATION_CONFLICT，不假装重放', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)

  const binary = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const first = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-same-id',
    proposal_hash: binary.envelope.data.proposal_hash,
  }))
  assert.equal(first.envelope.status, 'ok')

  const game = await handleRoster(ctx, input(project.root, { target_kinds: ['game'] }))
  const second = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['game'],
    operation_id: 'op-bind-same-id',
    proposal_hash: game.envelope.data.proposal_hash,
  }))

  assert.equal(second.envelope.status, 'blocked')
  assert.equal(second.envelope.code, 'OPERATION_CONFLICT')
  assert.notEqual(second.envelope.replayed, true)
  assert.equal((await readJson(project.root, 're/team/binding.json')).template_id, 'binary')
})

test('bind 拒绝篡改/过期的 proposal_hash，并且不写盘', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const before = await teamState(project.root)

  const tampered = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-tampered',
    proposal_hash: 'f'.repeat(64),
  }))
  assert.equal(tampered.envelope.status, 'blocked')
  assert.equal(tampered.envelope.code, 'OPERATION_CONFLICT')
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
})

test('bind 用别的 target_kinds 的旧提议 → 拒绝且不写盘', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['game'],
    operation_id: 'op-bind-wrong-kinds',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'OPERATION_CONFLICT')
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
})

test('bind 在锁内重读宿主计数：容量在 inspect 之后变紧 → blocked 且不写 binding', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  // inspect 之后容量声明被收紧：席位只剩 1 个，扣掉预留后无法新建成员。
  project.write('re/team/capacity.json', {
    schema_version: 1,
    declared_at: '2026-01-02T00:00:00Z',
    declared_by: 'operator',
    maxMembers: 1,
    maxActiveSubagents: 4,
  })

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-tight',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))

  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'CAPACITY_EXHAUSTED')
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'roster.json')))
  assert.equal(ctx.fakes.team.callsFor('spawnTeammate').length, 0)
})

test('bind 时锁被占 → PROJECT_BUSY；持锁进程崩溃且已过期也不自动夺锁', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))

  project.write('re/team/lock', {
    schema_version: 1,
    project: project.root,
    session: 'other-session',
    owner_nonce: 'other-nonce',
    pid: 999999,
    process_start_ms: 1,
    operation: null,
    acquired_at: '2020-01-01T00:00:00Z',
    expires_at: '2020-01-01T00:00:20Z',
  })

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-busy',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))

  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'PROJECT_BUSY')
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
  // 锁文件原样保留：过期不是自动解锁的理由。
  const lock = await readJson(project.root, 're/team/lock')
  assert.equal(lock.owner_nonce, 'other-nonce')
})

test('bind 变更操作仅 Lead：teammate 被拒且零副作用', async (t) => {
  const project = makeTempProject({ t })
  const teammate = makeCtx({
    t,
    role: 'teammate',
    agentName: 'rt-scout',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { 'rt-scout': FULL_TOOLS },
  })
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(teammate, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-teammate',
    proposal_hash: 'a'.repeat(64),
  }))

  assert.equal(envelope.status, 'error')
  assert.equal(envelope.code, 'ROLE_REQUIRED')
  assert.deepEqual(changedKeys(before, await teamState(project.root)), [])
})

test('bind 拒绝旧会话的绑定：同项目不同 team → PROJECT_SESSION_MISMATCH 且不改 binding', async (t) => {
  const project = makeTempProject({ t })
  const first = leadCtx(t, project)
  const inspected = await handleRoster(first, input(project.root, { target_kinds: ['binary'] }))
  const bound = await handleRoster(first, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-session-1',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))
  assert.equal(bound.envelope.status, 'ok')
  const before = await readFile(path.join(project.root, 're', 'team', 'binding.json'))

  const second = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { lead: FULL_TOOLS },
    teamOpts: { teamId: 'session-root-2' },
  })
  const reinspected = await handleRoster(second, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(reinspected.envelope.status, 'ok', '新会话允许只读 inspect')

  const { envelope } = await handleRoster(second, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-session-2',
    proposal_hash: reinspected.envelope.data.proposal_hash,
  }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'PROJECT_SESSION_MISMATCH')
  assert.deepEqual(await readFile(path.join(project.root, 're', 'team', 'binding.json')), before)
})

test('缺团队服务时 bind/takeover 都返回 TEAM_SERVICE_UNAVAILABLE 且不写项目文件', async (t) => {
  const project = makeTempProject({ t })
  const ctx = makeCtx({ t, team: null, projectRoot: project.root })
  const before = await teamState(project.root)

  for (const action of ['bind', 'takeover']) {
    const { envelope } = await handleRoster(ctx, input(project.root, {
      action,
      target_kinds: ['binary'],
      operation_id: `op-${action}-noservice`,
      proposal_hash: 'b'.repeat(64),
      ...(action === 'takeover' ? { recovery_ref: 're/team/recovery/x.md' } : {}),
    }))
    assert.equal(envelope.status, 'blocked')
    assert.equal(envelope.code, 'TEAM_SERVICE_UNAVAILABLE')
  }
  assert.deepEqual(changedKeys(before, await teamState(project.root)), [])
})

test('项目副本缺团队规则 → SKILL_INCOMPATIBLE，给出具体缺口且不重 init/不覆盖副本', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project, {
    projectOpts: {
      gaps: [{
        code: 'TEAM_RULES_MISSING',
        blocking: true,
        detail: '项目副本缺少 references/team-coordination.md（团队规则段）',
        nextStep: '按 skill 的团队规则合并项目副本（保留历史），不要用全局副本覆盖',
      }],
    },
  })
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'SKILL_INCOMPATIBLE')
  assert.equal(envelope.data.compatibility, 'blocked')
  assert.deepEqual(envelope.data.posts, [])
  assert.equal(envelope.data.recommended_members, 0)
  const gap = envelope.data.gaps.find((item) => item.code === 'TEAM_RULES_MISSING')
  assert.ok(gap, '必须点名具体缺口')
  assert.match(gap.reason, /team-coordination/u)
  assert.match(gap.next_step, /不要用全局副本覆盖/u)

  // 不重 init、不跑 index：只做只读探测。
  assert.deepEqual(ctx.fakes.project.order(), ['probe'])
  assert.deepEqual(changedKeys(before, await teamState(project.root)), ['audit.jsonl'])
})

test('项目副本缺 INDEX → PROJECT_NOT_CONFIGURED', async (t) => {
  const project = makeTempProject({ t })
  project.remove('INDEX.md')
  const ctx = leadCtx(t, project, {
    projectOpts: {
      gaps: [{
        code: 'PROJECT_INDEX_MISSING',
        blocking: true,
        detail: '项目根没有 INDEX.md',
        nextStep: '用项目 skill 的 init 建 INDEX.md，或确认传的是分析项目根',
      }],
    },
  })

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'PROJECT_NOT_CONFIGURED')
  await assert.rejects(readFile(path.join(project.root, 'INDEX.md')), '不得自行创建 INDEX')
})

test('审计写失败时信封仍然 ok，并给出 audit_written=false 诊断', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project, {
    depsOverrides: {
      audit: { appendAudit: async () => ({ written: false, error: 'disk full' }) },
    },
  })
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-audit',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))

  assert.equal(envelope.status, 'ok')
  const diagnostic = envelope.diagnostics.find((item) => item.code === 'AUDIT_WRITE_FAILED')
  assert.ok(diagnostic, '必须报告审计失败')
  assert.match(diagnostic.reason, /audit_written=false/u)
  // binding 仍然写好了。
  const binding = await readJson(project.root, 're/team/binding.json')
  assert.equal(binding.epoch, 1)
})

// ---------------------------------------------------------------------------
// action=takeover
// ---------------------------------------------------------------------------

async function bindFresh(t, project, options = {}) {
  const ctx = options.ctx ?? leadCtx(t, project)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const bound = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: options.operationId ?? 'op-bind-base',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))
  assert.equal(bound.envelope.status, 'ok', JSON.stringify(bound.envelope.diagnostics))
  return ctx
}

test('takeover 缺 recovery_ref / 文件不存在 → 拒绝且 epoch 不变', async (t) => {
  const project = makeTempProject({ t })
  const ctx = await bindFresh(t, project)
  const before = await readJson(project.root, 're/team/binding.json')

  const missing = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-1',
    proposal_hash: 'c'.repeat(64),
  }))
  assert.equal(missing.envelope.status, 'error')
  assert.equal(missing.envelope.code, 'INVALID_ARGUMENT')

  const absent = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-2',
    proposal_hash: 'c'.repeat(64),
    recovery_ref: 're/team/recovery/absent.md',
  }))
  assert.equal(absent.envelope.code, 'INVALID_ARGUMENT')
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, before.epoch)
})

test('takeover 的 recovery_ref 只有布尔值 → 阻塞，不归档也不换 epoch', async (t) => {
  const project = makeTempProject({ t })
  const ctx = await bindFresh(t, project)
  project.write('re/team/recovery/bad.md', '{"recovery_ok": true}\n')

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-bad',
    proposal_hash: 'c'.repeat(64),
    recovery_ref: 're/team/recovery/bad.md',
  }))

  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'RECOVERY_REQUIRED')
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 1)
  await assert.rejects(readdir(path.join(project.root, 're', 'team', 'history')))
})

test('新会话接管：takeover 换 session 并增 epoch，旧会话的变更操作随后被拒', async (t) => {
  const project = makeTempProject({ t })
  const oldCtx = await bindFresh(t, project)
  const oldSessionId = (await readJson(project.root, 're/team/binding.json')).session_id
  project.write('re/team/recovery/old-lead.md', GOOD_RECOVERY)

  const newCtx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { lead: FULL_TOOLS },
    teamOpts: { teamId: 'session-root-2' },
  })
  const inspected = await handleRoster(newCtx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(inspected.envelope.status, 'ok')
  const taken = await handleRoster(newCtx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-new-session',
    proposal_hash: inspected.envelope.data.proposal_hash,
    recovery_ref: 're/team/recovery/old-lead.md',
  }))
  assert.equal(taken.envelope.status, 'ok', JSON.stringify(taken.envelope.diagnostics))

  const binding = await readJson(project.root, 're/team/binding.json')
  assert.equal(binding.epoch, 2)
  assert.notEqual(binding.session_id, oldSessionId, '接管必须换成新会话的绑定')
  assert.equal(binding.session_id, taken.envelope.data.session_id)

  // 旧会话再想 bind/接管：绑定已属于新会话 → PROJECT_SESSION_MISMATCH。
  const oldInspected = await handleRoster(oldCtx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(oldInspected.envelope.status, 'ok', '只读 inspect 仍允许')
  const staleBind = await handleRoster(oldCtx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-old-session',
    proposal_hash: oldInspected.envelope.data.proposal_hash,
  }))
  assert.equal(staleBind.envelope.status, 'blocked')
  assert.equal(staleBind.envelope.code, 'PROJECT_SESSION_MISMATCH')
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 2)
})

test('没有项目适配器时兼容性是 unknown：inspect 给缺口，bind 拒绝', async (t) => {
  const project = makeTempProject({ t })
  const ctx = makeCtx({
    t,
    role: 'lead',
    projectRoot: project.root,
    capacity: CAPACITY,
    tools: { lead: FULL_TOOLS },
    project: null,
  })

  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(inspected.envelope.status, 'ok')
  assert.equal(inspected.envelope.data.compatibility, 'unknown')
  assert.ok(inspected.envelope.data.gaps.some((gap) => gap.code === 'PROJECT_PROBE_UNAVAILABLE'))

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-noprobe',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'SKILL_INCOMPATIBLE')
  await assert.rejects(readFile(path.join(project.root, 're', 'team', 'binding.json')))
})

test('takeover 重放同一 operation_id：返回原结果且不再换 epoch；改 recovery_ref 则冲突', async (t) => {
  const project = makeTempProject({ t })
  const ctx = await bindFresh(t, project)
  project.write('re/team/recovery/a.md', GOOD_RECOVERY)
  project.write('re/team/recovery/b.md', GOOD_RECOVERY)

  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const request = input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-replay',
    proposal_hash: inspected.envelope.data.proposal_hash,
    recovery_ref: 're/team/recovery/a.md',
  })

  const first = await handleRoster(ctx, request)
  assert.equal(first.envelope.status, 'ok', JSON.stringify(first.envelope.diagnostics))
  const auditAfter = (await readText(project.root, 're/team/audit.jsonl')).trim().split('\n').length

  const second = await handleRoster(ctx, request)
  assert.equal(second.envelope.status, 'ok')
  assert.equal(second.envelope.replayed, true)
  assert.deepEqual(second.envelope.data, first.envelope.data)
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 2, '重放不得再增 epoch')
  await assert.rejects(readdir(path.join(project.root, 're', 'team', 'history', 'epoch-2')))
  assert.equal((await readText(project.root, 're/team/audit.jsonl')).trim().split('\n').length, auditAfter)

  const changed = await handleRoster(ctx, input(project.root, {
    ...request,
    recovery_ref: 're/team/recovery/b.md',
  }))
  assert.equal(changed.envelope.status, 'blocked')
  assert.equal(changed.envelope.code, 'OPERATION_CONFLICT')
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 2)
})

test('takeover 成功：epoch+1、旧 binding/roster 归档、dispatch 与事实层保留', async (t) => {
  const project = makeTempProject({ t })
  const ctx = await bindFresh(t, project)
  project.write('re/team/dispatches/D-1.json', { schema_version: 1, dispatch_id: 'D-1', epoch: 1 })
  project.write('re/team/recovery/old-lead.md', GOOD_RECOVERY)
  const oldBinding = await readFile(path.join(project.root, 're', 'team', 'binding.json'))
  const oldRoster = await readFile(path.join(project.root, 're', 'team', 'roster.json'))
  const dispatchBytes = await readFile(path.join(project.root, 're', 'team', 'dispatches', 'D-1.json'))

  // 接管前重新提议：binding 已存在 → proposal_hash 覆盖当前绑定。
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-ok',
    proposal_hash: inspected.envelope.data.proposal_hash,
    recovery_ref: 're/team/recovery/old-lead.md',
  }))

  assert.equal(envelope.status, 'ok', JSON.stringify(envelope.diagnostics))
  assert.equal(envelope.data.action, 'takeover')
  assert.equal(envelope.data.binding_ref, 're/team/binding.json')

  const binding = await readJson(project.root, 're/team/binding.json')
  assert.equal(binding.epoch, 2)
  const archived = await readFile(path.join(project.root, 're', 'team', 'history', 'epoch-1', 'binding.json'))
  assert.deepEqual(archived, oldBinding, '旧 binding 必须逐字节保留在历史里')
  assert.deepEqual(await readFile(path.join(project.root, 're', 'team', 'history', 'epoch-1', 'roster.json')), oldRoster)
  const manifest = await readJson(project.root, 're/team/history/epoch-1/archive.json')
  assert.equal(manifest.recovery_ref, 're/team/recovery/old-lead.md')
  assert.equal(manifest.epoch, 1)

  const roster = await readJson(project.root, 're/team/roster.json')
  assert.equal(roster.epoch, 2)
  assert.deepEqual(roster.members, [])

  assert.deepEqual(
    await readFile(path.join(project.root, 're', 'team', 'dispatches', 'D-1.json')),
    dispatchBytes,
    'takeover 不得改动 dispatch 记录',
  )
  assert.equal(ctx.fakes.team.callsFor('spawnTeammate').length, 0)
})

test('takeover 无既有 binding → PROJECT_NOT_CONFIGURED，不建历史目录', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  project.write('re/team/recovery/old-lead.md', GOOD_RECOVERY)
  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))

  const { envelope } = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-empty',
    proposal_hash: inspected.envelope.data.proposal_hash,
    recovery_ref: 're/team/recovery/old-lead.md',
  }))
  assert.equal(envelope.status, 'blocked')
  assert.equal(envelope.code, 'PROJECT_NOT_CONFIGURED')
  await assert.rejects(readdir(path.join(project.root, 're', 'team', 'history')))
})

test('takeover 之后旧 epoch 的提议不能再用（必须重新提议）', async (t) => {
  const project = makeTempProject({ t })
  const ctx = await bindFresh(t, project)
  project.write('re/team/recovery/old-lead.md', GOOD_RECOVERY)

  const epoch1Proposal = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  const taken = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-takeover-epoch',
    proposal_hash: epoch1Proposal.envelope.data.proposal_hash,
    recovery_ref: 're/team/recovery/old-lead.md',
  }))
  assert.equal(taken.envelope.status, 'ok')
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 2)

  const afterTakeover = await teamState(project.root)
  const stale = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-bind-old-epoch',
    proposal_hash: epoch1Proposal.envelope.data.proposal_hash,
  }))
  assert.equal(stale.envelope.status, 'blocked')
  assert.equal(stale.envelope.code, 'OPERATION_CONFLICT')
  assert.deepEqual(changedKeys(afterTakeover, await teamState(project.root)), ['audit.jsonl'])
  assert.equal((await readJson(project.root, 're/team/binding.json')).epoch, 2)
})

// ---------------------------------------------------------------------------
// 通用：project_root 校验
// ---------------------------------------------------------------------------

test('project_root 非绝对路径 → PATH_INVALID，且不写任何文件', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  const before = await teamState(project.root)

  const { envelope } = await handleRoster(ctx, input('relative/project', { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'error')
  assert.equal(envelope.code, 'PATH_INVALID')
  assert.deepEqual(changedKeys(before, await teamState(project.root)), [])
})

test('缺 Python / 非默认布局 → SKILL_INCOMPATIBLE，并点名具体缺口', async (t) => {
  const noPython = makeTempProject({ t })
  const pythonCtx = leadCtx(t, noPython, {
    projectOpts: {
      gaps: [{
        code: 'PYTHON_MISSING',
        blocking: true,
        detail: 'PATH 上找不到可用的 python/python3',
        nextStep: '在项目配置里登记可用的解释器路径',
      }],
    },
  })
  const pythonResult = await handleRoster(pythonCtx, input(noPython.root, { target_kinds: ['binary'] }))
  assert.equal(pythonResult.envelope.status, 'blocked')
  assert.equal(pythonResult.envelope.code, 'SKILL_INCOMPATIBLE')
  assert.ok(pythonResult.envelope.data.gaps.some((gap) => gap.code === 'PYTHON_MISSING'))

  const legacy = makeTempProject({ t })
  const layoutCtx = leadCtx(t, legacy, {
    projectOpts: {
      compatibility: {
        projectRoot: legacy.root,
        indexPresent: true,
        configPresent: true,
        skillCopyPresent: true,
        hasTeamRules: true,
        pythonOk: true,
        layoutKind: 'legacy-flat',
        ruleDigest: 'r'.repeat(64),
        scriptDigest: 's'.repeat(64),
        catalogDigest: 'c'.repeat(64),
      },
    },
  })
  const layoutResult = await handleRoster(layoutCtx, input(legacy.root, { target_kinds: ['binary'] }))
  assert.equal(layoutResult.envelope.status, 'blocked')
  assert.equal(layoutResult.envelope.code, 'SKILL_INCOMPATIBLE')
  const layoutGap = layoutResult.envelope.data.gaps.find((gap) => gap.code === 'PROJECT_LAYOUT_UNSUPPORTED')
  assert.ok(layoutGap)
  assert.match(layoutGap.reason, /legacy-flat/u)
})

test('项目声明了容量但适配器没读到 → 明确诊断，仍按 CAPACITY_UNKNOWN 处理', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)
  // 模拟装配层没把 project_root 交给适配器：容量声明在项目里，但适配器创建时没有根。
  ctx.deps.teamAdapter = createTeamAdapter({
    services: ctx.services,
    exec: ctx.exec,
    config: {},
  })

  const { envelope } = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assert.equal(envelope.status, 'ok')
  assert.equal(envelope.data.capacity.remaining_member_slots, null)
  assert.equal(envelope.data.capacity.remaining_activations, null)
  assert.equal(envelope.data.recommended_members, 0)
  const unread = envelope.data.gaps.find((gap) => gap.code === 'CAPACITY_DECLARATION_UNREAD')
  assert.ok(unread, '必须点名「声明了但读不到」')
  assert.match(unread.reason, /maxMembers=8/u)
  assert.ok(envelope.data.gaps.some((gap) => gap.code === 'CAPACITY_UNKNOWN'))
})

// ---------------------------------------------------------------------------
// 结构：所有信封都必须过 $defs.result（含 blocked/error，D19 的 capacity 封闭字段）
// ---------------------------------------------------------------------------

const SCHEMA = JSON.parse(readFileSync(new URL('../../../docs/specs/rt-tools.schema.json', import.meta.url), 'utf8'))

function assertEnvelopeMatchesSchema(envelope) {
  const result = validateInput(SCHEMA, 'result', envelope)
  assert.equal(result.ok, true, `信封不符合 $defs.result：${JSON.stringify(result.issues, null, 2)}`)
}

test('inspect/bind/takeover 的 ok 与拒绝信封都能通过 $defs.result 校验', async (t) => {
  const project = makeTempProject({ t })
  const ctx = leadCtx(t, project)

  const inspected = await handleRoster(ctx, input(project.root, { target_kinds: ['binary'] }))
  assertEnvelopeMatchesSchema(inspected.envelope)

  const envOnly = await handleRoster(ctx, input(project.root))
  assertEnvelopeMatchesSchema(envOnly.envelope)

  const bound = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-schema-bind',
    proposal_hash: inspected.envelope.data.proposal_hash,
  }))
  assertEnvelopeMatchesSchema(bound.envelope)

  const rejected = await handleRoster(ctx, input(project.root, {
    action: 'bind',
    target_kinds: ['binary'],
    operation_id: 'op-schema-bad',
    proposal_hash: 'd'.repeat(64),
  }))
  assertEnvelopeMatchesSchema(rejected.envelope)

  project.write('re/team/recovery/bad.md', '{"ok": true}\n')
  const badTakeover = await handleRoster(ctx, input(project.root, {
    action: 'takeover',
    target_kinds: ['binary'],
    operation_id: 'op-schema-takeover',
    proposal_hash: 'd'.repeat(64),
    recovery_ref: 're/team/recovery/bad.md',
  }))
  assertEnvelopeMatchesSchema(badTakeover.envelope)

  const bare = makeCtx({ t, role: 'none', projectRoot: project.root })
  const denied = await handleRoster(bare, input(project.root, { target_kinds: ['binary'] }))
  assertEnvelopeMatchesSchema(denied.envelope)
})

async function realpath(target) {
  const { realpath: realpathFn } = await import('node:fs/promises')
  return realpathFn(target)
}
