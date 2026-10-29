# Spec：Rea-Multi-agent — 逆向团队的指挥架构

> 状态：修订版（本地文档，不发布到 GitHub Issue）
> 基线：DSH 0.2.1-rc.3 · 团队 profile `maxMembers: 8`（平台默认 16）· 宿主 `standard` preset 129 行
> 修订依据：`docs/reviews/2026-10-29-rea-multi-agent-spec-review.md`（逐条核对后修订，含对评审本身的更正）

## 术语

| 词 | 含义 |
|---|---|
| **岗位** | 班底模板里的一个角色定义（要不要人、要什么能力），开工前就存在 |
| **成员 / 工兵** | 岗位对应的实际 agent，具名、常驻、可续跑，占一个席位 |
| **席位** | 一个 Lead 会话内的成员名额（部署值 8，含创建失败的成员） |
| **空岗 / 空位** | 空岗 = 有岗位但缺工具能力；空位 = 有剩余席位但没建成员 |
| **路线（route）** | 项目里的一条分析线，有目标、有结论、有证死记录 |
| **锚点** | 可复跑的定位证据（地址、偏移、函数名、证据 ID、文件行号） |
| **收口** | 把工兵的结论与锚点写进路线记录并置任务完成 |

## Problem Statement

逆向是长拉锯。一次定位、一次反编译、一次动态验证动辄几十分钟到几小时，而当前只有一个 agent 在干活：发起一个耗时分析就只能停在那里等，本来可以同时探的岔路（静态、动态、协议）被一并串行化。

更麻烦的是执行与记录挤在一起。同一个 agent 干到一半上下文被压缩，前面挖出来的锚点就丢了——而逆向的价值恰恰在于**跑过之后留下了什么**：哪个函数、哪个地址、哪条证据支撑了哪个结论。

需要的是分工：主 agent 当指挥，拆路线、派任务、核对事实、写文档；一组工兵守各自的路线，干完带着证据回来。工兵不能再往下派发，否则编制失控、也没人对事实负责。

## Solution

新增一个 preset「红队指挥」和一个配套 bundle。

选中后，用户只要说清目标是什么（一个恶意样本、一个游戏客户端、一个 Web 应用），主 agent 会：判定目标类别 → 给出班底提议（岗位、每岗能力需求、当前缺口）→ 用户确认 → 建岗 → 对每个岗位派出一份书面契约 → 派完后继续核对已回证据、写文档、铺下一条路线 → 结论落进项目路线记录。

用户全程能看到名册与任务板（会话标题栏「智能体团队」面板），能点开任一工兵的会话看完整过程。

## User Stories

**入口与安装**

1. As a 逆向操作者, I want 在模式选择器里看到「红队指挥」并选中它, so that 我进入团队模式而不影响现有的「红队逆向」单人模式
2. As a 逆向操作者, I want 整个升级是一个可本地 link 安装、可一步移除的 bundle, so that 它坏掉时我不至于重装整个 DSH
3. As a 逆向操作者, I want 现有「红队逆向」preset 一个字节都不被改动, so that 我随时能退回已经调通的工作方式
4. As a 逆向操作者, I want 缺少团队服务时工具给出可读诊断而不是静默消失, so that 我不会对着一排不存在的工具怀疑人生

**班底与建岗**

5. As a 逆向操作者, I want 主 agent 先判定目标类别（binary / game / webapp / mixed）再提议班底, so that 岗位跟着目标走而不是每次现编
6. As a 逆向操作者, I want 班底提议里每个岗位都标注它需要的工具能力族, so that 我在开工前就知道哪个岗位此刻是空岗
7. As a 逆向操作者, I want 缺工具的岗位被显式标记、并被要求"缺什么报什么"而不是自己找替代, so that 我不会收到一堆无法复跑的编造结论
8. As a 逆向操作者, I want 班底提议受剩余席位与剩余 activation 额度双重约束, so that 建岗时不会把零碎活的通道一起堵死
9. As a 逆向操作者, I want 混合目标（比如带在线校验的游戏）也能组出班底, so that 不必为了迁就模板把目标硬切成两类
10. As a 逆向操作者, I want 主 agent 在已有同岗成员时复用而不是新建, so that 席位不被无谓烧掉（席位在一个会话内不可回收）

**派发契约**

11. As a 逆向操作者, I want 每次派发都落成一份结构化契约（路线、目标、必需锚点、产物路径、禁止事项、时限、依赖、能力需求）, so that 事后能审计"到底要求了什么"
12. As a 逆向操作者, I want 完整契约写进工兵 prompt、任务板只存摘要, so that 不会被任务描述 16384 字符的上限截断
13. As a 逆向操作者, I want 派发当场就把任务交给成员（变为进行中）, so that 后续收口不会撞状态机
14. As a 逆向操作者, I want 主 agent 派发后必须立刻找到下一件可独立推进的事, so that 它不会盯着第一个工兵发呆
15. As a 逆向操作者, I want 只有真的无路可走时才允许 `wait_agent`, so that 阻塞成为例外而不是常态
16. As a 逆向操作者, I want 工兵被要求边干边把发现追加进产物文件, so that 上下文被压缩之后它还读得回来
17. As a 逆向操作者, I want 工兵卡住时必须交回一条具体技术问题而不是"没搞出来", so that 主 agent 能立刻判断该换路线还是换人
18. As a 逆向操作者, I want 派发失败/超时由主 agent 处置而不是插件自动重试, so that 钱不会烧在同一个错误前提上

**收口与记录**

19. As a 逆向操作者, I want 工兵交回结论时同时交回可复跑锚点（地址、偏移、函数名、证据 ID、文件行号）, so that 我能自己验一遍
20. As a 逆向操作者, I want 结论落进项目的路线记录而不只是任务板, so that 会话结束后证据还在
21. As a 逆向操作者, I want 任务板负责"谁在干什么"，`re/` 负责"证死了没有、凭什么", so that 两个问题各有各的载体
22. As a 逆向操作者, I want 收口时强制重算封存哈希, so that 被覆盖的证据基线会在收口处暴露
23. As a 逆向操作者, I want 派发与收口留审计记录, so that 出了争议能回溯是谁在什么时候要求了什么

**边界与例外**

24. As a 逆向操作者, I want 一个逆向项目严格对应一个 Lead 会话, so that 班底不跨项目串味（席位按会话计，换会话即清零）
25. As a 逆向操作者, I want 零碎活走一次性子代理而不占席位, so that 常驻岗位的上下文不被垃圾污染
26. As a 逆向操作者, I want 团队模式下没有命令拦截, so that 我不会再被莫名其妙的拦截打断
27. As a 逆向操作者, I want DSH 自带的工具全部保留（shell、文件、搜索、Web、技能、后台任务、定时、计划模式、workflow）, so that 团队模式不是一个被阉割的壳
28. As a 逆向操作者, I want 工兵无法创建任何下一层 agent, so that 编制不会指数级炸开
29. As a 逆向操作者, I want 能中断一个跑飞的工兵而不清空它的收件箱, so that 我可以纠正方向再让它继续
30. As a 逆向操作者, I want 能点开工兵的会话读它的完整过程, so that 出问题时不用靠猜
31. As a 逆向操作者, I want Web 应用逆向（侦察、指纹、bundle、接口发现）在范围内, so that 目标带着在线组件时不必换工具
32. As a 逆向操作者, I want Web 攻击动作暂不实现但预留岗位, so that 以后补工具时不用改架构

## Implementation Decisions

### 分发形态

交付物是一个 **bundle**（npm 包 + `dsh.bundle.patch` 指向的 patch 文件），本地 `link:` 安装进 profile 的 `dsh.profile.bundles`，与既有 `@local/dsh-rea-plugin` 同形态。

**零个 `@deepseek-ai/*` 运行时 import**：本地 link 的 bundle 按自身真实路径解析裸包名，`import '@deepseek-ai/...'` 会 `ERR_MODULE_NOT_FOUND`。工具参数一律用原始 JSON Schema（对象级 `required: [...]`）。每个工具必须显式声明 `output.schema` 与 `render`，注册表按该 schema 校验返回值；入参校验由本包自己完成。

包内三样：一个 preset 行、两个工具插件（班底 / 派发收口）、一行人设。

### 安装前置

本 bundle 依赖 `@deepseek-ai/dsh-experimental-agent-team-profile` **已启用**——它随安装提供但**默认关闭**（列在 `OPTIONAL_BUNDLES` 里，package.json 无 `disabled` 元数据字段，只能靠 bundle 成员资格开启）。它同时带来 `ctx.agentTeams`、九个团队工具和 `ui-agent-team` 面板。

本包插件 `inject: ['tools', 'agentTeams', 'agentPresets']`。服务缺失时工具插件会**静默 pending 而不是报错**，所以必须有显式诊断：首次调用返回"团队服务未启用，请把 `@deepseek-ai/dsh-experimental-agent-team-profile` 加入 profile bundles"。

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
| `pwsh` / `bash`、`fs`、`fs_search`、`jobs`、`skill`、`web`、`todo`、`time-context`、`rt_conclude` | `rt_roster`、`rt_dispatch`、`workflow` |

平台**没有**"按成员裁工具"的一等能力，而工兵继承整个 preset。因此：

- 工兵手里的 `spawn_teammate` / `subagent` / `workflow` 全部**能看见但一调就抛错**。这不是安全洞（见下），但会白烧一个 step，所以派发契约里要明写"你没有派发权，缺人就报回来"。
- 真正的边界是 **depth**：`childDepth = delegationDepthOf(parent) + 1`，工兵自身是 depth 1，再往下创建就是 depth 2，而 `maxDepth` 默认 1 → 抛 `SubagentDepthError`。`subagent` 与 `workflow` 两条路都走这个判断（`workflow` 传 `parent: this.parent`，即调用者）。
- **`maxDepth` 是唯一的技术保证**。团队 patch 行没写这个值，它来自平台默认；谁把它调成 2，"工兵不能派发"会静默失效。进升级复核清单。

### 班底模板

四个内置模板（`binary` / `game` / `webapp` / `mixed`），每模板是岗位数组，每岗包含：标识、显示名、关注面、能力需求族、默认验收锚点类型、该岗禁止事项。

- 模板可扩编，但新增岗位必须给出能力需求族，否则派发时无法检查空岗。
- `mixed` = 取交集 + 保留空位。

### 能力族与匹配

能力族固定枚举（可增补但需同步文档）：`shell`、`fs`、`search`、`jobs`、`web`、`skill`、`mcp:<server>`、`binary-static`、`binary-dynamic`、`web-recon`、`browser`、`db`、`reserved`。

匹配是纯函数：`matchCapabilities(needs: string[], toolNames: string[]): Gap[]`。工具注册表只以**名字数组**传入，不作为替身对象——这样"注入某工具族不可用"就是一次纯函数调用。

### 派发契约字段

必填：`route`、`objective`、`target`、`deliverable_path`、`evidence_required`、`prohibited`。
可选：`timebox_ms`、`context`（fresh / fork）、`depends_on`、`capability_needs`。

- **完整契约写进 `spawn_teammate.prompt`**（该字段无长度上限），任务板 `subject`（≤200）与 `description`（≤16384）**只放摘要**。长度按 trim 后的 UTF-16 长度计算。
- `send_message` 单条上限 65536 **字节**，计量的是含前缀信封的 JSON 串，不是正文。
- 契约必须写入三条行为规矩：边干边落盘、卡住交具体问题、缺工具就报缺。

### 任务板状态机（决定派发与收口的形状）

任务板不是自由状态机，必须按它的真实转移设计：

- `create` 产出 `pending` 且**无 owner**；
- `reassign`（仅 Lead）把任务交给成员的同时置 `in_progress` 并写 owner；指派具体成员时要求 `taskReady()`（依赖全完成），清空 owner 退回 `pending` 时不检查依赖；
- `complete` 要求 `status === 'in_progress'`，且调用者是 owner 或 Lead；
- 因此**"pending 且有 owner"不可达**。

于是：`rt_dispatch` = `createTask` → `reassign(task, member)` → 回执带 `task_id` + `revision` + `member` + `route`。工兵完工后自己 `complete`（它是 owner）；`rt_conclude` 在工兵没交回时兜底：先读任务校验 owner/revision，再 `complete`。

**任何"派发后是 pending"的假设都是错的**，验收必须按 `in_progress` 断言。

`depends_on` 映射到 `blockedBy`，且 blocker 必须是已存在的任务（否则 `TEAM_TASK_NOT_FOUND`）。给成员派一个依赖未完成的任务会抛 `TEAM_TASK_BLOCKED`——要么等依赖完成再派，要么先建无 owner 的任务。

### 失败与超时

- 任务 owner **不会**因中断、失联或成员失败而自动释放。成员 `failed` 后它的 `in_progress` 任务仍被占用，别人 `claim` 报 `TEAM_TASK_ALREADY_CLAIMED`。
- 所以 Lead 处置卡活的**第一个动作是先解绑**（`reassign` 给别的成员，或清空 owner 退回 `pending`），再重派。
- 平台**没有超时回调**。`timebox_ms` 只能由 Lead 在下一轮读任务板时判断，然后 `reassign` / `send_message`。插件不自动重试。
- `interrupt_agent` 只停当前 turn，保留收件箱与成员身份；返回的 `previousStatus` 枚举是 `{running, inactive}`（空闲成员被中断返回 `inactive`）。

### 双账本

- 任务板 = 执行层，存在 Lead 会话日志里，随会话生命周期结束。
- `re/` = 事实层，随项目存活：路线、证据、证死记录、封存。
- `rt_dispatch` 一次写两处；`rt_conclude` 把完成态同步进路线记录。一致性写在工具实现里，不靠人设自觉。

### 席位与并发（一笔账，不是两笔）

团队成员和裸子代理**共用同一个 activation 池**（`maxActiveSubagents` 默认 8），超了直接抛 `ACTIVATION_LIMIT_REACHED`，**没有等待队列**；根 agent 不占名额。团队席位 `maxMembers` 部署值 8、平台默认 16，**含创建失败的成员**，在一个 Lead 会话内不可回收（Team 身份 = Lead 会话 id，换会话即清零）。

所以班底规划是一笔账：

```
岗位数 + Lead 零碎活并发 + 失败重试预留 ≤ 8
```

实际建议岗位 ≤ 6。**8 个常驻工兵在场时，零碎活一个都派不出去**——这条进已知限制，不能只说"subagent 自己有上限"。

### 证据基线

既有 guard 的证据保护（拦 `re/samples`、`re/seals` 的写）与命令拦截共用同一个 `pre-execute` 钩子和同一个 `scopePresets` 白名单；新 preset 不在白名单 → 两者一起失效。

本包的选择：**不新增任何拦截钩子，改由 `rt_conclude` 强制重算封存哈希并拒绝不一致的收口**。篡改在收口处暴露，而不是在执行处被挡。这与"团队模式没有命令拦截"一致。

### 锚点闭集

- `va` / `rva` 必须带模块名 + 宿主文件 `sha256`；
- `file_offset` 必须带文件 `sha256`；
- `evidence_id` 必须附导出证据包路径 + `sha256`——REA 的 evidence id 是**会话内**的，跨会话不可解析，单独出现不构成锚点。

`rt_conclude` 按闭集校验，缺锚点或锚点不完整一律拒收。

### 载体与审计

- 岗位 ↔ 成员 ↔ 席位的映射落在 `re/team/roster.json`（v0）：`{post, member_name, task_id, state, created_at}`，`state` 含 `vacant`。成员名遵循平台规则（`^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64、≠`lead`、全局不复用），建议 `rt-<post>` / `rt-<post>-2`。
- 空岗/空位**不进任务板**（没有成员就没有 owner，建不出空岗任务），只由 `roster.json` 的 `state: vacant` 与 `rt_roster` 的 `gaps` 表达。
- 审计写 `re/team/audit.jsonl`（append-only），字段 `at / kind / route / task / member / requester / verdict`。`$DSH_HOME/redteam/audit/` 已被既有包占用，不复用。审计失败不改变判定。

### 边界

- 本包不注册任何 `tools/pre-execute` 拦截、不新增命令扫描工具、不写拦截审计。
- **既有包的三个工具仍然存在**：`rt_scan_command` / `rt_shadow_status` / `rt_project_state` 由既有 `@local/dsh-rea-plugin` 在 **host 面**注册，对所有 preset 可见（含 `standard`）。要让它们消失得在 profile 里把对应行 `disabled: true`，这是独立的 profile 层决定，不在本包范围。
- 既有包的 `tools/post-execute` 提示钩子不受 preset 白名单约束，团队模式下仍会出现影子模式提示与项目缺口提示——无害，但验收里不要当作"门闸还在"。
- Web 攻击动作不实现；对应岗位存在但能力声明为空，派发时标为空岗。

### 项目记录

沿用既有逆向项目管理约定：`INDEX.md` 为总入口，`re/` 下按路线组织，证据以封存形式累积。`rt_dispatch` 创建或更新路线，`rt_conclude` 写入结论与证据引用。

## Testing Decisions

**两层，两个接缝。**

### 第一层：工具处理器（自动，`node --test`）

所有决策逻辑通过三个工具处理器暴露，测试直接调它们。替换的输入只有两样：**团队服务**（名册、任务板、spawn）与**项目文件系统**；工具注册表以**名字数组**传入，是数据不是替身。

团队服务用**契约级替身**，必须实现已核实的对外契约：成员角色 `lead|teammate`、`spawnTeammate` 只接受 lead、任务板状态机（`pending` 无 owner / `reassign` 指派即 `in_progress` / `complete` 要求 `in_progress` / `TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_BLOCKED` / 依赖未完成不可 claim）、`expected_revision` CAS、成员名规则与席位上限。替身与真服务的偏差由第二层兜住。

好测试的标准：给一个项目状态和一个派发请求，断言**可观察结果**——路线被创建还是复用、任务板条目变成什么状态与 owner、有没有成员被创建、返回的缺口清单是什么。不断言内部函数名、日志文案、调用顺序。

覆盖：
- 班底提议：四个模板岗位非空、每岗能力需求非空；`mixed` 产出交集；注入"某工具族不可用"时缺口正确；
- 席位账：已用席位 + 零碎活额度超过 8 时提议被压缩并给出理由；
- 派发：同岗有空闲成员时不新建；无成员时新建一次；契约缺字段时拒绝；能力缺口写进 prompt；**派发后任务为 `in_progress` 且 owner 正确**；
- 失败处置：成员 `failed` 后其任务仍被占用，`rt_dispatch` 拒绝重派并提示先解绑；
- 收口：结论与锚点写进路线；任务转 `completed`；重复收口被拒；`pending` 任务收口被拒（状态机保护）；
- 锚点闭集：缺 `sha256` 的地址锚点、无导出路径的 `evidence_id` 被拒；
- 封存哈希：`rt_conclude` 重算发现不一致时拒绝收口。

**先例**：沿用既有插件包的测试风格——`node --test` + 显式文件路径、临时目录搭项目状态、I/O 集中在边界、纯函数优先。

### 第二层：真服务验收（半自动，一次性会话）

必须跑真实的 `ctx.agentTeams`。它不能塞进 `node --test`：宿主包只在打包的 `app.asar` 内，磁盘上没有 `@deepseek-ai/dsh-tools` 的可用入口（`app.asar.unpacked` 下虽有三个 `@deepseek-ai` 目录，但其中只有 `libreoffice-kit` 是完整 JS 包，与本主题无关），裸 `node` 也无法从 asar require。所以在一**个专门的一次性 DSH 会话**里执行——真实服务、真实 spawn、真实会话日志。

1. 建临时项目目录，装好 bundle，用「红队指挥」开会话；断言 `request/header.tools` **含** `rt_roster`/`rt_dispatch`/`rt_conclude` 与团队九工具，**不含** `tool-subagent-control` 带来的同名工具。
2. 调 `rt_roster` → 岗位数 ≥ 4、每岗能力需求非空、缺口清单与当前工具注册表一致。
3. 调 `rt_dispatch` 派一个岗 → `list_agents` 出现该成员且 `role=teammate`；`team_task_list` 里该任务为 **`in_progress`** 且 owner 是该成员；`re/` 出现对应路线；回执的路线号/任务号能对上。
4. 对同一岗再派一次 → `list_agents` 成员数**不变**；任务板多一条任务；`re/team/roster.json` 里该岗位的 member 不变。
5. 用裸 `subagent` 起一个一次性子代理，让它调 `rt_dispatch` → 被拒且**无成员/任务副作用**；同时验证它调 `spawn_teammate` / `subagent` / `workflow` 均因 depth 抛错。
6. 调 `rt_conclude` → 任务转 `completed`、路线记录出现结论与锚点、审计多一条。
7. `interrupt_agent` 中断该工兵 → `previousStatus ∈ {running, inactive}`、成员仍在名册、用带 nonce 的 `send_message` 唤醒并在回报里看到 nonce。

会话一次性，验收完即丢——席位按会话计，丢弃即释放，但重跑会在新会话再建成员。验收记录（会话 id、`list_agents` 与 `team_task_list` 原始输出、路线与审计文件的 SHA-256）提交到 `docs/verify/`。

## Out of Scope

- 不改动既有 `redteam` preset 与 `@local/dsh-rea-plugin` 的源码或配置（含不替它关掉 `rt_*` 三工具）
- 不做命令门闸、命令审计、危险命令检测
- 不做 Web 攻击能力（重放、注入、越权、凭据管理、扫描器）
- 不做嵌套团队——平台按成员角色硬拦，且 depth 挡住一切下一层创建；本包只额外返回可读拒绝原因
- 不按成员裁剪工具面——平台没有这个一等能力，靠 depth + 可读拒绝 + 契约明写
- 不做队友模型档位选择（`SpawnTeammateRequest` 无此参数，模型继承 Lead）
- 不做自定义 UI（复用团队插件自带面板）
- 不做派发自动重试
- 不做跨项目的班底迁移
- 不发布 GitHub Issue；本 spec 为唯一书面依据

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

1. `maxDepth` 是否仍为 1——**这是"工兵不能派发"的唯一技术保证**，改了会静默失效。
2. `maxActiveSubagents` 与团队席位是否仍共享同一个池。
3. 团队 `maxMembers` 部署值与平台默认值；席位是否仍随会话重置。
4. `standard.patch.yml` 行清单与副本 diff；插件包是否改名。
5. 团队工具是否仍"按成员身份"注册；`TEAM_LEAD_REQUIRED`、`ACTIVATION_LIMIT_REACHED`、`TEAM_TASK_*` 等错误码是否变化。
6. 任务板状态机是否仍是"`reassign` 指派即 `in_progress`、`complete` 要求 `in_progress`"。
7. persona `complete` 语义与 `team:policy` 段的可追加性。
