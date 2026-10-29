/**
 * 原子写、独占创建与字节哈希。
 *
 * 契约要求（「路径、锁与资源」「操作阶段与部分失败」）：
 * - JSON/提交/回执使用**同目录临时文件 + 原子替换**；
 * - 不可变文件使用**独占创建**，已有内容不一致则视为冲突；
 * - 读取提交与复制时重新核对哈希，防止「校验后换内容」；
 * - 不回滚、不删除已保留的证据，冲突只前向修复。
 *
 * 冲突统一用 `OPERATION_CONFLICT`：契约的错误码表里没有更细的文件级码，
 * 而「同一身份下内容不一致」正是该码的语义（编排契约「稳定错误码」）。
 *
 * 本模块是 I/O 边界：只做字节搬运与校验，不做业务判断。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ContractError } from './errors.mjs'

function conflict(message, nextStep, details) {
  return new ContractError({ code: 'OPERATION_CONFLICT', message, nextStep, details })
}

/**
 * 计算字节摘要。
 * @param {Buffer | Uint8Array} bytes
 * @returns {string} 小写十六进制 SHA256
 */
export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 流式计算文件摘要（大文件不整读进内存）。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** 同目录唯一临时名：与目标同库同卷，保证 rename 是原子替换。 */
function tempSibling(filePath) {
  return join(dirname(filePath), `.${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
}

/**
 * 原子写 JSON：同目录临时文件 → `fs.rename` 替换。父目录自动创建。
 *
 * 输出固定为 2 空格缩进 + 结尾换行，便于 diff 与人工核对。
 *
 * @param {string} filePath 目标绝对路径
 * @param {unknown} value 可 JSON 序列化的值
 * @param {{ ensureParent?: boolean }} [options]
 * @returns {Promise<{ path: string, sha256: string, bytes: number }>}
 */
export async function writeJsonAtomic(filePath, value, options = {}) {
  const { ensureParent: createParent = true } = options
  const text = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.from(text, 'utf8')
  if (createParent) await ensureParent(filePath)

  const temp = tempSibling(filePath)
  try {
    await writeFile(temp, bytes)
    await rename(temp, filePath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return { path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.length }
}

/**
 * 独占创建不可变文件（`wx`）。
 *
 * 已存在且内容完全一致 → 幂等成功（`created=false`）；内容不同 → `OPERATION_CONFLICT`，
 * 且**不覆盖**原文件。
 *
 * @param {string} filePath 目标绝对路径
 * @param {string | Uint8Array} contents
 * @returns {Promise<{ created: boolean, existed: boolean, sameContent: boolean }>}
 */
export async function createExclusive(filePath, contents) {
  await ensureParent(filePath)
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents
  try {
    await writeFile(filePath, bytes, { flag: 'wx' })
    return { created: true, existed: false, sameContent: true }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const existing = await readFile(filePath)
  if (existing.equals(bytes)) {
    return { created: false, existed: true, sameContent: true }
  }
  throw conflict(
    `不可变文件已存在且内容不一致: ${filePath}`,
    '保留既有文件；若确实需要新内容，换一个新的 RUN/operation 标识而不是覆盖证据',
    { path: filePath, existing_sha256: sha256Bytes(existing), incoming_sha256: sha256Bytes(bytes) },
  )
}

/**
 * 核对文件哈希；不符或缺文件时抛 `OPERATION_CONFLICT`。
 *
 * 这是「校验后换内容」的唯一检测点：复制完成、归档前后、读取提交前都应重新核对。
 *
 * @param {string} filePath
 * @param {string} expectedSha256 小写十六进制
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function verifyFileHash(filePath, expectedSha256) {
  let actual
  try {
    actual = await sha256File(filePath)
  } catch (error) {
    throw conflict(
      `无法读取待核对文件: ${filePath}（${error?.code ?? 'unknown'}）`,
      '确认文件仍存在且可读；缺失即视为校验失败，不要继续后续步骤',
      { path: filePath, code: error?.code ?? null },
    )
  }
  if (actual !== expectedSha256) {
    throw conflict(
      `文件哈希与预期不一致: ${filePath}`,
      '重新读取原始来源确认内容；不要用当前文件继续封存或登记',
      { path: filePath, expected_sha256: expectedSha256, actual_sha256: actual },
    )
  }
  const info = await stat(filePath)
  return { sha256: actual, bytes: info.size }
}

/**
 * 复制并核对哈希：源哈希 → 同目录临时副本 → 校验副本字节 → 原子替换到目标 → 再核对目标。
 *
 * 任一步不符即冲突，且**目标位置不会出现错误字节**（临时文件已清理）。
 *
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {{ expectedSha256?: string, ensureParent?: boolean }} [options]
 *   `expectedSha256` 是调用方先前记录（例如提交哈希）的摘要，用于发现「校验后换内容」。
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function copyVerify(sourcePath, destPath, options = {}) {
  const { expectedSha256, ensureParent: createParent = true } = options

  let sourceHash
  let sourceSize
  try {
    sourceHash = await sha256File(sourcePath)
    sourceSize = (await stat(sourcePath)).size
  } catch (error) {
    throw conflict(
      `无法读取源文件: ${sourcePath}（${error?.code ?? 'unknown'}）`,
      '确认源文件存在且可读后重试',
      { path: sourcePath, code: error?.code ?? null },
    )
  }

  if (expectedSha256 !== undefined && sourceHash !== expectedSha256) {
    throw conflict(
      `源文件哈希与预期不一致: ${sourcePath}`,
      '源内容已改变：回到原始提交/证据重新取值，不要沿用旧摘要继续',
      { path: sourcePath, expected_sha256: expectedSha256, actual_sha256: sourceHash },
    )
  }

  if (createParent) await ensureParent(destPath)
  const temp = tempSibling(destPath)
  try {
    await copyFile(sourcePath, temp)
    const copiedHash = await sha256File(temp)
    if (copiedHash !== sourceHash) {
      throw conflict(
        `复制后的字节与源不一致: ${sourcePath}`,
        '同一份证据在复制过程中发生变化：重做复制，不要登记本次结果',
        { path: sourcePath, source_sha256: sourceHash, copied_sha256: copiedHash },
      )
    }
    await rename(temp, destPath)
    const finalHash = await sha256File(destPath)
    if (finalHash !== sourceHash) {
      throw conflict(
        `写入后的目标字节与源不一致: ${destPath}`,
        '目标在替换后被改动：重新复制并核对',
        { path: destPath, source_sha256: sourceHash, final_sha256: finalHash },
      )
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }

  return { sha256: sourceHash, bytes: sourceSize }
}
