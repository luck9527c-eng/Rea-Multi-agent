# @local/dsh-redteam-lead — 红队指挥

DSH bundle：给模式列表加一个 **红队指挥**（preset id `redteam-lead`，`order: 6`）预设，并在它的
作用域内注册三个编排工具：

| 工具 | 作用 | 只读? |
|---|---|---|
| `rt_roster` | 班底诊断（`action=inspect`，默认）/ 绑定与接管（`bind` / `takeover`，仅 Lead） | `inspect` 只读 |
| `rt_dispatch` | 把一份派发契约交给某个团队成员（仅 Lead） | 否 |
| `rt_conclude` | 校验提交、比对基准、跑项目 skill 检查、回执并完成任务（仅 Lead） | 否 |

零运行时依赖、纯 ESM、**不 import 任何 `@deepseek-ai/*`**：本地 `link:` 安装的 bundle 按自身真实
路径解析裸包名，宿主能力一律经注入的 `ctx` 取。

> **当前交付状态**：本包当前交付的是 bundle 骨架、preset、工具注册入口与 `bin/doctor.mjs`。
> `src/roster.mjs` / `src/dispatch.mjs` / `src/conclude.mjs` 是**占位实现**，合法调用会返回
> `TEAM_SERVICE_UNAVAILABLE` 错误信封并写清下一步；真实编排逻辑随后续 ticket 整体替换这三个文件，
> 不需要改 `index.js`、`cordis.patch.yml` 或本文件。

## 前置

1. **团队 profile bundle 必须启用**：`@deepseek-ai/dsh-experimental-agent-team-profile`。它随安装
   提供但默认关闭，而且**没有**按 bundle 的 `disabled` 字段——唯一的启用方式是把它列进 profile 的
   `dsh.profile.bundles`。没有它就没有 `ctx.agentTeams`，三个工具都会返回
   `TEAM_SERVICE_UNAVAILABLE`。
2. **分析项目**需要接好项目内 `reverse-project-management` 副本（含**团队规则**段）与可用的
   Python；插件只读检查，**不会**用全局副本覆盖项目副本，也**不会**自动 `init` 已有项目。

## 安装

本包按 `link:` 装进 profile（和既有 `@local/dsh-rea-plugin` 同形态），不是发布包。
以 `desktop` profile 为例（`%USERPROFILE%\.dsh\profiles\desktop`）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:\workSpace\rea-ma-wt\t2\packages\dsh-redteam-lead"   # 或你的 checkout 路径
```

然后编辑该目录的 `package.json`，把本包加进 `dsh.profile.bundles`（放在团队 profile 之后）：

```json
{
  "dependencies": {
    "@local/dsh-redteam-lead": "link:D:\\workSpace\\rea-ma-wt\\t2\\packages\\dsh-redteam-lead"
  },
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

重启 DSH 后，模式列表会多出「红队指挥」。**已有会话保留它启动时的 preset 版本**，新建会话才用新组合。

- 只改 `dependencies` 不改 `dsh.profile.bundles`，patch 层不会生效：`bundles` 决定哪些 bundle 贡献 patch。
- patch 写错插件名在宿主里是 **WARN + SKIP**（不报错、也不生效）；`doctor` 的检查项与
  `test/bundle.test.mjs` 的 id 清单断言就是用来兜住这一点的。

## 自检：`bin/doctor.mjs`

固定入口，**只读**，不需要插件已挂载，也不需要团队服务已注册：

```powershell
node D:\workSpace\rea-ma-wt\t2\packages\dsh-redteam-lead\bin\doctor.mjs `
  --profile $env:USERPROFILE\.dsh\profiles\desktop `
  --project D:\workSpace\PJ\case01
```

- 输出与工具一致的信封（`schema_version/status/code/operation_id/replayed/retryable/diagnostics/data`），
  每条诊断都有 `reason` 与**具体下一步**。
- `data.configuration_ready` 只反映**离线配置**是否齐备；`data.runtime_ready` 恒为 `unknown` ——
  离线不可能知道团队服务是否在跑，doctor 也不会假装知道。真正的运行时状态由挂载后的 `rt_roster` 检查。
- 退出码：有硬阻塞 → `1`，否则 `0`。
- 可省略 `--project`（项目侧检查标 `skip`）；`--bundle` 默认是本包根目录，只有校验打包副本时才需要。
- 检查项：本包 `package.json` / `exports` / `dsh.bundle.patch` / `dependencies` 是否为空、profile 的
  `dsh.profile.bundles` 是否含团队 profile 与本包、`dependencies` 里的 `@local/*` 与
  `node_modules/@local` 是否一致、项目侧 `INDEX.md` / `re/project.json` /
  `.agents/skills/reverse-project-management/`（含团队规则与 `scripts/project.py`）、Python 可达性。

## 卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
# 1) 从 package.json 的 dsh.profile.bundles 里删掉 "@local/dsh-redteam-lead"
# 2) pnpm remove @local/dsh-redteam-lead
```

本包**不写**任何项目内文件之外的全局状态，也不改既有 `redteam` preset 或 `@local/dsh-rea-plugin`
的任何文件与配置；卸载不需要回滚别的东西。若 `re/team/**` 下已有绑定/派发记录，它们留在项目里，由
后续 ticket 提供的恢复/接管流程处理。

## 工具面与边界

- 工具面 = 宿主 `standard` preset 的 `config.plugins` **整段手抄副本**，只做三处改动：
  删掉 `tool-subagent-control` / `tool-subagent-list-agents`（它们提供的
  `send_message` / `interrupt_agent` / `list_agents` 与团队服务按 agent 注册的同名工具冲突且语义不同），
  把 `persona` 换成角色中立的人设，追加本包行。保留 `tool-subagent` / `tool-subagent-fork` /
  `workflow-ptc` / `tool-workflow`（Lead 用于零碎活）。
- **不新增任何 `tools/pre-execute` / `tools/post-execute` 拦截钩子**，不做命令扫描、不加命令门闸。
  既有 `@local/dsh-rea-plugin` 的拦截与审计照旧工作（它的 `scopePresets` 白名单不含 `redteam-lead`，
  所以拦截与影子模式提示在本 preset 下不生效——那是有意的边界，不是本包能改的）。
- **人设角色中立**：工兵继承同一 preset 也读这条人设；角色由 runtime context 的 `team:identity` 注入。
  persona 行必须 `complete: false`，否则会把 `team:policy` 段吃掉。
- **preset 里不声明 sandbox / approval 设置**：提供服务的插件若随 preset 泄漏到 root realm，注册表会把
  整棵 preset 判成 `broken`；权限属于 host 平面，不是本包职责。

## 已知限制

1. **`workflow` 是 depth-1 工兵的未受限逃逸口**（DECISIONS D5）：`subagent` / `subagent_fork` 会被
   depth 策略挡住，但 `workflow` 传了 `parent` 而没传 `maxDepth`。本包不声称平台挡住一切下一层创建；
   补偿控制是派发契约里明写「你没有派发权，缺人就报回来」+ 团队服务自身的 `TEAM_LEAD_REQUIRED`。
   这一条同时记在 `docs/verify/` 的 L3 待实测项里。
2. **工具面是手抄副本、没有 extends**：宿主升级改名或改 Config 时，表现是 preset 挂载失败（roster 里
   仍在、带 `broken` 诊断），不会自动跟随。基线固定在 **rc.3**（`docs/impl/baseline/standard.patch.rc3.yml`），
   复核方式是重新从 asar 抽 `standard.patch.yml` 与本包的 `cordis.patch.yml` 逐行 diff。
3. **locale 只影响显示名**：宿主只消费 `locale/*.json` 的 `meta.title` / `meta.description`；
   **工具描述不做本地化**（`description` 是裸字符串，直接进模型上下文），所以工具文案只有英文一份。
4. **doctor 只报配置**：它看不到团队服务、也看不到会话状态；`runtime_ready` 永远是 `unknown`。

## 开发

```powershell
cd packages/dsh-redteam-lead
node --test "test/**/*.test.mjs"     # 仓库根：node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```

> 门禁命令必须写成显式 glob（DECISIONS D20）：裸 `node --test` 会把 `test/helpers/*.mjs` 也当测试文件跑；
> `node --test test` 在 Node 24 上直接失败（位置参数按 glob 解释，不展开目录）。

`test/bundle.test.mjs` 里三条「工具注册/路由」用例在 T1/T3/T4 模块尚未合入时会
`t.skip('waiting for sibling modules …')`——这是**故意**的：不为了跑绿而造假 stub。
