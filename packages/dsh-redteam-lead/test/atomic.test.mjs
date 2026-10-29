import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from '../dist/errors.js'
import {
  DEFAULT_REPLACE_ATTEMPTS,
  TRANSIENT_REPLACE_CODES,
  copyVerify,
  createExclusive,
  sha256Bytes,
  sha256File,
  verifyFileHash,
  writeJsonAtomic,
} from '../dist/atomic.js'
import { makeTempProject } from './helpers/tmp.mjs'

/** 断言抛 OPERATION_CONFLICT（内容/哈希冲突在契约里归到这一个稳定码）。 */
function assertConflict(fn, label) {
  return assert.rejects(fn, (error) => error instanceof ContractError && error.code === 'OPERATION_CONFLICT', label)
}

test('sha256Bytes 对已知输入给出标准摘要', () => {
  // 独立真值：echo -n abc | sha256sum
  assert.equal(sha256Bytes(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Bytes(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('sha256File 与 sha256Bytes 对同一字节一致', async () => {
  const project = await makeTempProject()
  try {
    const file = join(project.root, 'sample.bin')
    const bytes = Buffer.from('证据字节 evidence', 'utf8')
    await writeFile(file, bytes)
    assert.equal(await sha256File(file), sha256Bytes(bytes))
  } finally {
    await project.dispose()
  }
})

test('writeJsonAtomic 写入完整 JSON 并自动建父目录', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const file = join(project.root, 're', 'team', 'binding.json')
    const value = { schema_version: 1, project_id: 'p-1', 中文: '保留内容' }
    const result = await writeJsonAtomic(file, value)

    const text = await readFile(file, 'utf8')
    assert.deepEqual(JSON.parse(text), value)
    assert.ok(text.endsWith('\n'), 'JSON 文件应以换行结尾')
    assert.equal(result.path, file)
    assert.equal(result.sha256, sha256Bytes(Buffer.from(text, 'utf8')))
    assert.equal(result.bytes, Buffer.byteLength(text))
  } finally {
    await project.dispose()
  }
})

test('writeJsonAtomic 原子替换旧内容且不残留临时文件', async () => {
  const project = await makeTempProject()
  try {
    const dir = join(project.root, 're', 'team')
    const file = join(dir, 'roster.json')
    await writeJsonAtomic(file, { revision: 1, members: ['a', 'b'] })
    await writeJsonAtomic(file, { revision: 2, members: ['a'] })

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { revision: 2, members: ['a'] })
    const entries = await readdir(dir)
    assert.deepEqual(entries, ['roster.json'], `不应残留临时文件: ${entries.join(',')}`)
  } finally {
    await project.dispose()
  }
})

test('createExclusive 首次创建成功，相同内容再次创建不覆盖', async () => {
  const project = await makeTempProject()
  try {
    const file = join(project.root, 're', 'team', 'seals', 'RUN-1.json')
    const first = await createExclusive(file, '{"sealed":true}\n')
    assert.equal(first.created, true)

    const second = await createExclusive(file, '{"sealed":true}\n')
    assert.equal(second.created, false)
    assert.equal(second.existed, true)
    assert.equal(second.sameContent, true)
    assert.equal(await readFile(file, 'utf8'), '{"sealed":true}\n')
  } finally {
    await project.dispose()
  }
})

test('createExclusive 内容不一致时冲突且保留原文件', async () => {
  const project = await makeTempProject()
  try {
    const file = join(project.root, 're', 'team', 'seals', 'RUN-2.json')
    await createExclusive(file, '{"sealed":true}\n')
    await assertConflict(() => createExclusive(file, '{"sealed":false}\n'), '不同内容应冲突')
    assert.equal(await readFile(file, 'utf8'), '{"sealed":true}\n', '冲突时不得覆盖原文件')
  } finally {
    await project.dispose()
  }
})

test('copyVerify 复制后目标字节与源一致并返回摘要', async () => {
  const project = await makeTempProject()
  try {
    const source = join(project.root, 'submission-a.json')
    const dest = join(project.root, 're', 'team', 'archive', 'submission-a.json')
    const bytes = Buffer.from('{"submission":"ok"}\n', 'utf8')
    await writeFile(source, bytes)

    const result = await copyVerify(source, dest)
    assert.equal(result.sha256, sha256Bytes(bytes))
    assert.equal(result.bytes, bytes.length)
    assert.deepEqual(await readFile(dest), bytes)

    const entries = await readdir(join(project.root, 're', 'team', 'archive'))
    assert.deepEqual(entries, ['submission-a.json'], '不应残留临时文件')
  } finally {
    await project.dispose()
  }
})

test('copyVerify 在源哈希与预期不一致时冲突，且不产生目标文件', async () => {
  const project = await makeTempProject()
  try {
    const source = join(project.root, 'submission-b.json')
    const dest = join(project.root, 're', 'team', 'archive', 'submission-b.json')
    await writeFile(source, '{"v":1}\n')

    const staleExpected = sha256Bytes(Buffer.from('{"v":0}\n'))
    await assertConflict(() => copyVerify(source, dest, { expectedSha256: staleExpected }), '预期哈希不符应冲突')

    const exists = await stat(dest).then(
      () => true,
      () => false,
    )
    assert.equal(exists, false, '冲突时不得落盘目标文件')
  } finally {
    await project.dispose()
  }
})

test('verifyFileHash 在写入后被篡改时抛冲突（校验后换内容）', async () => {
  const project = await makeTempProject()
  try {
    const source = join(project.root, 'submission-c.json')
    const dest = join(project.root, 're', 'team', 'archive', 'submission-c.json')
    await writeFile(source, '{"v":1}\n')
    const copied = await copyVerify(source, dest)

    // 复制完成之后，目标被其他进程改写
    await writeFile(dest, '{"v":9}\n')

    await assertConflict(() => verifyFileHash(dest, copied.sha256), '篡改后应冲突')
    const intact = await verifyFileHash(dest, sha256Bytes(Buffer.from('{"v":9}\n')))
    assert.equal(intact.bytes, 8)
  } finally {
    await project.dispose()
  }
})

test('verifyFileHash 对缺失目标给出冲突而不是未知异常', async () => {
  const project = await makeTempProject()
  try {
    await assertConflict(
      () => verifyFileHash(join(project.root, 'nope.json'), 'a'.repeat(64)),
      '缺失目标应冲突',
    )
  } finally {
    await project.dispose()
  }
})

// ---------------------------------------------------------------------------
// 瞬时 rename/open 抖动：只对 EPERM/EACCES/EBUSY 做**有界**重试
//
// Windows 上并发写 %TEMP% 会让 `fs.rename` 偶发 EPERM（T5/T6/T7 都观察到，门禁约 1/6 飘红）。
// 这是真实的健壮性缺陷，但对 EEXIST/ENOENT/哈希不一致重试会把「有意义的失败」变成静默重来，
// 所以重试面必须窄：只有这三个码、最多 3 次、短退避。
// ---------------------------------------------------------------------------

/** 造一个带 `code` 的瞬时错误（形状与 Node 的 SystemError 一致）。 */
function transientError(code) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

/**
 * 可计数的 io 替身：只统计 `writeFile`/`rename` 的真实尝试次数，其余走真实 fs。
 * @param {{writeFile?: Function, rename?: Function}} [overrides]
 */
function countingIo(overrides = {}) {
  const attempts = { writeFile: 0, rename: 0 }
  const io = {
    mkdir: (...args) => mkdir(...args),
    rm: (...args) => rm(...args),
    readFile: (...args) => readFile(...args),
    writeFile: async (...args) => {
      attempts.writeFile += 1
      return overrides.writeFile === undefined ? writeFile(...args) : overrides.writeFile(...args)
    },
    rename: async (...args) => {
      attempts.rename += 1
      return overrides.rename === undefined ? rename(...args) : overrides.rename(...args)
    },
  }
  return { io, attempts }
}

test('writeJsonAtomic 命中瞬时 EPERM 时重试：第 2 次成功且内容正确', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const dir = join(project.root, 're', 'team')
    const file = join(dir, 'retry.json')
    const { io, attempts } = countingIo({
      rename: async (from, to) => {
        if (attempts.rename === 1) throw transientError('EPERM')
        return rename(from, to)
      },
    })

    const result = await writeJsonAtomic(file, { revision: 2 }, { io, sleep: async () => {} })

    assert.equal(attempts.rename, 2, '第一次 EPERM 后必须重试一次')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { revision: 2 })
    assert.equal(result.bytes, Buffer.byteLength('{\n  "revision": 2\n}\n'))
    assert.deepEqual(await readdir(dir), ['retry.json'], '重试成功后不得残留临时文件')
  } finally {
    await project.dispose()
  }
})

test('writeJsonAtomic 连续瞬时失败 → 最多 3 次后抛原始错误对象', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const dir = join(project.root, 're', 'team')
    const file = join(dir, 'always.json')
    const boom = transientError('EPERM')
    const { io, attempts } = countingIo({ rename: async () => { throw boom } })

    await assert.rejects(
      () => writeJsonAtomic(file, { a: 1 }, { io, sleep: async () => {} }),
      (error) => error === boom,
      '耗尽重试后必须抛原文（同一个错误对象），不是包装错误',
    )
    assert.equal(attempts.rename, DEFAULT_REPLACE_ATTEMPTS, `最多 ${DEFAULT_REPLACE_ATTEMPTS} 次尝试`)
    assert.deepEqual(await readdir(dir), [], '成败都不残留临时文件')
  } finally {
    await project.dispose()
  }
})

test('非瞬时错误（ENOENT）不重试：一次尝试后直接抛出', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const dir = join(project.root, 're', 'team')
    const file = join(dir, 'missing.json')
    const boom = Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' })
    const { io, attempts } = countingIo({ rename: async () => { throw boom } })

    await assert.rejects(
      () => writeJsonAtomic(file, { a: 1 }, { io, sleep: async () => {} }),
      (error) => error === boom,
    )
    assert.equal(attempts.rename, 1, 'ENOENT 是有意义的失败：不得重试')
  } finally {
    await project.dispose()
  }
})

test('createExclusive 命中瞬时 EPERM 时重试：第 2 次成功', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const dir = join(project.root, 're', 'team', 'seals')
    const file = join(dir, 'RUN-EPERM.json')
    const { io, attempts } = countingIo({
      writeFile: async (target, bytes, flag) => {
        if (attempts.writeFile === 1) throw transientError('EPERM')
        return writeFile(target, bytes, flag)
      },
    })

    const result = await createExclusive(file, '{"sealed":true}\n', { io, sleep: async () => {} })

    assert.equal(result.created, true)
    assert.equal(attempts.writeFile, 2, 'EPERM 后必须重试一次')
    assert.equal(await readFile(file, 'utf8'), '{"sealed":true}\n')
  } finally {
    await project.dispose()
  }
})

test('createExclusive 命中 EEXIST 不重试：同内容幂等、异内容冲突，各只尝试一次', async () => {
  const project = await makeTempProject({ segments: [] })
  try {
    const dir = join(project.root, 're', 'team', 'seals')
    const file = join(dir, 'RUN-EEXIST.json')
    const { io, attempts } = countingIo()

    const first = await createExclusive(file, '{"sealed":true}\n', { io, sleep: async () => {} })
    assert.equal(first.created, true)
    assert.equal(attempts.writeFile, 1)

    const second = await createExclusive(file, '{"sealed":true}\n', { io, sleep: async () => {} })
    assert.equal(second.created, false)
    assert.equal(second.sameContent, true)
    assert.equal(attempts.writeFile, 2, 'EEXIST 是幂等信号：每次调用只尝试一次')

    await assertConflict(
      () => createExclusive(file, '{"sealed":false}\n', { io, sleep: async () => {} }),
      '不同内容应冲突',
    )
    assert.equal(attempts.writeFile, 3, '内容冲突也不重试')
    assert.equal(await readFile(file, 'utf8'), '{"sealed":true}\n', '冲突时不得覆盖原文件')
  } finally {
    await project.dispose()
  }
})

test('重试只认 EPERM/EACCES/EBUSY 三个码', () => {
  assert.deepEqual([...TRANSIENT_REPLACE_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM'])
  assert.equal(DEFAULT_REPLACE_ATTEMPTS, 3)
})
