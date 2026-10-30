# 已交付的模块 API（T1 + T3）——T5/T6/T7 直接用，别重写

> 这些是**已合入集合成分支并通过门禁**的真实导出。签名以本文件为准；与本文件不符的实现才是 bug。
> 门禁命令：`cd packages/dsh-redteam-lead; node --test "test/**/*.test.mjs"`（见 [DECISIONS.md](DECISIONS.md) D20）。

## T1 内核

### `src/envelope.mjs`
```js
ok({ operation_id, data, diagnostics = [], replayed = false, retryable = false })
blocked({ code, operation_id, data = null, diagnostics, ... })
partial({ code, operation_id, data, phase, diagnostics, ... })
error({ code, operation_id, data = null, diagnostics, ... })
fromError(err, { operation_id, code, status })   // 绝不抛；未知异常 → RECOVERY_REQUIRED + status='error'
diagnostic({ code, reason, next_step })          // 恰好三字段（$defs.diagnostic 是封闭的）
defaultStatusFor(code)
FAILURE_PHASES                                   // $defs.failureData 的 preflight…needs_recovery
```
非 `ok` 的 `data` 必须带合法 `phase` 或 `null`（schema 要求）。

### `src/validate.mjs`
```js
validateInput(schemaDefs, defName, input)            -> {ok, issues[]}
normalizeInput({ schemaDefs, defName, input, normalizeRoot }) -> {ok, issues, value}  // 校验+填默认+规范化 root+集合排序
operationInputHash(normalized, { tool, action, project, session, epoch }) -> sha256hex
```
已支持 `not` / `if-then-else` / `$ref` 兄弟关键字合并 —— 真实 `rosterInput`/`result` 用到它们。

### `src/paths.mjs`
```js
normalizeProjectRoot(p)                              // 真实绝对根、必须是目录
assertProjectRelative(p)                             // 绝对/盘符/UNC/空段/./.. /反斜杠/控制字符/ADS 全拒
resolveInProject(root, rel)                          // 解析后必须仍在根内
assertSafeWriteTarget(root, rel)                     // 逐级 symlink/junction/reparse + 根内 + 不存在的父目录也要在根内
findCaseCollision(root, rels) / assertNoCaseCollision(root, rels)
```

### `src/atomic.mjs`
```js
writeJsonAtomic(path, value)  -> {path, sha256, bytes}
createExclusive(path, bytes)  // wx；同内容幂等；异内容 → OPERATION_CONFLICT 且不覆盖
sha256Bytes(b) / sha256File(p) / verifyFileHash(p, expected) / copyVerify(src, dst)
```

### `src/lock.mjs`
```js
acquire(root, { session, operation, ownerNonce, now, ttlMs, pid, processStartMs })  // 冲突 → PROJECT_BUSY
readLock(root)
release(root, { ownerNonce }) | release(root, { force: true, recoveryRef })
isStale(root, { now }) / staleReasons(root, { now })   // **只报告，绝不自动解锁**
```
损坏锁 → `RECOVERY_REQUIRED`。`force` 必须带 `recoveryRef`。

### `src/identity.mjs`
```js
resolveCaller(ctx) -> {ok:true, role:'lead'|'teammate'|'other', name, root}
                   | {ok:false, code:'ROLE_REQUIRED'|'TEAM_SERVICE_UNAVAILABLE', ...}
```
读 `ctx.exec.agent` + `ctx.deps.teamAdapter`；同时容忍实例与工厂两种形状；**入参自报角色一律忽略**。
适配器明确答"不是成员" → `ROLE_REQUIRED`；是成员但 role 非 lead/teammate → `{ok:true, role:'other'}`，由 handler 拒。

### `src/operation.mjs`
```js
createOperationLedger({ root, clock })
  .prepare(...) / .findById(operationId) / .advance(phase, data) / .saveResult(...) / .replayResult(...)
OPERATION_PHASES   // prepared…completed + needs_recovery（与 FAILURE_PHASES 不同，见 D24）
```
台账落盘 `re/team/operations/<operation_id>.json`。

### `src/audit.mjs`
```js
appendAudit(root, entry, { clock }) -> {written: boolean}   // 固定 7 列；写失败不抛
```

## T3 决策纯函数

### `src/catalog.mjs`
```js
defaultCatalog()        // 每次重读包内 catalog.data.json，无模块级缓存
loadCatalog(p) / validateCatalog(c) / normalizeCatalog(c) / findPost(c, id)
composeTemplate(templateId, targetKinds = [], catalog?) -> {
  ok, template_id, target_kinds, posts, reserved_posts, on_demand_posts, available_post_count
} | { ok:false, code:'INVALID_ARGUMENT', reason, next_step, posts:[], ... }
TARGET_KINDS / CONCRETE_TEMPLATES
```
- `posts` 是目录里的 post 对象，键是 **`id`**（不是 `post_id`）。
- `mixed` 按 post_id 去重、要求 ≥2 个**不同** target_kind；未知/重复 kind 与"具体模板配错 kind"都拒。
- `environment` 永不自动进模板；`web-attack` 只出现在 `reserved_posts`（`enabled:false`）。

### `src/capability.mjs`
```js
matchCapabilities(needs, toolNames, inventory, bindings) -> { matched, missing, providers }
```
- needs = 岗位 `required` ∪ 任务 `capability_needs`。
- `missing[]` 每项 `{capability, code, reason, next_step, missing_capabilities[]}` —— 投到 `$defs.diagnostic` 时只取 `code/reason/next_step`。
- 族名/插件 ID/子串/前缀**永不**算命中；区分大小写；`all_capabilities` 必须全满足。
- provider 记录要求 9 字段齐备、`snapshot_sha256` 64-hex、inventory revision 与 transport_tools 对得上。

### `src/capacity.mjs`
```js
planBudget({ candidates, remainingMemberSlots, remainingActivations,
             reuseCandidates, maxPosts, reservedMemberSlots, reservedActivations }) -> {
  assigned, vacant, deferred, disabled, gaps, recommended_members, capacity
}
```
- 每个 post 条目恰好是 `$defs.post` 的 7 字段形状（`post_id,state,required,optional,anchors_required,member,reason`），**可直接塞进 `rosterData.posts`**。
- `gaps[]` 恰好 `{code, reason, next_step}`，post id 嵌在 `reason` 里。
- 候选可带 `id` 或 `post_id`；复用项 `{post_id|id, member, activation_increment}`。
- 新成员岗位在任一余额为 null 时 → `deferred` + `CAPACITY_UNKNOWN`；复用岗位在 increment 是已验证整数且 activation 已知时仍可 assigned（不占席位）。
- `recommended_members` = `member === null` 的 assigned 条数。
- **`planBudget().capacity` 带 `known`/`available_*`，这是内部形状**：投进 `rosterData.capacity` 时只能保留 schema 的 4 个字段（`remaining_member_slots`/`remaining_activations`/`reserved_member_slots`/`reserved_activations`），未知用 `null`，**`known` 不得上线**（见 [DECISIONS.md](DECISIONS.md) D19）。

## T4 适配器与替身

### `src/team-adapter.mjs`
```js
createTeamAdapter({ ctx })            // 或 { services, exec, agent, config, projectRoot }
readDeclaredCapacity(projectRoot)     // 读校验 re/team/capacity.json
CONTRACT_VERSION / ADAPTER_CONTRACT_VERSION = 1
hasService()
```
服务获取链：`services.agentTeams` → `ctx.get('agentTeams')`；缺席时全部方法 `TEAM_SERVICE_UNAVAILABLE`。
返回的 `capacity()` 形状见 [SEAMS.md](SEAMS.md) §3；**`activations.remaining` 恒为 null**，上限已声明时 `total` 有值 —— 组装规则见 [DECISIONS.md](DECISIONS.md) **D25（必读）**。
错误映射：`TEAM_LEAD_REQUIRED → ROLE_REQUIRED`；`TEAM_MEMBER_LIMIT / ACTIVATION_LIMIT_REACHED → CAPACITY_EXHAUSTED`（带 `hostCode`、`retryable:false`）；`TEAM_TASK_STALE_REVISION → REVISION_CONFLICT`（带 `actualRevision`）；`TEAM_TASK_*` 原样透传；未知宿主码 → `RECOVERY_REQUIRED` + `hostCode` + 原文。
`task` 投影额外带 `ready`/`writeScopes`；`getTask` 对墓碑返回 `status:'deleted'`。
`spawnTeammate` 接受 `{name, prompt}`，内部补 `description`（prompt 首行截 200）/`context:'fresh'`/`provider:'spawn'`/自建 `AbortSignal`，调用方可覆盖。

### `src/project-adapter.mjs`
```js
createProjectAdapter({ projectRoot, python, projectPy, spawn, env, timeoutMs, catalogPath })
// probe / seal / impact / index / check / auditScope / readRoute / readRun / readSeals
```
- `index()` 是文本输出 → `{ok, json:null, stdout, exitCode}`。
- `readRoute/readRun` 缺失 → `{ok:false, code:'PROJECT_NOT_CONFIGURED', notFound:true}`；**JSON 损坏 → `RECOVERY_REQUIRED`**（不当作"没有记录"）；ID 不匹配 `R-…`/`RUN-…` → `INVALID_ARGUMENT`（防穿越）。
- `seal`：已有 seal 文件 → **不调用 CLI**，`alreadySealed:true, called:false`；CLI 退出 1 且 stderr 命中 `refusing to overwrite sealed execution` → 复用（`reused:true`）；其它退出 1 → `CHECK_FAILED` 真失败。
- Python 解析顺序：显式 `python` > 项目配置里真实存在的绝对路径（散文里 pin，启发式）> PATH `python`/`python3`；实际用的记进 `compatibility.versions.{python,pythonExe,pythonSource}`。
- `probe().gaps` 带 `blocking`：INDEX/项目配置/副本/团队规则/project.py/Python 缺失是 blocking；`tool-inventory.md` 与 catalog 缺失是 non-blocking（D11）。

### `src/compatibility.mjs`
```js
CONTRACT_VERSION = 1
SKILL_COPY_RELATIVE
computeDigests(...)      // rule/script/catalog 摘要；算法 = `path<TAB>sha256` 行排序后再 sha256
readBinding(root)
checkCompatibility(...)  // 与已存 binding 比对，不一致 → 需重新做兼容性检查
```

### `test/helpers/`
```js
createFakeTeam(options)   // → { service, agent, agentFor(name), calls, callsFor(op), resetCalls, snapshot(),
                          //     faults{beforeHost,afterHost,dropResponse,clear,list}, failNextSpawn({code,message}),
                          //     failMember(name), setActivations(n), capacityDeclaration }
createFakeProject({ projectRoot, responses:{check,impact,index,seal,probe,auditScope}, routes, runs, seals, ... })
                          // 对象本身即 adapter + calls / callsFor(cmd) / order() / queue(cmd, resp) / reset()
makeCtx({ role, agentName, team?, teamOpts, project?, projectOpts, capacity, tools,
          depsOverrides, config, projectRoot, t, now })   // 直接可传给 handler
makeTempProject({t, files}) / makeTempDir(t) / makeClock(start) / makeFakeTools({...}) / makeFs() / DEP_KEYS
```
- `createFakeTeam` 的 `service` 是**宿主形状**，抛**宿主码**（`TEAM_LEAD_REQUIRED`/`TEAM_MEMBER_LIMIT`/`ACTIVATION_LIMIT_REACHED`…），端到端经真实适配器才变成契约码 —— 测契约码就要走 `makeCtx`。
- `faults.beforeHost(op)` = 副作用前抛；`afterHost(op)` = 副作用后抛（模拟成功但响应丢失）；`dropResponse(op)` = 成功但返回丢失，`error.effectApplied=true`。
- `makeCtx` 的 `deps` 已装 T1/T3 真实模块；`binding/contract/resources/submission/anchors/baseline` 仍为 `null`（由 T5/T6/T7 填）。
- `capacity:{known:true,maxMembers,maxActiveSubagents,via:'project'|'config'}` 会落成 `re/team/capacity.json` 或 `ctx.config.capacity`；不传就 `known:false`。

## 宿主容量拒绝消息（外部事实；T18b 起本包解析它们）

两条容量拒绝消息里**写着真实数字**。本包只读宿主抛给调用方的 `error.message`（被动观测：不读私有字段、
也不为试探而 spawn，D1），并且**只**对这两个稳定码做匹配 —— 不把任意宿主消息拿去正则。

| 宿主码 | 消息原文 | 数字是什么 |
|---|---|---|
| `ACTIVATION_LIMIT_REACHED` | `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish or complete this work with the current agents` | `capacity` = `ActivationPool.reserve(capacity)` 的入参，即该池允许的**同时** activation 数；team spawn 走 `pool.reserve(this.maxActiveSubagents())`，每次预留时才读闭包 → **运行期可变** |
| `TEAM_MEMBER_LIMIT` | `Team member limit ${this.maxMembers} reached` | `maxMembers` = 成员席位上限；`state.members.length >= this.maxMembers` 时抛 |

出处：安装构建 `0.2.1-rc.3` 的 `app.asar`（`@deepseek-ai/dsh-subagent/lib/index.js:1047`、
`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1024`）。checkout 源码里逐字复核：
`packages/subagent/subagent/src/activation.ts`（`ActivationPool.reserve`）与
`packages/experimental/agent-team/src/roster.ts`（`spawnTeammate`）。

两个与「观测」有关的细节：

- `TEAM_MEMBER_LIMIT` 的检查在写成员行**之前**（`journal.transact` 内先查上限、再 append），所以这条拒绝
  **不烧**成员名与席位：观测当时的 `used` 正好等于 `maxMembers`。
- `ACTIVATION_LIMIT_REACHED` 发生在成员行 `appendAndFlush` **之后**，catch 里把该行 settle 成 `phase:'failed'`
  → 名字与席位确实被烧掉（D12），`used` 含这一行。

rc.3 安装构建与 checkout 对这两条顺序**一致**（`_agent-team.js:1024/1025/1032/1051` vs
`roster.ts:257-260/264/276-296`），`ActivationPool.reserve()` 在 asar 里与 `activation.ts:24-35` 逐字相同
（`throw` 在 `slots.add` **之前** → 失败的预留不占 activation 槽）。**这条事实决定的不只是观测值**：
`src/dispatch.ts` 的 `capacityRefusalBurned()` 用同一个判断决定失败文案说「名字没被占用、可同名重试」
还是「已烧掉、不得同名重试」（T18c，见 DECISIONS 的 D40 补记）。

消费方：`src/capacity-source.ts` 的 `parseHostCapacityLimit()`（正则只认这两条码）。拿不到数字就回落为
观测当时的已用席位数（T18 语义），并在诊断里说明「回落」—— 不抛、不猜。**宿主改措辞时**，先更新本表，
再更新那两条正则与 `test/t18b-capacity-limit.test.mjs`。

## 尚未交付（T5/T6/T7）
`src/{roster,binding,dispatch,contract,resources,conclude,submission,anchors,baseline}.mjs` 与其测试。
