# T2 — Bundle 骨架、`redteam-lead` preset、工具注册入口与 `bin/doctor.mjs`

**Blocked by:** T1（信封/错误码/校验）

## 这个 ticket 打通什么

一个能本地 `link:` 安装、**能挂载成功**的 bundle：模式选择器多出「红队指挥」（`order: 6`），既有「红队逆向」一个字节不动；该 preset 的工具面 = 宿主 `standard` 的工具面**减去两个同名冲突行** + 本包三工具；三个工具已按原始 JSON Schema 注册并且**有一条可执行的端到端空跑路径**（参数校验 → 分发到 handler → 信封返回）；缺团队服务时能用不依赖插件注册的 `bin/doctor.mjs` 拿到可读诊断。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)、[SEAMS.md](../SEAMS.md)
- **`D:\workSpace\rea-ma-notes\E1-host-anatomy.md`**（工具插件 API、`output.schema`/`render`、locale 消费方式、preset 注册 schema、测试假 ctx 形状——以此为准）
- `docs/impl/baseline/standard.patch.rc3.yml`（**基线副本**，见下）
- 参考实现：`D:\workSpace\DSH\redteam-preset\`（`package.json` / `cordis.patch.yml` / `index.js` / `test/*.mjs`）
- `docs/specs/rea-multi-agent.md` 的 `### 分发形态`、`### 安装前置`、`### preset 与工具面`、`### 人设与角色`、`### 工兵工具面`、`### 边界`
- `docs/specs/orchestration-contract.md` 的 `## 自检、会话接管与 Lead 循环`（doctor 段）
- `docs/specs/rt-tools.schema.json`（全量，你要把相关 `$defs` 复制进包内）
- `docs/specs/acceptance-matrix.md` 的 A01 / A02 / A03

## 交付

### `package.json`

`name: "@local/dsh-redteam-lead"`、`private: true`、`type: "module"`、`version: "0.1.0"`、`exports` 含 `"."` → `./index.js` 与 `"./locale/*.json"`、`files` 列出 `index.js`/`src`/`bin`/`cordis.patch.yml`/`locale`/`icon.svg`、`dsh.bundle.patch: "./cordis.patch.yml"`。**`dependencies` 必须为空对象或不存在。**

### `cordis.patch.yml`

- 只有一段 `- insert:`，插入两行：**preset 行** `preset-redteam-lead`（`name: '@deepseek-ai/dsh-agent-preset'`）与其 `config.plugins` 内的**本包行** `redteam-lead-tools`（`name: '@local/dsh-redteam-lead'`，`config` 可放 `defaults`）。
- preset config：`id: redteam-lead`、`name: 红队指挥`、`description`、`order: 6`。
- `config.plugins` 基线 = `docs/impl/baseline/standard.patch.rc3.yml` 里 `preset-standard.config.plugins` 的**整段手抄副本**（无 extends），但：
  - **删除** `tool-subagent-control` 与 `tool-subagent-list-agents` 两行（它们提供的 `send_message`/`interrupt_agent`/`list_agents` 与团队工具同名、语义不同）；
  - **保留** `tool-subagent`、`tool-subagent-fork`、`workflow-ptc`、`tool-workflow`（Lead 用于零碎活）；
  - 替换 `persona` 行的 config 为本包的人设；
  - 追加本包 `redteam-lead-tools` 行。
- **persona**：`complete: false`（否则会吃掉 `team:policy` 段）、`includeRuntimeContext: true`、`prefix` 是**角色中立**的共同准则（证据驱动、结论挂锚点、拿不出锚点写「未验证推测」、卡住说清卡在哪缺什么、不臆测），**不写「你是指挥」**——工兵继承同一 preset 也会读到这条人设，它的角色由 runtime context 的 `team:identity` 注入。
- **不要在 preset 里声明 sandbox/approval 设置**（会在 root realm 泄漏并被注册表拒绝），也不要声明服务。

### `index.js`

- 按 E1 笔记的真实 API 形状注册三个工具 `rt_roster` / `rt_dispatch` / `rt_conclude`：`parameters` 用 `src/tool-schema.mjs` 里的 `rosterInput`/`dispatchInput`/`concludeInput`，`output.schema` 用 `result`（成功 data 分别取 `rosterData`/`dispatchData`/`concludeData`），并给 `render`。
- 每个调用：解析入参 → 用 `deps.validate` 校验（非法 → `INVALID_ARGUMENT` 信封，**在产生任何副作用前**）→ 解出 `action`（仅 roster）→ 交给 `src/roster.mjs` / `src/dispatch.mjs` / `src/conclude.mjs` 的 handler → 返回 `{envelope}`。
- handler 抛异常时必须转成 `error` 信封，**不把栈抛给注册表**。
- 装配 `ctx.deps`：**键名必须与 SEAMS.md 第 1 节完全一致**。尚未实现的模块给 `null`（T5/T6/T7 只替换自己那几个），`clock`/`fs` 由本 ticket 提供真实实现。
- `src/roster.mjs`、`src/dispatch.mjs`、`src/conclude.mjs` 由本 ticket 建为**占位实现**：`export async function handleX(ctx, input) { return { envelope: <error 信封 TEAM_SERVICE_UNAVAILABLE 或明确的未实现诊断> } }`，以保证入口可加载、可测试；后续 ticket 会整体替换它们。

### `src/tool-schema.mjs`

从 `docs/specs/rt-tools.schema.json` 复制**用得到的** `$defs`（至少 `text/id/sha256/path/root/routeId/runId/dispatchId/attemptId/strings/kinds/date/routeStatus/outcome/errorCode/anchorKind/anchorRef/resource/post/rosterInput/retryOf/dispatchInput/review/concludeInput/diagnostic/failureData/result/rosterData/dispatchData/concludeData`），并 `export` 三个入参 schema 与 `result` schema。加**漂移测试**：把包内副本与 `docs/specs/rt-tools.schema.json` 逐 `$defs` 深比较，不一致即失败。

### `bin/doctor.mjs` + `src/doctor.mjs`

- 固定入口：`node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root>`。**只读**，不依赖插件已挂载、不依赖团队服务注册。
- 检查：本包能否被解析（`package.json`/`exports`/`cordis.patch.yml` 可读）、profile 的 `dsh.profile.bundles` 是否含团队 profile bundle 与本包、`package.json` 依赖是否与 profile 的 `node_modules/@local` 一致、项目侧是否有 `INDEX.md`/项目配置/`.agents/skills/reverse-project-management/`、Python 与 `project.py` 可达性。
- 输出**与工具一致的信封形状**（`schema_version/status/code/operation_id/replayed/retryable/diagnostics/data`），`diagnostics[]` 每条含原因 + 具体下一步。
- **离线配置正确只报 `configuration_ready`；`runtime_ready` 必须是 `unknown`**，不得假称团队服务已运行。退出码：诊断到硬阻塞 → 1，否则 0。

### `locale/en.json`、`locale/zh.json`、`README.md`

按 E1 笔记的 locale 消费方式提供工具/诊断文案；`README.md` 写安装（`link:` 进 `dsh.profile.bundles`）、前置（团队 profile bundle 必须启用）、doctor 用法、卸载。

## 验收

- [ ] `node --test test` 全绿
- [ ] `test/bundle.test.mjs`：`package.json` 形状正确、`dsh.bundle.patch` 指向存在的文件、`dependencies` 为空
- [ ] `test/bundle.test.mjs`：解析 `cordis.patch.yml` 后，preset 的 plugin id 列表 **= 基线列表 − {tool-subagent-control, tool-subagent-list-agents} + {redteam-lead-tools}**；且断言这两行确实**不存在**、`tool-subagent`/`tool-subagent-fork`/`workflow-ptc`/`tool-workflow` 仍在
- [ ] preset 行 `id=redteam-lead`、`order=6`、persona 行 `complete: false`；patch 里没有 sandbox/approval 声明
- [ ] `grep` 断言全包无 `from '@deepseek-ai/` 与无 `require('@deepseek-ai/`
- [ ] 三工具已注册：用一个假注册表跑通「合法入参 → 分发到 handler → 拿到 schema 合规的信封」与「非法入参 → `INVALID_ARGUMENT` 且 handler 未被调用」
- [ ] `bin/doctor.mjs` 在**不加载插件**的裸 `node` 下可运行：正常 profile 报 `configuration_ready` 且 `runtime_ready=unknown`；删掉 `cordis.patch.yml` 或指向不存在的 profile 时给出**具体**修复路径并以 1 退出
- [ ] `test/bundle.test.mjs` 断言 `src/tool-schema.mjs` 与 `docs/specs/rt-tools.schema.json` 无漂移
- [ ] 既有 `redteam` preset、`@local/dsh-rea-plugin` 的文件与配置**零改动**
