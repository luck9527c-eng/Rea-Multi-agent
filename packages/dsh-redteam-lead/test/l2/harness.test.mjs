/**
 * L2 · 测试装置自身的契约。
 *
 * 这些用例保护"跑真实 CLI 的前提"，而不是被测业务行为：
 * - 临时项目由 `project.py init` 建立，并含**项目内** skill 副本与团队规则段（D8）；
 * - 副本里没有 `__pycache__` / `.pyc`（`python -B` + 复制过滤），不会污染字节；
 * - 测试数据非可执行（只有文本占位目标）；
 * - `withProject()` 在成功路径上清理临时目录（`os.tmpdir()` 无残留）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  environment, withProject, writeTargets, SKILL_COPY_RELATIVE, projectPy, sha256File, tempEntries,
} from './helpers.mjs'

/** 递归收集文件名（测试数据规模很小）。 */
async function walkFiles(root, prefix = '') {
  const files = []
  for (const entry of await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await walkFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

test('临时项目：init 产物齐全，项目内 skill 副本含团队规则段（D8）', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    // init 的固定产物（skill 的默认布局，E3 §3.1）。
    for (const relative of ['INDEX.md', 'docs/agents/reverse-project-management.md', 're/targets.json', 're/project.json']) {
      assert.equal(existsSync(path.join(root, ...relative.split('/'))), true, `缺少 ${relative}`)
    }

    const copy = path.join(root, ...SKILL_COPY_RELATIVE.split('/'))
    assert.equal(existsSync(projectPy(root)), true, '项目内 scripts/project.py 必须在场（扁平 import 需要三个 sibling 一起）')
    for (const sibling of ['governance.py', 'impact.py', 'integrity.py']) {
      assert.equal(existsSync(path.join(copy, 'scripts', sibling)), true, `缺少 sibling 模块 ${sibling}`)
    }
    assert.equal(
      existsSync(path.join(copy, 'references', 'team-coordination.md')),
      true,
      '权威副本带团队规则段；插件 probe() 的 hasTeamRules 依赖它（D8）',
    )
    // 副本内容不是兜底替代段（兼容性用例依赖权威字节）。
    const teamSection = await readFile(path.join(copy, 'references', 'team-coordination.md'), 'utf8')
    assert.equal(teamSection.includes('L2-FALLBACK'), false, '不得用替代段冒充权威团队规则')

    // 副本里没有字节码缓存（python -B + 复制过滤）。
    const compiled = (await walkFiles(copy)).filter((file) => file.endsWith('.pyc') || file.includes('__pycache__'))
    assert.deepEqual(compiled, [], '项目副本不得包含 __pycache__ / *.pyc')
  })
})

test('测试数据非可执行：占位目标与产物都是纯文本', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  await withProject(t, async ({ root }) => {
    const target = await writeTargets(root)
    const absolute = path.join(root, ...target.path.split('/'))
    assert.equal(statSync(absolute).isFile(), true)
    // 占位目标只有文本内容；PE/ELF 魔术字节都不出现。
    const bytes = await readFile(absolute)
    assert.equal(bytes.subarray(0, 2).toString('latin1') === 'MZ', false, '不得是 PE')
    assert.equal(bytes.subarray(0, 4).toString('latin1') === '\x7fELF', false, '不得是 ELF')
    assert.equal(bytes.toString('utf8').includes('非可执行测试数据'), true)
    assert.equal(sha256File(absolute).length, 64)
  })
})

test('withProject 成功路径清理：os.tmpdir() 下不残留临时项目', async (t) => {
  const env = await environment()
  if (!env.ok) return t.skip(env.reason)
  // 成套测试是并发跑的，所以只断言**本用例前缀**下没有残留。
  const prefix = `dsh-rt-l2-harness-${process.pid}-`
  let created
  await withProject(t, async ({ root }) => {
    created = root
    assert.equal(root.startsWith(path.join(tmpdir(), prefix)), true, '临时项目必须建在 os.tmpdir() 下')
    assert.equal(existsSync(root), true, '用例运行期间临时项目必须存在')
  }, { prefix })
  assert.equal(existsSync(created), false, '成功用例结束后临时项目必须被删除')
  assert.deepEqual(tempEntries(prefix), [], 'os.tmpdir() 下出现本用例的残留目录')
})
