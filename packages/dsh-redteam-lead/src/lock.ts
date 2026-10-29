/**
 * 项目锁 `re/team/lock`。
 *
 * 契约（「路径、锁与资源」）：
 * - 用**原子独占创建**取得锁；内容含 project/session、owner nonce、PID/进程启动身份和 operation。
 * - 冲突返回 `PROJECT_BUSY`，并带持有者信息与是否过期（只报告）。
 * - **过期时间不作为自动解锁理由**：`isStale()` 只报告，`acquire()` 永远不会抢锁。
 *   只有当原进程/Lead 确认不再写、恢复记录已保存后，才能走 `release({ force: true, recoveryRef })`。
 * - 锁只协调遵守协议的插件/Lead，不声称限制通用 shell 或文件工具。
 *
 * 崩溃后未完成操作先恢复；损坏的锁内容视为 `RECOVERY_REQUIRED`，不能当「没锁」继续。
 */

import { randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { tryCreateExclusive } from './atomic.js'
import { ContractError } from './errors.js'
import { isRecord, thrownCode } from './guards.js'
import { resolveInProject } from './paths.js'

/** 锁记录（wire 形状：已知字段可选，其余按索引读取）。 */
export interface LockRecord {
  schema_version?: number
  project?: string
  session?: string
  owner_nonce?: string
  pid?: number
  process_start_ms?: number
  operation?: string | null
  acquired_at?: string
  expires_at?: string | null
  [key: string]: unknown
}

/** `ownProcessIdentity()` 可注入的时钟。 */
export interface OwnProcessOptions {
  now?: () => number
  uptime?: () => number
}

/** 过期/失联判定可注入的探针（测试用假进程表）。 */
export interface StaleOptions {
  now?: number | (() => number)
  isAlive?: (pid: number) => boolean
  processStart?: (pid: number) => number | null
}

/** `acquire()` 的入参。 */
export interface AcquireOptions {
  session?: string
  operation?: string | null
  ownerNonce?: string
  now?: number | (() => number)
  ttlMs?: number | null
  pid?: number
  processStartMs?: number
  isAlive?: (pid: number) => boolean
  processStart?: (pid: number) => number | null
}

/** `release()` 的入参。 */
export interface ReleaseOptions {
  ownerNonce?: string
  force?: boolean
  recoveryRef?: string
}
/** 项目内锁路径（统一 `/`）。 */
export const LOCK_PATH = 're/team/lock'

/** 进程启动身份允许的抖动（毫秒）：不同平台读取精度不同。 */
const START_TOLERANCE_MS = 1000

/** `$defs.id` */
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/

function lockPathOf(root: string): string {
  return resolveInProject(root, LOCK_PATH)
}

function invalid(message: string, nextStep: string): ContractError {
  return new ContractError({ code: 'INVALID_ARGUMENT', message, nextStep })
}

/**
 * 本进程的 PID 与近似启动时刻。
 *
 * 启动时刻用 `now - uptime` 估算（跨平台可用），精度足够识别「PID 被新进程复用」。
 *
 * @param {{ now?: () => number, uptime?: () => number }} [options]
 * @returns {{ pid: number, start_ms: number }}
 */
export function ownProcessIdentity(options: OwnProcessOptions = {}): { pid: number; start_ms: number } {
  const { now = Date.now, uptime = () => process.uptime() } = options
  return { pid: process.pid, start_ms: Math.round(now() - uptime() * 1000) }
}

/**
 * 进程是否仍存在（`kill(pid, 0)`；EPERM 表示存在但无权限）。
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return thrownCode(error) === 'EPERM'
  }
}

function nowMsOf(now: number | (() => number) | null | undefined): number {
  if (typeof now === 'function') return now()
  return typeof now === 'number' ? now : Date.now()
}

/**
 * 过期/失联的具体理由（纯报告，不产生任何副作用）。
 *
 * @param {object | null} record 锁记录
 * @param {{ now?: number | (() => number), isAlive?: (pid: number) => boolean, processStart?: (pid: number) => number | null }} [options]
 * @returns {string[]} `expired` / `process_dead` / `pid_reused`
 */
export function staleReasons(record: LockRecord | null, options: StaleOptions = {}): string[] {
  if (!record || typeof record !== 'object') return []
  const { isAlive = isProcessAlive, processStart } = options
  const nowMs = nowMsOf(options.now)
  const reasons = []

  if (typeof record.expires_at === 'string') {
    const expiresAt = Date.parse(record.expires_at)
    if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) reasons.push('expired')
  }

  const alive = typeof record.pid === 'number' ? isAlive(record.pid) : false
  if (typeof record.pid === 'number' && !alive) reasons.push('process_dead')

  // 多出的 `typeof record.pid === 'number'` 只为让类型收窄成立：alive 为真时 pid 必然已是数字，运行期不改变任何分支。
  if (alive && typeof processStart === 'function' && typeof record.process_start_ms === 'number' && typeof record.pid === 'number') {
    const actual = processStart(record.pid)
    if (typeof actual === 'number' && Math.abs(actual - record.process_start_ms) > START_TOLERANCE_MS) {
      reasons.push('pid_reused')
    }
  }

  return reasons
}

/**
 * 是否疑似过期/失联。**只报告**——调用方不得据此自动释放或抢锁。
 * @param {object | null} record
 * @param {object} [options] 同 `staleReasons`
 * @returns {boolean}
 */
export function isStale(record: LockRecord | null, options: StaleOptions = {}): boolean {
  return staleReasons(record, options).length > 0
}

/**
 * 读取锁记录。
 * @param {string} root 已规范化的绝对根
 * @returns {Promise<object | null>} 无锁返回 null
 * @throws {ContractError} 内容损坏时 `RECOVERY_REQUIRED`
 */
export async function readLock(root: string): Promise<LockRecord | null> {
  let text
  try {
    text = await readFile(lockPathOf(root), 'utf8')
  } catch (error) {
    if (thrownCode(error) === 'ENOENT') return null
    throw new ContractError({
      code: 'RECOVERY_REQUIRED',
      message: `无法读取项目锁: ${LOCK_PATH}（${thrownCode(error) ?? 'unknown'}）`,
      nextStep: '确认项目根可读；锁文件异常时先按恢复记录核实再处理',
    })
  }

  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    throw new ContractError({
      code: 'RECOVERY_REQUIRED',
      message: `项目锁内容不是合法 JSON: ${LOCK_PATH}`,
      nextStep: '按恢复流程核实持有者并显式清理（release({force:true, recoveryRef})），不要当作无锁继续',
      details: { path: LOCK_PATH },
    })
  }
  if (!isRecord(record) || typeof record.owner_nonce !== 'string') {
    throw new ContractError({
      code: 'RECOVERY_REQUIRED',
      message: `项目锁内容缺少 owner_nonce: ${LOCK_PATH}`,
      nextStep: '按恢复流程核实持有者并显式清理，不要当作无锁继续',
      details: { path: LOCK_PATH },
    })
  }
  return record
}

/**
 * 取得项目锁（原子独占创建）。
 *
 * @param {string} root 已规范化的绝对根
 * @param {{
 *   session: string,
 *   operation?: string | null,
 *   ownerNonce?: string,
 *   now?: number | (() => number),
 *   ttlMs?: number | null,
 *   pid?: number,
 *   processStartMs?: number,
 *   isAlive?: (pid: number) => boolean,
 * }} options
 * @returns {Promise<{ acquired: true, record: object }>}
 * @throws {ContractError} `PROJECT_BUSY`（已被持有）或 `RECOVERY_REQUIRED`（锁损坏）
 */
export async function acquire(root: string, options: AcquireOptions = {}): Promise<{ acquired: true; record: LockRecord }> {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new ContractError({
      code: 'PATH_INVALID',
      message: `项目根必须是绝对路径: ${JSON.stringify(root)}`,
      nextStep: '先调用 normalizeProjectRoot 得到规范根',
    })
  }
  const { session, operation = null, ownerNonce, ttlMs = null, isAlive = isProcessAlive, processStart } = options
  if (typeof session !== 'string' || session.trim() === '') {
    throw invalid('acquire 需要非空 session', '传入当前会话标识（TeamId/root SessionId）')
  }
  if (operation !== null && operation !== undefined && !OPERATION_ID_PATTERN.test(String(operation))) {
    throw invalid(`operation 形状非法: ${JSON.stringify(operation)}`, '使用 $defs.id 允许的形状')
  }
  if (ownerNonce !== undefined && (typeof ownerNonce !== 'string' || ownerNonce.trim() === '')) {
    throw invalid('ownerNonce 必须是非空字符串', '留空则由本模块生成随机 nonce')
  }

  const nonce = ownerNonce ?? randomBytes(16).toString('hex')
  const nowMs = nowMsOf(options.now)
  const identity =
    options.pid !== undefined
      ? { pid: options.pid, start_ms: options.processStartMs ?? nowMs }
      : ownProcessIdentity({ now: () => nowMs })

  const record = {
    schema_version: 1,
    project: root,
    session,
    owner_nonce: nonce,
    pid: identity.pid,
    process_start_ms: identity.start_ms,
    operation: operation ?? null,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: typeof ttlMs === 'number' ? new Date(nowMs + ttlMs).toISOString() : null,
  }

  const lockPath = lockPathOf(root)
  // 独占创建走 `atomic.tryCreateExclusive()`（`O_EXCL` + 瞬时错误有界重试，EEXIST 不重试）。
  // 锁的「已存在」永远是冲突信号：不读回内容比较，直接按 PROJECT_BUSY 报告持有者。
  const created = await tryCreateExclusive(lockPath, `${JSON.stringify(record, null, 2)}\n`)
  if (!created) {
    const holder = await readLock(root) // 损坏时抛出 RECOVERY_REQUIRED：绝不当成没锁
    throw new ContractError({
      code: 'PROJECT_BUSY',
      message: `项目锁已被持有: ${LOCK_PATH}（session=${String(holder?.session)} operation=${holder?.operation ?? 'null'} pid=${String(holder?.pid)}）`,
      nextStep:
        '等待持锁操作结束；只有核实原进程/Lead 不再写且恢复记录已保存后，才用 release({force:true, recoveryRef}) 显式清理',
      details: {
        holder,
        stale: isStale(holder, { now: nowMs, isAlive, processStart }),
      },
    })
  }

  return { acquired: true, record }
}

/**
 * 释放项目锁。
 *
 * - 默认只允许 `ownerNonce` 匹配的持有者释放（幂等：无锁返回 `released=false`）。
 * - `force` 只允许在显式恢复路径调用，必须给 `recoveryRef`（恢复核查记录的项目内路径）。
 *
 * @param {string} root 已规范化的绝对根
 * @param {{ ownerNonce?: string, force?: boolean, recoveryRef?: string }} [options]
 * @returns {Promise<{ released: boolean, forced: boolean, previous: object | null }>}
 */
export async function release(root: string, options: ReleaseOptions = {}): Promise<{ released: boolean; forced: boolean; previous: LockRecord | null }> {
  const { ownerNonce, force = false, recoveryRef } = options
  const lockPath = lockPathOf(root)

  let previous: LockRecord | null
  try {
    previous = await readLock(root)
  } catch (error) {
    if (!(force && typeof recoveryRef === 'string' && recoveryRef.trim() !== '')) throw error
    previous = null
  }

  if (force) {
    if (typeof recoveryRef !== 'string' || recoveryRef.trim() === '') {
      throw invalid(
        'release({force:true}) 必须在显式恢复路径调用，并提供 recoveryRef',
        '先核实原进程/Lead 已停止写入并保存恢复记录，再传 recoveryRef',
      )
    }
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    return { released: true, forced: true, previous }
  }

  if (previous === null) return { released: false, forced: false, previous: null }

  if (typeof ownerNonce !== 'string' || ownerNonce !== previous.owner_nonce) {
    throw new ContractError({
      code: 'PROJECT_BUSY',
      message: `项目锁持有者不是当前操作: ${LOCK_PATH}（session=${previous.session}）`,
      nextStep: '不要抢别人持有的锁；确需清理走显式恢复路径 release({force:true, recoveryRef})',
      details: { holder: previous },
    })
  }

  await unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  return { released: true, forced: false, previous }
}
