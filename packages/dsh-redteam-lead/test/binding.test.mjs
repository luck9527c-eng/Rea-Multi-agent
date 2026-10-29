/**
 * `src/binding.mjs` 的行为测试：项目/会话绑定的**持久化与身份**接缝。
 *
 * 只断言对外可见的行为与磁盘状态（文件在哪、字节是什么、第二次调用是否幂等），
 * 不断言内部函数名或调用顺序。
 *
 * 覆盖的验收点（T5）：
 * - binding 摘要齐备、原子写、内容可解析；
 * - INDEX 只在缺指针时追加，不重写其他内容；
 * - takeover 的归档保留旧 binding/roster/resources 字节；
 * - recovery_ref 的内容必须满足核查要求（布尔值不算）；
 * - 项目身份稳定、会话身份来自可信执行上下文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { makeTempProject } from './helpers/host.mjs'
import * as binding from '../src/binding.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readText(project, relative) {
  return readFile(project.pathOf(relative), 'utf8')
}

async function listTree(root, prefix = '') {
  const entries = await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...await listTree(root, relative))
      continue
    }
    files.push(relative)
  }
  return files.sort()
}

// ---------------------------------------------------------------------------
// 项目身份
// ---------------------------------------------------------------------------

test('project_id 对同一根稳定、对不同根不同，并且只有根时也给出可读形状', async (t) => {
  const a = makeTempProject({ t })
  const b = makeTempProject({ t })

  const first = binding.projectIdFor({ root: a.root })
  const again = binding.projectIdFor({ root: a.root })
  const other = binding.projectIdFor({ root: b.root })

  assert.equal(first, again)
  assert.notEqual(first, other)
  assert.match(first, /^proj-[0-9a-f]{12}$/u)
})

test('project_id 优先采用项目记录声明的标识', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/project.json', { schema_version: 1, project_id: 'acme-reversing', status: 'active' })

  const record = JSON.parse(await readText(project, 're/project.json'))
  assert.equal(binding.projectIdFor({ root: project.root, projectRecord: record }), 'acme-reversing')
})

test('缺 re/team 目录时读 JSON 返回 present=false 而不是抛错', async (t) => {
  const project = makeTempProject({ t })
  const missing = await binding.readJsonIfPresent(project.root, 're/team/capabilities.json')
  assert.equal(missing.present, false)
  assert.equal(missing.value, null)
  assert.match(String(missing.reason), /capabilities\.json/u)

  project.write('re/team/capabilities.json', { schema_version: 1, revision: 3, families: {} })
  const found = await binding.readJsonIfPresent(project.root, 're/team/capabilities.json')
  assert.equal(found.present, true)
  assert.equal(found.value.revision, 3)
  assert.match(found.sha256, /^[0-9a-f]{64}$/u)

  project.write('re/team/capabilities.json', '{ not json')
  const broken = await binding.readJsonIfPresent(project.root, 're/team/capabilities.json')
  assert.equal(broken.present, false)
  assert.equal(broken.value, null)
  assert.match(String(broken.reason), /JSON/u)
})

// ---------------------------------------------------------------------------
// 会话身份与不匹配判定
// ---------------------------------------------------------------------------

test('会话身份取自可信执行上下文：团队根 ID 同时作为 team_id 与会话回落', () => {
  const identity = { ok: true, role: 'lead', name: 'lead', root: 'session-root-9' }
  const exec = { agent: { id: 'session-root-9-lead', name: 'lead' } }

  const withoutHostSession = binding.sessionIdentityFrom({ identity, exec })
  assert.equal(withoutHostSession.team_id, 'session-root-9')
  assert.equal(withoutHostSession.session_id, 'session-root-9')

  const withHostSession = binding.sessionIdentityFrom({ identity, exec: { ...exec, sessionId: 'sess-42' } })
  assert.equal(withHostSession.team_id, 'session-root-9')
  assert.equal(withHostSession.session_id, 'sess-42')
})

test('旧绑定的会话/团队与当前调用不同 → 判定为 PROJECT_SESSION_MISMATCH 依据', () => {
  const same = binding.checkSessionMatch(
    { session_id: 's1', team_id: 't1', epoch: 1 },
    { sessionId: 's1', teamId: 't1' },
  )
  assert.equal(same.ok, true)

  const otherTeam = binding.checkSessionMatch(
    { session_id: 's1', team_id: 't1', epoch: 1 },
    { sessionId: 's1', teamId: 't2' },
  )
  assert.equal(otherTeam.ok, false)
  assert.match(otherTeam.reason, /t1/u)
  assert.match(otherTeam.reason, /t2/u)

  const otherSession = binding.checkSessionMatch(
    { session_id: 's1', team_id: 't1', epoch: 1 },
    { sessionId: 's9', teamId: 't1' },
  )
  assert.equal(otherSession.ok, false)
})

// ---------------------------------------------------------------------------
// binding / roster 原子写
// ---------------------------------------------------------------------------

test('写 binding.json 与 roster.json：原子落盘、字段齐备、哈希与字节一致', async (t) => {
  const project = makeTempProject({ t })
  const value = {
    schema_version: 1,
    project_id: 'proj-aaaaaaaaaaaa',
    canonical_root: project.root,
    session_id: 's1',
    team_id: 't1',
    epoch: 1,
    ruleDigest: 'r'.repeat(64),
    scriptDigest: 's'.repeat(64),
    catalogDigest: 'c'.repeat(64),
    bindingDigest: 'd'.repeat(64),
    adapter: { contract_version: 1 },
    capability: { revision: 2, registry_sha256: 'e'.repeat(64) },
  }

  const written = await binding.writeBinding(project.root, value)
  assert.equal(written.path, project.pathOf('re/team/binding.json'))
  assert.match(written.sha256, /^[0-9a-f]{64}$/u)

  const bytes = await readFile(project.pathOf('re/team/binding.json'))
  assert.equal(sha256(bytes), written.sha256)
  assert.equal(bytes.length, written.bytes)
  // 原子写的固定格式：2 空格缩进 + 结尾换行，便于 diff。
  assert.match(bytes.toString('utf8'), /\n$/u)
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), value)

  const rosterWritten = await binding.writeRoster(project.root, {
    schema_version: 1,
    epoch: 1,
    posts: [{ post_id: 'triage', state: 'vacant', member: null }],
    members: [],
    tasks: [],
  })
  assert.equal(rosterWritten.path, project.pathOf('re/team/roster.json'))
  const roster = JSON.parse(await readText(project, 're/team/roster.json'))
  assert.equal(roster.epoch, 1)
  assert.equal(roster.posts[0].state, 'vacant')
  assert.deepEqual(roster.members, [])
})

// ---------------------------------------------------------------------------
// INDEX 手写区指针
// ---------------------------------------------------------------------------

test('INDEX 只在缺指针时追加，不改写既有内容，重复调用幂等', async (t) => {
  const project = makeTempProject({ t })
  const original = '# 逆向项目 INDEX\n\n## 手写区\n- 既有条目：不要动我\n'
  project.write('INDEX.md', original)

  const first = await binding.linkIndexPointers(project.root, ['re/team/binding.json', 're/team/roster.json'])
  assert.equal(first.written, true)
  assert.deepEqual(first.added.sort(), ['re/team/binding.json', 're/team/roster.json'])

  const after = await readText(project, 'INDEX.md')
  assert.ok(after.startsWith(original), '既有字节必须原样保留在开头')
  assert.match(after, /re\/team\/binding\.json/u)
  assert.match(after, /re\/team\/roster\.json/u)

  const second = await binding.linkIndexPointers(project.root, ['re/team/binding.json', 're/team/roster.json'])
  assert.equal(second.written, false)
  assert.equal(second.unchanged, true)
  assert.deepEqual(second.added, [])
  assert.equal(await readText(project, 'INDEX.md'), after)
})

test('INDEX 已有其中一条指针时只补另一条', async (t) => {
  const project = makeTempProject({ t })
  project.write('INDEX.md', '# INDEX\n- [binding](re/team/binding.json)\n')

  const result = await binding.linkIndexPointers(project.root, ['re/team/binding.json', 're/team/roster.json'])
  assert.equal(result.written, true)
  assert.deepEqual(result.added, ['re/team/roster.json'])
  const text = await readText(project, 'INDEX.md')
  assert.equal(text.match(/re\/team\/binding\.json/gu).length, 1, '既有指针不得重复')
  assert.match(text, /re\/team\/roster\.json/u)
})

test('INDEX 不存在时不自行创建（不重 init、不覆盖副本）', async (t) => {
  const project = makeTempProject({ t })
  project.remove('INDEX.md')

  const result = await binding.linkIndexPointers(project.root, ['re/team/binding.json'])
  assert.equal(result.written, false)
  assert.equal(result.unchanged, false)
  assert.match(String(result.reason), /INDEX/u)
  const entries = await readdir(project.root)
  assert.equal(entries.includes('INDEX.md'), false)
})

// ---------------------------------------------------------------------------
// epoch 归档
// ---------------------------------------------------------------------------

test('接管归档：旧 binding/roster/resources 复制到 history/epoch-N 并保留原文件字节', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/binding.json', { schema_version: 1, epoch: 1, session_id: 's1' })
  project.write('re/team/roster.json', { schema_version: 1, epoch: 1, posts: [] })
  project.write('re/team/resources.json', { schema_version: 1, resources: [] })
  project.write('re/team/recovery/old-lead.md', '# 旧 Lead 核查\n')

  const before = {
    binding: await readFile(project.pathOf('re/team/binding.json')),
    roster: await readFile(project.pathOf('re/team/roster.json')),
    resources: await readFile(project.pathOf('re/team/resources.json')),
  }

  const archived = await binding.archiveEpoch(project.root, {
    epoch: 1,
    recoveryRef: 're/team/recovery/old-lead.md',
    reason: 'takeover',
  })

  assert.deepEqual(
    archived.files.map((file) => file.path).sort(),
    ['re/team/binding.json', 're/team/resources.json', 're/team/roster.json'],
  )
  for (const [name, bytes] of Object.entries(before)) {
    const live = await readFile(project.pathOf(`re/team/${name}.json`))
    assert.deepEqual(live, bytes, `原文件 ${name}.json 不得被删除或改写`)
    const copy = await readFile(project.pathOf(`re/team/history/epoch-1/${name}.json`))
    assert.deepEqual(copy, bytes, `归档必须逐字节一致：${name}.json`)
  }

  const manifest = JSON.parse(await readText(project, archived.manifest_path))
  assert.equal(manifest.epoch, 1)
  assert.equal(manifest.recovery_ref, 're/team/recovery/old-lead.md')
  assert.equal(manifest.reason, 'takeover')
  assert.equal(manifest.files.length, 3)
  for (const file of manifest.files) assert.match(file.sha256, /^[0-9a-f]{64}$/u)
})

test('归档缺 resources.json 时跳过而不报错', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/binding.json', { schema_version: 1, epoch: 2 })

  const archived = await binding.archiveEpoch(project.root, {
    epoch: 2,
    recoveryRef: 're/team/recovery/x.md',
    reason: 'takeover',
  })
  assert.deepEqual(archived.files.map((file) => file.path), ['re/team/binding.json'])
  const entries = await readdir(project.pathOf('re/team/history/epoch-2'))
  assert.equal(entries.includes('resources.json'), false)
})

// ---------------------------------------------------------------------------
// recovery_ref 内容核查
// ---------------------------------------------------------------------------

const GOOD_RECOVERY = `# 旧 Lead 停止核查（2026-10-29）

- 旧 Lead 会话已停止并隔离：session-root-1-lead 已 inactive，确认不再写入。
- 遗留进程处置：pid 4821 的后台抓包进程已 terminate，端口 9222 已释放。
- 剩余风险：re/team/work 下两个 attempt 目录保留未清理，可能含未归档产物。
`

test('recovery_ref 内容齐备时通过核查', () => {
  const result = binding.checkRecoveryRecord(GOOD_RECOVERY)
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
})

test('只有布尔值/空文本的核查记录被拒绝，并列出缺什么', () => {
  for (const text of ['true', '', '{"recovery_ok": true}', '# ok\nok']) {
    const result = binding.checkRecoveryRecord(text)
    assert.equal(result.ok, false, `必须拒绝: ${JSON.stringify(text)}`)
    assert.ok(result.missing.length > 0)
    for (const item of result.missing) {
      assert.equal(typeof item.code, 'string')
      assert.match(item.detail, /\S/u)
    }
  }
})

test('缺少遗留资源处置或剩余风险的记录同样被拒绝', () => {
  const noDisposition = '# 核查\n旧 Lead 已停止，确认不会继续写入项目。\n'
  const withoutRisk = '# 核查\n旧 Lead 已停止；后台进程已 terminate，端口已释放。\n'

  assert.equal(binding.checkRecoveryRecord(noDisposition).ok, false)
  assert.equal(binding.checkRecoveryRecord(withoutRisk).ok, false)
  assert.deepEqual(
    binding.checkRecoveryRecord(noDisposition).missing.map((item) => item.code).sort(),
    ['RECOVERY_DISPOSITION_MISSING', 'RECOVERY_RISK_MISSING'],
  )
})

test('核查记录的文件读取走项目内路径校验（越界/绝对路径拒）', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/recovery/ok.md', GOOD_RECOVERY)

  const inside = await binding.readRecoveryRef(project.root, 're/team/recovery/ok.md')
  assert.equal(inside.ok, true)
  assert.equal(inside.missing, undefined)

  const missing = await binding.readRecoveryRef(project.root, 're/team/recovery/nope.md')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'INVALID_ARGUMENT')

  const escaped = await binding.readRecoveryRef(project.root, '../outside.md')
  assert.equal(escaped.ok, false)
  assert.equal(escaped.code, 'INVALID_ARGUMENT')
})

test('核查记录文件存在但内容不合格时返回 RECOVERY_REQUIRED 候选', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/recovery/bad.md', '{"recovery_ok": true}\n')

  const result = await binding.readRecoveryRef(project.root, 're/team/recovery/bad.md')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RECOVERY_REQUIRED')
  assert.ok(result.missing.length > 0)
  assert.match(result.reason, /bad\.md/u)
})

test('归档后的 history 目录不含临时文件残留', async (t) => {
  const project = makeTempProject({ t })
  project.write('re/team/binding.json', { schema_version: 1, epoch: 1 })
  await binding.archiveEpoch(project.root, { epoch: 1, recoveryRef: 're/team/recovery/x.md', reason: 'takeover' })

  const files = await listTree(project.pathOf('re/team/history'))
  assert.deepEqual(files, ['epoch-1/archive.json', 'epoch-1/binding.json'])
  const statOfHistory = await stat(project.pathOf('re/team/history/epoch-1'))
  assert.equal(statOfHistory.isDirectory(), true)
})
