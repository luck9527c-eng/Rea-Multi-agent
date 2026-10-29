# Rea-Multi-agent

> 基于 DeepSeek Harness 多智能体编排的逆向分析插件

把逆向分析从「一个 agent 从头干到尾」变成**一支有编制的团队**：主 agent 当指挥，拆路线、派任务、核对事实、写文档；一组常驻工兵守各自的路线，干完带着可复跑的证据回来。

底座是 DSH 的实验性「智能体团队」——名册、共享任务板、成员看板直接复用，本仓库只补逆向专用的那一半。

## 它解决什么

逆向是长拉锯。一次定位、一次反编译、一次动态验证动辄几十分钟，单 agent 模式下有两个绕不开的浪费：

1. **路线被串行化。** 主 agent 发起一个耗时分析就只能停在那里等，本来可以同时探的岔路（静态、动态、协议）全部排队。
2. **执行和记录互相挤占。** 干到一半上下文被压缩，前面挖出来的地址、函数、证据就丢了——而逆向的价值恰恰在于跑完之后留下了什么。

团队模式下，工兵在独立工作区持续保存计划、执行事实与原始证据；指挥核对后统一归档、封存、更新路线和项目记录。

插件与 **reverse-project-management skill** 配合使用：插件负责成员、派发、并发与交付，skill 负责 INDEX、路线/RUN、证据封存、跨路线复查和项目验收。两者共用项目事实记录，skill 也可以独立用于单人项目。接入方式见[协作契约](docs/specs/project-management-integration.md)。

## 它怎么工作

```
你：目标是什么（一个样本 / 一个游戏客户端 / 一个 Web 应用）
 │
 ├─ 指挥判定目标类别 → 给出班底提议（岗位、能力需求、当前缺口）
 ├─ 你确认 → 建岗（常驻具名成员）
 ├─ 逐岗派发书面契约：要什么结论、必须交回哪几类锚点、产物落哪、禁止什么
 ├─ 派完不等着：核对已回证据、写文档、铺下一条路线
 └─ 收口：结论 + 锚点落进 re/ 的路线记录，任务板标完成
```

全程你能在会话标题栏看到名册与任务板，点开任意工兵就能读它的完整过程。

## 组成

| 部件 | 说明 |
|---|---|
| preset「红队指挥」 | 独立模式，不动既有的「红队逆向」 |
| `rt_roster` | 按目标类别给班底提议，读取 skill 维护的工具清单并标注能力缺口 |
| `rt_dispatch` | 对已有可执行路线查前提、能力和资源，复用或建岗，再建任务并交付完整契约引用 |
| `rt_conclude` | Lead 收口：按项目 skill 核对交付、归档封存、更新路线和影响，通过检查后完成任务 |
| reverse-project-management | 配套项目 skill，负责工具清单维护及证据格式、封存/复查、项目验收；保留各项目副本 |
| 角色中立人设 | 共同准则（证据驱动、锚点、不臆测），角色差异由 runtime context 与派发契约承载 |

## 三个编排约束

以下约束用于 v0 编排；不同宿主版本的接口须分别核对，见[本地 DSH 接口记录](docs/reviews/2026-10-29-dsh-interface-check.md)：

1. **席位按会话计、不回收，且与裸子代理共用同一个 activation 池。** 一个项目同一时刻只绑定一个 Lead，会话变更需显式接管；岗位数 + 零碎活并发 + 重试预留必须一起算，实际岗位建议 ≤ 6。
2. **委派限制必须在执行端成立。** 团队操作检查 Lead 身份，裸 subagent/workflow 路径另需核实 depth；工具可见性不代替授权检查。
3. **任务完成不会唤醒指挥。** 它只满足正在等待的 `wait_agent`。派完推进已有独立工作，没有独立工作时有界等待并回读状态。

## 状态

**已实现，可按本地 `link:` 安装使用；第三层（真实 DSH 团队会话）验收尚未执行。**

- 插件（`packages/dsh-redteam-lead/`）包含 preset、三个 `rt_*` 工具、项目/团队两个适配器与只读 `bin/doctor.mjs`；源码是 TypeScript，`dist/` 随仓库提交（DECISIONS D28/D31），运行时**零依赖**、不 import 任何 `@deepseek-ai/*`。
- L1/L2 自动门禁全绿：**0 失败、0 跳过**（门禁命令见[开发与门禁](#开发与门禁)）。
- **L3 一次都没跑过**：验收矩阵中 18 条参与真实会话的行全部是 `not-run`。逐条判定（44 行全覆盖）见[验收总表](docs/verify/acceptance-status.md)，执行方法见[第三层验收说明](docs/verify/README.md)。

| 文档 | 内容 |
|---|---|
| [规格](docs/specs/rea-multi-agent.md) | 问题、方案、34 条用户故事、实现决策、三层验证、范围外；补充评审已落实到设计 |
| [项目管理协作契约](docs/specs/project-management-integration.md) | 插件/skill 分工、隔离交付、Lead 验收、恢复与集成验收 |
| [编排契约](docs/specs/orchestration-contract.md) | 三工具字段、结果分类、资源/锁、恢复阶段、诊断与 Lead 循环 |
| [工具发现与文档](docs/specs/tool-discovery.md) / [文档示例](docs/examples/tools.md) | skill 负责联合发现、JSON/MD 维护与提醒；插件只读消费，保留不可变快照 |
| [工具 Schema](docs/specs/rt-tools.schema.json) / [岗位目录](docs/specs/roster-catalog.json) | 可校验的工具输入输出与模板/能力数据 |
| [验收矩阵](docs/specs/acceptance-matrix.md) | 44 个插件/skill 协作验收场景，区分静态验证和三层运行验证 |
| [验收总表](docs/verify/acceptance-status.md) | A01–A44 逐条状态（`pass`/`fail`/`not-run`/`out-of-scope`）与证据位置 |
| [评审](docs/reviews/2026-10-29-rea-multi-agent-spec-review.md) | 对规格的逐条核对（P0/P1/P2），规格已按其修订 |
| [DSH 接口核对](docs/reviews/2026-10-29-dsh-interface-check.md) | 按 Desktop 0.2.1-rc.3 tag 文档核对工具名、作用域、身份与任务 API；记录主线差异与额度接入缺口 |
| [设计补充评审](docs/reviews/2026-10-29-rea-multi-agent-design-review.md) | 13 条问题的规格修订位置与验收编号；保留原评审，运行验证待实现 |
| [实现决策](docs/impl/DECISIONS.md) | 规格与平台事实冲突时的裁决（容量声明、depth、seal 顺序、skill 侧坑位……） |

## 安装

本仓库**不发布 npm 包**：按本地 `link:` 装进 DSH profile，然后再把包名加进该 profile 的
`dsh.profile.bundles`。两件事都要做，只做一件都是"看起来装了、其实没生效"。

> **前置：团队 profile bundle 必须已启用。**
> `@deepseek-ai/dsh-experimental-agent-team-profile` 必须出现在同一个 profile 的
> `dsh.profile.bundles` 里。它随 DSH 提供但默认关闭，而且**没有**按 bundle 的 `disabled` 字段——
> 唯一的启用方式就是列进 `bundles`。没有它就没有 `ctx.agentTeams`，三个 `rt_*` 工具只会返回
> `TEAM_SERVICE_UNAVAILABLE`。

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop          # 换成你实际用的 profile 目录
pnpm add "link:D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead"   # 或 npm install
```

然后编辑该目录的 `package.json`，把本包加进 `dsh.profile.bundles`（**放在团队 profile 之后**）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@local/dsh-redteam-lead"
      ]
    }
  }
}
```

重启 DSH 后模式列表会多出「红队指挥」（preset id `redteam-lead`）。**已有会话保留它启动时的 preset
版本**，要新开会话才生效。

- 只改 `dependencies` 不改 `bundles`：patch 层不生效（`bundles` 决定谁贡献 patch）。
- 只改 `bundles` 不装依赖：`node_modules/@local/dsh-redteam-lead` 不存在，加载失败。
- patch 里写错插件名在宿主里是 **WARN + SKIP**（不报错、也不生效），所以装完必须用 doctor 确认三项
  `profile.bundle_listed` / `profile.bundle_declared` / `profile.bundle_linked` 都是 `true`。

实际分析项目还需要接入含**团队规则段**的 `reverse-project-management` 项目副本；已有项目按差异局部合并，
插件不会重新 `init`、也不会用全局副本覆盖项目副本（DECISIONS D8）。

## 卸载（一步）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
# 1) 从 package.json 的 dsh.profile.bundles 里删掉 "@local/dsh-redteam-lead"
pnpm remove @local/dsh-redteam-lead
```

本包不写项目之外的全局状态，也不改既有 `redteam` preset 与 `@local/dsh-rea-plugin`。分析项目里的
`re/team/**` 是**项目事实**（绑定、派发、回执、审计），不是安装残留；要不要清理由你按 skill 的恢复
规则决定，卸载本身不需要回滚别的东西。

## 自检：`bin/doctor.mjs`

只读、裸 `node`、不需要插件已挂载、也不需要团队服务在线：

```powershell
node D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead\bin\doctor.mjs `
  --profile $env:USERPROFILE\.dsh\profiles\desktop `
  --project D:\workSpace\PJ\case01
```

- 输出与工具一致的信封（`schema_version/status/code/operation_id/replayed/retryable/diagnostics/data`），
  每条诊断都有 `reason` 与**具体下一步**。
- `data.configuration_ready` 只反映**离线配置**；`data.runtime_ready` 恒为 `unknown` —— 离线不可能知道
  团队服务是否在跑，doctor 不会假装知道。真实运行状态由挂载后的 `rt_roster` 检查。
- 退出码：有硬阻塞 → `1`，否则 `0`。
- 可省略 `--project`（项目侧检查标 `skip`）；`--bundle` 默认是本包根目录。

## 三层验证怎么跑

| 层 | 跑什么 | 怎么跑 | 前置 |
|---|---|---|---|
| **L1** | 工具处理器 + 团队/文件/项目管理接缝的故障注入（自动） | `node --test "packages/dsh-redteam-lead/test/*.test.mjs"` | Node 24（本机 v24.22.1） |
| **L2** | 临时分析仓库里的**真实** `project.py`（自动） | `node --test "packages/dsh-redteam-lead/test/l2/*.test.mjs"` | 真实 Python；权威 skill 副本（`RT_L2_PYTHON` / `RPM_SKILL_ROOT` 可覆盖） |
| **L3** | 真实 DSH 团队会话（人工，一次性会话） | 按 [docs/verify/README.md](docs/verify/README.md)：五项前置自检 → 七步清单 [l3-checklist.md](docs/verify/l3-checklist.md) → `scripts/l3-verify.mjs collect/diff` 取证 → 记录归档到 `docs/verify/records/` | 团队 profile bundle 已启用 + 本包已 `link:` 并列入 `bundles` + 一次性临时项目 + Python + 项目外证据目录 |

L2 在上述前置缺失时会 `t.skip(具体原因)`，不会假通过；L3 目前**没有任何记录**——总表里对应的行因此只能是
`not-run`，不能读成"通过"。

## 开发与门禁

**唯一门禁命令（在仓库根执行）**：

```powershell
npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```

- 必须用**显式 glob**：裸 `node --test` 会把 `test/helpers/*.mjs` 也当测试文件跑；`node --test test` 在
  Node 24 上直接失败（位置参数按 glob 解释，不展开目录）。见 DECISIONS D20。
- `npm.cmd`（不是 `npm`）：PowerShell 执行策略会拦 `npm.ps1`。
- `dist/` 必须重建并随源码一起提交：`link:` 安装不触发 `prepare`，不提交等于装一具空壳（D28）。

## 已知限制

1. **`workflow` 不受 depth 限制（DECISIONS D5）**：teammate（depth=1）用 `subagent` / `subagent_fork` 会被
   depth 策略挡住，但 `workflow` 传了 `parent` 而没传 `maxDepth`，**不会**被挡。本包不声称"平台挡住一切下一层
   创建"；补偿控制是派发契约里明写「你没有派发权，缺人就报回来」+ 团队服务自身的 `TEAM_LEAD_REQUIRED`。
   这一条同时列为 L3 待实测项，且**不要在验收里跑 `workflow`**（会烧 activation 名额并污染后续步骤）。
2. **容量必须显式声明（DECISIONS D1）**：宿主没有受支持的只读余额查询。`re/team/capacity.json` 或 profile
   `config.capacity` 必须有一处声明 `maxMembers`/`maxActiveSubagents`；都没有时 `rt_roster` / `rt_dispatch`
   返回 `CAPACITY_UNKNOWN` 并写明下一步，**不猜 8/16、不读私有字段、不靠 spawn 试探**。另外 activation
   **占用**不可观测（D25）：上限已声明时按上限扣预留，并附一条 `ACTIVATION_USAGE_UNOBSERVED` 非阻塞 gap。
3. **`re/env/tools.json` 没有生产者（DECISIONS D11）**：skill 侧没有生成命令，本机也没有真实实例，唯一具体
   样例是 [docs/examples/tools.json](docs/examples/tools.json)。插件必须**容忍缺失**，按
   [tool-discovery](docs/specs/tool-discovery.md) 报 unknown/gap；绝不自己生成清单、绝不因缺失而崩。

## 目录

```
packages/dsh-redteam-lead/  插件包（src/ TypeScript 源码，dist/ 提交的发货字节，test/ L1+L2 用例）
scripts/                    构建脚本（tsc → dist/）
docs/specs/                 设计规格（数据源，不改写）
docs/examples/              工具清单与生成文档示例
docs/impl/                  ticket、实现决策、约定、基线
docs/reviews/               评审记录
docs/verify/                第三层验收：怎么跑、清单、记录模板、验收总表
```

