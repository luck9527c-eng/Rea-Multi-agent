# T6 — `rt_dispatch`：派发契约、建岗/复用与任务交付

**Blocked by:** T2、T3、T4

## 这个 ticket 打通什么

Lead 能把一条**已在项目 skill 中建立的可执行路线**交给一个成员：契约完整落盘、任务当场 `in_progress` 且 owner 正确、成员只收到带摘要哈希的信封引用、超长契约不受消息长度限制、首派不会提前开始实验。同时把失败/部分失败/重入做成可恢复的阶段，而不是「重试一次」。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)、[SEAMS.md](../SEAMS.md)
- `docs/specs/orchestration-contract.md`：`## 工具输入与输出`（rt_dispatch 行）、`## 交付、开始和结果分类`、`## 操作阶段与部分失败`、`## 路径、锁与资源`、`## 锚点与封存绑定`（`baseline_ref` 部分）
- `docs/specs/rea-multi-agent.md` 的 `### 任务板状态机（决定派发与收口的形状）`、`### 派发契约字段`、`### 失败与超时`、`### 席位与并发（共同约束）`
- `docs/specs/project-management-integration.md` 的 `## rt_dispatch：把可执行问题交给成员`（五条不变量逐条落地）
- `docs/specs/rt-tools.schema.json` 的 `$defs.dispatchInput`、`$defs.dispatchData`、`$defs.retryOf`、`$defs.resource`
- `docs/specs/acceptance-matrix.md` 的 A09 / A10 / A11 / A12 / A13 / A14 / A19 / A20 / A22 / A23 / A24 / A25 / A26 / A33

## 交付

`src/dispatch.mjs`（`handleDispatch`）+ `src/contract.mjs` + `src/resources.mjs`，测试 `test/dispatch.test.mjs`、`test/contract.test.mjs`、`test/resources.test.mjs`。

### 前置检查（任一不过 → `status=blocked`，**零副作用**：不建成员、不建任务、不改路线）

按协作契约五条不变量顺序执行，并在诊断里点名是哪一条、下一步做什么：

1. 路线必须**已由 Lead 按 skill 建立为可执行问题**（`projectAdapter.readRoute` + `impact`）；工具不接受自由形状路线草稿。`target_ids` 必须是该路线目标集合的非空子集，额外目标先建新路线。
2. 有效 `validated` 依赖、条件版本、open 争议、恢复待办、已有资源租用逐项核查。
3. 能力：岗位 `required` ∪ 任务 `capability_needs`（**只追加，不能用短数组删模板需求**）；`optional` 不阻止派发；缺必需通道/入口 → `CAPABILITY_MISSING`；已知运行时不适配 → `CAPABILITY_NOT_READY`。只能在新成员验证的就绪项走 bootstrap 无害预检，失败保留已用席位并返回 `partial`，**不开始实验**。
4. 预算：`capacity.planBudget` + `teamAdapter.capacity()`；未知 → `CAPACITY_UNKNOWN`；`MEMBER_BUSY`（同一成员最多一个未收口任务）；`DEPENDENCY_BLOCKED`（`depends_on_tasks` 的 blocker 必须已存在且已完成）。
5. 资源：`resources.mjs` 在锁内检查/租用；同物理实例别名归一为同一 `resource_key`；默认独占，只有登记为不可变读取且无状态写才 `shared_read`；未知实例或缺映射 → `RESOURCE_BINDING_MISSING`；冲突 → `RESOURCE_BUSY`。

### 契约与身份

- 生成 `dispatch_id`、`attempt_id`、RUN ID 预留、`work_dir = re/team/work/<dispatch-id>/<attempt-id>/`。**不接受任意共享写入路径。**
- 完整契约写入 `re/team/dispatches/<dispatch-id>.json`（不可变、独占创建），含：必填字段、路线版本与完整内容摘要、能力/资源需求、`baseline_ref`（冻结目标 ID 与字节哈希、相关已有 seal 的路径与哈希、依赖产物身份；首次无 seal 时 `preexisting_seals=[]` 但**必须有真实目标哈希**）、三条行为规矩（边干边落盘 / 卡住交具体问题 / 缺工具就报缺）。
- 计算 `contract_sha256`。

### 成员与任务

- **复用**：同 `post_id` 已有空闲成员（无未收口任务）→ 复用，不新建；忙碌 → `MEMBER_BUSY`。复用与新成员收到**同一份**交付信封。
- **新建**：`teamAdapter.spawnTeammate({name: 'rt-<post>' | 'rt-<post>-2', prompt})`；bootstrap prompt 只加载角色 + 项目规则入口 + 「等待任务身份，不要在指派完成前执行实验」。创建失败也记已用席位（`member_ready` 阶段）。
- **任务**：`createTask`（`subject` ≤200、`description` ≤16384，**只放摘要**：route/dispatch/attempt 标记、契约摘要哈希、operation_id）→ `updateTask(action=reassign, owner)` 使它成为 `in_progress` 且 owner 正确。**`pending` 且有 owner 不可达**，不要尝试构造该状态。
- 成功回执 `data`：`dispatch/attempt/task/member/route`、`revision`、`phase = 'delivered'`、`contract_ref`、`work_dir`、`started_at = null`。**只有 `delivered` + `in_progress` 才算成功派发**；中间阶段失败返回 `partial` 并带上已产生的身份，不能当成功验收。
- 交付信封经 `teamAdapter.sendMessage`：含 dispatch/attempt/task/revision、契约路径 + SHA256、项目规则入口。**消息上限 65536 字节，计量的是含前缀信封的整个 JSON 串**——按字节算并留余量；超限或宿主拒绝 → `DELIVERY_FAILED`，保留已创建身份。同信封重发要能去重（成员按 dispatch/attempt 去重，一次任务最多启动一次）。
- `started_at` 只在读回成员写下的 `start.json` 后记录，**不从 delivered 推断已开始**。

### `depends_on_tasks` / `retry_of`

- `depends_on_tasks` 映射到 `blockedBy`；任务 ID 只在当前绑定 team/session 解析，跨团队引用拒绝。
- `retry_of` 只恢复**尚未收口**的同一 dispatch/task：要求引用当前旧 attempt 与真实恢复记录；先撤销旧尝试提交资格 → 新增 attempt（新目录、新 RUN ID）→ 重新指派；route/目标/问题必须与原契约一致。已收口或问题改变 → 拒绝并要求另发新 dispatch，不重开宿主 completed 任务。

### 操作阶段与恢复

用 `operation` 实现阶段推进：`prepared → member_ready → task_created → assigned → delivered`，每步「先存意图、后存实际 ID」。同一 `operation_id` 重入从已存阶段续做（不重复 spawn / 不建第二个 task）；同 ID 改内容 → `OPERATION_CONFLICT`；宿主变更成功但响应丢失且无法唯一关联 → `RECOVERY_REQUIRED`，不盲重试。

## 验收

- [ ] `node --test test` 全绿
- [ ] 同岗空闲复用 / 忙碌 `MEMBER_BUSY`；复用与新建都交付同一份契约引用
- [ ] 成功派发后：task `status='in_progress'` 且 owner 正确、`phase='delivered'`、`started_at=null`、成员 `role='teammate'`
- [ ] 契约 >64 KiB 时仍能派发：消息字节数 <65536，契约文件完整，回执里的 `contract_sha256` 与文件字节一致
- [ ] 消息发送失败 / 长度拒绝 → `partial` + `DELIVERY_FAILED` + 已有身份保留；同信封重投不产生第二次启动
- [ ] 缺能力 / 前提不满足 → `blocked`，且断言 `spawnTeammate`/`createTask` 零调用、`re/team/` 无新文件、无半条路线
- [ ] `depends_on_tasks` 指向未完成 blocker → `DEPENDENCY_BLOCKED`；跨团队任务 ID → 拒绝
- [ ] 资源：两别名同实例 → 第二次 `RESOURCE_BUSY`；独立实例可并行；`quarantined` 资源不可再分配
- [ ] 阶段注入：在 `member_ready` 之后、`task_created` 之前失败 → 重入复用同一成员、不 spawn 第二个；在 `assigned` 之后失败 → 重入只重发同一信封
- [ ] `retry_of` 未核查恢复时拒绝；核查后只建新 attempt、新目录与新 RUN ID，旧提交只入历史
- [ ] 契约里 `prohibited`/`evidence_required` 是**追加**：传空数组不会删掉岗位默认要求
- [ ] `work_dir` 与 `submission_ref` 落在本 attempt 分配目录内；越界/绝对路径/junction/ADS → `PATH_INVALID`
