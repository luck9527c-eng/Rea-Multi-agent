# T9 — 第三层验收工具包：可复跑真会话步骤 + `docs/verify/` 记录

**Blocked by:** T5、T6、T7

## 这个 ticket 打通什么

第三层（真 `ctx.agentTeams` 会话）**不能**在 `node --test` 里跑：宿主包只在打包的 `app.asar` 内，裸 `node` 无法 require。所以本 ticket 把这一层做成**可执行的验收工具 + 逐条清单**：一个人在一次性 DSH 会话里照做，把原始输出贴回 `docs/verify/`，就能判定通过或失败。

## 读什么

- `docs/specs/rea-multi-agent.md` 的 `### 第三层：真团队服务验收（半自动，一次性会话）`（七步，逐条落地）
- `docs/specs/orchestration-contract.md` 的 `## 自检、会话接管与 Lead 循环`
- `docs/specs/acceptance-matrix.md` 的全部 L3 行：A01 / A02 / A03 / A08 / A09 / A10 / A11 / A12 / A13 / A15 / A22 / A25 / A26 / A31 / A34 / A38 / A40 / A44
- `docs/specs/rea-multi-agent.md` 的 `### 工兵工具面`、`### 边界`、`### Further Notes`

## 交付

### `packages/dsh-redteam-lead/scripts/l3-verify.mjs`

一个**只读**辅助脚本，在一次性 DSH 会话里由 Lead（或人）用 shell 调用，收集可机读证据：

- 子命令 `collect --project <root> --out <file>`：把项目侧的 `re/team/binding.json`、`roster.json`、`dispatches/*`、`receipts/*`、`audit.jsonl`、`re/routes/*`、`re/seals/**` 的**路径 + 字节 SHA-256 + mtime** 收成一份 JSON。
- 子命令 `diff --before <file> --after <file>`：对比两次收集，输出新增/变更/删除项，用于"这一步到底写了什么"。
- 子命令 `checklist --out <file>`：生成带勾选框的验收清单 markdown（七步 × 每步的可观察断言 + 期望错误码）。
- **不**调用宿主、**不**写项目内文件（只写 `--out` 指定的外部路径）、**不**启动分析工具。

### `docs/verify/` 目录

| 文件 | 内容 |
|---|---|
| `README.md` | 第三层怎么跑：前置（团队 profile bundle 已启用、本 bundle 已 `link:` 安装、临时分析项目已接入 skill、Python 可用）、会话怎么开、每步怎么记、通过了怎么归档、失败怎么留证 |
| `l3-checklist.md` | 由脚本生成或手写对齐：七步逐条，每步含**可观察断言**（不是"看起来对"）与对应 A 编号 |
| `l3-record-template.md` | 记录模板：会话 id、`list_agents` 与 `team_task_list` 原始输出、`rt_roster`/`rt_dispatch`/`rt_conclude` 的原始返回、doctor 输出、`scripts/l3-verify.mjs collect` 的 JSON、路线与审计文件的 SHA-256、每步判定 |
| `acceptance-status.md` | 见 T10（由 T10 负责，本 ticket 建空壳并写清"未执行"的含义） |

### 七步要点（写进 checklist，不得简化）

1. 建临时分析项目并接入项目 skill，装好 bundle，用「红队指挥」开会话；检查三个 rt 工具及团队工具可用，**用解析后的参数或行为区分同名工具来源**（不能仅靠工具名集合）；另在**缺团队服务**环境验证 `bin/doctor.mjs` 可达诊断。
2. `rt_roster` → 项目副本兼容、各可用岗位需求非空、缺口与当前能力相符、岗位数随目标与预算变化。
3. Lead 先按 skill 建立可执行路线 → `rt_dispatch` → 成员 `role=teammate`、任务 `in_progress` 且 owner 正确、契约/路线/任务/尝试身份相符、**首派不会提前实验**。
4. 先完成同岗首个任务的验收再派下一任务 → 成员数不变、`task_id` 变化、成员收到新的完整契约；忙碌重派另测为拒绝。
5. 真实 teammate 调 `rt_dispatch`/`rt_conclude` → 身份拒绝且无副作用；用真实 teammate 验证下一层创建受限；裸子代理另测并区分「工具不存在」与「depth 拒绝」，**不以裸子代理代替成员身份测试**。
6. 工兵只提交独立工作区产物 → Lead `rt_conclude` → 真实 skill 归档/封存/校验通过、任务 `completed`、路线记录与实际判定相符、审计多一条；**校验失败不得完成**。
7. `interrupt_agent` 中断该工兵 → `previousStatus ∈ {running, inactive}`、成员仍在名册、用带 nonce 的 `send_message` 唤醒并在回报里看到 nonce。

## 验收

- [ ] `node packages/dsh-redteam-lead/scripts/l3-verify.mjs checklist --out <tmp>` 能产出非空 markdown，且包含全部七步与 A 编号
- [ ] `collect` 对一个人造的最小 `re/team/` + `re/` 目录产出确定 JSON（两次运行字节一致，除 mtime）；对缺失目录给出明确缺失项而不是崩
- [ ] `diff` 能正确报告新增/变更/删除
- [ ] `docs/verify/README.md` 的前置条件足够让没参与实现的人独立跑完七步
- [ ] `l3-record-template.md` 含全部要贴的原始输出项与 SHA-256 位置
- [ ] 脚本零依赖、只读项目、不联网
