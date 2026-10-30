# T5 — `rt_roster`：班底提议、绑定与接管

**Blocked by:** T2（入口与装配）、T3（目录/能力/预算）、T4（适配器与替身）

## 这个 ticket 打通什么

`rt_roster` 三个 action 端到端可用：`inspect` 给出可核对的班底提议与缺口且**零副作用**；`bind` 把已确认提议固化成项目/会话绑定；`takeover` 在核查后换 Lead 会话并增 epoch。做完后 Lead 能「先看清楚再动手」，而项目事实记录一条不写。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)、[SEAMS.md](../SEAMS.md)
- `docs/specs/orchestration-contract.md` 的 `## 工具输入与输出`（rt_roster 行）、`## 岗位目录与预算裁剪`、`## 能力绑定与就绪判定`、`## 自检、会话接管与 Lead 循环`、`## 稳定错误码`
- `docs/specs/rt-tools.schema.json` 的 `$defs.rosterInput`、`$defs.rosterData`、`$defs.post`、`$defs.result`、`$defs.failureData`、`$defs.diagnostic`
- `docs/specs/project-management-integration.md` 的 `## 接入与版本绑定`（尤其第 4/5 条）、`## 记录与写入归属`
- `docs/specs/acceptance-matrix.md` 的 A03 / A04 / A05 / A06 / A07 / A08 / A09 / A31 / A36 / A41 / A44
- `docs/impl/tickets/T3-*.md`（你消费的纯函数接口）

## 交付

`src/roster.mjs`（`handleRoster`）+ `src/binding.mjs`，并补 `test/roster.test.mjs`、`test/binding.test.mjs`。

### action=inspect（只读）

- 允许 **Lead 与真实 teammate**；裸子代理/非成员 → `ROLE_REQUIRED`（用 `identity` + `teamAdapter.membership`，不取入参自报角色）。
- **不落盘**：不写 binding/roster/audit 之外的东西；不创建成员/任务；不运行实验。审计可写（best-effort）。
- `target_kinds` 为空 → 只做环境与兼容性检查，**不臆测项目类别**、不给班底提议（`posts` 可为空、`recommended_members=0`）。
- 非空 → `catalog.composeTemplate` + `capability.matchCapabilities` + `capacity.planBudget`，输出：`posts`（含 `state: assigned|vacant|deferred|disabled`）、`gaps`（缺工具/未知能力/预算延后/未实现分类给出）、`capacity`（`known` 标记）、`recommended_members`（**只计本提议需要新建的成员**，不含复用）、`compatibility`、`proposal_hash`。
- 工具可见性从**实际执行者**取（`ctx.services.tools.schemas(exec.agent)` / `get(name, agent)`）；其他作用域可见 ≠ 本执行者可调用；宿主不提供时降级为 `gaps` 里的明确未知项，不假装已核对。
- 能力映射版本、目录版本、预算与当前绑定一起进 `proposal_hash`。

### action=bind

- 必填 `operation_id` + `proposal_hash`；proposal 与当前目录/能力映射/预算/绑定不符（过期）→ `OPERATION_CONFLICT` 或 `INVALID_ARGUMENT`，**无副作用**。
- 在项目锁内**重读宿主计数**；资源不足 → 返回 blocked 要求重新提议，不能沿旧快照超配。
- 写 `re/team/binding.json`：`schema_version=1`、`project_id`、`canonical_root`、`session_id`、`team_id`、`epoch`、`rule/script/catalog/binding` 摘要、adapter `contract_version=1`、能力映射版本。从 INDEX 手写区链接 binding 与 roster（只在 INDEX 缺指针时追加，不重写 INDEX 其他内容）。
- 写 `re/team/roster.json`：岗位↔成员↔当前任务映射，`state` 含 `vacant`；**不创建成员**。
- 同一 `operation_id` 重放返回原结果（`replayed=true`），不重复追加历史。

### action=takeover

- 必填 `recovery_ref`（指向旧 Lead/执行者已停止或隔离、遗留进程/资源处置与剩余风险的**真实核查记录**）。
- 取项目锁 → 归档旧 binding/roster/resources 到历史（不删）→ `epoch + 1` → 建立新团队映射；保留 dispatch 与事实层记录；旧 epoch 提交不进入新结果。
- `recovery_ref` 指向的文件不存在或内容不满足核查要求 → 拒绝，不靠一个布尔值替代核查。
- 旧会话变更操作 → `PROJECT_SESSION_MISMATCH`；无法确定旧执行是否仍在写 → 阻塞并说明。

## 验收

- [ ] `node --test test` 全绿；新测试不得改动别人的测试文件
- [ ] inspect 三类身份（Lead / 真实 teammate / 裸子代理）分支正确，拒绝时无副作用（用替身断言 `spawnTeammate`/`createTask` 零调用、`re/team/` 无新文件）
- [ ] inspect 未传 `target_kinds` 时不猜类别、`recommended_members=0`
- [ ] inspect 的 `gaps` 能区分：缺注册工具（vacant）、未知能力族、预算延后（deferred）、disabled 未实现（web-attack 单列）；`recommended_members` 不含复用成员
- [ ] 工具可见性取自实际执行者：给 Lead 一份、给 teammate 另一份工具集时，两边的 vacant 不同
- [ ] bind 前必须 inspect 且 `proposal_hash` 匹配；过期/篡改 proposal 被拒且不写盘
- [ ] bind 成功写 binding.json + roster.json，字段齐备，**成员数仍为 0**
- [ ] bind 重放同 `operation_id` 返回原结果且 `replayed=true`，不追加第二条历史
- [ ] 锁被占时返回 `PROJECT_BUSY`；锁持有者崩溃后**不因过期自动夺锁**
- [ ] takeover 无有效 `recovery_ref` 被拒；成功后 epoch 递增、旧 binding 归档保留、旧 epoch 操作被拒
- [ ] 缺团队服务 → `TEAM_SERVICE_UNAVAILABLE`，且不写任何项目文件
- [ ] 项目副本不兼容（无 INDEX / 缺团队规则 / 缺 Python / 非默认布局）→ `SKILL_INCOMPATIBLE` 或 `PROJECT_NOT_CONFIGURED` 并给出**具体缺口与下一步**，不重 init、不覆盖副本
- [ ] 审计多一条；审计写失败时信封仍然 ok 但 `audit_written=false`
