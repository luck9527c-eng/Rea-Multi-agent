# T4 — 宿主与项目 skill 适配器 + 契约级测试替身

**Blocked by:** T2（需要 `bin/doctor` 之外的装配不涉及；实际只需 T1 与其自身）

> 注：本 ticket 只需 T1。它**不改** `index.js`（T2 已定义 `deps` 键名），只填自己那几个键。

## 这个 ticket 打通什么

把「宿主团队服务」和「项目 skill CLI」两个外部世界收进两个窄接口后面，并配上**忠实复刻状态机**的替身。做完之后 T5/T6/T7 可以在没有 DSH、没有 Python 的情况下单测全部编排决策，同时真实适配器已经能在真环境跑。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)、**第 3/4/5 节是硬契约**
- **`D:\workSpace\rea-ma-notes\E2-team-service.md`**（`ctx.agentTeams` 真实方法、任务板 `createTask`/`updateTask`、角色授权、错误码、depth、服务检测方式）
- **`D:\workSpace\rea-ma-notes\E3-project-skill.md`**（7 个子命令、无 `--json`、退出码、`check`/`impact`/`audit-scope` 的 JSON 形状、`seal` 一次性、init 拒绝、写策略、路径与指纹）
- `docs/specs/orchestration-contract.md` 的 `## 路径、锁与资源`、`## 自检、会话接管与 Lead 循环`、`## 稳定错误码`
- `docs/specs/project-management-integration.md` 的 `## 接缝与验收`
- `docs/specs/acceptance-matrix.md` 的 A01 / A05 / A08 / A09 / A12 / A24 / A25 / A26 / A36 / A38 / A40 / A43

## 交付

### `src/team-adapter.mjs`

实现 SEAMS 第 3 节全部方法。

- 服务获取：用 E2 笔记确认的**可选注入**方式拿 `agentTeams`；缺席时所有方法返回 `{ok:false, code:'TEAM_SERVICE_UNAVAILABLE'}`，**不得**抛异常、不得在模块初始化时崩。
- `membership(agent)` 只接受宿主提供的活 `exec.agent`；`tryMembership` 的拒绝映射为 `{ok:false, code:'ROLE_REQUIRED'}`。
- `spawnTeammate({name, prompt})` → 宿主 `spawnTeammate`；把 `ACTIVATION_LIMIT_REACHED` / 席位满分别映射到 `CAPACITY_EXHAUSTED` / `CAPACITY_EXHAUSTED`，`TEAM_LEAD_REQUIRED` → `ROLE_REQUIRED`。
- `createTask` / `updateTask({action:'reassign'|'complete', owner})` / `getTask` / `listTasks`：**严格用宿主的方法名与 action 枚举**（E2 笔记为准），不要臆造 `reassignTask`/`completeTask`。任务投影成 SEAMS 的 `task` 形状。
- `sendMessage`：把宿主抛的长度/拒绝映射为 `DELIVERY_FAILED`，`reason` 保留原文。
- `interruptAgent`：返回 `previousStatus ∈ {running, inactive}`。
- **`capacity()` 是本 ticket 最关键的判断点**，先读 [DECISIONS.md](../DECISIONS.md) D1，再按它实现：
  - 宿主**没有**受支持的余额查询（已核实：`maxMembers`/`maxActiveSubagents`/`ActivationPool.slots` 全私有，唯一公开限额 getter 是 `resolveMaxDepth()`）。
  - `used` 恒从 `listMembers().filter(r=>r.role==='teammate').length` 得出，**必须计入失败成员**。
  - `total`/`remaining` **只允许**来自显式声明：`re/team/capacity.json`（`evidence.source:'declared:re/team/capacity.json'`）或插件 `config.capacity`（`'declared:profile-config'`）。都没有 → `known:false` + null。
  - **绝对禁止**：假设 8、把 `maxMembers` 配置当剩余额度、读宿主 `private` 字段或 manager 内部结构、把 `listMembers().length` 当 `remaining`、`listChildren()` 算术当余额、**靠 spawn 试探余额**（失败会永久烧掉成员名与席位，见 D12）。
  - 另提供 `readDeclaredCapacity(projectRoot)`：读并校验 `re/team/capacity.json`（`schema_version`、`declared_at`、`declared_by`、`maxMembers`、`maxActiveSubagents`），非法/缺字段 → `{known:false, gap}` 而不是崩。

### `src/project-adapter.mjs`

实现 SEAMS 第 4 节。

- `python` 与 `project.py` 路径**由入参/探测得到**，不硬编码；用 `child_process.spawn` 传**参数数组**，`shell: false`，不拼字符串。
- `check({hashes, complete})`：`JSON.parse(stdout.trim())`；非 0 退出码 → `{ok:false, code:'CHECK_FAILED', exitCode, stdout, stderr}`（stderr 原文是契约，保留）。
- `impact()` / `auditScope()`：pretty JSON，直接 parse；空输出或非 JSON → `ok:false` 且保留原文诊断。
- `seal({runId})`：文本 stdout；已经存在对应 seal 文件时**不调用、直接返回 `alreadySealed: true`**；`seal` 返回 1 时区分"已封存"（可复用）与"真失败"。
- `index()`：文本；失败保留 stderr。
- `readRoute/readRun/readSeals`：**直接读文件**（`re/routes/<id>.json`、`re/runs/<id>/run.json`、`re/seals/**`）。文件不存在 → `{ok:false, code:'PROJECT_NOT_CONFIGURED'}` 或明确的 `not found` 诊断，不抛。
- `probe({projectRoot})`：检查 `INDEX.md`、项目配置、`.agents/skills/reverse-project-management/`、团队规则段、`python` 与 `project.py` 可达性；产出 `compatibility` 与 `gaps`。

### `src/compatibility.mjs`

- 计算 `ruleDigest`（项目 skill 副本的 `SKILL.md` + 规则文档）、`scriptDigest`（`project.py` 及被引用脚本）、`catalogDigest`（岗位目录）。
- 与 `re/team/binding.json` 里已存摘要比较；不一致 → 返回需要重新兼容性检查的信号（不静默换规则）。
- 摘要**不是**独立可信签名，注释里写清这点。
- `adapter contract_version = 1`。

### `test/helpers/fake-team.mjs`（**最重要**）

按 SEAMS 第 5 节实现**契约级**替身，必须真实复刻：

- `createTask` → `status: 'pending'`、`owner: null`、`revision: 1`。
- `updateTask(action='reassign', owner=X)` → `status: 'in_progress'`、`owner: X`、`revision++`；**若 `blockedBy` 未全部完成 → `TEAM_TASK_BLOCKED`**；多次认领 → `TEAM_TASK_ALREADY_CLAIMED`；`expectedRevision` 不匹配 → `REVISION_CONFLICT` 并附带实际 revision。
- `updateTask(action='complete')` → 只在 `status === 'in_progress'` 且调用者是 owner 或 Lead 时成功；否则 `TEAM_TASK_BLOCKED`/`ROLE_REQUIRED`。
- `spawnTeammate`：非 Lead → `ROLE_REQUIRED`；超席位 → `CAPACITY_EXHAUSTED`；成员名违反 `^[a-z0-9]+(?:-[a-z0-9]+)*$`/≤64/`lead` 保留/团队内重复 → 拒绝。
- 成员 `failed` 后：名册里仍在、其 `in_progress` 任务**仍被占用**（别人 claim 报 `TEAM_TASK_ALREADY_CLAIMED`）。
- `capacity()` 可配置：`known:true` 带具体余额，或 `known:false`。
- **故障注入**：`beforeHost(op, n)` / `afterHost(op, n)` 抛错（模拟"变更成功但响应丢失"与"变更前失败"两种），以及"成功但丢返回"的 `dropResponse(op)` 模式。

### `test/helpers/fake-project.mjs`、`test/helpers/host.mjs`

- `fake-project` 实现 SEAMS 第 4 节；每个子命令可注入 `{exitCode, stdout, stderr}` 与延迟；可断言调用顺序。
- `host.mjs` 装配假 `ctx`：`makeCtx({role, agentName, teamOpts, projectOpts, depsOverrides})` 一行返回可直接传给 handler 的 `ctx`。

## 验收

- [ ] `node --test test` 全绿
- [ ] `test/team-adapter.test.mjs`：缺服务时全部方法返回 `TEAM_SERVICE_UNAVAILABLE` 且不抛；成员名规则四种违规各一例被拒；`ACTIVATION_LIMIT_REACHED` 正确映射；`capacity()` 在替身两种形态下分别返回 `known:true/false`，且实现里**没有**任何 `8`、`16`、`getCapacity`、`private` 之类的兜底/私有读取（用源码级断言）
- [ ] `test/team-adapter.test.mjs`：`spawnTeammate`/`createTask`/`updateTask` 失败时返回 `{ok:false, code}` 而非抛
- [ ] `test/project-adapter.test.mjs`：`check` 单行 JSON 解析成功；stderr `ERROR: ...` + 退出 1 → `CHECK_FAILED` 且原文保留；`impact`/`audit-scope` pretty JSON 解析成功；非 JSON 输出 → `ok:false` 不抛
- [ ] `test/project-adapter.test.mjs`：已存在 seal 文件时**不调用 CLI**；`seal` 失败与"已封存"被区分
- [ ] `test/project-adapter.test.mjs`：参数以数组传给 spawn（源码级断言无 `shell: true`、无 `exec(`、无字符串拼接命令）
- [ ] `test/compatibility.test.mjs`：摘要随 `SKILL.md`/`project.py`/目录内容变化而变化；与 binding 存值不一致时给出需复查信号
- [ ] `test/helpers` 自身有测试或断言：`fake-team` 的 `pending`+owner 不可达、`complete` 必须先 `in_progress`、依赖未完成不可 claim、`failed` 成员任务仍被占用
- [ ] `test/helpers` 故障注入：`afterHost('spawnTeammate')` 抛错后成员**已存在**（模拟响应丢失）；`beforeHost` 抛错后成员**不存在**
