/**
 * T23 的删除断言（验收第 1 条）：证明整套容量推断机真的没了，而不是「还在但没人调」。
 *
 * 判据是源码/产物的文本扫描（`rg` 的等价物）与目录扫描，断言的是**不存在**：
 * 观测值文件、观测中标记、从宿主消息解析上限、烧/不烧分类、项目容量声明。
 * 这些名字一旦被谁加回来，这条用例就会红 —— 它是「不要再建那套东西」的唯一防线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(PACKAGE_ROOT, 'src');
const DIST = path.join(PACKAGE_ROOT, 'dist');

/** 已随 T23/T25 删除的标识符 / 路径 / 键名（出现即失败）。 */
const TRIPWIRES = [
  'capacity-observed',
  'capacity-observing',
  'parsed_limit',
  'capacityRefusalBurned',
  'capacity.json',
  'readDeclaredCapacity',
  'planBudget',
  'CAPACITY_UNDECLARED',
  'CAPACITY_OBSERVED',
  'CAPACITY_DECLARATION_MISSING',
  'observeCapacity',
  'resolveCapacity',
  'parseHostCapacityLimit',
  // T25：容量已从规格与 wire data 删除，这些特判/占位名不得回来。
  'CAPACITY_ARGUMENT_OBSOLETE',
  'NO_CAPACITY_PLAN',
  'remaining_member_slots',
];

/** 递归收集某个目录下的 `.ts` / `.js` / `.mjs` 文件（不含 node_modules）。 */
async function textFiles(directory) {
  const out = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!/\.(?:ts|js|mjs)$/u.test(entry.name)) continue
      out.push({ path: absolute, relative: path.relative(PACKAGE_ROOT, absolute), text: await readFile(absolute, 'utf8') })
    }
  }
  await walk(directory)
  return out
}

test('源码与产物里搜不到被删除的容量机制（rg 等价断言）', async () => {
  const files = [...(await textFiles(SRC)), ...(await textFiles(DIST))]
  assert.ok(files.length > 20, `应当扫到源码与产物文件，实际 ${files.length} 个`)

  const hits = []
  for (const file of files) {
    for (const token of TRIPWIRES) {
      if (file.text.includes(token)) hits.push(`${file.relative}: ${token}`)
    }
  }
  assert.deepEqual(hits, [], `这些名字属于已删除的容量推断机，不得再出现：\n${hits.join('\n')}`)
})

test('capacity-source 模块已删除，capacity 模块只剩岗位计划', async () => {
  const sourceNames = await readdir(SRC)
  assert.equal(sourceNames.includes('capacity-source.ts'), false, 'capacity-source.ts 必须已删除')

  const source = await readFile(path.join(SRC, 'capacity.ts'), 'utf8')
  assert.match(source, /export function planPosts/u, '岗位计划还在（它不含任何容量判定）')
})

test('T25：规格的 rosterInput/dispatchInput/rosterData 不再声明容量键', async () => {
  const specPath = path.join(PACKAGE_ROOT, '..', '..', 'docs', 'specs', 'rt-tools.schema.json')
  const spec = JSON.parse(await readFile(specPath, 'utf8'))
  const forbidden = ['capacity', 'reserved_member_slots', 'reserved_activations']

  for (const defName of ['rosterInput', 'dispatchInput']) {
    const props = Object.keys(spec.$defs[defName].properties)
    for (const key of forbidden) {
      assert.equal(props.includes(key), false, `$defs.${defName}.properties 不得再声明 ${key}`)
    }
  }

  const data = spec.$defs.rosterData
  for (const key of [...forbidden, 'recommended_members']) {
    assert.equal(data.required.includes(key), false, `$defs.rosterData.required 不得再引用 ${key}`)
    assert.equal(Object.hasOwn(data.properties, key), false, `$defs.rosterData.properties 不得再声明 ${key}`)
  }
})
