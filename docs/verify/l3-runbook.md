# L3 执行 runbook（一次性会话，复制粘贴即可）

> 配套文件：`l3-checklist.md`（判据，54 条断言）、`l3-record-template.md`（记录模板）、`scripts/l3-verify.mjs`（取证）。
> 本文件解决两件事：**正确的执行顺序**，以及**怎样让会话里的 agent 自己跑完而不用自评通过**。

## 0. 已经准备好的东西（换机器要重做）

| 项 | 位置 / 值 |
|---|---|
| bundle 已装进 profile | `dependencies` 与 `dsh.profile.bundles` 都含 `@local/dsh-redteam-lead`；`node_modules/@local/dsh-redteam-lead` 是指向仓库的 junction |
| 团队 profile bundle | 已在 `bundles` 里（前置条件，无需改动） |
| 临时分析项目 | `D:\workSpace\_l3-verify\proj`（`project.py init` + 真实 skill **项目副本**，含 `references/team-coordination.md`） |
| 证据目录 | `D:\workSpace\_l3-verify\evidence\` |
| doctor 基线 | `configuration_ready: true`、`runtime_ready: "unknown"`、退出码 0 —— 三项 bundle 检查全 `true` |

**换机器必须重做**：装包（`link:` + `bundles` 两处都要）、临时项目。装完先跑 doctor，`configuration_ready` 必须是 `true` 再往下。

## 1. 执行顺序：**不是 1→2→3→4→5→6→7**

规格的第四步写"先完成同岗首个任务的验收，再派下一任务"，而"完成验收"正是第六步的内容（`rt_conclude` 走完归档/seal/index/check 才能 `complete`）。所以第四步依赖第六步。

**正确顺序：`1 → 2 → 3 → 6 → 4 → 5 → 7`**

| 序 | 步 | 为什么排这里 |
|---|---|---|
| 1 | 1 安装/工具面/doctor | 先证明工具在位 |
| 2 | 2 `rt_roster` | 只读，零副作用，先确认兼容性与缺口 |
| 3 | 3 首次 `rt_dispatch` | 需要路线已存在 |
| 4 | 6 `rt_conclude` 收口 #1 | 让成员回到空闲，第四步才有"复用"可言 |
| 5 | 4 第二次派发 → 复用 | 依赖上一步 |
| 6 | 5 teammate 越权 | 需要会话里已有一个真实 teammate |
| 7 | 7 interrupt + nonce 唤醒 | 放最后，因为中断会影响后续步骤 |

### 省力技巧：任务 #1 用 `blocked` 收口

第四步验的是**席位复用**，不是分析质量。所以让任务 #1 的工兵交一个 `blocked` 结果（"缺某工具/入口"），`rt_conclude` 用 `outcome = "blocked"`、`run_ids: []`：

- 收口路径照样完整走（写记录 → `impact` → `index` → `check --hashes`），能验到第六步的机制；
- 但**不需要真跑实验、不需要封存**，省掉最容易卡住的一段。

真实 `seal` + `check --hashes` 的那条，用第六步第二次收口做：交一个 `finding`，带一个真 RUN 和 `artifact_locator` 锚点。

## 2. 粘进新会话的驱动提示词

下面这段**整段复制**粘进新会话即可（已改成代码块，复制不会带 `>` 前缀）。

```text
你负责执行 L3 真服务验收并取证。你没有判定权：不要写 pass/fail，不要给自己打分，只执行 + 落证据 + 原样贴原始返回。发现异常就停在原地报回来。

【环境】
- 临时分析项目根：D:\workSpace\_l3-verify\proj
- 证据目录：D:\workSpace\_l3-verify\evidence
- 取证脚本：D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead\scripts\l3-verify.mjs
- 判据清单：D:\workSpace\_l3-verify\l3-checklist.md（先读它）

【硬约束】
1. 只用非可执行测试数据；不要执行任何样本、不要联网、不要跑 workflow（它会绕过 depth 限制并烧掉 activation 名额）。
2. 每一步开始前 collect --out sN-before.json，结束后 collect --out sN-after.json 再 diff，三个文件都留在证据目录。
3. 每次工具调用的返回整段原文存成 evidence\sN-<tool>.json，不要在回复里改写成摘要。
4. 某步失败：立即停止，保存当时的完整信封与 diagnostics[]、before/after/diff、doctor 输出，然后报回来。不要重跑同一会话。

【执行顺序】严格按 1 → 2 → 3 → 6 → 4 → 5 → 7，不是按编号顺序。
（原因：第 4 步要求"先完成同岗首个任务的验收"，而验收是第 6 步的内容，所以第 4 步依赖第 6 步。）

- 步 1：先调 rt_roster 但不传 target_kinds，贴完整返回（应只做环境检查、不提议班底）。再跑
  node D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead\bin\doctor.mjs --profile C:\Users\Administrator\.dsh\profiles\desktop --project D:\workSpace\_l3-verify\proj
  贴 stdout 与退出码。用 list_agents 与 team_task_list 的原始输出证明九个团队工具在位；同名工具用入参形状区分（团队版 send_message 收 {target}，另一版收 {agent_id}）。
- 步 2：rt_roster（action="inspect"，target_kinds=["binary"]），把 compatibility、每个岗位的 required、gaps、proposal_hash 原样贴出。
- 步 3：先按项目 skill 在临时项目里建一条可执行路线：re/targets.json 加一个目标（用非可执行测试文件即可），re/routes/R-001.json 用 status: "active" 并声明该目标。然后 rt_dispatch（post_id="triage"、route_id="R-001"、target_ids=[该目标]、objective、evidence_required=["artifact_locator"]、prohibited=[]）。断言：phase="delivered"、task 为 in_progress、owner 正确、started_at=null、re/team/dispatches/*.json 存在且含真实目标哈希与 rule_digest。同时确认工兵没有在收到信封之前就开始跑实验。
- 步 6（先做 #1 的收口）：等工兵交回 re/team/work/<dispatch>/<attempt>/submission.json，用 outcome="blocked"、run_ids: [] 调 rt_conclude。贴完整返回（含 checks[]、audit_written）、re/routes/R-001.json、re/team/audit.jsonl 末尾两行、以及 task 是否变成 completed。
- 步 4：对同一岗位再 rt_dispatch 一次（新的 operation_id）。断言：list_agents 里成员数不变（不应出现 rt-triage-2）、task_id 变了、工兵收到的是新契约（新 dispatch/attempt、新 contract_sha256）。然后趁 #2 还在执行时再派第三次，记录被拒的错误码（应为 MEMBER_BUSY）。
- 步 5：把 rt_dispatch 与 rt_conclude 的调用交给真实的 teammate 去做（用 send_message 指示它调用），贴它的拒绝返回（应 ROLE_REQUIRED），并用 collect 的 digest 前后一致证明零副作用。另让该 teammate 尝试创建下一层 agent（subagent / subagent_fork），区分"工具不存在"与"depth 拒绝"。不要用裸子代理代替这一步。
- 步 7：对某个 teammate 调 interrupt_agent，贴 previousStatus（只能是 running 或 inactive）；确认它仍在 list_agents 里；再用带 nonce 的 send_message 唤醒，确认回报里出现该 nonce。记录两次调用之间的时间间隔（没回 nonce 可能只是还没处理）。
- 步 6 的第二轮（真实封存）：另派一个任务，工兵交回 finding，带一个真 RUN、一个已保存产物和一个 artifact_locator 锚点（锚点必须指向该 RUN 的 artifacts）。rt_conclude 后确认 seal 恰好调用一次、index 在 check 之前、task 变为 completed。然后构造一次校验失败（例如收口前手工改掉已封存产物的字节），确认任务没有被 complete，且返回 CHECK_FAILED 或 BASELINE_MISMATCH。

【跑完报回来】七步各自的原始返回文件清单、每步 before/after/diff 的摘要、以及你观察到的异常（只描述事实，不做判定）。
```

## 3. 判据（由**另一个** agent 或人做，不由执行的 agent 做）

执行者交回后，判定者按 `l3-checklist.md` 逐条对照。重点确认这些**不可伪造**的观察：

| 断言 | 不可伪造的证据 |
|---|---|
| 零副作用（步 1/2/5） | 两次 `collect` 的 `digest` 相同 |
| 复用而非重建（步 4） | `list_agents` 成员集合不变 + `task_id` 变化 + 新 `contract_sha256` |
| 繁忙拒绝（步 4） | 错误码 `MEMBER_BUSY` 且 `collect` 前后 `digest` 不变 |
| 越权拒绝（步 5） | `ROLE_REQUIRED` + `digest` 不变；且调用者是**真实 teammate** |
| 一次性封存（步 6） | `re/seals/**` 中该 RUN 只有一个文件；第二次收口不新增 seal |
| 校验失败不得完成（步 6） | task 仍是 `in_progress`，且 `re/team/receipts/**` 有失败回执 |
| 中断不改身份（步 7） | `previousStatus ∈ {running, inactive}`，`list_agents` 仍有该成员 |

**假 `pass` 是本层最严重的问题。** 没有证据就写 `not-run` 并写明缺什么——`acceptance-status.md` 的规则是「`pass` 必须能在矩阵要求的层上复跑」。

## 4. 已声明不可观察的（照实记 `not-run`，别硬造）

1. `workflow` 不受 depth 限制（DECISIONS D5）—— 验证它要真开出孙代，会烧 activation；只作已知限制。
2. activation 占用无宿主查询 —— `remaining_activations` 只能是声明值 + `ACTIVATION_USAGE_UNOBSERVED` gap。
3. 同名工具无对照组 —— 本 preset 已删掉那两个冲突行，只能旁证"留下的那个是团队版"。
4. 故障注入做不了 —— A25（响应丢失）、A13（不写 `start.json` 的超时）在一次性会话里不可靠复现。
5. `send_message` 返回只是投递确认 —— nonce 必须从**后续**团队消息里读到。

## 5. 归档与回滚

归档：按 `l3-record-template.md` 命名 `docs/verify/records/<YYYYMMDD>-<session前8位>.md`，证据文件放同名目录，附「文件名 + 字节数 + SHA-256」清单；七步**每步都有结论**才把整层判 `pass`（部分执行照样归档，结论写 `not-run` / `fail`）。

回滚：

```powershell
# 1) profile package.json：dsh.profile.bundles 与 dependencies 里各删掉 "@local/dsh-redteam-lead"
# 2) Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-redteam-lead" -Force
# 3) 重启 DSH
```

临时项目与证据目录直接删。本插件不写项目之外的全局状态。
