# 实现决策与规格更正（Lead 记录）

> 探明结果推翻了规格里若干**事实性**断言。实现以本文件为准；本文件不改 `docs/specs/`，但 T10 必须在验收记录里承认这些差异。
> 证据来源：`D:\workSpace\rea-ma-notes\E2-team-service.md`、`E3-project-skill.md`、`agent-team.rc3.md`、`D:\workSpace\deepseek-harness` 的 `dsh-v0.2.1-rc.3` tag。

## D1 — 容量余额：宿主没有受支持的只读查询 → 必须允许「显式声明」

**事实**：`maxMembers`、`maxActiveSubagents`、`ActivationPool.slots` 全是私有且无 getter；唯一公开的限额 getter 是 `ctx.subagents.resolveMaxDepth()`（讲的是 depth）。`listMembers().filter(role==='teammate').length` 能数**已用**席位，但**上限与剩余不可算**。`ACTIVATION_LIMIT_REACHED` 来自 `ActivationPool.reserve`，且**一次失败的 spawn 会永久烧掉成员名和 maxMembers 一个席位**（roster 留 `phase:'failed'`，`maxMembers` 计入失败成员）。

**决策**：`teamAdapter.capacity()` 按以下优先级取值，**永不猜 8/16、永不读私有字段、永不靠 spawn 试探**：

1. `re/team/capacity.json`（项目声明，含 `declared_at`/`declared_by`/`maxMembers`/`maxActiveSubagents`）→ `known:true, evidence.source:'declared:re/team/capacity.json'`；
2. 插件自身 `config.capacity`（profile patch 声明）→ `known:true, evidence.source:'declared:profile-config'`；
3. 都没有 → `known:false`，`memberSlots.used` 仍从 `listMembers()` 得出（已知），`remaining/total = null`。

第 3 种情况下 `rt_roster`/`rt_dispatch` 返回 `CAPACITY_UNKNOWN`，**诊断里必须写清下一步**（在 `re/team/capacity.json` 声明，或改 profile config），而不是含糊"资源不足"。

**已用席位**永远可数且必须计入失败成员：`used = listMembers().filter(m => m.role === 'teammate').length`。

## D2 — 任务板 CAS 错误码不同名

宿主抛 `TEAM_TASK_STALE_REVISION`。`teamAdapter` 映射到本包的稳定码 `REVISION_CONFLICT`，并在 `diagnostics` 保留原始码与**实际 revision**。其余 `TEAM_TASK_*` 按语义映射（`TEAM_TASK_BLOCKED` / `TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_UNAUTHORIZED` / `TEAM_LEAD_REQUIRED`）。

## D3 — 任务板状态机（已核实，写测试的人照这个）

- `create` → `pending`、无 owner、`revision = 1`。
- `reassign`（**Lead only**）→ **总是**写 `status='in_progress'` + `ownerId`；`taskReady()` **只在指派具体成员时检查**；清空 owner 的分支在 gate **之前** early-return（所以对 blocked 任务也能解绑）。
- `reassign` 传 `owner: null` → 退回 `pending`（等价 release）。
- `complete` 要求 `status === 'in_progress'`，且 `authorizeOwner()` = Lead **或** owner。
- `completed` **保留** owner；`deleted` 是墓碑。
- `pending + owner` 与 `in_progress + 无 owner` **不可达**。
- `expectedRevision` 不匹配 → `TEAM_TASK_STALE_REVISION`；提交值恒为 `current + 1`。

## D4 — 角色授权只有三处，其余 owner-or-Lead

服务层**只有三个** Lead-only 操作：`spawnTeammate`、`interrupt`、`updateTask{action:'reassign'}` → 越权抛 `TEAM_LEAD_REQUIRED`。其余（`complete`/`release`/`edit`/`set_dependencies`/`reopen`/`delete`）是 owner **或** Lead → 越权抛 `TEAM_TASK_UNAUTHORIZED`；`claim` 是自助的。

**工具层没有任何角色检查** —— 授权完全靠服务层。所以本包自己的 `rt_dispatch`/`rt_conclude`/`rt_roster(bind|takeover)` 必须**自己做** Lead 身份检查（`identity` + `membership`），这是本包的责任，不是宿主的。

## D5 — 规格更正：`workflow` 是 depth-1 工兵的未受限逃逸口

规格 §Further Notes 的评审更正说「工兵通过 `workflow` 开子代理不成立（depth 超限）」。**探明结果与此不符**：`childDepth = parent + 1`，cap 用 `>` 比较，`maxDepth:1` 因此挡住**孙代**；team spawn 走 `startActivation` 不传 `maxDepth`（绕过 depth 策略）；而 **`workflow` 传了 `parent` 但从不传 `maxDepth`**。

因此：teammate（depth=1）用 `subagent`/`subagent_fork` 会被挡，用 `workflow` **不会**。

**本包的处理（v0）**：不声称"平台挡住一切下一层创建"。补偿控制：
- 派发契约明写「你没有派发权，缺人就报回来」；
- 团队操作本身由服务层 `TEAM_LEAD_REQUIRED` 挡住（成员拿不到 Lead 授权）；
- 在 `docs/verify/` 与 README 的已知限制里**如实记录**这条，并列为 L3 待实测项（A 系列里"下一层创建受限"的判定改为「`subagent`/`subagent_fork` 被 depth 挡；`workflow` 不受 depth 限制，见已知限制」）。

## D6 — 版本漂移：运行的是 0.2.1-rc.3，checkout 是 0.2.2-alpha.2

安装目标 `0.2.1-rc.3`（`dsh-runtimes\dsh-primary-runtime\runtime.json` 与 `app.asar` 内 `dsh/package.json`）。团队 patch 在 rc.3 停用 **4 行**主机面（`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`），在 checkout 只停用 3 行（`tool-subagent-list-agents` 已被并进 `tool-subagent-control`）。服务层、任务板、27 个 `TEAM_*` 码、9 个工具名两边**行为一致**。

**决策**：preset 工具面基线用 **rc.3**（`docs/impl/baseline/standard.patch.rc3.yml`），删两行（`tool-subagent-control`、`tool-subagent-list-agents`），保留 `tool-subagent`/`tool-subagent-fork`/`workflow-ptc`/`tool-workflow`。

## D7 — 团队 profile bundle 已启用，但插件不得假定

`dsh.profile.bundles` 里已经列了 `@deepseek-ai/dsh-experimental-agent-team-profile`，且它没有一个按 bundle 的 `disabled` 字段——启用方式**只有**成员资格。插件仍必须在服务缺失时给 `TEAM_SERVICE_UNAVAILABLE` + `bin/doctor.mjs` 修复路径。

## D8 — 项目 skill 基线

权威副本是 `C:\Users\Administrator\.agents\skills\reverse-project-management\`（git HEAD `c4cf44e`，无 tag/version）。工作树**有未提交的两个新参考文档**：`team-coordination.md`、`tool-inventory.md` —— 正是本设计依赖的团队规则。**四个真实分析项目全部没有团队规则**（从 HEAD 初始化），其中一个的 `project.py` 还更旧。

**决策**：`compatibility` 把「团队规则段缺失」判为**缺口**，`bind` 拒绝并给出"按 skill 团队规则合并项目副本，不要用全局副本覆盖历史"的下一步；**永不**用全局副本覆盖项目副本，**永不**自动 `init` 已有项目。L2 测试的临时项目由测试自己复制一份**含团队规则**的副本。

## D9 — `send_message` 上限与会话消息前缀

上限 65536 **字节**，用 `Buffer.byteLength(JSON.stringify(content),'utf8')` 量，量的是**含 `Team message from <name>:` 信封前缀**的数组；比较是 `>`，所以恰好 65536 通过。CJK 3 字节/字。实现按字节算并留余量。

## D10 — `interrupt_agent`

`previousStatus` 只可能是 `running` 或 `inactive`（`availability()` 产不出 `provisioning`/`failed`）。

## D11 — `re/env/tools.json` 目前没有生产者

skill 侧**没有**生成命令，本机**零个真实实例**；唯一具体样例是本仓库的 `docs/examples/tools.json`。插件必须**容忍缺失**，按 `tool-discovery.md` 报 unknown/gap，绝不自己生成清单、绝不因缺失而崩。

## D12 — 失败成员的席位语义

一次失败 spawn 会烧掉名字 + 席位。因此 `rt_dispatch`：**先**查名字唯一性与已用席位、**再** spawn；spawn 失败后必须把该成员记成 `failed` 并计入已用席位，**不得**用同名重试。

## D13 — 目标构建 = 已安装的 rc.3，E1 报的「fatal difference」对我们是无操作

E1 发现：`@deepseek-ai/dsh-tool-subagent-control/list-agents` 这个子路径在 rc.3 存在、在 0.2.2 已移除；`mountPreset()` 会因**任何一行**起不来而把**整个 preset** 标成 broken。所以「保留 `tool-subagent-list-agents` 行」是致命的。

**对本设计无影响**：规格本来就要求**删掉这两行**（`tool-subagent-control` 与 `tool-subagent-list-agents`），因为它们提供的 `send_message`/`interrupt_agent`/`list_agents` 与团队服务按 Agent 注册的同名工具冲突。删掉之后我们**不引用任何 `.../list-agents` 子路径**，两种构建都不会因为这一行炸掉。

同理 `modelSelectionSettings: true`（rc.3）vs `modelSelection/modelDiscovery`（0.2.2）：我们基线取自 **rc.3**，保留 rc.3 的写法。目标构建是已安装的 rc.3，不追主线。

## D14 — patch 失败是**静默的**，所以必须有 id 清单测试

`applyEntryPatches` 对 name 不匹配、目标行缺失都是 **WARN + SKIP**，不报错。因此「patch 写错一个插件名」的表现是**什么都没发生**，不是挂载失败。

**强制**：`test/bundle.test.mjs` 必须解析出 preset 的最终 plugin id 列表，并断言它 **等于** `docs/impl/baseline/standard.patch.rc3.yml` 的列表 − `{tool-subagent-control, tool-subagent-list-agents}` + `{redteam-lead-tools}`。不能只断言"文件里有这些行"。

## D15 — `output` 是强制的，且返回值就是规范的 JSON 值

`ctx.tools.register()` 缺 `output` 直接抛 `TypeError`。`execute` 返回**一个**符合 `output.schema` 的 JSON 值（不是 `{ok}`、不是 content block）：宿主无损快照 → 校验 → 冻结 → 交给 `render(args, value)`。所以我们的 `result` 信封**就是**那个返回值；`render` 必须纯、必须全能、必须返回 `[{type:'text',text}]` 且绝不抛。

原始 JSON Schema 的工具**没有**入参自动校验（那是 `defineTool` 的能力，我们 import 不到），所以入参校验完全由本包负责。

## D16 — locale / icon 的硬要求

`<specifier>/locale/en.json` 锚定目录，随后**每个**同名 `*.json` 都会通过 `exports` 解析——所以 `exports` 必须包含 `"./locale/*.json"`，且 `locale/` 下每个文件都要能被解析。只读 `meta.title` / `meta.description`（必须非空）。`icon` 经 `"./icon"` 导出或 `package.json` 的 `icon` 字段，**≤ 256 KiB** 且在包内。**工具描述不做本地化**——不要为工具名/描述写 locale 条目。

## D17 — 插件入口只允许具名导出

`export const name`、`export const inject = ['tools']`、`export function apply(ctx, config)`，**没有 default export**；`ctx.tools.register(...)` 必须在 `apply` 内调用，让 fiber 拥有 disposer。`inject` 只放**硬依赖**（`tools`）；`agentTeams`/`agentPresets`/`subagents` 一律用 `ctx.get('x')` 探针 + 降级——本 Cordis **没有** `inject: { optional }` 这种形态。

## D18 — 基线文件的编码

`docs/impl/baseline/*.yml` 必须是 **UTF-8 无 BOM**。最初用 PowerShell 重定向抓的版本是 UTF-16LE，会污染 T2 的手抄副本与任何 `readFileSync(..., 'utf8')`。已修正；T2 若重新生成基线快照，必须显式指定编码。

## D19 — `$defs.rosterData.capacity` 只有 4 个字段，**没有** `known`

schema 是 `additionalProperties:false`，`capacity` 恰好 4 个属性：`remaining_member_slots` / `remaining_activations` / `reserved_member_slots` / `reserved_activations`。T5 的 ticket 里「`capacity`（带 known 标记）」是错的。

**裁决**：**不改 schema**（它是规格数据源）。T5 只投影这 4 个字段，未知用 `null`；`known` 只能在**内部**从 `remaining_* === null` 推导，**不得**写进 `rosterData.capacity`。`planBudget().capacity` 可以带 `known`/`available_*` 供内部与诊断使用，但那是插件内部形状，不是 wire shape。

## D20 — 门禁命令用显式 glob

`cd packages/dsh-redteam-lead; node --test "test/**/*.test.mjs"`。裸 `node --test` 会把 `test/helpers/*.mjs` 当测试文件执行（虚增计数、将来可能产生副作用）；`node --test test` 在 Node 24 上直接失败（位置参数按 glob 解释，不展开目录）。

## D21 — `ContractError.details` 不可上线

`$defs.diagnostic` 是 `additionalProperties:false` 且恰好 `code/reason/next_step` 三字段。所以 `details` 只作进程内机读用途；**具体对象与 ID 必须写进 `reason`/`next_step` 文本**，否则模型看不到。

## D22 — 未知异常映射

契约表没有 `INTERNAL_ERROR`。`envelope.fromError(非契约错误)` → `code='RECOVERY_REQUIRED'`、`status='error'`（`RECOVERY_REQUIRED` 的默认状态是 `partial`，此处显式覆盖），并允许调用方用 `options.code/status` 覆盖。**不得**把宿主异常字符串当 `code`。

## D23 — 文件级冲突的码

契约表没有「文件已存在且内容不同」。独占创建冲突、`copyVerify`/`verifyFileHash` 哈希不一致，统一用 `OPERATION_CONFLICT`，并在 `next_step` 说明是哪个文件。

## D24 — 两套阶段枚举，不得混用

`$defs.failureData` 的阶段是 `preflight…needs_recovery`（无 `completed`）；编排契约的操作阶段是 `prepared…completed` + `needs_recovery`（无 `preflight`）。两者各留逐字常量（`envelope.FAILURE_PHASES` / `operation.OPERATION_PHASES`），不要互相翻译。

## D25 — activation「上限已声明、占用不可观测」不能导致全员 defer
T4 的 `teamAdapter.capacity()` 如实返回：`memberSlots` 的 `used` 恒可数、`total/remaining` 来自声明；但 **`activations.remaining` 恒为 `null`**（真实宿主没有任何 activation 占用查询）。而 T3 的 `planBudget` 规则是「任一余额为 null → 新成员岗位 deferred + `CAPACITY_UNKNOWN`」。两者叠加会让**所有新成员岗位永远 deferred**，插件直接不可用。

**裁决：把「上限未知」与「占用不可观测」分开。**

- **上限未声明**（`activations.known === false`）→ 传 `remainingActivations = null`，`planBudget` 照旧 defer + `CAPACITY_UNKNOWN`。这是正确行为。
- **上限已声明**（`activations.known === true`）→ 调用方传 **`remainingActivations = cap.activations.total`**（即声明的上限），由 `planBudget` 再扣 `reserved_activations`；**不要**传 `remaining`。同时把 `cap.gaps` 里的 `ACTIVATION_USAGE_UNOBSERVED` 原样并入返回的 `gaps`（非阻塞诊断）。
- 于是「占用不可观测」表现为**一条可读的 gap**，而不是静默超配或全员阻塞。派发时若宿主真的抛 `ACTIVATION_LIMIT_REACHED`，按 D12 处理（记 failed、烧席位、不用同名重试）。

**T5/T6 必须照此组装**，不得各自发明口径：

```js
const cap = await teamAdapter.capacity()
const remainingActivations = cap.activations.known ? cap.activations.total : null
const budget = planBudget({ ..., remainingMemberSlots: cap.memberSlots.remaining,
                            remainingActivations, ... })
const gaps = [...budget.gaps, ...cap.gaps]   // cap.gaps 只作非阻塞诊断
```

`rosterData.capacity` 仍然只投影 schema 的 4 个字段（D19）；`remaining_activations` 取 `budget.capacity` 里已扣预留的结果。

## D26 — output.schema / parameters 不能直接注册规格的 $defs

ctx.tools.register() 会用 host 的 ssertSupportedJsonSchema 校验，**支持的子集只有** 	ype / oneOf / properties / required / additionalProperties / items / enum / const + 注解。以下一律抛 UNSUPPORTED_SCHEMA，**整行插件不激活**（不是降级，是整行消失）：
\、llOf、nyOf、if/then/else、pattern、minLength、minimum、ormat、**类型数组**（如 ["string","null"]）。
已对照**两个**版本核对：安装目标 dsh-v0.2.1-rc.3 与 checkout  .2.2-alpha.2 的 `packages/core/tools/src/json-schema.ts`，子集与 `ONE_OF_SIBLING_KEYWORDS` 一致。

**因此**：
- 注册用的 output.schema 是 `src/tool-schema.mjs` 的 `resultOutput` —— `\.result` 的**子集投影**（八字段/required/封闭/status enum；`code` 的 enum 直接取 `\.errorCode`；string|null 与 object|null 用 `oneOf`）。
- `parameters` 用 `inlineRefs` 就地展开 `\`（悬空 `\` 会直接进模型上下文）。
- `ok ⇒ code=null`、非 ok 的 data 联合这类表达不了的条件，由 `envelope.mjs` + 入口的**完整** JSON Schema 校验（含 if/then/else）在运行期保证。
- 测试里镜像了宿主的校验器；谁把 `\`/`allOf` 加回注册 schema 就红。
- **校验**仍用逐字 `\`（漂移测试不变）—— 注册投影与校验用字分离。

## D27 — envelope 的参数名以实现为准

`envelope.ok/blocked/...` 解构的是 **`operationId`**（驼峰），不是 `operation_id`。信封**输出**字段才是 `operation_id`。下游照实现写；`index.js` 目前两个键都传，属兼容冗余。

## D28 — 改用 TypeScript：源码 .ts + 	sc 产物 dist/，运行时依赖仍为零

**背景**：原决定用纯 .mjs 的两条理由已失效 ——（a）本机 Node v24.22.1 **原生支持运行 .ts**（类型擦除默认开启，`node x.ts` 与 `node --test x.test.ts` 均实测通过）；（b）`npm.cmd` 实测可用（11.19.1），registry 可达，`typescript` 可装。此前"npm 不可用"是 **PowerShell 执行策略**拦了 `npm.ps1`（五个作用域全 Undefined → OS 默认 Restricted），与 DSH 无关，`npm.cmd` 一直能用。

**决定**：

| 项 | 形态 |
|---|---|
| 源码 | `packages/dsh-redteam-lead/src/*.ts`；`strict: true`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`module/moduleResolution: nodenext`、`target: es2023`、`declaration: true` |
| 产物 | `tsc` 编译到 `packages/dsh-redteam-lead/dist/*.js` + `*.d.ts` |
| `dist/` | **提交进 git**。`link:` 安装不触发 `prepare`，不提交等于装上一具空壳；参考实现也是直接提交成品 JS |
| 入口 | `package.json` 的 `exports["."]` → `./dist/index.js`；`dsh.bundle.patch` **不变** |
| `bin/doctor.mjs` | **保留这个路径与文件名**（规格钉死 `node <bundle-root>/bin/doctor.mjs`），内容改为薄壳：`import('../dist/doctor.js')` |
| 依赖 | `typescript` 放**仓库根** `devDependencies`；**shipped bundle 的 `dependencies` 仍为空**，运行时仍零 `@deepseek-ai/*` import |
| 测试 | `test/**/*.test.ts`，import `dist/`（测试跑的就是要发货的字节）；`declaration` 提供类型 |
| 门禁 | `npm run build && node --test "test/**/*.test.ts"`（`node --test test` 在 Node 24 上仍不可用，见 D20） |
| 漂移防护 | 一条用例断言 `dist/` 与源码同步（构建后再跑；不同步即红） |

**迁移顺序**：等 T5/T6/T7 的 `.mjs` 实现落地合并后再做（现在是 278 绿用例的安全网在托底），迁移是机械的、不得改行为；T8/T9/T10 直接按 TS 做。

**不得**：不得为了让 TS 编译通过而放宽 `strict` 或加 `any` 兜底；不得在 `src/` 里引入任何运行时依赖。

## D29 — seal 顺序：保持「先 seal 再更新事实」

编排契约 §135 提到「seal 前先按事实解除会令全项目校验失败的旧状态」，而 T7 的实现顺序是 写记录 → seal → 更新事实 → impact → index → check。

**裁决：保持 T7 的顺序。** 把 seal 挪到「更新事实」之后会让**封存的是尚未更新的旧事实**，比它想解决的问题更严重。若旧路线状态本身会让 seal 的全项目校验失败，t_conclude 如实返回 CHECK_FAILED，由 Lead 先按 skill 修正记录再以同一 operation ID 重入 —— **不降门槛、不静默改序**。

## D30 — TS 工具链已由 Lead 预置；注意 Windows 不能 spawn .cmd

**已就位**（不要重新发明）：仓库根 package.json（	ypescript@^5.9 + @types/node@^24 为 devDependencies，scripts.build/test/typecheck）、packages/dsh-redteam-lead/tsconfig.json、scripts/build.mjs。实测 	sc 5.9.3 可用，
pm run build 通路正常（无 .ts 时如实报 TS18003 并非零退出）。

**	sconfig 的取舍**：strict: true，但 **
oUncheckedIndexedAccess: false**。理由：本次是**机械迁移**，目标是把模块边界的类型钉住，而不是在迁移途中跟每一处 obj[key] 搏斗；打开它会让迁移量成倍膨胀且容易诱发「加 ! 兜底」的伪类型安全。要开另立 ticket。

**踩到的坑（复用价值高）**：Windows 上 Node ≥ 18.20 因 CVE-2024-27980 的修正，在 shell: false 下**拒绝 spawn .cmd/.bat**，会抛 spawn EINVAL。所以 scripts/build.mjs 用 `process.execPath` + `node_modules/typescript/bin/tsc` 的 **JS 入口**，而不是 `.bin/tsc.cmd`。任何要调外部程序的代码都适用这条：优先找 .exe 或 JS 入口，不要靠 .cmd shim，也**不要**为了跑通而打开 shell: true（那会引入注入面）。

## D31 — 测试保持 `.mjs`（T13 明确降级为后续项）

产品代码已全部是 TypeScript（`src/*.ts` → `dist/`，`tsc` 0 错、`strict: true`）。**测试保持 `.mjs` 并 import `dist/*.js`** —— 它们跑的是要发货的字节，行为断言完整。

未做「测试也转 TS」（T13）的理由：它只增加测试内部类型，不改变被测行为；而当前剩余工作（真实 skill 集成、第三层验收套件、验收总表、代码审查）对交付价值更高。**这是有意的降级，不是遗漏**：T13 的 ticket 保留，可随时执行，门禁届时切到 `test/**/*.test.ts`。
