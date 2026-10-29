# T7 — `rt_conclude`：提交校验、归档封存与收口

**Blocked by:** T2、T3、T4

## 这个 ticket 打通什么

工兵交回的结果能被**核验后**才落成事实：先比对派发时冻结的基准与封存，再按项目 skill 归档 + 一次性 seal + impact + index + `check --hashes`，通过后才 `complete` 宿主任务。任何一步失败都不完成、不降门槛；重复收口返回原回执。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)、[SEAMS.md](../SEAMS.md)
- `docs/specs/orchestration-contract.md`：`## 工具输入与输出`（rt_conclude 行）、`## 交付、开始和结果分类`（七类 outcome 表）、`## 锚点与封存绑定`、`## 操作阶段与部分失败`
- `docs/specs/rea-multi-agent.md` 的 `### 锚点闭集`、`### 证据基线`、`### 双账本`
- `docs/specs/project-management-integration.md` 的 `## 工兵交回与 rt_conclude`（六步收口顺序逐条落地）、`## 记录与写入归属`
- `docs/specs/rt-tools.schema.json` 的 `$defs.concludeInput`、`$defs.review`、`$defs.concludeData`、`$defs.anchorRef`、`$defs.anchorKind`、`$defs.outcome`
- `docs/specs/acceptance-matrix.md` 的 A15 / A16 / A17 / A18 / A19 / A21 / A27 / A28 / A29 / A30 / A32 / A35

## 交付

`src/conclude.mjs`（`handleConclude`）+ `src/submission.mjs` + `src/anchors.mjs` + `src/baseline.mjs`，测试同名 `.test.mjs`。

### 身份与幂等

- **只有 Lead** 可调；工兵/裸子代理 → `ROLE_REQUIRED`，零副作用。
- 同 `operation_id` 重放 → 返回原回执且 `replayed=true`；内容冲突 → `OPERATION_CONFLICT`。**不同 operation ID 指向同一 dispatch/attempt** 也必须按业务身份去重，不能重复封存或追加 history。
- `expected_revision` CAS 不匹配 → `REVISION_CONFLICT`，并带实际 revision；不自动用新 revision 覆盖别人的决定。

### 六步收口（顺序不可换）

1. **核对身份与前提**：task owner/attempt/契约摘要/规则版本；`projectAdapter.readRoute` + `impact` 复核目标身份、条件版本、open 争议、恢复待办。失效前提要 Lead 在 `review` 里给出处置，不能自动沿用旧判定。
2. **校验提交**：`submission_ref` 必须位于**当前 attempt** 的工作目录，重算 `submission_sha256` 与传入值比对（读取后再核对一次，防校验后换内容）。`submission.json` 必填：`schema_version`、dispatch/attempt/task、`contract_sha256`、`outcome`、`summary`、`run_ids`、`artifacts[{path,sha256}]`、`anchor_refs`、`blocker`、`state_recovery_ref`、`submitted_at`。不合法 → `SUBMISSION_INVALID`。
3. **锚点闭集校验**（`anchors.mjs`）：六类 `binary_location` / `source_location` / `web_capture` / `runtime_event` / `evidence_export` / `artifact_locator`，逐类校验最低定位字段，缺项拒绝：

   | kind | 必须 |
   |---|---|
   | binary_location | target_id、目标 sha256、module、va/rva/file_offset 值及类型；va 另含基址与进程实例/捕获时间 |
   | source_location | 内容文件 sha256、文件路径、行号或字节范围 |
   | web_capture | 捕获时间、URL/方法、保存响应或会话导出的 path/sha256、请求/响应内定位 |
   | runtime_event | 目标身份、进程实例、事件/时间位置、触发与观测窗口、已保存日志身份 |
   | evidence_export | 服务/版本、原会话、原 evidence ID、导出包 path/sha256、包内定位 |
   | artifact_locator | 文件 sha256 与具体行/事件/偏移 |

   `anchor_ref` 统一指向 `run_id/path/locator`，`path` 必须登记在该 RUN 的 artifacts。**函数名、URL、evidence ID 单独不成立。**
4. **归档**：把核对过的产物与 RUN 记录放进 skill 支持的正式位置；保存原提交、路径映射与原始字节哈希；保持实际命令、cwd、时间、来源与采集事件，**不因移动存储改写执行事实**。归档后正式记录才参与校验。
5. **封存与基准比对**（`baseline.mjs`）：先与派发时冻结的 `baseline_ref` 比（目标字节、既有 seal 路径与字节哈希、依赖产物），既存项删除/读取失败/内容变化 → `BASELINE_MISMATCH`。再对尚未封存的终态 RUN 调 `projectAdapter.seal`；**已有封存只校验复用，绝不重封存、不覆盖旧 seal**。封存用 skill 自己的基线与目标身份，**不以本次提交的新哈希替换旧期望值**。
6. **更新事实 → impact → index → check**：按 `review` 的有依据判定更新路线 history/closure、条件/争议与受影响验收；执行 `impact` 处置会阻止当前状态成立的影响；刷新 `index`；执行 `check --hashes`（项目完成另走 `--complete`）。任一脚本失败 → `CHECK_FAILED`，保留 stdout/stderr/exitCode/阶段，**不完成任务、不降门槛**。

### 结果分类与门槛（`src/conclude.mjs` 内表驱动）

按 `outcome ∈ finding | no_finding | refuted | blocked | budget_exhausted | failed | cancelled` 决定实际提交门槛与允许的路线变化（严格照 orchestration-contract 的七行表实现）：
- 成功/反证型交付检查**合并后**的锚点要求（岗位默认 ∪ 契约 `evidence_required`）。
- 未开始即阻塞/取消**不得**被强制补造成功锚点（`run_ids=[]` 合法，但须有保存的就绪检查或中断核查）。
- `failed` 不能自动 `falsified`；`no_finding` ≠ 证死；`completed` ≠ `validated`。
- `proposed_route_status` 只能取该 outcome 行允许的子集，越界 → `CHECK_FAILED`。

### 前置完成与回执

- 发现 task 已是 `completed` 但无验收回执 → 标记 `UNREVIEWED_COMPLETION`：**全部检查照跑**，最后核对完成态而**不再调 complete**。
- task 仍 `pending` → 拒绝收口。
- 顺序：持久化**预备收口回执** → `updateTask(action=complete)` → 核对完成态 → 保存**最终回执**到 `re/team/receipts/` 并返回 `ok`。业务回执未落盘前禁止报 ok。
- 审计：best-effort；失败不逆转证据判定，信封 `audit_written=false` 且有诊断。**回执写不成 → `partial`**，不能等同审计失败后继续报成功。
- 所有写入持有项目锁；锁竞争 → `PROJECT_BUSY`；任何不完整整合都阻止其他正式变更；不回滚、不删除已保留证据，只前向修复。

## 验收

- [ ] `node --test test` 全绿
- [ ] 工兵/裸子代理调用 → `ROLE_REQUIRED`，且断言零副作用
- [ ] 正常 finding 交付：adapter 依次被调用 `seal → impact → index → check`，任务变 `completed`，回执落盘，审计 +1，路线状态按 review 落定
- [ ] 七类 outcome 各一例：路线允许变化与成功依赖符合七行表；`failed` 不自动证死；未开始即阻塞可 `run_ids=[]`
- [ ] 六类锚点各一例有效；缺必要字段各一例被拒（**缺 `sha256` 的地址锚点、无导出路径的 `evidence_id`** 必被拒）
- [ ] 封存哈希：`baseline_ref` 冻结后改动目标字节 / 删除旧 seal / 篡改产物 → `BASELINE_MISMATCH`；已有封存只校验复用、不重封存
- [ ] `check --hashes` 失败 → `CHECK_FAILED`，任务**不**变 completed，回执说明阶段
- [ ] 重复收口：同 `operation_id` → 原回执 `replayed=true`；不同 `operation_id` 同 attempt → 不重复 seal/history；内容冲突 → `OPERATION_CONFLICT`
- [ ] `expected_revision` 过期 → `REVISION_CONFLICT` 且带实际 revision，不覆盖他人决定
- [ ] 原生提前 `complete`（无回执）→ `UNREVIEWED_COMPLETION`，全部检查照跑；补验成功后不重复调 `complete`，补验失败不放行事实层依赖
- [ ] pending 任务收口被拒
- [ ] 回执写失败 → `partial`；审计写失败 → `ok` + `audit_written=false`
- [ ] `submission_ref` 指向别的 attempt / 越界路径 → `PATH_INVALID` 或 `SUBMISSION_INVALID`
