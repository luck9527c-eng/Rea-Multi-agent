import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from '../src/errors.mjs'
import {
  assertNoCaseCollision,
  assertProjectRelative,
  assertSafeWriteTarget,
  findCaseCollision,
  isProjectRelative,
  normalizeProjectRoot,
  resolveInProject,
} from '../src/paths.mjs'
import { makeTempProject, removeTree } from './helpers/tmp.mjs'

/** 断言抛出 PATH_INVALID 契约错误。 */
function assertPathInvalid(fn, label) {
  assert.throws(
    fn,
    (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
    `应拒绝: ${label}`,
  )
}

test('合法项目内相对路径原样通过', () => {
  const valid = [
    're/team/lock',
    're/team/audit.jsonl',
    're/team/dispatches/D-0001/attempts/A-000001/submission.json',
    're/运行记录/facts.json',
  ]
  for (const relativePath of valid) {
    assert.equal(assertProjectRelative(relativePath), relativePath)
    assert.equal(isProjectRelative(relativePath), true)
  }
})

test('绝对路径与盘符被拒', () => {
  for (const bad of ['/etc/passwd', 'C:/workSpace/x', 'C:x', 'c:/x', 'D:\\workSpace\\x']) {
    assertPathInvalid(() => assertProjectRelative(bad), bad)
    assert.equal(isProjectRelative(bad), false)
  }
})

test('UNC 路径被拒', () => {
  for (const bad of ['//server/share/x', '\\\\server\\share\\x', '//?/C:/x']) {
    assertPathInvalid(() => assertProjectRelative(bad), bad)
  }
})

test('反斜杠被拒（项目内路径统一 /）', () => {
  assertPathInvalid(() => assertProjectRelative('re\\team\\lock'), 're\\team\\lock')
})

test('空段与首尾分隔符被拒', () => {
  for (const bad of ['re//team', 're/team/', '/re/team', 're/team//x']) {
    assertPathInvalid(() => assertProjectRelative(bad), bad)
  }
})

test('. 与 .. 段被拒', () => {
  for (const bad of ['re/../etc', '../x', 're/./x', '..', '.']) {
    assertPathInvalid(() => assertProjectRelative(bad), bad)
  }
})

test('Windows ADS（a:b）被拒', () => {
  for (const bad of ['re/team/a.json:stream', 'a:b', 're/team/file.json:$DATA']) {
    assertPathInvalid(() => assertProjectRelative(bad), bad)
  }
})

test('控制字符被拒', () => {
  for (const bad of ['re/team/a\u0000b.json', 're/team/a\u001fb', 're/team/a\u007fb', 're/team/a\nb']) {
    assertPathInvalid(() => assertProjectRelative(bad), JSON.stringify(bad))
  }
})

test('非字符串与空串被拒', () => {
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assertPathInvalid(() => assertProjectRelative(bad), String(bad))
  }
})

test('normalizeProjectRoot 返回真实绝对根', async () => {
  const project = await makeTempProject()
  try {
    const normalized = await normalizeProjectRoot(project.root)
    assert.equal(normalized, await realpath(project.root))
    assert.ok(normalized.includes(':') || normalized.startsWith('/'), '必须是绝对路径')
  } finally {
    await project.dispose()
  }
})

test('normalizeProjectRoot 拒绝不存在、非目录与相对路径', async () => {
  const project = await makeTempProject()
  try {
    const missing = join(project.root, 'not-there')
    await assert.rejects(() => normalizeProjectRoot(missing), (error) => error.code === 'PATH_INVALID')

    const filePath = join(project.root, 'file.txt')
    await writeFile(filePath, 'x')
    await assert.rejects(() => normalizeProjectRoot(filePath), (error) => error.code === 'PATH_INVALID')

    await assert.rejects(() => normalizeProjectRoot('relative/dir'), (error) => error.code === 'PATH_INVALID')
    await assert.rejects(() => normalizeProjectRoot(''), (error) => error.code === 'PATH_INVALID')
  } finally {
    await project.dispose()
  }
})

test('resolveInProject 把相对路径拼到根下且不越界', async () => {
  const project = await makeTempProject()
  try {
    const absolute = resolveInProject(project.root, 're/team/lock')
    assert.equal(absolute, join(project.root, 're', 'team', 'lock'))
    assertPathInvalid(() => resolveInProject(project.root, '../escape'), '../escape')
  } finally {
    await project.dispose()
  }
})

test('assertSafeWriteTarget 放行根内普通路径（含尚未创建的父目录）', async () => {
  const project = await makeTempProject()
  try {
    const existing = await assertSafeWriteTarget(project.root, 're/team/lock')
    assert.equal(existing, join(project.root, 're', 'team', 'lock'))

    const fresh = await assertSafeWriteTarget(project.root, 're/team/dispatches/D-0001/contract.json')
    assert.equal(fresh, join(project.root, 're', 'team', 'dispatches', 'D-0001', 'contract.json'))
  } finally {
    await project.dispose()
  }
})

test('assertSafeWriteTarget 拒绝穿过 symlink/junction 的写入', async (t) => {
  const project = await makeTempProject()
  const outside = await makeTempProject({ prefix: 'dsh-rt-outside-' })
  try {
    const linkPath = join(project.root, 're', 'link-out')
    let linked = true
    try {
      await symlink(outside.root, linkPath, 'junction')
    } catch {
      linked = false
    }
    if (!linked) {
      t.diagnostic('无法创建 junction（权限或文件系统限制），跳过该用例')
      return
    }

    await assert.rejects(
      () => assertSafeWriteTarget(project.root, 're/link-out/pwn.json'),
      (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
    )
  } finally {
    await project.dispose()
    await outside.dispose()
  }
})

test('assertSafeWriteTarget 拒绝目标本身是链接', async (t) => {
  const project = await makeTempProject()
  const outside = await makeTempProject({ prefix: 'dsh-rt-outside-' })
  try {
    const targetDir = join(project.root, 're', 'team', 'linked-target')
    try {
      await symlink(outside.root, targetDir, 'junction')
    } catch {
      t.diagnostic('无法创建 junction，跳过该用例')
      return
    }
    await assert.rejects(
      () => assertSafeWriteTarget(project.root, 're/team/linked-target'),
      (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
    )
  } finally {
    await project.dispose()
    await outside.dispose()
  }
})

test('大小写折叠碰撞检测是纯函数且区分布同项与碰撞项', () => {
  assert.equal(findCaseCollision(['re', 'team'], 'team'), null, '完全同名不是碰撞')
  assert.equal(findCaseCollision(['re', 'Team'], 'team'), 'Team')
  assert.equal(findCaseCollision(['RE', 're'], 'Re'), 'RE')
  assert.equal(findCaseCollision([], 'team'), null)
})

test('assertNoCaseCollision 拒绝仅大小写不同的路径碰撞', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    await mkdir(join(project.root, 'Re', 'Team'), { recursive: true })
    await assert.rejects(
      () => assertNoCaseCollision(project.root, 're/team/new.json'),
      (error) => error instanceof ContractError && error.code === 'PATH_INVALID',
    )
    // 完全一致的写法不视为碰撞
    await assertNoCaseCollision(project.root, 'Re/Team/new.json')
    // 完全不存在的顶层目录无需碰撞检查
    await assertNoCaseCollision(project.root, 'zz/other/new.json')
  } finally {
    await project.dispose()
  }
})

test('清理工具本身可用（removeTree 幂等）', async () => {
  const project = await makeTempProject()
  await removeTree(project.root)
  await removeTree(project.root)
})
