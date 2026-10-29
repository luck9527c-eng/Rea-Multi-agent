# 实现决策与规格更正（Lead 记录）

> 探明结果推翻了规格里若干**事实性**断言。实现以本文件为准；本文件不改 `docs/specs/`，但 T10 必须在验收记录里承认这些差异。
> 证据来源：`D:\workSpace\rea-ma-notes\E2-team-service.md`、`E3-project-skill.md`、`agent-team.rc3.md`、`D:\workSpace\deepseek-harness` 的 `dsh-v0.2.1-rc.3` tag。

## D1 — 容量余额：宿主没有受支持的只读查询 → 必须允许「显式声明」

**事实**：`maxMembers`、`maxActiveSubagents`、`ActivationPool.slots` 全是私有且无 getter；唯一公开的限额 getter 是 `ctx.subagents.resolveMaxDepth()`（讲的是 depth）。`listMembers().filter(role==='teammate').length` 能数**已用**席位，但**上限与剩余不可算**。`ACTIVATION_LIMIT_REACHED` 来自 `ActivationPool.reserve`，且**一次失败的 spawn 会永久烧掉成员名和 maxMembers 一个席位**（roster 留 `phase:'failed'`，`maxMembers` 计入失败成员）。

**决策**：`teamAdapter.capacity()` 按以下优先级取值，**永不猜 8/16、永不读私有字段、永不靠 spawn 试探**：

1. `re/team/capacity.json`（项目声明，含 `declared_at`/`declared_by`/`maxMembers`/`maxActiveSubagents`）→ `known:true, evidence.source:'declared:re/team/capacity.json'`；
2. 插件自身 `config.capacity`（profile patch 声明）→ `known:true, evidence.source:'declared:profile-config'`；
3. 都没有 → `known:false`，`memberSlots.used` 仍从 `listMembers()` 得出（已知），`remaining/total = null`。

第 3 种情况下 `rt_roster`/`rt_dispatch` 返回 `CAPACITY_UNKNOWN`，**诊断里必须写清下一步**（在 `re/team/capacity.json` 声明，或改 profile config），而不是含糊"资源不足"。

**已用席位**永远可数且必须计入失败成员：`used = listMembers().filter(m => m.role === 'teammate').length`。

## D2 — 任务板 CAS 错误码不同名

宿主抛 `TEAM_TASK_STALE_REVISION`。`teamAdapter` 映射到本包的稳定码 `REVISION_CONFLICT`，并在 `diagnostics` 保留原始码与**实际 revision**。其余 `TEAM_TASK_*` 按语义映射（`TEAM_TASK_BLOCKED` / `TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_UNAUTHORIZED` / `TEAM_LEAD_REQUIRED`）。

## D3 — 任务板状态机（已核实，写测试的人照这个）

- `create` → `pending`、无 owner、`revision = 1`。
- `reassign`（**Lead only**）→ **总是**写 `status='in_progress'` + `ownerId`；`taskReady()` **只在指派具体成员时检查**；清空 owner 的分支在 gate **之前** early-return（所以对 blocked 任务也能解绑）。
- `reassign` 传 `owner: null` → 退回 `pending`（等价 release）。
- `complete` 要求 `status === 'in_progress'`，且 `authorizeOwner()` = Lead **或** owner。
- `completed` **保留** owner；`deleted` 是墓碑。
- `pending + owner` 与 `in_progress + 无 owner` **不可达**。
- `expectedRevision` 不匹配 → `TEAM_TASK_STALE_REVISION`；提交值恒为 `current + 1`。

## D4 — 角色授权只有三处，其余 owner-or-Lead

服务层**只有三个** Lead-only 操作：`spawnTeammate`、`interrupt`、`updateTask{action:'reassign'}` → 越权抛 `TEAM_LEAD_REQUIRED`。其余（`complete`/`release`/`edit`/`set_dependencies`/`reopen`/`delete`）是 owner **或** Lead → 越权抛 `TEAM_TASK_UNAUTHORIZED`；`claim` 是自助的。

**工具层没有任何角色检查** —— 授权完全靠服务层。所以本包自己的 `rt_dispatch`/`rt_conclude`/`rt_roster(bind|takeover)` 必须**自己做** Lead 身份检查（`identity` + `membership`），这是本包的责任，不是宿主的。

## D5 — 规格更正：`workflow` 是 depth-1 工兵的未受限逃逸口

规格 §Further Notes 的评审更正说「工兵通过 `workflow` 开子代理不成立（depth 超限）」。**探明结果与此不符**：`childDepth = parent + 1`，cap 用 `>` 比较，`maxDepth:1` 因此挡住**孙代**；team spawn 走 `startActivation` 不传 `maxDepth`（绕过 depth 策略）；而 **`workflow` 传了 `parent` 但从不传 `maxDepth`**。

因此：teammate（depth=1）用 `subagent`/`subagent_fork` 会被挡，用 `workflow` **不会**。

**本包的处理（v0）**：不声称"平台挡住一切下一层创建"。补偿控制：
- 派发契约明写「你没有派发权，缺人就报回来」；
- 团队操作本身由服务层 `TEAM_LEAD_REQUIRED` 挡住（成员拿不到 Lead 授权）；
- 在 `docs/verify/` 与 README 的已知限制里**如实记录**这条，并列为 L3 待实测项（A 系列里"下一层创建受限"的判定改为「`subagent`/`subagent_fork` 被 depth 挡；`workflow` 不受 depth 限制，见已知限制」）。

## D6 — 版本漂移：运行的是 0.2.1-rc.3，checkout 是 0.2.2-alpha.2

安装目标 `0.2.1-rc.3`（`dsh-runtimes\dsh-primary-runtime\runtime.json` 与 `app.asar` 内 `dsh/package.json`）。团队 patch 在 rc.3 停用 **4 行**主机面（`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`），在 checkout 只停用 3 行（`tool-subagent-list-agents` 已被并进 `tool-subagent-control`）。服务层、任务板、27 个 `TEAM_*` 码、9 个工具名两边**行为一致**。

**决策**：preset 工具面基线用 **rc.3**（`docs/impl/baseline/standard.patch.rc3.yml`），删两行（`tool-subagent-control`、`tool-subagent-list-agents`），保留 `tool-subagent`/`tool-subagent-fork`/`workflow-ptc`/`tool-workflow`。

## D7 — 团队 profile bundle 已启用，但插件不得假定

`dsh.profile.bundles` 里已经列了 `@deepseek-ai/dsh-experimental-agent-team-profile`，且它没有一个按 bundle 的 `disabled` 字段——启用方式**只有**成员资格。插件仍必须在服务缺失时给 `TEAM_SERVICE_UNAVAILABLE` + `bin/doctor.mjs` 修复路径。

## D8 — 项目 skill 基线

权威副本是 `C:\Users\Administrator\.agents\skills\reverse-project-management\`（git HEAD `c4cf44e`，无 tag/version）。工作树**有未提交的两个新参考文档**：`team-coordination.md`、`tool-inventory.md` —— 正是本设计依赖的团队规则。**四个真实分析项目全部没有团队规则**（从 HEAD 初始化），其中一个的 `project.py` 还更旧。

**决策**：`compatibility` 把「团队规则段缺失」判为**缺口**，`bind` 拒绝并给出"按 skill 团队规则合并项目副本，不要用全局副本覆盖历史"的下一步；**永不**用全局副本覆盖项目副本，**永不**自动 `init` 已有项目。L2 测试的临时项目由测试自己复制一份**含团队规则**的副本。

## D9 — `send_message` 上限与会话消息前缀

上限 65536 **字节**，用 `Buffer.byteLength(JSON.stringify(content),'utf8')` 量，量的是**含 `Team message from <name>:` 信封前缀**的数组；比较是 `>`，所以恰好 65536 通过。CJK 3 字节/字。实现按字节算并留余量。

## D10 — `interrupt_agent`

`previousStatus` 只可能是 `running` 或 `inactive`（`availability()` 产不出 `provisioning`/`failed`）。

## D11 — `re/env/tools.json` 目前没有生产者

skill 侧**没有**生成命令，本机**零个真实实例**；唯一具体样例是本仓库的 `docs/examples/tools.json`。插件必须**容忍缺失**，按 `tool-discovery.md` 报 unknown/gap，绝不自己生成清单、绝不因缺失而崩。

## D12 — 失败成员的席位语义

一次失败 spawn 会烧掉名字 + 席位。因此 `rt_dispatch`：**先**查名字唯一性与已用席位、**再** spawn；spawn 失败后必须把该成员记成 `failed` 并计入已用席位，**不得**用同名重试。
