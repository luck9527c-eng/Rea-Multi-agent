# Spec：Rea-Multi-agent — 逆向团队的指挥架构

> 状态：补充评审问题已落实到规格（2026-10-29；插件实现与运行验收待做）
> 基线：DSH 0.2.1-rc.3 · 团队 profile `maxMembers: 8`（平台默认 16）· 宿主 `standard` preset 129 行
> 修订依据：`docs/reviews/2026-10-29-rea-multi-agent-spec-review.md`（逐条核对后修订，含对评审本身的更正）
> 配套依据：[项目管理协作契约](project-management-integration.md)；工具清单由 skill 维护，插件只读消费。兼容目标固定为 Desktop 0.2.1-rc.3，接口已对照源码对应 release tag 的文档核对；见[DSH 接口核对](../reviews/2026-10-29-dsh-interface-check.md)，真实 Desktop 运行验收仍待做。
> 具体定义：[编排契约](orchestration-contract.md)、[工具发现与文档](tool-discovery.md)、[工具 JSON Schema](rt-tools.schema.json)、[岗位目录](roster-catalog.json)、[验收矩阵](acceptance-matrix.md)。

## 术语

| 词 | 含义 |
|---|---|
| **岗位** | 班底模板里的一个角色定义（要不要人、要什么能力），开工前就存在 |
| **成员 / 工兵** | 岗位对应的实际 agent，具名、常驻、可续跑，占一个席位 |
| **席位** | 一个 Lead 会话内的成员名额（部署值 8，含创建失败的成员） |
| **空岗 / 空位** | 空岗 = 有岗位但缺工具能力；空位 = 有剩余席位但没建成员 |
| **路线（route）** | 项目里的一条分析线，有目标、有结论、有证死记录 |
| **锚点** | 可复跑的定位证据（地址、偏移、函数名、证据 ID、文件行号） |
| **收口** | Lead 核对交付，按项目 skill 归档、封存并更新事实记录，通过检查后完成本轮任务；不等于路线成立或项目完成 |

## Problem Statement

逆向是长拉锯。一次定位、一次反编译、一次动态验证动辄几十分钟到几小时，而当前只有一个 agent 在干活：发起一个耗时分析就只能停在那里等，本来可以同时探的岔路（静态、动态、协议）被一并串行化。

更麻烦的是执行与记录挤在一起。同一个 agent 干到一半上下文被压缩，前面挖出来的锚点就丢了——而逆向的价值恰恰在于**跑过之后留下了什么**：哪个函数、哪个地址、哪条证据支撑了哪个结论。

需要的是分工：主 agent 当指挥，拆路线、派任务、核对事实、写文档；一组工兵守各自的路线，干完带着证据回来。工兵不能再往下派发，否则编制失控、也没人对事实负责。

## Solution

新增一个 preset「红队指挥」和一个配套 bundle。

选中后，用户只要说清目标是什么（一个恶意样本、一个游戏客户端、一个 Web 应用），主 agent 会：判定目标类别 → 给出班底提议（岗位、每岗能力需求、当前缺口）→ 用户确认 → 建岗 → 对每个岗位派出一份书面契约 → 派完后继续核对已回证据、写文档、铺下一条路线 → 结论落进项目路线记录。

用户全程能看到名册与任务板（会话标题栏「智能体团队」面板），能点开任一工兵的会话看完整过程。

### 与 reverse-project-management 配合

本插件管理团队执行；`reverse-project-management` 管理项目事实、证据与验收。沿用实际分析仓库的 INDEX、项目配置、路线/RUN/条件/争议格式及 seal/impact/index/check/audit-scope，不在插件中复制封存算法或另建路线状态。

工兵负责在独立工作区持续记录执行事实，Lead 作为唯一整合者核对、归档、封存和更新共享正式记录。skill 的团队协作规则描述工作方式，插件实现成员交付、资源归属、重入恢复和确定性检查；skill 文本本身不提供锁或事务。

具体接口、路径、提交/验收顺序及兼容性以 [项目管理协作契约](project-management-integration.md) 为本 spec 的组成部分。新项目初始化项目副本，旧项目按差异合并，不覆盖已有副本。本插件开发仓库不自动初始化为分析项目。

## User Stories

**入口与安装**

1. As a 逆向操作者, I want 在模式选择器里看到「红队指挥」并选中它, so that 我进入团队模式而不影响现有的「红队逆向」单人模式
2. As a 逆向操作者, I want 整个升级是一个可本地 link 安装、可一步移除的 bundle, so that 它坏掉时我不至于重装整个 DSH
3. As a 逆向操作者, I want 现有「红队逆向」preset 一个字节都不被改动, so that 我随时能退回已经调通的工作方式
4. As a 逆向操作者, I want 缺少团队服务时仍能从包内独立自检入口取得可读诊断, so that 工具未注册时也有可执行的修复指引

**班底与建岗**

5. As a 逆向操作者, I want 主 agent 先判定目标类别（binary / game / webapp / mixed）再提议班底, so that 岗位跟着目标走而不是每次现编
6. As a 逆向操作者, I want 班底提议里每个岗位都标注它需要的工具能力族, so that 我在开工前就知道哪个岗位此刻是空岗
7. As a 逆向操作者, I want 缺工具的岗位被显式标记、并被要求"缺什么报什么"而不是自己找替代, so that 我不会收到一堆无法复跑的编造结论
8. As a 逆向操作者, I want 班底提议受剩余席位与剩余 activation 额度双重约束, so that 建岗时不会把零碎活的通道一起堵死
9. As a 逆向操作者, I want 混合目标（比如带在线校验的游戏）也能组出班底, so that 不必为了迁就模板把目标硬切成两类
10. As a 逆向操作者, I want 主 agent 在已有同岗成员时复用而不是新建, so that 席位不被无谓烧掉（席位在一个会话内不可回收）

**派发契约**

11. As a 逆向操作者, I want 每次派发都落成一份结构化契约（路线、目标、必需锚点、产物路径、禁止事项、时限、依赖、能力需求）, so that 事后能审计"到底要求了什么"
12. As a 逆向操作者, I want 完整契约先持久化、工兵收到带摘要哈希的引用、任务板只存摘要, so that 新建和复用成员都能取得同一份完整要求且不受消息长度限制
13. As a 逆向操作者, I want 派发当场就把任务交给成员（变为进行中）, so that 后续收口不会撞状态机
14. As a 逆向操作者, I want 主 agent 派发后必须立刻找到下一件可独立推进的事, so that 它不会盯着第一个工兵发呆
15. As a 逆向操作者, I want 只有真的无路可走时才允许 `wait_agent`, so that 阻塞成为例外而不是常态
16. As a 逆向操作者, I want 工兵按项目 skill 在独立工作区边干边保存计划、运行事实与原始产物, so that 上下文被压缩之后它还读得回来且不与其他成员争写共享记录
17. As a 逆向操作者, I want 工兵卡住时必须交回一条具体技术问题而不是"没搞出来", so that 主 agent 能立刻判断该换路线还是换人
18. As a 逆向操作者, I want 派发失败/超时由主 agent 处置而不是插件自动重试, so that 钱不会烧在同一个错误前提上

**收口与记录**

19. As a 逆向操作者, I want 工兵交回结论时同时交回可复跑锚点（地址、偏移、函数名、证据 ID、文件行号）, so that 我能自己验一遍
20. As a 逆向操作者, I want 结论落进项目的路线记录而不只是任务板, so that 会话结束后证据还在
21. As a 逆向操作者, I want 任务板负责"谁在干什么"，`re/` 负责"证死了没有、凭什么", so that 两个问题各有各的载体
22. As a 逆向操作者, I want 收口复用项目 skill 的一次性 seal 与 check --hashes 并核对来源, so that 不覆盖旧基线，也不把结构完整误当成结论成立
23. As a 逆向操作者, I want 派发与收口留审计记录, so that 出了争议能回溯是谁在什么时候要求了什么

**边界与例外**

24. As a 逆向操作者, I want 一个逆向项目同一时刻只绑定一个 Lead 会话，换会话时显式恢复与接管, so that 事实记录可以延续而旧成员/任务句柄不会误用于新团队
25. As a 逆向操作者, I want 零碎活走一次性子代理而不占席位, so that 常驻岗位的上下文不被垃圾污染
26. As a 逆向操作者, I want 团队模式下没有命令拦截, so that 我不会再被莫名其妙的拦截打断
27. As a 逆向操作者, I want DSH 自带的工具全部保留（shell、文件、搜索、Web、技能、后台任务、定时、计划模式、workflow）, so that 团队模式不是一个被阉割的壳
28. As a 逆向操作者, I want 工兵无法创建任何下一层 agent, so that 编制不会指数级炸开
29. As a 逆向操作者, I want 能中断一个跑飞的工兵而不清空它的收件箱, so that 我可以纠正方向再让它继续
30. As a 逆向操作者, I want 能点开工兵的会话读它的完整过程, so that 出问题时不用靠猜
31. As a 逆向操作者, I want Web 应用逆向（侦察、指纹、bundle、接口发现）在范围内, so that 目标带着在线组件时不必换工具
32. As a 逆向操作者, I want Web 攻击动作暂不实现但预留岗位, so that 以后补工具时不用改架构
33. As a 逆向操作者, I want 插件复用项目内 reverse-project-management 的规则、格式与检查命令, so that 团队模式和单人模式共享事实记录，升级共享 skill 不覆盖旧项目
34. As a 逆向操作者, I want 工兵交付与 Lead 验收分开、前提按路线和条件核查, so that 任务板完成不提前放行无效证据或冒充项目完成

## Implementation Decisions

### 分发形态

交付物是一个 **bundle**（npm 包 + `dsh.bundle.patch` 指向的 patch 文件），本地 `link:` 安装进 profile 的 `dsh.profile.bundles`，与既有 `@local/dsh-rea-plugin` 同形态。

**零个 `@deepseek-ai/*` 运行时 import**：本地 link 的 bundle 按自身真实路径解析裸包名，`import '@deepseek-ai/...'` 会 `ERR_MODULE_NOT_FOUND`。工具参数一律用原始 JSON Schema（对象级 `required: [...]`）。每个工具必须显式声明 `output.schema` 与 `render`，注册表按该 schema 校验返回值；入参校验由本包自己完成。

包内三样：一个 preset 行、两个工具插件（班底 / 派发收口）、一行人设。

### 安装前置

本 bundle 依赖 `@deepseek-ai/dsh-experimental-agent-team-profile` **已启用**——它随安装提供但**默认关闭**（列在 `OPTIONAL_BUNDLES` 里，package.json 无 `disabled` 元数据字段，只能靠 bundle 成员资格开启）。它同时带来 `ctx.agentTeams`、九个团队工具和 `ui-agent-team` 面板。

缺服务诊断固定使用包内只读 `bin/doctor.mjs`，命令及配置就绪/运行就绪的区分见编排契约；它不依赖团队插件已注册。rt_roster 挂载后再检查真实服务。可选注入只作体验优化，不是唯一诊断路径，不承诺未注册的工具能返回错误。

分析项目另需接入项目内 `reverse-project-management` 副本及团队规则，Python 与现有 CLI 可用。兼容性、路径及版本绑定按协作契约检查；缺失时报告缺口，不自动覆盖项目副本。

### preset 与工具面

- 新 preset id `redteam-lead`，显示名「红队指挥」，`order: 6`。既有 `redteam` 不动，模式列表新增一行。
- **工具清单以宿主 `standard.patch.yml` 的 `plugins:` 段为基线整段复制**（这是"能力不被阉割"的落地），但**必须删掉两行**：

  | 删除 | 原因 |
  |---|---|
  | `tool-subagent-control` | 提供的 `send_message` / `interrupt_agent` 与团队工具**同名**，语义不同（前者按 `agent_id` 找会话，后者按 `target` 找成员） |
  | `tool-subagent-list-agents` | 提供的 `list_agents` 与团队工具同名 |

  团队 profile 停用的是 **host 面**那四行，而 `standard` 又在自己的 `config.plugins` 里重声明同名 id——预设是独立组合树，不删就会从 agent 平面重新装回来，把 Lead 的 `send_message` 变成"发给会话"。

- 保留 `tool-subagent`、`tool-subagent-fork`、`workflow-ptc`、`tool-workflow`（工兵用不上，Lead 用于零碎活）。
- 这份清单是**手抄副本、没有 extends**。宿主升级改名/改 Config 的表现是 preset 挂载失败（roster 里仍在、带 broken 诊断），不会自动跟随。复核方式是重新从 asar 抽 `standard.patch.yml` 与副本 diff。

### 人设与角色

人设**角色中立**：写共同准则（证据驱动、锚点、不臆测、卡住说清），不写"你是指挥"。原因是工兵继承 Lead 的 preset、也就继承同一条人设，而 runtime context 会给工兵注入 `You are teammate "<name>"`——写死指挥口吻会让两者打架。

角色差异由三处承载：

1. runtime context 的 `team:identity` 段（平台注入）；
2. 团队工具描述里的 `teamPolicy`（平台自带）；
3. 本包 `rt_dispatch` 生成的派发契约（任务级规矩）。

persona 行必须 `complete: false`，否则会把 `team:policy` 段吃掉。

### 工兵工具面

| 工兵应有 | 工兵不应有 |
|---|---|
| shell、文件、搜索、后台任务、skill、Web 等既有能力（实际工具名见目录）、只读 rt_roster | `rt_roster` 的 bind/takeover、`rt_dispatch`、`rt_conclude`、`workflow` |

v0 选择由工兵继承 preset，并在执行端拒绝越权；不实施按岗裁剪。rc.3 tag 文档已有 Agent 作用域 tools.restrict 接口，不能再把“不裁剪”解释成平台完全不支持；scope-local 注册还有独立规则，见接口核对。因此：

- 工兵可见的 `spawn_teammate` 由团队服务检查 Lead 身份，调用会拒绝；裸 `subagent` / `workflow` 另受其委派策略限制。派发契约仍明写“你没有派发权，缺人就报回来”，避免无效调用。
- 对原基线的本地裸委派路径，`childDepth = delegationDepthOf(parent) + 1`；在工兵 depth=1 且有效 maxDepth=1 时，再创建触发 `SubagentDepthError`。这是具体部署条件，不是所有 provider 或未来版本的统一保证；进入实现时须按目标版本复验各入口。
- **裸 subagent/workflow 路径仍须核实并限制 `maxDepth`**。它不能代替团队服务自身的 Lead 授权检查；团队 patch 未显式设值时还需核实部署默认，不能把更深层创建会失败当成永远成立。进升级复核清单。
- 本包变更操作另做 Lead 身份校验；工兵提交工作区产物并通知，不自行完成任务或验收事实。工具面仍继承，写入归属是团队协作契约，不新增命令门闸。

### 班底模板

四个内置模板 binary/game/webapp/mixed 的岗位清单、required/optional 能力、默认锚点、禁止事项及优先级以[岗位目录](roster-catalog.json)为唯一数据源。environment 按需加入，web-attack 显式 disabled。

- 模板可扩编，但新增岗位必须给出能力需求族，否则派发时无法检查空岗。
- mixed 至少指定两个目标类别，按 post_id 取并集、以优先级和 ID 稳定排序，再按实际预算裁剪；缺能力、预算延后与未实现分别展示。完整算法见编排契约，不固定要求岗位数 ≥4。

### 能力族与匹配

静态能力族以岗位目录的 capabilities 为准；mcp:<server> 需项目显式绑定，reserved 不作为可执行能力。匹配规则及项目覆盖格式见编排契约。

匹配是纯函数：`matchCapabilities(needs, toolNames, inventory, bindings): CapabilityMatchResult`。显式输入实际注册名、工具清单快照、默认目录和项目映射，返回 matched/missing 与 provider 引用，不依赖可变全局映射或注册表替身。本地 IDA/Ghidra 等可通过已验证入口及 shell/Python 调用配方接入，不要求额外挂 MCP；具体数据契约见[工具发现与文档](tool-discovery.md)。

它只检查结构性可用性；独立就绪判定沿用项目 skill 的四层环境规则，按入口/执行者/session/target 区分。模板必需需求不可删减，缺注册或已知不适配时无副作用拒绝。只能在新成员验证的就绪项先用 bootstrap 做无害检查，未通过时保留已用席位并返回 partial，不开始实验。默认精确别名和需项目绑定的专用能力已在目录及编排契约中定义，不猜测 provider。

工具发现合并实际 DSH MCP 注册表、PATH、Windows 应用注册与项目指定目录（如 `D:\Tool`）。由工程管理 skill 指导 agent 维护 `re/env/tools.json`、生成 `tools.md` 并按需验证/刷新/提醒；需要辅助脚本时放在 skill 内。插件只读清单做能力匹配与派发前检查，inspect 保持只读，不增加刷新 action。正式 RUN/契约绑定不可变 ENV-tools 快照。现有 skill probe 尚无专用目录扫描和生成命令。

### 派发契约字段

必填：`operation_id`、`post_id`、`route_id`、`objective`、`target_ids`、`evidence_required`、`prohibited`，并引用路线的问题/判据/预算与项目规则版本。插件生成尝试身份、工作目录与 RUN ID 预留，不接受任意共享写入路径。
可选字段、默认值与完整输入/输出以工具 JSON Schema 和编排契约为准，包括 timebox_ms、delivery_timeout_ms、depends_on_tasks、附加 capability_needs/resource_needs、retry_of。v0 不提供 context=fresh|fork。路线依赖来自 route.depends_on，不与宿主 task ID 混用。

- **完整契约先写入 dispatch 记录**，新建和复用成员都用交付信封取得路径/摘要哈希。新成员初始 prompt 只加载角色与项目入口并等待任务身份，不在指派完成前执行实验。任务板 `subject`（≤200）与 `description`（≤16384）**只放摘要**。长度按 trim 后的 UTF-16 长度计算。
- `send_message` 单条上限 65536 **字节**，计量的是含前缀信封的 JSON 串，不是正文。
- 契约必须写入三条行为规矩：边干边落盘、卡住交具体问题、缺工具就报缺。

### 任务板状态机（决定派发与收口的形状）

任务板不是自由状态机，必须按它的真实转移设计：

- `create` 产出 `pending` 且**无 owner**；
- `reassign`（仅 Lead）把任务交给成员的同时置 `in_progress` 并写 owner；指派具体成员时要求 `taskReady()`（依赖全完成），清空 owner 退回 `pending` 时不检查依赖；
- `complete` 要求 `status === 'in_progress'`，且调用者是 owner 或 Lead；
- 因此**"pending 且有 owner"不可达**。

于是：`rt_dispatch` 按协作契约持久化身份，完成 `createTask` → `reassign(task, member)` → 交付契约引用；成功回执带 `task_id` + `revision` + `member` + `route_id` + dispatch/attempt 身份。同岗空闲复用，忙碌拒绝。工兵只提交结果；Lead 调 `rt_conclude` 通过项目 skill 的归档/封存/校验后再 `complete`，不把完成权交给工兵正常流程。

**成功派发回执对应 in_progress**。部分失败的中间阶段可能只有 pending task，必须返回 partial 与阶段，不能当成功派发验收。

`depends_on_tasks` 映射到 `blockedBy`，blocker 必须是已存在任务且已完成；路线/条件前提还须按 skill 独立核查。v0 前提未满足时无副作用拒绝，不建等待队列。任务 completed 只表示本轮交付已处理，不能代替有效 validated 或条件版本判断。

原生 complete 绕过协议时标记未验收，不把它作为事实层依赖；Lead 补验仍执行全部收口检查，最后核对已完成态，不重复 complete。重复收口按 operation ID 返回原回执，内容冲突才拒绝。

### 失败与超时

- 任务 owner **不会**因中断、失联或成员失败而自动释放。成员 `failed` 后它的 `in_progress` 任务仍被占用，别人 `claim` 报 `TEAM_TASK_ALREADY_CLAIMED`。
- Lead 先撤销旧 attempt 的提交资格，按 skill 恢复规则核查旧成员、后台任务及资源，再解绑/重派。新尝试用新目录和 RUN ID，迟到提交不覆盖当前产物；解绑 owner 不证明旧执行已停止。
- 平台**没有超时回调**。`timebox_ms` 只能由 Lead 在下一轮读任务板时判断，然后 `reassign` / `send_message`。插件不自动重试。
- `interrupt_agent` 只停当前 turn，保留收件箱与成员身份；返回的 `previousStatus` 枚举是 `{running, inactive}`（空闲成员被中断返回 `inactive`）。

### 双账本

- 任务板 = 执行层，存在 Lead 会话日志里，随会话生命周期结束。
- `re/` = 事实层，随项目存活；正式结构与判据由项目 skill 定义，`re/team/` 仅保存编排身份、交付和回执。
- `rt_dispatch` 关联路线与任务；`rt_conclude` 整合运行、判定和影响，不把任务完成态直接复制成路线结论。操作阶段、重入、部分失败与响应丢失按协作契约恢复；本地文件和宿主之间不假装有原子事务。

### 席位与并发（共同约束）

团队成员和裸子代理**共用同一个 activation 池**（`maxActiveSubagents` 默认 8），超了直接抛 `ACTIVATION_LIMIT_REACHED`，**没有等待队列**；根 agent 不占名额。团队席位 `maxMembers` 部署值 8、平台默认 16，**含创建失败的成员**，在一个 Lead 会话内不可回收（Team 身份 = Lead 会话 id，换会话即清零）。

班底能不能派只看两件事：**能力是否满足**与操作者的 `max_posts`。宿主不公开成员/activation 上限（`maxMembers` 没有 getter，activation 限制由 subagent 层强制），本插件不预测、不预留、也不为「学一次上限」而试探；已用席位只作为一条诊断如实报出（来自宿主名册，含失败成员），不参与裁剪。默认 `max_posts=6` 是操作者愿意在一次提议里保留的岗位数，不是对宿主能创建多少成员的预测；被拒时按宿主原话返回 `CAPACITY_EXHAUSTED`。完整口径见[协作契约](orchestration-contract.md)「岗位目录与预算裁剪」。

### 证据基线

既有 guard 的证据保护（拦 `re/samples`、`re/seals` 的写）与命令拦截共用同一个 `pre-execute` 钩子和同一个 `scopePresets` 白名单；新 preset 不在白名单 → 两者一起失效。

本包的选择：**不新增任何拦截钩子，复用项目 skill 的一次性 seal 和 check --hashes**，拒绝相对既有封存不一致的收口。先核对原始来源，再建立新 RUN 的封存；不覆盖旧 seal，不实现第二套哈希基线。可发现与保留基线不一致，不能抵抗基线和校验器被同时重写。

### 锚点闭集

编排契约定义 binary_location/source_location/web_capture/runtime_event/evidence_export/artifact_locator 六类，统一引用 skill 的 RUN/artifacts/locator，类型内容保存在证据产物中。目标、模块、内容身份、运行实例、Web 保存响应及会话导出分别有明确最低字段；函数名、URL、会话 evidence ID 单独不成立。

交付结果按 finding/no_finding/refuted/blocked/budget_exhausted/failed/cancelled 分类，各类证据要求、允许的路线变化与依赖含义均见编排契约。未执行即阻塞不编造 RUN；失败不自动证死。派发基准快照绑定目标和既有 seal，收口检查旧项删除与变更；哈希与结构不能替代人工来源和推理审阅。

### 载体与审计

- 岗位 ↔ 成员 ↔ 当前任务的映射落在 `re/team/roster.json`，历史任务指向独立 dispatch 记录；项目/session 绑定、attempt 工作区、回执和资源归属见协作契约。`state` 含 `vacant`。成员名遵循平台规则（`^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64、≠`lead`，在所属团队内不复用），建议 `rt-<post>` / `rt-<post>-2`。
- 空岗/空位**不进任务板**，仅在 roster 提议、disabled/deferred/vacant 状态与 gaps 中表达；pending task 只可能是一次真实派发的中间状态，不用来占位。
- 审计写 `re/team/audit.jsonl`（append-only），字段 `at / kind / route / task / member / requester / verdict`。`$DSH_HOME/redteam/audit/` 已被既有包占用，不复用。审计失败不改变判定。

### 边界

- 本包不注册任何 `tools/pre-execute` 拦截、不新增命令扫描工具、不写拦截审计。
- **既有包的三个工具仍然存在**：`rt_scan_command` / `rt_shadow_status` / `rt_project_state` 由既有 `@local/dsh-rea-plugin` 在 **host 面**注册，对所有 preset 可见（含 `standard`）。要让它们消失得在 profile 里把对应行 `disabled: true`，这是独立的 profile 层决定，不在本包范围。
- 既有包的 `tools/post-execute` 提示钩子不受 preset 白名单约束，团队模式下仍会出现影子模式提示与项目缺口提示——无害，但验收里不要当作"门闸还在"。
- Web 攻击动作不实现；对应岗位显式 disabled 并说明未实现，不参与可用岗位与能力非空测试，派发时拒绝。

### 项目记录

沿用实际分析仓库内 reverse-project-management：`INDEX.md` 为总入口，路线与 RUN/条件/争议分别维护。插件通过项目管理 adapter 使用现有脚本，Lead 审阅后写入结论和影响；阶段交接执行全部历史路线关联审计，项目完成另过 check --hashes --complete。具体职责与顺序见协作契约。

## Testing Decisions

**三层：工具处理器、真实项目 skill 集成、真实团队服务。** 项目 skill 与宿主团队分别验收，避免两份替身互相证明。

### 第一层：工具处理器（自动，`node --test`）

所有编排决策通过三个工具处理器暴露，测试直接调它们。接缝为**团队服务**（名册、任务板、spawn/消息）、**项目文件系统**与**项目管理 adapter**（项目副本 CLI 及事实检查）；工具注册表以名字数组传入。封存/来源链算法不在插件替身中重写，使用下一节的真实 skill 集成兜住。

团队服务用**契约级替身**，必须实现已核实的对外契约：成员角色 `lead|teammate`、`spawnTeammate` 只接受 lead、任务板状态机（`pending` 无 owner / `reassign` 指派即 `in_progress` / `complete` 要求 `in_progress` / `TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_BLOCKED` / 依赖未完成不可 claim）、`expected_revision` CAS、成员名规则与席位上限。替身与真服务的偏差由第三层兜住。

好测试的标准：给一个项目状态和请求，断言任务状态与 owner、成员是否被创建、缺口和回执、正式记录及基线是否正确。路线由 Lead 先建为可执行问题，前置拒绝不新建路线。不断言内部函数名、日志文案或无意义调用顺序。

覆盖：
- 班底提议：各模板可用岗位非空、必需能力非空，disabled 预留岗不算可用；mixed 合并去重并报告预算裁剪后的缺口；工具缺失时缺口正确；
- 席位账：`max_posts` 裁剪与 `deferred`/`CAPACITY_EXHAUSTED`；已用席位（含失败成员）只作 `TEAM_SEATS_USED` 诊断（数不到则 `TEAM_SEATS_UNKNOWN`），不预测、不预留，宿主拒绝时按原话透传；
- 派发：同岗空闲复用、忙碌拒绝；缺能力/前提时无副作用；新建和复用都交付契约引用；**成功派发后任务为 in_progress 且 owner 正确**；
- 失败处置：成员 failed 后其任务仍被占用，未核查恢复与撤销旧尝试前拒绝 retry；恢复后只创建新 attempt，不误复用旧产物；
- 收口：Lead 经 adapter 归档/封存/校验后完成任务；工兵调用拒绝；重复请求返回原回执，内容冲突拒绝；pending 收口拒绝；原生提前完成必须补验；
- 锚点闭集：缺 `sha256` 的地址锚点、无导出路径的 `evidence_id` 被拒；
- 封存哈希：`rt_conclude` 重算发现不一致时拒绝收口。
- 恢复与隔离：同请求阶段失败/响应丢失恢复不重复建岗，无法确认则需核查；旧 attempt 不污染新结果，共享独占资源不并行使用。

**先例**：沿用既有插件包的测试风格——`node --test` + 显式文件路径、临时目录搭项目状态、I/O 集中在边界、纯函数优先。

三层的具体输入、断言和失败注入场景见[验收矩阵](acceptance-matrix.md)；矩阵是计划，不代表运行测试已通过。

### 第二层：真实项目 skill 集成（自动，不依赖 DSH）

用临时分析项目和非可执行测试数据，调用真实项目副本的 init/seal/impact/index/check/audit-scope，验证独立暂存、串行归档、失败/中断结果、来源和封存复用、条件变更与下游复查、会话绑定和完成门槛。具体场景见协作契约；现有 skill 单测不代替插件适配测试。

### 第三层：真团队服务验收（半自动，一次性会话）

必须跑真实的 `ctx.agentTeams`。它不能塞进 `node --test`：宿主包只在打包的 `app.asar` 内，磁盘上没有 `@deepseek-ai/dsh-tools` 的可用入口（`app.asar.unpacked` 下虽有三个 `@deepseek-ai` 目录，但其中只有 `libreoffice-kit` 是完整 JS 包，与本主题无关），裸 `node` 也无法从 asar require。所以在一**个专门的一次性 DSH 会话**里执行——真实服务、真实 spawn、真实会话日志。

1. 建临时分析项目并接入项目 skill，装好 bundle，用「红队指挥」开会话；检查 rt 三工具及团队工具可用，用解析后的参数或行为区分同名工具来源，不能仅靠工具名集合。另在缺团队服务环境验证可达诊断。
2. 调 rt_roster → 项目副本兼容、各可用岗位需求非空、缺口与当前能力相符，岗位数随目标与预算变化。
3. Lead 先按 skill 建立可执行路线，调 rt_dispatch → 成员 role=teammate，任务 in_progress 且 owner 正确；契约/路线/任务/尝试身份相符，首派不会提前实验。
4. 先完成同岗首个任务的验收，再派下一任务 → 成员数不变、task_id 变化、成员收到新的完整契约；忙碌重派另测为拒绝。
5. 真实 teammate 调 rt_dispatch/rt_conclude → 身份拒绝且无副作用；用真实 teammate 验证下一层创建受限。裸子代理另测，区分工具不存在与 depth 拒绝，不以它代替成员身份测试。
6. 工兵只提交独立工作区产物，Lead 调 rt_conclude → 真实 skill 归档/封存/校验通过、任务 completed、路线记录与实际判定相符、审计多一条；校验失败不得完成。
7. `interrupt_agent` 中断该工兵 → `previousStatus ∈ {running, inactive}`、成员仍在名册、用带 nonce 的 `send_message` 唤醒并在回报里看到 nonce。

会话一次性，验收完即丢——席位按会话计，丢弃即释放，但重跑会在新会话再建成员。验收记录（会话 id、`list_agents` 与 `team_task_list` 原始输出、路线与审计文件的 SHA-256）提交到 `docs/verify/`。

## Out of Scope

- 不改动既有 `redteam` preset 与 `@local/dsh-rea-plugin` 的源码或配置（含不替它关掉 `rt_*` 三工具）
- 不做命令门闸、命令审计、危险命令检测
- 不做 Web 攻击能力（重放、注入、越权、凭据管理、扫描器）
- 不做嵌套团队——平台按成员角色硬拦，且 depth 挡住一切下一层创建；本包只额外返回可读拒绝原因
- v0 不按岗位裁剪工具面；这是范围选择。团队操作靠可信身份授权，裸委派另受 depth 约束，契约补充说明
- 不做队友模型档位选择（`SpawnTeammateRequest` 无此参数，模型继承 Lead）
- 不做自定义 UI（复用团队插件自带面板）
- 不做派发自动重试
- 不做跨项目的班底迁移
- 不做自动跨会话团队迁移；项目事实保留，显式接管前核查旧执行
- 不重写 reverse-project-management 的路线/RUN/封存/复查算法，不自动覆盖已有项目 skill 副本
- 不发布 GitHub Issue；本 spec、项目管理协作契约、编排契约、工具 Schema、岗位目录和验收矩阵共同构成插件设计依据；按内容分别维护，不重复定义。项目事实规则以绑定的项目 skill 副本为准

## Further Notes

### 被平台事实定死的三条

1. **席位按会话计，不回收。** `TeamId(id) { return id; }`——Team 身份就是 Lead 会话 id，名册是会话投影，新会话从 0/8 起算。会话内不可删除、不可改名、不可复用，失败的成员也占位。
2. **席位与 activation 名额是同一个池。** 团队 spawn 与裸 `subagent` 都走 `reserve(maxActiveSubagents)`，超了直接抛、不排队。所以"派完自动收通知"也不成立——任务完成只满足 `wait_agent` 的等待者，不向 Lead 投递消息。
3. **团队工具按成员身份注册，不按 preset。** 九个工具装给每个成员（含 teammate），三个 Lead-only 操作在服务层按角色拒绝。所以 Lead 身份与选哪个 preset 无关；带 subagent descriptor 的普通子代理既不是 Lead 也不是成员，拿不到团队工具。

### 评审更正记录

评审的多数结论成立，以下五处需要更正，已并入正文：

- **"工兵能通过 `workflow` 开非团队子代理"——不成立。** `workflow` 传 `parent: this.parent`（调用者自身），depth 加一后超限，与 `subagent` 同一下场。
- **"`reassign` 要求任务 `ready`"——不准确。** `taskReady()` 只在"指派具体成员"分支检查；`ready` 不是状态，是派生布尔。
- **"九个工具装给每个成员"被标为事实错误——过重。** 结论与机制都描述对了，属措辞层级问题。
- **"`send_message` 上限 65536"——不完整。** 计量的是含前缀信封的 JSON 字节数，不是正文。
- **引用的"某会话无 `subagent`"证据与本会话不符**（本会话两者都在），该证据行不作为硬依据。

另补评审未提的两处：既有 guard 的 `scopePresets` 有两个逃逸口——为空时**全拦**，`preset === 'unknown'` 时**跳过白名单**。

### 升级 DSH 后的复核清单

1. 核实团队服务的 Lead 授权和裸 subagent/workflow 的 depth 策略；maxDepth 是否仍为 1，不把可见性或平台默认当作所有委派路径的统一保证。
2. `maxActiveSubagents` 与团队席位是否仍共享同一个池。
3. 团队 `maxMembers` 部署值与平台默认值；席位是否仍随会话重置。
4. `standard.patch.yml` 行清单与副本 diff；插件包是否改名。
5. 团队工具是否仍"按成员身份"注册；`TEAM_LEAD_REQUIRED`、`ACTIVATION_LIMIT_REACHED`、`TEAM_TASK_*` 等错误码是否变化。
6. 任务板状态机是否仍是"`reassign` 指派即 `in_progress`、`complete` 要求 `in_progress`"。
7. persona `complete` 语义与 `team:policy` 段的可追加性。
