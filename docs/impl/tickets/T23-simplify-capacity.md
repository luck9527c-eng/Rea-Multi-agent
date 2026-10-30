# T23：容量不再自建 —— 删掉推断机，改为委托宿主

状态：待办（**方向已由用户定**：能复用智能体团体就复用，不要复杂）
前身：本票原稿是「按调用容器不透传给 dispatch」的修补。用户指出那是在给一个故意不透明的接口建影子预算系统，**方向改掉**。

## 为什么改

宿主侧的实测事实（核对 `_agent-team.js` 反编译源码）：

| 项 | 事实 |
|---|---|
| `maxMembers` | 是 `TeamService` **构造函数参数**（`config.maxMembers ?? DEFAULT_MAX_MEMBERS`），**没有任何 getter / state 投影可读** |
| 它的唯一用途 | `if (state.members.length >= this.maxMembers) throw new TeamError(\`Team member limit ${this.maxMembers} reached\`, "TEAM_MEMBER_LIMIT")` |
| `maxActiveSubagents` | 团队服务里**完全不存在**；activation 限制来自 subagent 层（`ACTIVATION_LIMIT_REACHED` 是另一处） |
| 可复用的东西 | ① `used` 计数（`listMembers`，`rt_roster` 已在用）② 它自己的强制执行 + 错误码 |

也就是说：**上限读不到是设计如此，不是我们没找到 API。** T18b 的"从错误消息里学上限"、`capacity-observed.json`、`capacity-observing.json` 标记与并发守卫、`parseHostCapacityLimit`、`capacityRefusalBurned` 的"烧/不烧"分类、D40 的五档优先级表 —— 全是为了**预测一个宿主明确不给的东西**。四张票（T18/T18b/T18c/T19）都在给它打补丁，这本身就是过复杂的信号。

## 改成什么

原则：**我们知道什么就说什么，不知道的就不声称，让宿主去拒。**

**保留（复用宿主）**

1. `used`（已用席位/激活数）继续从 `listMembers` 取 —— 这是真实可读的。
2. `re/team/capacity.json`（若存在）：仅作为**操作者主动下设的上限**，用来提前把岗位标 `deferred`。文件不存在 = 完全没有容量规划。
3. 宿主拒绝时：回执 `code` 用宿主映射出的稳定码（`CAPACITY_EXHAUSTED`），**诊断里逐字带上宿主的原始消息**。

**删除**

| 删除项 | 位置（预估） |
|---|---|
| `capacity-observed.json` 写入与读取、`basis.parsed_limit` 等 | `src/capacity-source.ts` |
| `capacity-observing.json` 观测标记与并发守卫（`capacityMarkerGuard`） | `src/capacity-source.ts` |
| 从宿主消息解析上限（`parseHostCapacityLimit`） | `src/capacity-source.ts` |
| "烧掉/没烧掉"分类（`capacityRefusalBurned`）与相应措辞分支 | `src/dispatch.ts`、`src/capacity-source.ts` |
| 五档优先级里的 `observed` 与 `profile config.capacity` 两档 | `src/capacity-source.ts` |
| `CAPACITY_UNKNOWN` / `CAPACITY_UNDECLARED` 两套诊断，以及"最多损失一个成员名与席位"一类推测性措辞 | `src/roster.ts`、`src/dispatch.ts` |
| 按调用的 `capacity` 参数（若保留，仅是"本次上限"，不再参与粘性讨论） | `src/tool-schema.ts`、`src/index.ts` |
| 规划期因容量未知而 `deferred` 的逻辑 | `src/roster.ts`（`planBudget`） |

删除后的语义，简单到一段话能讲完：

> 名册报 `used`（来自宿主）与岗位状态；`capacity.json` 存在时按它把超额岗位标 `deferred`，不存在就都标可派。
> 派发直接调 `spawnTeammate`；宿主拒绝就返回 `CAPACITY_EXHAUSTED` + 宿主原话，不猜上限、不声称"烧了什么"。

## 已决：全删（用户裁决，2026-10-30）

**`capacity.json` 一并删除**，不留"操作者可下设上限"这种半留半删。

裁决理由（用户原话）：官方 Agent Teams 自己都不做容量规划，上限还是刻意藏起来的；我们替它做只会越猜越偏。

连带追加删除：

| 追加删除项 | 位置（预估） |
|---|---|
| `re/team/capacity.json` 读取（`readDeclaredCapacity` / `capacitySourceGap('project')`） | `src/capacity.ts`、`src/team-adapter.ts` |
| `planBudget` 的一切预算：剩余席位/activation、`deferred` 标记、`recommended_members` | `src/roster.ts` |
| `capacity` 入参与 schema（`max_members` / `max_active_subagents` / `reserved_*`） | `src/tool-schema.ts`、`src/index.ts` |
| 名册 render 里的 `capacity：` 行与 `reserved_*` | `src/index.ts`（render） |
| `profile config.capacity` 读取 | 装配层 / `src/team-adapter.ts` |
| SEAMS §7 状态归属表里 `re/team/capacity.json` 那一行 | `docs/impl/SEAMS.md` |

**删完之后 `rt_roster` 只剩三件事**：读宿主名册（成员与任务）、报项目 skill 兼容性缺口与技术能力缺口、生成/校验 `proposal_hash` 供 bind。
没有"预算"、没有"剩余多少"、没有"建议几人"。岗位能不能派只看**能力是否满足**，不看容量。

`DECISIONS.md` 要写清：D40 的**结论保留**（容量未知也照派、不主动探测），但为它服务的整套推断机与声明文件**全部删除**；
D40 那张五档优先级表**保留原文并标"已废止"**，不要改写历史。

## 验收

1. 代码里搜不到 `capacity-observed`、`capacity-observing`、`parsed_limit`、`capacityRefusalBurned`（留一个 `rg` 断言在测试里）。
2. 未声明容量的项目：`rt_roster` 的 gaps 里**不再有** `CAPACITY_UNKNOWN` / `CAPACITY_UNDECLARED`；`rt_dispatch` 不因容量前置拒绝。
3. 宿主真的拒绝时（可用替身构造）：回执 `code=CAPACITY_EXHAUSTED`，diagnostics **逐字包含宿主消息**，且**不含**任何"烧掉/损失一个席位"的推断。
4. `re/team/` 下**不再出现** `capacity-observed.json` / `capacity-observing.json`（即使发生拒绝）。
5. `DECISIONS.md` 记一条：D40 的**结论不变**（unknown 也照派），但**为它服务的整套推断机删除**；并说明理由（宿主上限不可读是设计）。
6. 测试：`capacity.test.mjs` 现有 16 例中依赖"解析上限/观测文件/烧不烧"的用例删除或改写；T18b/T18c/T19 三份用例文件随之大幅缩减或删除。**这是本次改动的真实成本，别低估。**
7. 全量门禁全绿；注意 T22 的偶发红（约 1/3 概率 1 条），别把偶发当回归。

## 写作用域（预估）

`src/capacity-source.ts`（大删）、`src/capacity.ts`、`src/dispatch.ts`、`src/roster.ts`、`src/tool-schema.ts`、`src/index.ts`、`dist/**`、
`docs/impl/DECISIONS.md`、`test/capacity*.test.mjs`、`test/t19-*.test.mjs`、`test/l2/*`（若引用容量）

## 备注

T19 曾报告"不修"的那几处（`phase: 'member_ready'`、台账 `member_failed`、marker 措辞、unknown 的 next_step）**大部分会随本票一起消失**，因为整个分支被删掉了。只剩 `phase` 那一处仍需单独处理。
