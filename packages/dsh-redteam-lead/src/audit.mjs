/**
 * 审计日志 `re/team/audit.jsonl`（append-only）。
 *
 * 契约（「操作阶段与部分失败」）：
 * - 审计是 **best-effort**：写失败不逆转已有证据判定，也不抛异常；
 *   调用方据返回值把 `audit_written=false` 写进回执，并附一条诊断。
 * - 每行是一个 JSON 对象，字段固定为 `at/kind/route/task/member/requester/verdict`。
 * - append-only：只追加、不重写、不回滚；一行一条记录。
 *
 * 需要「必需回执写失败」时走 `partial` 信封，那不是审计的职责（审计失败仍可以 ok）。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 项目内审计文件路径（统一 `/`）。 */
export const AUDIT_PATH = 're/team/audit.jsonl'

/**
 * 固定列顺序。缺省填 null，未知字段丢弃 —— 保证 JSONL 每行列一致、可直接被工具消费。
 */
export const AUDIT_FIELDS = Object.freeze(['at', 'kind', 'route', 'task', 'member', 'requester', 'verdict'])

function isoNowOf(clock) {
  if (clock && typeof clock.isoNow === 'function') return clock.isoNow()
  if (typeof clock === 'function') return new Date(clock()).toISOString()
  return new Date().toISOString()
}

function column(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * 追加一条审计记录。
 *
 * **绝不抛出**：任何失败都以 `{ written: false, error }` 返回，由调用方写入 `audit_written=false`。
 *
 * @param {string} root 已规范化的项目根
 * @param {{ kind: string, route?: string|null, task?: string|null, member?: string|null,
 *           requester?: string|null, verdict?: string|null, at?: string|null }} entry
 * @param {{ clock?: { isoNow?: () => string } | (() => number) }} [options]
 * @returns {Promise<{ written: true, line: string } | { written: false, error: string }>}
 */
export async function appendAudit(root, entry, options = {}) {
  try {
    if (typeof root !== 'string' || root.length === 0) {
      return { written: false, error: '缺少项目根，无法写入审计' }
    }
    if (!entry || typeof entry !== 'object') {
      return { written: false, error: '审计条目必须是对象' }
    }
    if (typeof entry.kind !== 'string' || entry.kind.trim() === '') {
      return { written: false, error: '审计条目缺少 kind（非空字符串）' }
    }

    const at = typeof entry.at === 'string' && entry.at.length > 0 ? entry.at : isoNowOf(options.clock)
    const record = {}
    for (const field of AUDIT_FIELDS) {
      record[field] = field === 'at' ? at : column(entry[field])
    }

    const line = `${JSON.stringify(record)}\n`
    const filePath = join(root, ...AUDIT_PATH.split('/'))
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, line, 'utf8')

    return { written: true, line }
  } catch (error) {
    return { written: false, error: error?.message ?? String(error) }
  }
}
