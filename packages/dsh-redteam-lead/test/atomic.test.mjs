import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ContractError } from '../src/errors.mjs'
import { copyVerify, createExclusive, sha256Bytes, sha256File, verifyFileHash, writeJsonAtomic } from '../src/atomic.mjs'
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
