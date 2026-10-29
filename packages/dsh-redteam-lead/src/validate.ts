/**
 * 入参校验（JSON Schema 子集）与规范化。
 *
 * 形状只认 `docs/specs/rt-tools.schema.json` 的 `$defs`；本模块不复述、不改写规格。
 * 支持关键字：$ref（仅 `#/$defs/<name>`）、type、required、properties、additionalProperties、
 * items、enum、const、oneOf、anyOf、allOf、not、if/then/else、pattern、minLength、maxLength、
 * minimum、maximum、minItems、maxItems、uniqueItems、format（date-time）。
 * `if/then/else` 与 `not` 是规格数据里实际用到的（rosterInput 的 bind/takeover 分支、
 * result 信封的 ok 分支、review 的 outcome 门槛），缺了它们校验器会静默放行非法输入。
 *
 * 规范化顺序按编排契约：拒绝重复集合项 → 填默认值 → 规范化项目根 → 集合语义数组排序
 * →（调用方）对 tool/action/project/session/epoch 与输入按键排序求 SHA256。
 * 正文文本保留实际内容，不做 trim。
 *
 * 本模块不做 I/O：项目根的真实化通过注入的 `normalizeRoot` 完成。
 */

import { createHash } from 'node:crypto'

import { isRecord, thrownMessage } from './guards.js'

/** 递归深度上限，防御异常 schema（规格本身无环）。 */
const MAX_DEPTH = 64

/**
 * 一条校验问题（`path` 是 JSON Pointer 形式的位置）。
 *
 * `params` 只在某些关键字上出现（规格不需要它，人读诊断才需要），因此是可选的松散对象。
 */
export interface Issue {
  path: string
  keyword: string
  message: string
  params?: unknown
}

/**
 * 本模块认识的 schema 节点。
 *
 * schema 由 `JSON.parse` 读入（`docs/specs/rt-tools.schema.json`），关键字形状由规格保证；
 * 这里按 JSON Schema 的语义声明本模块真正读到的那些关键字，其余关键字仍可按名读取（`unknown`）。
 * 运行期判断保持原样：关键字缺省即跳过，非法值依旧走 JS 的比较/真值语义。
 */
interface SchemaNode extends Record<string, unknown> {
  /** 仅支持本地 `#/$defs/<name>`。 */
  $ref?: unknown
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  required?: string[]
  properties?: Record<string, unknown>
  additionalProperties?: unknown
  items?: unknown
  allOf?: unknown[]
  anyOf?: unknown[]
  oneOf?: unknown[]
  not?: unknown
  if?: unknown
  then?: unknown
  else?: unknown
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  format?: string
  default?: unknown
}

/** `$defs` 映射（定义名 → schema 节点）；值来自 JSON，读取时仍按需判断。 */
type Defs = Record<string, unknown>

/** 一次校验的共享上下文；`depth` 每层自增（`local` 是子层的副本）。 */
interface ValidationCtx {
  defs: Defs
  issues: Issue[]
  depth: number
}

/** `validateInput()` 的返回值。 */
export interface ValidationResult {
  ok: boolean
  issues: Issue[]
}

/** `normalizeInput()` 的入参。 */
export interface NormalizeInputOptions {
  /** 整份 schema（含 `$defs`）或 `$defs` 映射本身。 */
  schemaDefs?: unknown
  /** 定义名，如 `rosterInput`。 */
  defName?: string
  input?: unknown
  /** 项目根真实化；由调用方注入（本模块不做 I/O）。 */
  normalizeRoot?: (raw: string) => string | Promise<string>
}

/** `normalizeInput()` 的返回值。 */
export interface NormalizeInputResult {
  ok: boolean
  issues: Issue[]
  value: unknown
}

/** `operationInputHash()` 的上下文；值原样进哈希载荷，因此按写入方给什么就收什么。 */
export interface OperationHashContext {
  tool?: unknown
  action?: unknown
  project?: unknown
  session?: unknown
  epoch?: unknown
}

/**
 * 把任意读到的值记作一个 schema 节点。
 *
 * 不变量：本函数的入参一定来自 `$defs` 的条目或 `$ref` 的解析结果，即规格里的 schema 位置；
 * JSON Schema 允许这里出现 `true`/`false` 布尔 schema，而本模块对布尔 schema 的处理是
 * 「先做 `isRecord` 判断、原样放行」，所以类型上记作节点不会改变任何运行期行为。
 */
function asSchemaNode(value: unknown): SchemaNode {
  return value as SchemaNode
}

/** 数组判断（`Array.isArray` 的谓词版本，收窄成 `unknown[]` 而不是 `any[]`）。 */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** 非 null、非数组的对象（JSON 对象本体）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 允许入参是整份 schema（带 $defs）或 $defs 映射本身。 */
function defsOf(schemaDefs: unknown): Defs {
  if (!isRecord(schemaDefs)) throw new TypeError('schemaDefs 必须是对象')
  const defs = schemaDefs.$defs
  // `$defs` 缺省时，入参本身就是 $defs 映射（契约允许两种入参）。
  if (isRecord(defs)) return defs
  return schemaDefs
}

function schemaOf(schemaDefs: unknown, defName: string): { defs: Defs; schema: SchemaNode } {
  const defs = defsOf(schemaDefs)
  const schema = defs[defName]
  if (!schema) throw new TypeError(`未定义的 schema 定义: ${String(defName)}`)
  return { defs, schema: asSchemaNode(schema) }
}

/**
 * 解析 `$ref`（仅本地 `#/$defs/<name>`），并把同层兄弟关键字叠加到解析结果上。
 * 规格里 `{ "$ref": "...", "default": [] }` 这种写法依赖兄弟关键字仍然生效。
 */
function deref(node: unknown, defs: Defs, depth = 0): SchemaNode {
  if (!isRecord(node) || isArray(node)) return asSchemaNode(node)
  const ref = node.$ref
  if (typeof ref !== 'string') return asSchemaNode(node)
  if (depth > MAX_DEPTH) throw new TypeError(`$ref 解析过深: ${ref}`)
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref)
  if (!match) throw new TypeError(`不支持的 $ref: ${ref}`)
  const target = defs[match[1]]
  if (!target) throw new TypeError(`$ref 指向未定义的 $defs: ${ref}`)
  const { $ref, ...siblings } = node
  // 与 `{ ...resolved, ...siblings }` 等价（对象展开即 Object.assign 语义），
  // 这样不必对 unknown 的结果做类型断言。
  return asSchemaNode(Object.assign({}, deref(target, defs, depth + 1), siblings))
}

function escapePointer(text: string | number): string {
  return String(text).replaceAll('~', '~0').replaceAll('/', '~1')
}

function childPath(path: string, key: string | number): string {
  return `${path}/${escapePointer(key)}`
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const patternCache = new Map<string, RegExp>()

function patternOf(source: string): RegExp {
  let compiled = patternCache.get(source)
  if (!compiled) {
    compiled = new RegExp(source, 'u')
    patternCache.set(source, compiled)
  }
  return compiled
}

/**
 * 按键排序的 JSON 编码（UTF-8 语义），用于哈希与深比较。
 * 正文文本原样保留。
 *
 * 契约要求返回字符串：调用方只喂 JSON 值，而 `JSON.stringify` 对 JSON 值恒返回字符串
 * （只有 `undefined`/函数/Symbol 才返回 `undefined`，那不是本模块的入参）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) as string
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key])
    return out
  }
  return value
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function push(issues: Issue[], path: string, keyword: string, message: string, params?: unknown): void {
  issues.push({ path, keyword, message, ...(params ? { params } : {}) })
}

/**
 * 校验单个值。
 * @param node 已解引用的 schema 节点
 * @param path JSON Pointer 形式的位置
 */
function validateNode(node: SchemaNode, value: unknown, path: string, ctx: ValidationCtx): void {
  if (!isRecord(node)) return
  if (ctx.depth > MAX_DEPTH) {
    push(ctx.issues, path, 'schema-depth', 'schema 递归过深，拒绝继续校验')
    return
  }
  const local: ValidationCtx = { ...ctx, depth: ctx.depth + 1 }

  if (node.type !== undefined) {
    const allowed: unknown[] = isArray(node.type) ? node.type : [node.type]
    if (!allowed.some((type) => typeMatches(type, value))) {
      push(
        ctx.issues,
        path,
        'type',
        `类型应为 ${allowed.join('|')}，实际是 ${typeName(value)}`,
        { expected: allowed, actual: typeName(value) },
      )
      return
    }
  }

  if (isArray(node.enum) && !node.enum.some((candidate) => deepEqual(candidate, value))) {
    push(ctx.issues, path, 'enum', `取值必须是 ${node.enum.map((item) => JSON.stringify(item)).join('、')} 之一`, {
      allowed: node.enum,
    })
  }

  if (Object.hasOwn(node, 'const') && !deepEqual(node.const, value)) {
    push(ctx.issues, path, 'const', `取值必须恒为 ${JSON.stringify(node.const)}`, { expected: node.const })
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      push(ctx.issues, path, 'minLength', `长度不得小于 ${node.minLength}（实际 ${value.length}）`)
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      push(ctx.issues, path, 'maxLength', `长度不得大于 ${node.maxLength}（实际 ${value.length}）`)
    }
    if (node.pattern !== undefined && !patternOf(String(node.pattern)).test(value)) {
      push(ctx.issues, path, 'pattern', `不匹配必需格式 /${node.pattern}/`, { pattern: node.pattern })
    }
    if (node.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      push(ctx.issues, path, 'format', '必须是带时区的 ISO 8601 日期时间')
    }
  }

  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      push(ctx.issues, path, 'minimum', `不得小于 ${node.minimum}（实际 ${value}）`)
    }
    if (node.maximum !== undefined && value > node.maximum) {
      push(ctx.issues, path, 'maximum', `不得大于 ${node.maximum}（实际 ${value}）`)
    }
  }

  if (isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      push(ctx.issues, path, 'minItems', `至少需要 ${node.minItems} 项（实际 ${value.length}）`)
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      push(ctx.issues, path, 'maxItems', `最多允许 ${node.maxItems} 项（实际 ${value.length}）`)
    }
    if (node.uniqueItems === true) {
      const seen = new Map<string, number>()
      value.forEach((item, index) => {
        const key = canonicalJson(item)
        if (seen.has(key)) {
          push(
            ctx.issues,
            childPath(path, index),
            'uniqueItems',
            `与第 ${seen.get(key)} 项重复，集合项必须唯一`,
            { duplicatedIndex: seen.get(key) },
          )
        } else {
          seen.set(key, index)
        }
      })
    }
    if (node.items !== undefined) {
      const itemSchema = deref(node.items, ctx.defs)
      value.forEach((item, index) => validateNode(itemSchema, item, childPath(path, index), local))
    }
  }

  if (isPlainObject(value)) {
    const properties: Record<string, unknown> = node.properties && typeof node.properties === 'object'
      ? node.properties
      : {}
    if (isArray(node.required)) {
      for (const name of node.required) {
        if (!Object.hasOwn(value, name)) {
          push(ctx.issues, childPath(path, name), 'required', `缺少必填字段 ${name}`, { missing: name })
        }
      }
    }
    for (const [name, rawSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, name)) continue
      validateNode(deref(rawSchema, ctx.defs), value[name], childPath(path, name), local)
    }
    if (node.additionalProperties !== undefined) {
      const extras = Object.keys(value).filter((name) => !Object.hasOwn(properties, name))
      if (node.additionalProperties === false) {
        for (const name of extras) {
          push(ctx.issues, childPath(path, name), 'additionalProperties', `不允许的字段 ${name}`, { unexpected: name })
        }
      } else if (typeof node.additionalProperties === 'object') {
        const extraSchema = deref(node.additionalProperties, ctx.defs)
        for (const name of extras) {
          validateNode(extraSchema, value[name], childPath(path, name), local)
        }
      }
    }
  }

  if (isArray(node.allOf)) {
    for (const branch of node.allOf) {
      validateNode(deref(branch, ctx.defs), value, path, local)
    }
  }

  if (isArray(node.anyOf)) {
    const matches = node.anyOf.some((branch) => validateNodeReturnsOk(deref(branch, ctx.defs), value, path, local))
    if (!matches) push(ctx.issues, path, 'anyOf', '不满足任何一个允许的形状')
  }

  if (isArray(node.oneOf)) {
    const matches = node.oneOf.filter((branch) => validateNodeReturnsOk(deref(branch, ctx.defs), value, path, local))
    if (matches.length !== 1) {
      push(ctx.issues, path, 'oneOf', `必须恰好命中一种形状（命中 ${matches.length} 种）`, { matches: matches.length })
    }
  }

  if (node.not !== undefined) {
    if (validateNodeReturnsOk(deref(node.not, ctx.defs), value, path, local)) {
      push(ctx.issues, path, 'not', '命中了禁止的形状')
    }
  }

  if (node.if !== undefined) {
    const conditionHolds = validateNodeReturnsOk(deref(node.if, ctx.defs), value, path, local)
    const branch = conditionHolds ? node.then : node.else
    if (branch !== undefined) validateNode(deref(branch, ctx.defs), value, path, local)
  }
}

/** 子分支探测：用一个独立 issues 容器跑一遍，只关心是否零问题。 */
function validateNodeReturnsOk(node: SchemaNode, value: unknown, path: string, ctx: ValidationCtx): boolean {
  const issues: Issue[] = []
  validateNode(node, value, path, { defs: ctx.defs, issues, depth: ctx.depth })
  return issues.length === 0
}

/**
 * 按 `$defs` 中的定义校验入参。
 * @param schemaDefs 整份 schema（含 `$defs`）或 `$defs` 映射本身
 * @param defName 定义名，如 `rosterInput`
 */
export function validateInput(schemaDefs: unknown, defName: string, value: unknown): ValidationResult {
  const { defs, schema } = schemaOf(schemaDefs, defName)
  const issues: Issue[] = []
  validateNode(deref(schema, defs), value, '', { defs, issues, depth: 0 })
  return { ok: issues.length === 0, issues }
}

/** 遍历 schema 与值，对每个「数组且 uniqueItems」的节点回调。 */
function walkArrays(
  node: SchemaNode,
  value: unknown,
  defs: Defs,
  path: string,
  visit: (node: SchemaNode, array: unknown[], path: string) => void,
): void {
  if (!isRecord(node)) return
  if (isArray(value)) {
    visit(node, value, path)
    if (node.items !== undefined) {
      const itemSchema = deref(node.items, defs)
      value.forEach((item, index) => walkArrays(itemSchema, item, defs, childPath(path, index), visit))
    }
    return
  }
  if (isPlainObject(value) && node.properties && typeof node.properties === 'object') {
    for (const [name, rawSchema] of Object.entries(node.properties)) {
      if (!Object.hasOwn(value, name)) continue
      walkArrays(deref(rawSchema, defs), value[name], defs, childPath(path, name), visit)
    }
  }
}

/**
 * 规范化的第一步：拒绝重复集合项（语义为集合 = `uniqueItems: true` 的数组）。
 * @returns issues
 */
export function detectDuplicateSetItems(schemaDefs: unknown, defName: string, value: unknown): Issue[] {
  const { defs, schema } = schemaOf(schemaDefs, defName)
  const issues: Issue[] = []
  walkArrays(deref(schema, defs), value, defs, '', (node, array, path) => {
    if (node.uniqueItems !== true) return
    const seen = new Map<string, number>()
    array.forEach((item, index) => {
      const key = canonicalJson(item)
      if (seen.has(key)) {
        push(issues, childPath(path, index), 'uniqueItems', `与第 ${seen.get(key)} 项重复，集合项必须唯一`, {
          duplicatedIndex: seen.get(key),
        })
      } else {
        seen.set(key, index)
      }
    })
  })
  return issues
}

/**
 * 规范化第二步：按 schema 的 `default` 注解填默认值。
 * schema 的 default 只是注解，只有显式调用本函数才会生效（契约要求处理器显式填默认值）。
 * @returns 填好默认值的新对象（不改调用方入参）
 */
export function applyDefaults(schemaDefs: unknown, defName: string, value: unknown): unknown {
  const { defs, schema } = schemaOf(schemaDefs, defName)
  const out = structuredClone(value)
  fillDefaults(deref(schema, defs), out, defs)
  return out
}

function fillDefaults(node: SchemaNode, value: unknown, defs: Defs): void {
  if (!isRecord(node)) return
  if (isArray(value)) {
    if (node.items === undefined) return
    const itemSchema = deref(node.items, defs)
    for (const item of value) fillDefaults(itemSchema, item, defs)
    return
  }
  if (!isPlainObject(value) || !node.properties) return
  for (const [name, rawSchema] of Object.entries(node.properties)) {
    const propertySchema = deref(rawSchema, defs)
    if (!Object.hasOwn(value, name)) {
      if (Object.hasOwn(propertySchema, 'default')) {
        value[name] = structuredClone(propertySchema.default)
        fillDefaults(propertySchema, value[name], defs)
      }
      continue
    }
    fillDefaults(propertySchema, value[name], defs)
  }
}

/**
 * 规范化第四步：把语义为集合的数组（`uniqueItems: true`）按规范 JSON 排序，
 * 让同一集合的不同书写顺序得到同一哈希。
 * @returns 排序后的新对象
 */
export function sortSetArrays(schemaDefs: unknown, defName: string, value: unknown): unknown {
  const { defs, schema } = schemaOf(schemaDefs, defName)
  const out = structuredClone(value)
  walkArrays(deref(schema, defs), out, defs, '', (node, array) => {
    if (node.uniqueItems !== true) return
    array.sort((left, right) => {
      const a = canonicalJson(left)
      const b = canonicalJson(right)
      if (a === b) return 0
      return a < b ? -1 : 1
    })
  })
  return out
}

/**
 * 判断某个属性是否是契约里的 `$defs.root`（需要真实化的项目根）。
 * 先看原始 `$ref`（规格就是这么写的），再容忍内联的同形写法。
 */
function isRootSchema(rawSchema: unknown, resolvedSchema: SchemaNode, defs: Defs): boolean {
  if (isRecord(rawSchema) && rawSchema.$ref === '#/$defs/root') return true
  return Boolean(defs.root) && deepEqual(resolvedSchema, defs.root)
}

/**
 * 规范化第三步：把 `$defs.root` 形状的字段交给注入的真实化函数（IO 由调用方提供）。
 */
function normalizeRootFields(
  node: SchemaNode,
  value: unknown,
  defs: Defs,
  path: string,
  normalizeRoot: (raw: string) => string | Promise<string>,
): { value: unknown; issues: Issue[] } {
  const issues: Issue[] = []
  const apply = (currentNode: SchemaNode, currentValue: unknown, currentPath: string): unknown => {
    if (!isRecord(currentNode)) return currentValue
    if (isArray(currentValue)) {
      if (currentNode.items === undefined) return currentValue
      const itemSchema = deref(currentNode.items, defs)
      return currentValue.map((item, index) => apply(itemSchema, item, childPath(currentPath, index)))
    }
    if (!isPlainObject(currentValue) || !currentNode.properties) return currentValue
    const next: Record<string, unknown> = { ...currentValue }
    for (const [name, rawSchema] of Object.entries(currentNode.properties)) {
      if (!Object.hasOwn(next, name)) continue
      const propertySchema = deref(rawSchema, defs)
      if (isRootSchema(rawSchema, propertySchema, defs) && typeof next[name] === 'string') {
        try {
          next[name] = normalizeRoot(next[name])
        } catch (error) {
          push(issues, childPath(currentPath, name), 'root', `项目根无法规范化: ${thrownMessage(error)}`)
        }
        continue
      }
      next[name] = apply(propertySchema, next[name], childPath(currentPath, name))
    }
    return next
  }
  return { value: apply(node, value, path), issues }
}

/**
 * 校验 + 规范化：拒绝重复集合项 → 校验形状 → 填默认值 → 规范化项目根 → 集合排序。
 */
export async function normalizeInput(options: NormalizeInputOptions = {}): Promise<NormalizeInputResult> {
  const { schemaDefs, input, normalizeRoot } = options
  // 定义名缺省时 String(undefined) === 'undefined'，与迁移前 `defs[undefined]` 的键强制转换逐字一致
  // （随后因 `$defs` 里查不到该定义而抛 TypeError）。
  const defName = String(options.defName)
  const { defs, schema } = schemaOf(schemaDefs, defName)

  const duplicateIssues = detectDuplicateSetItems(schemaDefs, defName, input)
  if (duplicateIssues.length > 0) return { ok: false, issues: duplicateIssues, value: input }

  const validation = validateInput(schemaDefs, defName, input)
  if (!validation.ok) return { ok: false, issues: validation.issues, value: input }

  let value = applyDefaults(schemaDefs, defName, input)
  if (typeof normalizeRoot === 'function') {
    const normalized = normalizeRootFields(deref(schema, defs), value, defs, '', normalizeRoot)
    if (normalized.issues.length > 0) return { ok: false, issues: normalized.issues, value }
    value = normalized.value
  }
  value = sortSetArrays(schemaDefs, defName, value)
  return { ok: true, issues: [], value }
}

/**
 * 操作输入哈希：`{tool, action, project, session, epoch, input}` 按键排序后编码成 UTF-8 JSON 求 SHA256。
 *
 * 正文文本保留实际内容；身份上下文字段由调用方按该操作首次捕获的授权上下文传入。
 * 上下文各字段原样进哈希载荷（只做 JSON 编码），因此这里按调用方给什么就收什么。
 *
 * @param input 已规范化的输入
 * @returns 小写十六进制 SHA256
 */
export function operationInputHash(input: unknown, context: OperationHashContext = {}): string {
  const { tool = null, action = null, project = null, session = null, epoch = null } = context
  const payload = { tool, action, project, session, epoch, input }
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}
