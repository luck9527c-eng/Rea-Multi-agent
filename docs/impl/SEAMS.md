# 接缝定义（Lead 定义，实现方遵守）

> 这份文件把「谁调谁、传什么」钉死，让 T4/T5/T6/T7 可以并行实现而不互相等。
> 任何一方要改接缝，先报 Lead 改本文件，不要在代码里私改签名。

## 1. 装配上下文 `ctx`

`index.js`（T2）为每个工具调用组装一次上下文并交给 handler：

```js
/** @typedef {object} HandlerCtx */
const ctx = {
  deps,        // { envelope, errors, validate, paths, atomic, lock, identity, operation, audit,
               //   catalog, capability, capacity, teamAdapter, projectAdapter, compatibility,
               //   binding, contract, resources, submission, anchors, baseline,
               //   clock, fs }  —— 尚未实现的键为 null
  exec,        // 宿主执行上下文原样携带；身份只能从它取
  services,    // { agentTeams?, tools? } —— 宿主可选注入，缺为 undefined
  config,      // { defaults, presetId, bundleRoot }
  now,         // () => number(ms)
};
```

handler 形状（T2 固定，T5/T6/T7 实现）：

```js
export async function handleRoster(ctx, input)   // input 已通过对应 $defs 校验
export async function handleDispatch(ctx, input)
export async function handleConclude(ctx, input)
// 三者都 resolve 为 { envelope }，绝不 reject。
```

`deps.clock`：`{ now(), isoNow() }`；测试可注入假时钟。`deps.fs`：`fs/promises` 的薄封装（测试可注入内存实现），至少含 `readFile/writeFile/rename/mkdir/stat/lstat/readdir/unlink/open`。

## 2. `identity`（T1 提供）

```js
resolveCaller(ctx) -> Promise<
  | { ok: true, role: 'lead' | 'teammate' | 'other', name: string|null, root: string|null }
  | { ok: false, code: 'ROLE_REQUIRED' | 'TEAM_SERVICE_UNAVAILABLE', diagnostic }
>
```

只读 `ctx.exec.agent` + `ctx.deps.teamAdapter.membership()`。**入参里的任何 `role` 字段一律忽略。**

## 3. `teamAdapter`（T4 提供，薄封装宿主）

所有方法 `async`，永不 reject；失败用 `{ok:false, code, reason?, retryable?}`。

```js
membership(agent)                        -> {ok, member?: {id, name, role, root}} | {ok:false, code}
listMembers()                            -> {ok, members: [{id, name, role, status}]}
spawnTeammate({name, prompt})            -> {ok, member} | {ok:false, code: 'CAPACITY_EXHAUSTED'|'ACTIVATION_LIMIT_REACHED'|..., retryable}
sendMessage({target, message})           -> {ok} | {ok:false, code:'DELIVERY_FAILED', reason}
interruptAgent({target})                 -> {ok, previousStatus: 'running'|'inactive'}
capacity()                               -> {
  memberSlots:  {known: boolean, remaining: number|null, total: number|null},
  activations:  {known: boolean, remaining: number|null, total: number|null},
  evidence: {source: string}             // 说明余额从哪读到的；宿主不提供时 known:false 且 evidence.source='unavailable'
}
createTask({subject, description, blockedBy}) -> {ok, task} | {ok:false, code}
updateTask({taskId, expectedRevision, action, owner?}) -> {ok, task} | {ok:false, code:'REVISION_CONFLICT'|'TEAM_TASK_*'}
getTask(taskId)                          -> {ok, task} | {ok:false, code}
listTasks()                              -> {ok, tasks: []}
```

`task` 统一投影为 `{id, revision, status: 'pending'|'in_progress'|'completed', owner: string|null, subject, description, blockedBy: []}`。

**`capacity()` 的 known=false 是合法结果**：上层必须转成 `CAPACITY_UNKNOWN` 并拒绝创建，不得用 8 兜底、不得读宿主私有字段。若 E2 的探查证明宿主确有受支持的读法，T4 就实现它并在 `evidence.source` 注明。

## 4. `projectAdapter`（T4 提供，跑项目 skill 的真实 CLI）

```js
probe({projectRoot})   -> {ok, compatibility: {projectRoot, indexPresent, configPresent, skillCopyPresent,
                                               hasTeamRules, pythonOk, versions:{...},
                                               ruleDigest, scriptDigest, catalogDigest},
                           gaps: [ {code, detail, nextStep} ]}
seal({runId})          -> {ok, alreadySealed: boolean, stdout, exitCode}
impact()               -> {ok, json, exitCode}      // 解析 skill 的 JSON 输出
index()                -> {ok, json, exitCode}
check({hashes, complete}) -> {ok, json, exitCode, failures: []}
auditScope()           -> {ok, json, exitCode}
readRoute(routeId)     -> {ok, route} | {ok:false, code:'PROJECT_NOT_CONFIGURED'}
readRun(runId)         -> {ok, run}
readSeals()            -> {ok, seals: [{path, sha256, bytes}]}
```

**CLI 事实（已核对 `reverse-project-management`，详见 `D:\workSpace\rea-ma-notes\E3-project-skill.md`）：**

- 只有 7 个子命令：`init | index | check | impact | audit-scope | probe | seal`。**没有** `run/route/condition/env/complete`；`--complete` 是 `check` 的 flag。
- **没有 `--json` 开关**。可解析的只有：`check`（单行 JSON）、`impact`（pretty JSON）、`audit-scope`（pretty JSON）。`init/index/seal` 是文本，只当诊断保留。`seal` 的 stdout 形如 `Sealed <RUN>; ...`。
- 退出码：`0` 成功；`1` 任意校验/IO 错误且 stderr 有 `ERROR: <text>`（**fail-fast，只报第一条**）；`2` argparse 用法错误。
- **写策略**：只有 `init/index/seal/probe --output` 写文件。`routes/runs/conditions/disputes/targets/project.json` 是**普通 JSON 文件，由本插件直接读写**，CLI 只校验它们。所以 `readRoute/readRun/readSeals` 直接读文件，不走 CLI；`check`/`impact`/`audit-scope` 只读不写。
- `seal` 是**一次性**：`re/seals/runs/<RUN>.json` 与 `re/seals/targets/T-*.json`（不存在才建）。已有封存只校验复用，重复 seal 不得覆盖。
- `init` 在已有任何 target 时**拒绝**（退出 1），所以插件永不自动 init 已有项目。
- `python` 与 `project.py` 的实际路径**必须从项目配置/探测得到**，不硬编码；Node 侧用 `child_process.spawn` 传参数组，**不拼 shell 字符串**。

脚本失败一律 `{ok:false, ...}` 并保留 `stdout/stderr/exitCode`，**不得抛异常**，不得把脚本失败当成路线证死。

`compatibility` 里的 `ruleDigest/scriptDigest/catalogDigest` 是绑定用的内容摘要，**不是**独立可信签名。

## 5. 测试替身（T4 提供，T5/T6/T7 使用）

- `test/helpers/fake-team.mjs` —— **契约级**替身，实现第 3 节全部方法，并**真实复刻状态机**：create→`pending` 且无 owner；`updateTask(action=reassign, owner)` → `in_progress`；`complete` 只在 `in_progress` 且调用者为 owner 或 Lead 时成功；`blockedBy` 未完成不可 claim → `TEAM_TASK_BLOCKED`；重复认领 → `TEAM_TASK_ALREADY_CLAIMED`；`expectedRevision` CAS 不匹配 → `REVISION_CONFLICT`；席位上限 → `CAPACITY_EXHAUSTED`；成员失败后其任务仍被占用。另支持注入故障点（每次宿主调用前/后可抛）。
- `test/helpers/fake-project.mjs` —— 项目管理替身，实现第 4 节；可注入每个子命令的退出码/输出/延迟。
- `test/helpers/host.mjs` —— 装配假 `ctx`（假 exec/agent/agentTeams/deps），让 handler 单测一行起。

## 6. 错误映射

内部分支优先用 `errors.mjs` 的稳定码。适配器把宿主/脚本错误映射到稳定码；无法映射时用 `RECOVERY_REQUIRED` 并保留原始信息在 `diagnostics`。**不允许**把宿主异常字符串直接当 `code` 返回。

## 7. 状态归属

| 状态 | 唯一权威 |
|---|---|
| 成员/任务/名册 | 宿主（`teamAdapter`）；本地只做恢复关联 |
| `re/team/binding.json`、`roster.json`、`dispatches/`、`receipts/`、`audit.jsonl`、`capabilities.json`、`resources.json`、`lock` | 本插件（`atomic` + `lock`） |
| `re/targets.json`、`re/routes/`、`re/runs/`、`re/conditions/`、`re/project.json`、`re/env/`、`re/seals/`、`INDEX.md` | 项目 skill（本插件只经 `projectAdapter` 调用，不自己重写算法） |
