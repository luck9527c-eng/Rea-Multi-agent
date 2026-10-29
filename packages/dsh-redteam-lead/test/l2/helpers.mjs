/**
 * 第二层验收（L2）测试基础设施：真实 `reverse-project-management` skill CLI。
 *
 * 设计约束（ticket T8）：
 * - 每个用例在 `os.tmpdir()` 下建**临时分析项目**，用 `project.py init <root>` 初始化，
 *   再把权威 skill 副本同步进 `.agents/skills/reverse-project-management/`，
 *   最后补团队规则段（D8：插件 `probe()` 要求副本内有 `references/team-coordination.md`）。
 * - **必须**从项目副本内调用脚本（`project.py` 用扁平 import，见 E3 §1.1），解释器一律 `python -B`。
 * - 测试数据全部非可执行（纯文本），不碰任何真实分析项目，不执行样本，不联网。
 * - Python 或 skill 副本不可用时由调用方 `t.skip(具体原因)`，本模块只负责**准确回报**原因。
 * - 临时目录默认清理；用例失败时保留并打印路径（`withProject()` 负责）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 权威 skill 副本（可用 `RPM_SKILL_ROOT` 覆盖，便于在别的机器上跑）。 */
export const SKILL_SOURCE = process.env.RPM_SKILL_ROOT
  ?? 'C:/Users/Administrator/.agents/skills/reverse-project-management'

/** 解释器（可用 `RT_L2_PYTHON` 指定绝对路径）。 */
export const PYTHON = process.env.RT_L2_PYTHON ?? 'python'

/** 项目内 skill 副本相对路径（skill 自己的规则：项目记录不引用全局绝对路径）。 */
export const SKILL_COPY_RELATIVE = '.agents/skills/reverse-project-management'

/** 临时项目前缀，便于断言 `os.tmpdir()` 下无残留。 */
export const TEMP_PREFIX = 'dsh-rt-l2-'

const PROJECT_PY = 'scripts/project.py'
const REQUIRED_SKILL_FILES = [
  'SKILL.md',
  'scripts/project.py',
  'scripts/governance.py',
  'scripts/impact.py',
  'scripts/integrity.py',
  'assets/INDEX.md',
  'assets/project.json',
  'assets/project-management.md',
]

/**
 * 探测 L2 运行条件：Python 可执行 + 权威 skill 副本齐全。
 * 结果缓存；原因是**具体**的（缺什么、在哪），供 `t.skip()` 直接使用。
 *
 * @returns {Promise<
 *   | { ok: true, python: string, pythonVersion: string, skillSource: string }
 *   | { ok: false, reason: string, detail: string }
 * >}
 */
let environmentProbe
export function environment() {
  environmentProbe ??= (async () => {
    const version = spawnSync(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true })
    const text = `${version.stdout ?? ''}${version.stderr ?? ''}`.trim()
    if (version.error || version.status !== 0) {
      const code = version.error?.code ?? `exit ${version.status}`
      return {
        ok: false,
        reason: `L2 需要真实 Python：\`${PYTHON} --version\` 失败（${code}）`,
        detail: String(version.error?.message ?? text),
      }
    }
    const matched = /Python (\d+\.\d+\.\d+)/u.exec(text)
    if (matched === null) {
      return { ok: false, reason: `L2 需要真实 Python：\`${PYTHON} --version\` 输出里没有版本号（${text}）`, detail: text }
    }
    if (!existsSync(SKILL_SOURCE)) {
      return {
        ok: false,
        reason: `L2 需要真实 skill 副本：${SKILL_SOURCE} 不存在（可用 RPM_SKILL_ROOT 指定）`,
        detail: SKILL_SOURCE,
      }
    }
    for (const file of REQUIRED_SKILL_FILES) {
      const absolute = path.join(SKILL_SOURCE, ...file.split('/'))
      if (!existsSync(absolute)) {
        return {
          ok: false,
          reason: `L2 需要完整 skill 副本：${SKILL_SOURCE} 缺少 ${file}`,
          detail: absolute,
        }
      }
    }
    return { ok: true, python: PYTHON, pythonVersion: matched[1], skillSource: SKILL_SOURCE }
  })()
  return environmentProbe
}

/**
 * 在给定 cwd 下跑 `python -B <script> <args...>`。
 * 传参数组、`shell:false`、UTF-8 环境变量（E3 §8.1）。
 *
 * @param {string} script 脚本绝对路径
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number }} [options]
 * @returns {{ code: number | null, signal: string | null, stdout: string, stderr: string, argv: string[] }}
 */
export function runScript(script, args, options = {}) {
  const { cwd = process.cwd(), timeout = 120_000 } = options
  const result = spawnSync(PYTHON, ['-B', script, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    env: {
      ...process.env,
      // CJK 输出 + 禁止写 __pycache__（避免污染项目副本、稳定摘要）
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })
  return {
    code: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    argv: ['-B', script, ...args],
  }
}

/**
 * 建一个临时分析项目：`init` → 同步权威 skill 副本 → 补团队规则段。
 *
 * @param {{ dropTeamRules?: boolean, dropToolInventoryRules?: boolean, prefix?: string }} [options]
 * @returns {Promise<{
 *   root: string,
 *   env: object,
 *   run: (args: string[], opts?: object) => object,
 *   cli: (args: string[], opts?: object) => object,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function makeProject(options = {}) {
  const environmentInfo = await environment()
  if (!environmentInfo.ok) throw new Error(environmentInfo.reason)
  const root = await mkdtemp(path.join(tmpdir(), options.prefix ?? TEMP_PREFIX))
  const init = runScript(path.join(SKILL_SOURCE, ...PROJECT_PY.split('/')), ['init', root])
  if (init.code !== 0) {
    await removeTree(root)
    throw new Error(`project.py init 失败（exit ${init.code}）：${init.stderr.trim() || init.stdout.trim()}`)
  }
  await syncSkillCopy(root, { dropTeamRules: options.dropTeamRules, dropToolInventoryRules: options.dropToolInventoryRules })
  const project = {
    root,
    env: environmentInfo,
    run: (args, opts) => projectCli(root, args, opts),
    cli: (args, opts) => projectCli(root, args, opts),
    dispose: () => removeTree(root),
  }
  return project
}

/**
 * 把权威 skill 副本整棵同步进临时项目（覆盖 init 产生的副本），
 * 保证被测字节就是权威副本的字节。
 *
 * @param {string} root
 * @param {{ dropTeamRules?: boolean, dropToolInventoryRules?: boolean }} [options]
 */
export async function syncSkillCopy(root, options = {}) {
  const destination = path.join(root, ...SKILL_COPY_RELATIVE.split('/'))
  await rm(destination, { recursive: true, force: true })
  await cp(SKILL_SOURCE, destination, {
    recursive: true,
    force: true,
    // `filter(source) => true` 表示复制；排除 `.git` / `__pycache__` / `*.pyc`
    filter: (source) => keepSource(source),
  })
  if (options.dropTeamRules === true) {
    await rm(path.join(destination, 'references', 'team-coordination.md'), { force: true })
  }
  if (options.dropToolInventoryRules === true) {
    await rm(path.join(destination, 'references', 'tool-inventory.md'), { force: true })
  }
  // 刻意保留"旧副本"形态时不要补规则段（那正是被测的缺口）。
  if (options.dropTeamRules !== true) await ensureTeamRules(root)
}

function keepSource(source) {
  const parts = source.split(/[\\/]/u)
  if (parts.includes('__pycache__') || parts.includes('.git')) return false
  if (source.endsWith('.pyc')) return false
  return true
}

/**
 * 保证副本含团队规则段（D8）。
 *
 * 权威工作树副本本身带 `references/team-coordination.md`；只有来源副本缺该文件时，
 * 才写一份**显式标记**的最小替代段，让 `probe()` 的 `hasTeamRules` 有意义。
 * 兼容性用例会断言「不是替代段」，避免把补丁当权威字节。
 *
 * @param {string} root
 * @returns {Promise<{ source: 'authoritative' | 'fallback' }>}
 */
export async function ensureTeamRules(root) {
  const file = path.join(root, ...SKILL_COPY_RELATIVE.split('/'), 'references', 'team-coordination.md')
  if (existsSync(file)) return { source: 'authoritative' }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    [
      '# 团队协作规则（L2 测试替代段）',
      '',
      '<!-- L2-FALLBACK: 来源 skill 副本缺 references/team-coordination.md -->',
      '',
      '整合者（Lead）唯一写入共享路线/RUN/seal/INDEX；执行者在独立工作区保存计划与原始产物，',
      '提交后由整合者核对、归档、封存；已有封存只校验复用，不重封存。',
      '',
    ].join('\n'),
    'utf8',
  )
  return { source: 'fallback' }
}

/** 项目副本内的 project.py 绝对路径。 */
export function projectPy(root) {
  return path.join(root, ...SKILL_COPY_RELATIVE.split('/'), ...PROJECT_PY.split('/'))
}

/**
 * 跑项目副本里的真实 CLI。
 * @param {string} root
 * @param {string[]} args
 */
export function projectCli(root, args, options = {}) {
  return runScript(projectPy(root), args, { cwd: root, ...options })
}

/** `check`（真实 CLI 单行 JSON）。 */
export function checkProject(root, flags = []) {
  return projectCli(root, ['check', root, ...flags])
}

/** 解析 `check` 的 stdout（单行 JSON）；解析失败直接抛，不掩盖。 */
export function parseCheck(result) {
  try {
    return JSON.parse(result.stdout.trim())
  } catch (error) {
    throw new Error(`check 输出不是 JSON（exit ${result.code}）：${JSON.stringify(result.stdout)}\n${error.message}`)
  }
}

/** 解析 `impact` / `audit-scope` 的 pretty JSON。 */
export function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${label} 输出不是 JSON（exit ${result.code}）：${result.stdout.slice(0, 2000)}\n${error.message}`)
  }
}

/**
 * 断言退出码，失败时把原始 stdout/stderr 带进消息（不吞诊断）。
 * @param {{ code: number | null, stdout: string, stderr: string, argv?: string[] }} result
 * @param {number} expected
 * @param {string} label
 */
export function expectCode(result, expected, label) {
  if (result.code !== expected) {
    throw new Error(
      `${label}: 期望 exit ${expected}，实际 exit ${result.code}\n`
      + `argv: ${(result.argv ?? []).join(' ')}\n`
      + `stdout: ${result.stdout.trim()}\n`
      + `stderr: ${result.stderr.trim()}`,
    )
  }
  return result
}

/** 断言 stderr 含给定片段（真实 CLI 的 fail-fast 单条诊断）。 */
export function expectStderrIncludes(result, fragment, label) {
  if (!result.stderr.includes(fragment)) {
    throw new Error(
      `${label}: stderr 未包含 ${JSON.stringify(fragment)}\n`
      + `stdout: ${result.stdout.trim()}\n`
      + `stderr: ${result.stderr.trim()}`,
    )
  }
  return result
}

/**
 * 创建临时项目并执行用例；失败时保留目录并打印路径，成功时清理。
 *
 * @template T
 * @param {import('node:test').TestContext} t
 * @param {(project: Awaited<ReturnType<typeof makeProject>>) => Promise<T>} body
 * @param {object} [options]
 * @returns {Promise<T>}
 */
export async function withProject(t, body, options = {}) {
  const project = await makeProject(options)
  let ok = false
  try {
    const value = await body(project)
    ok = true
    return value
  } finally {
    if (ok) {
      await project.dispose()
    } else {
      t.diagnostic(`失败用例保留临时项目：${project.root}`)
    }
  }
}

/** 递归删除，Windows 上偶发占用重试。 */
export async function removeTree(target) {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

/** `os.tmpdir()` 下以给定前缀开头的条目（残留检查用）。 */
export function tempEntries(prefix = TEMP_PREFIX) {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => path.join(tmpdir(), entry.name))
}

// ---------------------------------------------------------------------------
// 哈希与规范 JSON
// ---------------------------------------------------------------------------

/** sha256(hex) of bytes/string。 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 文件的 sha256（lowercase hex），与 Python `digest()` 同算法。 */
export function sha256File(file) {
  return sha256(readFileSync(file))
}

/**
 * Python `json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))` 的等价物。
 * 用来独立复算 `execution_sha256`（不依赖被测 CLI 的实现）。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 封存摘要：`run.json` 去掉 `state` 后的规范 JSON sha256（E3 §4.2）。 */
export function executionSha256(run) {
  const identity = { ...run }
  delete identity.state
  return sha256(canonicalJson(identity))
}

// ---------------------------------------------------------------------------
// 记录写入（全部普通 JSON 文件；skill 没有写记录的子命令，见 E3 §1.4）
// ---------------------------------------------------------------------------

/** UTF-8、无 BOM、2 空格缩进、尾换行（与 skill 的 `save_new` 一致）。 */
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

export async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

/** 项目内相对路径（`/` 分隔）。 */
export function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

/**
 * 目标 + `re/targets.json`。
 * `path` 一律项目内相对路径；文件是**非可执行测试数据**。
 */
export async function writeTargets(root, options = {}) {
  const {
    id = 'T-001',
    file = `re/samples/${id}.txt`,
    bytes = `L2 fixture target ${id} — 非可执行测试数据\n`,
    version = 'fixture-1',
    platform = 'windows',
    arch = 'x64',
    source = 'L2 测试构造的非可执行占位目标',
    notes = ['纯文本占位，不含任何可执行内容'],
  } = options
  const absolute = path.join(root, ...file.split('/'))
  if (!existsSync(absolute)) await writeText(absolute, bytes)
  const target = {
    id,
    path: file,
    sha256: sha256File(absolute),
    version,
    platform,
    arch,
    source,
    notes,
  }
  await writeJson(path.join(root, 're', 'targets.json'), { schema_version: 1, targets: [target] })
  return target
}

/** 环境快照（`collected_at` + `host` + `tools`，check 只校验这三项结构）。 */
export async function writeEnvSnapshot(root, options = {}) {
  const {
    name = 'ENV-20261029T000000Z.json',
    collectedAt = '2026-10-29T00:00:00Z',
    host = { id: 'l2-fixture-host', system: 'Windows', scope: 'L2 测试' },
    tools = [{ name: 'python', discovered: 'pass' }],
  } = options
  const file = path.join(root, 're', 'env', name)
  await writeJson(file, { schema_version: 1, collected_at: collectedAt, host, tools })
  return { path: relative(root, file), sha256: sha256File(file) }
}

/** 默认运行状态评估（`state`）；`not_needed` 需要 observed_effects/verification。 */
export function stateFixture(overrides = {}) {
  return {
    initial: 'L2 临时项目，无既有状态',
    expected_effects: '仅在项目目录内写文本产物',
    restore_plan: '删除临时项目即可，无系统副作用',
    status: 'not_needed',
    observed_effects: '仅创建项目内文本文件',
    verification: '未执行任何目标程序',
    recovery: null,
    ...overrides,
  }
}

/**
 * 写一次 RUN（`re/runs/<id>/run.json` + 产物 + 可选环境快照）。
 * 默认是 `completed` 的成功运行；用 `status` 覆盖成 failed/timed_out/interrupted/cancelled。
 */
export async function writeRun(root, options = {}) {
  const {
    id,
    routeId = 'R-001',
    target,
    status = 'completed',
    startedAt = '2026-10-01T00:00:00Z',
    endedAt = '2026-10-01T00:10:00Z',
    command = `python -B re/scripts/l2-${id}.py  # L2 静态占位命令`,
    cwd = root,
    tools = [{ name: 'python', version: '3.15.2' }],
    artifacts = [{ path: `re/runs/${id}/raw/artifact-1.txt`, bytes: `artifact for ${id}\n` }],
    scripts = [],
    environment,
    provenance = null,
    state = status === 'planned' ? undefined : stateFixture(),
    observation = { trigger: 'L2 fixture', window: '2026-10-01T00:00Z..00:10Z', coverage: 'fixture', control: 'none', chain_status: 'unknown' },
    result = `L2 fixture run ${id} completed`,
    exitCode = status === 'completed' ? 0 : null,
    acceptedExitCodes = [0],
    extra = {},
  } = options
  if (!id) throw new Error('writeRun: id 必填')
  const runDir = path.join(root, 're', 'runs', id)

  const artifactRecords = []
  for (const artifact of artifacts) {
    const abs = path.join(root, ...artifact.path.split('/'))
    await writeText(abs, artifact.bytes)
    artifactRecords.push({ path: artifact.path, sha256: sha256File(abs) })
  }
  const scriptRecords = []
  for (const script of scripts) {
    const abs = path.join(root, ...script.path.split('/'))
    await writeText(abs, script.bytes)
    scriptRecords.push({ path: script.path, sha256: sha256File(abs) })
  }
  const snapshot = environment ?? await writeEnvSnapshot(root, {
    name: `ENV-${id.replace(/^RUN-/, '')}.json`,
    collectedAt: startedAt,
  })

  const run = {
    schema_version: 1,
    id,
    route_id: routeId,
    status,
    started_at: startedAt,
    ended_at: status === 'planned' ? null : endedAt,
    target: { id: target.id, sha256: target.sha256 },
    command: status === 'planned' ? '' : command,
    cwd,
    tools: status === 'planned' ? [] : tools,
    environment: { snapshot: snapshot.path, snapshot_sha256: snapshot.sha256, differences: [] },
    state,
    scripts: scriptRecords,
    artifacts: artifactRecords,
    exit_code: exitCode,
    accepted_exit_codes: acceptedExitCodes,
    observation,
    result,
    limitations: 'L2 测试数据；未执行目标、未联网',
    ...(provenance === null ? {} : {
      provenance: {
        kind: 'acquisition',
        capture_id: `CAP-${id}`,
        captured_at: startedAt,
        raw_artifacts: artifactRecords.map((item) => item.path),
        source_runs: [],
        note: 'L2 测试构造的采集记录（非真实目标）',
        ...provenance,
      },
    }),
    ...extra,
  }
  const file = path.join(runDir, 'run.json')
  // `state: null` 表示**没有** state 键：真实 CLI 对 `"state": null` 会在
  // `management_summary` 里抛 `'NoneType' object has no attribute 'get'`（见 T8 报告）。
  if (state === null) delete run.state
  await writeJson(file, run)
  return { run, file, runDir }
}

/**
 * 写一条路线（`re/routes/<id>.json`）。
 * 默认 history 是 `planned → status` 的直链（validator 只校验链的连续性，无转换白名单）。
 */
export async function writeRoute(root, options = {}) {
  const {
    id = 'R-001',
    status = 'planned',
    targetIds = ['T-001'],
    dependsOn = [],
    conditionIds = [],
    conditionReviews = [],
    evidence = [],
    closure = null,
    resumeWhen = '',
    stateReason = 'L2 测试登记的路线状态',
    question = `${id}：L2 测试问题（是否存在可复算的锚点）？`,
    hypothesis = 'L2 测试假设：占位目标只含文本。',
    experiment = { action: '读取占位文件并复算哈希', expected: '哈希一致', falsifier: '哈希不一致' },
    budget = { limit: '单轮静态读取', stop_when: '哈希与结构记录一致' },
    prerequisites = ['仅静态读取；不运行样本、不联网'],
    history = null,
    extra = {},
  } = options
  const events = history ?? defaultHistory(id, status)
  const route = {
    schema_version: 1,
    id,
    status,
    question,
    hypothesis,
    target_ids: targetIds,
    depends_on: dependsOn,
    condition_ids: conditionIds,
    condition_reviews: conditionReviews,
    prerequisites,
    experiment,
    budget,
    evidence,
    state_reason: stateReason,
    resume_when: resumeWhen,
    closure,
    history: events,
    ...extra,
  }
  await writeJson(path.join(root, 're', 'routes', `${id}.json`), route)
  return route
}

/** 默认 history：`planned` 起步，必要时一步到目标状态。 */
export function defaultHistory(id, status, options = {}) {
  const { start = '2026-10-01T00:00:00Z', stepMinutes = 5, evidence = [] } = options
  const at = (index) => new Date(Date.parse(start) + index * stepMinutes * 60_000).toISOString().replace('.000Z', 'Z')
  const events = [{ at: at(0), from: null, to: 'planned', reason: `${id} 登记`, evidence: [] }]
  if (status !== 'planned') {
    events.push({ at: at(1), from: 'planned', to: status, reason: `${id} 状态更新`, evidence })
  }
  return events
}

/** 写一条共享条件（`re/conditions/<id>.json`）。history 长度必须等于 revision。 */
export async function writeCondition(root, options = {}) {
  const {
    id = 'C-001',
    revision = 1,
    state = 'unknown',
    evidence = [],
    targetIds = ['T-001'],
    statement = `${id}：L2 测试条件（壳是否会返回调用方）`,
    scope = '仅限 L2 测试占位目标',
    history = null,
    start = '2026-10-01T00:00:00Z',
    extra = {},
  } = options
  const events = history ?? Array.from({ length: revision }, (_, index) => ({
    revision: index + 1,
    at: new Date(Date.parse(start) + index * 60_000).toISOString().replace('.000Z', 'Z'),
    state: index + 1 === revision ? state : 'unknown',
    reason: `${id} 第 ${index + 1} 版`,
    evidence: index + 1 === revision ? evidence : [],
  }))
  const condition = {
    schema_version: 1,
    id,
    statement,
    scope,
    target_ids: targetIds,
    revision,
    state,
    evidence,
    history: events,
    ...extra,
  }
  await writeJson(path.join(root, 're', 'conditions', `${id}.json`), condition)
  return condition
}

/** 写 `re/project.json`。 */
export async function writeProject(root, options = {}) {
  const {
    status = 'active',
    goal = 'L2 测试项目：验证真实 project.py 的判定门槛',
    scope = '仅临时分析项目与非可执行测试数据',
    acceptance = [],
    audits = [],
    disputes = [],
    completion = { limitations: '全部为 L2 测试数据', handoff: '无真实分析缺口' },
  } = options
  const project = {
    schema_version: 1,
    goal,
    scope,
    status,
    acceptance,
    audits,
    disputes,
    completion,
  }
  await writeJson(path.join(root, 're', 'project.json'), project)
  return project
}

/** 读取并解析一个 JSON 记录。 */
export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** 用**真实** `audit-scope` 产出的快照写一条阶段关联审计（让 `--complete` 可达）。 */
export async function writeAuditFromCli(root, options = {}) {
  const {
    at = '2026-10-02T00:00:00Z',
    trigger = 'L2 测试：阶段关联审计',
    outcomes = {},
  } = options
  const scopeResult = projectCli(root, ['audit-scope', root])
  expectCode(scopeResult, 0, 'audit-scope')
  const snapshot = parseJsonOutput(scopeResult, 'audit-scope').snapshot
  const project = await readJson(path.join(root, 're', 'project.json'))
  const routeIds = (await readdir(path.join(root, 're', 'routes')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort()
  project.audits.push({
    at,
    trigger,
    snapshot,
    route_reviews: routeIds.map((routeId) => ({
      route_id: routeId,
      outcome: outcomes[routeId] ?? 'no_change',
      reason: 'L2 测试：已按当前路线范围复核',
    })),
  })
  await writeJson(path.join(root, 're', 'project.json'), project)
  return project
}

/** `seal` 一个 RUN（真实 CLI）。 */
export function seal(root, runId) {
  return projectCli(root, ['seal', root, runId])
}

/** `index`（真实 CLI）。 */
export function index(root) {
  return projectCli(root, ['index', root])
}
