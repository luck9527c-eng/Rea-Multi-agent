/**
 * 测试基础设施：临时目录、临时项目、只读规格文件加载。
 *
 * 只做 I/O，不含业务判断。所有临时目录建在系统 tmpdir 下，测试结束必须 dispose，
 * 绝不读写真实分析项目。
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库根（<repo>/packages/dsh-redteam-lead/test/helpers/tmp.mjs 上溯四层）。 */
export function repoRoot() {
  return resolve(here, '../../../..')
}

/**
 * 建一个唯一临时目录。
 * @param {string} [prefix]
 * @returns {Promise<string>} 绝对路径
 */
export async function makeTempDir(prefix = 'dsh-rt-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * 建一个临时“分析项目”：根目录 + 常规 re/team 目录骨架。
 *
 * 返回的 `dispose()` 递归删除整个临时根，失败重试一次（Windows 上杀毒/索引偶发占用）。
 *
 * @param {{ segments?: string[], prefix?: string }} [options]
 * @returns {Promise<{ root: string, dispose: () => Promise<void> }>}
 */
export async function makeTempProject(options = {}) {
  const { segments = ['re/team'], prefix = 'dsh-rt-proj-' } = options
  const root = await makeTempDir(prefix)
  for (const segment of segments) {
    await mkdir(join(root, ...segment.split('/')), { recursive: true })
  }
  return {
    root,
    dispose: () => removeTree(root),
  }
}

/**
 * 递归删除目录或文件；不存在视为成功。
 * @param {string} target 绝对路径
 */
export async function removeTree(target) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2 })
      return
    } catch (error) {
      if (attempt === 1) throw error
      await new Promise((done) => setTimeout(done, 50))
    }
  }
}

/**
 * 读取仓库内的只读规格文件（docs/specs/**），测试用它当唯一数据源。
 * @param {string} relativePath 相对仓库根，例如 `docs/specs/rt-tools.schema.json`
 * @returns {Promise<any>} 解析后的 JSON
 */
export async function loadSpecJson(relativePath) {
  const absolute = join(repoRoot(), ...relativePath.split('/'))
  return JSON.parse(await readFile(absolute, 'utf8'))
}
