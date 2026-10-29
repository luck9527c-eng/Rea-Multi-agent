# 工具发现、能力接入与工具文档

> 状态：skill 工作流与插件消费约定；发现、验证、JSON/Markdown 维护和提醒由 reverse-project-management 指导 agent 完成，可在 skill 内添加辅助脚本。现有 project.py 不提供专用扫描或生成命令。
> 本文明确 skill 维护什么、插件读取什么；与[编排契约](orchestration-contract.md)、[项目管理协作契约](project-management-integration.md)共同定义接入。

## 发现来源与边界

按以下来源合并候选，不把任何单一来源视为完整安装清单：

1. **实际 DSH 会话工具注册表**：保存完整工具名、描述、server 归属及会话身份；用户说 REA 已挂载是线索，最终以该会话实际暴露为准。另一个客户端的注册表不能代替它。
2. **PATH 与应用注册信息**：读取路径和 Windows 应用注册元数据，不读取无关凭据或执行卸载命令。
3. **项目配置的便携工具根与已知入口**：如 `D:\Tool`。机器路径保存在分析项目配置的“工具环境”，不硬编码到通用 skill 或岗位目录。
4. **已有清单与验证记录**：保留来源与历史，廉价复验变化项。

机器可读发现配置固定为分析项目的 `docs/agents/tool-discovery.json`，由项目“工具环境”章节链接；不把扫描配置混放进要求环境快照结构的 re/env。配置至少定义 schema_version=1、host.id、roots、max_depth、max_entries、known_entrypoints 和 exclusions。其形状例如：

```json
{
  "schema_version": 1,
  "host": {"id": "my-windows-workstation"},
  "roots": ["D:\\Tool"],
  "known_entrypoints": [],
  "max_depth": 4,
  "max_entries": 10000,
  "exclusions": []
}
```

roots、known_entrypoints、exclusions 均为显式绝对路径数组，exclusions 按规范化后的目录/文件边界匹配，不执行表达式。深度以 root 为 0；max_entries 是本轮总访问条目上限，含目录，按规范化路径稳定排序遍历。默认 max_depth=4、max_entries=10000；达到边界、无权限或路径不存在时记录 partial/unknown 与跳过原因。无配置时只能发现注册表/PATH/应用注册信息，不猜根目录，并在清单注明未配置便携工具扫描；缺少可信 host.id 时禁止沿用旧检查成功状态。

仅扫描显式根或 known_entrypoints；默认不跟随 junction/symlink，不逐文件计算大型工具包哈希，不递归整盘。只保存能解释入口和覆盖范围的必要元数据；安装包、缓存、文档或示例不能冒充已安装工具。

“未发现”只针对已扫描范围；无法读取实际工具注册表时保留 registry_ref=null 并报告未知，不以空数组证明没有 MCP。只读发现不启动 IDA/Ghidra 等程序、不附加目标、不安装软件、不修改客户端配置。

## JSON、Markdown 与历史引用

| 文件 | 用途 |
|---|---|
| `re/env/tools.json` | 当前机器可读清单，唯一当前数据源 |
| `re/env/tools.md` | 从 JSON 生成的可读说明，INDEX 链接到这里 |
| `re/env/ENV-tools-<unique>.json` | 不可变工具环境快照，RUN 与派发契约引用其路径及字节 SHA256 |
| `re/team/capabilities.json` | 能力族到已登记 provider 的映射，引用清单，不复制工具状态 |

顶层保留现有 skill 环境 JSON 所需的 schema_version=1、collected_at（带时区）、host 对象、tools 数组；另含 inventory_revision、snapshot_ref、discovery_scope、registry_ref。host.id 区分机器与执行环境；宿主会话与目标身份另记在 checks 中。

工具项包含 id、name、version（未知 null）、version_source、capability_candidates、entrypoints、notes、limitations、next_step。同一程序的不同安装实例使用不同 ID，入口在实例内唯一。目录名推测的版本须注明 inferred，不当成命令输出。

入口包含 id、kind=cli|python|mcp|gui、path 或 server/tool_names、transport_tools、invocation、discovery、states、checks。四层状态为 discovered/executable/session_ready/target_ready，各取 unknown/pass/fail/not_applicable；checks 保存层级、时间、结果、host/session/target 范围、原因与证据引用。历史 pass 只适用于原入口、程序身份、执行者和目标配置，不跨范围沿用。变更使相关当前状态退为 unknown，但保留原 checks。

invocation 未验证为 null；核实后登记 program、参数数组模板、cwd 规则、输出约定、来源/验证引用和资源需求。参数槽位及转义方式须明确，不用拼接 shell 字符串执行未受约束的输入。清单仅保存事实，不因登记入口就执行程序。GUI 存在不代表 agent 有控制通道，桥接 exe 存在不代表 MCP 已连接。

Markdown 必须展示源 JSON 路径、字节 SHA256、revision、时间、host.id、不可变快照链接；正文包括扫描覆盖/局限、工具与入口总览、路径/版本/候选能力/调用方式/四层状态/验证时间/证据及下一步。未知写未知，不补猜测命令。用户备注编辑到 JSON 的 notes/limitations 后重新发布，不能手工维护第二份状态。

示例见[工具 JSON](../examples/tools.json)及其[可读文档](../examples/tools.md)。它们仅记录已确认的文件入口，未启动程序、未读取 DSH MCP 注册表，也未完整扫描 `D:\Tool`。

## skill 维护与发布

工具发现、最小验证、清单更新、Markdown 生成和缺口提醒都由 reverse-project-management 指导 agent 完成；没有编排插件时同样可用。需要稳定重复执行的扫描/渲染逻辑时，辅助脚本归入该 skill 的 scripts，不在编排插件重做。三个 rt 工具不增加清单刷新 action。

开始或接手项目时，agent 按 skill 读取已有清单和实际工具上下文，结合项目根目录配置做有界元数据发现。只读发现不启动分析程序；当前路线需要时才另做最小无害验证，保存实际证据。检查结果由单人执行者或团队 Lead 审阅后合并，不自动采信工兵的未审阅材料。

发布时由同一整合者串行维护；团队模式遵守项目共享写入锁：

1. 保存审阅后的新清单内容，生成新 revision 与不可变快照。
2. 原子替换 tools.json，字节与快照相同。
3. 从确切 JSON 字节生成并原子替换 tools.md，文档注明源 SHA256。
4. 核对引用、文档哈希和 INDEX 指针，留下本次发现/验证及未完成事项。

这不是多文件原子事务。写入中断后先核查现有快照和当前 JSON，保留已发布的不可变文件，再补完当前副本/MD；不能重写旧快照或把半发布当完成。无实质变化可复用原 revision；任何清单内容变化须新 revision。Markdown 陈旧时按 JSON 重生，不能反过来用 MD 改判工具状态。正式 RUN 始终引用不可变快照，清单刷新不改变旧 seal。

## 插件只消费清单

rt_roster inspect 只读清单和实际 Agent 工具上下文，返回岗位能力缺口；rt_dispatch 读取选定快照、能力映射与就绪依据，再做派发前检查。它们不扫描本机目录、不生成文档、不启动环境验证或隐式刷新清单。需要补齐时返回具体缺口，由 Lead 按 skill 处理后重读；不要求先 bind 班底才能建立清单。

目标 Desktop 0.2.1-rc.3 的 tag 文档提供 ctx.tools.schemas(agent) 与 ctx.tools.get(name, agent)，用于取得经过作用域遮蔽/限制后的工具集合。inspect 与 dispatch 分别核对实际执行者，不能用全局集合或 Lead 的工具集合代替工兵。工具可见仍不证明 provider/session/目标就绪；执行前按 skill 复验。主线较新版本的 definitions/resolve/exec.toolSet 不作为 rc.3 依赖，见[DSH 接口核对](../reviews/2026-10-29-dsh-interface-check.md)。

## 原生工具如何满足能力

目录中的通用 shell/fs 等仍匹配完整工具名。专用 binary-static 等可以显式绑定 MCP 工具，也可绑定工具清单的本地入口；IDA 不必作为 MCP 工具名出现。

每个能力族仅选一种组合方式：any_tool、any_provider 或 all_capabilities。any_provider 为 OR，每个 provider 内部为 AND，至少包含 tool_id、entrypoint_id、inventory_revision、snapshot_ref、snapshot_sha256、transport_tools、invocation_ref、readiness_ref、resource_needs。通用默认别名保持在岗位目录中，专用 provider 由 Lead 核实后登记。

本地 provider 要求：入口属于当前 host；路径和程序身份仍匹配；所需 transport_tools 全部出现在执行者实际注册表；invocation_ref 指向同一快照内已核实的调用配方；满足该实验所需的四层就绪与资源规则。MCP provider 要求真实 server/工具归属与当前会话就绪，不能拿本地 launcher 替代。候选标签本身不能满足能力。纯存在性匹配与作用域就绪判定分开；仅执行者特定的未知可在 bootstrap 无害预检，已知失败先拒绝。

`matchCapabilities(needs, toolNames, inventory, bindings)` 只接收显式快照数据并检查结构性可用性，返回 matched/missing 及具体 provider 引用；另一个纯判定接收 checks、当前执行者/session/target、程序身份与时间来判断就绪。不从可变全局读数据，也不靠 MD 判断。派发契约冻结选定 provider、配方、资源、注册表指纹和工具快照引用；刷新后旧任务不静默切换工具或配方。新派发发现旧绑定 revision 与当前清单不符时必须复验并更新绑定，不能自动信任旧引用。

## 增量检查与主动提醒

进入项目先读现有清单；工具首次用于本条路线前做廉价复验。根目录、注册表、程序/配置、连接或目标变化时增量刷新受影响项，不每次派发扫描整盘。旧机器清单只能作发现线索。

影响当前工作时，提醒包含：已发现的入口、缺失层级、受影响岗位/路线、最小下一步和可继续的路线。按 host/session、能力/provider、失败层级、原因和处置状态去重，状态保存在项目会话记录中，团队模式可引用编排记录；相同未变化缺口不逐轮提醒，首次/变化/恢复/需要用户动作时报告。没有可用方法则如实交回具体阻塞，不擅自安装或创造分析结论。这是 Lead 活跃循环内的提示，不是后台监控或会话外自动通知。
