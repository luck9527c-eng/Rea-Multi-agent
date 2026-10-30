# T18 — 容量改为按调用声明 + 未声明时「撞一次就学」

> **已被 T23 取代**（2026-10-30）：本票引入的容量推断机与容量声明文件已整体删除（见 [DECISIONS](../DECISIONS.md) D41）。原文保留作历史记录，**不再作为实现口径**。


**来源**：用户裁决（2026-10-30）。当前容量只能写在 `re/team/capacity.json` 或 profile config，第一次用必卡；用户希望「由 Leader 决定开几个」。

## 这是一个有意的 spec 偏离（必须先记）

编排契约明确规定：「无法取得或保守确定可用额度时返回 `CAPACITY_UNKNOWN`，不估计后盲目创建」。本 ticket 把"未知即拒绝"改成"未知则照派、撞一次就学"。

理由是宿主事实：`maxMembers` / `maxActiveSubagents` / `ActivationPool.slots` 全无公开读法（D1），而一次失败 spawn 会**永久烧掉成员名与席位**。所以"猜"确实危险 —— 但"逼人先写配置"也不便宜。用户选择：**把决策权交给 Leader，并接受最多一次不可逆损失作为学费。**

必须在 `docs/impl/DECISIONS.md` 记一条（编号顺延），写清：改了哪条 spec 原文、为什么、代价是什么、谁决定的。

## 交付

### 1. 按调用声明 `capacity`（可选入参）

- `rosterInput` 与 `dispatchInput` 各加一个**可选**字段 `capacity`：`{ "max_members": <int ≥1>, "max_active_subagents": <int ≥1> }`（snake_case，与既有字段风格一致）。
- **必须同步改 `docs/specs/rt-tools.schema.json`**（它是 wire schema），并保持 `src/tool-schema.ts` 与它的漂移测试绿。这是本票唯一允许改 `docs/specs/**` 的地方。

### 2. 优先级（从高到低）

1. 本次调用的 `capacity`
2. 项目 `re/team/capacity.json`
3. profile `config.capacity`
4. **本会话已观测到的上限**（见第 3 节）
5. 都没有 → `unknown`（不再拒绝，见第 3 节）

必须把实际来源记进 operation 台账与诊断（`capacity_source: call | project | profile | observed | unknown`），**出问题要能回答"当时它以为上限是多少"**。

### 3. 未声明时：照派，撞一次就学

- 容量为 `unknown` 时 `rt_dispatch` **不拒绝**，但必须发一条诊断，明说：容量未声明、本次创建不保证有位置、最多可能损失一个成员名与席位。
- 宿主因上限拒绝 spawn（`team-adapter` 已把 `ACTIVATION_LIMIT_REACHED` / `TEAM_MEMBER_LIMIT` 映射为 `CAPACITY_EXHAUSTED` 并带 `hostCode`）时：
  - 写 `re/team/capacity-observed.json`：`{schema_version, session_id, observed_at, max_members, max_active_subagents, basis:{used_at_observation, host_code}}`；
  - `max_members` 取**观测当时的已用席位数**（失败成员已计入），即"你已经到顶了"；
  - 返回 `partial`（副作用已发生：席位已烧），回执里点名被烧掉的成员名与 `hostCode`；
  - **不要**用同名重试（D12）。
- **观测值按会话生效**：`TeamId` 就是 Lead 会话 id，席位随会话重置，所以 `session_id` 不匹配的观测值**不得**套用。
- **并发保护**：无已知容量且已有一次"观测中"标记时，第二次派发返回明确拒绝（避免并行撞出 N 个损失），而不是一起冲。

### 4. `proposal_hash` 必须包含生效的容量

T15 已让 `declared_budget` 进入 hash。本次要把**按调用传入**与**观测到的**值也纳入，保证"预算变了 → 提议失效 → bind 报 `OPERATION_CONFLICT`"这条对三种来源一致成立。

## 测试（都要）

1. 按调用的 `capacity` 覆盖项目文件（`max_members` 8 的文件 + 调用传 2 → 提议按 2 算）。
2. 同一提议、不同 `capacity` → `proposal_hash` 不同（三种来源各一例）。
3. 容量 `unknown` → `rt_dispatch` **不再**返回 `CAPACITY_UNKNOWN`，且诊断里出现"未声明/可能损失"的明确措辞。
4. 模拟宿主 `ACTIVATION_LIMIT_REACHED` → `re/team/capacity-observed.json` 写出、`max_members` == 当时已用席位数、状态 `partial`、回执点名成员与 `hostCode`、**未**用同名重试。
5. 观测值在**同会话**后续 `rt_roster(inspect)` / `rt_dispatch` 生效（`capacity_source: observed`）。
6. 观测值来自**别的会话** → 不生效（仍 `unknown` 或回落其它来源）。
7. 并发保护：无已知容量 + 已有观测中标记 → 第二次派发被明确拒绝。

## 门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线 **570 pass / 0 fail / 0 skip**、`tsc` 0 错。改 `src/` 必须重建并提交 `dist/`。

## 兼容与边界

- 未传 `capacity`、项目与 profile 都没声明、也没有观测值时：**行为变化**（以前拒绝，现在照派）。这是本票的核心，测试 3 锁住。
- 已有 `re/team/capacity.json` 的项目行为**不变**。
- 不得回退 D1 的其它部分：仍然禁止读宿主私有字段、禁止靠 spawn 试探余额（本票的"撞一次"是**被动观测**，不是主动试探；一次派发只因真实需要而撞，不为探测而撞）。

## 验收

- [ ] tsc 0 错、门禁 0 fail / 0 skip
- [ ] `docs/specs/rt-tools.schema.json` 与 `src/tool-schema.ts` 同步且漂移测试绿
- [ ] 七条测试全绿
- [ ] DECISIONS 记明 spec 偏离（改了什么、为什么、代价、谁决定）
- [ ] `capacity_source` 在诊断/台账里可见
- [ ] 未声明容量的风险措辞出现在诊断里，不是静默
