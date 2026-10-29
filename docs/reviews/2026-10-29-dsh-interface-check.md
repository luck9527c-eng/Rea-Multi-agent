# Desktop 0.2.1-rc.3 接口定点核对

- 日期：2026-10-29。
- 用户确认的安装目标：**DSH Desktop 0.2.1-rc.3**。
- 文档来源仓库：`D:\workSpace\deepseek-harness`。
- 核对基准：`dsh-v0.2.1-rc.3`，提交 `1f81c047fc48fa190a683e469daa699857e9afe8`；该 tag 的 package.json 标注 `0.2.1-rc.3`。
- 当前 checkout 为 `0.2.2-alpha.2`，HEAD `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。其内容仅作差异参考，不能作为 rc.3 接口依据。查询采用 git show，未切换或修改 DSH 工作区。
- 范围：实际 Agent 工具集合、可信身份、任务指派/完成及规格的直接依赖。先定点读了当前源码，按用户建议后续以 docs 为主；目标版本确定后重新读取对应 release tag 的文档。未启动 DSH、未运行真实团队或分析工具。

## 结论与修订

工具清单由工程管理 skill 指导 agent 发现、验证、维护 JSON、生成 Markdown 和提醒；需要稳定辅助脚本时放在 skill 内。插件只读消费清单，已删除先前设计的 refresh_tools action、对应返回数据和发布阶段。

| 接缝 | rc.3 tag 文档事实 | 对插件的要求 |
|---|---|---|
| 工具集合 | ToolRuntime 提供 schemas(scope?) 与 get(name, scope?)，按 Agent 作用域遮蔽/限制 | 使用 schemas(exec.agent) 查询，针对实际执行者复验；不能用全局集合或 Lead 集合代表工兵。definitions、resolve、exec.toolSet 属较新主线，不作为 rc.3 依赖 |
| 工具名 | 文件工具为 read/write/edit 等，搜索为 glob/grep，后台控制为 job_list/job_output/job_kill，Web 为 web_fetch/web_search | fs/search/jobs/web 是能力族；默认映射已改为实际工具名及组合子能力，部署覆盖仍以实际会话为准 |
| 可信身份 | 执行上下文含受保护的 exec.agent；agentTeams.membership(agent) 返回 root/id/role/name；tryMembership 可拒绝非成员或过时身份 | 只接受准确的宿主活 Agent，不靠提示词、模型传参或名字字符串判断 Lead；TeamId 对应 root SessionId |
| 派发与收口 | createTask 返回无 owner 的 pending；updateTask 使用 taskId、expectedRevision、action、owner；reassign 与 complete 是 action | 调 updateTask(action=reassign/complete)，保留 CAS；不臆造 reassignTask/completeTask 方法。工兵提交、Lead 审阅后完成的方案可接入 |
| 工具限制 | rc.3 已有 Agent 作用域 tools.restrict；scope-local 注册不被全局工具过滤一概覆盖 | 删除“平台完全没有按成员裁工具能力”的断言。v0 不裁剪是范围选择；团队操作的身份授权与裸委派 depth 分别验证 |
| 并发/席位余额 | TeamService 与 SubagentRuntime 的公开 API 列出名册和生命周期/目录查询，但本次未找到统一剩余余额查询 | 不发明 getCapacity，不读 private 配置/manager。adapter 需明确可验证的部署配置、实际计数和并发处置；无法确定仍返回 CAPACITY_UNKNOWN |

rc.3 的核心消费方式为：

```text
caller = exec.agent                       # 必须是宿主提供的有效 Agent
membership = ctx.agentTeams.membership(caller)
visibleSchemas = ctx.tools.schemas(caller)
definition = ctx.tools.get(exactToolName, caller)
# 工具可见性之后，仍须按 skill 核实 provider/session/目标就绪。
# 指派和完成统一使用 ctx.agentTeams.updateTask(caller, request)。
```

当前主线的条件工具文档不能倒推为 rc.3 可用。规格已移除该依赖，岗位目录的默认工具名也已重新对照 rc.3 工具目录确认。rc.3 与当前 checkout 的 task-board.ts、Agent Teams API 文档在本次比较中未显示差异；工具运行时文档/实现有明显差异，因此必须按 release tag 取证。

## 文档依据与复查方式

以下是文档路径；链接打开当前 checkout，**rc.3 的实际核对内容来自同路径的 release tag**：

- [Agent Teams](D:/workSpace/deepseek-harness/docs/subsystems/agent-team.md)：身份、任务 DAG 和 TeamService 生成 API。
- [工具子系统](D:/workSpace/deepseek-harness/docs/subsystems/tools.md)：ToolRuntime、schemas/get/restrict、执行上下文。
- [工具目录](D:/workSpace/deepseek-harness/docs/tool-catalog.md)：插件包与完整工具名的对应；默认目录不能代替运行集合。
- [工具编写参考](D:/workSpace/deepseek-harness/docs/cookbook/adding-a-tool.md)：execute 身份、raw JSON Schema 与 defineTool 的区别、output 和取消。
- [Subagent API](D:/workSpace/deepseek-harness/docs/subsystems/subagent.md)：listChildren/listDescendants 是目录查询，不等于并发余额查询。

可在 DSH 源码目录重读准确版本，例如：

```powershell
git show dsh-v0.2.1-rc.3:docs/subsystems/tools.md
git show dsh-v0.2.1-rc.3:docs/subsystems/agent-team.md
git show dsh-v0.2.1-rc.3:docs/tool-catalog.md
```

先行读取的主线实现集中在 tools、agent-team、tool-agent-team、mcp-client 的接口附近，不作为旧版专属行为的证据。MCP provider 仍保存真实来源或显式绑定，不通过拆工具名猜 server 归属。

## 验证范围

只修改 Rea-Multi-agent 规格、目录和共享 skill 规则。Draft 2020-12 元校验、31 个合法/非法工具输入输出约束样例、20 个能力族的引用/无环检查、10 个岗位能力引用、44 个验收编号及本地文档链接通过；示例 JSON 与不可变副本/Markdown 源哈希一致；共享 skill 快速校验通过。

这些检查不能代替 adapter、真实 Desktop 团队或并发故障验收。未构建或运行 DSH，未认证安装包与 release tag 的逐文件一致性；bundle 安装路径、preset 组合、所有 provider 和运行细节未全面复核。进入实现前还需解决额度预算的接入来源，不能把目录查询当成可靠余额。
