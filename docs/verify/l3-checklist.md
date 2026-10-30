# 第三层验收清单（真 `ctx.agentTeams` 团队会话）

> 本文件由 `node packages/dsh-redteam-lead/scripts/l3-verify.mjs checklist --out <path>` 生成。
> **不要手改**：要改断言就改脚本里的 `STEPS`，重新生成并提交。
>
> **状态：未执行。** 截至本文件生成时，第三层一次都没有跑过。本文件是待办与判定标准，**不是通过结论**；
> 通过与否只由 `docs/verify/` 下填好的记录文件决定（见 `l3-record-template.md`）。

七步共 55 条断言，其中 39 条可直接观察；其余标了「需构造」或「不可观察」——
**不要**用"看起来对"去填这三类里的后两类。

## 执行顺序：**不是** 1→2→3→4→5→6→7

第 4 步要求"先完成同岗首个任务的验收，再派下一任务"，而"完成验收"正是第 6 步的内容
（`rt_conclude` 走完归档/seal/index/check 才能 `complete`）。所以第 4 步**依赖**第 6 步。

**按 `1 → 2 → 3 → 6 → 4 → 5 → 7` 执行。**

省力技巧：第 6 步的第一次收口用 `outcome="blocked"` + `run_ids: []`（工兵报"缺某项能力"），
收口路径照样完整走一遍但不需要真跑实验、不需要封存；第 4 步要验的是**席位复用**，不是分析质量。
真实 `seal` + `check --hashes` 留给第 6 步的第二轮（交 `finding`，带真 RUN 与 `artifact_locator` 锚点）。

## 标记约定

| 标记 | 含义 | 能不能算通过 |
|---|---|---|
| 〔可观察〕 | 本会话的原始工具返回或 `collect` 的 JSON 里能直接读到判据 | 能，贴原文即可 |
| 〔需构造〕 | 必须先造一个额外条件（改坏一个字段、开第二个会话、故意等超时） | 能，但必须写清构造方式，否则不算 |
| 〔不可观察〕 | 现有工具面产不出该判据 | **不能**。记 `not-run` + 为什么 |

## 开始之前

1. 读完 `docs/verify/README.md` 的「前置」；四项缺一项就不要开始（团队 profile bundle、bundle 已 `link:` 安装并列进 `dsh.profile.bundles`、临时分析项目已接 skill、Python 可达）。
2. 复制 `docs/verify/l3-record-template.md` 成一份记录，填好会话 id 与开始时间。
3. **一次性会话**：验收完即丢。席位按会话计，丢弃即释放；重跑要在新会话里重新建成员。
4. 每一步都做「`collect` → 操作 → `collect` → `diff`」，diff 是"这一步到底写了什么"的唯一机读证据。

每一步的取证命令固定是这三条（`<证据目录>` 必须**在项目根之外**，脚本会拒绝把 `--out` 写进项目）：

```powershell
node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\sN-before.json
node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs collect --project <项目根> --out <证据目录>\sN-after.json
node <仓库根>/packages/dsh-redteam-lead/scripts/l3-verify.mjs diff --before <证据目录>\sN-before.json --after <证据目录>\sN-after.json --out <证据目录>\sN-diff.json
```

`collect` 的输出里有 `digest`（只覆盖 path/bytes/sha256，不含 mtime）：两次 `collect` 的 `digest` 相同 = 项目内容没变。

## 第 1 步 — 安装、一次性会话、工具面（含同名工具归属与 doctor）

**目标**：证明「红队指挥」preset 真的挂上了团队服务、三个 rt 工具与团队工具都可用，并且**同名工具确实是团队版**；另证明在没有团队服务的环境里 `bin/doctor.mjs` 仍然可达。

**本步覆盖的 A 编号**：`A01`、`A02`、`A38`

### 怎么做

1. 按 `docs/verify/README.md` 的「前置」装好 bundle（`link:` 进 profile + 写进 `dsh.profile.bundles`，顺序在团队 profile 之后），重启 DSH。
2. 新建**一次性**会话，模式选「红队指挥」（preset id `redteam-lead`）。已有会话保留它启动时的 preset，**必须新开**。
3. 在普通 shell（不是会话内）跑一次 `node <仓库根>/packages/dsh-redteam-lead/bin/doctor.mjs --profile %USERPROFILE%\.dsh\profiles\desktop --project <临时项目根>`，记下完整 JSON 与退出码。
4. 在会话里先跑 `collect --project <临时项目根> --out <证据目录>\s1-before.json`。

### 看哪里

- 会话里直接问：`list_agents` 的原始返回（`members[]` 的 `name`/`role`/`status`），Lead 伪行必须在第一行且 `role=lead`。
- 工具参数面：故意少传一个必填字段（例如 `rt_roster` 只传 `action=inspect`）→ 判据是 `INVALID_ARGUMENT` 的具体报错文本，而不是"工具存在"。
- 同名归属：用**不存在的成员名**做探针，保证零投递（见下面的断言）。
- doctor：看 `status`/`code`/`diagnostics[]`/`data.configuration_ready`/`data.runtime_ready`/`data.profile.bundle_listed`/`bundle_linked` 与退出码。

### 可观察断言

- [ ] 〔可观察〕`list_agents` 返回团队名册（含 Lead 伪行 `role=lead`、`name=lead`），说明 `ctx.agentTeams` 真的在，不是替身。
- [ ] 〔可观察〕三个 rt 工具的参数面与规格一致：`rt_roster` 必填 `project_root`、`action∈{inspect,bind,takeover}`；`rt_dispatch` 必填 `project_root/operation_id/post_id/route_id/target_ids/objective/evidence_required/prohibited`；`rt_conclude` 必填 `project_root/operation_id/dispatch_id/attempt_id/task_id/expected_revision/submission_ref/submission_sha256/review`。少传必填字段得到 `INVALID_ARGUMENT`。
- [ ] 〔可观察〕团队工具按**成员身份**注册（不是按 preset）：Lead 调 `team_task_list` 能拿到 `tasks[]`（空数组也算可用），`team_task_get`/`team_task_create`/`team_task_update`/`spawn_teammate`/`wait_agent` 在工具表里可见。
- [ ] 〔可观察〕同名工具归属（**不能只看名字**）：`send_message({target:"nobody-xyz",message:"probe"})` → 期望 `TEAM_MEMBER_NOT_FOUND`（参数名是团队版的 `target`，且零投递）；`send_message({agent_id:"nobody-xyz",message:"probe"})` → 期望参数校验失败（`agent_id` 不是本工具字段）。
- [ ] 〔可观察〕`interrupt_agent({target:"nobody-xyz"})` → 期望 `TEAM_MEMBER_NOT_FOUND`；`interrupt_agent({agent_id:"nobody-xyz"})` → 期望参数校验失败。两条合起来才证明挂载的是团队版而非 `tool-subagent-control` 版。
- [ ] 〔可观察〕A01：`bin/doctor.mjs` 在**没有团队服务**的普通 shell 里可达：输出同一信封形状，`data.runtime_ready` 恒为字符串 `"unknown"`（不得是 `true`），`data.configuration_ready` 只反映离线配置，退出码 0（无硬阻塞）或 1（有硬阻塞）。
- [ ] 〔可观察〕A01：doctor 的诊断带 `next_step`，且当本 bundle 未安装/未列进 `dsh.profile.bundles` 时，`[profile.bundle-listed]`/`[profile.bundle-declared]`/`[profile.bundle-linked]` 三条各给一条具体修复路径。
- [ ] 〔可观察〕A38：`re/env/tools.json` 缺失时 `rt_roster` 只报 unknown/gap，**不得**自动生成该文件；`collect` 输出里 `env-tools` 目标应为 `absent`（若存在则记录其 sha256，用于后续比对是否被插件写过）。
- [ ] 〔需构造〕A38：另一客户端（如 REA MCP）的工具表里出现同名 MCP 工具时，本会话的 `rt_roster` 不得因此判某能力为已就绪；构造方式是临时连一个 MCP server 再看 `gaps`，未连通时只允许报 discovered/unknown。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| 少传必填字段（任一个 rt 工具） | `INVALID_ARGUMENT` | 参数面证据 |
| `send_message` / `interrupt_agent` 指向不存在的成员 | `TEAM_MEMBER_NOT_FOUND` | 团队版参数名与零投递 |
| `send_message` 传 `agent_id` | 参数校验失败（无 `code`） | 证明不是 subagent-control 版 |
| 在无团队服务的会话里调 rt 工具 | `TEAM_SERVICE_UNAVAILABLE` | 诊断必须指向 doctor |

### 本步要贴的证据

- `list_agents` 原始返回（整段 JSON）。
- 四个探针（两个 `send_message`、两个 `interrupt_agent`）的原始返回与报错文本。
- `bin/doctor.mjs` 的完整 stdout + 退出码（`$LASTEXITCODE`）。
- `s1-before.json`（`collect` 产物）与它的 SHA-256。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- 「同名工具」在本 preset 下的另一半（`tool-subagent-control` 的 `send_message/list_agents/interrupt_agent`）**已被 patch 行删除**，所以会话里不存在两个活着的同名工具可供对比。能观察的只有「留下的这个的参数面/行为属于团队版」+「被删的那行确实不在 patch 里」。这是本步的如实边界，不是失败。
- `list_agents` 的确切字段名以实际返回为准；若与 `name/role/status` 不同，照抄原始输出，不要按预期改写。

## 第 2 步 — `rt_roster`：兼容性、岗位需求、缺口、max_posts 裁剪

**目标**：证明名册是**按当前项目副本和当前能力**算出来的：兼容性有明确判定、可用岗位需求非空、缺口能对上实际缺的东西、岗位数随目标与 `max_posts` 变化；并证明容量键已从 wire schema 删除（传了就是未知字段），`re/team/` 下没有容量声明/观测文件。原 A09 的两条容量余额断言已废止，按 T23 起的现行行为改写为下方 (T23 起) 判据，保留以便对照旧记录。

**本步覆盖的 A 编号**：`A40`

### 怎么做

1. 在会话里对临时项目跑 `rt_roster`（`action=inspect`，默认只读）。跑之前先 `collect --out <证据目录>\s2-before.json`。
2. 再跑一次，只改 `target_kinds`（例如 `["webapp"]` → `["game","webapp"]`）或 `max_posts`，记录 `posts` 数量与 `gaps` 的变化。
3. 对照检查 wire data：`data` 里没有容量键（`capacity` / `reserved_*` / 建议成员数）；再传一次已删除的 `capacity`，入口应按未知字段拒绝（`INVALID_ARGUMENT`），不是 `CAPACITY_ARGUMENT_OBSOLETE`。
4. 核对 `re/team/`：没有任何文件名含 `capacity` 的声明/观测文件；`list_agents` 的 `role=teammate` 计数只作已用席位诊断。
5. 全部 inspect 跑完后 `collect --out <证据目录>\s2-after.json`，`diff` 必须为空（inspect 不写项目）。

### 看哪里

- `data.compatibility`（`status`/`gaps`/`versions` 或 `rule_digest` 一类字段）与 `data.posts[]`（每个岗位的 `id`/`required`/`optional`/`priority`）。
- `data.gaps[].code` 与 `reason`/`next_step`；已用席位在诊断里（`TEAM_SEATS_USED` / `TEAM_SEATS_UNKNOWN`），不参与岗位裁剪。
- `data.proposal_hash` 与 `data.binding_ref`：inspect 不得写 `binding_ref`（必须是 `null`）。

### 可观察断言

- [ ] 〔可观察〕项目副本兼容性有明确判定，不是"读到了就算过"：缺团队规则段 → `SKILL_INCOMPATIBLE` 且 `next_step` 要求按 skill 合并项目副本（**不得**用全局副本覆盖，也不得自动 `init`）。
- [ ] 〔可观察〕每个可用岗位的 `required`（与 `optional`）都非空；`disabled` 的预留岗不出现在可派岗位里（不得被当成可用岗）。
- [ ] 〔可观察〕缺口与当前能力相符：把一个确实缺的能力（例如未安装的 IDA / 未绑定的 provider）留在需求里 → `gaps` 出现 `CAPABILITY_MISSING` 或 `CAPABILITY_NOT_READY`，并且点名缺的能力族，而不是笼统"资源不足"。
- [ ] 〔可观察〕岗位数随目标与 `max_posts` 变化：改 `target_kinds`（webapp → game+webapp）后 `posts` 集合变化且并集去重；调小 `max_posts` 后岗位被标 `deferred`（`CAPACITY_EXHAUSTED`），裁剪结果稳定（同样入参两次结果一致）。
- [ ] 〔可观察〕(T23 起，原 A09) wire data 里没有容量键（`capacity` / `reserved_*` / 建议成员数）；再传 `capacity` 时入口按未知字段返回 `INVALID_ARGUMENT`，**不是** `CAPACITY_ARGUMENT_OBSOLETE`，且没有发生任何宿主调用。
- [ ] 〔可观察〕(T23 起，原 A09) `re/team/` 下不出现任何容量声明/观测文件（文件名含 `capacity` 的文件为零；inspect 前后 `collect` 的路径清单一致）。已用席位只以 `TEAM_SEATS_USED` / `TEAM_SEATS_UNKNOWN` 诊断出现，不参与裁剪。
- [ ] 〔可观察〕`action=inspect` 零副作用：跑完后 `collect` 的 `digest` 与 `s2-before.json` 相同，且没有新增 `re/team/binding.json`。
- [ ] 〔可观察〕A40：`data.project_id` 由项目根本身决定（同一根两次一致），`data.session_id`/`team_id` 是本会话的值；**不要**把上一次记录里的 pass 迁移过来。
- [ ] 〔需构造〕A40：换执行者/换入口（例如同一项目在另一个 profile 或另一台机器上打开）后，`compatibility` 必须重算而不是沿用旧判定；构造方式是改 `re/team/binding.json` 里的 `rule_digest`/`session` 再 inspect，期望 `RECOVERY_REQUIRED` 或明确的"需要重新兼容检查"。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| 缺团队规则段/布局不支持 | `SKILL_INCOMPATIBLE` / `PROJECT_NOT_CONFIGURED` | 不得覆盖副本、不得自动 init |
| 传已删除的 capacity（T23 起） | `INVALID_ARGUMENT`（未知字段） | 不是 `CAPACITY_ARGUMENT_OBSOLETE` |
| 缺能力 | `CAPABILITY_MISSING` | 点名能力族与下一步 |
| 同一个根换了会话又来改 | `PROJECT_SESSION_MISMATCH` | 先接管/解绑 |

### 本步要贴的证据

- 两次（或多组入参）`rt_roster` 的**完整**返回（含传 `capacity` 被拒的原文）。
- `list_agents` 的原始返回（`role=teammate` 计数；证明已用席位来自宿主名册）。
- `re/project.json` 与项目 skill 副本路径（用于证明兼容性读的是项目副本）。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- 本插件**不读**任何容量声明（容量声明/观测文件已随 T23/D41 删除）：`max_posts` 是操作者给的岗位数上限，不是宿主能创建多少成员的预测；宿主的真实上限只在它拒绝 spawn 时可见。
- `rt_roster` 无法回答"还剩几个席位上限"；`used` 只能从 `list_agents` 数 `role=teammate` 得到。

## 第 3 步 — 首次 `rt_dispatch`：身份、状态、契约落盘、不提前实验

**目标**：证明首次派发真的建出了 `role=teammate` 的成员、任务落到 `in_progress` 且 owner 正确、契约完整落盘并与路线/任务/尝试身份对得上，并且成员是**先拿到完整契约**再动手。

**本步覆盖的 A 编号**：`A10`、`A12`、`A13`

### 怎么做

1. 先按项目 skill 建一条可执行路线：`re/routes/<R>.json` 的 `status` 必须是 `planned` 或 `active`（只有这两个可派）。
2. `collect --out <证据目录>\s3-before.json`。
3. 调 `rt_dispatch`（`project_root`/`operation_id`/`post_id`/`route_id`/`target_ids`/`objective`/`evidence_required`/`prohibited`，按需 `capability_needs`/`timebox_ms`/`delivery_timeout_ms`）。
4. 立刻 `collect --out <证据目录>\s3-after.json`，然后 `diff --before s3-before.json --after s3-after.json`。

### 看哪里

- `rt_dispatch` 返回 `status=ok`，`data` 含 `dispatch_id`/`attempt_id`/`task_id`/`member`/`route_id`/`revision`/`phase="delivered"`/`contract_ref`/`contract_sha256`/`work_dir`/`started_at`。
- `list_agents` 里新成员 `role=teammate`、`name == data.member`；`team_task_list` 里该 `task_id` 的 `status=in_progress`、`ownerName == data.member`。
- `collect` 新增 `re/team/dispatches/<D>.json`，其 `sha256` 必须等于 `data.contract_sha256`；`re/team/attempts/` 出现对应尝试记录。

### 可观察断言

- [ ] 〔可观察〕A10：成员身份与任务状态对得上——`list_agents` 新行 `role=teammate`，`team_task_list` 同一 `task_id` 为 `in_progress` 且 `ownerName` 就是该成员，**不是** `pending + owner`（D3：不可达）。
- [ ] 〔可观察〕A10：契约完整落盘且可校验——`re/team/dispatches/<dispatch>.json` 的 SHA-256 == `data.contract_sha256`，契约里的 `dispatch_id`/`attempt_id`/`task_id`/`route_id` 与工具返回、`team_task_list`、`re/routes/<R>.json` 完全一致；契约超过 64 KiB 时消息里只应有引用（D9），正文不得被截断。
- [ ] 〔可观察〕A10：首派不提前实验——`rt_dispatch` 返回那一刻 `data.started_at` 为 `null`（`started_at` 只认成员写的 `start.json`）；`re/team/work/<D>/<A>/` 在成员回报前不得出现实验产物。
- [ ] 〔可观察〕契约里写明了「你没有派发权，缺人报回来」与工作目录边界（`re/team/work/<D>/<A>/`），且 `prohibited` 原样落盘（不能只剩摘要）。
- [ ] 〔需构造〕A12：消息层失败要带已有身份返回 `partial`，且**同信封重投不重复启动**。构造方式：把 `delivery_timeout_ms` 调到极小值或临时把契约文件改成不可读，再观察 `status=partial` 且 `data` 里保留 `dispatch_id`/`attempt_id`；重投同一 `operation_id` 返回原结果（`replayed=true`）。
- [ ] 〔需构造〕A12：超长消息必须被拒（`DELIVERY_FAILED`，`bytes`/`limit` 可读），不得截断后假报成功。构造方式：把 `objective` 撑到超过 65536 字节（注意 `send_message` 按含信封前缀的 JSON 字节计量，CJK 3 字节/字）。
- [ ] 〔不可观察〕A13：无 `start.json` 超 `delivery_timeout_ms` 必须报"未确认开始"而不是"已开始"。这一次性会话里成员会自动起跑，无法可靠制造"不写 start.json"，只能记 not-run。
- [ ] 〔需构造〕(T23 起) 宿主真的拒绝 spawn（席位/activation 满）时：回执 `status=partial`、`code=CAPACITY_EXHAUSTED`，`diagnostics[]` 逐字含宿主原话与 `hostCode`，**不出现**"烧掉/损失一个席位"一类措辞。只在本会话自然撞到上限时记录；**不得**为触发它故意烧名字/席位。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| 路线不存在/状态不可派 | `PROJECT_NOT_CONFIGURED` / `RECOVERY_REQUIRED` | 先按 skill 建路线 |
| 岗位被别人占着 | `MEMBER_BUSY` | 先收口再派，不排队 |
| 前置任务未完 | `DEPENDENCY_BLOCKED` | blocked 且零副作用 |
| 宿主拒绝 spawn（席位/activation 满） | `CAPACITY_EXHAUSTED` / `partial` | 逐字含宿主原话；不声称"烧掉/损失" |
| 消息层失败 | `DELIVERY_FAILED` / `partial` | 保留已有身份 |

### 本步要贴的证据

- `rt_dispatch` 的完整返回（含 `operation_id`）。
- `team_task_list` 与 `list_agents` 的原始输出（派发后立刻取）。
- `re/team/dispatches/<D>.json` 的前 40 行（证明正文完整而不是引用摘要）+ 它的 SHA-256。
- `s3-before.json` / `s3-after.json` / `diff` 输出。
- 宿主拒绝时的原始回执与 `diagnostics[]`（仅在本会话自然撞到上限时）。
- 成员第一份回报的原文（证明它是照契约做的、没有提前实验）。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- 「不提前实验」只能证明"`started_at` 在派发返回时为 null + 契约先于产物存在"，不能证明模型内部的时序；这是可观察性的上限。
- A13 的"两时间盒分开"需要制造"成员不写 start.json"，一次性会话里不可控，记 not-run。

## 第 4 步 — 同岗第二个任务：复用成员、`task_id` 变化、繁忙重派被拒

**目标**：证明"先收口再派"的复用语义：成员数不变、新任务有新 `task_id`、成员拿到新的完整契约；同时证明忙碌时重派是**拒绝**而不是排队。

**本步覆盖的 A 编号**：`A11`、`A22`

### 怎么做

1. 先让第 3 步那个任务走到 `completed`（见第 6 步；顺序上第 4 步在第 6 步之后执行也可，只要记录里写清实际顺序）。
2. `collect --out <证据目录>\s4-before.json`；再对**同一 `post_id`** 调 `rt_dispatch`（新的 `operation_id`）。
3. 收口后立刻 `collect --out s4-after.json`；`diff` 出变化。
4. 另测"忙碌重派"：在第二个任务还 `in_progress` 时，对同一 `post_id` 再派一次。

### 看哪里

- 前后 `list_agents` 的 teammate 行数（应相同，不是 +1）。
- `team_task_list` 的 `task_id` 集合（应新增一个，旧的那个仍是 `completed` 并保留 owner）。
- 新契约文件与 `data.contract_sha256`；第二次调用的成员回报里引用的 `contract_ref` 是否换成新的。
- 忙碌重派时 `rt_dispatch` 的 `status`/`code`，以及 `diff` 是否为**空**（零副作用）。

### 可观察断言

- [ ] 〔可观察〕A11：成员数不变——`list_agents` 的 `role=teammate` 行数与第 3 步相同（复用同一成员），且这不是因为失败席位被跳过（`roster.json` 的 `phase` 不是 `failed`）。
- [ ] 〔可观察〕A11：`task_id` 变化——`team_task_list` 出现新的 `task_id`，旧的仍是 `completed` 且 owner 保留（D3：`completed` 保留 owner），**不是**把旧任务改回 `in_progress`。
- [ ] 〔可观察〕A11：成员收到新的**完整**契约——新 `re/team/dispatches/<D2>.json` 的 SHA-256 == 新 `data.contract_sha256` ≠ 旧契约的 SHA-256，且 `work_dir` 换成新的 attempt 目录。
- [ ] 〔可观察〕A11：忙碌重派被拒——`status=blocked`、`code=MEMBER_BUSY`，`next_step` 明确要"先收口再派"，且 `diff` 显示**零新增/零变更**（不建成员、不建任务、不写契约）。
- [ ] 〔需构造〕A22：若本次派发带 `resource_needs`，则观察 `re/team/resources.json` 的 `aliases`/`physical_identity`：同一物理实例的两个别名必须互斥，不同实例/只读共享才允许并行；构造方式是声明两个指向同一 `physical_identity` 的 `resource_key` 再派一次，期望 `OPERATION_CONFLICT` 或明确的互斥拒绝。
- [ ] 〔不可观察〕A22：残留进程/端口是否被隔离后不重分配，需要真的留着进程再申请资源；一次性会话里不做（会污染后续步骤），记 not-run 并写明缺什么。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| 同岗忙碌再派 | `MEMBER_BUSY` | blocked + 零副作用 |
| 旧任务未收口就想复用 | `MEMBER_BUSY`（同一成员最多一个未收口任务） | 不是排队 |
| 资源物理身份冲突 | `OPERATION_CONFLICT` | 先登记 aliases 或换实例 |
| 任务 revision 过期 | `REVISION_CONFLICT` | 带实际 revision |

### 本步要贴的证据

- 两次派发的完整返回（`task_id`/`contract_ref`/`contract_sha256`/`work_dir` 四个字段要能并排对比）。
- 两次 `list_agents` + `team_task_list` 原始输出（证明成员数不变、旧任务仍 `completed`）。
- 忙碌重派的完整返回 + 那次 `diff` 的**空**结果。
- `s4-before.json` / `s4-after.json` / `diff`。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- 「先完成同岗首个任务的验收再派下一任务」这一步的顺序依赖第 6 步的收口结果，所以记录模板里要写清实际执行顺序（第 4 步可能在第 6 步之后）。

## 第 5 步 — 真实 teammate 越权被拒 + 下一层创建受限

**目标**：用**真实成员身份**证明：teammate 调 `rt_dispatch`/`rt_conclude` 被身份拒绝且零副作用；同时用真实 teammate 观察下一层创建受限，并把「裸子代理被拒」与「工具不存在」区分开。

**本步覆盖的 A 编号**：`A03`、`A08`

### 怎么做

1. 在会话里给该成员派一个**只读探针任务**（或用 `send_message` 让它执行下列探针），要求它把原始返回贴回来。
2. 让 teammate 依次调用：`rt_dispatch`（随便合法入参）、`rt_conclude`（用真实 `dispatch_id`/`attempt_id`/`task_id`）、`subagent({prompt:"probe"})`、`workflow`（**不要真跑**，见 gaps）。
3. `collect --out s5-before.json`（在 teammate 探针之前）与 `s5-after.json`（之后），`diff` 必须为空。
4. 再让 Lead 用 `subagent` 开一个**裸子代理**，让它调 `rt_dispatch`，记录它看到的是"工具不存在"还是"身份拒绝"。

### 看哪里

- teammate 的原始工具返回：`status`/`code`/`reason`（`reason` 里应点出当前角色是 `teammate`）。
- `diff` 是否为空——这是"无副作用"的唯一机读判据。
- 裸子代理那次的错误形状：`TEAM_SERVICE_UNAVAILABLE`（没有成员身份）vs 工具不存在（模型看不到该工具）。

### 可观察断言

- [ ] 〔可观察〕A03：teammate 调 `rt_dispatch` → `code=ROLE_REQUIRED`（身份来自 `ctx.exec.agent` + 团队服务，不接受入参自报），`reason` 点名 `teammate`；`diff` 为零 → 无成员、无任务、无契约、无审计新增。
- [ ] 〔可观察〕A03：teammate 调 `rt_conclude` → `code=ROLE_REQUIRED`；该任务仍是 `in_progress`、owner 不变、`re/team/receipts/` 无新增（零副作用）。
- [ ] 〔可观察〕A03：`rt_roster action=inspect` 对真实成员是**允许**的（只读）；同一个 teammate 调 `bind`/`takeover` → `ROLE_REQUIRED`。
- [ ] 〔可观察〕下一层创建受限（真实 teammate）：`subagent` 与 `subagent_fork` 都被 depth 策略挡住（错误文本提到 depth/maxDepth），且**没有**真的建出孙代（`list_agents` 的成员数不变）。
- [ ] 〔可观察〕A08：把「裸子代理看不到团队工具」与「看得见但被身份拒绝」分开记——裸子代理若拿不到团队工具（工具不存在），**不能**当作身份拒绝的证据；反之它若调到了 `rt_dispatch`，期望 `TEAM_SERVICE_UNAVAILABLE`（没有成员身份）而不是 `ROLE_REQUIRED`。
- [ ] 〔不可观察〕`workflow` 不受 depth 限制（D5）：它传 `parent` 但从不传 `maxDepth`。**不要**为了验收真跑 `workflow`——那会真的开出孙代并烧掉 activation 名额。这一条只能按 D5 的静态结论与代码引用记录，标记为已知限制。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| teammate 调 `rt_dispatch`/`rt_conclude` | `ROLE_REQUIRED` | 零副作用 |
| teammate 调 `rt_roster` 的 `bind`/`takeover` | `ROLE_REQUIRED` | inspect 仍允许 |
| teammate 调 `subagent`/`subagent_fork` | depth 拒绝（宿主错误，非本包码） | 不得记成本包拒绝 |
| 裸子代理调 `rt_dispatch` | `TEAM_SERVICE_UNAVAILABLE`（或工具不存在） | 两者必须分开记 |

### 本步要贴的证据

- teammate 回传的**原始**工具返回（不要复述，要原文）。
- `s5-before.json` / `s5-after.json` / `diff`（空的 diff 也要贴）。
- 裸子代理那次的原始报错文本。
- `list_agents` 在探针前后的输出（证明没有孙代、没有新成员）。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- `workflow` 的逃逸口**不可安全观察**：真要验证就得让它开出孙代。按要求只记录 D5 + 代码位置，列为已知限制。
- 「下一层创建受限」只在 `subagent`/`subagent_fork` 路径上成立；把它写成"平台挡住一切下一层创建"是错的（D5 已更正）。

## 第 6 步 — `rt_conclude`：真实归档/封存/校验、任务 `completed`、审计 +1、校验失败不得完成

**目标**：证明收口不是"把任务标完成"，而是真的经项目 skill 归档、封存、跑检查后才完成任务；并且检查失败时**不**完成任务。

**本步覆盖的 A 编号**：`A15`、`A25`、`A26`、`A31`、`A44`

### 怎么做

1. 成员只提交**独立工作区**产物：`submission_ref` 必须落在 `re/team/work/<D>/<A>/` 内，并给出 `submission_sha256`。
2. `collect --out s6-before.json`。
3. 调 `rt_conclude`（带 `review.outcome`、`summary`、`reason`、`proposed_route_status`、`evidence_run_ids`、`anchor_refs`、`limitations`、`next_step`）。
4. `collect --out s6-after.json`，`diff`。
5. 再构造一次失败：把 `submission_sha256` 改错一位重投（新的 `operation_id`），或在路线记录里制造一处 skill 会判失败的状态。

### 看哪里

- `rt_conclude` 返回 `status=ok`，`data` 含 `phase="completed"`/`task_id`/`outcome`/`route_status`/`receipt_ref`/`checks[]`/`audit_written`。
- `team_task_list` 里该任务 `status=completed`（owner 保留）。
- `diff`：`re/team/receipts/<D>-<A>/` 新增文件、`re/team/audit.jsonl` 的 `lines` 增加（`collect` 的 `changed` 项会同时给出 `bytes`/`lines` 的前后值）、`re/routes/<R>.json` 的状态更新。
- 失败那次：`status=error`、`code=SUBMISSION_INVALID` 或 `CHECK_FAILED`，任务仍 `in_progress`，只有 `failed-<op>.json` 一类轨迹新增。

### 可观察断言

- [ ] 〔可观察〕A15 / 主路径：`rt_conclude` 成功后任务 `completed`，`data.receipt_ref` 指向 `re/team/receipts/<D>-<A>/` 下真实存在的文件，且 receipt 里 `submission.sha256` == 入参 `submission_sha256`。
- [ ] 〔可观察〕真实 skill 归档：receipt 的 `submission.archived_ref` 指向的正式副本存在，且其 SHA-256 与提交相同（`collect` 里能找到该路径）；不是"复制了个名字"。
- [ ] 〔可观察〕真实 skill 封存：若 `review.evidence_run_ids` 非空，`re/seals/runs/<RUN>.json` 出现（`collect` 的 `seals` 目标新增文件），receipt 的 `seals[]` 给出 `action`（如 `created`/`alreadySealed`）与 `path`；**不得**手工伪造 seal。
- [ ] 〔可观察〕真实 skill 校验：receipt 的 `checks[]` 每项有 `name`/`output_ref`/`exit_code`，成功路径全部 `exit_code === 0`；路线记录 `status` == `data.route_status`，`closure` 与 review 的判定相符（不能"任务完成、路线没动"）。
- [ ] 〔可观察〕审计多一条：`diff` 里 `re/team/audit.jsonl` 出现在 `changed` 且 `content_changed=true`、`lines` 递增；`data.audit_written === true`。
- [ ] 〔需构造〕校验失败不得完成：`submission_sha256` 改错 → `code=SUBMISSION_INVALID`（或 skill 侧走不动时 `CHECK_FAILED`），任务仍 `in_progress`、`re/routes` 未被改写、未新增成功回执。
- [ ] 〔需构造〕A15：`UNREVIEWED_COMPLETION` 补验路径——先让成员自己用 `team_task_update action=complete` 把任务标完成（owner 有权），Lead 再 `rt_conclude`：期望标记 `UNREVIEWED_COMPLETION` 并**照跑全部检查**；成功时**不**重复 complete（revision 不二次递增），失败时不得据此放开依赖。
- [ ] 〔需构造〕A26：校验后 task revision 改变 → `REVISION_CONFLICT` 且 `reason` 带实际 revision；构造方式是手工 `team_task_update` 改一次 revision（或另开一个成员任务）后再收口，期望拒绝而不是覆盖。
- [ ] 〔需构造〕A31：新会话打开同一项目 → `rt_roster` 报既有绑定/会话不匹配（`PROJECT_SESSION_MISMATCH`），变更被拒直到 `takeover`；接管后 `re/team/history/epoch-N/` 出现归档且旧 `binding.json` 不被删除。构造方式：开第二个一次性会话。
- [ ] 〔需构造〕A44：同一个不变缺口连续多轮只报首次/变化/恢复/用户动作，且可恢复（缺口消失后不再提示、不建后台监控）。构造方式：连续调两次 `rt_roster` 比对 `gaps` 文本，再补上缺的那项看提示是否消失。
- [ ] 〔不可观察〕A25：spawn/create/message/complete 成功但**响应丢失**（进程被杀、连接断）在本会话里无法可靠制造；记 not-run，并写明需要故障注入。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| 提交哈希不对/不在工作区 | `SUBMISSION_INVALID` | 任务不得完成 |
| skill 检查失败 | `CHECK_FAILED` | 不降门槛、不改序（D29） |
| 原生 complete 后补验 | `UNREVIEWED_COMPLETION` | 检查照跑 |
| task revision 变了 | `REVISION_CONFLICT` | 带实际 revision |
| 同会话换了又改 | `PROJECT_SESSION_MISMATCH` | 先 takeover |
| 回执写不成 | `partial` + `RECOVERY_REQUIRED` | 业务已成功但不得报 ok |

### 本步要贴的证据

- `rt_conclude` 的完整成功返回（含 `checks[]`）。
- `team_task_list`（完成后）+ `list_agents`。
- receipt 全文（`re/team/receipts/<D>-<A>/` 下的 JSON）。
- `s6-before.json` / `s6-after.json` / `diff`（审计 `lines` 与 `routes` 的变化就在里面）。
- 失败那次的完整返回 + `diff`（证明"只多了失败轨迹，没多成功回执"）。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- A25（响应丢失）与 A13（超时）都需要故障注入，一次性会话里做不可靠，只能记 not-run。
- `checks[]` 的具体 `name` 由项目 skill 决定，本地不同副本可能不同；判据是"每项都有退出码且成功路径全 0"，不是固定名字列表。

## 第 7 步 — `interrupt_agent` 与带 nonce 的唤醒

**目标**：证明中断只改状态、不释放席位与任务；再用带 nonce 的 `send_message` 唤醒，并证明成员真的收到（回报里出现 nonce）。

**本步覆盖的 A 编号**：`A34`

### 怎么做

1. 在任务开始后（成员 `status=running`）调 `interrupt_agent({target:"<成员名>"})`。
2. 立刻 `list_agents` + `team_task_list`，`collect --out s7-before.json`。
3. 生成一个 32 位十六进制 nonce，`send_message({target:"<成员名>", message:"唤醒探针 nonce=<nonce>；请原样回报该 nonce 与当前任务 id"})`。
4. 等成员回复（`wait_agent` 或直接读它发来的团队消息），记下回报原文。

### 看哪里

- `interrupt_agent` 返回 `{previousStatus}`，取值只能是 `running` 或 `inactive`（枚举外的值即失败）。
- `list_agents` 里该成员仍在名册（`status` 变 `inactive`），`role=teammate` 行数不变。
- 成员回报里出现 nonce 原文；`team_task_list` 的 `task_id`/`ownerName` 未被中断改写。

### 可观察断言

- [ ] 〔可观察〕`interrupt_agent` 返回 `previousStatus ∈ {running, inactive}`（D10：`provisioning`/`failed` 不可能出现）；调用者必须是 Lead，teammate 调用得到 `TEAM_LEAD_REQUIRED`。
- [ ] 〔可观察〕成员仍留在名册：`list_agents` 仍有该 `name`，`role=teammate` 计数不变（席位不因中断释放）。
- [ ] 〔可观察〕中断不释放任务：`team_task_list` 里该任务仍是原 `task_id`、`in_progress`、`ownerName` 不变；没有新的 attempt 被自动创建。
- [ ] 〔可观察〕带 nonce 的 `send_message` 投递成功，且**成员回报里出现该 nonce 原文**——这是"真的醒了"的唯一可观察判据（投递确认不等于它处理了）。
- [ ] 〔可观察〕A34：收尾停止条件可读——所有任务 `completed` 或已显式交接，Lead 不再新开路线；每轮先 `list_agents` + `team_task_list` 再决定动作（30 秒控制点回读），空闲等待是有界 `wait_agent` 而不是无限轮询。
- [ ] 〔不可观察〕A34 的"不承诺自动唤醒"是行为约束，不是单次调用能观察到的字段；只能以记录里"没有无限轮询/没有新开路线"的旁证支撑。

### 期望错误码

| 触发 | 期望 `code` / 状态 | 备注 |
|---|---|---|
| teammate 调 `interrupt_agent` | `TEAM_LEAD_REQUIRED` | 服务层拒绝 |
| 中断不存在/非 active 的成员 | `TEAM_MEMBER_NOT_FOUND` | 不是"已中断" |
| 唤醒消息超 65536 字节 | `TEAM_MESSAGE_TOO_LARGE` | 含信封前缀计量 |

### 本步要贴的证据

- `interrupt_agent` 的原始返回。
- 中断前后的 `list_agents` 与 `team_task_list`。
- `send_message` 的投递确认 + 成员回报原文（nonce 高亮）。
- `s7-before.json` 与它之后的 `diff`（证明中断本身没写项目文件）。

### 本步不可观察 / 有边界的项（记 `not-run`，不要编）

- `send_message` 的工具返回只是投递确认（不是对方的答复），所以 nonce 必须从**后续团队消息**里读到，不能从 `send_message` 的返回里读到。
- 中断与唤醒的时序受模型调度影响；记录里要写清两次调用之间的实际间隔，否则"它没回 nonce"无法归因。

## A 编号 → 步骤 → 可观察性

| A 编号 | 步骤 | 能否在本会话观察 |
|---|---|---|
| `A01` | 第 1 步 | 可观察（doctor 在普通 shell 跑） |
| `A02` | 第 1 步 | 部分：只能证明留下的是团队版，另一半已被 patch 删除 |
| `A03` | 第 5 步 | 可观察（真实 teammate 的原始返回 + 空 diff） |
| `A08` | 第 5 步 | 可观察（裸子代理与成员两种错误形状分开记） |
| `A10` | 第 3 步 | 可观察（契约 SHA-256 == `contract_sha256`；`started_at` 为 null） |
| `A11` | 第 4 步 | 可观察（成员数不变、`task_id` 变、`MEMBER_BUSY` + 空 diff） |
| `A12` | 第 3 步 | 需构造（撑爆消息 / 极小超时），否则 not-run |
| `A13` | 第 3 步 | 不可观察（成员自动起跑，造不出"不写 start.json"） |
| `A15` | 第 6 步 | 需构造（先让成员自己 complete 再收口） |
| `A22` | 第 4 步 | 需构造（要声明 `resource_needs`）；残留进程项 not-run |
| `A25` | 第 6 步 | 不可观察（要故障注入：响应丢失） |
| `A26` | 第 6 步 | 需构造（手工改 revision 后收口） |
| `A31` | 第 6 步 | 需构造（开第二个会话做 takeover） |
| `A34` | 第 7 步 | 部分：停止条件与有界等待可读，"不承诺自动唤醒"只能旁证 |
| `A38` | 第 1 步 | 部分：只报 discovered/unknown 可观察；另一客户端工具表需构造 |
| `A40` | 第 2 步 | 可观察（`project_id` 由根决定、`session_id` 是本会话）＋需构造（换执行者） |
| `A44` | 第 6 步 | 需构造（连续两次 `rt_roster` 比对去重） |

## 全表判定怎么写

- 每步只允许三种判定：`pass`（本步所有〔可观察〕断言都有原文证据）、`fail`（任一条断言与期望不符，写清第几条）、`not-run`（没执行或只执行了部分，写清缺什么）。
- 〔需构造〕断言没构造就是 `not-run`，不能算 `pass`。
- 〔不可观察〕断言永远不进 `pass`；它们进 `docs/verify/acceptance-status.md` 的 `not-run` 并附原因。

## 跑完要交的东西

1. 填好的记录（从 `l3-record-template.md` 复制），命名 `<YYYYMMDD>-<会话 id 前 8 位>.md`，放在 `docs/verify/records/`。
2. 每一步的 `collect` JSON + `diff` JSON，放在 `docs/verify/records/<同名>/`，并在记录里写出每个文件的 SHA-256。
3. 一条结论：整层 `pass` / `fail` / `not-run`，以及**没有覆盖到的 A 编号**。

