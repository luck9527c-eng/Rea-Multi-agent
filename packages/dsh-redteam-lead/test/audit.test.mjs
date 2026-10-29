import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AUDIT_FIELDS, AUDIT_PATH, appendAudit } from '../src/audit.mjs'
import { makeTempProject } from './helpers/tmp.mjs'

const clock = { isoNow: () => '2026-10-29T08:00:00.000Z', now: () => Date.parse('2026-10-29T08:00:00.000Z') }

async function readLines(root) {
  const text = await readFile(join(root, 're', 'team', 'audit.jsonl'), 'utf8')
  return text.trimEnd().split('\n').map((line) => JSON.parse(line))
}

test('成功追加一行且字段齐全', async () => {
  const project = await makeTempProject()
  try {
    const result = await appendAudit(
      project.root,
      {
        kind: 'dispatch',
        route: 'R-0001',
        task: 'task-1',
        member: 'rt-binary-diff',
        requester: 'lead',
        verdict: 'delivered',
      },
      { clock },
    )

    assert.equal(result.written, true)
    assert.equal(AUDIT_PATH, 're/team/audit.jsonl')
    assert.deepEqual([...AUDIT_FIELDS], ['at', 'kind', 'route', 'task', 'member', 'requester', 'verdict'])

    const lines = await readLines(project.root)
    assert.equal(lines.length, 1)
    assert.deepEqual(lines[0], {
      at: '2026-10-29T08:00:00.000Z',
      kind: 'dispatch',
      route: 'R-0001',
      task: 'task-1',
      member: 'rt-binary-diff',
      requester: 'lead',
      verdict: 'delivered',
    })
    assert.deepEqual(Object.keys(lines[0]), [...AUDIT_FIELDS], '列顺序必须稳定')
  } finally {
    await project.dispose()
  }
})

test('append-only：多次追加各占一行，不重写历史', async () => {
  const project = await makeTempProject()
  try {
    await appendAudit(project.root, { kind: 'roster', verdict: 'inspect' }, { clock })
    await appendAudit(project.root, { kind: 'conclude', verdict: 'completed' }, { clock })

    const lines = await readLines(project.root)
    assert.equal(lines.length, 2)
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['roster', 'conclude'],
    )
  } finally {
    await project.dispose()
  }
})

test('缺省字段填 null，未知字段被丢弃', async () => {
  const project = await makeTempProject()
  try {
    await appendAudit(
      project.root,
      { kind: 'roster', verdict: 'bound', secret: '不该进审计', route: undefined },
      { clock },
    )

    const [line] = await readLines(project.root)
    assert.deepEqual(line, {
      at: '2026-10-29T08:00:00.000Z',
      kind: 'roster',
      route: null,
      task: null,
      member: null,
      requester: null,
      verdict: 'bound',
    })
  } finally {
    await project.dispose()
  }
})

test('写失败返回 written=false 且不抛（审计 best-effort）', async () => {
  const project = await makeTempProject()
  try {
    // 让 audit.jsonl 变成目录：追加必然失败
    await mkdir(join(project.root, 're', 'team', 'audit.jsonl'), { recursive: true })

    const result = await appendAudit(project.root, { kind: 'dispatch', verdict: 'delivered' }, { clock })
    assert.equal(result.written, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  } finally {
    await project.dispose()
  }
})

test('根路径不可用（是文件）时同样只报告失败', async () => {
  const project = await makeTempProject()
  try {
    const blocker = join(project.root, 'blocker')
    await writeFile(blocker, 'not a directory')
    const result = await appendAudit(blocker, { kind: 'roster', verdict: 'x' }, { clock })
    assert.equal(result.written, false)
    assert.equal(typeof result.error, 'string')
  } finally {
    await project.dispose()
  }
})

test('条目非法（缺 kind）时返回 written=false 而不是抛异常', async () => {
  const project = await makeTempProject()
  try {
    const result = await appendAudit(project.root, { verdict: 'x' }, { clock })
    assert.equal(result.written, false)
    assert.match(result.error, /kind/)
  } finally {
    await project.dispose()
  }
})
