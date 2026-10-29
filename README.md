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

**规格阶段——还没有可安装的产物。**

| 文档 | 内容 |
|---|---|
| [规格](docs/specs/rea-multi-agent.md) | 问题、方案、34 条用户故事、实现决策、三层验证、范围外；补充评审已落实到设计 |
| [项目管理协作契约](docs/specs/project-management-integration.md) | 插件/skill 分工、隔离交付、Lead 验收、恢复与集成验收 |
| [编排契约](docs/specs/orchestration-contract.md) | 三工具字段、结果分类、资源/锁、恢复阶段、诊断与 Lead 循环 |
| [工具发现与文档](docs/specs/tool-discovery.md) / [文档示例](docs/examples/tools.md) | skill 负责联合发现、JSON/MD 维护与提醒；插件只读消费，保留不可变快照 |
| [工具 Schema](docs/specs/rt-tools.schema.json) / [岗位目录](docs/specs/roster-catalog.json) | 可校验的工具输入输出与模板/能力数据 |
| [验收矩阵](docs/specs/acceptance-matrix.md) | 44 个插件/skill 协作验收场景，区分静态验证和三层运行验证 |
| [评审](docs/reviews/2026-10-29-rea-multi-agent-spec-review.md) | 对规格的逐条核对（P0/P1/P2），规格已按其修订 |
| [DSH 接口核对](docs/reviews/2026-10-29-dsh-interface-check.md) | 按 Desktop 0.2.1-rc.3 tag 文档核对工具名、作用域、身份与任务 API；记录主线差异与额度接入缺口 |
| [设计补充评审](docs/reviews/2026-10-29-rea-multi-agent-design-review.md) | 13 条问题的规格修订位置与验收编号；保留原评审，运行验证待实现 |
| `docs/verify/` | 待建：真服务验收记录 |

## 安装（待实现）

预期形态：一个本地 `link:` 安装的 bundle，进 profile 的 `dsh.profile.bundles`。前置是 DSH 的团队 profile bundle 已启用——它随安装提供但默认关闭。实际分析项目还需接入含团队规则的 reverse-project-management 项目副本；旧项目比较后局部合并，不自动覆盖。

## 目录

```
docs/specs/     设计规格
docs/examples/  工具清单与生成文档示例
docs/reviews/   评审记录
docs/verify/    真服务验收记录（待建）
```
