# T25：把容量从规格层删干净（收尾 T23 的半截状态）

状态：待办（**由 Lead 授权改动 `docs/specs/**`**，普通票无权改）
前身：T23 已把容量子系统从**代码**里删掉（净 −4848 行，603→573 用例），但规格里还留着 `capacity`，
于是工具仍然宣称一个不起作用的旋钮 —— 这比原来更糟：模型读 schema 会以为它有语义。

## 现在的半截状态（T23 的临时处置，D41 已记）

| 位置 | 现状 |
|---|---|
| `docs/specs/rt-tools.schema.json` | `rosterInput.capacity`、`dispatchInput.capacity`、`rosterData.capacity`（4 个必备字段）、`rosterData.recommended_members` 仍在 |
| `src/tool-schema.ts` | 是上面这份规格的**逐字副本**（`bundle.test.mjs` 有漂移用例） |
| 入参 `capacity` | 仍能过校验，收到就回 `CAPACITY_ARGUMENT_OBSOLETE`（"不参与任何判定"） |
| 出参 `rosterData.capacity` | 恒为 `{remaining_*: null, reserved_*: 0}` |
| `recommended_members` | 语义收窄为"需要新建成员的岗位数" |

## 裁决（用户，2026-10-30）

容量整套不要了，**包括 `re/team/capacity.json`**。理由：官方 Agent Teams 自己不做容量规划，上限还是刻意藏的。

推论：`capacity` 这个键**不该继续存在**。留着"接受但警告"只是把复杂度从逻辑搬到了措辞。

## 要做的事

### 1. 规格（`docs/specs/**`，本票授权修改）

- `rt-tools.schema.json`：
  - 删 `rosterInput.capacity`、`dispatchInput.capacity`（含 `max_members` / `max_active_subagents` / `reserved_member_slots` / `reserved_activations` 全部字段定义）；
  - 删 `rosterData.capacity` 整个对象与 `rosterData.recommended_members`；
  - 检查 `required` 数组，**不要留下指向已删键的引用**。
- `orchestration-contract.md`：rt_roster 那一段仍把 `reserved_member_slots=1` / `reserved_activations=2` 当必填入参 → 删。
- `acceptance-matrix.md` 的 **A09**（"未知时不盲目 spawn"）：容量不再由插件管理，这条**标记为已废止**（写明理由与日期），不要静默删行——验收表要能解释"为什么少了这一条"。

### 2. 代码收尾

- `src/tool-schema.ts`：按新规格重新生成/同步（漂移用例会验证）。
- 删 `CAPACITY_ARGUMENT_OBSOLETE` 诊断分支与其用例（键从 schema 消失后，传 `capacity` 会因 `additionalProperties:false` 直接报未知键 —— **这才是正确行为**，不要再为它写特判）。
- 删 `rosterDataOf` 里造常量 capacity 的分支、`roster.ts` 的 `NO_CAPACITY_PLAN`。
- `test/validate.test.mjs:300` 与 `test/schema-static.test.mjs:255` 仍在断言 `reserved_*` 默认值 1/2 → 随规格一起删。
- 复查 `render`：不应再有 `capacity：` 行（T23 已删，本票确认）。

### 3. `scripts/l3-verify.mjs`

里面仍有 `CAPACITY_UNKNOWN`、写 `re/team/capacity.json`、以及 A09 的步骤。照它跑会得到与实现不符的指导 → 同步删。

## 验收

1. `rg` 在 `docs/specs/`、`src/`、`dist/`、`scripts/` 里搜 `capacity`（大小写不敏感）**只剩**：历史票/记录/DECISIONS 里的记述、以及 D41 的说明。代码与规格里应为 0 命中。
2. 传 `capacity` 调 `rt_roster` / `rt_dispatch` → 因 `additionalProperties:false` 被拒（未知键），**不是** `CAPACITY_ARGUMENT_OBSOLETE`。
3. 规格漂移用例（`bundle.test.mjs:465` 附近）仍绿 —— 说明 `tool-schema.ts` 与新规格一致。
4. `A09` 在验收表里标为已废止并写明理由。
5. 全量门禁全绿；注意 T22 的 `l2/lock.test.mjs` 偶发红（约 1/3），别当回归。

## 硬约束

- 除本票明确列出的 `docs/specs/**` 四处，**不要改其它规格**。
- 不要削弱证据锚点 / baseline / 幂等 / 锁相关断言。
- 不要改 `docs/verify/records/**`（历史记录）。
- 不要碰 `D:\workSpace\_l3-verify`，不要跑 L3。
- 不要 push、不要合并，Lead 审后合。

## 写作用域（预估）

`docs/specs/{rt-tools.schema.json,orchestration-contract.md,acceptance-matrix.md}`、
`src/tool-schema.ts`、`src/roster.ts`、`src/index.ts`、`dist/**`、
`test/{validate,schema-static,bundle,roster,dispatch,capacity-removed}.test.mjs`、`scripts/l3-verify.mjs`
