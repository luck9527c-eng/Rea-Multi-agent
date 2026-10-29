# 第三层验收记录 — `<YYYYMMDD>-<session_id 前 8 位>`

> 这是**模板**。复制成 `docs/verify/records/<YYYYMMDD>-<session_id 前 8 位>.md` 再填。
> 规则只有一条：**贴原文，不要复述**。工具返回整段贴，项目侧哈希用 `collect` 的输出，
> 判定只允许 `pass` / `fail` / `not-run`。没有证据的项写 `not-run`，不要写"看起来正常"。
>
> 判据来源：`docs/verify/l3-checklist.md`（由 `scripts/l3-verify.mjs checklist` 生成，七步 × 54 条断言）。

## 1. 元信息

| 字段 | 值 |
|---|---|
| 执行日期（本地时区） | `<YYYY-MM-DD HH:mm +08:00>` |
| 执行人 | `<姓名/账号>` |
| 机器 | `<主机名 / Windows 版本>` |
| 仓库 commit | `<git rev-parse HEAD>` |
| 本 bundle 版本 | `<package.json version>` |
| DSH 运行时版本 | `<runtime.json 的版本，例如 0.2.1-rc.3>` |
| profile 根 | `<%USERPROFILE%\.dsh\profiles\<name>>` |
| 会话 id（`rt_roster.data.session_id`） | `<...>` |
| 团队 id（`rt_roster.data.team_id`） | `<...>` |
| 项目 id（`rt_roster.data.project_id`） | `<...>` |
| 临时项目根 | `<绝对路径>` |
| 证据目录 | `<绝对路径，必须在项目之外>` |
| 会话是否一次性（未复用于其他工作） | `<是/否>` |

## 2. 前置条件核对

| # | 前置 | 判据 | 结论 |
|---|---|---|---|
| 1 | 团队 profile bundle 已启用 | `doctor.data.profile.team_profile_enabled === true` | `<pass/fail>` |
| 2 | 本 bundle 已 `link:` 安装并列进 `dsh.profile.bundles` | `bundle_listed` / `bundle_declared` / `bundle_linked` 三项均 `true` | `<pass/fail>` |
| 3 | 临时项目已接项目 skill（含团队规则段 + `project.py`） | `doctor.data.project.skill_copy_present/team_rules_present/project_py_present` 均 `true` | `<pass/fail>` |
| 4 | Python 可达 | `doctor.data.project.python.ok === true`，附 `version` | `<pass/fail>` |
| 5 | 证据目录在项目之外 | `collect` 未报 "--out 不能落在 --project 之内" | `<pass/fail>` |

### 2.1 `bin/doctor.mjs` 原始输出（A01）

命令：

```powershell
node <仓库根>\packages\dsh-redteam-lead\bin\doctor.mjs --profile <profile 根> --project <项目根>
```

退出码：`<0/1>`

```json
<整段 stdout 原样粘贴；不要省略 diagnostics[]>
```

## 3. 会话起始快照

`list_agents` 原始返回（会话刚开、未派发时）：

```json
<整段粘贴>
```

`team_task_list` 原始返回：

```json
<整段粘贴>
```

## 4. 七步

> 每步都要贴：① 实际调用（工具名 + 完整入参）② 工具返回的整段 JSON ③ `sN-before.json` /
> `sN-after.json` / `sN-diff.json` 三个文件路径与它们的 SHA-256 ④ 对照 `l3-checklist.md` 第 N 步的
> 逐条结果 ⑤ 本步判定。
>
> 判定只写一种：`pass`（该步所有〔可观察〕断言都有原文证据）/ `fail`（写清第几条断言、期望值、实测值）/
> `not-run`（写清缺什么）。〔需构造〕项没构造就是 `not-run`；〔不可观察〕项永远不写 `pass`。

### 第 1 步 — 安装、会话、工具面（含同名工具归属与 doctor）

**① 调用与入参**

```text
<例如：send_message({target:"nobody-xyz",message:"probe"})>
<例如：interrupt_agent({agent_id:"nobody-xyz"})>
```

**② 原始返回**

```json
<四条探针的原始返回 / 报错文本，逐条贴>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| collect before | `<证据目录>\s1-before.json` | `<n>` | `<sha256>` |
| collect after | `<证据目录>\s1-after.json` | `<n>` | `<sha256>` |
| diff | `<证据目录>\s1-diff.json` | `<n>` | `<sha256>` |

`collect` 的 `digest`：before=`<...>` after=`<...>`（相同 = 本步零副作用）

**④ 断言逐条**

| 断言（`l3-checklist.md` 第 1 步） | 结论 | 证据/实测 |
|---|---|---|
| `list_agents` 有 Lead 伪行 | `<pass/fail>` | `<...>` |
| 三个 rt 工具参数面一致（少传必填 → `INVALID_ARGUMENT`） | `<pass/fail>` | `<...>` |
| `send_message` 用 `target` 命中 `TEAM_MEMBER_NOT_FOUND`；用 `agent_id` 被参数校验拒绝 | `<pass/fail>` | `<...>` |
| `interrupt_agent` 同上两条 | `<pass/fail>` | `<...>` |
| 团队工具按成员身份注册（`team_task_list` 可用） | `<pass/fail>` | `<...>` |
| A01：doctor 可达、`runtime_ready === "unknown"`、诊断带 `next_step` | `<pass/fail>` | 见 §2.1 |
| A38：`re/env/tools.json` 缺失时只报 unknown，未被自动生成 | `<pass/fail/not-run>` | `<...>` |
| A38：另一客户端工具表不替代 DSH | `<需构造 → pass/fail/not-run>` | `<...>` |

**⑤ 本步判定**：`<pass/fail/not-run>` — `<一句话理由>`

---

### 第 2 步 — `rt_roster`：兼容性 / 岗位需求 / 缺口 / 预算

**① 调用与入参**（至少两组入参，证明"岗位数随目标与预算变化"）

```text
<rt_roster({project_root:"…",action:"inspect",target_kinds:["webapp"],max_posts:6})>
<rt_roster({project_root:"…",action:"inspect",target_kinds:["game","webapp"],max_posts:4})>
```

**② 原始返回**

```json
<两次完整返回；保留 compatibility / posts / gaps / capacity / proposal_hash>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s2-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s2-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s2-diff.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/capacity.json`（若创建） | `<...>` | `<n>` | `<sha256>` |

`digest`：before=`<...>` after=`<...>`（inspect 不得改变 digest）

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| 兼容性有明确判定（缺团队规则 → `SKILL_INCOMPATIBLE`） | `<pass/fail>` | `<...>` |
| 每个可用岗位 `required` 非空、disabled 岗不出现 | `<pass/fail>` | `<...>` |
| 缺口与当前能力相符（`CAPABILITY_MISSING` 点名能力族） | `<pass/fail>` | `<...>` |
| 岗位数随 `target_kinds`/预算变化且稳定 | `<pass/fail>` | `<...>` |
| A09：无声明时 `remaining_*` 为 `null` + `CAPACITY_UNKNOWN`，无常数兜底 | `<pass/fail>` | `<...>` |
| A09：声明后余额可读 + `ACTIVATION_USAGE_UNOBSERVED` gap | `<pass/fail>` | `<...>` |
| inspect 零副作用（digest 不变、无 binding 新增） | `<pass/fail>` | `<...>` |
| A40：`project_id` 由根决定、`session_id` 是本会话 | `<pass/fail>` | `<...>` |
| A40：换执行者后重算 | `<需构造 → pass/fail/not-run>` | `<...>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

---

### 第 3 步 — 首次 `rt_dispatch`

**① 调用与入参**

```text
<rt_dispatch({project_root,operation_id,post_id,route_id,target_ids,objective,evidence_required,prohibited,…})>
```

**② 原始返回**

```json
<完整 envelope；保留 dispatch_id/attempt_id/task_id/member/route_id/revision/phase/contract_ref/contract_sha256/work_dir/started_at>
```

派发后立即取的 `list_agents` 与 `team_task_list`：

```json
<两份原始返回>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s3-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s3-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s3-diff.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/dispatches/<D>.json` | `<...>` | `<n>` | `<sha256>`（必须 == `contract_sha256`） |
| `re/routes/<R>.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/attempts/<D>.<A>.json` | `<...>` | `<n>` | `<sha256>` |

契约正文前 40 行（证明是完整契约、不是摘要）：

```json
<粘贴>
```

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| A10：`role=teammate` + 任务 `in_progress` + owner 正确 | `<pass/fail>` | `<...>` |
| A10：契约 SHA-256 == `contract_sha256`；身份四元组一致 | `<pass/fail>` | `<...>` |
| A10：`started_at` 为 `null`、无提前实验 | `<pass/fail>` | `<...>` |
| 契约写明派发权边界 + `prohibited` 原样落盘 | `<pass/fail>` | `<...>` |
| A12：消息层失败返回 `partial` 且重投不重复启动 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A12：超长消息被拒（`DELIVERY_FAILED`） | `<需构造 → pass/fail/not-run>` | `<...>` |
| A13：无 `start.json` 超时 | `<不可观察 → not-run>` | `<原因>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

---

### 第 4 步 — 同岗第二个任务

**① 调用与入参**

```text
<第二次 rt_dispatch，同一 post_id、新 operation_id>
<忙碌重派：第三个 operation_id，第二个任务仍 in_progress>
```

**② 原始返回**

```json
<两次返回；`task_id`/`contract_ref`/`contract_sha256`/`work_dir` 并排能看出变化>
<忙碌重派：status=blocked + code=MEMBER_BUSY 的完整 envelope>
```

两次 `list_agents` 与 `team_task_list`：

```json
<原始返回；证明 teammate 行数不变、旧任务仍 completed>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s4-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s4-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s4-diff.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/dispatches/<D2>.json` | `<...>` | `<n>` | `<sha256>` |
| 忙碌重派那次 `diff`（必须零变化） | `<...>` | `<n>` | `<sha256>` |

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| A11：成员数不变（复用同一成员） | `<pass/fail>` | `<...>` |
| A11：新 `task_id`，旧任务仍 `completed` 且保留 owner | `<pass/fail>` | `<...>` |
| A11：新契约完整且 SHA-256 不同、`work_dir` 换新 | `<pass/fail>` | `<...>` |
| A11：忙碌重派 `MEMBER_BUSY` + 零副作用 | `<pass/fail>` | `<...>` |
| A22：资源物理身份互斥 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A22：残留进程不重分配 | `<不可观察 → not-run>` | `<原因>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

---

### 第 5 步 — teammate 越权 + 下一层创建

**① 怎么让成员做探针**（`send_message` 的原文，或派给它的只读探针任务）

```text
<粘贴>
```

**② 成员回传的原始工具返回**（不要复述）

```json
<rt_dispatch → ROLE_REQUIRED>
<rt_conclude → ROLE_REQUIRED>
<rt_roster action=bind → ROLE_REQUIRED>
<subagent({prompt:"probe"}) → depth 拒绝原文>
```

裸子代理那次（Lead 用 `subagent` 开的）：

```json
<原始报错：工具不存在 还是 TEAM_SERVICE_UNAVAILABLE？两者分开记>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s5-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s5-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s5-diff.json`（必须零变化） | `<...>` | `<n>` | `<sha256>` |

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| A03：teammate 调 `rt_dispatch` → `ROLE_REQUIRED` + 空 diff | `<pass/fail>` | `<...>` |
| A03：teammate 调 `rt_conclude` → `ROLE_REQUIRED`，任务仍 `in_progress` | `<pass/fail>` | `<...>` |
| A03：inspect 允许、bind/takeover 被拒 | `<pass/fail>` | `<...>` |
| `subagent`/`subagent_fork` 被 depth 挡住且无孙代 | `<pass/fail>` | `<...>` |
| A08：裸子代理的两种错误形状分开记录 | `<pass/fail>` | `<...>` |
| `workflow` 不受 depth 限制（D5） | `<不可观察 → not-run>` | `<原因：会真开孙代>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

---

### 第 6 步 — `rt_conclude`

**① 调用与入参**（成功一次 + 失败一次）

```text
<成功：rt_conclude({project_root,operation_id,dispatch_id,attempt_id,task_id,expected_revision,submission_ref,submission_sha256,review:{…}})>
<失败：把 submission_sha256 改错一位，新 operation_id>
```

**② 原始返回**

```json
<成功 envelope 全文（含 checks[]/audit_written/phase/route_status/receipt_ref）>
<失败 envelope 全文（code=SUBMISSION_INVALID 或 CHECK_FAILED）>
```

收口后的 `list_agents` / `team_task_list`：

```json
<原始返回；任务 completed、owner 保留>
```

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s6-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s6-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s6-diff.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/receipts/<D>-<A>/*.json` | `<...>` | `<n>` | `<sha256>` |
| `re/team/audit.jsonl`（before → after） | `<...>` | `<n1> → <n2>` | `<sha1> → <sha2>` |
| `re/seals/runs/<RUN>.json`（若有） | `<...>` | `<n>` | `<sha256>` |
| `re/routes/<R>.json`（after） | `<...>` | `<n>` | `<sha256>` |

审计行数（`collect` 里 `lines` 字段）：before=`<n>`，after=`<n>`，**差值必须是本步新增的审计条数**。

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| 成功路径任务 `completed`，receipt 存在且 `submission.sha256` 相符 | `<pass/fail>` | `<...>` |
| 真实 skill 归档：`archived_ref` 指向的副本存在且哈希相同 | `<pass/fail>` | `<...>` |
| 真实 skill 封存：`seals[]` 的 `action`/`path` 可读（若有 run_ids） | `<pass/fail/not-run>` | `<...>` |
| 真实 skill 校验：`checks[].exit_code` 全 0；路线 `status` 相符 | `<pass/fail>` | `<...>` |
| 审计多一条：`audit.jsonl` 在 changed 且 `lines` 递增、`audit_written=true` | `<pass/fail>` | `<...>` |
| 校验失败不得完成 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A15：`UNREVIEWED_COMPLETION` 补验 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A26：`REVISION_CONFLICT` 带实际 revision | `<需构造 → pass/fail/not-run>` | `<...>` |
| A31：新会话打开旧项目的接管 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A44：同缺口连续多轮的去重/恢复 | `<需构造 → pass/fail/not-run>` | `<...>` |
| A25：响应丢失 | `<不可观察 → not-run>` | `<原因：需故障注入>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

---

### 第 7 步 — `interrupt_agent` 与 nonce 唤醒

**① 调用与入参**

```text
<interrupt_agent({target:"<成员名>"})>
<send_message({target:"<成员名>", message:"唤醒探针 nonce=<32 位十六进制>"})>
```

nonce 原文：`<32 hex>`

**② 原始返回**

```json
<interrupt_agent 返回：previousStatus ∈ {running,inactive}>
<send_message 的投递确认>
```

中断前后 `list_agents` + `team_task_list`：

```json
<原始返回；成员仍在名册、任务 task_id/owner 未变>
```

成员回报原文（nonce 必须在这里出现）：

```text
<粘贴成员发来的团队消息；nonce 出现的位置要能一眼看到>
```

两次调用之间的间隔：`<秒>`（等待方式：`wait_agent` / 直接读消息）

**③ 项目侧证据**

| 文件 | 路径 | bytes | SHA-256 |
|---|---|---|---|
| `s7-before.json` | `<...>` | `<n>` | `<sha256>` |
| `s7-after.json` | `<...>` | `<n>` | `<sha256>` |
| `s7-diff.json`（中断本身不应写项目） | `<...>` | `<n>` | `<sha256>` |

**④ 断言逐条**

| 断言 | 结论 | 证据/实测 |
|---|---|---|
| `previousStatus ∈ {running, inactive}` | `<pass/fail>` | `<...>` |
| 成员仍在名册、teammate 计数不变 | `<pass/fail>` | `<...>` |
| 中断不释放任务（`task_id`/`in_progress`/owner 不变） | `<pass/fail>` | `<...>` |
| 带 nonce 的 `send_message` 投递且回报里出现 nonce | `<pass/fail>` | `<...>` |
| A34：停止条件与 30 秒控制点回读、有界等待 | `<pass/fail>` | `<...>` |
| A34：不承诺自动唤醒 | `<不可观察 → not-run>` | `<原因>` |

**⑤ 本步判定**：`<pass/fail/not-run>`

## 5. A 编号覆盖

| A 编号 | 步骤 | 本记录结论 | 证据位置 |
|---|---|---|---|
| `A01` | 1 | `<pass/fail/not-run>` | `<§2.1>` |
| `A02` | 1 | `<...>` | `<...>` |
| `A03` | 5 | `<...>` | `<...>` |
| `A08` | 5 | `<...>` | `<...>` |
| `A09` | 2 | `<...>` | `<...>` |
| `A10` | 3 | `<...>` | `<...>` |
| `A11` | 4 | `<...>` | `<...>` |
| `A12` | 3 | `<...>` | `<...>` |
| `A13` | 3 | `not-run`（不可观察） | `<原因>` |
| `A15` | 6 | `<...>` | `<...>` |
| `A22` | 4 | `<...>` | `<...>` |
| `A25` | 6 | `not-run`（不可观察） | `<原因>` |
| `A26` | 6 | `<...>` | `<...>` |
| `A31` | 6 | `<...>` | `<...>` |
| `A34` | 7 | `<...>` | `<...>` |
| `A38` | 1 | `<...>` | `<...>` |
| `A40` | 2 | `<...>` | `<...>` |
| `A44` | 6 | `<...>` | `<...>` |

## 6. 附件清单

> 证据文件自身的哈希（项目侧文件的哈希在 `collect` 里，这里不重复）。用
> `Get-FileHash <文件> -Algorithm SHA256` 生成。

| 文件（相对 `docs/verify/records/<同名>/`） | bytes | SHA-256 |
|---|---|---|
| `s1-before.json` | `<n>` | `<sha256>` |
| `s1-diff.json` | `<n>` | `<sha256>` |
| `<…每个 collect/diff 都列一遍…>` | `<n>` | `<sha256>` |
| `doctor.json` | `<n>` | `<sha256>` |

## 7. 结论

| 项 | 值 |
|---|---|
| 整层判定 | `<pass / fail / not-run>` |
| 通过的步骤 | `<1,2,…>` |
| 失败的步骤（第一个失败最要紧） | `<n：第几条断言>` |
| 未执行的步骤 | `<n：缺什么>` |
| 未覆盖的 A 编号 | `<A13, A25, …>` |
| 记录是否包含全部原始返回 | `<是/否>` |

一句话结论：

```text
<例如：七步中 1–6 通过、第 7 步 not-run（会话在唤醒前结束）；A13/A25 不可观察，见未覆盖清单。>
```

## 8. 失败时的最小复现（仅 `fail` 时填）

- 失败步骤 / 断言编号：`<...>`
- 期望值：`<...>`
- 实测值：`<...>`
- 项目初始状态（哪些文件本来存在）：`<...>`
- 会话 id / `operation_id` / 第几次调用：`<...>`
- 复现所需的最小步骤：`<...>`
- 是否已在新会话重试：`<否 / 是，见 <文件>>`
