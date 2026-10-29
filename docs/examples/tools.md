# 本机工具清单示例

> 由 [tools.json](tools.json) 生成。此处是设计示例，不是已初始化分析项目的当前环境。正式项目使用 re/env/ 路径；示例快照引用使用 docs/examples/。

- inventory_revision：`example-20261029-001`
- collected_at：`2026-10-29T15:08:01+08:00`
- host.id：`example-local-windows`
- 源 JSON SHA256：`cbfd4d1a8ed8b948823a6b8e95a05b04c01dde6569bb5ce0e8646be178a4437b`
- 不可变快照：[ENV-tools-example.json](ENV-tools-example.json)（与源 JSON 字节相同）

## 发现范围

仅读取 D:\Tool 下 5 个指定入口的文件元数据。未完整扫描目录、PATH 或应用注册，未读取实际 DSH MCP 清单。用户报告 REA 已挂载，本示例尚未独立核验。扫描错误：无（仅针对指定入口）；其余范围未知。未启动任何列出的程序。

## 工具总览

| 工具 | 版本 | 入口数 | 候选能力 |
|---|---|---|---|
| IDA Pro | 未验证 | 3 | binary-static（候选） |
| Ghidra | 未验证 | 1 | binary-static（候选） |
| TShark | 未验证 | 1 | network-observation（候选） |

## IDA Pro

- 实例 ID：`ida-pro-local`
- 版本：未知；来源：not_checked
- 备注：仅核查指定文件元数据，未启动程序。
- 限制：未验证调用参数、控制通道、许可证、依赖或目标适配。；MCP launcher 文件存在不证明 DSH 已挂载或连接；GUI 存在不证明 agent 能操作。

### gui（gui）

- 路径：`D:\Tool\IDAPro\ida.exe`
- 文件大小：12874240 字节
- 发现方式/时间：selected_file_metadata / 2026-10-29T15:08:01+08:00
- 四层状态：discovered=pass；executable=unknown；session_ready=unknown；target_ready=unknown
- 已验证调用方式：无（invocation=null）；传输工具：未登记
- 验证时间/证据：无执行验证，checks=[]

### headless-candidate（cli）

- 路径：`D:\Tool\IDAPro\idat.exe`
- 文件大小：16896 字节
- 发现方式/时间：selected_file_metadata / 2026-10-29T15:08:01+08:00
- 四层状态：discovered=pass；executable=unknown；session_ready=unknown；target_ready=unknown
- 已验证调用方式：无（invocation=null）；传输工具：未登记
- 验证时间/证据：无执行验证，checks=[]

### mcp-launcher-candidate（cli）

- 路径：`D:\Tool\IDAPro\python311\Scripts\ida-pro-mcp.exe`
- 文件大小：108336 字节
- 发现方式/时间：selected_file_metadata / 2026-10-29T15:08:01+08:00
- 四层状态：discovered=pass；executable=unknown；session_ready=unknown；target_ready=unknown
- 已验证调用方式：无（invocation=null）；传输工具：未登记
- 验证时间/证据：无执行验证，checks=[]

下一步：当前路线需要时，查实际说明并进行最小无害验证，保留证据。

## Ghidra

- 实例 ID：`ghidra-local`
- 版本：未知；来源：not_checked
- 备注：仅核查指定文件元数据，未启动程序。
- 限制：未验证调用参数、控制通道、许可证、依赖或目标适配。

### headless-candidate（cli）

- 路径：`D:\Tool\ghidra_12.1.4_PUBLIC\support\analyzeHeadless.bat`
- 文件大小：2930 字节
- 发现方式/时间：selected_file_metadata / 2026-10-29T15:08:01+08:00
- 四层状态：discovered=pass；executable=unknown；session_ready=unknown；target_ready=unknown
- 已验证调用方式：无（invocation=null）；传输工具：未登记
- 验证时间/证据：无执行验证，checks=[]

下一步：当前路线需要时，查实际说明并进行最小无害验证，保留证据。

## TShark

- 实例 ID：`tshark-local`
- 版本：未知；来源：not_checked
- 备注：仅核查指定文件元数据，未启动程序。
- 限制：未验证调用参数、控制通道、许可证、依赖或目标适配。

### cli（cli）

- 路径：`D:\Tool\Wireshark\tshark.exe`
- 文件大小：410440 字节
- 发现方式/时间：selected_file_metadata / 2026-10-29T15:08:01+08:00
- 四层状态：discovered=pass；executable=unknown；session_ready=unknown；target_ready=unknown
- 已验证调用方式：无（invocation=null）；传输工具：未登记
- 验证时间/证据：无执行验证，checks=[]

下一步：当前路线需要时，查实际说明并进行最小无害验证，保留证据。

## 缺口与下一步

REA 以实际 DSH 会话的工具表和最小检查确认；IDA 等本地工具按路线需求核实 CLI/Python/MCP/GUI 控制通道，再登记能力绑定。MCP launcher 与 GUI exe 均不能仅凭存在就放行任务。网络工具的候选标签未登记到岗位能力目录，不能直接用于派发。

后续修改以 JSON 为准，重新生成 Markdown；正式 RUN 绑定不可变快照，不引用会刷新的 tools.json。
