/**
 * `bin/doctor.mjs` 的行为测试：**裸 node、不加载插件、不依赖团队服务**。
 *
 * 验收要点（ticket / 契约「自检、会话接管与 Lead 循环」/ A01）：
 * - 离线配置正确 → `configuration_ready`，`runtime_ready` 必须是 `unknown`（不许假报服务已运行）；
 * - 硬阻塞 → 具体修复路径 + 退出码 1；
 * - 输出与工具一致的信封形状（八字段 + 每条诊断含 code/reason/next_step）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(PACKAGE_ROOT, 'bin', 'doctor.mjs')
const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const BUNDLE_NAME = '@local/dsh-redteam-lead'

const ENVELOPE_KEYS = [
  'schema_version', 'status', 'code', 'operation_id', 'replayed', 'retryable', 'diagnostics', 'data',
]

/**
 * 选一个「能被 `-V` 跑通」的解释器给 fixture 用：本机有 python 就用 python，
 * 没有就用当前 node（doctor 只验可达性——能启动、`-V` 退出 0——不解析版本语义），
 * 这样测试不依赖宿主环境是否装了 Python。
 */
function fixtureInterpreter() {
  const probe = spawnSync('python', ['-V'], { encoding: 'utf8', windowsHide: true })
  if (probe.status === 0) return 'python'
  return process.execPath
}

async function makeProfile(root, options = {}) {
  const {
    bundles = [TEAM_BUNDLE, BUNDLE_NAME],
    declaredLocal = [BUNDLE_NAME],
    linkedLocal = [BUNDLE_NAME],
  } = options
  await mkdir(root, { recursive: true })
  const dependencies = {}
  for (const name of declaredLocal) dependencies[name] = `link:../${name.split('/').at(-1)}`
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture-profile', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
  for (const name of linkedLocal) {
    const dir = join(root, 'node_modules', ...name.split('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.1.0', type: 'module' })}\n`)
  }
  return root
}

async function makeProject(root, options = {}) {
  const {
    index = true,
    config = true,
    skill = true,
    teamRules = true,
    projectPy = true,
    interpreter = fixtureInterpreter(),
  } = options
  await mkdir(join(root, 're'), { recursive: true })
  if (index) await writeFile(join(root, 'INDEX.md'), '# INDEX\n')
  if (config) {
    await writeFile(
      join(root, 're', 'project.json'),
      `${JSON.stringify({ schema_version: 1, python: interpreter }, null, 2)}\n`,
    )
  }
  if (skill) {
    const skillRoot = join(root, '.agents', 'skills', 'reverse-project-management')
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    const skillDoc = teamRules
      ? '# reverse-project-management\n\n团队协作规则见 references/team-coordination.md\n'
      : '# reverse-project-management\n'
    await writeFile(join(skillRoot, 'SKILL.md'), skillDoc)
    if (teamRules) {
      await mkdir(join(skillRoot, 'references'), { recursive: true })
      await writeFile(join(skillRoot, 'references', 'team-coordination.md'), '# team coordination\n')
    }
    if (projectPy) await writeFile(join(skillRoot, 'scripts', 'project.py'), 'print("ok")\n')
  }
  return root
}

/** 造一个「形状对但内容不全」的 bundle 目录（用来模拟 patch 文件被删掉）。 */
async function makeBrokenBundle(root, options = {}) {
  const { patchFile = false } = options
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: BUNDLE_NAME,
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: { '.': './index.js', './locale/*.json': './locale/*.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`,
  )
  await writeFile(join(root, 'index.js'), 'export function apply() {}\n')
  if (patchFile) await writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n')
  return root
}

function runDoctor(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', windowsHide: true })
  let envelope
  try {
    envelope = JSON.parse(result.stdout)
  } catch {
    envelope = undefined
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope }
}

async function withTemp(prefix, body) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function assertEnvelopeShape(envelope) {
  assert.ok(envelope, 'doctor 必须输出可解析的 JSON 信封')
  assert.deepEqual(Object.keys(envelope).sort(), ENVELOPE_KEYS.slice().sort(), '信封必须是八个固定字段')
  assert.equal(envelope.schema_version, 1)
  assert.ok(['ok', 'blocked', 'partial', 'error'].includes(envelope.status))
  assert.equal(envelope.operation_id, null, 'doctor 不是 operation，operation_id 必须是 null')
  assert.equal(envelope.replayed, false)
  assert.ok(Array.isArray(envelope.diagnostics))
  for (const entry of envelope.diagnostics) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'next_step', 'reason'], '每条诊断只有 code/reason/next_step')
    for (const key of ['code', 'reason', 'next_step']) {
      assert.equal(typeof entry[key], 'string')
      assert.ok(entry[key].trim().length > 0, `诊断的 ${key} 不得为空`)
    }
  }
  assert.equal(typeof envelope.data, 'object')
  assert.equal(envelope.data.runtime_ready, 'unknown', 'runtime_ready 恒为 unknown：离线不得假称团队服务已运行')
  assert.equal(typeof envelope.data.configuration_ready, 'boolean')
  assert.ok(Array.isArray(envelope.data.checks))
}

/** 把信封里所有文字拼起来，便于断言「修复路径」确实写出来了。 */
function textOf(envelope) {
  return [
    envelope.code ?? '',
    ...envelope.diagnostics.map((entry) => `${entry.code} ${entry.reason} ${entry.next_step}`),
    ...envelope.data.checks.map((check) => `${check.id} ${check.status} ${check.detail ?? ''}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 1. 正常 profile + 正常项目：只报 configuration_ready
// ---------------------------------------------------------------------------

test('健康 profile/项目：configuration_ready、runtime_ready=unknown、退出码 0', async () => {
  await withTemp('doctor-ok-', async (root) => {
    const profile = await makeProfile(join(root, 'profile'))
    const project = await makeProject(join(root, 'project'))

    const run = runDoctor(['--profile', profile, '--project', project])
    assert.equal(run.status, 0, `doctor 应退出 0，实际 ${run.status}\n${run.stdout}\n${run.stderr}`)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.status, 'ok')
    assert.equal(run.envelope.code, null)
    assert.deepEqual(run.envelope.diagnostics, [])
    assert.equal(run.envelope.data.configuration_ready, true)
    assert.equal(run.envelope.data.project.skill_copy_present, true)
    assert.equal(run.envelope.data.project.python.ok, true)
    assert.equal(run.envelope.data.profile.team_profile_enabled, true)
    assert.equal(run.envelope.data.bundle.name, BUNDLE_NAME)
  })
})

test('只给 --profile：项目侧标 skip，仍可判 configuration_ready 并退出 0', async () => {
  await withTemp('doctor-noproject-', async (root) => {
    const profile = await makeProfile(join(root, 'profile'))
    const run = runDoctor(['--profile', profile])
    assert.equal(run.status, 0, run.stdout)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.data.configuration_ready, true)
    assert.equal(run.envelope.data.project, null)
    const skipped = run.envelope.data.checks.filter((check) => check.id.startsWith('project.'))
    assert.ok(skipped.length > 0, '未给项目时应记录跳过项')
    assert.ok(skipped.every((check) => check.status === 'skip'), '未给项目时的检查只能是 skip')
  })
})

// ---------------------------------------------------------------------------
// 2. 硬阻塞：具体修复路径 + 退出码 1
// ---------------------------------------------------------------------------

test('本包 patch 文件缺失：退出码 1，诊断指出 cordis.patch.yml 与修法', async () => {
  await withTemp('doctor-nopatch-', async (root) => {
    const bundle = await makeBrokenBundle(join(root, 'bundle'), { patchFile: false })
    const profile = await makeProfile(join(root, 'profile'))
    const project = await makeProject(join(root, 'project'))

    const run = runDoctor(['--bundle', bundle, '--profile', profile, '--project', project])
    assert.equal(run.status, 1, `doctor 应以 1 退出\n${run.stdout}`)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.status, 'blocked')
    assert.equal(run.envelope.data.configuration_ready, false)
    const text = textOf(run.envelope)
    assert.ok(text.includes('cordis.patch.yml'), '诊断必须点名缺失的 patch 文件')
    assert.ok(/恢复|重新|checkout|link|补/.test(text), '诊断必须给出具体修复路径')
  })
})

test('profile 目录不存在：退出码 1，诊断点名路径并给出修法', async () => {
  await withTemp('doctor-noprofile-', async (root) => {
    const missing = join(root, 'no-such-profile')
    const project = await makeProject(join(root, 'project'))
    const run = runDoctor(['--profile', missing, '--project', project])

    assert.equal(run.status, 1, run.stdout)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.status, 'blocked')
    assert.ok(textOf(run.envelope).includes(missing), '诊断必须点名不存在的 profile 路径')
    assert.ok(run.envelope.diagnostics.some((entry) => entry.code === 'PROJECT_NOT_CONFIGURED'))
  })
})

test('团队 profile bundle 未启用在 dsh.profile.bundles：退出码 1，诊断给出要加的那一行', async () => {
  await withTemp('doctor-noteam-', async (root) => {
    const profile = await makeProfile(join(root, 'profile'), {
      bundles: [BUNDLE_NAME],
      declaredLocal: [BUNDLE_NAME],
      linkedLocal: [BUNDLE_NAME],
    })
    const project = await makeProject(join(root, 'project'))

    const run = runDoctor(['--profile', profile, '--project', project])
    assert.equal(run.status, 1, run.stdout)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.data.profile.team_profile_enabled, false)
    const entry = run.envelope.diagnostics.find((item) => item.code === 'TEAM_SERVICE_UNAVAILABLE')
    assert.ok(entry, '缺团队 bundle 必须报 TEAM_SERVICE_UNAVAILABLE')
    assert.ok(entry.next_step.includes(TEAM_BUNDLE), 'next_step 必须点名要加入 bundles 的包名')
  })
})

test('项目缺 `.agents/skills/reverse-project-management` 副本：退出码 1，且不许建议用全局副本覆盖', async () => {
  await withTemp('doctor-noskill-', async (root) => {
    const profile = await makeProfile(join(root, 'profile'))
    const project = await makeProject(join(root, 'project'), { skill: false })

    const run = runDoctor(['--profile', profile, '--project', project])
    assert.equal(run.status, 1, run.stdout)
    assertEnvelopeShape(run.envelope)
    const entry = run.envelope.diagnostics.find((item) => item.code === 'SKILL_INCOMPATIBLE')
    assert.ok(entry, '缺项目 skill 副本必须报 SKILL_INCOMPATIBLE')
    assert.ok(
      entry.next_step.includes(join('.agents', 'skills', 'reverse-project-management')),
      `next_step 必须给出具体路径，实际：${entry.next_step}`,
    )
    assert.ok(!/用全局副本覆盖|覆盖项目副本/.test(entry.next_step), '绝不允许用全局副本覆盖项目副本（DECISIONS D8）')
  })
})

test('项目缺团队规则段：报缺口但不说“覆盖”，并指明按 skill 规则合并', async () => {
  await withTemp('doctor-noteamrules-', async (root) => {
    const profile = await makeProfile(join(root, 'profile'))
    const project = await makeProject(join(root, 'project'), { teamRules: false })

    const run = runDoctor(['--profile', profile, '--project', project])
    assert.equal(run.status, 1, run.stdout)
    assertEnvelopeShape(run.envelope)
    assert.equal(run.envelope.data.project.team_rules_present, false)
    const entry = run.envelope.diagnostics.find((item) => item.reason.includes('团队规则'))
    assert.ok(entry, '必须有一条诊断说明团队规则段缺失')
    assert.ok(/合并/.test(entry.next_step), 'next_step 必须是「按 skill 团队规则合并项目副本」')
  })
})

// ---------------------------------------------------------------------------
// 3. 参数与结构约束
// ---------------------------------------------------------------------------

test('缺 --profile：退出码 1，报 INVALID_ARGUMENT 并给出用法', async () => {
  const run = runDoctor([])
  assert.equal(run.status, 1)
  assertEnvelopeShape(run.envelope)
  assert.equal(run.envelope.status, 'error')
  assert.equal(run.envelope.code, 'INVALID_ARGUMENT')
  assert.ok(run.envelope.diagnostics[0].next_step.includes('--profile'))
})

test('doctor 只依赖 node 内建与 T2 自己的 doctor 模块（不 import index.js / 适配器）', async () => {
  for (const relative of [join('bin', 'doctor.mjs'), join('src', 'doctor.mjs')]) {
    const text = await readFile(join(PACKAGE_ROOT, relative), 'utf8')
    const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith('node:') ||
        specifier === './doctor.mjs' ||
        specifier === '../src/doctor.mjs'
      assert.ok(allowed, `${relative} 只能 import node:* 与 ./doctor.mjs，出现了：${specifier}`)
    }
  }
})
