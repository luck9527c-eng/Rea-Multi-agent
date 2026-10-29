#!/usr/bin/env node
/**
 * 第三层（真 `ctx.agentTeams` 会话）验收的**只读**辅助脚本。
 *
 * 为什么要有这个脚本：第三层不能塞进 `node --test`（宿主包只在打包的 `app.asar` 里，裸 `node`
 * 无法 require），只能由一个人在一次性的 DSH 会话里照着清单跑一遍。人在会话里能看到的只有
 * 「工具返回了什么」；至于「这一步到底往项目里写了什么」需要另外取证。本脚本只做三件事：
 *
 *   collect   --project <root> --out <file>   把项目侧证据文件的 路径 + 字节 SHA-256 + mtime 收成 JSON
 *   diff      --before <f> --after <f> [--out <file>]
 *                                             对比两次 collect，报新增 / 变更 / 删除
 *   checklist --out <file>                    生成七步验收清单 markdown（含可观察断言与 A 编号）
 *
 * 硬约束（与 ticket T9 一致）：
 * - **零依赖**：只用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 或第三方包。
 * - **对项目只读**：不创建、不修改、不删除项目内任何文件；唯一的写入是 `--out` 指定的路径，
 *   且**拒绝**把 `--out` 落到 `--project` 之内（否则「只读」就成了空话）。
 * - **不联网**、不启动分析工具、不调用宿主。
 * - **确定性**：同一棵目录树连跑两次，输出逐字节相同；只有文件真的变了才会出现 mtime 差异。
 *   （所以输出里没有 `generated_at` 之类的时间戳——时间属于记录模板，不属于证据。）
 * - 缺失目录/文件是**显式缺口**（`gaps`），不是崩溃。
 *
 * 用法见 `docs/verify/README.md`；清单正文见 `docs/verify/l3-checklist.md`（由本脚本生成）。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { argv, platform, stderr, stdout } from 'node:process'

/** collect 输出格式版本；改形状时 +1，diff 会拒绝跨版本比较。 */
const SCHEMA_VERSION = 1

/** 三个子命令各自的 kind，防止把 checklist 当 collect 喂给 diff。 */
const KIND_COLLECT = 'l3-evidence-collect'
const KIND_DIFF = 'l3-evidence-diff'

/** 单个目标最多收多少个文件（防止把巨大的 work/ 或 receipts/ 拖死）。 */
const MAX_FILES_PER_TARGET = 20000
/** 递归深度上限（正常 `re/seals/**` 只有两三层）。 */
const MAX_DEPTH = 16

/**
 * 收集目标表。
 *
 * `expectation: 'required'` = 出现在 T9 ticket 列出的证据清单里；缺了要在 `gaps` 里点名。
 * `expectation: 'optional'` = 说话才算数的声明类文件（容量/能力/工具清单/锁）。它们缺失本身
 * 就是一条有意义的证据（例如没有 `re/team/capacity.json` 就该看到 `CAPACITY_UNKNOWN`），
 * 所以只记 `absent`，不算缺口。
 *
 * 路径常量与实现保持一致：`src/binding.ts`（binding/roster/resources/history）、
 * `src/contract.ts`（dispatches/attempts/work）、`src/conclude.ts`（receipts）、
 * `src/audit.ts`（audit.jsonl）、`src/operation.ts`（operations）、`src/baseline.ts`（baselines）、
 * `src/team-adapter.ts`（capacity）、`src/roster.ts`（capabilities）、`src/lock.ts`（lock）、
 * `src/project-adapter.ts`（routes/seals）。
 */
const TARGETS = [
  { id: 'binding', kind: 'file', path: 're/team/binding.json', expectation: 'required', label: '项目/会话绑定' },
  { id: 'roster', kind: 'file', path: 're/team/roster.json', expectation: 'required', label: '名册投影' },
  { id: 'resources', kind: 'file', path: 're/team/resources.json', expectation: 'required', label: '资源租用' },
  { id: 'audit', kind: 'file', path: 're/team/audit.jsonl', expectation: 'required', label: '审计（append-only）' },
  { id: 'dispatches', kind: 'glob', path: 're/team/dispatches', expectation: 'required', label: '派发契约' },
  { id: 'receipts', kind: 'tree', path: 're/team/receipts', expectation: 'required', label: '收口回执' },
  { id: 'routes', kind: 'glob', path: 're/routes', expectation: 'required', label: '路线记录（skill 写）' },
  { id: 'seals', kind: 'tree', path: 're/seals', expectation: 'required', label: '封存记录' },
  { id: 'capacity', kind: 'file', path: 're/team/capacity.json', expectation: 'optional', label: '容量声明（D1）' },
  { id: 'capabilities', kind: 'file', path: 're/team/capabilities.json', expectation: 'optional', label: '能力绑定声明' },
  { id: 'lock', kind: 'file', path: 're/team/lock', expectation: 'optional', label: '项目锁（残留即证据）' },
  { id: 'attempts', kind: 'glob', path: 're/team/attempts', expectation: 'optional', label: '尝试关联记录' },
  { id: 'operations', kind: 'glob', path: 're/team/operations', expectation: 'optional', label: '操作台账（重放证据）' },
  { id: 'baselines', kind: 'glob', path: 're/team/baselines', expectation: 'optional', label: '冻结基准' },
  { id: 'env-tools', kind: 'file', path: 're/env/tools.json', expectation: 'optional', label: '工具清单（无生产者，D11）' },
]

class UsageError extends Error {}

/* -------------------------------------------------------------------------- */
/* 参数解析                                                                    */
/* -------------------------------------------------------------------------- */

const USAGE = `用法：
  node scripts/l3-verify.mjs collect --project <项目根> --out <文件>
  node scripts/l3-verify.mjs diff --before <collect.json> --after <collect.json> [--out <文件>]
  node scripts/l3-verify.mjs checklist --out <文件>

  collect    收项目侧证据文件的 路径 + 字节 SHA-256 + mtime（只读项目；缺目录报 gaps 不崩）
  diff       对比两次 collect，报新增 / 变更 / 删除（默认把 JSON 打到 stdout）
  checklist  生成七步验收清单 markdown（含可观察断言与 A 编号）

  公共：--help 打印本说明；--debug 出错时附带堆栈。`

/** 按 `--key value` / `--key=value` 解析；未知开关由各子命令自己拒绝。 */
function parseArgv(tokens) {
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) throw new UsageError(`多余的参数：${token}`)
    const equals = token.indexOf('=')
    if (equals !== -1) {
      options[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${key} 缺少值`)
    options[key] = value
    index += 1
  }
  return options
}

function requireOption(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UsageError(`缺少必需参数 --${key}（用 --help 看用法）`)
  }
  return value
}

function assertKnownOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new UsageError(`未知参数 --${key}（用 --help 看用法）`)
  }
}

/* -------------------------------------------------------------------------- */
/* 路径与小工具                                                                */
/* -------------------------------------------------------------------------- */

/** 项目内路径一律 `/` 分隔（与插件写出的相对路径同形）。 */
function toPosix(relativePath) {
  return relativePath.split(sep).join('/')
}

/** 大小写无关的比较：Windows 上 `Re` 与 `re` 是同一棵树（DECISIONS 路径规则）。 */
function foldForCompare(value) {
  return platform === 'win32' ? value.toLowerCase() : value
}

/** `child` 是否就是 `parent` 或在它内部（不做 realpath，调用方已规范化）。 */
function isInside(child, parent) {
  const from = foldForCompare(resolve(parent))
  const to = foldForCompare(resolve(child))
  if (to === from) return true
  const rel = relative(from, to)
  if (rel === '' || isAbsolute(rel)) return false
  return !(rel === '..' || rel.startsWith(`..${sep}`))
}

/** 稳定的字节序排序：不用 localeCompare（不同机器的区域设置会改顺序）。 */
function compareText(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 错误码：只取 `code`，绝不把 message 塞进确定性输出（message 含本机绝对路径）。 */
function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'UNKNOWN'
}

/* -------------------------------------------------------------------------- */
/* collect                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 流式算一个文件的证据：字节数、SHA-256、mtime、以及 `.jsonl` 的行数。
 *
 * 行数是「审计多一条」的唯一机读判据（SHA 变了说明不了多了几条），所以顺手数掉。
 * 用流而不是 `readFile`：收口回执里可能带着几 MB 的提交产物。
 */
async function describeFile(root, relativePath) {
  const absolute = join(root, ...relativePath.split('/'))
  const stats = await lstat(absolute)
  const hash = createHash('sha256')
  let bytes = 0
  let newlines = 0
  const countLines = relativePath.endsWith('.jsonl')
  for await (const chunk of createReadStream(absolute)) {
    hash.update(chunk)
    bytes += chunk.length
    if (countLines) {
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) newlines += 1
      }
    }
  }
  const record = {
    path: relativePath,
    type: 'file',
    bytes,
    sha256: hash.digest('hex'),
    mtime: new Date(stats.mtimeMs).toISOString(),
  }
  if (countLines) record.lines = newlines
  return record
}

async function describeSymbolicLink(root, relativePath) {
  const absolute = join(root, ...relativePath.split('/'))
  const stats = await lstat(absolute)
  let target = null
  try {
    target = await readlink(absolute)
  } catch {
    target = null
  }
  return {
    path: relativePath,
    type: 'symlink',
    bytes: null,
    sha256: null,
    mtime: new Date(stats.mtimeMs).toISOString(),
    link_target: target,
  }
}

/** 递归（`tree`）或单层（`glob`）列出目标下所有条目；符号链接只记录不跟随。 */
async function walk(root, relativeDir, targetId, gaps, depth, state, recursive) {
  if (depth > MAX_DEPTH) {
    gaps.push({ target: targetId, path: relativeDir, reason: 'TRUNCATED', detail: `深度超过 ${MAX_DEPTH}` })
    return
  }
  let entries
  try {
    entries = await readdir(join(root, ...relativeDir.split('/')), { withFileTypes: true })
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    gaps.push({ target: targetId, path: relativeDir, reason: 'UNREADABLE', detail: code })
    return
  }
  entries.sort((a, b) => compareText(a.name, b.name))
  for (const entry of entries) {
    if (state.entries.length >= MAX_FILES_PER_TARGET) {
      gaps.push({
        target: targetId,
        path: relativeDir,
        reason: 'TRUNCATED',
        detail: `条目超过 ${MAX_FILES_PER_TARGET}`,
      })
      return
    }
    const childRelative = `${relativeDir}/${entry.name}`
    if (entry.isSymbolicLink()) {
      state.entries.push(await describeSymbolicLink(root, childRelative))
      continue
    }
    if (entry.isDirectory()) {
      if (!recursive) continue
      if (depth + 1 > MAX_DEPTH) {
        gaps.push({ target: targetId, path: childRelative, reason: 'TRUNCATED', detail: `深度超过 ${MAX_DEPTH}` })
        continue
      }
      await walk(root, childRelative, targetId, gaps, depth + 1, state, recursive)
      continue
    }
    if (!entry.isFile()) {
      state.entries.push({ path: childRelative, type: 'other', bytes: null, sha256: null, mtime: null })
      continue
    }
    try {
      state.entries.push(await describeFile(root, childRelative))
    } catch (error) {
      state.entries.push({ path: childRelative, type: 'file', bytes: null, sha256: null, mtime: null })
      gaps.push({ target: targetId, path: childRelative, reason: 'READ_FAILED', detail: errorCode(error) })
    }
  }
}

/** 收一个目标。永远不抛：任何读取失败都变成 `gaps` 里的一行。 */
async function collectTarget(root, target) {
  const summary = {
    id: target.id,
    label: target.label,
    kind: target.kind,
    path: target.path,
    expectation: target.expectation,
    status: 'present',
    files: 0,
    bytes: 0,
  }
  const entries = []
  const gaps = []
  const absolute = join(root, ...target.path.split('/'))

  if (target.kind === 'file') {
    let stats
    try {
      stats = await lstat(absolute)
    } catch (error) {
      const code = errorCode(error)
      summary.status = 'absent'
      gaps.push({
        target: target.id,
        path: target.path,
        reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'MISSING' : 'UNREADABLE',
        detail: code,
      })
      return { summary, entries, gaps }
    }
    if (stats.isDirectory()) {
      summary.status = 'absent'
      gaps.push({ target: target.id, path: target.path, reason: 'UNREADABLE', detail: 'EXPECTED_FILE_GOT_DIR' })
      return { summary, entries, gaps }
    }
    if (stats.isSymbolicLink()) {
      entries.push(await describeSymbolicLink(root, target.path))
    } else {
      try {
        entries.push(await describeFile(root, target.path))
      } catch (error) {
        entries.push({ path: target.path, type: 'file', bytes: null, sha256: null, mtime: null })
        gaps.push({ target: target.id, path: target.path, reason: 'READ_FAILED', detail: errorCode(error) })
      }
    }
    summary.files = entries.length
    summary.bytes = entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
    return { summary, entries, gaps }
  }

  // glob / tree：目录缺失 = 显式缺口；目录存在但没有文件 = empty（也是证据）。
  let dirStats
  try {
    dirStats = await lstat(absolute)
  } catch (error) {
    const code = errorCode(error)
    summary.status = 'absent'
    gaps.push({
      target: target.id,
      path: target.path,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'MISSING' : 'UNREADABLE',
      detail: code,
    })
    return { summary, entries, gaps }
  }
  if (!dirStats.isDirectory()) {
    summary.status = 'absent'
    gaps.push({ target: target.id, path: target.path, reason: 'UNREADABLE', detail: 'EXPECTED_DIR_GOT_FILE' })
    return { summary, entries, gaps }
  }

  const state = { entries }
  await walk(root, target.path, target.id, gaps, 0, state, target.kind === 'tree')
  if (state.entries.length === 0) summary.status = 'empty'
  summary.files = state.entries.length
  summary.bytes = state.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
  return { summary, entries, gaps }
}

/**
 * 证据摘要：只覆盖 (path, bytes, sha256)，**不含 mtime**。
 * 于是「两次 collect 摘要相同」= 内容没变，而 mtime 差异不影响这个判定。
 */
function evidenceDigest(files) {
  const canonical = files.map((file) => [file.path, file.bytes, file.sha256])
  return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf8'))
}

async function readProjectRoot(raw) {
  const absolute = resolve(raw)
  let canonical
  try {
    canonical = await realpath(absolute)
  } catch (error) {
    throw new UsageError(`项目根无法解析（${errorCode(error)}）：${raw}`)
  }
  let stats
  try {
    stats = await stat(canonical)
  } catch (error) {
    throw new UsageError(`项目根无法读取（${errorCode(error)}）：${canonical}`)
  }
  if (!stats.isDirectory()) throw new UsageError(`项目根不是目录：${canonical}`)
  return canonical
}

/**
 * 把输出路径折算成「真实路径」：找到最深的已存在祖先做 `realpath`，再把还不存在的尾段拼回去。
 *
 * 必须这么做的原因：Windows 上同一个目录可能同时以长名（`...\Administrator\...`）与 8.3 短名
 * （`...\ADMINI~1\...`）出现，纯字符串比较会把「项目内」误判成「项目外」——那样"只读项目"的
 * 守卫就等于没有。**不创建任何目录**，所以不会在项目里留下痕迹。
 */
async function canonicalizeTarget(absolute) {
  let current = absolute
  const tail = []
  for (;;) {
    try {
      const real = await realpath(current)
      return join(real, ...tail.reverse())
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return absolute
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

async function prepareOutputPath(rawOutput, projectRoot) {
  const absolute = resolve(rawOutput)
  const canonical = await canonicalizeTarget(absolute)
  if (projectRoot !== null && isInside(canonical, projectRoot)) {
    throw new UsageError(
      `--out 不能落在 --project 之内：本脚本对项目只读（项目根 ${projectRoot}，输出 ${canonical}）`,
    )
  }
  await mkdir(dirname(absolute), { recursive: true })
  return absolute
}

async function writeJsonFile(absolute, value) {
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function commandCollect(options) {
  assertKnownOptions(options, ['project', 'out'])
  const projectRoot = await readProjectRoot(requireOption(options, 'project'))
  const outPath = await prepareOutputPath(requireOption(options, 'out'), projectRoot)

  const targets = []
  const files = []
  const gaps = []

  for (const target of TARGETS) {
    const collected = await collectTarget(projectRoot, target)
    targets.push(collected.summary)
    files.push(...collected.entries)
    gaps.push(...collected.gaps)
  }

  files.sort((a, b) => compareText(a.path, b.path))
  gaps.sort((a, b) => compareText(`${a.target}\u0000${a.path}\u0000${a.reason}`, `${b.target}\u0000${b.path}\u0000${b.reason}`))
  targets.sort((a, b) => compareText(a.id, b.id))

  const present = targets.filter((target) => target.status === 'present').length
  const empty = targets.filter((target) => target.status === 'empty').length
  const absent = targets.filter((target) => target.status === 'absent').length
  const requiredMissing = gaps.filter((gap) => {
    const target = TARGETS.find((candidate) => candidate.id === gap.target)
    return target?.expectation === 'required'
  }).length

  const evidence = {
    schema_version: SCHEMA_VERSION,
    kind: KIND_COLLECT,
    project: { root: projectRoot },
    digest: { algorithm: 'sha256', scope: 'files[path,bytes,sha256]', value: evidenceDigest(files) },
    targets,
    files,
    gaps,
    summary: {
      targets: targets.length,
      present,
      empty,
      absent,
      files: files.length,
      bytes: files.reduce((total, file) => total + (file.bytes ?? 0), 0),
      gaps: gaps.length,
      required_gaps: requiredMissing,
    },
  }

  await writeJsonFile(outPath, evidence)
  stdout.write(
    `collect：目标 ${targets.length}（present ${present} / empty ${empty} / absent ${absent}），` +
      `文件 ${files.length}，缺口 ${gaps.length}（其中 required ${requiredMissing}）\n` +
      `        证据摘要 ${evidence.digest.value.slice(0, 16)}… → ${outPath}\n`,
  )
  return 0
}

/* -------------------------------------------------------------------------- */
/* diff                                                                        */
/* -------------------------------------------------------------------------- */

async function readCollectFile(rawPath) {
  const absolute = resolve(rawPath)
  let text
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    throw new UsageError(`读不到 collect 文件（${errorCode(error)}）：${absolute}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`不是合法 JSON：${absolute}（${error.message}）`)
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== KIND_COLLECT) {
    throw new UsageError(`不是本脚本 collect 的产物（kind 应为 ${KIND_COLLECT}）：${absolute}`)
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new UsageError(
      `collect 格式版本不一致（文件 ${String(parsed.schema_version)}，脚本 ${SCHEMA_VERSION}）：请用同一版本重新 collect`,
    )
  }
  if (!Array.isArray(parsed.files)) throw new UsageError(`collect 文件缺 files 数组：${absolute}`)
  return { path: absolute, evidence: parsed }
}

function indexFiles(files) {
  const map = new Map()
  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue
    map.set(file.path, file)
  }
  return map
}

function describeSide(side) {
  const summary = side.evidence.summary ?? {}
  return {
    file: side.path,
    root: side.evidence.project?.root ?? null,
    digest: side.evidence.digest?.value ?? null,
    files: Array.isArray(side.evidence.files) ? side.evidence.files.length : 0,
    bytes: typeof summary.bytes === 'number' ? summary.bytes : null,
    required_gaps: typeof summary.required_gaps === 'number' ? summary.required_gaps : null,
  }
}

async function commandDiff(options) {
  assertKnownOptions(options, ['before', 'after', 'out'])
  const before = await readCollectFile(requireOption(options, 'before'))
  const after = await readCollectFile(requireOption(options, 'after'))

  const beforeFiles = indexFiles(before.evidence.files)
  const afterFiles = indexFiles(after.evidence.files)

  const added = []
  const removed = []
  const changed = []

  for (const [path, file] of afterFiles) {
    const previous = beforeFiles.get(path)
    if (previous === undefined) {
      added.push({ path, bytes: file.bytes, sha256: file.sha256, mtime: file.mtime, lines: file.lines ?? null })
      continue
    }
    const contentChanged = previous.sha256 !== file.sha256 || previous.bytes !== file.bytes
    const mtimeChanged = previous.mtime !== file.mtime
    if (!contentChanged && !mtimeChanged) continue
    changed.push({
      path,
      content_changed: contentChanged,
      bytes: [previous.bytes, file.bytes],
      sha256: [previous.sha256, file.sha256],
      mtime: [previous.mtime, file.mtime],
      lines: [previous.lines ?? null, file.lines ?? null],
    })
  }
  for (const [path, file] of beforeFiles) {
    if (afterFiles.has(path)) continue
    removed.push({ path, bytes: file.bytes, sha256: file.sha256, mtime: file.mtime, lines: file.lines ?? null })
  }

  const gapKey = (gap) => `${gap.target}\u0000${gap.path}\u0000${gap.reason}`
  const beforeGaps = new Map((before.evidence.gaps ?? []).map((gap) => [gapKey(gap), gap]))
  const afterGaps = new Map((after.evidence.gaps ?? []).map((gap) => [gapKey(gap), gap]))
  const gapsAdded = [...afterGaps.keys()].filter((key) => !beforeGaps.has(key)).sort(compareText).map((key) => afterGaps.get(key))
  const gapsRemoved = [...beforeGaps.keys()].filter((key) => !afterGaps.has(key)).sort(compareText).map((key) => beforeGaps.get(key))

  added.sort((a, b) => compareText(a.path, b.path))
  removed.sort((a, b) => compareText(a.path, b.path))
  changed.sort((a, b) => compareText(a.path, b.path))

  const result = {
    schema_version: SCHEMA_VERSION,
    kind: KIND_DIFF,
    before: describeSide(before),
    after: describeSide(after),
    added,
    removed,
    changed,
    unchanged: afterFiles.size - added.length - changed.length,
    gaps: { added: gapsAdded, removed: gapsRemoved },
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      changed_content: changed.filter((entry) => entry.content_changed).length,
      changed_mtime_only: changed.filter((entry) => !entry.content_changed).length,
      unchanged: afterFiles.size - added.length - changed.length,
    },
  }

  if (typeof options.out === 'string') {
    const outPath = await prepareOutputPath(options.out, null)
    await writeJsonFile(outPath, result)
    stdout.write(
      `diff：新增 ${result.summary.added} / 变更 ${result.summary.changed}` +
        `（内容 ${result.summary.changed_content}，仅 mtime ${result.summary.changed_mtime_only}）/ ` +
        `删除 ${result.summary.removed} → ${outPath}\n`,
    )
    return 0
  }

  stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* checklist                                                                   */
/* -------------------------------------------------------------------------- */

/** 断言标记：判据能不能直接读到，决定这条能不能算「通过」。 */
const TAGS = {
  direct: '〔可观察〕',
  construct: '〔需构造〕',
  unobservable: '〔不可观察〕',
}

/**
 * 七步验收内容。
 *
 * 这里就是清单的唯一真相：`docs/verify/l3-checklist.md` 由本脚本生成并提交，
 * 别手改生成物（要改断言就改这里，然后重新生成 + 提交）。
 *
 * 每条断言的 tag 是**诚实性**的一部分：
 * - direct    —— 人在本会话就能从工具原始返回或 collect 的 JSON 里读到；
 * - construct —— 必须先构造一个额外条件（改坏一个字段、开第二个会话、故意等超时）；
 * - unobservable —— 现有工具面产不出该判据，只能记 not-run 并写清为什么。
 */
const STEPS = [
  {
    n: 1,
    title: '安装、一次性会话、工具面（含同名工具归属与 doctor）',
    goal:
      '证明「红队指挥」preset 真的挂上了团队服务、三个 rt 工具与团队工具都可用，并且**同名工具确实是团队版**；' +
      '另证明在没有团队服务的环境里 `bin/doctor.mjs` 仍然可达。',
    a: ['A01', 'A02', 'A38'],
    setup: [
      '按 `docs/verify/README.md` 的「前置」装好 bundle（`link:` 进 profile + 写进 `dsh.profile.bundles`，顺序在团队 profile 之后），重启 DSH。',
      '新建**一次性**会话，模式选「红队指挥」（preset id `redteam-lead`）。已有会话保留它启动时的 preset，**必须新开**。',
      '在普通 shell（不是会话内）跑一次 `node <仓库根>/packages/dsh-redteam-lead/bin/doctor.mjs --profile %USERPROFILE%\\.dsh\\profiles\\desktop --project <临时项目根>`，记下完整 JSON 与退出码。',
      '在会话里先跑 `collect --project <临时项目根> --out <证据目录>\\s1-before.json`。',
    ],
    observe: [
      '会话里直接问：`list_agents` 的原始返回（`members[]` 的 `name`/`role`/`status`），Lead 伪行必须在第一行且 `role=lead`。',
      '工具参数面：故意少传一个必填字段（例如 `rt_roster` 只传 `action=inspect`）→ 判据是 `INVALID_ARGUMENT` 的具体报错文本，而不是"工具存在"。',
      '同名归属：用**不存在的成员名**做探针，保证零投递（见下面的断言）。',
      'doctor：看 `status`/`code`/`diagnostics[]`/`data.configuration_ready`/`data.runtime_ready`/`data.profile.bundle_listed`/`bundle_linked` 与退出码。',
    ],
    asserts: [
      { tag: 'direct', text: '`list_agents` 返回团队名册（含 Lead 伪行 `role=lead`、`name=lead`），说明 `ctx.agentTeams` 真的在，不是替身。' },
      { tag: 'direct', text: '三个 rt 工具的参数面与规格一致：`rt_roster` 必填 `project_root`、`action∈{inspect,bind,takeover}`；`rt_dispatch` 必填 `project_root/operation_id/post_id/route_id/target_ids/objective/evidence_required/prohibited`；`rt_conclude` 必填 `project_root/operation_id/dispatch_id/attempt_id/task_id/expected_revision/submission_ref/submission_sha256/review`。少传必填字段得到 `INVALID_ARGUMENT`。' },
      { tag: 'direct', text: '团队工具按**成员身份**注册（不是按 preset）：Lead 调 `team_task_list` 能拿到 `tasks[]`（空数组也算可用），`team_task_get`/`team_task_create`/`team_task_update`/`spawn_teammate`/`wait_agent` 在工具表里可见。' },
      { tag: 'direct', text: '同名工具归属（**不能只看名字**）：`send_message({target:"nobody-xyz",message:"probe"})` → 期望 `TEAM_MEMBER_NOT_FOUND`（参数名是团队版的 `target`，且零投递）；`send_message({agent_id:"nobody-xyz",message:"probe"})` → 期望参数校验失败（`agent_id` 不是本工具字段）。' },
      { tag: 'direct', text: '`interrupt_agent({target:"nobody-xyz"})` → 期望 `TEAM_MEMBER_NOT_FOUND`；`interrupt_agent({agent_id:"nobody-xyz"})` → 期望参数校验失败。两条合起来才证明挂载的是团队版而非 `tool-subagent-control` 版。' },
      { tag: 'direct', text: 'A01：`bin/doctor.mjs` 在**没有团队服务**的普通 shell 里可达：输出同一信封形状，`data.runtime_ready` 恒为字符串 `"unknown"`（不得是 `true`），`data.configuration_ready` 只反映离线配置，退出码 0（无硬阻塞）或 1（有硬阻塞）。' },
      { tag: 'direct', text: 'A01：doctor 的诊断带 `next_step`，且当本 bundle 未安装/未列进 `dsh.profile.bundles` 时，`[profile.bundle-listed]`/`[profile.bundle-declared]`/`[profile.bundle-linked]` 三条各给一条具体修复路径。' },
      { tag: 'direct', text: 'A38：`re/env/tools.json` 缺失时 `rt_roster` 只报 unknown/gap，**不得**自动生成该文件；`collect` 输出里 `env-tools` 目标应为 `absent`（若存在则记录其 sha256，用于后续比对是否被插件写过）。' },
      { tag: 'construct', text: 'A38：另一客户端（如 REA MCP）的工具表里出现同名 MCP 工具时，本会话的 `rt_roster` 不得因此判某能力为已就绪；构造方式是临时连一个 MCP server 再看 `gaps`，未连通时只允许报 discovered/unknown。' },
    ],
    codes: [
      ['少传必填字段（任一个 rt 工具）', '`INVALID_ARGUMENT`', '参数面证据'],
      ['`send_message` / `interrupt_agent` 指向不存在的成员', '`TEAM_MEMBER_NOT_FOUND`', '团队版参数名与零投递'],
      ['`send_message` 传 `agent_id`', '参数校验失败（无 `code`）', '证明不是 subagent-control 版'],
      ['在无团队服务的会话里调 rt 工具', '`TEAM_SERVICE_UNAVAILABLE`', '诊断必须指向 doctor'],
    ],
    evidence: [
      '`list_agents` 原始返回（整段 JSON）。',
      '四个探针（两个 `send_message`、两个 `interrupt_agent`）的原始返回与报错文本。',
      '`bin/doctor.mjs` 的完整 stdout + 退出码（`$LASTEXITCODE`）。',
      '`s1-before.json`（`collect` 产物）与它的 SHA-256。',
    ],
    gaps: [
      '「同名工具」在本 preset 下的另一半（`tool-subagent-control` 的 `send_message/list_agents/interrupt_agent`）**已被 patch 行删除**，所以会话里不存在两个活着的同名工具可供对比。能观察的只有「留下的这个的参数面/行为属于团队版」+「被删的那行确实不在 patch 里」。这是本步的如实边界，不是失败。',
      '`list_agents` 的确切字段名以实际返回为准；若与 `name/role/status` 不同，照抄原始输出，不要按预期改写。',
    ],
  },
  {
    n: 2,
    title: '`rt_roster`：兼容性、岗位需求、缺口、预算',
    goal:
      '证明名册是**按当前项目副本和当前能力**算出来的：兼容性有明确判定、可用岗位需求非空、缺口能对上实际缺的东西、' +
      '岗位数随目标与预算变化，且容量未知时不盲目派发。',
    a: ['A09', 'A40'],
    setup: [
      '在会话里对临时项目跑 `rt_roster`（`action=inspect`，默认只读）。跑之前先 `collect --out <证据目录>\\s2-before.json`。',
      '再跑一次，只改 `target_kinds`（例如 `["webapp"]` → `["game","webapp"]`）或 `max_posts`，记录 `posts` 数量与 `gaps` 的变化。',
      '若项目里没有 `re/team/capacity.json`：先看 `CAPACITY_UNKNOWN`；再按 D1 的格式写上 `schema_version/declared_at/declared_by/maxMembers/maxActiveSubagents` 后重跑，看 `capacity` 字段与 `gaps` 怎么变。',
      '全部 inspect 跑完后 `collect --out <证据目录>\\s2-after.json`，`diff` 必须为空（inspect 不写项目）。',
    ],
    observe: [
      '`data.compatibility`（`status`/`gaps`/`versions` 或 `rule_digest` 一类字段）与 `data.posts[]`（每个岗位的 `id`/`required`/`optional`/`priority`）。',
      '`data.gaps[].code` 与 `reason`/`next_step`；`data.capacity` 只有四个字段（`remaining_member_slots`/`remaining_activations`/`reserved_member_slots`/`reserved_activations`），未知用 `null`（D19：**没有** `known`）。',
      '`data.proposal_hash` 与 `data.binding_ref`：inspect 不得写 `binding_ref`（必须是 `null`）。',
    ],
    asserts: [
      { tag: 'direct', text: '项目副本兼容性有明确判定，不是"读到了就算过"：缺团队规则段 → `SKILL_INCOMPATIBLE` 且 `next_step` 要求按 skill 合并项目副本（**不得**用全局副本覆盖，也不得自动 `init`）。' },
      { tag: 'direct', text: '每个可用岗位的 `required`（与 `optional`）都非空；`disabled` 的预留岗不出现在可派岗位里（不得被当成可用岗）。' },
      { tag: 'direct', text: '缺口与当前能力相符：把一个确实缺的能力（例如未安装的 IDA / 未绑定的 provider）留在需求里 → `gaps` 出现 `CAPABILITY_MISSING` 或 `CAPABILITY_NOT_READY`，并且点名缺的能力族，而不是笼统"资源不足"。' },
      { tag: 'direct', text: '岗位数随目标与预算变化：改 `target_kinds`（webapp → game+webapp）后 `posts` 集合变化且并集去重；调小 `max_posts` 或 `reserved_member_slots` 后岗位被裁剪，裁剪结果稳定（同样入参两次结果一致）。' },
      { tag: 'direct', text: 'A09：没有容量声明时 `capacity.remaining_member_slots`/`remaining_activations` 为 `null`，`rt_roster`/`rt_dispatch` 报 `CAPACITY_UNKNOWN`，**不得**用常数 8 兜底、也不得靠 spawn 试探。' },
      { tag: 'direct', text: 'A09：声明容量后 `remaining_*` 变成可读数值（= 声明上限扣掉预留），并且 `gaps` 里出现 `ACTIVATION_USAGE_UNOBSERVED` 一类非阻塞诊断——「上限已声明、占用不可观测」必须是一条可读的 gap（D25），不是静默超配。' },
      { tag: 'direct', text: '`action=inspect` 零副作用：跑完后 `collect` 的 `digest` 与 `s2-before.json` 相同，且没有新增 `re/team/binding.json`。' },
      { tag: 'direct', text: 'A40：`data.project_id` 由项目根本身决定（同一根两次一致），`data.session_id`/`team_id` 是本会话的值；**不要**把上一次记录里的 pass 迁移过来。' },
      { tag: 'construct', text: 'A40：换执行者/换入口（例如同一项目在另一个 profile 或另一台机器上打开）后，`compatibility` 必须重算而不是沿用旧判定；构造方式是改 `re/team/binding.json` 里的 `rule_digest`/`session` 再 inspect，期望 `RECOVERY_REQUIRED` 或明确的"需要重新兼容检查"。' },
    ],
    codes: [
      ['缺团队规则段/布局不支持', '`SKILL_INCOMPATIBLE` / `PROJECT_NOT_CONFIGURED`', '不得覆盖副本、不得自动 init'],
      ['没有容量声明就派发', '`CAPACITY_UNKNOWN`', '先声明或改 profile config'],
      ['容量文件坏了/读不了', '`CAPACITY_DECLARATION_UNREAD`', '读失败不得当成没有声明'],
      ['缺能力', '`CAPABILITY_MISSING`', '点名能力族与下一步'],
      ['同一个根换了会话又来改', '`PROJECT_SESSION_MISMATCH`', '先接管/解绑'],
    ],
    evidence: [
      '两次（或多组入参）`rt_roster` 的**完整**返回。',
      '改容量声明前后的 `re/team/capacity.json` 内容 + `collect` 两次（`s2-capacity-before/after.json`）。',
      '`re/project.json` 与项目 skill 副本路径（用于证明兼容性读的是项目副本）。',
    ],
    gaps: [
      '`remaining_activations` 的真实占用**不可观测**（宿主没有任何 activation 占用查询），只能看到"D25 组装后的声明值 + 一条 gap"。因此"岗位数随预算变化"只能通过改声明或 `reserved_*` 入参构造，不能靠真实占用触发。',
      '`rt_roster` 无法回答"还剩几个席位上限"；`used` 只能从 `list_agents` 数 `role=teammate` 得到。',
    ],
  },
  {
    n: 3,
    title: '首次 `rt_dispatch`：身份、状态、契约落盘、不提前实验',
    goal:
      '证明首次派发真的建出了 `role=teammate` 的成员、任务落到 `in_progress` 且 owner 正确、契约完整落盘并与路线/任务/尝试身份对得上，' +
      '并且成员是**先拿到完整契约**再动手。',
    a: ['A10', 'A12', 'A13'],
    setup: [
      '先按项目 skill 建一条可执行路线：`re/routes/<R>.json` 的 `status` 必须是 `planned` 或 `active`（只有这两个可派）。',
      '`collect --out <证据目录>\\s3-before.json`。',
      '调 `rt_dispatch`（`project_root`/`operation_id`/`post_id`/`route_id`/`target_ids`/`objective`/`evidence_required`/`prohibited`，按需 `capability_needs`/`timebox_ms`/`delivery_timeout_ms`）。',
      '立刻 `collect --out <证据目录>\\s3-after.json`，然后 `diff --before s3-before.json --after s3-after.json`。',
    ],
    observe: [
      '`rt_dispatch` 返回 `status=ok`，`data` 含 `dispatch_id`/`attempt_id`/`task_id`/`member`/`route_id`/`revision`/`phase="delivered"`/`contract_ref`/`contract_sha256`/`work_dir`/`started_at`。',
      '`list_agents` 里新成员 `role=teammate`、`name == data.member`；`team_task_list` 里该 `task_id` 的 `status=in_progress`、`ownerName == data.member`。',
      '`collect` 新增 `re/team/dispatches/<D>.json`，其 `sha256` 必须等于 `data.contract_sha256`；`re/team/attempts/` 出现对应尝试记录。',
    ],
    asserts: [
      { tag: 'direct', text: 'A10：成员身份与任务状态对得上——`list_agents` 新行 `role=teammate`，`team_task_list` 同一 `task_id` 为 `in_progress` 且 `ownerName` 就是该成员，**不是** `pending + owner`（D3：不可达）。' },
      { tag: 'direct', text: 'A10：契约完整落盘且可校验——`re/team/dispatches/<dispatch>.json` 的 SHA-256 == `data.contract_sha256`，契约里的 `dispatch_id`/`attempt_id`/`task_id`/`route_id` 与工具返回、`team_task_list`、`re/routes/<R>.json` 完全一致；契约超过 64 KiB 时消息里只应有引用（D9），正文不得被截断。' },
      { tag: 'direct', text: 'A10：首派不提前实验——`rt_dispatch` 返回那一刻 `data.started_at` 为 `null`（`started_at` 只认成员写的 `start.json`）；`re/team/work/<D>/<A>/` 在成员回报前不得出现实验产物。' },
      { tag: 'direct', text: '契约里写明了「你没有派发权，缺人报回来」与工作目录边界（`re/team/work/<D>/<A>/`），且 `prohibited` 原样落盘（不能只剩摘要）。' },
      { tag: 'construct', text: 'A12：消息层失败要带已有身份返回 `partial`，且**同信封重投不重复启动**。构造方式：把 `delivery_timeout_ms` 调到极小值或临时把契约文件改成不可读，再观察 `status=partial` 且 `data` 里保留 `dispatch_id`/`attempt_id`；重投同一 `operation_id` 返回原结果（`replayed=true`）。' },
      { tag: 'construct', text: 'A12：超长消息必须被拒（`DELIVERY_FAILED`，`bytes`/`limit` 可读），不得截断后假报成功。构造方式：把 `objective` 撑到超过 65536 字节（注意 `send_message` 按含信封前缀的 JSON 字节计量，CJK 3 字节/字）。' },
      { tag: 'unobservable', text: 'A13：无 `start.json` 超 `delivery_timeout_ms` 必须报"未确认开始"而不是"已开始"。这一次性会话里成员会自动起跑，无法可靠制造"不写 start.json"，只能记 not-run。' },
    ],
    codes: [
      ['路线不存在/状态不可派', '`PROJECT_NOT_CONFIGURED` / `RECOVERY_REQUIRED`', '先按 skill 建路线'],
      ['岗位被别人占着', '`MEMBER_BUSY`', '先收口再派，不排队'],
      ['前置任务未完', '`DEPENDENCY_BLOCKED`', 'blocked 且零副作用'],
      ['容量未知', '`CAPACITY_UNKNOWN`', '声明容量'],
      ['消息层失败', '`DELIVERY_FAILED` / `partial`', '保留已有身份'],
    ],
    evidence: [
      '`rt_dispatch` 的完整返回（含 `operation_id`）。',
      '`team_task_list` 与 `list_agents` 的原始输出（派发后立刻取）。',
      '`re/team/dispatches/<D>.json` 的前 40 行（证明正文完整而不是引用摘要）+ 它的 SHA-256。',
      '`s3-before.json` / `s3-after.json` / `diff` 输出。',
      '成员第一份回报的原文（证明它是照契约做的、没有提前实验）。',
    ],
    gaps: [
      '「不提前实验」只能证明"`started_at` 在派发返回时为 null + 契约先于产物存在"，不能证明模型内部的时序；这是可观察性的上限。',
      'A13 的"两时间盒分开"需要制造"成员不写 start.json"，一次性会话里不可控，记 not-run。',
    ],
  },
  {
    n: 4,
    title: '同岗第二个任务：复用成员、`task_id` 变化、繁忙重派被拒',
    goal:
      '证明"先收口再派"的复用语义：成员数不变、新任务有新 `task_id`、成员拿到新的完整契约；同时证明忙碌时重派是**拒绝**而不是排队。',
    a: ['A11', 'A22'],
    setup: [
      '先让第 3 步那个任务走到 `completed`（见第 6 步；顺序上第 4 步在第 6 步之后执行也可，只要记录里写清实际顺序）。',
      '`collect --out <证据目录>\\s4-before.json`；再对**同一 `post_id`** 调 `rt_dispatch`（新的 `operation_id`）。',
      '收口后立刻 `collect --out s4-after.json`；`diff` 出变化。',
      '另测"忙碌重派"：在第二个任务还 `in_progress` 时，对同一 `post_id` 再派一次。',
    ],
    observe: [
      '前后 `list_agents` 的 teammate 行数（应相同，不是 +1）。',
      '`team_task_list` 的 `task_id` 集合（应新增一个，旧的那个仍是 `completed` 并保留 owner）。',
      '新契约文件与 `data.contract_sha256`；第二次调用的成员回报里引用的 `contract_ref` 是否换成新的。',
      '忙碌重派时 `rt_dispatch` 的 `status`/`code`，以及 `diff` 是否为**空**（零副作用）。',
    ],
    asserts: [
      { tag: 'direct', text: 'A11：成员数不变——`list_agents` 的 `role=teammate` 行数与第 3 步相同（复用同一成员），且这不是因为失败席位被跳过（`roster.json` 的 `phase` 不是 `failed`）。' },
      { tag: 'direct', text: 'A11：`task_id` 变化——`team_task_list` 出现新的 `task_id`，旧的仍是 `completed` 且 owner 保留（D3：`completed` 保留 owner），**不是**把旧任务改回 `in_progress`。' },
      { tag: 'direct', text: 'A11：成员收到新的**完整**契约——新 `re/team/dispatches/<D2>.json` 的 SHA-256 == 新 `data.contract_sha256` ≠ 旧契约的 SHA-256，且 `work_dir` 换成新的 attempt 目录。' },
      { tag: 'direct', text: 'A11：忙碌重派被拒——`status=blocked`、`code=MEMBER_BUSY`，`next_step` 明确要"先收口再派"，且 `diff` 显示**零新增/零变更**（不建成员、不建任务、不写契约）。' },
      { tag: 'construct', text: 'A22：若本次派发带 `resource_needs`，则观察 `re/team/resources.json` 的 `aliases`/`physical_identity`：同一物理实例的两个别名必须互斥，不同实例/只读共享才允许并行；构造方式是声明两个指向同一 `physical_identity` 的 `resource_key` 再派一次，期望 `OPERATION_CONFLICT` 或明确的互斥拒绝。' },
      { tag: 'unobservable', text: 'A22：残留进程/端口是否被隔离后不重分配，需要真的留着进程再申请资源；一次性会话里不做（会污染后续步骤），记 not-run 并写明缺什么。' },
    ],
    codes: [
      ['同岗忙碌再派', '`MEMBER_BUSY`', 'blocked + 零副作用'],
      ['旧任务未收口就想复用', '`MEMBER_BUSY`（同一成员最多一个未收口任务）', '不是排队'],
      ['资源物理身份冲突', '`OPERATION_CONFLICT`', '先登记 aliases 或换实例'],
      ['任务 revision 过期', '`REVISION_CONFLICT`', '带实际 revision'],
    ],
    evidence: [
      '两次派发的完整返回（`task_id`/`contract_ref`/`contract_sha256`/`work_dir` 四个字段要能并排对比）。',
      '两次 `list_agents` + `team_task_list` 原始输出（证明成员数不变、旧任务仍 `completed`）。',
      '忙碌重派的完整返回 + 那次 `diff` 的**空**结果。',
      '`s4-before.json` / `s4-after.json` / `diff`。',
    ],
    gaps: [
      '「先完成同岗首个任务的验收再派下一任务」这一步的顺序依赖第 6 步的收口结果，所以记录模板里要写清实际执行顺序（第 4 步可能在第 6 步之后）。',
    ],
  },
  {
    n: 5,
    title: '真实 teammate 越权被拒 + 下一层创建受限',
    goal:
      '用**真实成员身份**证明：teammate 调 `rt_dispatch`/`rt_conclude` 被身份拒绝且零副作用；' +
      '同时用真实 teammate 观察下一层创建受限，并把「裸子代理被拒」与「工具不存在」区分开。',
    a: ['A03', 'A08'],
    setup: [
      '在会话里给该成员派一个**只读探针任务**（或用 `send_message` 让它执行下列探针），要求它把原始返回贴回来。',
      '让 teammate 依次调用：`rt_dispatch`（随便合法入参）、`rt_conclude`（用真实 `dispatch_id`/`attempt_id`/`task_id`）、`subagent({prompt:"probe"})`、`workflow`（**不要真跑**，见 gaps）。',
      '`collect --out s5-before.json`（在 teammate 探针之前）与 `s5-after.json`（之后），`diff` 必须为空。',
      '再让 Lead 用 `subagent` 开一个**裸子代理**，让它调 `rt_dispatch`，记录它看到的是"工具不存在"还是"身份拒绝"。',
    ],
    observe: [
      'teammate 的原始工具返回：`status`/`code`/`reason`（`reason` 里应点出当前角色是 `teammate`）。',
      '`diff` 是否为空——这是"无副作用"的唯一机读判据。',
      '裸子代理那次的错误形状：`TEAM_SERVICE_UNAVAILABLE`（没有成员身份）vs 工具不存在（模型看不到该工具）。',
    ],
    asserts: [
      { tag: 'direct', text: 'A03：teammate 调 `rt_dispatch` → `code=ROLE_REQUIRED`（身份来自 `ctx.exec.agent` + 团队服务，不接受入参自报），`reason` 点名 `teammate`；`diff` 为零 → 无成员、无任务、无契约、无审计新增。' },
      { tag: 'direct', text: 'A03：teammate 调 `rt_conclude` → `code=ROLE_REQUIRED`；该任务仍是 `in_progress`、owner 不变、`re/team/receipts/` 无新增（零副作用）。' },
      { tag: 'direct', text: 'A03：`rt_roster action=inspect` 对真实成员是**允许**的（只读）；同一个 teammate 调 `bind`/`takeover` → `ROLE_REQUIRED`。' },
      { tag: 'direct', text: '下一层创建受限（真实 teammate）：`subagent` 与 `subagent_fork` 都被 depth 策略挡住（错误文本提到 depth/maxDepth），且**没有**真的建出孙代（`list_agents` 的成员数不变）。' },
      { tag: 'direct', text: 'A08：把「裸子代理看不到团队工具」与「看得见但被身份拒绝」分开记——裸子代理若拿不到团队工具（工具不存在），**不能**当作身份拒绝的证据；反之它若调到了 `rt_dispatch`，期望 `TEAM_SERVICE_UNAVAILABLE`（没有成员身份）而不是 `ROLE_REQUIRED`。' },
      { tag: 'unobservable', text: '`workflow` 不受 depth 限制（D5）：它传 `parent` 但从不传 `maxDepth`。**不要**为了验收真跑 `workflow`——那会真的开出孙代并烧掉 activation 名额。这一条只能按 D5 的静态结论与代码引用记录，标记为已知限制。' },
    ],
    codes: [
      ['teammate 调 `rt_dispatch`/`rt_conclude`', '`ROLE_REQUIRED`', '零副作用'],
      ['teammate 调 `rt_roster` 的 `bind`/`takeover`', '`ROLE_REQUIRED`', 'inspect 仍允许'],
      ['teammate 调 `subagent`/`subagent_fork`', 'depth 拒绝（宿主错误，非本包码）', '不得记成本包拒绝'],
      ['裸子代理调 `rt_dispatch`', '`TEAM_SERVICE_UNAVAILABLE`（或工具不存在）', '两者必须分开记'],
    ],
    evidence: [
      'teammate 回传的**原始**工具返回（不要复述，要原文）。',
      '`s5-before.json` / `s5-after.json` / `diff`（空的 diff 也要贴）。',
      '裸子代理那次的原始报错文本。',
      '`list_agents` 在探针前后的输出（证明没有孙代、没有新成员）。',
    ],
    gaps: [
      '`workflow` 的逃逸口**不可安全观察**：真要验证就得让它开出孙代。按要求只记录 D5 + 代码位置，列为已知限制。',
      '「下一层创建受限」只在 `subagent`/`subagent_fork` 路径上成立；把它写成"平台挡住一切下一层创建"是错的（D5 已更正）。',
    ],
  },
  {
    n: 6,
    title: '`rt_conclude`：真实归档/封存/校验、任务 `completed`、审计 +1、校验失败不得完成',
    goal:
      '证明收口不是"把任务标完成"，而是真的经项目 skill 归档、封存、跑检查后才完成任务；并且检查失败时**不**完成任务。',
    a: ['A15', 'A25', 'A26', 'A31', 'A44'],
    setup: [
      '成员只提交**独立工作区**产物：`submission_ref` 必须落在 `re/team/work/<D>/<A>/` 内，并给出 `submission_sha256`。',
      '`collect --out s6-before.json`。',
      '调 `rt_conclude`（带 `review.outcome`、`summary`、`reason`、`proposed_route_status`、`evidence_run_ids`、`anchor_refs`、`limitations`、`next_step`）。',
      '`collect --out s6-after.json`，`diff`。',
      '再构造一次失败：把 `submission_sha256` 改错一位重投（新的 `operation_id`），或在路线记录里制造一处 skill 会判失败的状态。',
    ],
    observe: [
      '`rt_conclude` 返回 `status=ok`，`data` 含 `phase="completed"`/`task_id`/`outcome`/`route_status`/`receipt_ref`/`checks[]`/`audit_written`。',
      '`team_task_list` 里该任务 `status=completed`（owner 保留）。',
      '`diff`：`re/team/receipts/<D>-<A>/` 新增文件、`re/team/audit.jsonl` 的 `lines` 增加（`collect` 的 `changed` 项会同时给出 `bytes`/`lines` 的前后值）、`re/routes/<R>.json` 的状态更新。',
      '失败那次：`status=error`、`code=SUBMISSION_INVALID` 或 `CHECK_FAILED`，任务仍 `in_progress`，只有 `failed-<op>.json` 一类轨迹新增。',
    ],
    asserts: [
      { tag: 'direct', text: 'A15 / 主路径：`rt_conclude` 成功后任务 `completed`，`data.receipt_ref` 指向 `re/team/receipts/<D>-<A>/` 下真实存在的文件，且 receipt 里 `submission.sha256` == 入参 `submission_sha256`。' },
      { tag: 'direct', text: '真实 skill 归档：receipt 的 `submission.archived_ref` 指向的正式副本存在，且其 SHA-256 与提交相同（`collect` 里能找到该路径）；不是"复制了个名字"。' },
      { tag: 'direct', text: '真实 skill 封存：若 `review.evidence_run_ids` 非空，`re/seals/runs/<RUN>.json` 出现（`collect` 的 `seals` 目标新增文件），receipt 的 `seals[]` 给出 `action`（如 `created`/`alreadySealed`）与 `path`；**不得**手工伪造 seal。' },
      { tag: 'direct', text: '真实 skill 校验：receipt 的 `checks[]` 每项有 `name`/`output_ref`/`exit_code`，成功路径全部 `exit_code === 0`；路线记录 `status` == `data.route_status`，`closure` 与 review 的判定相符（不能"任务完成、路线没动"）。' },
      { tag: 'direct', text: '审计多一条：`diff` 里 `re/team/audit.jsonl` 出现在 `changed` 且 `content_changed=true`、`lines` 递增；`data.audit_written === true`。' },
      { tag: 'construct', text: '校验失败不得完成：`submission_sha256` 改错 → `code=SUBMISSION_INVALID`（或 skill 侧走不动时 `CHECK_FAILED`），任务仍 `in_progress`、`re/routes` 未被改写、未新增成功回执。' },
      { tag: 'construct', text: 'A15：`UNREVIEWED_COMPLETION` 补验路径——先让成员自己用 `team_task_update action=complete` 把任务标完成（owner 有权），Lead 再 `rt_conclude`：期望标记 `UNREVIEWED_COMPLETION` 并**照跑全部检查**；成功时**不**重复 complete（revision 不二次递增），失败时不得据此放开依赖。' },
      { tag: 'construct', text: 'A26：校验后 task revision 改变 → `REVISION_CONFLICT` 且 `reason` 带实际 revision；构造方式是手工 `team_task_update` 改一次 revision（或另开一个成员任务）后再收口，期望拒绝而不是覆盖。' },
      { tag: 'construct', text: 'A31：新会话打开同一项目 → `rt_roster` 报既有绑定/会话不匹配（`PROJECT_SESSION_MISMATCH`），变更被拒直到 `takeover`；接管后 `re/team/history/epoch-N/` 出现归档且旧 `binding.json` 不被删除。构造方式：开第二个一次性会话。' },
      { tag: 'construct', text: 'A44：同一个不变缺口连续多轮只报首次/变化/恢复/用户动作，且可恢复（缺口消失后不再提示、不建后台监控）。构造方式：连续调两次 `rt_roster` 比对 `gaps` 文本，再补上缺的那项看提示是否消失。' },
      { tag: 'unobservable', text: 'A25：spawn/create/message/complete 成功但**响应丢失**（进程被杀、连接断）在本会话里无法可靠制造；记 not-run，并写明需要故障注入。' },
    ],
    codes: [
      ['提交哈希不对/不在工作区', '`SUBMISSION_INVALID`', '任务不得完成'],
      ['skill 检查失败', '`CHECK_FAILED`', '不降门槛、不改序（D29）'],
      ['原生 complete 后补验', '`UNREVIEWED_COMPLETION`', '检查照跑'],
      ['task revision 变了', '`REVISION_CONFLICT`', '带实际 revision'],
      ['同会话换了又改', '`PROJECT_SESSION_MISMATCH`', '先 takeover'],
      ['回执写不成', '`partial` + `RECOVERY_REQUIRED`', '业务已成功但不得报 ok'],
    ],
    evidence: [
      '`rt_conclude` 的完整成功返回（含 `checks[]`）。',
      '`team_task_list`（完成后）+ `list_agents`。',
      'receipt 全文（`re/team/receipts/<D>-<A>/` 下的 JSON）。',
      '`s6-before.json` / `s6-after.json` / `diff`（审计 `lines` 与 `routes` 的变化就在里面）。',
      '失败那次的完整返回 + `diff`（证明"只多了失败轨迹，没多成功回执"）。',
    ],
    gaps: [
      'A25（响应丢失）与 A13（超时）都需要故障注入，一次性会话里做不可靠，只能记 not-run。',
      '`checks[]` 的具体 `name` 由项目 skill 决定，本地不同副本可能不同；判据是"每项都有退出码且成功路径全 0"，不是固定名字列表。',
    ],
  },
  {
    n: 7,
    title: '`interrupt_agent` 与带 nonce 的唤醒',
    goal:
      '证明中断只改状态、不释放席位与任务；再用带 nonce 的 `send_message` 唤醒，并证明成员真的收到（回报里出现 nonce）。',
    a: ['A34'],
    setup: [
      '在任务开始后（成员 `status=running`）调 `interrupt_agent({target:"<成员名>"})`。',
      '立刻 `list_agents` + `team_task_list`，`collect --out s7-before.json`。',
      '生成一个 32 位十六进制 nonce，`send_message({target:"<成员名>", message:"唤醒探针 nonce=<nonce>；请原样回报该 nonce 与当前任务 id"})`。',
      '等成员回复（`wait_agent` 或直接读它发来的团队消息），记下回报原文。',
    ],
    observe: [
      '`interrupt_agent` 返回 `{previousStatus}`，取值只能是 `running` 或 `inactive`（枚举外的值即失败）。',
      '`list_agents` 里该成员仍在名册（`status` 变 `inactive`），`role=teammate` 行数不变。',
      '成员回报里出现 nonce 原文；`team_task_list` 的 `task_id`/`ownerName` 未被中断改写。',
    ],
    asserts: [
      { tag: 'direct', text: '`interrupt_agent` 返回 `previousStatus ∈ {running, inactive}`（D10：`provisioning`/`failed` 不可能出现）；调用者必须是 Lead，teammate 调用得到 `TEAM_LEAD_REQUIRED`。' },
      { tag: 'direct', text: '成员仍留在名册：`list_agents` 仍有该 `name`，`role=teammate` 计数不变（席位不因中断释放）。' },
      { tag: 'direct', text: '中断不释放任务：`team_task_list` 里该任务仍是原 `task_id`、`in_progress`、`ownerName` 不变；没有新的 attempt 被自动创建。' },
      { tag: 'direct', text: '带 nonce 的 `send_message` 投递成功，且**成员回报里出现该 nonce 原文**——这是"真的醒了"的唯一可观察判据（投递确认不等于它处理了）。' },
      { tag: 'direct', text: 'A34：收尾停止条件可读——所有任务 `completed` 或已显式交接，`rt_roster` 的 `capacity` 余额不再变化，Lead 不再新开路线；每轮先 `list_agents` + `team_task_list` 再决定动作（30 秒控制点回读），空闲等待是有界 `wait_agent` 而不是无限轮询。' },
      { tag: 'unobservable', text: 'A34 的"不承诺自动唤醒"是行为约束，不是单次调用能观察到的字段；只能以记录里"没有无限轮询/没有新开路线"的旁证支撑。' },
    ],
    codes: [
      ['teammate 调 `interrupt_agent`', '`TEAM_LEAD_REQUIRED`', '服务层拒绝'],
      ['中断不存在/非 active 的成员', '`TEAM_MEMBER_NOT_FOUND`', '不是"已中断"'],
      ['唤醒消息超 65536 字节', '`TEAM_MESSAGE_TOO_LARGE`', '含信封前缀计量'],
    ],
    evidence: [
      '`interrupt_agent` 的原始返回。',
      '中断前后的 `list_agents` 与 `team_task_list`。',
      '`send_message` 的投递确认 + 成员回报原文（nonce 高亮）。',
      '`s7-before.json` 与它之后的 `diff`（证明中断本身没写项目文件）。',
    ],
    gaps: [
      '`send_message` 的工具返回只是投递确认（不是对方的答复），所以 nonce 必须从**后续团队消息**里读到，不能从 `send_message` 的返回里读到。',
      '中断与唤醒的时序受模型调度影响；记录里要写清两次调用之间的实际间隔，否则"它没回 nonce"无法归因。',
    ],
  },
]

/** 生成 markdown。故意不写时间戳：清单是判据，不是记录。 */
function renderChecklist() {
  const lines = []
  const totalAsserts = STEPS.reduce((total, step) => total + step.asserts.length, 0)
  const totalDirect = STEPS.reduce(
    (total, step) => total + step.asserts.filter((assertion) => assertion.tag === 'direct').length,
    0,
  )

  lines.push('# 第三层验收清单（真 `ctx.agentTeams` 团队会话）')
  lines.push('')
  lines.push('> 本文件由 `node packages/dsh-redteam-lead/scripts/l3-verify.mjs checklist --out <path>` 生成。')
  lines.push('> **不要手改**：要改断言就改脚本里的 `STEPS`，重新生成并提交。')
  lines.push('>')
  lines.push('> **状态：未执行。** 截至本文件生成时，第三层一次都没有跑过。本文件是待办与判定标准，**不是通过结论**；')
  lines.push('> 通过与否只由 `docs/verify/` 下填好的记录文件决定（见 `l3-record-template.md`）。')
  lines.push('')
  lines.push(`七步共 ${totalAsserts} 条断言，其中 ${totalDirect} 条可直接观察；其余标了「需构造」或「不可观察」——`)
  lines.push('**不要**用"看起来对"去填这三类里的后两类。')
  lines.push('')
  lines.push('## 标记约定')
  lines.push('')
  lines.push('| 标记 | 含义 | 能不能算通过 |')
  lines.push('|---|---|---|')
  lines.push('| 〔可观察〕 | 本会话的原始工具返回或 `collect` 的 JSON 里能直接读到判据 | 能，贴原文即可 |')
  lines.push('| 〔需构造〕 | 必须先造一个额外条件（改坏一个字段、开第二个会话、故意等超时） | 能，但必须写清构造方式，否则不算 |')
  lines.push('| 〔不可观察〕 | 现有工具面产不出该判据 | **不能**。记 `not-run` + 为什么 |')
  lines.push('')
  lines.push('## 开始之前')
  lines.push('')
  lines.push('1. 读完 `docs/verify/README.md` 的「前置」；四项缺一项就不要开始（团队 profile bundle、bundle 已 `link:` 安装并列进 `dsh.profile.bundles`、临时分析项目已接 skill、Python 可达）。')
  lines.push('2. 复制 `docs/verify/l3-record-template.md` 成一份记录，填好会话 id 与开始时间。')
  lines.push('3. **一次性会话**：验收完即丢。席位按会话计，丢弃即释放；重跑要在新会话里重新建成员。')
  lines.push('4. 每一步都做「`collect` → 操作 → `collect` → `diff`」，diff 是"这一步到底写了什么"的唯一机读证据。')
  lines.push('')
  lines.push('每一步的取证命令固定是这三条（`<证据目录>` 必须**在项目根之外**，脚本会拒绝把 `--out` 写进项目）：')
  lines.push('')
  lines.push('```powershell')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\\sN-before.json')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\\sN-after.json')
  lines.push('node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs diff --before <证据目录>\\sN-before.json --after <证据目录>\\sN-after.json --out <证据目录>\\sN-diff.json')
  lines.push('```')
  lines.push('')
  lines.push('`collect` 的输出里有 `digest`（只覆盖 path/bytes/sha256，不含 mtime）：两次 `collect` 的 `digest` 相同 = 项目内容没变。')
  lines.push('')

  for (const step of STEPS) {
    lines.push(`## 第 ${step.n} 步 — ${step.title}`)
    lines.push('')
    lines.push(`**目标**：${step.goal}`)
    lines.push('')
    lines.push(`**本步覆盖的 A 编号**：${step.a.map((id) => `\`${id}\``).join('、')}`)
    lines.push('')
    lines.push('### 怎么做')
    lines.push('')
    step.setup.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`)
    })
    lines.push('')
    lines.push('### 看哪里')
    lines.push('')
    for (const item of step.observe) lines.push(`- ${item}`)
    lines.push('')
    lines.push('### 可观察断言')
    lines.push('')
    for (const assertion of step.asserts) {
      lines.push(`- [ ] ${TAGS[assertion.tag]}${assertion.text}`)
    }
    lines.push('')
    lines.push('### 期望错误码')
    lines.push('')
    lines.push('| 触发 | 期望 `code` / 状态 | 备注 |')
    lines.push('|---|---|---|')
    for (const [trigger, code, note] of step.codes) lines.push(`| ${trigger} | ${code} | ${note} |`)
    lines.push('')
    lines.push('### 本步要贴的证据')
    lines.push('')
    for (const item of step.evidence) lines.push(`- ${item}`)
    lines.push('')
    if (step.gaps.length > 0) {
      lines.push('### 本步不可观察 / 有边界的项（记 `not-run`，不要编）')
      lines.push('')
      for (const item of step.gaps) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  lines.push('## A 编号 → 步骤 → 可观察性')
  lines.push('')
  lines.push('| A 编号 | 步骤 | 能否在本会话观察 |')
  lines.push('|---|---|---|')
  const coverage = [
    ['A01', 1, '可观察（doctor 在普通 shell 跑）'],
    ['A02', 1, '部分：只能证明留下的是团队版，另一半已被 patch 删除'],
    ['A03', 5, '可观察（真实 teammate 的原始返回 + 空 diff）'],
    ['A08', 5, '可观察（裸子代理与成员两种错误形状分开记）'],
    ['A09', 2, '可观察（`CAPACITY_UNKNOWN` + 声明后的余额）'],
    ['A10', 3, '可观察（契约 SHA-256 == `contract_sha256`；`started_at` 为 null）'],
    ['A11', 4, '可观察（成员数不变、`task_id` 变、`MEMBER_BUSY` + 空 diff）'],
    ['A12', 3, '需构造（撑爆消息 / 极小超时），否则 not-run'],
    ['A13', 3, '不可观察（成员自动起跑，造不出"不写 start.json"）'],
    ['A15', 6, '需构造（先让成员自己 complete 再收口）'],
    ['A22', 4, '需构造（要声明 `resource_needs`）；残留进程项 not-run'],
    ['A25', 6, '不可观察（要故障注入：响应丢失）'],
    ['A26', 6, '需构造（手工改 revision 后收口）'],
    ['A31', 6, '需构造（开第二个会话做 takeover）'],
    ['A34', 7, '部分：停止条件与有界等待可读，"不承诺自动唤醒"只能旁证'],
    ['A38', 1, '部分：只报 discovered/unknown 可观察；另一客户端工具表需构造'],
    ['A40', 2, '可观察（`project_id` 由根决定、`session_id` 是本会话）＋需构造（换执行者）'],
    ['A44', 6, '需构造（连续两次 `rt_roster` 比对去重）'],
  ]
  for (const [id, step, note] of coverage) lines.push(`| \`${id}\` | 第 ${step} 步 | ${note} |`)
  lines.push('')
  lines.push('## 全表判定怎么写')
  lines.push('')
  lines.push('- 每步只允许三种判定：`pass`（本步所有〔可观察〕断言都有原文证据）、`fail`（任一条断言与期望不符，写清第几条）、`not-run`（没执行或只执行了部分，写清缺什么）。')
  lines.push('- 〔需构造〕断言没构造就是 `not-run`，不能算 `pass`。')
  lines.push('- 〔不可观察〕断言永远不进 `pass`；它们进 `docs/verify/acceptance-status.md` 的 `not-run` 并附原因。')
  lines.push('')
  lines.push('## 跑完要交的东西')
  lines.push('')
  lines.push('1. 填好的记录（从 `l3-record-template.md` 复制），命名 `<YYYYMMDD>-<会话 id 前 8 位>.md`，放在 `docs/verify/records/`。')
  lines.push('2. 每一步的 `collect` JSON + `diff` JSON，放在 `docs/verify/records/<同名>/`，并在记录里写出每个文件的 SHA-256。')
  lines.push('3. 一条结论：整层 `pass` / `fail` / `not-run`，以及**没有覆盖到的 A 编号**。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function commandChecklist(options) {
  assertKnownOptions(options, ['out'])
  const outPath = await prepareOutputPath(requireOption(options, 'out'), null)
  const markdown = renderChecklist()
  await writeFile(outPath, markdown, 'utf8')
  const asserts = STEPS.reduce((total, step) => total + step.asserts.length, 0)
  stdout.write(`checklist：${STEPS.length} 步 / ${asserts} 条断言 → ${outPath}\n`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(tokens) {
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h') || tokens[0] === 'help') {
    stdout.write(`${USAGE}\n`)
    return 0
  }
  const command = tokens[0]
  const options = parseArgv(tokens.slice(1))
  if (command === 'collect') return commandCollect(options)
  if (command === 'diff') return commandDiff(options)
  if (command === 'checklist') return commandChecklist(options)
  throw new UsageError(`未知子命令：${command}（用 --help 看用法）`)
}

const debug = argv.includes('--debug')
const tokens = argv.slice(2).filter((token) => token !== '--debug')

try {
  const code = await main(tokens)
  if (code !== 0) process.exitCode = code
} catch (error) {
  if (error instanceof UsageError) {
    stderr.write(`l3-verify: ${error.message}\n\n${USAGE}\n`)
    process.exitCode = 2
  } else {
    stderr.write(`l3-verify: 未预期的失败：${error?.message ?? String(error)}\n`)
    if (debug && typeof error?.stack === 'string') stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  }
}
