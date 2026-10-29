// 验收总表的**文档契约**：`docs/verify/acceptance-status.md` 是 T10 的交付物，状态词表与覆盖范围
// 都是硬要求（`docs/specs/acceptance-matrix.md`：A01–A44 全表、状态只用 pass/fail/not-run/out-of-scope、
// 每条 pass 必须点到用例或记录、未实现的 case 标待验收而不是占位"通过"）。
//
// 这里只解析文档，不启动任何宿主；断言的是"表本身没撒谎"，不是验收结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const statusUrl = new URL('../../../docs/verify/acceptance-status.md', import.meta.url)
const markdown = readFileSync(statusUrl, 'utf8')

const ALLOWED = new Set(['pass', 'fail', 'not-run', 'out-of-scope'])
const ROWS = Array.from({ length: 44 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)

/** 取两个 `## ` 标题之间的正文。 */
function section(title) {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === `## ${title}`)
  assert.notEqual(start, -1, `总表缺少章节：${title}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** 解析一个 Markdown 表格为 `{header, rows}`（跳过分隔行）。 */
function table(text) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().startsWith('|'))
  assert.ok(lines.length >= 2, '表格至少要表头 + 一行数据')
  const cells = (line) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
  const header = cells(lines[0])
  const rows = lines.slice(1).filter((line) => !/^\|[\s:|-]+\|$/u.test(line.trim())).map(cells)
  return { header, rows }
}

/** 主表：`## A01–A44 逐条` 里的 44 行（状态列去掉 Markdown 反引号）。 */
function matrixRows() {
  const { header, rows } = table(section('A01–A44 逐条'))
  assert.deepEqual(header, ['编号', '层', '状态', '证据位置', '备注'], '主表列名必须固定（编号/层/状态/证据位置/备注）')
  return rows.map((row) => [row[0], row[1], row[2].replaceAll('`', '').trim(), row[3], row[4]])
}

test('A01–A44 全部 44 行各出现一次，状态只取四个允许值', () => {
  const rows = matrixRows()
  assert.equal(rows.length, 44, `主表必须有 44 行，实际 ${rows.length}`)
  const ids = rows.map((row) => row[0])
  assert.deepEqual([...ids].sort(), [...ROWS].sort(), '编号必须恰好是 A01–A44')
  assert.equal(new Set(ids).size, ids.length, '编号不得重复')
  for (const [id, , status] of rows) {
    assert.ok(ALLOWED.has(status), `${id} 的状态 ${status} 不在允许值内`)
  }
})

test('每条 pass 都点到可复跑的用例文件或 docs/verify 下的记录', () => {
  const passRows = matrixRows().filter((row) => row[2] === 'pass')
  assert.ok(passRows.length > 0, '至少要有通过行')
  for (const [id, , , evidence] of passRows) {
    assert.ok(
      /\.test\.mjs\)/u.test(evidence) || /docs\/verify\/|records\//u.test(evidence),
      `${id} 的 pass 必须点到 *.test.mjs 用例或 docs/verify 记录，实际：${evidence.slice(0, 120)}`,
    )
  }
})

test('没有占位"通过"：not-run/fail 行必须写清缺什么，状态列不得出现中文"通过"', () => {
  const rows = matrixRows()
  for (const [id, , status, , note] of rows) {
    assert.notEqual(status, '通过', `${id} 用了占位"通过"`)
    if (status === 'not-run' || status === 'fail') {
      assert.ok(note.trim().length >= 8, `${id} 是 ${status}，备注必须写清缺什么（实际：${note}）`)
    }
  }
  // 全表（含静态验证章节）不得把"通过"当状态使用。
  assert.doesNotMatch(markdown, /\|\s*通过\s*\|/u, '表格里不得出现"通过"作为状态值')
})

test('分布表与实际判定一致（pass/not-run/out-of-scope/fail 的行数）', () => {
  const rows = matrixRows()
  const counts = new Map([...ALLOWED].map((status) => [status, 0]))
  for (const row of rows) counts.set(row[2], counts.get(row[2]) + 1)

  const { rows: distribution } = table(section('分布'))
  const declared = new Map()
  for (const row of distribution) {
    const label = row[0].replaceAll('`', '').trim()
    if (label === '合计') continue
    const matched = /^(\d+)$/u.exec(row[1].replaceAll('*', '').trim())
    assert.ok(matched, `分布表的行数必须是纯数字：${row[1]}`)
    declared.set(label, Number(matched[1]))
  }
  for (const status of ALLOWED) {
    assert.equal(declared.get(status), counts.get(status), `分布表里 ${status} 的计数与主表不一致`)
  }
  const total = Array.from(declared.values()).reduce((sum, value) => sum + value, 0)
  assert.equal(total, 44, '分布表四类之和必须是 44')
})
