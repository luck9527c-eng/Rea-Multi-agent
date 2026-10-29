# 评审：`docs/specs/rea-multi-agent.md`

- 评审对象：本仓库 `docs/specs/rea-multi-agent.md`（204 行，状态「待评审」）
- 评审日期：2026-10-29
- 核对基线：DSH 0.2.1-rc.3（宿主打包在 `D:\Apps\DSH\resources\app.asar`），profile `desktop`（`C:\Users\Administrator\.dsh\profiles\desktop`），既有插件 `@local/dsh-rea-plugin`（`D:\workSpace\DSH\redteam-preset`）
- 方法：逐条把 spec 里的平台断言与宿主实现对照（只读解包 asar + 读 profile 组合 + 一次真实的团队服务会话观察），再把设计逻辑、可测性、接口与体例分轴评审

## 结论

方向成立，可以按它开工，但**不能按现在的文字开工**：spec 有 **4 处事实错误**、**5 处设计硬伤**（其中两处会让第二层验收必然失败），另有一组欠定项和体例问题。改动量约 15 处文字 + 3 张表（能力族枚举、工具契约、失败处置），不需要推翻架构。

优先级统计：

| 级别 | 含义 | 条数 |
|---|---|---|
| P0 | 不改就会返工或验收假红 | 7 |
| P1 | 开工前必须定，否则实现时必然现编 | 9 |
| P2 | 体例、表达、可判定性 | 6 |

一句话概括最要紧的三件事：**①任务板状态机接不上「派发—收口」，②工兵会继承 Lead 的 preset 与人设（于是「工兵不能派发」「证据不被改写」两条承诺都落空），③命令门闸删掉的同时把证据基线保护也删掉了，而 spec 只承认了一半代价。**

---

## 一、事实核对：平台断言 vs 宿主实现

判定：✅ 成立 ｜ ⚠️ 需改写 ｜ ❌ 事实错误

| # | spec 断言 | 判定 | 实情与证据 |
|---|---|---|---|
| 1 | L194「席位终身不回收，只减不增」/ L172「成员永久占位」 | ⚠️ | 席位的范围是**一个 Lead 会话**：`TeamId = SessionId`（`@deepseek-ai/dsh-experimental-agent-team/README.zh.md:127`）。会话内确实不回收（无删除/改名/复用，失败成员也占位，`:61,206`）；换会话即换 Team，新会话 0/8。写成「终身」「永久」会被读成全局池。 |
| 2 | L43/L122「8 个终身席位」 | ⚠️ | 8 是**部署值**：团队 profile `maxMembers: 8`（`@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:21`），平台默认 **16**（`dsh-experimental-agent-team/lib/index.js:1421`）。 |
| 3 | L71「工兵调不动派发工具」/ L183「平台按成员角色硬拦」 | ❌ | 九个团队工具对**每个成员**都注册，包括 `spawn_teammate`；拦截发生在服务层抛 `TEAM_LEAD_REQUIRED`（`dsh-experimental-agent-team/lib/types/roster.js:209-211`）。结论对、机制错。 |
| 4 | L69「命令门闸彻底消失、连检测工具也不留」 | ❌ | 拦截只对 `scopePresets` 生效，新 preset 下确实关闭（`redteam-preset/index.js:457-459`）；但 `rt_scan_command` / `rt_shadow_status` / `rt_project_state` 由 **Host 面**注册，对所有 preset 可见——本会话（preset=standard）工具目录里就有这三个（`session.v4.jsonl.zstd` 的 `request/header.tools`）。要它消失只能 `disabled: true` 该行或 `ctx.tools.restrict({deny:[…]})`。 |
| 5 | L160「`app.asar.unpacked` 下没有 `@deepseek-ai`」 | ❌ | 实际有 3 个：`dsh-session-log-export`、`libreoffice-kit`、`libreoffice-kit-win32-x64`（`D:\Apps\DSH\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\`），但都只有 native 片段、入口仍在 asar 内。「无本地可 import 副本」的结论成立。 |
| 6 | L88「工具清单取宿主 `standard` preset 的全量行」 | ⚠️ | 可行但只能整段手抄：`standard.patch.yml` 在 asar 内，`plugins:` 共 L11–L129，preset 声明无 extends/include（`@deepseek-ai/dsh-agent-preset/lib/index.js:14-20`）。照抄会带回 `tool-subagent-control` / `tool-subagent-list-agents`，它们提供的 `send_message` / `interrupt_agent` / `list_agents` 与团队工具**完全同名、语义不同**。 |
| 7 | L166 步骤 3「`team_task_list` 出现该任务且 `status=pending`」 | ❌ | 与 L122「派给成员」矛盾：把任务交给成员只能走 `reassign`，它要求任务 ready 并直接置 `in_progress` + owner（`dsh-experimental-agent-team/lib/types/task-board.js:157-171`）；`pending` 只存在于无人认领的瞬间。 |
| 8 | L170 步骤 7「`interrupt_agent` 返回 `previousStatus=running`」 | ⚠️ | 字段存在，枚举 `{running,inactive}`（`dsh-experimental-tool-agent-team/lib/index.js:184-192`）；空闲成员被中断返回 `inactive`。 |
| 9 | L195「任务完成不会唤醒 Lead，只有 `wait_agent` 的等待者会被满足」 | ✅ | 成立。补充：任何 Team 变更（roster、任务、消息接收、成员 running/inactive）都会满足 waiter（`agent-team/README.zh.md:141`），且 `wait_agent` 只回 `{timedOut}`（`lib/index.js:49-52`），不告诉你是哪种变化。 |
| 10 | L196「任何 preset 的根 agent 天然都是 Lead」 | ⚠️ | 成立但有两个前提：团队服务必须已挂载；**带 subagent descriptor 的子级既不是 Lead 也不是成员**，拿不到团队工具（`roster.js:63-97`）。 |
| 11 | L89「Host 面权限不在本包重复声明」 | ✅ | 成立且方向正确。preset 内声明服务会因 `Preset services require isolate realms` 挂载失败（`dsh-agent-preset-registry/lib/index.js:231`）；带 isolate 的实例对 Host 面消费者不可见，等于无效。 |
| 12 | L82「零个 `@deepseek-ai/*` 运行时 import」 | ✅ | 实测：在 `D:\workSpace\DSH\redteam-preset` 里 `import('@deepseek-ai/dsh-tools')` → `ERR_MODULE_NOT_FOUND`；profile `node_modules` 也只有 `@local`。 |
| 13 | L90 persona scope-only、必须挂 preset | ✅ | 准确（`@deepseek-ai/dsh-persona/README.zh.md:29,117`）。**补一条硬约束**：人设行必须 `complete: false`，否则 `team:policy` 提示段会被吃掉（`README.zh.md:50`）。 |
| 14 | L26「会话标题栏的『智能体团队』面板」 | ✅ | 成立，但依赖独立包 `@deepseek-ai/dsh-experimental-client-ui-agent-team`（行 `ui-agent-team`），由团队 profile 插入。 |
| 15 | L96-98 三工具方案（plugin 注册 + 查名册/建任务/ spawn） | ✅ | 可行：宿主团队工具自己就是这么做的——`inject: ['agents','agentTeams','tools','systemPrompt']`，`ctx.agentTeams.spawnTeammate(exec.agent, …)`（`dsh-experimental-tool-agent-team/lib/index.js:10-15, 251-292`）。前提见 P0-4。 |
| 16 | L140-152 第一层「只替换两样东西」 | ⚠️ | 与实际需要不符：能力匹配要读工具注册表（第三个输入），而 L148 又要求「注入某工具族不可用」。见 P2-4。 |

---

## 二、P0：开工前必须改

### P0-1 三个工具与任务板状态机接不上（会让验收步骤 3/6 必失败）

现状：`rt_dispatch` 建一条 `pending` 任务 → `rt_conclude` 想把它「置为完成」。但 `complete` 要求 `status === 'in_progress'` 且调用者是 owner 或 Lead（`task-board.js:104-107,146-149`）。派发后任务若无人认领，收口必然抛 `TEAM_TASK_INVALID_TRANSITION`；若 `rt_dispatch` 用 `reassign` 派给成员，状态立刻是 `in_progress`（验收步骤 3 的 `pending` 就不成立）。

改法（二选一，写死）：

- **A（推荐）**：`rt_dispatch` = `createTask` → `reassign(task, member)` → 回执带 `task_id` + `revision` + `member`。工兵 prompt 里带 `task_id`，要求它完工后自己 `complete`（owner 有权）。`rt_conclude` 只在工兵没交回时兜底：`getTask` 校验 `owner/revision` → `complete`。
- **B**：只 `createTask`，prompt 带 `task_id`，由工兵 `claim`；`pending` 只是派发瞬间的状态，验收断言改为「任务存在且 owner 为空，工兵 claim 后变 `in_progress`」。

无论哪种，都要写清：**任务 owner 不会因中断/失联/进程退出自动释放**（`agent-team/README.zh.md:207`），Lead 只能 `reassign`；任务板上限 `maxTasks: 256`。

### P0-2 工兵继承 Lead 的 preset 与人设 → 两条承诺同时落空

取证：子代理**省略 preset 时加入父方当前 preset 代际**（`@deepseek-ai/dsh-subagent/README.zh.md:66`；实现 `lib/index.js:339-383` 的 `composeFrom(childCtx, parent.ctx)`）。团队 spawn 不传 `agentPreset`（`roster.js:237-247`），所以工兵 = 同一套 preset 行 + 同一条 persona。

后果：

1. 工兵手里有 `rt_*`（若工具放 preset 内）、`subagent_fork`、`workflow`、以及本包的派发工具（服务层会拒，但工具可见）。US 28 只挡住了「团队席位」，挡不住「一个工兵开 20 个裸子代理」。
2. 人设是**指挥口吻**（"主 agent 当指挥"）时，工兵也会读到它，与 runtime-context 的 `You are teammate "<name>"` 打架（`dsh-experimental-tool-agent-team/lib/index.js:246`）。
3. 更危险的是它把「工兵不能派发」实现成「靠底层抛错」，而不是「靠工具面 + 身份校验」。

改法：

- persona 写成**角色中立**（"你是逆向团队的一员；指挥与工兵的职责差异由 runtime context 与派发契约给出"），或在派发 prompt 里显式覆盖角色。
- 在「班底与建岗」里加一张**工兵工具面表**：明确工兵应该有 `pwsh`/`fs`/`fs_search`/`jobs`/`skill`/`web`/`todo`/`rt_conclude`，不应有 `rt_roster`/`rt_dispatch`；`subagent`/`subagent_fork`/`workflow` 去留必须决定（去掉则 US 25 的零碎活只能由 Lead 做；保留则要写「工兵可开裸子代理，不进编制也不进席位」）。
- 在「已知限制」写清：宿主没有「按成员裁工具」的一等能力，`ctx.tools.restrict` 需要在 agent 作用域内调用；本包若做不到，US 28 由 `rt_dispatch` 的身份校验兜底，而不是靠不可见。

### P0-3 删命令门闸 = 连证据基线保护一起删掉（spec 只承认了一半）

既有 guard 的 `protect-evidence`（`re/samples`、`re/seals` 的 `write/edit` 拦截）与危险命令拦截共用同一个 `pre-execute` 钩子和同一个 `scopePresets` 白名单（`redteam-preset/index.js:453-478`）。新 preset 不在白名单 → **两条一起关闭**。而 Further Notes L200 只写了「失去对不可撤销操作的唯一技术兜底」，没有写「证据基线可被任何工兵直接覆盖」。

改法（必须选一个，不能留白）：

- 在新 bundle 里实现最小等价保护（`pre-execute` 钩子 + 只对 `re/samples`/`re/seals`/`re/seals/**` 的 `write/edit` 拒绝，按 preset 白名单 `redteam-lead` 生效，审计复用既有目录）；
- 或者把「证据基线不设技术保护，靠 `re/seals` 的 hash 校验在收口时发现篡改」写进设计，并在 `rt_conclude` 里强制重算封存哈希。

顺带：既有 guard 的 `tools/post-execute` 钩子**不受 preset 白名单约束**（`index.js:504-534`），团队模式下广告式的影子模式提示与项目缺口提示仍会出现——这是无害的，但验收里不要把它当「门闸还在」。

### P0-4 团队 profile 是硬前置，spec 一个字没写

`ctx.agentTeams` 由 `@deepseek-ai/dsh-experimental-agent-team-profile` 提供，该包「随安装提供但默认关闭」；未启用时三个 `rt_*` 工具的 `inject` 不满足 → 整行失活，症状是「工具莫名消失」而不是报错。当前 desktop profile 已把它列在 `dsh.profile.bundles` 第 5 项（`C:\Users\Administrator\.dsh\profiles\desktop\package.json:9-15`）。

改法：在「分发形态」加一节**安装前置**：断言 `@deepseek-ai/dsh-experimental-agent-team-profile` 已在 `dsh.profile.bundles`、已启用且 `list_agents` 可用；本包插件 `inject: ['tools','agentTeams','agentPresets']`，服务缺失时返回可读诊断而不是静默失活；团队面板依赖 `ui-agent-team` 行。

### P0-5「照抄 standard 全量行」需要一处删行与一套漂移诊断

照抄会带回 `tool-subagent-control`（全局 `send_message`/`interrupt_agent`）与 `tool-subagent-list-agents`（`list_agents`），与团队工具同名。两个 scope 谁遮蔽谁没有文档保证，属实现期必炸的坑。

改法：基线 = `standard.patch.yml` 的 `plugins:`（L11–L129）整段复制，**删除 `tool-subagent-control` 与 `tool-subagent-list-agents` 两行**，保留 `tool-subagent`(→`subagent`)、`tool-subagent-fork`、`workflow-ptc`、`tool-workflow`。写清三件事：

1. 这份清单是**手抄副本**，没有 extends；宿主升级改名/改 Config 的表现是**本 preset 挂载失败**（roster 里仍在、带 broken 诊断），不会自动跟随；
2. 升级后的复核方式：重新从 asar 抽 `standard.patch.yml` 与副本做 diff（脚本可复用本轮方法）；
3. 验收里用 `request/header.tools` 的工具名集合做断言，而不是靠人看模式列表。

### P0-6 三个 `rt_*` 工具放 Host 平面还是 preset 内，spec 没说

两种落位后果完全不同：

- **Host 平面**（与既有 guard 同形态）：工具在**所有** preset 可见——包括旧「红队逆向」和 `standard`。好处是工兵也有 `rt_conclude`；坏处是用户在任何会话都会看到 `rt_dispatch`。
- **preset 内**（`plugins:` 里加一行）：只在「红队指挥」会话可见，工兵也继承（P0-2）；不污染其它 preset。

改法：明确选一个并写后果；同时把「服务缺失」与「非 Lead 调用」两种拒绝的返回形状定下来。若选 preset 内，验收步骤 5（工兵侧调用被拒）才有可执行的前提。

### P0-7 席位与并发要一起算，4–5 岗位 + 2–3 空位的算法要重写

`maxMembers: 8` 计的是该会话内成员数（**含创建失败的成员**，`roster.js:231`）。同时宿主的 `maxActiveSubagents` 默认也是 **8**，且与团队成员**共享同一棵 activation 树的名额**（`@deepseek-ai/dsh-subagent/README.zh.md:54`），`maxMembers` 与它不是两个独立池。8 个工兵常驻时，裸 `subagent` 做零碎活会被拒（`ACTIVATION_LIMIT_REACHED`，**不排队**，`:58`）。

改法：班底规划改成「岗位数 + 零碎活并发额度 + 失败重试预留」三笔账；「2–3 个空位」写成「剩余席位 ≥ 2 且可用 activation 名额 ≥ 1」，并把「8 工兵在线时零碎活必被拒」写进已知限制（spec L123 现在只说 subagent 自身有上限，没说共享）。

---

## 三、P1：开工前应定（现在只有结论，没有判据）

1. **能力族枚举与匹配规则**：给 10–13 个族（`shell`、`fs`、`search`、`jobs`、`web`、`skill`、`mcp:<server>`、`binary-static`、`binary-dynamic`、`web-recon`、`browser`、`db`、`reserved`），把匹配做成纯函数 `matchCapabilities(needs: string[], toolNames: string[]): Gap[]`，注册表只以名字数组传入（顺带解决 P2-4）。
2. **`rt_roster` 的输入/输出 schema**：输出至少 `posts[]`（`id`、`display_name`、`focus`、`capability_needs`、`anchors_required`、`prohibited`）、`gaps[]`、`recommended_members`、`reserved_slots`；落盘位置 `re/team/roster.json`（见第 5 条）。
3. **岗位 ↔ 成员 ↔ 席位的载体**：`re/team/roster.json`（v0）存 `{post, member_name, task_id, state, created_at}`；成员名规则照平台（`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤64，≠`lead`，全局不复用），建议 `rt-<post>` / `rt-<post>-2`。这是验收步骤 4 能否机械判定的前提。
4. **`depends_on` 语义**：指向任务 id 还是路线 id；映射到 `blockedBy` 时必须是已存在任务（否则 `TEAM_TASK_NOT_FOUND`），且 `claim` 前要 `taskReady`，依赖未完成的任务**不可认领**。
5. **`timebox_ms` 到点谁负责**：宿主没有超时回调；只能由 Lead 在下一轮 `team_task_list` 时判超时并 `reassign`/`send_message`。写成「到时 Lead 重新评估，插件不自动处置」（与 US 17 一致）。
6. **空岗/空位在任务板上的表示**：没有成员就没有 owner，不能建「空岗任务」；建议用 `re/team/roster.json` 的 `state: "vacant"` + `rt_roster` 的 `gaps` 表达，任务板只放真实任务。
7. **审计的位置与字段**：`$DSH_HOME/redteam/audit/<date>.jsonl` 已被既有包占用；建议本包写 `re/team/audit.jsonl`（append-only，字段 `at/kind/route/task/member/requester/verdict`），并写清「审计失败不改变判定」（沿用既有 best-effort 约定）。验收要 SHA-256，就必须给它稳定路径与字段。
8. **锚点闭集与「可复跑」定义**：`va`/`rva` 必须带模块名 + 文件 `sha256`；`file_offset` 带文件 `sha256`；`evidence_id` 必须附导出证据包路径与 `sha256`，否则不得作为唯一锚点（REA 的 evidence id 是会话内的，跨会话不可解析）。`rt_conclude` 按闭集校验。
9. **文本上限**：`spawn_teammate.prompt` 与任务 `description` 的上限分别是「无独立上限 / 16384 字符」；`subject` ≤200；成员 `description` ≤200；`send_message` 单条 ≤65536 字节。契约模板按这个切分，否则长目标描述会在 `team_task_create` 处失败。

---

## 四、P2：体例与可判定性

1. **状态行补日期与基线**（沿用邻居 spec 体例）：「状态：待评审；基线 DSH 0.2.1-rc.3 / team profile maxMembers=8 / standard preset 129 行」。升级后按第六节复核。
2. **术语表**：岗位 / 成员 / 工兵 / 席位 / 空位 / 空岗 / 路线 / 锚点 / 收口，一文一义。
3. **裁剪三处冗余**：Problem Statement 与 Solution 的重复段；US 13/21/22 是行为要求而不是需求（没有工具或断言承载），应移入「派发契约必须写进 prompt 的三条行为规矩」，或由 `rt_conclude` 校验 `evidence_required` 齐全。
4. **修正「只替换两样东西」**：工具注册表以字符串数组传给纯函数，不算替身；这样 L148 的「注入某工具族不可用」才写得出来。
5. **验收步骤可判定化**：步骤 4 改为「`list_agents` 成员数不变 + `re/team/roster.json` 里该岗位 member 不变 + 回执 task_id 变」；步骤 5 改为「在 Lead 会话用裸 `subagent`（或 workflow）起一个一次性子代理，让它调 `rt_dispatch`，断言被拒且无成员/任务副作用」；步骤 7 改为「`previousStatus ∈ {running,inactive}` + 成员仍在名册 + 用带 nonce 的 `send_message` 唤醒并在回报里看到 nonce」。
6. **安装与模式列表的写法**：「模式列表从 5 行变 6 行」改成「新增一行」（数量随环境变化：`$DSH_HOME/.agent-presets/` 这种 legacy 目录**已不再被读取**，见 `editing-cordis-compositions/SKILL.md:71`；当前 desktop 为 4 内置 + `redteam` = 5 行）。安装路径写死为 `plugin_manager install_bundle`（或向 `dsh.profile.bundles` 追加），并注明安装会重启 Host、模式列表要新会话/硬刷新才可见。

---

## 五、可直接替换的改写句（摘）

- **L43**：「8 个终身席位」→「每个 Lead 会话 8 个成员席位（团队 profile 的 `maxMembers: 8`，平台默认 16），会话内不可回收，含创建失败的成员。」
- **L69（US 26）** →「『红队指挥』下既有 guard 的拦截不再介入（它按 preset 白名单生效）；检测工具 `rt_scan_command` 仍由 Host 面注册、对所有 preset 可见，本 spec 不删除它，只在团队模式下不使用。」
- **L71（US 28）** →「工兵的团队工具与 Lead 相同（平台对每个成员注册同样的九个工具），派发能力由服务层按角色拒绝；本包的 `rt_dispatch` 在调用前判定角色并返回可读原因，不依赖底层抛错。」
- **L82** 补一句：「每个工具必须显式声明 `output.schema` 与 `render`——注册表会按该 schema 校验返回值，不符即报错；raw `register()` 不校验入参，参数校验由本包自己完成。」
- **L88** →「以宿主 `standard.patch.yml` 的 `plugins:`（L11–L129）为基线整段复制，删除 `tool-subagent-control` 与 `tool-subagent-list-agents` 两行（与团队工具同名、语义不同）；这是一份手抄副本，无 extends，宿主升级后须重抄并以 `request/header.tools` 验收。」
- **L122** →「工兵是常驻岗位；席位在一个 Lead 会话内不可回收（Team 身份 = Lead 会话），换会话即换 Team，新会话从 0/8 起算。宿主 `maxActiveSubagents` 默认 8 且与团队成员共享同一 activation 池，班底规划要给零碎活留并发额度。」
- **L128** →「本包不注册任何 `tools/pre-execute` 拦截、不新增命令扫描工具、不写拦截审计；既有 `rt_scan_command` 仍在工具表，要移除需 `disabled: true` 该行，本 spec 明确不做。」
- **L160** →「宿主包只在 `app.asar` 内；`app.asar.unpacked` 下虽有三个 `@deepseek-ai` 目录，但只有 native 片段、无可 require 的入口；本地 `link:` 的 bundle 按自身真实路径解析裸包名，`import '@deepseek-ai/*'` 会 `ERR_MODULE_NOT_FOUND`——第二层只能在真实 DSH 会话里跑。」
- **L172** →「验收会话丢弃即释放（席位只在会话内占位）；验收记录提交 `docs/verify/`，但『可重跑』要注明每次重跑会在新会话里再建成员。」
- **L183** →「不做嵌套团队：平台把九个团队工具注册给每个成员，但 `spawnTeammate`/`interrupt`/`reassign` 在服务层校验调用方必须是 Lead，teammate 无法创建下一层成员；本包额外返回可读拒绝原因。」
- **L195** →「任务板存在 Lead 的会话日志里；任何 Team 变更只会满足当前 `wait_agent` 的等待者，不向 Lead 投递消息；且 `wait_agent` 只返回 `{timedOut}`，必须重新读名册与任务板。」
- **新增（安装前置）**：「本 bundle 依赖已启用 `@deepseek-ai/dsh-experimental-agent-team-profile`（默认关闭），它同时带来 `ctx.agentTeams`、九个团队工具与 `ui-agent-team` 面板；缺失时本包工具会因注入不满足而完全失活，验收第一步必须断言。」

---

## 六、升级 DSH 后的复核清单

1. 团队 `maxMembers` 部署值与默认值；席位是否仍随会话重置。
2. `standard.patch.yml` 的行清单（与副本 diff）；插件包改名。
3. 团队工具注册方式是否仍「按成员身份」；`TEAM_LEAD_REQUIRED` 等错误码是否变化。
4. Host 面工具是否仍对所有 preset 可见（决定 US 26 的写法）。
5. `maxActiveSubagents` 与成员席位是否仍共享池；`previousStatus` 枚举是否仍含 `inactive`。
6. persona `complete` 语义与 `team:policy` 段的可追加性。

---

## 附：证据索引

| 事实 | 位置 |
|---|---|
| 团队服务名 `agentTeams`、九个工具、Lead-only 校验 | `@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1453,1491-1586`；`dsh-experimental-tool-agent-team/lib/index.js:10-15,235-292,352-364` |
| 席位默认 16、失败成员计席、名字规则 | `dsh-experimental-agent-team/lib/index.js:1421`；`lib/types/roster.js:10,216,231`；`README.zh.md:61,127,206` |
| 任务板状态机、CAS、`reassign`/`complete` 前置条件 | `lib/types/task-board.js:90-195` |
| `wait_agent` 返回与「不唤醒 Lead」 | `lib/index.js:49-52,330-351,1462-1473`；`README.zh.md:141,145` |
| 团队 profile：`maxMembers: 8`、禁用 subagent 行、插入 UI | `@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:5-33` |
| `standard` preset 全量行 | `@deepseek-ai/dsh-web-app/presets/standard.patch.yml:5-129` |
| persona scope-only、`complete` 语义 | `@deepseek-ai/dsh-persona/README.zh.md:29,41-50,117` |
| Host 面工具对所有 preset 可见、scope 遮蔽全局 | `@deepseek-ai/dsh-tools/README.zh.md:86`；`dsh-tools/lib/index.js:2969-2971` |
| preset 内不能声明服务 | `@deepseek-ai/dsh-agent-preset-registry/lib/index.js:231` |
| 子级继承父 preset | `@deepseek-ai/dsh-subagent/README.zh.md:66`；`dsh-subagent/lib/index.js:339-383` |
| activation 池 8 与不排队 | `@deepseek-ai/dsh-subagent/README.zh.md:52-58` |
| legacy `.agent-presets` 已不读 | `@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:71` |
| 既有 guard 的 scope 与证据保护 | `D:\workSpace\DSH\redteam-preset\index.js:453-478,504-534`；`cordis.patch.yml:16-17` |
| 本机 profile bundle 顺序 | `C:\Users\Administrator\.dsh\profiles\desktop\package.json:9-15` |
| 本会话（standard）工具目录含 `rt_*`、无 `subagent`、有 `subagent_fork` | `C:\Users\Administrator\.dsh\sessions\--D-workSpace-Rea-Multi-agent--\session-bc99288d-…\session.v4.jsonl.zstd` 的 `request/header.tools`（272 项） |
