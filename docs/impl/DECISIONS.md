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

**T18c 补正（机械口径）**：只有**已经写下成员行之后**才失败的 spawn 才会烧。「宿主因容量拒绝」有两种时机 —— `TEAM_MEMBER_LIMIT` 在 `appendAndFlush` **之前**抛（没有成员行 → 名字仍空闲、席位没消耗 → **同名重试合法**），`ACTIVATION_LIMIT_REACHED` 在成员行 append **之后**抛（catch 把它 settle 成 `failed` → 名字与席位都烧掉）。判断只写在 `dispatch.ts` 的 `capacityRefusalBurned()` 一处；宿主证据与逐字诊断见 D40 的 T18c 补记。

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

**T10 起统一为仓库根形态**，并与根 `package.json` 的 `scripts.test`、`docs/impl/CONVENTIONS.md`、`packages/dsh-redteam-lead/README.md` 三处逐字相同：`npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"`。裸 `node --test` 会把 `test/helpers/*.mjs` 当测试文件执行（虚增计数、将来可能产生副作用）；`node --test <目录>` 在 Node 24 上直接失败（位置参数按 glob 解释，不展开目录）。

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

ctx.tools.register() 会用 host 的 `assertSupportedJsonSchema` 校验，**支持的子集只有** `type` / oneOf / properties / required / additionalProperties / items / enum / const + 注解。以下一律抛 UNSUPPORTED_SCHEMA，**整行插件不激活**（不是降级，是整行消失）：
`$ref`、`allOf`、`anyOf`、if/then/else、pattern、minLength、minimum、`format`、**类型数组**（如 ["string","null"]）。
已对照**两个**版本核对：安装目标 dsh-v0.2.1-rc.3 与 checkout `0.2.2-alpha.2` 的 `packages/core/tools/src/json-schema.ts`，子集与 `ONE_OF_SIBLING_KEYWORDS` 一致。

**因此**：
- 注册用的 output.schema 是 `src/tool-schema.mjs` 的 `resultOutput` —— `$defs.result` 的**子集投影**（八字段/required/封闭/status enum；`code` 的 enum 直接取 `$defs.errorCode`；string|null 与 object|null 用 `oneOf`）。
- `parameters` 用 `inlineRefs` 就地展开 `$ref`（悬空 `$ref` 会直接进模型上下文）。
- `ok ⇒ code=null`、非 ok 的 data 联合这类表达不了的条件，由 `envelope.mjs` + 入口的**完整** JSON Schema 校验（含 if/then/else）在运行期保证。
- 测试里镜像了宿主的校验器；谁把 `$ref`/`allOf` 加回注册 schema 就红。
- **校验**仍用逐字 `$defs`（漂移测试不变）—— 注册投影与校验用字分离。

## D27 — envelope 的参数名以实现为准

`envelope.ok/blocked/...` 解构的是 **`operationId`**（驼峰），不是 `operation_id`。信封**输出**字段才是 `operation_id`。下游照实现写；`index.js` 目前两个键都传，属兼容冗余。

## D28 — 改用 TypeScript：源码 .ts + `tsc` 产物 `dist/`，运行时依赖仍为零

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

**裁决：保持 T7 的顺序。** 把 seal 挪到「更新事实」之后会让**封存的是尚未更新的旧事实**，比它想解决的问题更严重。若旧路线状态本身会让 seal 的全项目校验失败，`rt_conclude` 如实返回 CHECK_FAILED，由 Lead 先按 skill 修正记录再以同一 operation ID 重入 —— **不降门槛、不静默改序**。

## D30 — TS 工具链已由 Lead 预置；注意 Windows 不能 spawn .cmd

**已就位**（不要重新发明）：仓库根 package.json（`typescript@^5.9` + @types/node@^24 为 devDependencies，scripts.build/test/typecheck）、packages/dsh-redteam-lead/tsconfig.json、scripts/build.mjs。实测 `tsc` 5.9.3 可用，`npm run build` 通路正常（无 .ts 时如实报 TS18003 并非零退出）。

**`tsconfig` 的取舍**：strict: true，但 **noUncheckedIndexedAccess: false**。理由：本次是**机械迁移**，目标是把模块边界的类型钉住，而不是在迁移途中跟每一处 obj[key] 搏斗；打开它会让迁移量成倍膨胀且容易诱发「加 ! 兜底」的伪类型安全。要开另立 ticket。

**踩到的坑（复用价值高）**：Windows 上 Node ≥ 18.20 因 CVE-2024-27980 的修正，在 shell: false 下**拒绝 spawn .cmd/.bat**，会抛 spawn EINVAL。所以 scripts/build.mjs 用 `process.execPath` + `node_modules/typescript/bin/tsc` 的 **JS 入口**，而不是 `.bin/tsc.cmd`。任何要调外部程序的代码都适用这条：优先找 .exe 或 JS 入口，不要靠 .cmd shim，也**不要**为了跑通而打开 shell: true（那会引入注入面）。

## D31 — 测试保持 `.mjs`（T13 明确降级为后续项）

产品代码已全部是 TypeScript（`src/*.ts` → `dist/`，`tsc` 0 错、`strict: true`）。**测试保持 `.mjs` 并 import `dist/*.js`** —— 它们跑的是要发货的字节，行为断言完整。

未做「测试也转 TS」（T13）的理由：它只增加测试内部类型，不改变被测行为；而当前剩余工作（真实 skill 集成、第三层验收套件、验收总表、代码审查）对交付价值更高。**这是有意的降级，不是遗漏**：T13 的 ticket 保留，可随时执行，门禁届时切到 `test/**/*.test.ts`。

## D32 — skill 侧三处会「炸一整个命令」的坑，以及 seal 的真实成本

> 来源：T8 在真实 `project.py` 上做第二层集成时踩到并记录；本文件只记录事实与由此而来的实现约束，不改 `docs/specs/`。
> 对应的回归用例：`test/l2/helpers.mjs`（`writeRun` 的 `state` 语义）、`test/l2/outcomes.test.mjs`（中断必须有恢复评估）、`test/l2/seal-check.test.mjs`（导航顺序与执行事实）、`test/l2/recovery.test.mjs`（重放与前向恢复）。

### 1. `run.json` 里写 `"state": null` 会让 `index` 崩

`run.json` 带 `"state": null` 时，真实 CLI 的 `management_summary()` 在 `state.get(...)` 上抛
`'NoneType' object has no attribute 'get'`。**没有 state 就要整个删掉这个键**，不能写 `null`：

- 写记录的一方（`test/l2/helpers.mjs` 的 `writeRun`、任何归档路径）必须 `delete run.state`；
- 插件收口/归档时**不得**把"没有状态评估"序列化成 `state: null`；
- 读到少了 `state` 键的旧记录是合法的，不能当损坏（`RECOVERY_REQUIRED` 只适用于真的坏 JSON）。

### 2. `interrupted` 缺 `recovery` 同样会让 `index` 崩

`status: 'interrupted'` 的运行必须带恢复评估（`state.recovery`）。缺它的表现不是"少一条提示"，而是
`index` 直接失败——因为导航区摘要要数"实验恢复待办"。因此：

- `interrupted` 的 RUN 要么补 `state.recovery`，要么不要进正式记录；
- 插件对 `interrupted` 的提交必须要求恢复评估（`test/l2/outcomes.test.mjs` 的
  "failed（中断）：interrupted 必须有恢复评估，否则 check 给出具体拒绝" 就是这条）。

### 3. INDEX 的导航区是**内容派生**的，改完事实必须重跑 `index`

`<!-- RPM:NAV:START -->…<!-- RPM:NAV:END -->` 之间的内容由 `inventory(root)` 现算：目标清单、
`re/project.json` 的验收/审计/争议摘要、`re/{env,conditions,routes,runs,seals,docs,scripts}` 的文件枚举、
待复核表与恢复待办。**它不是缓存，是当前事实的投影。** 所以：

- 改 `re/project.json`（验收项、审计、争议、完成声明）、改条件/路线、加 RUN、加 seal、加环境快照之后，
  **必须重跑 `index`**；
- 否则 `check` 的第一条就是 `INDEX navigation stale; run index`——这是记录真的不一致，不是"忘了刷新页面"；
- 插件侧的推导：`seal`/`index`/`check` 是**有序**的（`test/l2/seal-check.test.mjs` 的
  "顺序不可换：seal 不刷新 INDEX…"），编排顺序照 D29（写记录 → seal → 更新事实 → impact → index → check）。

### 4. 操作后果：`seal` 跑的是**全项目**校验

`seal` 在写基线前调用 `validate(root, hashes=True, allow_unsealed=True, check_index=False)`，即：
所有目标的字节哈希、所有路线/条件/锚点的结构与引用、既有 seal 的字节一致性都会在这一步被核对，
**只有 INDEX 导航检查被跳过**。

因此 seal 失败通常**不是**"这个 RUN 有问题"，而是项目里别处已经不一致（旧目标哈希变了、旧 seal 被删、
某条路线缺锚点……）。处置顺序：按 skill 修记录 → 用**同一个 operation ID** 重入（D29 的前向恢复），
**不要**重封存、不要为了让 seal 过去而放宽 `check` 门槛、不要删旧证据。

## D33 — 已知缺口：`spawnTeammate` 之后没有 bootstrap 就绪预检（只记录，不实现）

编排契约 §167 要求：派发后先做一次**无害的**就绪预检（bootstrap 是否真的把成员拉起来），失败按 `partial` 返回。

**现状：没有这个载体。** `contract.ts` 里生成 `bootstrap` 的那一段只是一条写进契约/提示的字符串；`rt_dispatch`
在 `spawnTeammate` 成功后直接 `createTask` → `reassign`，中间没有任何"预检 + 失败 partial"的步骤。后果：成员
拉不起来时，错误要等到任务/消息环节才暴露，而不是在派发当场暴露。

**裁决：本次（审查修复 pass）不实现，按已知缺口记录**（验收表 `G1` 行，`not-run`）。理由：加预检要改派发的
阶段机（`prepared → member_ready → task_created`）与 `rt_dispatch` 的 `partial` 语义，属于重构级改动，必须带
自己的失败注入测试；塞进一个修复 pass 会变成"顺手改行为"。

## D34 — 已知缺口：用户故事 14/15 在插件里没有载体（只记录，不实现）

- 用户故事 14：「派发后必须立刻找到下一件可独立推进的事」；
- 用户故事 15：「只有真的无路可走时才允许 `wait_agent`」。

**现状：插件侧没有可断言的判据。** `rt_dispatch` 只负责投递契约并回一段 `next_step` 建议文本；它既不知道
Lead 手里还有哪几件可独立推进的事，也没有"必须先做下一件事"的状态位。`wait_agent` 是 Lead 活跃循环里的
动作，插件既不拦截也不校验时机——所以这两条既不能判 `pass`，也不该假装有实现。

**裁决：不实现，按已知缺口记录**（验收表 `G2` 行，`not-run`）。真要做需要一条 Lead 侧的"待办清单"事实层
加 `wait_agent` 前的检查钩子，那是新工具/新契约，超出本次修复范围。

## D35 — `scripts/l3-verify.mjs` 与 `docs/examples/tools.md` 重写不是范围蔓延

审查把这两项列为 scope creep。**两项都保留**，理由记在这里，下一位审查者不必再复议：

- **`scripts/l3-verify.mjs`**：第三层验收在规格里是**强制**的（A01–A44 里有 18 行要 L3），但原来是纯人工、
  没有任何机读证据。这个脚本只做一件事：把项目侧事实（文件枚举 + 字节 + sha256）采成 JSON 并 diff，让
  "零副作用 / 有副作用"变成可判定的事实。它不生成清单、不改项目、不替人判 `pass`——它只是把**已经要求的
  人工层**变成可执行，属于补齐验收手段，不是加功能。
- **`docs/examples/tools.md` 的重写**：该文件记录的"源 JSON SHA256"必须等于 `docs/examples/tools.json` 的
  真实字节摘要，A42 的用例就是断言这一条。旧文件的哈希与字节不符（陈旧），不改就与规格自相矛盾；重写只是
  让文档与它记录的源字节一致，没有改规格、没有改 JSON。

## D36 — 已知技术债：`roster.ts` 的 `bindProject` / `takeoverProject` 重复

两者在"epoch 递增、旧 binding/roster/resources 归档到 `re/team/history/epoch-N`、提议校验、审计"上有大段
重复。审查同意应当合并成一个内部的 `applyBinding(epoch + 1)` 之类函数，但**合并必须先有测试覆盖**（尤其
归档失败、epoch 竞争、旧 epoch 提议失效这三条路径），否则是拿行为风险换行数。本次修复 pass 不做，记录在此：
下次动 `roster.ts` 时优先处理。

## D37 — 已封存产物被篡改时，**本包自己的 baseline 比对抓不到**（原为已知缺口，**T17 已实现**）

> 来源：L3 第三轮（失败构造）实测 + 事后核对代码。原始证据见
> `docs/verify/records/20261029-session-040cb6df.md` §4.8 / §9.2。

### 实测（`session-040cb6df`）

把已封存产物 `re/runs/RUN-L3-001/artifacts/t001-hash.txt` 改一个字节后收口，返回的是
**`SUBMISSION_INVALID`（`status=blocked`、`phase=integrating`）**，不是任务说明预测的 `CHECK_FAILED` 或
`BASELINE_MISMATCH`。原因很简单：**该产物正好在本次提交的 `artifacts` 列表里**，提交校验重算文件哈希就
对不上（`r2-s6c-rt_conclude.txt`：「产物缺失或哈希不符…文件哈希与预期不一致」），根本走不到 baseline 比对，
更走不到最后的 `check --hashes`。这是**更早**的失败，属可接受的 fail-fast。

### 代码事实（T17 之前的状态，保留为出处）

1. `src/dispatch.ts:1744-1760`：真实派发路径的 `captureBaseline({ targetIds, … })` **从不传 `artifacts`**，
   所以 `re/team/baselines/<D>.json` 的 `artifacts` 恒为 `[]`。L3 回执对得上：
   `r2-s6b-receipt.json` 的 `baseline.compared = {targets: 1, preexisting_seals: 0, artifacts: 0}`。
2. `src/baseline.ts:393-478`：`compareBaseline()` 只哈希 `baseline.targets` 与 `baseline.artifacts`；
   `preexisting_seals` **只比对 seal 文件自身的 `path`+`sha256`**，从不重算被封存 RUN 里产物的字节哈希。
   `src/conclude.ts:1340-1352` 调用它时也没有传任何 artifacts。

**结论**：被篡改的已封存产物**无论是否出现在 `submission.artifacts` 里，baseline 比对都抓不到**。
若它不在提交列表里，唯一检测点是收口最后一步 skill 的 `check --hashes`
（实测 `r2-s6c-precheck-after-tamper.txt`：`ERROR: RUN-L3-001: artifact/script hash mismatch: …`，退出码 1），
而那时**路线文件已回写、INDEX 已刷新、封存已复用**，失败会是 `partial`（带已落盘的副作用）而不是前置拒绝。

### 当时的裁决：本次不实现，按 `not-run` 缺口记录

加"对已封存 RUN 的产物重算哈希"不是一行判断，而是给 `baseline` 引入新的语义（要覆盖:既有 seal 只校验复用的
路径、大项目全量哈希的成本、以及"产物在 seal 之后被合法补正"的处置），必须配自己的失败注入测试。塞进一个
修复 pass 会变成"顺手改行为"，与 D33/D34 的处置一致。

**这条缺口没有自动化用例覆盖，也不该写一条"断言我们抓不到"的用例把它固化。** 已在
`docs/verify/acceptance-status.md` 的「矩阵外的已知缺口」里登记为 `G3`，并已转成
[`tickets/T17-baseline-artifacts.md`](tickets/T17-baseline-artifacts.md)（Lead 复核后立项：派发侧真的冻结
依赖产物身份 + 收口侧在写盘之前比对）。

### 落地：T17（本条缺口已实现）

1. **派发侧真的冻结依赖产物**（`src/dispatch.ts` 的 `dependentArtifacts()` / `dependedSealedRunIds()`）：
   对本次派发**依赖的既有已封存 RUN**，把它们 `run.json` 里声明的每个 `{path, sha256}` 冻进
   `re/team/baselines/<D>.json` 的 `artifacts`。「依赖」只从**本路线**取：
   `route.dependency_runs`（插件扩展）∪ `route.evidence`（skill 字段）∪ 本路线在本次目标上已封存的 RUN
   （「目标已有 seal」背后的既有证据）。只冻**已封存**的（未封存产物仍可合法补正），
   **不扫别的路线的 RUN** —— 契约要求「其他路线正常新增 seal 不使旧快照失效」。首次目标无任何已封存 RUN 时
   `artifacts: []` 仍是正确值。读不到 seal 清单、或路线声明的依赖 RUN 已封存却读不到 / 产物登记残缺 →
   派发 fail-closed（`RECOVERY_REQUIRED`），不能假装「没有依赖产物」。
2. **收口侧在写盘之前比对**（`src/conclude.ts`）：`loadBaseline()` + `compareBaseline()` 从「归档之后」
   前移到**归档之前**（基准比对成为步骤 4，归档成为步骤 5，seal 成为步骤 6）。篡改被依赖的已封存产物因此
   得到 `BASELINE_MISMATCH` + `status=blocked`，且**零写盘**：路线未回写、INDEX 未刷新、任务未完成、
   回执目录都没产生。L3 那种「跑到最后 `check --hashes` 才发现、项目停在半整合状态」的路径不再存在。
   `preexisting_seals` 仍然只比 seal 文件自身的 `path`+`sha256`（那部分语义没变）。
3. **用例**：`test/baseline-artifacts.test.mjs` 三条（冻结了什么/没冻什么、篡改 → 写盘前 `BASELINE_MISMATCH`
   且零写盘、别的路线新增 seal 不误伤）；`test/conclude.test.mjs` 的 `BASELINE_MISMATCH` 与
   `RECOVERY_REQUIRED`（快照读不到）用例改为断言「写盘前拒绝」的 `blocked`。
4. `docs/verify/acceptance-status.md` 的 `G3` 行由验收总表维护者回填（`pass` + 指向
   `test/baseline-artifacts.test.mjs`）；T17 只改实现、测试与本文件。

## D38 — `checks/check-hashes.json` 的 `audit_pending: true` 是**预期行为**

> 来源：L3 第 6 步首轮与第 6b 步两次实测（`r2-s6-check-hashes.json`、`r2-s6b-check-hashes.json`，
> `exit_code` 都是 `0`）。

`rt_conclude` 的持久化顺序是
**checks（baseline/seal/impact/index/check-hashes）→ 路线回写 → impact → index → check --hashes →
完成任务 → 回执 → 审计**。所以 `check --hashes` 看到的那份 `re/team/audit.jsonl` 必然**还没有**
本次收口那条 `conclude` 记录，`project.py check` 于是报 `audit_pending: true` 并以退出码 0 通过。

- 这是**顺序的正确投影**，不是缺陷：审计在检查之后写（契约要求 `audit_written` 如实回报，L3 两次都是 `true`）；
- **不得**为了让这个字段变 `false` 而把审计提前到 checks 之前 —— 那会让"检查通过"与"审计已记"互相冒充；
- skill 级别的 stage audit（`audit-scope`）是**交接职责**，由 Lead 在收口后按 skill 走，插件不代劳、也不
  声称它已完成。

判定：任何时候看到 `check-hashes` 的 `audit_pending: true` 且 `exit_code: 0`，都按预期行为处理；只有
`audit_written: false` 才是需要报告的异常（那条路径 L1 有覆盖：`audit.test.mjs` /
`conclude.test.mjs`「审计写失败 → ok + audit_written=false 且有诊断」）。

## D39 — 两个「内容变了」的码不是一回事：`SUBMISSION_INVALID` vs `BASELINE_MISMATCH`

> 来源：D37 的 L3 实测（`session-040cb6df`，`r2-s6c-rt_conclude.txt`）+ T17 补全后的收口序列。

| | `SUBMISSION_INVALID` | `BASELINE_MISMATCH` |
|---|---|---|
| 抓的是 | **本次提交自报**的产物：`submission.artifacts` 的 path 缺失 / 哈希不符，或该 path 未在该 RUN 的 `artifacts` 里登记 | **派发时依赖的既有证据**：快照里的目标字节、既有 seal 的 `path`+`sha256`、**所依赖既有已封存 RUN 的产物字节** |
| 期望值来源 | 提交自己声明的 `sha256` / RUN 登记的正式位置 | 派发时冻结的快照（`re/team/baselines/<D>.json`） |
| 触发点 | 步骤 2（提交文件自身哈希、交叉核对与形状）与步骤 5 的归档复核（`verifyFileHash`） | **步骤 4**（`archiveAttempt()` 之前） |
| 语义 | 「你交回来的东西不是你说的那份」 | 「你动手之前依据的那份证据被改了」 |

两者都是拒绝，但**码不同、触发点不同，不能互相替代**：

- 篡改一个**在本提交里**的产物 → `SUBMISSION_INVALID`（更早的 fail-fast；这就是 L3 第 6c 步观察到的那个码，
  当时根本没走到 baseline 比对）；
- 篡改一个**不在本提交里、但被本次派发依赖**的已封存产物 → 只有 `BASELINE_MISMATCH` 能发现，由 T17 的
  `baseline.artifacts` 负责，且现在已经排到归档之前。

回归时若看到「篡改依赖产物却报 `SUBMISSION_INVALID`」，说明快照里的 `artifacts` 又空了（回到 D37 的缺口），
或者被篡改的文件恰好也在本次提交的 `artifacts` 里（合法的更早 fail-fast）。

## D40 — 有意的 spec 偏离：容量未知不再拒绝，改为「照派、撞一次就学」

> 来源：用户裁决（2026-10-30）+ ticket [`tickets/T18-capacity-per-call.md`](tickets/T18-capacity-per-call.md)。
> 实现：`src/capacity-source.ts`（新）、`src/roster.ts`、`src/dispatch.ts`、
> `docs/specs/rt-tools.schema.json` + `src/tool-schema.ts`（`capacity` 入参）；
> 用例：`test/t18-capacity.test.mjs`（T0–T7）与 `test/dispatch.test.mjs` 的「未声明容量」用例。

### 改了哪条 spec 原文

`docs/specs/orchestration-contract.md` §「岗位目录与预算裁剪」（第 44 行）逐字写着：

> 「无法取得或保守确定可用额度时返回 CAPACITY_UNKNOWN，不估计后盲目创建。」

同一份契约的「派发前置」表也把 `CAPACITY_UNKNOWN` 列为派发前置码（第 157 行）。

**本票把「未知即拒绝」改成「未知则照派，并在宿主拒绝时学一次上限」。** `rt_roster`/`bind` 的
预算裁剪口径不变（未知仍然 defer + `CAPACITY_UNKNOWN`，因为那一步不产生不可逆副作用）；
变化的只有 `rt_dispatch` 遇到**未声明**容量时的前置判定。`CAPACITY_UNKNOWN` 这个码**保留**：
它现在只用于「复用增量未知」「用量数不到」「观测进行中」这类**有具体未知项**的情形，
不再用于「项目压根没声明上限」。

### 为什么

宿主事实（D1）没有变：`maxMembers` / `maxActiveSubagents` / `ActivationPool.slots` 全无公开读法，
一次失败 spawn 还会**永久烧掉成员名与席位**（D12）。所以「猜一个 8/16」仍然禁止。
但「必须先写配置文件才能第一次派发」同样有代价：它把「开几个人」的决定权从 Leader 手里拿走，
而 Leader 本来就有这个上下文。用户的裁决是：**把决定权交给 Leader，并接受最多一次不可逆损失作为学费**。

### 代价（如实记录）

1. 未声明容量的第一次派发**可能真的烧掉一个成员名与一个席位**；诊断会明说这一点，不静默。
2. 观测值是**保守下限**：`max_members` 取「宿主拒绝那一刻的已用席位数」（失败成员已计入），
   即 ticket 说的「你已经到顶了」。真实上限只会 ≥ 这个数，所以学到之后**宁可不派**：
   剩余 0 时后续派发直接 `CAPACITY_EXHAUSTED`（前置拒绝、零副作用），不会再烧名字。
   *（T18b 起：能解析到宿主消息里的准确值时就不是下限了，见下面的补记。）*
3. `max_active_subagents` 在观测时**不可观测**（D25：池内占用没有只读查询）。ticket 要求这个字段
   必须写，因此实现取同一个「已用席位数」作为它的保守下限，并只用它做更严格的裁剪；
   它**不声称**知道真实 activation 池大小。要放宽就显式声明，不要靠再撞一次去试探
   （D1 仍然禁止「为探测而 spawn」）。
   *（T18b 起：`ACTIVATION_LIMIT_REACHED` 的消息里带着池大小本身，这个代理值只在解析不到时使用。）*
4. 观测值**按会话生效**：`TeamId` 就是 Lead 会话 id，席位随会话重置。`session_id` 与当前会话不一致、
   或当前会话身份拿不到时，观测值**不套用**（仍按 `unknown` 或其它声明来源），并且会留一条诊断说明为什么不套用。
5. 并发保护：未知容量 + 已存在 `re/team/capacity-observing.json` 标记时，第二次派发**明确拒绝**
   （`CAPACITY_UNKNOWN`，message 点名标记文件与被观测的成员），避免并行撞出 N 个不可逆损失。
   标记属于**别的会话**时不挡（席位已重置），但会留一条诊断；标记无法归到任何会话时按本会话处理（保守）。

### 谁决定

用户（2026-10-30 裁决），由 Lead 立项为本票；实现方只落实口径，不再复议。

> **已废止（T23 / D41，2026-10-30）**：下面这张五档优先级表、以及本节与之配套的观测文件、
> 观测中标记、从宿主消息解析上限、烧/不烧分类 **全部删除**。D40 的**结论**（容量未知也照派、
> 不主动探测）仍然有效，见 D41。原文按下划线保留，只作历史记录，**不再是实现口径**。

### 落地口径（后续改动请照这个，不要各写一套）

| 项 | 取值 |
|---|---|
| 优先级 | 按调用 `capacity` > `re/team/capacity.json` > profile `config.capacity` > **本会话**观测值 > `unknown` |
| `capacity_source` | `call` / `project` / `profile` / `observed` / `unknown`，写进 operation 台账（`capacity_source`、`capacity_max_members`、`capacity_max_active_subagents`、`capacity_session_id`）与诊断文本（`capacity_source=…` 出现在 reason 里） |
| 观测值文件 | `re/team/capacity-observed.json`：`{schema_version:1, session_id, observed_at, max_members, max_active_subagents, basis:{host_code, parsed_limit, used_at_observation, message}}`（`basis` 是四字段并集，T18b） |
| 写入时机 | **只在**宿主因容量拒绝了一次**真实需要**的 spawn 之后（`CAPACITY_EXHAUSTED`）；绝不为了探测而派发 |
| 观测中标记 | `re/team/capacity-observing.json`（spawn 前写、spawn 结束删；只在容量未知时写） |
| 回执 | `status=partial`、`code=CAPACITY_EXHAUSTED`、`data.member` **只在焚烧类**点名被烧的成员（非焚烧类**不带该键**，不得写 `null`——见下方「裁决（Lead）：接受 T19 的 `member` 偏差」）；`hostCode` 与观测值落点写进诊断（D21：`failureData` 是封闭对象，细节只能进文本） |
| 同名重试 | 写成员行**之后**才失败的（`ACTIVATION_LIMIT_REACHED` 与运行期故障）**禁止**（D12），失败分支不重试，下一次派发自然用 `-2`；`TEAM_MEMBER_LIMIT` 在写成员行**之前**就拒绝，名字仍空闲，容量解决后可用同名（T18c，见补记） |
| 免拒绝范围 | 只有 `capacity_source === 'unknown'`；**已声明**容量（项目/调用/观测）仍按原预算裁剪，行为不变 |

**诊断原文（未声明时，逐字）**：

> 容量未声明（capacity_source=unknown）：re/team/capacity.json 与 profile config.capacity 都没有声明，
> 本会话也还没有观测值，当前已用席位 N。本次派发照派，但**不保证**有位置：
> 宿主若因上限拒绝创建，最多可能损失一个成员名与一个席位：activation 池满会烧掉名字，
> 成员席位满发生在写成员行之前（名字还在，可以同名重试，T18c）

### 补记（T18b，2026-10-30）：上限有了**准确值**，不只是「你已经到顶了」

> ticket [`tickets/T18b-parse-exact-limit.md`](tickets/T18b-parse-exact-limit.md)。
> 实现：`src/capacity-source.ts`（`parseHostCapacityLimit` 纯解析 + `observeCapacity` 纯归并）、
> `src/dispatch.ts`（`recordCapacityObservation` 只负责 IO）。
> 用例：`test/t18b-capacity-limit.test.mjs`（T18b-1…7）；宿主消息格式记在
> [`UPSTREAM-API.md`](UPSTREAM-API.md) 的「宿主容量拒绝消息」一节。

宿主把**真实数字写在拒绝消息里**，所以「撞一次就学」学到的不再是推断值：

| 宿主码 | 消息 | 写进哪个字段 |
|---|---|---|
| `ACTIVATION_LIMIT_REACHED` | `subagent limit reached (active child limit: N); …` | `max_active_subagents = N` |
| `TEAM_MEMBER_LIMIT` | `Team member limit N reached` | `max_members = N` |

**这修掉了代价第 3 条（T18 被迫用已用席位数代理 activation 池大小）**：D25 说的是「activation 的**当前占用**
没有只读查询」，这一点没变；但**池大小**本来就在拒绝消息里，之前没读。现在 `max_active_subagents` 拿到的是 N，
`rt_roster` 的 activation 维度因此第一次有真实数字。同理，`max_members = N` 之后余量是**真余量**
（`N - used - 预留`），不再恒为 0 —— 这正是「别的 activation 释放后还能开几个」的前提。

每条消息只讲一件事，所以**另一个维度仍按 T18 的语义回落**为观测当时的已用席位数（保守下限）。
`basis.host_code` 说明这个 `parsed_limit` 落在哪个维度（`TEAM_MEMBER_LIMIT` → 成员席位；
`ACTIVATION_LIMIT_REACHED` → activation 池）。

**两种来源都必须可查**（`re/team/capacity-observed.json` 的 `basis` 是四字段并集，旧的
`{used_at_observation, host_code}` 不够用了）：

| `basis.parsed_limit` | 含义 | 诊断怎么说 |
|---|---|---|
| `>= 1` | 从宿主消息里解析出的**准确值** | 「从宿主消息里解析出的准确值」，原文留在 `basis.message` |
| `null` | 消息里没有数字 → **回落**为 `used_at_observation`（你已到顶） | 明说「回落」+ `basis.parsed_limit=null`，不假装知道真实上限 |

**这个值会失效。** `dsh-subagent` 的容量是**每次预留时通过闭包读**的（`pool.reserve(this.maxActiveSubagents())`），
`maxMembers` 同样来自配置：用户在设置里改了就变。因此：

- 观测值一定带 `observed_at`，**不是**永久常量；
- 同会话下一次撞到并解析出不同的 N → **覆盖**并更新 `observed_at`（ticket 用例 5）；
- 解析失败的碰撞**不得把准确值降级**：原样沿用、连 `observed_at` 都不改（用例 4），
  否则宿主一次改措辞就把准确值退化成推断值；
- 消息没讲到的那个维度取 `max(已有值, used)`，不会被另一个维度的消息顺手缩小。

**兼容**：`basis` 现在是四字段并集（`host_code` 仍在，没删字段）。旧的两字段文件会被判
`CAPACITY_OBSERVED_INVALID`（诊断给出新形状），下一次真实碰撞自动重写一份 —— 不需要手工迁移。
`schema_version` 仍是 1（形状只增不减，读方本来就按字段校验）。

**观测中标记可判残骸**：`re/team/capacity-observing.json` 的正常生命周期是「spawn 前写、spawn 结束删」，
进程被杀就留下来了。并发拒绝的诊断现在同时给出标记内的 `started_at` 与**该文件的 mtime**
（`readObservationMarker().modified_at`），操作者据此判断是「刚刚有人在观测」还是「很久以前的残骸」；
处置仍是先核对名册、再手工删文件（插件不自动清理别人的标记）。已知限制同步写进 README。

### 补记（T18c，2026-10-30）：两条容量码的**损坏语义不同** —— 名字与席位不是每次都烧

> ticket T18c（本仓库没有单独落 ticket 文件；上下文见 D12 的补正与本节）。
> 实现：`src/dispatch.ts`（`capacityRefusalBurned()` + 两句 `refusal*Clause()`；failure 文案与诊断共用）。
> 用例：`test/t18c-burn-semantics.test.mjs`（T18c-1…3）与 `test/fake-team.test.mjs` 的
> 「两条容量拒绝的席位语义不同」；替身修正见 `test/helpers/fake-team.mjs`。

**缺陷**：容量碰撞的 failure 文案与诊断对两条码**都说**「该名字与席位已被烧掉，不得同名重试（D12）」。
`TEAM_MEMBER_LIMIT` 实际发生在写成员行**之前**，名字仍然空闲、席位没有消耗。把「名字还在」说成
「已烧掉」，等于让 Lead 放弃一个还能用的名字、跳过唯一一次本该成功的重试 —— 与 T15 的假绿同类：
替身编了一个不存在的损失，测试再给那个损失背书。

**宿主事实（逐字核对）**：

| 宿主码 | 抛出点 | 成员行 | 名字 | 席位 |
|---|---|---|---|---|
| `TEAM_MEMBER_LIMIT` | `journal.transact` 内的席位上限检查，**在 `appendAndFlush` 之前** | 没有 | 仍空闲 | 未消耗 → **同名重试合法** |
| `ACTIVATION_LIMIT_REACHED` | `subagents.startActivation` → `ActivationPool.reserve` 池满抛，**在成员行 append 之后**；catch 把该行 settle 成 `phase:'failed'` | 有（`failed`） | 被占用 | 计入 `state.members.length` → **烧掉** |

**rc.3（运行构建）vs checkout（源码）—— 两者顺序一致，没有偏离**：

| 环节 | rc.3 安装构建（`_l3-verify/evidence/_agent-team.js`） | checkout（`deepseek-harness` @ 0.2.2-alpha.2） |
|---|---|---|
| 席位上限检查抛错 | `1024`（`throw … TEAM_MEMBER_LIMIT`） | `roster.ts:257-259` |
| 成员行 `appendAndFlush` | `1025`（在 1024 **之后**） | `roster.ts:260` |
| `startActivation`（activation 池满在这里抛） | `1032` | `roster.ts:264` |
| catch → `settleProvisioning` | `1044-1057`（写 failed 行在 `1174`） | `roster.ts:276-296` → `447-465` |

`ACTIVATION_LIMIT_REACHED` 的抛出点本身在 `dsh-subagent`：安装 asar 里的 `ActivationPool.reserve()`
与 checkout `packages/subagent/subagent/src/activation.ts:24-35` **逐字相同**（`throw` 在 `slots.add`
**之前** → 失败**不**占 activation 槽），由 `manager.ts:744` 的 `pool.reserve(this.maxActiveSubagents())`
在 `materialize()` 最开始调用，早于任何成员行。**结论：按 checkout 的语义实现 = 按运行构建实现。**

**落地口径（新）**：`capacityRefusalBurned(hostCode)` 是唯一判断点；认不出的宿主码按「已烧掉」说
（宁可保守，也不给一个可能失败的「同名重试没问题」的承诺）。

**两句诊断原文（逐字，`envelope.diagnostics[0]`；`TEAM_MEMBER_LIMIT` 的形态以解析到 N 为例）**：

> `[CAPACITY_EXHAUSTED]` 宿主拒绝创建成员 `rt-cross-check`（hostCode=TEAM_MEMBER_LIMIT）：该名字没有被占用、
> 也没有消耗席位 —— 宿主在写成员行之前就拒绝了（宿主报的成员上限 1 席）
> `next_step`：先解决容量（复用空闲成员、等一个成员释放，或放宽 maxMembers），再用同名 `rt-cross-check` 重试

> `[CAPACITY_EXHAUSTED]` 宿主拒绝创建成员 `rt-cross-check`（hostCode=ACTIVATION_LIMIT_REACHED）：该名字与席位
> 已被烧掉，不得同名重试（D12）
> `next_step`：不要用同名重试（D12）；下一次派发会自动用下一个名字

**观测值口径不变但更准**：`basis.used_at_observation` 现在如实反映「这次拒绝有没有写下成员行」——
`TEAM_MEMBER_LIMIT` 不写，所以连续两次成员席位满的 `used` 相同（T18b-5 原先断言的 `2` 是替身假行的产物）。

**替身修正（这才是假绿的根）**：`fake-team.mjs` 的 `failNextSpawn({code})` 以前**一律**在写完
provisioning 行之后抛，于是注入的 `TEAM_MEMBER_LIMIT` 也留下一个 `failed` 行（名字与席位都被「烧掉」）。
现在按码选抛出点（`PRE_APPEND_SPAWN_CODES`）：`TEAM_LEAD_REQUIRED` / `TEAM_INVALID_MEMBER_NAME` /
`TEAM_MEMBER_NAME_TAKEN` / `TEAM_MEMBER_LIMIT` 在写行**之前**抛，其余（`ACTIVATION_LIMIT_REACHED`、
运行期故障）仍在写行**之后**。受影响并已更正的旧用例：T18b-2 / T18b-4 / T18b-5（它们曾靠那条假行把
`used` 顶到 ≥ 1；真实前提是「席位满只可能在 `used >= maxMembers >= 1` 时发生」，所以现在预置一名队友，
T18b-5 的 `used_at_observation` 如实改为 `1`）。

### 补记（T19，2026-10-30）：非焚烧类拒绝的**措辞**与**回执字段**

> ticket 的 T19 段（[`tickets/T19-T20-diagnostics-and-render.md`](tickets/T19-T20-diagnostics-and-render.md)）。
> 实现：`src/dispatch.ts`（`openCapacityGate()` 的拒绝文案、容量碰撞回执的 `member`、`parsedLimitDimension()`）。
> 用例：`test/t19-refusal-wording.test.mjs`（T19-1…5）。

1. **闸门拒绝文案按「上限是哪类拒绝教会的」分支**（`openCapacityGate()` 重读观测值那一段）：
   - `basis.host_code === 'TEAM_MEMBER_LIMIT'`（什么都没烧）→
     「宿主会在写成员行之前拒绝，名字与席位都不会被占用（同名重试仍然合法，T18c）」；
   - `ACTIVATION_LIMIT_REACHED` 与认不出的码 → 保留原文「不再创建成员（避免再烧一个名字与席位）」。
   判断仍只走 `capacityRefusalBurned()`（T18c 的唯一判断点），不新增第二套口径。
2. **`data.member` 只在焚烧类出现。** `TEAM_MEMBER_LIMIT` 没有写下成员行，回执点名 `rt-cross-check`
   等于承诺一个名册里不存在的对象；因此非焚烧类回执**不带** `member` 键，焚烧类照旧点名。
   **不能写 `member: null`**（ticket 的原文写法）：`$defs.failureData.member` 是 `$defs/text`
   （`string` / `minLength:1`），`null` 过不了 `$defs.result`，入口 `index.ts` 会把整封回执换成
   `RECOVERY_REQUIRED` —— 比原来的虚报更糟。T19-1 用入口同一条 `validateInput(schemaDefs,'result',…)`
   把这个形状钉住；要改成字面 `null`，必须先让规格允许（`docs/specs/**` 由 Lead 维护）。
   上面「落地口径」表里「`data.member` 点名被烧的成员」一行按本条收窄。
3. **typo**：`解析出的activation 池大小准确值` → `解析出的 activation 池大小准确值`
   （`parsedLimitDimension()` 对 Latin 开头的维度自带分隔空格；同一句里的
   「宿主消息里的 activation 池大小」也一并修正）。
4. **本票没动、但同样属于「看起来像虚报」的两处**（另立票，不要顺手改）：
   `capacityMarkerGuard()` 的「现在再派发可能再撞一次、再烧一个成员名与席位」与
   `capacitySourceGap('unknown')` 的「最多烧一个成员名与席位」—— 席位满一样烧不着。
   另外非焚烧类拒绝的回执仍带 `phase: 'member_ready'`（成员行其实没写），改它等于改阶段机语义。

### 裁决（Lead，2026-10-30）：接受 T19 的 `member` 偏差，不放宽规格

ticket 写的是「非焚烧类给 `member: null`」，**这条 ticket 要求本身是错的**：`$defs.failureData.member`
为 `$defs/text`，而入口按 `$defs.result` 校验整封回执，字面 `null` 会把回执整体降级成 `RECOVERY_REQUIRED`
（`data: null`）—— 比原来那句虚报更糟。验收口径取「**不带 `member` 键**」为「不点名」的唯一合法形式。

- **不放宽 `docs/specs/**`。** 为一个字段的写法去动 wire 契约，成本远大于收益；后续票不得以「规格允许 null」为由改动。
- T19-1 用入口同一条 `validateInput(schemaDefs,'result',…)` 钉住该形状，谁改回 `null` 即红。
- 记录人：T19；裁决人：Lead。本裁决**终结**该偏差，不再讨论。

> 顺带记一条方法教训：ticket 里只要出现「给某个字段填 `null`」，必须先用**入口的校验器**跑一遍形状再写进票里。
> 这次是子代理实测发现的，不是设计时发现的。

### 裁决（Lead，2026-10-30）：第三轮 L3 的 N1–N4 **决定不修**

出处：[第三轮记录 §4](../verify/records/20261030-session-c7189ebb.md)。记在这里是为了**不让下一个 agent 把它们当新 bug 重新提一遍**。

| 发现 | 结论 | 理由 |
|---|---|---|
| N1 `rt_roster(bind)` 对 `CAPACITY_UNKNOWN` 整体 `blocked` | **不修** | 拒绝**自解释**：`next_step` 指向「把容量声明放进 profile 的 `config.capacity`」；且传 call `capacity` 即可 bind（第三轮步 C 实测 `{2,2}` 成功）。与 D40 的差别只在**表述**——D40 讲的是 dispatch 侧，bind 侧仍按「不懂就别动」。已由 SEAMS §7 记清 `roster.json` 语义，**不**改闸门 |
| N2 `BASELINE_MISMATCH` 回执带 `phase: "integrating"` 但未写盘 | **不修** | 机读字段**无消费者**；改它要动 conclude 阶段机，风险大于收益 |
| N3 `re/team/roster.json` 的 `members`/`tasks` 恒为 `[]` | **只改文档** | 唯一有「被误当成员表」风险的项（它被 `linkIndexPointers` 链进 INDEX，算对外宣称）。但加写路径会新增并发与失败面，删字段要改 schema。已在 SEAMS §7 写明「这不是成员表」 |
| N4 契约 `hypothesis` 不随 post 变 | **不修（不是 bug）** | 契约**忠实复制**路线原文；原文里写了「triage 岗位」属路线内容问题，插件改写路线语义才是越界 |

T19 遗留的 5 处（非焚烧类仍带 `phase: 'member_ready'`、台账 `member_failed`、`capacityMarkerGuard` 措辞、unknown 的 next_step、`capacityFailureReason` 死路径）与 N2 同类——**无消费者的机读过度陈述**，一并**不修**。

> 判据（以后照这个拒绝顺手改）：**只有当「读的人会因此做错事」时才算 bug**。没人读的机读字段措辞、以及自解释的拒绝，属于噪声，不算。

### 裁决（Lead，2026-10-30）：preset 缺 `rt_*` 流程说明 —— 模型知道有工具却不用

**现象**（会话 `session-8e17d6d0`，preset 选的确实是 `redteam-lead`）：`rt_*` 调用 **0 次**，`pwsh` **44 次**，
`list_agents` 2 次，`spawn_teammate` 0 次。模型甚至在自述里写了「`rt_roster`/`rt_dispatch`/`rt_conclude` … I have them」，
知道自己有这三个工具，然后一次都没调。

**根因不是接线**，接线全对：`request/header` 里 263 个工具名含全部三个 `rt_*`；persona 前缀也确实注入了系统提示
（实测正文第 2 段就是它）。缺的是**流程**——宿主会自动注入约四段英文 Agent Teams 说明
（`spawn_teammate` / `send_message` / `team_task_*` / `wait_agent`，含「Shared-task workflow is …」这类分步指令），
而人设只写了「怎么说话」（挂锚点、别用推测填空），一个字没写「进项目先调 `rt_roster`」。**模型照有说明书的那套做事。**

**改法**：persona 前缀加「## 项目账目：rt_roster / rt_dispatch / rt_conclude」一段，写法对齐宿主的三个特征：
1. 角色规则一律**第三人称**（「Lead 负责派发与收口」「收到派发契约的那个成员按契约干活」）——因为工兵继承同一 persona，
   写「你是…」会把工兵说成 Lead；
2. 流程压成一句话，不展开成手册；
3. 只写规则与陷阱，不写理由（「`gaps` 为空不等于名册就绪；只有收据代表结论落定」）。

**为什么不写第二人称**：宿主自己的 Agent Teams 段也只写 "The Lead must wait for …"。
角色由 runtime context 注入（`You are the Team Lead named "lead"`），人设不重复声明，也就不可能把工兵说成指挥。

**回归保护**：`test/bundle.test.mjs` 的 persona 用例新增断言，要求前缀含三个工具名与「项目账目 / submission.json / 收据」。
原有两条中立性断言（不含「指挥」、不含「你是」）**未放宽**——是改措辞去满足它，不是改测试。

**未验证（重要）**：这条修复**没有**被任何正式用例证明有效，用例只查形状。要重启 DSH 后开新会话实测，
判据：`rt_*` 调用次数 > 0，且首个动作是 `rt_roster`。

### 补记（2026-10-30，据用户反馈）：人设改为「红队准则 + 委托 skill + 仅编排」

用户指出两条，都成立：

1. **与 skill 重复。** `reverse-project-management` skill 已经规定了「以 `INDEX.md` 为唯一总入口」「每轮闭环」
   「失败、超时、空结果与中断同样保留」「区分观察、推断、假设与未知」「引用运行和文件内定位」
   「`seal` / `impact` / `index` / `check --hashes` 的用法」。上一版人设把这套又写了一遍
   （INDEX.md、RUN 目录、失败也保留、引用来源、`check --hashes`）。**重复不只是啰嗦**：
   同一个 prompt 里两套说法并存，模型只能猜听谁的。→ 删掉重述，改成一句委托：
   项目记录结构 / RUN / 封存 / impact / 验收 / check 归 skill；本包只保留一条输出约束（结论挂锚点）。
2. **完全没有红队作业内容。** 上一版三段全是「怎么记账」，没有一个字讲「接到越界要求怎么办」。
   → 新增「## 红队作业准则」：授权范围（不清先问）、**不评价用户**（不评判动机、不说教、不掺无关道德评论）、
   **该拒绝就拒绝**（伪造/粉饰结论、补写篡改封存记录、隐瞒失败、越界 → 明说不做并给替代，不先答应再糊弄）、
   破坏性操作先说影响与回滚、失败如实记。

**分工原则**（以后不再混）：skill 管**项目账目怎么记**，本包人设管**作业纪律 + 编排（谁派谁收）**。
两段都不重述第三方的规定；本包只重述自己的输出约束。

**回归保护**：`test/bundle.test.mjs` 的 persona 用例相应改写——要求含「不评价用户 / 拒绝 / 授权 / 回滚 / 失败」，
要求点名 `reverse-project-management`，并**禁止**出现 skill 的操作原文（`INDEX.md`、`check --hashes`、`project.py`）。
委托句里点话题名（"封存、验收归 skill"）是允许的，只禁抄命令。
原中立性断言（不含「指挥」、不含「你是」）仍未放宽。

## D41 — 容量子系统整体删除：不再预测宿主上限，只照派 + 转述宿主原话

> 来源：用户裁决（2026-10-30）+ ticket [`tickets/T23-simplify-capacity.md`](tickets/T23-simplify-capacity.md)。
> 实现：删除 `src/capacity-source.ts`；`src/capacity.ts` 只剩 `planPosts()`；
> `src/team-adapter.ts` 的 `capacity()` → `usedSeats()`；`src/roster.ts` / `src/dispatch.ts` /
> `src/index.ts` 同步收窄；用例：删除 `t18-*` / `t18b-*` / `t18c-*` / `t19-refusal-wording`，
> 新增 `test/capacity-removed.test.mjs`（源码级删除断言）。

### 结论：D40 的**判定**保留，**机器**删除

- **保留**：容量未知**不拒绝**、**不主动探测**（不为了学上限而 spawn）。派发照派，宿主自己拒。
- **保留**：`used` 仍然从宿主 `listMembers` 数（`role === 'teammate'`，含失败成员）。
- **删除**：`re/team/capacity-observed.json` 与 `re/team/capacity-observing.json`、`parseHostCapacityLimit`、
  `capacityRefusalBurned` 的烧/不烧分类、五档优先级（`call`/`project`/`profile`/`observed`/`unknown`）、
  `re/team/capacity.json` 与 `profile config.capacity` 的读取、`reserved_member_slots`/`reserved_activations`。
- D40 那张五档表已在原处标「已废止」，原文未改写（历史记录，不再是口径）。

### 为什么（用户裁决的原始理由）

官方 Agent Teams **自己都不做容量规划**，上限还是**刻意藏起来**的：
`maxMembers` 是 `TeamService` 的构造函数参数（`config.maxMembers ?? DEFAULT_MAX_MEMBERS`），
**没有任何 getter 或 state 投影**，唯一用途是抛 `Team member limit N reached`（`TEAM_MEMBER_LIMIT`）；
`maxActiveSubagents` 在团队服务里**根本不存在**（activation 限制来自 subagent 层）。
**读不到是设计，不是我们没找到 API。** 四张票（T18/T18b/T18c/T19）都在给「预测一个宿主明确不给的数」
打补丁 —— 这本身就是过复杂的信号。所以整套推断机连同它的声明文件一起删掉。

### 删除后的语义（一段话）

> 名册报「已用几席」（来自 `listMembers`）与岗位状态；岗位能不能派只看**能力是否满足**（与操作者的
> `max_posts`）。派发直接调 `spawnTeammate`；宿主拒绝就返回 `CAPACITY_EXHAUSTED` + **宿主原话逐字**，
> 不猜上限、不声称"烧掉/损失了什么"。

### 落地面（读代码的人按这个，不要各写一套）

| 项 | 取值 |
|---|---|
| 岗位状态 | `assigned` / `vacant`（能力缺口）/ `deferred`（**只**因 `max_posts` 用尽）/ `disabled` |
| 缺口码 | `CAPABILITY_*`、`POST_DISABLED`、`CAPACITY_EXHAUSTED`（`max_posts`）。**不再有** `CAPACITY_UNKNOWN` / `CAPACITY_UNDECLARED` |
| 已用席位 | `rt_roster` 的一条诊断 `TEAM_SEATS_USED`（数不到 → `TEAM_SEATS_UNKNOWN`）；`rt_dispatch` 拒绝时附在诊断里 |
| 宿主拒绝 | `status=partial`、`code=CAPACITY_EXHAUSTED`、`data.phase=prepared`（成员身份未落台账）、诊断逐字含 `error.message` 与 `hostCode`；**不带** `data.member` |
| `rosterData.capacity` | wire 必备的 4 个键恒为「未知 / 不预留」：`remaining_*: null`、`reserved_*: 0` |
| `recommended_members` | 语义收窄为「本次提议需要**新建**成员的岗位数」（不再表示"预算内还能开几个"） |
| bind 闸门 | 只在 `max_posts` 放不下时拒绝（`CAPACITY_EXHAUSTED`）；容量不再参与 |
| 台账 | `capacity_source` / `capacity_max_*` / `capacity_diagnostics` 删；只留 `used_seats` 存证 |

> **2026-10-30 追加（T26）**：T25 已从 wire schema 删除 `rosterData.capacity` 与 `recommended_members`；
> 上表这两行**作废**，`roster.json` 与 `rt_roster` 返回都不再带它们，以
> [规格](../specs/rt-tools.schema.json) 与实现为准（本条不改写上表原文）。

### 与 specs 的冲突（**未**改 `docs/specs/**`，由 Lead 处置）

> **2026-10-30 追加（T26）**：本节记录 T23 当时的状态；T25 已删除下面 1、2 两条里的规格键并修改
> `docs/specs/**`，A09 也已由 `acceptance-matrix.md` 标为废止。以下仅作历史记录，不再是现行口径。

1. `docs/specs/rt-tools.schema.json` 仍声明 `rosterInput.capacity`、`dispatchInput.capacity`、
   `rosterData.capacity`（4 个必备整数/null 字段）、`rosterData.recommended_members`。
   `src/tool-schema.ts` 是它的**逐字副本**（有漂移用例），所以本票**没有删**这几个键：
   - 入参 `capacity` / `reserved_*` 仍会被校验放行，但收到就回一条诊断 `CAPACITY_ARGUMENT_OBSOLETE`（不静默忽略）；
   - 出参 `capacity` / `recommended_members` 照发（值见上表），否则 `$defs.rosterData` 过不了入口校验。
2. `docs/specs/orchestration-contract.md` 第 20 行的 `rt_roster` 行仍写着 `max_posts=6；reserved_member_slots=1；
   reserved_activations=2`；后两个已废止。
3. 验收 A09（"未知时不盲目 spawn"）与 D40 起就是**有意偏离**，T23 之后偏离更大（连"撞一次就学"也删了）。
   现状：未知照派、宿主拒绝即转述。要把它写回规格，需要 Lead 改 `acceptance-matrix.md` 与契约原文。

### 代价（如实记录）

- 删掉 4 个测试文件、改写 8 个；门禁用例数 603 → 569（净 -34）。
- 被删掉的能力是"下一次派发不再重复撞同一堵墙"。现在每次撞墙都会真的调用一次 `spawnTeammate`；
  宿主拒绝时**没有**任何本地记忆。这是用户明确接受的代价（"官方自己都不做容量规划"）。
- 名字是否还能复用**不再由本插件判断**：拒绝之后名册里有没有那一行由宿主决定，
  诊断只引导"先 `listMembers` 核对，再决定复用/换名"。D12 的"失败行占名"仍然有效，但只在**读名册之后**成立。

