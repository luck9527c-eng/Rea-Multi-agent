# 验收总表（`acceptance-status.md`）

> 覆盖 [`docs/specs/acceptance-matrix.md`](../specs/acceptance-matrix.md) 的 **A01–A44 全部 44 行**，
> 以及该文件「## 规格静态验证」列出的每一类静态检查。
>
> 状态只允许四个值：`pass` / `fail` / `not-run` / `out-of-scope`。**没有占位"通过"**：
> 每条 `pass` 都能点到一个 `node --test` 用例名（门禁里就在跑），或 `docs/verify/` 下的一份记录。
>
> 本表由 T10 汇总；T9 建的空壳（只列 18 条 L3 行）已被本表取代。第三层验收**一次都没有执行过**，
> 所以本表里没有任何 L3 判定，也没有任何 `docs/verify/records/` 记录。

## 判定规则（先读）

| 状态 | 含义 |
|---|---|
| `pass` | 该行要求的观察有**可复跑的自动用例**证明。`层`列给出规格要求的层；`证据`列注明证据来自哪一层。 |
| `not-run` | 需要真实 DSH 团队会话（L3）或故障注入才能判定，且**尚未执行**。`备注`写清缺什么。 |
| `out-of-scope` | 该行要求的观察**全部**落在规格明确划给 skill 工作流/平台的部分，插件侧没有可执行实现；`备注`附出处。 |
| `fail` | 实现或证据明确不成立。**当前没有 `fail` 行。** |

- **凡是 `层` 含 L3 的行一律 `not-run`**（T9 的结论：第三层从未执行）。这些行的 L1/L2 半已经通过的，
  在 `备注` 里给出用例名——但整行不因此判 `pass`。这正是"不拿自动化冒充真会话"的口径。
  **唯一例外是 A39**：规格把它的四条观察全部放在 L1（能力匹配不需要会话），T9 的 18 行待执行清单也没把它
  算进去，所以判 `pass`，L3 半未执行写在备注里。
- **门禁命令**（本表所有 `pass` 都能被它复跑，在仓库根执行）：
  `npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"`
  当前结果：**543 用例 / 543 pass / 0 fail / 0 skipped**（含本表自身的文档契约用例
  [acceptance-status.test.mjs](../../packages/dsh-redteam-lead/test/acceptance-status.test.mjs)）。
- 用例名与文件路径都相对于 `packages/dsh-redteam-lead/test/`；测试跑的是 **`dist/` 里的发货字节**。

## 分布

| 状态 | 行数 | 编号 |
|---|---|---|
| `pass` | **24** | A04、A05、A06、A07、A14、A16、A17、A18、A19、A20、A21、A23、A24、A27、A28、A29、A30、A32、A33、A35、A36、A39、A41、A42 |
| `not-run` | **19** | A01、A02、A03、A08、A09、A10、A11、A12、A13、A15、A22、A25、A26、A31、A34、A38、A40、A43、A44 |
| `out-of-scope` | **1** | A37 |
| `fail` | **0** | — |
| 合计 | **44** | A01–A44 |

- `not-run` 的 19 行里，**18 行是 L3 会话项**（A01、A02、A03、A08、A09、A10、A11、A12、A13、A15、A22、
  A25、A26、A31、A34、A38、A40、A44），**1 行是 L1/L2 缺口**（A43：工具清单刷新后的"旧契约不变 / 新派发复验"
  没有自动化用例）。
- A39 的 `层` 也含 L3，但它的四条观察全部由 L1 的能力匹配用例覆盖（不需要会话），因此判 `pass`，
  L3 半未执行的事实写在 `备注` 里。

## A01–A44 逐条

| 编号 | 层 | 状态 | 证据位置 | 备注 |
|---|---|---|---|---|
| A01 | L1/L3 | `not-run` | L1 半：[doctor.test.mjs](../../packages/dsh-redteam-lead/test/doctor.test.mjs)「健康 profile/项目：configuration_ready、runtime_ready=unknown、退出码 0」等 11 例 | L1 半已通过（离线 doctor 可达、给修复路径、不假报 runtime）。缺 L3：「未注册工具不是唯一入口」要在真实会话里观察，会话未启动。 |
| A02 | L3 | `not-run` | — | 需真实会话：同名对照组（`tool-subagent-control` / `list-agents`）已被 patch 删除，只能证明"留下的是团队版"。清单第 1 步。 |
| A03 | L1/L3 | `not-run` | L1 半：[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 允许真实 teammate；裸子代理被拒且零副作用」「inspect 作为 Lead：给出可核对提议，且不创建成员/任务、不写 binding 与 roster」 | 缺 L3：真实 teammate 的原始返回 + 身份拒绝时的空 `collect` diff。清单第 5 步。 |
| A04 | L1/L2 | `pass` | [roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 作为 Lead：给出可核对提议，且不创建成员/任务、不写 binding 与 roster」「bind：proposal_hash 匹配时写 binding + roster，成员仍为 0，INDEX 有指针」「bind 拒绝篡改/过期的 proposal_hash，并且不写盘」「bind 用别的 target_kinds 的旧提议 → 拒绝且不写盘」「bind 重放同一 operation_id：返回原结果 replayed=true，不重复追加历史/审计」「bind 在锁内重读宿主计数：容量在 inspect 之后变紧 → blocked 且不写 binding」 | inspect 不落盘、bind 不建成员、重放不重复历史、过期提议不超配，四条都有断言（L1）。 |
| A05 | L1/L2 | `pass` | [l2/compat.test.mjs](../../packages/dsh-redteam-lead/test/l2/compat.test.mjs) 7 例（含「非默认布局：probe 分类布局、给出 blocking 缺口与可读下一步，且不静默另建 re/（A05）」「旧副本缺团队规则：blocking 缺口 + 具体下一步，且不覆盖副本/INDEX/历史（A05 / D8）」「缺 Python：PYTHON_MISSING（blocking）点名解释器…」）；[project-adapter.test.mjs](../../packages/dsh-redteam-lead/test/project-adapter.test.mjs)「probe：缺团队规则/缺 INDEX/缺 Python 各自给出具体 gap 与下一步」 | 缺配置 / 缺 Python / 旧副本无团队规则 / 非默认布局四类缺口都报实际差异；不重 init、不覆盖副本/INDEX/历史（用哈希对比断言）。**非默认布局是 T10 补的实现缺口**（原 `layoutKind` 恒为 `'default'`）。 |
| A06 | L1 | `pass` | [capacity.test.mjs](../../packages/dsh-redteam-lead/test/capacity.test.mjs)「A06 场景：mixed 并集、缺工具、预算只够两岗时稳定裁剪且保留专岗缺口」「vacant / deferred / disabled 三类分开返回，缺口码可区分」；[catalog.test.mjs](../../packages/dsh-redteam-lead/test/catalog.test.mjs)「mixed 给 game+webapp 得到按 post_id 去重的并集，各自专岗都在」 | 并集去重 + 稳定裁剪 + 三类分开 + 不强凑四岗，L1 断言齐全。 |
| A07 | L1 | `pass` | [capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「族名本身、插件 ID、子串与前缀都不算命中」「web-recon 组合必须 web、fs、search 全部满足」「binary-static 没有任何默认工具名：存在 REA/MCP 名也不放行」「mcp:<server> 未绑定即缺口，不能凭工具名猜归属」；[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 的 gaps 区分：缺工具、未就绪 provider、预算延后、disabled」；[catalog.test.mjs](../../packages/dsh-redteam-lead/test/catalog.test.mjs)「模板不含 disabled 岗位，web-attack 只出现在 reserved_posts」 | 不凭 REA 名字推定能力、模板需求不可删（`prohibited/evidence_required` 只追加见 A17/契约用例）、disabled 岗不派。 |
| A08 | L1/L3 | `not-run` | L1 半：[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 工具可见性取自实际执行者：Lead 与 teammate 的 vacant 不同」「缺必需能力 → CAPABILITY_MISSING，且不建成员/任务」（dispatch）；[host.test.mjs](../../packages/dsh-redteam-lead/test/host.test.mjs)「工具可见性按 agent 名字区分」 | 缺 L3：其他作用域可见/已卸载/后端 fail、bootstrap 失败保留席位返回 partial——需要真实成员与真实工具注册表。 |
| A09 | L1/L3 | `not-run` | L1 半：[capacity.test.mjs](../../packages/dsh-redteam-lead/test/capacity.test.mjs)（16 例）；[team-adapter.test.mjs](../../packages/dsh-redteam-lead/test/team-adapter.test.mjs)「capacity()：有项目声明时 known:true，used 计入失败成员」「capacity()：没有显式声明时 known:false，但 used 仍然可数并给出下一步」；[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「未声明容量 → CAPACITY_UNKNOWN；席位不足 → CAPACITY_EXHAUSTED（都不动成员/任务）」 | 缺 L3：真实席位与 activation 余额的差异、失败成员占位后的实际剩余。 |
| A10 | L1/L3 | `not-run` | L1 半：[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「契约 >64 KiB 仍能派发：消息 <65536 字节、契约完整、哈希与文件字节一致」「started_at 只认成员写下的 start.json，不从 delivered 推断」；[contract.test.mjs](../../packages/dsh-redteam-lead/test/contract.test.mjs)「成员 bootstrap prompt 只含角色、规则入口与「等待任务」，不含契约正文」 | 缺 L3：spawn → bootstrap → 等身份/交付验证 → 才允许实验的真实时序。 |
| A11 | L1/L3 | `not-run` | L1 半：[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「同岗成员忙碌 → MEMBER_BUSY，且零副作用」「同岗已有空闲成员时复用，不新建成员，交付同一份契约引用」 | 缺 L3：真实成员复用后 `task_id` 改变、新契约完整交付。 |
| A12 | L1/L3 | `not-run` | L1 半：[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「消息发送失败 → partial + DELIVERY_FAILED + 保留身份；重投只发同一份信封」 | 缺 L3：真实消息上限拒绝与同信封重投。 |
| A13 | L1/L3 | `not-run` | L1 只覆盖：[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「started_at 只认成员写下的 start.json，不从 delivered 推断」；[contract.test.mjs](../../packages/dsh-redteam-lead/test/contract.test.mjs)「readStartAck：只有合法的 start.json 才给出开始时间」 | L1 **未**覆盖两个时间盒（`delivery_timeout_ms` / `timebox_ms`）分开推进；L3 需构造"成员迟迟不写 start.json"，一次性会话里不可靠复现（`docs/verify/README.md` 已知边界 5）。 |
| A14 | L1/L2 | `pass` | [dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「depends_on_tasks：未完成 → DEPENDENCY_BLOCKED；已完成 → 任务带 blockedBy」「依赖任务不存在 → DEPENDENCY_BLOCKED；跨团队任务 ID → PROJECT_SESSION_MISMATCH」「impact 报告 open 争议 → blocked 且不建半条路线」；[l2/impact.test.mjs](../../packages/dsh-redteam-lead/test/l2/impact.test.mjs)「open 争议影响活动路线：真实 check 拒绝；impact 给出 dispute_impacts；处置后放行（A30）」；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「更新事实后的 impact 仍有待复查/争议且路线保持 active/validated → CHECK_FAILED，任务不完成」 | 前置拒绝零新增（成员/任务/路线）、不建等待队列、不只看 `task completed`。 |
| A15 | L1/L2/L3 | `not-run` | L1 半：[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「原生提前 complete（无回执）→ UNREVIEWED_COMPLETION：全部检查照跑、不再调 complete」「原生提前 complete 但补验失败 → 失败码，不放行且不改任务」 | 缺 L2/L3：没有"成员先自行 complete"的真实场景用例（L2 未构造，L3 会话未跑）。 |
| A16 | L1/L2 | `pass` | [l2/outcomes.test.mjs](../../packages/dsh-redteam-lead/test/l2/outcomes.test.mjs) 8 例（finding / no_finding / budget_exhausted / refuted / failed / interrupted / blocked / cancelled，真实 `check`+`seal`）；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「七类 outcome：路线允许变化符合七行表；failed 不自动证死；未开始即阻塞可 run_ids=[]」 | 交付已处理 ≠ validated；失败不自动证死；两处（L1 表 + L2 真实 CLI）都覆盖。 |
| A17 | L1/L2 | `pass` | [anchors.test.mjs](../../packages/dsh-redteam-lead/test/anchors.test.mjs) 20 例（六类锚点各一例 + 逐类缺必要定位字段被拒 + 闭集）；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「锚点缺必要类型 → SUBMISSION_INVALID（缺 sha256 的地址锚点 / 无导出路径的 evidence_id 都不成立）」 | 函数名/URL/evidence ID 单独无效；锚点必须在本次 RUN 的 artifacts 里。 |
| A18 | L1/L2 | `pass` | [l2/outcomes.test.mjs](../../packages/dsh-redteam-lead/test/l2/outcomes.test.mjs)「failed（中断）：interrupted 必须有恢复评估，否则 check 给出具体拒绝（A18）」「blocked（未开始）：没有 RUN 也可以成立，缺 resume_when 才拒绝（A18）」；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「blocked 且 run_ids=[] 可以在没有 RUN 的情况下收口（须有保存的就绪/中断核查）」 | 前者可无 RUN 但有核查记录；后者保留 interrupted RUN 与诊断产物，不造采集。 |
| A19 | L1/L2 | `pass` | [baseline.test.mjs](../../packages/dsh-redteam-lead/test/baseline.test.mjs)「compareBaseline：既有 seal 被删除 → BASELINE_MISMATCH（不能因为"没找到"就漏过）」「compareBaseline：既有 seal 内容被改 → BASELINE_MISMATCH」「compareBaseline：目标字节被改动 → BASELINE_MISMATCH」；[l2/seal-check.test.mjs](../../packages/dsh-redteam-lead/test/l2/seal-check.test.mjs)「已封存 RUN：重复 seal 被拒绝，基线字节不变（只校验复用，不重封存）」「同时改写目标与清单：目标封存仍拒绝（旧项变化不允许）」；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「基准失效：既有 seal 被删除 → BASELINE_MISMATCH」 | 首派冻结真实目标哈希；旧项变化/删除拒绝；不重封存。 |
| A20 | L1/L2 | `pass` | [paths.test.mjs](../../packages/dsh-redteam-lead/test/paths.test.mjs) 18 例（绝对路径/UNC/`..`/ADS/控制字符/junction 写入）；[l2/paths.test.mjs](../../packages/dsh-redteam-lead/test/l2/paths.test.mjs) 5 例（越界产物、junction、ADS、大小写碰撞、检查后改提交） | Windows 专属项**在本机 Windows 上实际跑过**（不是 mock）。 |
| A21 | L1/L2 | `pass` | [lock.test.mjs](../../packages/dsh-redteam-lead/test/lock.test.mjs) 9 例；[l2/lock.test.mjs](../../packages/dsh-redteam-lead/test/l2/lock.test.mjs)「两个 Lead 并发取得整合锁：只有一个成功，另一个 PROJECT_BUSY（A21）」「锁持有者崩溃：只报告 stale，不因过期夺锁；显式恢复必须给 recoveryRef（A21）」「串行整合窗口：两个任务在锁内各 seal 一次，真实 check --hashes 通过（A21）」 | 唯一整合者；显式恢复不超时夺锁；半操作未恢复不接新变更。 |
| A22 | L1/L3 | `not-run` | L1 半：[resources.test.mjs](../../packages/dsh-redteam-lead/test/resources.test.mjs)「别名归一：同一物理实例的两个别名第二次独占租用 → RESOURCE_BUSY」「登记为不可变读取的 shared_read 可以并行」「quarantined 资源不可再分配（RESOURCE_BUSY），恢复依据后才回到 released」 | 缺 L3：真实独立实例/许可共享读/残留进程；"残留不重分配"需要真实进程。 |
| A23 | L1/L2 | `pass` | [dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「retry_of：恢复记录缺失 → blocked；核查后只新增 attempt、新目录、新 RUN ID」「retry_of：问题改变 / 旧任务已收口 → STALE_ATTEMPT」；[l2/recovery.test.mjs](../../packages/dsh-redteam-lead/test/l2/recovery.test.mjs)「迟到 attempt 只写隔离区：正式记录、基线、INDEX 都不受影响（A24/A32）」「迟到 attempt 用已接受的 RUN ID 再归档：真实 check 拒绝身份冲突（不静默覆盖）」 | 新目录/RUN 不被覆盖；旧结果只入历史；共享资源核查后才给 B（资源用例在 A22/A33）。 |
| A24 | L1/L2 | `pass` | [l2/recovery.test.mjs](../../packages/dsh-redteam-lead/test/l2/recovery.test.mjs)「seal 的响应丢失后重放：被拒绝、基线不变、history 不重复（A24）」「阶段失败不留半成品：seal 校验失败后不写基线，修正记录后同一 RUN 前向恢复（A24）」「封存后补写恢复评估：state.recovery 可更新，execution_sha256 不变（A24）」；[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「member_ready 之后、task_created 之前失败 → 重入复用同一成员，只建一个任务」；[operation.test.mjs](../../packages/dsh-redteam-lead/test/operation.test.mjs)「prepare 同 ID 同哈希：恢复既有台账，不重复追加历史」 | 回执说明已有身份与阶段；同 ID 前向恢复；不重复成员/task/seal/history；不删证据"回滚"。 |
| A25 | L1/L3 | `not-run` | L1 半：[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「spawnTeammate 生效但响应丢失 → 按确定名字唯一关联，不重复 spawn」「createTask 生效但响应丢失 → 按摘要标记唯一关联，不建第二个任务」 | 缺 L3：故障注入（杀进程/断连接）在一次性会话里不可靠复现（`docs/verify/README.md` 已知边界 5）；`RECOVERY_REQUIRED` 的"无法唯一关联"分支只有单测覆盖。 |
| A26 | L1/L3 | `not-run` | L1 半：[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「expected_revision 过期 → REVISION_CONFLICT 并带实际 revision，不覆盖他人决定」；[team-adapter.test.mjs](../../packages/dsh-redteam-lead/test/team-adapter.test.mjs)「CAS 失败 → REVISION_CONFLICT + 实际 revision；非法 action 不触达宿主」 | 缺 L3：真实两人并发改 owner/revision、恢复时又变。 |
| A27 | L1/L2 | `pass` | [conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「审计写失败 → ok + audit_written=false 且有诊断」「回执写失败 → partial（不伪称成功，也不完成任务）」；[audit.test.mjs](../../packages/dsh-redteam-lead/test/audit.test.mjs)「写失败返回 written=false 且不抛（审计 best-effort）」 | 两者处理**不同**：审计可 ok、必需回执失败必须 partial。 |
| A28 | L2 | `pass` | [l2/archive.test.mjs](../../packages/dsh-redteam-lead/test/l2/archive.test.mjs)「两个工兵并行写独立暂存区，Lead 串行归档：正式产物与暂存字节一致、执行事实原样保留（A28）」 | 原提交与映射保留、正式引用同字节、命令/cwd/时间/来源保持真实（不因移动改写执行事实）。 |
| A29 | L2 | `pass` | [l2/archive.test.mjs](../../packages/dsh-redteam-lead/test/l2/archive.test.mjs)「工兵继续写隔离区时，Lead 对另一提交执行 seal/index/check：正式记录稳定、隔离区不被索引（A29）」「未核对哈希的提交：真实 seal 拒绝且不写任何基线（不降门槛，A29）」 | 真实 CLI 验证；已有缺口保留失败；不降门槛。 |
| A30 | L1/L2 | `pass` | [l2/impact.test.mjs](../../packages/dsh-redteam-lead/test/l2/impact.test.mjs)「B 的 RUN 更新 C：真实 impact 报出 B（direct）与 A（downstream），旧 closure 原样保留（A30）」「未复核的影响不阻止 check --hashes，但阻止 check --hashes --complete（A30/A35）」「open 争议影响活动路线：真实 check 拒绝；impact 给出 dispute_impacts；处置后放行（A30）」 | 不等整条 B 完成；impact + 人工处置覆盖 A/下游；保留旧 closure。 |
| A31 | L1/L2/L3 | `not-run` | L1/L2 半：[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「新会话接管：takeover 换 session 并增 epoch，旧会话的变更操作随后被拒」「takeover 成功：epoch+1、旧 binding/roster 归档、dispatch 与事实层保留」「takeover 之后旧 epoch 的提议不能再用（必须重新提议）」；[binding.test.mjs](../../packages/dsh-redteam-lead/test/binding.test.mjs)「接管归档：旧 binding/roster/resources 复制到 history/epoch-N 并保留原文件字节」 | 缺 L3：真实"第二个会话打开旧项目"与旧句柄混用；重载不重复建岗需会话。 |
| A32 | L1/L2 | `pass` | [operation.test.mjs](../../packages/dsh-redteam-lead/test/operation.test.mjs)「prepare 同 ID 不同哈希：OPERATION_CONFLICT 且不改写台账」「replayResult 返回原结果并标记 replayed=true」；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「同一 operation_id 重放 → 原回执 replayed=true，不重复 seal/完成/审计」「不同 operation_id 指向同一 attempt → 业务身份去重，不重复 seal/history/审计」「同一 operation_id 改内容 → OPERATION_CONFLICT（不覆盖既有台账）」；[l2/recovery.test.mjs](../../packages/dsh-redteam-lead/test/l2/recovery.test.mjs)「同一条路线变更应用两次：真实 check 拒绝 broken history chain（A32）」 | 原结果返回、改内容冲突、不同 ID 也不重复 closure/history/seal。 |
| A33 | L1/L2 | `pass` | [resources.test.mjs](../../packages/dsh-redteam-lead/test/resources.test.mjs)「quarantined 资源不可再分配（RESOURCE_BUSY），恢复依据后才回到 released」「默认独占：未登记为不可变读取的 shared_read 降级为独占并记 gap」「releaseResources：只释放自己的租约，不碰别人的」；[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「资源冲突 → RESOURCE_BUSY，不改资源记录也不建成员」 | 保留事实 + 隔离继续 + 未核实前不准后继占用（L1 故障注入即判据）。**L2 未单独构造真实端口/进程残留**——真实残留属环境侧，不是插件可判定项。 |
| A34 | L1/L3 | `not-run` | — | 缺 L3：三动作 / 30 秒控制点回读、空闲有界 wait 都是 Lead 活跃循环行为，插件侧没有可断言代码；"不承诺自动唤醒"只能旁证。清单第 7 步。 |
| A35 | L2 | `pass` | [l2/seal-check.test.mjs](../../packages/dsh-redteam-lead/test/l2/seal-check.test.mjs)「验收缺口存在时 check --hashes --complete 失败（A35）」「任务全部完成但仍有活动路线：check --hashes --complete 仍失败（A35 语义）」；[l2/impact.test.mjs](../../packages/dsh-redteam-lead/test/l2/impact.test.mjs)「未复核的影响不阻止 check --hashes，但阻止 check --hashes --complete（A30/A35）」 | 真实 CLI 拒绝；通过也不省略人工逐目标证据审阅（人工审阅属 L3 记录）。 |
| A36 | L1/L2 | `pass` | [l2/compat.test.mjs](../../packages/dsh-redteam-lead/test/l2/compat.test.mjs)「克隆到新根：摘要与路径无关；改规则/脚本后要求重新做兼容检查，旧绑定保留（A36）」「重做兼容检查的最小闭环：修正记录后 probe/check 仍能给出确定结论（A36）」；[compatibility.test.mjs](../../packages/dsh-redteam-lead/test/compatibility.test.mjs)「binding 摘要一致 → 不需要复查；不一致 → REBIND_REQUIRED 且列出差异」；[dispatch.test.mjs](../../packages/dsh-redteam-lead/test/dispatch.test.mjs)「派发把规则/脚本/目录摘要冻结进契约，且一次派发只探测一次兼容性」 | 重做兼容检查；旧尝试绑定原规则或显式重派；不静默改根/session、不覆盖副本。 |
| A37 | L1/L2 | `out-of-scope` | 出处：[acceptance-matrix.md](../specs/acceptance-matrix.md) 第 7 行（"A37–A44 中的工具发现、发布和提醒由 skill 工作流承担；L1 只验证插件正确消费或拒绝，**不要求编排插件实现扫描/渲染器**"）；[tool-discovery.md](../specs/tool-discovery.md)「## 发现来源与边界」「## skill 维护与发布」 | 该行的四条观察（登记指定范围内入口、保存覆盖/跳过/失败、不启动程序、不跟随范围、不因未命中宣称全机不存在）**全部是 skill 侧发现行为**；插件里没有扫描器可验收。插件侧"不把未命中当否定"体现为能力缺口码（`capability.test.mjs`「未知能力族返回 UNKNOWN_CAPABILITY」）。 |
| A38 | L1/L3 | `not-run` | L1 半：[capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「any_provider 缺 snapshot_sha256 被拒」「any_provider 的清单 revision / 工具归属对不上时不算就绪」 | 缺 L3：真实"DSH 注册表不可读/未连接"与"确无工具"的区分，只报 `discovered`/`unknown`。 |
| A39 | L1/L3 | `pass` | [capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「binary-static 可用显式登记的工具名绑定满足」「any_provider 完整登记且清单可核验时匹配，并返回 provider 引用」「any_provider 依赖的 transport_tools 必须在执行者注册表中」「binary-static 没有任何默认工具名：存在 REA/MCP 名也不放行」 | L1 已覆盖四条观察：合法 native provider 可匹配、无需新增 MCP；缺任一必要项拒绝；不凭候选标签放行。L3 半（真实 IDA + 壳）未执行。 |
| A40 | L1/L3 | `not-run` | L1 半：[capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「any_provider 的清单 revision / 工具归属对不上时不算就绪」「any_provider 依赖的 transport_tools 必须在执行者注册表中」 | 缺 L3：换机器/入口/版本/执行者/session/目标后的四层状态与历史 checks 不迁移。 |
| A41 | L1/L2 | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「rosterInput：未知 action（含 skill 侧的清单刷新动作）被拒，不静默当成 inspect」；[capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「any_provider 的清单 revision / 工具归属对不上时不算就绪」（清单缺失 → `CAPABILITY_NOT_READY`）「只有 read 时 fs 缺失，且缺口指向组合里没满足的子能力」（缺口带 `next_step`）；[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 未传 target_kinds：只做环境检查，不猜类别、不提议班底、不给 proposal_hash」「没有项目适配器时兼容性是 unknown：inspect 给缺口，bind 拒绝」 | rt 工具不扫描/生成/隐式刷新（schema 只接受 `inspect|bind|takeover`，刷新动作被拒）；未知 action 拒绝；缺口可操作；inspect 不依赖 bind。 |
| A42 | L1/L2 | `pass` | [examples-static.test.mjs](../../packages/dsh-redteam-lead/test/examples-static.test.mjs)「tools.md 的源 JSON SHA256 等于当前 tools.json 字节（MD 不得陈旧）」「不可变快照与当前 JSON 字节相同，MD 指向的正是这份快照」「四层状态：未知不冒充验证成功，且 MD 逐入口与 JSON 一致」；[capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「any_provider 缺 snapshot_sha256 被拒」「any_provider 的清单 revision / 工具归属对不上时不算就绪」 | 插件只依据有效 JSON（快照哈希 + revision 校验）；示例的 MD 源哈希与快照字节一致，MD 不得手写第二份状态。skill 侧的"发布中断后补完 / 无变化复用 revision"是人的核查步骤（矩阵第 7 行），不在插件门禁内。**T10 修正了 `docs/examples/tools.md` 里陈旧的源哈希**（原来与 JSON 字节不符）。 |
| A43 | L1/L2 | `not-run` | 实现位置（未断言）：`src/contract.ts` 的 `capability_match` / `capability_needs`；[capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs) 只覆盖匹配本身 | **缺口**：没有用例断言"刷新清单后旧契约里的 provider/配方不变、新派发必须复验并更新绑定"；L2"旧 RUN 的 `check --hashes` 在 `re/env/tools.json` 刷新后仍通过"也没有自动化用例（需要先造真实 tools 快照再封存）。 |
| A44 | L1/L3 | `not-run` | — | 缺 L3：连续多轮缺口的去重/恢复提示要在真实会话里连跑两次 `rt_roster` 比对，且提醒本身是 Lead 活跃循环行为（不是后台监控）。清单第 6 步。 |

## 规格静态验证

对 `docs/specs/acceptance-matrix.md`「## 规格静态验证」逐类判定。全部 `pass`，证据都是 `node --test` 用例。

| 静态检查项（规格原话） | 状态 | 证据位置 | 备注 |
|---|---|---|---|
| 工具 Schema 的 Draft 2020-12 元校验（结构自洽） | `pass` | [schema-static.test.mjs](../../packages/dsh-redteam-lead/test/schema-static.test.mjs)「schema 的 $defs 齐备，且所有 $ref 都能解析」「每个封闭对象都声明了全部 required 属性，且 object 类型确实封闭」；[bundle.test.mjs](../../packages/dsh-redteam-lead/test/bundle.test.mjs)「src/tool-schema.mjs 与 docs/specs/rt-tools.schema.json 逐 $defs 无漂移」 | 零依赖元校验（不引 ajv）：`$ref` 可解析、封闭对象 `required` 齐备、注册投影不漂移。**不是**完整 Draft 2020-12 实现验证——那要外部校验器，属静态检查的已知边界（规格要求的是"对 Schema 执行元校验 + 合法/非法样例"，后者在下面的行里）。 |
| 默认只读 inspect | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「rosterInput：inspect 携带 operation_id 被拒（else 分支的 not 约束）」；[roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect 作为 Lead：给出可核对提议，且不创建成员/任务、不写 binding 与 roster」 | 默认 `action` 缺省即 `inspect`（`applyDefaults` 用例），且 inspect 带 `operation_id` 会被 `not` 约束拒绝。 |
| bind / takeover 必填条件 | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「rosterInput：action=bind 缺 operation_id 被拒（if/then 条件约束）」「rosterInput：bind/takeover 的 target_kinds 不能为空（then 分支 minItems）」「rosterInput：takeover 缺 recovery_ref 被拒（const 条件），带齐则通过」 | 正例 + 反例都有；`takeover` 的 `recovery_ref` 是 `const` 条件（**T10 补的用例**）。 |
| 拒绝不支持的清单刷新 action / 返回数据 | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「rosterInput：未知 action（含 skill 侧的清单刷新动作）被拒，不静默当成 inspect」；[bundle.test.mjs](../../packages/dsh-redteam-lead/test/bundle.test.mjs)「三工具注册：raw JSON Schema（自包含）、output.schema 为宿主子集投影、render 全能」「handler 抛异常或返回不合规信封时，注册表只看到合法信封（不抛栈）」 | `refresh_tools`/`refresh`/`list` 三种都被 `enum` 拒绝；返回值形状由注册 schema 与宿主校验器镜像守住。 |
| 缺派发字段 | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「dispatchInput：缺必填 objective 被拒」「dispatchInput：target_ids 为空、重复或格式非法都被拒」「dispatchInput：正整数下界与空白文本被拒」 | — |
| 非法角色字段 / 旧 `context` | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「rosterInput：未知字段被拒（additionalProperties=false）」（`role`）「dispatchInput：未知字段被拒」（`context`） | `additionalProperties:false` 直接拒绝，不是"忽略"。 |
| 收口身份与 review | `pass` | [validate.test.mjs](../../packages/dsh-redteam-lead/test/validate.test.mjs)「concludeInput：缺必填 review 被拒」「concludeInput：review 条件约束按 outcome 生效」；[conclude.test.mjs](../../packages/dsh-redteam-lead/test/conclude.test.mjs)「submission_ref 指向别的 attempt → PATH_INVALID」「submission_ref 越界（绝对路径）→ PATH_INVALID」「submission_sha256 不符 → SUBMISSION_INVALID，不完成」 | 身份（dispatch/attempt/task/revision/submission）与 review 条件同时覆盖。 |
| 成功 / 失败信封 | `pass` | [envelope.test.mjs](../../packages/dsh-redteam-lead/test/envelope.test.mjs) 18 例（含「所有四态构造结果都能通过规格 result 定义…」「三种非 ok 态都要求已登记稳定码」）；[errors.test.mjs](../../packages/dsh-redteam-lead/test/errors.test.mjs)「错误码集合与 rt-tools.schema.json 的 errorCode 枚举完全一致」 | 四态信封都过 `$defs.result`；码只取稳定表（表外码构造即抛）。 |
| 三工具成功 data | `pass` | [roster.test.mjs](../../packages/dsh-redteam-lead/test/roster.test.mjs)「inspect/bind/takeover 的 ok 与拒绝信封都能通过 $defs.result 校验」；[bundle.test.mjs](../../packages/dsh-redteam-lead/test/bundle.test.mjs)「output.schema 投影与 $defs.result 对齐，且在宿主支持子集内」 | 注册投影与校验用字分离（D26），两边都有断言。 |
| 工具清单示例：四层未知不冒充验证成功、MD 的源哈希与快照字节一致 | `pass` | [examples-static.test.mjs](../../packages/dsh-redteam-lead/test/examples-static.test.mjs) 3 例 | 除 `discovered` 外任何 `pass` 必须有同层 `checks`；MD 状态行逐入口等于 JSON；`registry_ref` 为 `null` 而不是空数组。 |
| 能力映射用完整工具名（族名/插件 ID 不算已注册）、组合不可被单个读工具满足 | `pass` | [capability.test.mjs](../../packages/dsh-redteam-lead/test/capability.test.mjs)「族名本身、插件 ID、子串与前缀都不算命中」「只有 read 时 fs 缺失，且缺口指向组合里没满足的子能力」「web-recon 组合必须 web、fs、search 全部满足」「工具名区分大小写」 | 同时覆盖 `any_tool` 的 OR 语义与 `all_capabilities` 的 AND 语义。 |
| 岗位目录：ID 唯一、模板引用存在且不含 disabled、required 族可解析、组合无环、精确别名无通配、mixed 并集含各自专岗且不重复 | `pass` | [schema-static.test.mjs](../../packages/dsh-redteam-lead/test/schema-static.test.mjs)「岗位目录不变量：ID 唯一、模板引用存在且不含 disabled」「岗位目录不变量：能力族恰一种组合方式、别名精确、组合无环」「岗位目录不变量：required 族可解析、enabled 缺省 true、预留与按需单列」「包内目录副本与 docs/specs/roster-catalog.json 字节一致（漂移即失败）」；[catalog.test.mjs](../../packages/dsh-redteam-lead/test/catalog.test.mjs)「mixed 给 game+webapp 得到按 post_id 去重的并集，各自专岗都在」 | 静态检查只证明数据自洽，不替代 L1/L2/L3。 |
| 运行证据按编号保存、未实现的 case 标待验收、不填占位"通过" | `pass` | 本文件 + [docs/verify/README.md](README.md)（L3 记录规范与模板） | 本表即证据索引：未执行的行全部 `not-run`，没有一行用"通过"占位。 |

## 这些 `not-run` 行要跑起来需要什么

统一前提（缺一项就别开始，`bin/doctor.mjs` 会给对应 `next_step`）：

1. 团队 profile bundle `@deepseek-ai/dsh-experimental-agent-team-profile` 已列进 `dsh.profile.bundles`；
2. 本包已 `link:` 安装**并**列进 `bundles`（doctor 的 `profile.bundle_listed/declared/linked` 三项为 `true`）；
3. 一次性临时分析项目（已 `init`，项目副本含团队规则段与 `scripts/project.py`）；
4. `python` 可达（或项目配置里 pin 了可用解释器）；
5. 证据目录在项目之外（`collect --out` / `diff --out` 拒绝写进项目）。

逐行还额外需要：

| 编号 | 额外需要什么 |
|---|---|
| A01 | 真实会话里确认"未注册工具不是唯一入口"（doctor 与 `rt_roster` 都在会话外可用） |
| A02 | 会话里对比 `send_message` 的参数面/行为属于团队版（对照组已被 patch 删除，只能旁证） |
| A03 | 真实 teammate 调用 `rt_roster` 的原始返回 + 拒绝时的空 `collect` diff |
| A08 | 其他作用域可见的工具、已卸载/后端 fail 的 provider；以及 bootstrap 失败后席位仍被占用 |
| A09 | 真实席位/activation 余额与失败成员占位 |
| A10 | 真实 spawn → bootstrap 身份/交付验证的时序 |
| A11 | 真实成员"忙碌 → 收口 → 再派"的复用 |
| A12 | 真实消息长度上限/发送失败（需构造） |
| A13 | **需故障注入**：成员不写 `start.json`；两个时间盒要真等到超时 |
| A15 | 成员先自行 `complete`（需构造） |
| A22 | 真实独立实例/许可共享读；残留进程不可观察 |
| A25 | **需故障注入**：响应丢失（杀进程/断连接），一次性会话里不可靠复现 |
| A26 | 两人并发改 owner/revision（需构造） |
| A31 | 第二个真实会话做 takeover、旧 epoch 句柄混用 |
| A34 | Lead 活跃循环的三动作/30 秒回读与有界 wait |
| A38 | DSH 注册表不可读/未连接 vs 确无工具 |
| A40 | 换机器/入口/版本/执行者/session/目标（需构造） |
| A43 | 造一份真实 `re/env/tools.json` 快照并封存，刷新清单后复跑 `check --hashes`；再补一条契约断言（旧 provider 不变、新派发复验） |
| A44 | 连续多轮相同缺口的去重/恢复提示（需连跑两次以上） |

## 与 `docs/specs/` 的差异（实现以 DECISIONS 为准）

规格里若干**事实性**断言被探明结果推翻；本表按实现判定，差异如下（详见 [`docs/impl/DECISIONS.md`](../impl/DECISIONS.md)）：

| 差异 | 裁决 | 影响的行 |
|---|---|---|
| 平台"挡住一切下一层创建"不成立：`workflow` 传 `parent` 但不传 `maxDepth`（D5） | 不声称平台挡住；以契约「你没有派发权」+ `TEAM_LEAD_REQUIRED` 补偿，并记为已知限制 | A03 / A34（L3 待实测） |
| 宿主没有受支持的容量余额只读查询（D1/D25） | 允许 `re/team/capacity.json` 或 profile `config.capacity` **显式声明**；都没有 → `CAPACITY_UNKNOWN`；activation 占用不可观测只作 gap | A09（L1 已改判据，L3 未跑） |
| `$defs.rosterData.capacity` 只有 4 个字段、没有 `known`（D19） | `known` 只在内部推导，不进 wire shape | 静态验证（`$defs` 用例） |
| 两套阶段枚举不得混用（D24） | `FAILURE_PHASES` / `OPERATION_PHASES` 各自逐字 | A24 / A32 |
| `re/env/tools.json` 没有生产者（D11） | 插件容忍缺失、报 unknown/gap，绝不自己生成 | A41 / A42 / A43 |
| 版本漂移：安装目标 rc.3、checkout 0.2.2-alpha.2（D6/D13） | 基线取 rc.3；删两行同名冲突插件 | A02（L3） |

## 记录在哪

- **L3 执行方法**：[docs/verify/README.md](README.md)（前置五项、七步循环、失败怎么留证、卸载）。
- **L3 清单**：[docs/verify/l3-checklist.md](l3-checklist.md)（七步 × 54 条断言）。
- **L3 记录模板**：[docs/verify/l3-record-template.md](l3-record-template.md)；填好的实例放 `docs/verify/records/`。
- **本表**：任何 L3 行要改成 `pass`，必须先把一份填好的记录放进 `docs/verify/records/`，再把该行证据指向它。
