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

### `deps` 的两种形状（已定，别再猜）

| 键 | 形状 |
|---|---|
| `envelope`, `errors`, `validate`, `paths`, `atomic`, `lock`, `identity`, `operation`, `audit`, `catalog`, `capability`, `capacity`, `compatibility`, `binding`, `contract`, `resources`, `submission`, `anchors`, `baseline` | **模块命名空间**（`import * as envelope from './envelope.mjs'`），直接用其导出函数 |
| `teamAdapter`, `projectAdapter` | **工厂函数**：`createTeamAdapter({ services, exec, config, deps })` / `createProjectAdapter({ services, exec, config, deps })`。**每次工具调用新建一次**，把当次的 exec/services/config 绑进去；不跨调用复用实例 |

`identity.resolveCaller(ctx)` 内部用 `ctx.deps.teamAdapter.membership(ctx.exec.agent)` —— 下面 §3 的 `membership(agent)` 是**带 agent 参数**的，§2 里不重复写。

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
  memberSlots:  {known: boolean, remaining: number|null, total: number|null, used: number},
  activations:  {known: boolean, remaining: number|null, total: number|null},
  evidence: {source: string}             // 'declared:re/team/capacity.json' | 'declared:profile-config' | 'unavailable'
}
createTask({subject, description, blockedBy}) -> {ok, task} | {ok:false, code}
updateTask({taskId, expectedRevision, action, owner?}) -> {ok, task} | {ok:false, code:'REVISION_CONFLICT'|'TEAM_TASK_*'}
getTask(taskId)                          -> {ok, task} | {ok:false, code}
listTasks()                              -> {ok, tasks: []}
```

`task` 统一投影为 `{id, revision, status: 'pending'|'in_progress'|'completed', owner: string|null, subject, description, blockedBy: []}`。

**`capacity()` 是本次实现最容易瞎编的地方，规则见 [DECISIONS.md](DECISIONS.md) D1。** 宿主**没有任何**受支持的只读余额查询（`maxMembers` / `maxActiveSubagents` / `ActivationPool.slots` 全私有，唯一公开限额 getter 是 `resolveMaxDepth()`）。因此：

- `used` 恒为 `listMembers().filter(r => r.role === 'teammate').length`，**永远可数，且必须计入失败成员**（失败 spawn 会永久占用名字与席位）。
- `total` / `remaining` **只允许**来自显式声明：`re/team/capacity.json`（`evidence.source: 'declared:re/team/capacity.json'`）或插件 `config.capacity`（`'declared:profile-config'`）；都没有 → `known:false` 且置 `null`。
- **禁止**：猜 8/16、读 `service.config` 或任何私有字段、用 `listChildren()` 算术当余额、**靠 spawn 试探余额**。
- `known:false` 是合法结果，上层转 `CAPACITY_UNKNOWN` 并给出「怎么声明容量」的具体下一步。

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

**已核对的 CLI 硬事实（补充，来自 `D:\workSpace\rea-ma-notes\E3-project-skill.md`，实现必须照做）：**

1. **脚本位置**：`project.py` 用扁平 import（`governance.py`/`impact.py`/`integrity.py`），**必须**从项目副本内调用：`<root>/.agents/skills/reverse-project-management/scripts/project.py`，并用 `python -B`。不能从全局 skill 目录跑项目。
2. **解释器**：优先用项目配置里 pin 的解释器，其次 PATH 上的 `python`；实际用了哪个必须记进 `compatibility`/诊断（本机存在 3.15.2 与 3.12.14 两个，不能含糊）。
3. **顺序不可换**：写记录 → `seal` → `index` → `check --hashes` →（项目完成时）`check --hashes --complete`。**`check` 会校验 INDEX 导航区字节相等，所以 `index` 必须在 `check` 之前**。`impact`/`audit-scope` 只做派生，不做校验。
4. **`seal` 语义**：先对整个项目跑带哈希的校验，**通过后用 `O_EXCL` 写** `re/seals/targets/*.json` 与 `re/seals/runs/*.json`。`execution_sha256` = `run.json` 去掉 `state` 后的规范 JSON 哈希 —— 封存后**只允许改 `state`**。已有 seal 一律校验复用，**绝不重封**；更正走新 RUN。
5. **`check --hashes --complete`** 额外要求：**不允许存在任何 `active` 路线**。别把它当成"任务全完成就通过"。
6. **`re/env/tools.json` 与 `ENV-tools-*.json` 目前没有生产者、也没有真实实例**：插件必须**容忍缺失**，按 `tool-discovery.md` 报 unknown/gap，不得因此崩、不得自己生成清单。
7. **skill 不提供任何锁或事务**：`re/team/lock` 由本插件提供。
8. **`re/team/**` 对 `index` 不可见**：只有 INDEX 的手写区能链接它，插件只能在那里追加指针。
9. **`check` fail-fast，一次只报第一条违规**：诊断里要保留原文，不要假装有聚合报告。

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
| `re/team/operations/<operation_id>.json` | 本插件（T1 的 `operation` 台账落盘位置；`$defs.id` 保证文件名安全） |
| `re/team/capacity.json` | **项目/操作者显式声明**，插件只读（T4 `readDeclaredCapacity`）；插件**不写**它 |
| `re/targets.json`、`re/routes/`、`re/runs/`、`re/conditions/`、`re/project.json`、`re/env/`、`re/seals/`、`INDEX.md` | 项目 skill（本插件只经 `projectAdapter` 调用，不自己重写算法） |
