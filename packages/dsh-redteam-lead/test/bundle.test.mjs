/**
 * bundle 形状测试：包清单、patch 行清单、preset 行、schema 副本漂移、工具注册接缝。
 *
 * 这些断言针对**文件与注册接缝**，不针对内部函数名：patch 写错一个插件名在宿主里是
 * WARN + SKIP（DECISIONS D14），所以这里必须解析出最终的 plugin id 列表再比对，
 * 而不是「文件里有这一行」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT))
const BASELINE = join(REPO_ROOT, 'docs', 'impl', 'baseline', 'standard.patch.rc3.yml')
const SPECS_SCHEMA = join(REPO_ROOT, 'docs', 'specs', 'rt-tools.schema.json')

/** 宿主 `standard` preset 的基线里被删掉的两行（与团队工具同名、语义不同）。 */
const REMOVED_ROWS = ['tool-subagent-control', 'tool-subagent-list-agents']

/** 本包追加的工具行 id。 */
const ADDED_ROW = 'redteam-lead-tools'

/** 基线里必须保留的裸委派行（Lead 用于零碎活）。 */
const KEPT_DELEGATION_ROWS = ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']

// ---------------------------------------------------------------------------
// 最小 YAML 读取器（无依赖；`dependencies` 必须为空，所以测试自带一个子集解析器）
// ---------------------------------------------------------------------------

const BLOCK_SCALAR = /^[|>][+-]?$/

function splitKey(text) {
  const match = /^([A-Za-z0-9_@./-]+):(?:[ \t]+(.*))?$/.exec(text)
  if (match === null) return undefined
  return { key: match[1], rest: match[2] ?? '' }
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('\\"', '"')
  }
  return text
}

function scalar(text) {
  const trimmed = text.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  // `!!js` 只出现在 config/disabled 里，值当字符串保留（本测试不执行表达式）。
  return unquote(trimmed)
}

/**
 * 解析块序列 / 块映射 / 标量 / 块标量的 YAML 子集。
 *
 * 块标量的内容在**分词阶段**就整段收进 token，所以块标量里的空行与以 `#` 开头的行
 * （例如人设里的 `## 共同准则`）不会被误当成注释丢掉。
 *
 * @param {string} text patch 文件内容
 * @returns {unknown} 顶层节点
 */
export function parsePatchYaml(text) {
  /** @type {Array<{indent: number, body: string, line: number, block?: string[]}>} */
  const lines = []
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index]
    if (line.trim().length === 0) continue
    if (line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (line.slice(0, indent).includes('\t')) throw new Error(`第 ${index + 1} 行含制表符缩进`)
    const token = { indent, body: line.slice(indent), line: index + 1 }
    // 块标量指示符（`|` / `|-` / `>`）：把后续更深缩进的行原样收进本 token。
    if (BLOCK_SCALAR.test(token.body.slice(token.body.indexOf(':') + 1).trim())) {
      const block = []
      let contentIndent
      let cursor = index + 1
      while (cursor < raw.length) {
        const next = raw[cursor]
        if (next.trim().length === 0) {
          block.push('')
          cursor += 1
          continue
        }
        const nextIndent = next.length - next.trimStart().length
        if (nextIndent <= indent) break
        if (contentIndent === undefined) contentIndent = nextIndent
        block.push(next.slice(contentIndent))
        cursor += 1
      }
      token.block = block
      index = cursor - 1
    }
    lines.push(token)
  }

  let cursor = 0
  const peek = () => lines[cursor]
  const fail = (message) => {
    const line = peek()
    throw new Error(`YAML 子集解析失败（第 ${line?.line ?? 'EOF'} 行）：${message}`)
  }

  const assign = (map, key, rest, keyIndent) => {
    if (rest === '') {
      const next = peek()
      if (next !== undefined && next.indent > keyIndent) map[key] = parseNode()
      else if (next !== undefined && next.indent === keyIndent && next.body.startsWith('- ')) map[key] = parseNode()
      else map[key] = null
      return
    }
    if (BLOCK_SCALAR.test(rest.trim())) {
      // 块标量的内容已在分词阶段挂在 token.block 上；这里只取出来。
      const owner = lines[cursor - 1]
      map[key] = Array.isArray(owner?.block) ? owner.block.join('\n') : ''
      return
    }
    map[key] = scalar(rest)
  }

  const parseMapping = (indent) => {
    const map = {}
    while (cursor < lines.length) {
      const line = peek()
      if (line.indent !== indent) break
      if (line.body.startsWith('- ')) break
      const pair = splitKey(line.body)
      if (pair === undefined) fail(`不是 key: value 形式：${line.body}`)
      cursor += 1
      assign(map, pair.key, pair.rest, indent)
    }
    return map
  }

  const parseSequence = (indent) => {
    const list = []
    while (cursor < lines.length) {
      const line = peek()
      if (line.indent !== indent || !line.body.startsWith('- ')) break
      const content = line.body.slice(2)
      const contentIndent = indent + 2
      cursor += 1
      const pair = splitKey(content)
      if (pair === undefined) {
        list.push(scalar(content))
        continue
      }
      const map = {}
      assign(map, pair.key, pair.rest, contentIndent)
      if (cursor < lines.length && peek().indent === contentIndent && !peek().body.startsWith('- ')) {
        Object.assign(map, parseMapping(contentIndent))
      }
      list.push(map)
    }
    return list
  }

  function parseNode() {
    const line = peek()
    if (line === undefined) return null
    if (line.body.startsWith('- ')) return parseSequence(line.indent)
    return parseMapping(line.indent)
  }

  const root = parseNode()
  if (cursor !== lines.length) fail('存在未能归属到任何节点的行')
  return root
}

/** 收集一棵 entry 列表里所有 row id（含 group 的 config 子列表）。 */
function flattenRowIds(rows) {
  const ids = []
  const walk = (list) => {
    assert.ok(Array.isArray(list), 'entry 列表必须是数组')
    for (const row of list) {
      assert.equal(typeof row, 'object', '每行必须是对象')
      assert.ok(row !== null && typeof row.id === 'string', '每行必须有字符串 id')
      ids.push(row.id)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  return ids
}

/** 收集一棵 entry 列表里所有 row（含 group 子列表）。 */
function flattenRows(rows) {
  const all = []
  const walk = (list) => {
    for (const row of list) {
      all.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  return all
}

function readText(path) {
  const bytes = readFileSync(path)
  // 基线快照历史上曾是 UTF-16LE（DECISIONS D18）；这里两种编码都容忍。
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le').replace(/^\uFEFF/, '')
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

/** 本包的 patch 内容与解析结果。 */
function loadPatch() {
  const path = join(PACKAGE_ROOT, 'cordis.patch.yml')
  assert.ok(existsSync(path), 'cordis.patch.yml 必须存在')
  const root = parsePatchYaml(readText(path))
  assert.ok(Array.isArray(root), 'patch 顶层必须是数组（include 的 read() 要求）')
  return root
}

/** 基线 `preset-standard.config.plugins` 的整段（解析结果）。 */
function loadBaselinePlugins() {
  const root = parsePatchYaml(readText(BASELINE))
  assert.ok(Array.isArray(root), '基线 patch 顶层必须是数组')
  const rows = flattenRows(root.filter((entry) => Array.isArray(entry?.insert)).flatMap((entry) => entry.insert))
  const preset = rows.find((row) => row?.config?.id === 'standard')
  assert.ok(preset, '基线里必须能找到 config.id=standard 的 preset 行')
  assert.ok(Array.isArray(preset.config.plugins), '基线 preset 的 config.plugins 必须是数组')
  return preset.config.plugins
}

/** 本包的 preset 行（`name: '@deepseek-ai/dsh-agent-preset'`）。 */
function loadPresetRow() {
  const root = loadPatch()
  const inserted = root.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
  const presets = inserted.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
  assert.equal(presets.length, 1, 'patch 必须恰好插入一个 preset 行')
  return presets[0]
}

/** 递归列出包内文件（跳过 node_modules/.git）。 */
function listPackageFiles(dir = PACKAGE_ROOT) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listPackageFiles(full))
    else out.push(full)
  }
  return out
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// 1. package.json 形状
// ---------------------------------------------------------------------------

test('package.json 满足 bundle 清单要求，dsh.bundle.patch 指向存在的文件', () => {
  const manifest = readPackageJson()

  assert.equal(manifest.name, '@local/dsh-redteam-lead')
  assert.equal(manifest.private, true)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.version, '0.1.0')

  // exports：入口 + locale（每个 locale 文件都必须能通过 exports 解析，DECISIONS D16）
  assert.equal(manifest.exports?.['.'], './dist/index.js')
  assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json')

  // files：ticket 要求的五项（TS 迁移后入口在 dist/，源码不进发布清单）
  const files = manifest.files ?? []
  for (const entry of ['dist', 'bin', 'cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(files.includes(entry), `files 必须列出 ${entry}`)
  }

  // dsh.bundle.patch → 一个真实存在的文件
  const patch = manifest.dsh?.bundle?.patch
  assert.ok(typeof patch === 'string' || Array.isArray(patch), 'dsh.bundle.patch 必须是字符串或数组')
  for (const entry of Array.isArray(patch) ? patch : [patch]) {
    assert.equal(typeof entry, 'string')
    assert.ok(existsSync(join(PACKAGE_ROOT, entry)), `dsh.bundle.patch 指向的文件不存在：${entry}`)
  }

  // 零运行时依赖：link: 安装的 bundle 不会安装依赖
  const dependencies = manifest.dependencies ?? {}
  assert.deepEqual(Object.keys(dependencies), [], 'dependencies 必须为空对象或不存在')
  assert.equal(manifest.devDependencies, undefined, 'devDependencies 也必须为空（干净 checkout 不装依赖）')
})

// ---------------------------------------------------------------------------
// 2. cordis.patch.yml：preset 行与 plugin id 清单
// ---------------------------------------------------------------------------

test('patch 只插入 preset 一行，本包工具行挂在它的 config.plugins 内', () => {
  const root = loadPatch()
  assert.equal(root.length, 1, 'patch 顶层只允许一段 insert')
  assert.deepEqual(Object.keys(root[0]), ['insert'], '顶层段只允许 insert')
  assert.equal(root[0].insert.length, 1, 'insert 里只有 preset 行；工具行必须挂在 preset 作用域内')
  assert.equal(root[0].insert[0].id, 'preset-redteam-lead')

  // 工具行落在 preset 的 plugins 里 → 只有选 redteam-lead 的会话能看到它
  const tools = loadPresetRow().config.plugins.find((row) => row.id === 'redteam-lead-tools')
  assert.ok(tools, 'config.plugins 里必须有本包行')
  assert.equal(tools.name, '@local/dsh-redteam-lead')
  assert.equal(tools.disabled, undefined)
  assert.equal(typeof tools.config, 'object', '本包行允许声明 config.defaults')
  assert.equal(tools.config.capacity, undefined, '不得在 profile config 里声明席位/activation 上限（DECISIONS D1）')
})

test('preset 行：id/显示名/order 与「红队指挥」一致', () => {
  const preset = loadPresetRow()
  assert.equal(preset.config.id, 'redteam-lead')
  assert.equal(preset.config.name, '红队指挥')
  assert.equal(preset.config.order, 6)
  assert.ok(typeof preset.config.description === 'string' && preset.config.description.trim().length > 0)
  // PresetDefinition 只接受五个字段：id/name/description/order/plugins
  assert.deepEqual(
    Object.keys(preset.config).sort(),
    ['description', 'id', 'name', 'order', 'plugins'],
    'preset config 只允许 id/name/description/order/plugins',
  )
})

test('plugin id 清单 = 基线清单 − 两个同名冲突行 + 本包行', () => {
  const baselineIds = flattenRowIds(loadBaselinePlugins())
  const actualIds = flattenRowIds(loadPresetRow().config.plugins)

  const expected = new Set(baselineIds)
  for (const removed of REMOVED_ROWS) {
    assert.ok(expected.delete(removed), `基线里必须有待删除的行 ${removed}`)
  }
  expected.add(ADDED_ROW)

  assert.deepEqual(new Set(actualIds), expected, 'preset 的最终 plugin id 集合必须与基线逐项对齐')
  assert.deepEqual(
    actualIds.slice().sort(),
    [...expected].sort(),
    '不允许重复 id（同层重复注册会抛错，跨层重复会遮蔽）',
  )
  assert.equal(
    actualIds.length,
    baselineIds.length - REMOVED_ROWS.length + 1,
    '行数必须是「基线 − 2 + 1」，多一行少一行都说明手抄漏了',
  )

  for (const removed of REMOVED_ROWS) {
    assert.ok(!actualIds.includes(removed), `${removed} 必须被删除（与团队工具同名、语义不同）`)
  }
  for (const kept of KEPT_DELEGATION_ROWS) {
    assert.ok(actualIds.includes(kept), `${kept} 必须保留（Lead 用于零碎活）`)
  }
  assert.ok(actualIds.includes(ADDED_ROW), '本包工具行必须存在')
})

test('每一行都声明了 name，group 行的 config 是子 entry 列表', () => {
  const rows = flattenRows(loadPresetRow().config.plugins)
  for (const row of rows) {
    assert.equal(typeof row.name, 'string', `行 ${row.id} 缺少 name（entryListProblem 会拒绝整棵 preset）`)
    assert.ok(row.name.trim().length > 0)
    if (row.group === true) {
      assert.equal(row.name, 'cordis:group', 'group 行的 name 必须是 cordis:group')
      assert.ok(Array.isArray(row.config), `group 行 ${row.id} 的 config 必须是子 entry 列表`)
    }
  }
})

test('persona 行：complete=false（否则吃掉 team:policy 段）、带 runtime context、人设角色中立', () => {
  const persona = flattenRows(loadPresetRow().config.plugins).find((row) => row.id === 'persona')
  assert.ok(persona, 'preset 必须有 persona 行')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.complete, false, 'persona 必须 complete: false，否则 team:policy 段被吃掉')
  assert.equal(persona.config.includeRuntimeContext, true)
  assert.equal(typeof persona.config.prefix, 'string')
  assert.ok(persona.config.prefix.trim().length > 0, 'persona prefix 不能为空')

  // 人设现在**点明身份**（资深逆向工程师 / 决策者 / 智囊），所以不再禁第二人称。
  // 但工兵继承同一 preset、也读这一段，所以必须同时给出两条角色分支；
  // 只写"你是团队的决策者"会让成员以为自己是 Lead、拒绝干活。
  assert.ok(persona.config.prefix.includes('收到派发契约'), '必须写明"收到契约"这条角色分支')
  assert.ok(persona.config.prefix.includes('Lead'), '必须写明无契约时按 Lead 走')
  assert.ok(!persona.config.prefix.includes('红队指挥'), '不得把「红队指挥」写成人设身份（工兵会误认）')

  // 证据纪律必须真的在：锚点 / 未验证推测 / 缺什么
  for (const phrase of ['锚点', '未验证推测', '缺']) {
    assert.ok(persona.config.prefix.includes(phrase), `人设必须包含证据纪律关键词：${phrase}`)
  }
  // 块标量里的标题行不能被当成 YAML 注释吃掉（解析器的回归点）
  assert.ok(persona.config.prefix.includes('## 红队作业准则'), 'persona 的块标量内容必须完整解析')

  // 红队作业准则（本包独有，skill 不管这一段）：不评价用户、越界要拒绝、破坏性操作先问、失败如实记。
  for (const phrase of ['不评价用户', '拒绝', '授权', '回滚', '失败']) {
    assert.ok(persona.config.prefix.includes(phrase), `红队作业准则必须包含：${phrase}`)
  }

  // 项目记录规则**委托给 skill**，本包不得重述。委托句里点话题名是对的（"封存、验收归 skill"），
  // 所以这里只盯 skill 的**命令原文**：出现就说明又把操作步骤抄了一遍。
  assert.ok(
    persona.config.prefix.includes('reverse-project-management'),
    '人设必须把项目记录规则指向 reverse-project-management skill'
  )
  for (const dup of ['INDEX.md', 'check --hashes', 'project.py']) {
    assert.ok(
      !persona.config.prefix.includes(dup),
      `人设不得重述 skill 的操作原文（出现 "${dup}" 说明又抄了一遍）`
    )
  }

  // 回归：人设必须点明 rt_* 的存在。实测过没有这段的版本 —— 三个工具都在 request/header 里，
  // 模型却一次都没调用（pwsh 44 次），因为宿主注入的 Agent Teams 说明覆盖了"怎么协作"，
  // 而人设只写了"怎么说话"。删掉这段就会静默退回到那个状态，所以要钉住。
  for (const tool of ['rt_roster', 'rt_dispatch', 'rt_conclude']) {
    assert.ok(persona.config.prefix.includes(tool), `persona 必须点明 ${tool}，否则模型知道有却不用`)
  }
  // 但**只点存在性**：第几步调、参数、容量处置都归工具描述（模型决策时读的是那里），
  // 人设里不该再铺一遍流程 —— 那是在拿 10% 的 prompt 席位去替工具描述打工。
  assert.ok(persona.config.prefix.includes('编排'), 'persona 必须有一段点明项目账目归 rt_*')
  assert.ok(!persona.config.prefix.includes('submission.json'), '流程细节应留在工具描述，不要塞回人设')
  assert.ok(!persona.config.prefix.includes('CAPACITY_UNKNOWN'), '容量处置应留在工具描述，不要塞回人设')
})

test('patch 里没有 sandbox / approval 声明（服务泄漏会让整棵 preset broken）', () => {
  const root = loadPatch()
  const text = readText(join(PACKAGE_ROOT, 'cordis.patch.yml'))
  for (const forbidden of ['danger-full-access', 'user-approval', 'sandbox-policy', 'sandboxPolicy', 'approval:']) {
    assert.ok(!text.includes(forbidden), `patch 不得包含 ${forbidden}（权限属于 host 平面）`)
  }
  const rows = flattenRows(root[0].insert)
  for (const row of rows) {
    assert.ok(!/sandbox|approval/i.test(row.name), `行 ${row.id} 声明了 ${row.name}：preset 不能带服务`)
    assert.equal(row.inject, undefined, 'preset 行不得声明 inject')
  }
})

// ---------------------------------------------------------------------------
// 3. 包内 schema 副本与规格无漂移
// ---------------------------------------------------------------------------

/** ticket 要求至少复制这些 `$defs`（三个入参 + result 的传递闭包）。 */
const REQUIRED_DEFS = [
  'text', 'id', 'sha256', 'path', 'root', 'routeId', 'runId', 'dispatchId', 'attemptId', 'strings',
  'kinds', 'date', 'routeStatus', 'outcome', 'errorCode', 'anchorKind', 'anchorRef', 'resource', 'post',
  'rosterInput', 'retryOf', 'dispatchInput', 'review', 'concludeInput', 'diagnostic', 'failureData',
  'result', 'rosterData', 'dispatchData', 'concludeData',
]

function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value)
      else collectRefs(value, out)
    }
  }
  return out
}

test('src/tool-schema.mjs 与 docs/specs/rt-tools.schema.json 逐 $defs 无漂移', async () => {
  const module = await import('../dist/tool-schema.js')
  const spec = JSON.parse(readFileSync(SPECS_SCHEMA, 'utf8'))

  for (const name of REQUIRED_DEFS) {
    assert.ok(module.schemaDefs?.[name], `包内 schema 缺少 $defs.${name}`)
  }

  for (const [name, def] of Object.entries(module.schemaDefs)) {
    assert.ok(spec.$defs[name], `包内多出规格里没有的 $defs: ${name}（升级后要重新对齐）`)
    assert.deepEqual(def, spec.$defs[name], `$defs.${name} 与 docs/specs/rt-tools.schema.json 不一致`)
  }

  // 对外导出的四个 schema 必须是副本里的同一份对象，不是手写的变体
  for (const name of ['rosterInput', 'dispatchInput', 'concludeInput', 'result']) {
    assert.equal(module[name], module.schemaDefs[name], `${name} 必须直接取自 schemaDefs`)
  }

  // 三个入参必须是封闭对象（raw JSON Schema 的工具没有自动校验，封闭性由这里保证）
  for (const name of ['rosterInput', 'dispatchInput', 'concludeInput']) {
    assert.equal(module[name].type, 'object')
    assert.equal(module[name].additionalProperties, false)
    assert.ok(Array.isArray(module[name].required) && module[name].required.includes('project_root'))
    for (const key of module[name].required) {
      assert.ok(key in module[name].properties, `${name}.required 里的 ${key} 必须在 properties 中`)
    }
  }

  // 副本必须自包含：所有 $ref 都能在 schemaDefs 里解析
  for (const [name, def] of Object.entries(module.schemaDefs)) {
    for (const ref of collectRefs(def)) {
      const match = /^#\/\$defs\/([^/]+)$/.exec(ref)
      assert.ok(match, `$defs.${name} 里出现非本地 $ref: ${ref}`)
      assert.ok(module.schemaDefs[match[1]], `$defs.${name} 的 $ref 指向副本里缺失的定义: ${ref}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 4. 注册用投影：output.schema 必须是宿主支持子集的 $defs.result 投影；
//    入参必须是自包含（$ref 就地展开）的原始 JSON Schema
// ---------------------------------------------------------------------------

test('output.schema 投影与 $defs.result 对齐，且在宿主支持子集内', async () => {
  const module = await import('../dist/tool-schema.js')
  const spec = JSON.parse(readFileSync(SPECS_SCHEMA, 'utf8'))
  const resultDef = spec.$defs.result
  const output = module.resultOutput

  // 宿主 assertSupportedJsonSchema：$ref / allOf / 类型数组 / pattern 一律 UNSUPPORTED_SCHEMA
  assert.deepEqual(hostSchemaViolations(output), [], 'resultOutput 必须在宿主支持子集内')
  assert.deepEqual(collectRefs(output), [], 'resultOutput 不得含 $ref')

  assert.equal(output.type, 'object')
  assert.equal(output.additionalProperties, false)
  assert.deepEqual(output.required, resultDef.required, '八个必填字段必须与 $defs.result 一致')
  assert.deepEqual(Object.keys(output.properties).sort(), Object.keys(resultDef.properties).sort())
  assert.equal(output.properties.schema_version.const, resultDef.properties.schema_version.const)
  assert.equal(output.properties.schema_version.type, 'integer')
  assert.deepEqual(output.properties.status.enum, resultDef.properties.status.enum)
  // code：ok 必须 null、其余取 $defs.errorCode；投影用 oneOf 表达 string|null
  assert.deepEqual(output.properties.code.oneOf[0].enum, spec.$defs.errorCode.enum, 'code 的枚举必须直接来自规格')
  assert.deepEqual(output.properties.code.oneOf[1], { type: 'null' })
  assert.deepEqual(output.properties.diagnostics.items.required, spec.$defs.diagnostic.required)
  assert.deepEqual(
    Object.keys(output.properties.diagnostics.items.properties).sort(),
    Object.keys(spec.$defs.diagnostic.properties).sort(),
  )
  assert.equal(output.properties.diagnostics.items.additionalProperties, false)
  assert.deepEqual(output.properties.data.oneOf, [{ type: 'object' }, { type: 'null' }])

  // 宿主校验器必须真的能用它：合法信封零违规，坏信封要被抓住
  const valid = {
    schema_version: 1, status: 'ok', code: null, operation_id: null,
    replayed: false, retryable: false, diagnostics: [], data: {},
  }
  assert.deepEqual(hostValueViolations(output, valid), [])
  assert.ok(hostValueViolations(output, { ...valid, status: 'bogus' }).length > 0, 'status 枚举要挡')
  assert.ok(hostValueViolations(output, { ...valid, code: 'NOPE' }).length > 0, '未经登记的错误码要挡')
  assert.ok(hostValueViolations(output, { ...valid, extra: 1 }).length > 0, 'additionalProperties:false 要挡')
  assert.ok(hostValueViolations(output, { ...valid, diagnostics: [{ code: 'X' }] }).length > 0, '诊断三字段必填')
})

test('三个入参 schema 在注册前展开 $ref（自包含），展开保留规格内容', async () => {
  const module = await import('../dist/tool-schema.js')
  const spec = JSON.parse(readFileSync(SPECS_SCHEMA, 'utf8'))

  for (const [exportName, defName] of [
    ['rosterParameters', 'rosterInput'],
    ['dispatchParameters', 'dispatchInput'],
    ['concludeParameters', 'concludeInput'],
  ]) {
    const projected = module[exportName]
    assert.deepEqual(collectRefs(projected), [], `${exportName} 不得残留 $ref（模型与严格 provider 解析不了）`)
    assert.equal(projected.type, 'object')
    assert.equal(projected.additionalProperties, false)
    assert.deepEqual(projected.required, spec.$defs[defName].required, `${exportName}.required 必须与规格一致`)
    assert.deepEqual(Object.keys(projected.properties).sort(), Object.keys(spec.$defs[defName].properties).sort())
  }

  // 嵌套 $ref 也要展开（抽查三层：kinds → items.enum、text → pattern、anchorRef → anchorKind）
  assert.deepEqual(module.rosterParameters.properties.target_kinds.items.enum, spec.$defs.kinds.items.enum)
  assert.equal(module.rosterParameters.properties.target_kinds.uniqueItems, true)
  assert.equal(module.dispatchParameters.properties.prohibited.items.pattern, spec.$defs.text.pattern)
  assert.deepEqual(
    module.concludeParameters.properties.review.properties.anchor_refs.items.required,
    spec.$defs.anchorRef.required,
  )
  assert.deepEqual(
    module.concludeParameters.properties.review.properties.anchor_refs.items.properties.kind.enum,
    spec.$defs.anchorKind.enum,
  )
  // 入参里用到的 $defs 闭包必须完整（不能展开成悬空对象）
  assert.deepEqual(module.inlineRefs({ $ref: '#/$defs/dispatchId' }), spec.$defs.dispatchId)
  assert.throws(() => module.inlineRefs({ $ref: '#/$defs/nope' }), /未定义/)
})

// ---------------------------------------------------------------------------
// 5. 工具注册与路由接缝
// ---------------------------------------------------------------------------

/**
 * 宿主 `assertSupportedJsonSchema` 的等价检查。
 *
 * 依据：`packages/core/tools/src/json-schema.ts`（E1 §C.2 引用的 `ctx.tools.register` 实现）。
 * 宿主只接受 `type / oneOf / properties / required / additionalProperties / items / enum / const`
 * 加注解；`$ref`、`allOf`、`anyOf`、`if/then/else`、`pattern`、类型数组都会让注册直接抛
 * `UNSUPPORTED_SCHEMA`、整行插件不激活。这里把它写成测试守卫，避免交付一个「测试全绿但挂不上」的包。
 *
 * @param {unknown} schema
 * @returns {string[]} 违规项（空 = 宿主会接受）
 */
function hostSchemaViolations(schema) {
  const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']
  const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
  const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
  const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
  const violations = []

  const walk = (node, at) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${at} must be a schema object`)
      return
    }
    for (const key of Object.keys(node)) {
      if (!CONSTRAINT.has(key) && !ANNOTATION.has(key)) violations.push(`${at}.${key} is not a supported keyword`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${at} cannot declare both type and oneOf`)
      return
    }
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${at}.${key} is not supported beside oneOf`)
      }
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${at}.oneOf must be an array of at least two schemas`)
      } else {
        node.oneOf.forEach((branch, index) => walk(branch, `${at}.oneOf[${index}]`))
      }
      return
    }
    if (!hasType) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, key)) violations.push(`${at}.${key} requires type or oneOf`)
      }
      return
    }
    if (typeof node.type !== 'string' || !TYPES.includes(node.type)) {
      violations.push(`${at}.type must be a single type string`)
      return
    }
    if (Object.hasOwn(node, 'properties')) {
      if (node.type !== 'object') violations.push(`${at}.properties is not supported on type "${node.type}"`)
      else if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        violations.push(`${at}.properties must be an object of schemas`)
      } else {
        for (const [key, value] of Object.entries(node.properties)) walk(value, `${at}.properties.${key}`)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (node.type !== 'object') violations.push(`${at}.required is not supported on type "${node.type}"`)
      else if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${at}.required must be an array of strings`)
      } else {
        const declared = node.properties ?? {}
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${at}.required names "${key}" which is not in properties`)
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties')) {
      if (node.type !== 'object') violations.push(`${at}.additionalProperties is not supported on type "${node.type}"`)
      else if (typeof node.additionalProperties !== 'boolean') violations.push(`${at}.additionalProperties must be a boolean`)
    }
    if (Object.hasOwn(node, 'items')) {
      if (node.type !== 'array') violations.push(`${at}.items is not supported on type "${node.type}"`)
      else walk(node.items, `${at}.items`)
    }
    for (const key of ['enum', 'const']) {
      if (!Object.hasOwn(node, key)) continue
      if (!SCALARS.includes(node.type)) {
        violations.push(`${at}.${key} is not supported on type "${node.type}"`)
        continue
      }
      const values = key === 'enum' ? node.enum : [node.const]
      if (!Array.isArray(values) || values.length === 0) {
        violations.push(`${at}.${key} must be a non-empty array`)
        continue
      }
      for (const value of values) {
        const matches =
          node.type === 'string' ? typeof value === 'string'
            : node.type === 'boolean' ? typeof value === 'boolean'
              : node.type === 'null' ? value === null
                : typeof value === 'number' && (node.type === 'number' || Number.isInteger(value))
        if (!matches) violations.push(`${at}.${key} value ${JSON.stringify(value)} is not a ${node.type}`)
      }
    }
  }

  walk(schema, 'schema')
  return violations
}

/**
 * 宿主 `validateJsonSchemaValue` 的等价检查：`output.render` 之前的返回值校验。
 * 用它断言「本包返回的每个信封都能通过宿主校验」，否则用户看到的是 `INVALID_TOOL_OUTPUT`。
 *
 * @param {unknown} schema 已通过 {@link hostSchemaViolations} 的 schema
 * @param {unknown} value 待校验的值
 * @returns {string[]} 违规项（空 = 宿主会接受）
 */
function hostValueViolations(schema, value) {
  const isPlain = (candidate) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)

  /** 纯函数：返回该节点对当前值的全部违规（oneOf 必须按分支独立判断，不能共享累加器）。 */
  const check = (node, current, path) => {
    if (Object.hasOwn(node, 'oneOf')) {
      let matched = 0
      for (const branch of node.oneOf) if (check(branch, current, path).length === 0) matched += 1
      return matched === 1 ? [] : [`${path} must match exactly one oneOf branch (matched ${matched})`]
    }
    if (!Object.hasOwn(node, 'type')) return []
    switch (node.type) {
      case 'object': {
        if (!isPlain(current)) return [`${path} must be an object`]
        const out = []
        const properties = node.properties ?? {}
        for (const key of node.required ?? []) {
          if (!Object.hasOwn(current, key) || current[key] === undefined) out.push(`${path}.${key} is required`)
        }
        for (const [key, childSchema] of Object.entries(properties)) {
          if (!Object.hasOwn(current, key)) continue
          out.push(...check(childSchema, current[key], `${path}.${key}`))
        }
        if (node.additionalProperties === false) {
          for (const key of Object.keys(current)) {
            if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} is not a declared property`)
          }
        }
        return out
      }
      case 'array': {
        if (!Array.isArray(current)) return [`${path} must be an array`]
        if (!Object.hasOwn(node, 'items')) return []
        return current.flatMap((item, index) => check(node.items, item, `${path}[${index}]`))
      }
      default: {
        const matches =
          node.type === 'string' ? typeof current === 'string'
            : node.type === 'boolean' ? typeof current === 'boolean'
              : node.type === 'null' ? current === null
                : typeof current === 'number' && (node.type === 'number' || Number.isInteger(current))
        if (!matches) return [`${path} must be a ${node.type}`]
        if (Object.hasOwn(node, 'const') && current !== node.const) {
          return [`${path} must equal ${JSON.stringify(node.const)}`]
        }
        if (Array.isArray(node.enum) && !node.enum.includes(current)) {
          return [`${path} must be one of ${node.enum.map((entry) => JSON.stringify(entry)).join('、')}`]
        }
        return []
      }
    }
  }

  return check(schema, value, 'value')
}

/** 与 `$defs.result` 等价的信封断言（不依赖任何实现，按 schema 逐条对）。 */
function assertResultEnvelope(envelope, context) {
  const { errorCodes, resultOutput } = context
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ['code', 'data', 'diagnostics', 'operation_id', 'replayed', 'retryable', 'schema_version', 'status'],
    '信封必须恰好是 $defs.result 的八个字段',
  )
  assert.equal(envelope.schema_version, 1)
  assert.ok(['ok', 'blocked', 'partial', 'error'].includes(envelope.status))
  assert.equal(typeof envelope.replayed, 'boolean')
  assert.equal(typeof envelope.retryable, 'boolean')
  assert.ok(envelope.data === null || typeof envelope.data === 'object')
  assert.ok(Array.isArray(envelope.diagnostics))
  for (const entry of envelope.diagnostics) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'next_step', 'reason'])
    for (const key of ['code', 'reason', 'next_step']) {
      assert.equal(typeof entry[key], 'string')
      assert.ok(entry[key].trim().length > 0, `诊断的 ${key} 不得为空`)
    }
  }
  if (envelope.status === 'ok') {
    assert.equal(envelope.code, null, 'ok 的 code 必须是 null')
    assert.equal(typeof envelope.data, 'object')
  } else {
    assert.ok(errorCodes.has(envelope.code), `非 ok 必须是稳定错误码，实际 ${String(envelope.code)}`)
    assert.ok(envelope.diagnostics.length >= 1, '非 ok 至少要一条诊断')
  }
  // 宿主会在快照/冻结/渲染前按注册的 output.schema 再校验一次
  assert.deepEqual(hostValueViolations(resultOutput, envelope), [], '返回的信封必须能通过宿主的 output.schema 校验')
}

/** 最小 Cordis 形状的假 ctx：只实现本插件用到的 `tools.register` 与 `get`。 */
function fakeCtx() {
  const registered = new Map()
  const ctx = {
    get(service) {
      if (service === 'tools') return ctx.tools
      return undefined // 团队服务缺席：本包必须照样注册、照样降级
    },
    tools: {
      register(definition) {
        if (definition.output === undefined || typeof definition.output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
        }
        if (registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
  return { ctx, registered }
}

/** 动态导入入口；兄弟 ticket（T1/T3/T4）还没合入时按契约 skip，不造假 stub。 */
async function importIndex(t) {
  try {
    return await import('../dist/index.js')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      const missing = String(error.message).split('\n').find((line) => line.includes('Cannot find')) ?? error.message
      t.skip(`waiting for sibling modules (T1 kernel / T3 catalog / T4 adapters): ${missing.trim()}`)
      return undefined
    }
    throw error
  }
}

test('三工具注册：raw JSON Schema（自包含）、output.schema 为宿主子集投影、render 全能', async (t) => {
  const index = await importIndex(t)
  if (index === undefined) return
  const schema = await import('../dist/tool-schema.js')
  const errorCodes = new Set(schema.schemaDefs.errorCode.enum)

  assert.equal(typeof index.apply, 'function')
  assert.equal(index.name, 'redteam-lead-tools')
  assert.deepEqual(index.inject, ['tools'], 'inject 只放硬依赖 tools；agentTeams 走 ctx.get 探针')

  const { ctx, registered } = fakeCtx()
  index.apply(ctx, { defaults: { max_posts: 6 } })
  assert.deepEqual([...registered.keys()].sort(), ['rt_conclude', 'rt_dispatch', 'rt_roster'])

  for (const [toolName, definition] of registered) {
    // 入参是**原始 JSON Schema**：对象级 required + 封闭
    assert.equal(definition.parameters.type, 'object', `${toolName}.parameters 必须是 object`)
    assert.equal(definition.parameters.additionalProperties, false, `${toolName}.parameters 必须封闭`)
    assert.ok(Array.isArray(definition.parameters.required) && definition.parameters.required.length > 0)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, 'description 是模型读的说明，不能敷衍')
    // 编排顺序写在**工具描述**里：模型决定调不调时读的是它，而不是人设第 2 段。
    // 实测过没有顺序的人设版 —— 三个工具都在，却 0 次调用。
    assert.match(definition.description, /Step \d/u, `${toolName}.description 必须写明它处在编排的第几步`)
    // 入参必须自包含：悬空 $ref 模型解析不了
    assert.deepEqual(collectRefs(definition.parameters), [], `${toolName}.parameters 不得残留 $ref`)

    // 返回值形状：宿主支持子集里的 $defs.result 投影（$ref/allOf/类型数组会让 register 直接抛）
    assert.deepEqual(definition.output.schema, schema.resultOutput, `${toolName}.output.schema 必须逐字等于 resultOutput`)
    assert.deepEqual(hostSchemaViolations(definition.output.schema), [], `${toolName}.output.schema 必须在宿主支持子集内`)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')

    // render 必须全能、纯、返回 [{type:'text',text}]
    const hostile = [
      undefined,
      null,
      {},
      { status: 'weird' },
      { status: 'ok', code: null, data: {} },
      { status: 'blocked', code: 'X', diagnostics: [{ code: 1, reason: null, next_step: {} }] },
      { status: 'partial', code: null, diagnostics: [], data: { phase: 'delivered' } },
    ]
    for (const value of hostile) {
      let blocks
      assert.doesNotThrow(() => {
        blocks = definition.output.render({}, value)
      }, `${toolName}.render 不得抛`)
      assert.ok(Array.isArray(blocks) && blocks.length >= 1)
      for (const block of blocks) {
        assert.equal(block.type, 'text')
        assert.equal(typeof block.text, 'string')
      }
    }
  }

  // 合法入参经注册表 → 真 handler → 合规信封（当前 handler 是占位：TEAM_SERVICE_UNAVAILABLE）
  const roster = registered.get('rt_roster')
  const value = await roster.execute({ project_root: 'D:\\workSpace\\PJ\\case01' }, { signal: undefined })
  assertResultEnvelope(value, { errorCodes, resultOutput: schema.resultOutput })
  assert.equal(value.status, 'blocked')
  assert.equal(value.code, 'TEAM_SERVICE_UNAVAILABLE')
  assert.ok(value.diagnostics[0].next_step.includes('bin/doctor.mjs'), '缺服务诊断必须给出 doctor 入口')
  const rendered = roster.output.render({ project_root: 'D:\\workSpace\\PJ\\case01' }, value)
  assert.match(rendered[0].text, /rt_roster/)
})

test('非法入参 → INVALID_ARGUMENT 且 handler 完全没有被调用', async (t) => {
  const index = await importIndex(t)
  if (index === undefined) return
  const schema = await import('../dist/tool-schema.js')
  const errorCodes = new Set(schema.schemaDefs.errorCode.enum)
  const { ctx } = fakeCtx()

  const calls = []
  const handler = async (_ctx, input) => {
    calls.push(input)
    return {
      envelope: {
        schema_version: 1, status: 'ok', code: null, operation_id: null,
        replayed: false, retryable: false, diagnostics: [], data: {},
      },
    }
  }
  const handlers = { roster: handler, dispatch: handler, conclude: handler }

  const cases = [
    // 缺必填
    { tool: 'rt_roster', args: {} },
    // 未知字段（additionalProperties: false）
    { tool: 'rt_roster', args: { project_root: 'D:\\p', surprise: 1 } },
    // bind 分支缺 operation_id / proposal_hash / target_kinds
    { tool: 'rt_roster', args: { project_root: 'D:\\p', action: 'bind' } },
    // inspect 分支禁止携带 operation_id
    { tool: 'rt_roster', args: { project_root: 'D:\\p', operation_id: 'op-1' } },
    // 非对象入参
    { tool: 'rt_dispatch', args: 'not-an-object' },
    // 空 target_ids（minItems: 1）
    {
      tool: 'rt_dispatch',
      args: {
        project_root: 'D:\\p', operation_id: 'op-1', post_id: 'binary-static', route_id: 'R-001',
        target_ids: [], objective: 'x', evidence_required: ['binary_location'], prohibited: [],
      },
    },
    // review 缺字段
    { tool: 'rt_conclude', args: { project_root: 'D:\\p' } },
  ]

  for (const { tool, args } of cases) {
    const value = await index.invokeTool({ tool, args, exec: {}, ctx, handlers })
    assertResultEnvelope(value, { errorCodes, resultOutput: schema.resultOutput })
    assert.equal(value.status, 'error', `${tool} ${JSON.stringify(args)} 应被拒绝`)
    assert.equal(value.code, 'INVALID_ARGUMENT')
    assert.ok(value.diagnostics[0].reason.length > 0)
  }
  assert.deepEqual(calls, [], '非法入参必须在产生任何副作用之前就被拦住：handler 不能被调用')

  // 对照：合法入参确实会调 handler，并且 roster 的 action 默认填成 inspect
  const ok = await index.invokeTool({
    tool: 'rt_roster',
    args: { project_root: 'D:\\p' },
    exec: {},
    ctx,
    handlers,
  })
  assertResultEnvelope(ok, { errorCodes, resultOutput: schema.resultOutput })
  assert.equal(ok.status, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'inspect', 'schema 的 default 只是注解，入口必须显式填 action=inspect')
})

test('handler 抛异常或返回不合规信封时，注册表只看到合法信封（不抛栈）', async (t) => {
  const index = await importIndex(t)
  if (index === undefined) return
  const schema = await import('../dist/tool-schema.js')
  const errorCodes = new Set(schema.schemaDefs.errorCode.enum)
  const { ctx } = fakeCtx()

  const throwing = await index.invokeTool({
    tool: 'rt_roster',
    args: { project_root: 'D:\\p' },
    exec: {},
    ctx,
    handlers: { roster: async () => { throw new Error('boom') } },
  })
  assertResultEnvelope(throwing, { errorCodes, resultOutput: schema.resultOutput })
  assert.equal(throwing.status, 'error')
  assert.ok(errorCodes.has(throwing.code))
  assert.match(throwing.diagnostics[0].reason, /boom/)
  assert.ok(!String(throwing.diagnostics[0].reason).includes('\n    at '), '不得把栈写进信封')

  // operation_id 必须被回显（信封构造器的参数名在文档与实现之间有差异，两个键都传）
  const withOperation = await index.invokeTool({
    tool: 'rt_dispatch',
    args: {
      project_root: 'D:\\p', operation_id: 'op-echo', post_id: 'binary-static', route_id: 'R-001',
      target_ids: ['T-001'], objective: 'x', evidence_required: ['binary_location'], prohibited: [],
    },
    exec: {},
    ctx,
    handlers: { dispatch: async () => { throw new Error('boom') } },
  })
  assertResultEnvelope(withOperation, { errorCodes, resultOutput: schema.resultOutput })
  assert.equal(withOperation.operation_id, 'op-echo', '失败信封也要回显 operation_id')

  const garbage = await index.invokeTool({
    tool: 'rt_dispatch',
    args: {
      project_root: 'D:\\p', operation_id: 'op-1', post_id: 'binary-static', route_id: 'R-001',
      target_ids: ['T-001'], objective: 'x', evidence_required: ['binary_location'], prohibited: [],
    },
    exec: {},
    ctx,
    handlers: { dispatch: async () => ({ envelope: { status: 'ok' } }) },
  })
  assertResultEnvelope(garbage, { errorCodes, resultOutput: schema.resultOutput })
  assert.equal(garbage.status, 'error')
  assert.match(garbage.diagnostics[0].reason, /result/)
})

// ---------------------------------------------------------------------------
// 6. 全包不得 import 任何 @deepseek-ai 包
// ---------------------------------------------------------------------------

test('全包没有 @deepseek-ai 的 import / require', () => {
  const offenders = []
  for (const file of listPackageFiles()) {
    if (!/\.(?:mjs|cjs|js|ts)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const pattern of [
      /(?:from|import)\s*\(?\s*['"]@deepseek-ai\//,
      /require\s*\(\s*['"]@deepseek-ai\//,
      /export\s+[^'"]*from\s*['"]@deepseek-ai\//,
    ]) {
      if (pattern.test(text)) offenders.push(`${relative(PACKAGE_ROOT, file)}: ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [], '本地 link: 的 bundle 不能 import @deepseek-ai/*（会 ERR_MODULE_NOT_FOUND）')
})

// ---------------------------------------------------------------------------
// 7. locale / icon（宿主只消费 meta.title 与 meta.description）
// ---------------------------------------------------------------------------

test('locale 与 icon 满足宿主的显示元数据要求', async () => {
  const localeDir = join(PACKAGE_ROOT, 'locale')
  const names = readdirSync(localeDir)
  assert.ok(names.includes('en.json'), 'en.json 必须存在（它锚定 locale 目录）')

  for (const name of names) {
    assert.match(name, /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/u, `locale 文件名必须是语言 id：${name}`)
    const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string', `${name} 缺 meta.title`)
    assert.ok(parsed.meta.title.trim().length > 0)
    assert.equal(typeof parsed.meta?.description, 'string', `${name} 缺 meta.description`)
    assert.ok(parsed.meta.description.trim().length > 0)

    // 每个 locale 文件都必须能通过 exports 解析（否则宿主的 metadata 读取会带 error）
    const manifest = readPackageJson()
    const pattern = manifest.exports?.['./locale/*.json']
    assert.equal(pattern, './locale/*.json')
    assert.ok(name.endsWith('.json'))
  }

  const icon = join(PACKAGE_ROOT, 'icon.svg')
  assert.ok(existsSync(icon), 'icon.svg 必须存在（files 里列了它）')
  const bytes = statSync(icon).size
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon 必须 ≤ 256 KiB，实际 ${bytes} 字节`)
  assert.equal(readPackageJson().exports?.['./icon'], './icon.svg')
})

test('不碰既有 redteam preset 与 @local/dsh-rea-plugin', () => {
  for (const file of [join(PACKAGE_ROOT, 'cordis.patch.yml'), join(PACKAGE_ROOT, 'dist', 'index.js')]) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('dsh-rea-plugin'), `${relative(PACKAGE_ROOT, file)} 不得引用既有 bundle`)
    assert.ok(!text.includes('rt_scan_command'), '既有包的工具名不得出现在本包 patch/入口里')
    assert.ok(!/id: preset-redteam(?![\w-])/.test(text), '既有 preset 行（preset-redteam）不得被本包覆盖')
  }
})
