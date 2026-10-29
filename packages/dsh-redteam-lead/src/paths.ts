/**
 * 项目根规范化与项目内相对路径校验。
 *
 * 规则来自编排契约「路径、锁与资源」：
 * - `project_root` 必须是显式选择的本地分析目录，规范化为真实绝对根（`realpath`）并核对是目录。
 * - 插件生成的项目内路径统一用 `/`；拒绝绝对/盘符/UNC、空段、`.`/`..`、反斜杠、控制字符和 Windows ADS。
 * - 写入前逐级检查所有祖先及现有目标都不是 symlink/junction/reparse point，且新文件父目录在根内。
 * - 大小写折叠后的路径碰撞拒绝（Windows 文件系统不区分大小写，`Re` 与 `re` 会互相覆盖）。
 *
 * 判定函数（`assertProjectRelative` / `findCaseCollision` / `resolveInProject`）是纯函数；
 * 文件系统检查集中在 `normalizeProjectRoot` / `assertSafeWriteTarget` / `assertNoCaseCollision`。
 */

import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { ContractError } from './errors.js'
import { thrownCode, thrownMessage } from './guards.js'

/** 控制字符（含 NUL / 换行 / DEL）：Windows 上会被截断或被驱动层特殊解释。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const PATH_NEXT_STEP = '改用项目内以 / 分隔的相对路径（例如 re/team/binding.json），不要传绝对路径、.. 或盘符'

function pathInvalid(
  message: string,
  nextStep: string = PATH_NEXT_STEP,
  details?: Record<string, unknown>,
): ContractError {
  return new ContractError({ code: 'PATH_INVALID', message, nextStep, details })
}

/** `root` 必须是真实绝对路径（断言函数：通过后调用方拿到 `string`）。 */
function assertAbsoluteRoot(root: unknown): asserts root is string {
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
    throw pathInvalid(`项目根必须是真实绝对路径: ${JSON.stringify(root)}`, '先用 normalizeProjectRoot 得到规范根再拼路径')
  }
}

/**
 * 校验并返回项目内相对路径。
 *
 * 通过时原样返回（调用方已保证 `/` 分隔、无空段），不做大小写或文本改写。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export function assertProjectRelative(relativePath: unknown): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw pathInvalid(`项目内路径必须是非空字符串: ${JSON.stringify(relativePath)}`)
  }
  if (CONTROL_CHARS.test(relativePath)) {
    throw pathInvalid('项目内路径不得包含控制字符')
  }
  if (relativePath.includes('\\')) {
    throw pathInvalid(`项目内路径不得包含反斜杠: ${relativePath}`)
  }
  if (relativePath.includes(':')) {
    throw pathInvalid(`项目内路径不得包含冒号（盘符或 Windows ADS）: ${relativePath}`)
  }
  if (relativePath.startsWith('/')) {
    throw pathInvalid(`项目内路径不得是绝对路径或 UNC 路径: ${relativePath}`)
  }
  for (const segment of relativePath.split('/')) {
    if (segment.length === 0) {
      throw pathInvalid(`项目内路径不得有空段（// 或结尾 /）: ${relativePath}`)
    }
    if (segment === '.' || segment === '..') {
      throw pathInvalid(`项目内路径不得包含 . 或 .. 段: ${relativePath}`)
    }
  }
  return relativePath
}

/**
 * 非抛出版本，供快速判定。
 */
export function isProjectRelative(value: unknown): boolean {
  try {
    assertProjectRelative(value)
    return true
  } catch {
    return false
  }
}

/**
 * 把项目内相对路径解析为绝对路径（不做文件系统检查）。
 */
export function resolveInProject(root: unknown, relativePath: unknown): string {
  assertAbsoluteRoot(root)
  const validated = assertProjectRelative(relativePath)
  return join(root, ...validated.split('/'))
}

/** 目标是否在根内（Windows 上按大小写不敏感比较，避免盘符大小写造成假阴性）。 */
function isWithin(rootReal: string, targetReal: string): boolean {
  const relation = relative(rootReal, targetReal)
  if (relation === '') return true
  const folded = process.platform === 'win32' ? relation.toLowerCase() : relation
  if (isAbsolute(relation)) return false
  return !(folded === '..' || folded.startsWith(`..${sep}`) || folded.startsWith('../'))
}

/**
 * 规范化项目根：必须是已存在的绝对目录，返回 `realpath` 后的真实绝对根。
 *
 * 链接/重解析点会被解析到真实位置；调用方得到的是可比较的规范根。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export async function normalizeProjectRoot(projectRoot: unknown): Promise<string> {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw pathInvalid('project_root 必须是非空字符串', '传入显式选择的本地分析目录绝对路径')
  }
  if (!isAbsolute(projectRoot)) {
    throw pathInvalid(`project_root 必须是绝对路径: ${projectRoot}`, '传入显式选择的本地分析目录绝对路径')
  }

  let canonical: string
  try {
    canonical = await realpath(projectRoot)
  } catch (error) {
    throw pathInvalid(
      `project_root 无法解析为真实路径: ${projectRoot}（${thrownCode(error) ?? thrownMessage(error) ?? 'unknown'}）`,
      '确认目录存在、路径拼写正确且当前用户可访问',
      { projectRoot, code: thrownCode(error) },
    )
  }

  let stats: Stats
  try {
    stats = await stat(canonical)
  } catch (error) {
    throw pathInvalid(
      `project_root 无法读取: ${canonical}（${thrownCode(error) ?? 'unknown'}）`,
      '确认目录可访问',
    )
  }
  if (!stats.isDirectory()) {
    throw pathInvalid(`project_root 不是目录: ${canonical}`, '传入分析项目根目录，而不是文件')
  }
  return canonical
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target)
  } catch (error) {
    const code = thrownCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw pathInvalid(`无法检查路径组件: ${target}（${code ?? 'unknown'}）`, '确认路径及其祖先可访问')
  }
}

/**
 * 写入前的路径安全检查：逐级确认祖先与现有目标不是链接/重解析点，
 * 且最深的已存在祖先真实路径仍在根内。返回写目标绝对路径。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export async function assertSafeWriteTarget(root: unknown, relativePath: unknown): Promise<string> {
  assertAbsoluteRoot(root)
  const validated = assertProjectRelative(relativePath)
  const segments = validated.split('/')

  const rootReal = await realpath(root).catch(() => root)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const stats = await lstatOrNull(current)
    if (stats === null) break // 从这里开始尚不存在：已核验的祖先都在根内且无链接
    if (stats.isSymbolicLink()) {
      throw pathInvalid(
        `写入路径穿过链接/重解析点: ${validated}（组件 ${segment}）`,
        '改用项目内普通目录；插件只允许写 re/team/** 等真实目录',
        { relativePath: validated, component: segment },
      )
    }
    const isLast = index === segments.length - 1
    if (!isLast && !stats.isDirectory()) {
      throw pathInvalid(`写入路径的中间段不是目录: ${validated}（组件 ${segment}）`, '检查路径拼写')
    }
  }

  let ancestor = dirname(join(root, ...segments))
  for (;;) {
    const stats = await lstatOrNull(ancestor)
    if (stats !== null) break
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const ancestorReal = await realpath(ancestor).catch(() => null)
  if (ancestorReal !== null && !isWithin(rootReal, ancestorReal)) {
    throw pathInvalid(
      `写入目标逃出项目根: ${validated}`,
      '目标必须位于项目根内',
      { relativePath: validated, ancestor },
    )
  }

  return join(root, ...segments)
}

/**
 * 大小写折叠碰撞：若存在仅大小写不同的既有条目则返回该条目名，否则 null。
 *
 * 完全同名不算碰撞（那是同一个条目，由调用方决定覆盖语义）。
 */
export function findCaseCollision(existingNames: Iterable<unknown>, candidate: unknown): string | null {
  const names = [...existingNames]
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  if (names.includes(candidate)) return null
  const folded = candidate.toLowerCase()
  for (const name of names) {
    if (typeof name === 'string' && name.toLowerCase() === folded) return name
  }
  return null
}

/**
 * 逐级检查待写入路径是否与既有条目仅大小写不同；一旦发现即拒绝。
 *
 * 尚不存在的层级无需检查（更深的层级也不可能已存在）。
 *
 * @throws {ContractError} code=PATH_INVALID
 */
export async function assertNoCaseCollision(root: unknown, relativePath: unknown): Promise<void> {
  assertAbsoluteRoot(root)
  const validated = assertProjectRelative(relativePath)

  let current = root
  for (const segment of validated.split('/')) {
    let names: string[]
    try {
      names = await readdir(current)
    } catch (error) {
      const code = thrownCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw pathInvalid(`无法列出目录以检查大小写碰撞: ${current}（${code ?? 'unknown'}）`, '确认目录可访问')
    }
    const collision = findCaseCollision(names, segment)
    if (collision !== null) {
      throw pathInvalid(
        `大小写折叠后与既有条目碰撞: ${validated} ↔ ${collision}`,
        '与既有条目保持完全一致的大小写，或改用不含歧义的名字',
        { relativePath: validated, existing: collision },
      )
    }
    const stats = await lstatOrNull(join(current, segment))
    if (stats === null || !stats.isDirectory()) return
    current = join(current, segment)
  }
}
