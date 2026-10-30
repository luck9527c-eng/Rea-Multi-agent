# T26：容量残留清扫 —— catalog 默认值 + 四份仍按旧口径写的文档

状态：待办（**Lead 授权**：可改 `docs/specs/roster-catalog.json` 与本票列出的文档）
背景：T23 删了容量子系统的代码（净 −4848 行），T25 从 `rt-tools.schema.json` 等规格里删了 `capacity` 键（+190/−724）。
**但还有两处"规格层旋钮"与四份文档仍在教旧做法** —— 我们刚吃过一次教训：文档说一套、实际做另一套，模型就会照文档做错事。

## 要清的东西（按危害排序）

### 1. catalog 里残留的预留默认值（真旋钮，最高优先）

- `docs/specs/roster-catalog.json:6-7`：`defaults.reserved_member_slots: 1`、`defaults.reserved_activations: 2`
- `src/catalog.data.json:6-7`：上面这份的**字节副本**（有漂移用例盯着，必须同步）

两个键**删掉**。（注意同文件 `:360` 有 `reserved_posts` 数组，那是**岗位名**，与容量无关，**不要动**。）
`src/catalog.ts:260` 那句"由 Lead 决定何时删"的注释随删。

### 2. `README.md:179-181`（用户可见，直接和实现矛盾）

仍要求用户"用 `re/team/capacity.json` 或 profile `config.capacity` 声明上限，否则返回 `CAPACITY_UNKNOWN`"。
改写为现行事实：**插件不做容量规划，也不读任何容量声明；上限由宿主自己强制，被拒时按宿主原话返回 `CAPACITY_EXHAUSTED`。**

### 3. `docs/verify/l3-runbook.md:13,17,69`

仍指导创建 `capacity.json`、读 `recommended_members`。删掉这些步骤（L3 清单里"传 `capacity` 应被未知字段拒绝"的核对**保留**，那是 T25 新增的正确断言）。

### 4. `docs/impl/SEAMS.md:166,169`

仍把 `capacity` 四字段与 `recommended_members` 描述为 wire 必备键。改成现状（rosterData 已不含这两个键）。

### 5. `docs/impl/DECISIONS.md:734-735`（D41 自相矛盾）

D41 的"落地面"写着 `recommended_members` **保留、语义收窄**；但 T25 按票把它删了。**以实现为准**：在 D41 该处加一行更正说明（"2026-10-30 追加：T25 已删除 `recommended_members`，本条作废"），**不要改写历史正文**。

### 6. `docs/verify/acceptance-status.md:81,154,178-179`

A09 仍列为 `not-run` 并引用容量判据。`docs/specs/acceptance-matrix.md:19` 已把 A09 标为"已废止 2026-10-30"——**验收表要与之对齐**：A09 改成已废止（保留历史说明，说明它何时、因何废止，以及原判据不再适用）。

## 验收

1. `git grep -n "reserved_member_slots\|reserved_activations"` 在 `docs/specs/`、`src/`、`dist/` 下 **0 命中**（历史票 `docs/impl/tickets/T18*.md`、`docs/verify/records/**` 里的记述**允许保留**，别改历史）。
2. `git grep -n "capacity.json"` 在 `README.md`、`docs/verify/l3-runbook.md` 下 **0 命中**。
3. `src/catalog.data.json` 与 `docs/specs/roster-catalog.json` 仍字节一致（漂移用例绿）。
4. D41 的更正说明在读的时候不会与正文冲突（明确标注"本条作废/已删除"）。
5. `acceptance-status.md` 的 A09 与 `acceptance-matrix.md` 口径一致。
6. 全量门禁全绿（注意 T22 的 `l2/lock.test.mjs` 偶发红约 1/3，别当回归）。

## 硬约束

- **不要改 `docs/verify/records/**`**（历史记录）、**不要改 `docs/impl/tickets/T18*.md` / `T19*` 的正文**（历史票）。
- 不要动 `reserved_posts`（岗位名，非容量）。
- 不要跑 L3、不要碰 `D:\workSpace\_l3-verify`。
- 不要 push、不要合并。Lead 审后合。

## 写作用域（预估）

`docs/specs/roster-catalog.json`、`src/catalog.data.json`、`src/catalog.ts`（仅注释）、`dist/**`（重建）、
`README.md`、`docs/verify/l3-runbook.md`、`docs/verify/acceptance-status.md`、`docs/impl/SEAMS.md`、`docs/impl/DECISIONS.md`（仅追加更正说明）
