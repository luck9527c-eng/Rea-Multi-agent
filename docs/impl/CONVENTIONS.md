# 实现约定（所有 ticket 共用）

> 本文件是实现的唯一工程约定来源。ticket 只写「做什么」，工程形状看这里。

## 目标产物

一个本地 `link:` 安装的 DSH bundle，包名 `@local/dsh-redteam-lead`，仓库内放在 `packages/dsh-redteam-lead/`。形态与既有参考实现 `@local/dsh-rea-plugin`（`D:\workSpace\DSH\redteam-preset`）一致：npm 包 + `dsh.bundle.patch` 指向的 `cordis.patch.yml`。

## 硬约束

1. **零运行时依赖。** `dependencies` 必须为空。**零个 `@deepseek-ai/*` import** —— 本地 link 的 bundle 按自身真实路径解析裸包名，`import '@deepseek-ai/...'` 会 `ERR_MODULE_NOT_FOUND`。宿主能力一律通过注入的 `ctx` 取。
2. **TypeScript 源码（`src/**/*.ts`）+ 纯 ESM 产物（`dist/**/*.js`）**。源码带类型注解，`tsc -p packages/dsh-redteam-lead/tsconfig.json` 编到 `dist/`；`dist/` **随仓库提交**（`link:` 安装不触发 `prepare`，见 [DECISIONS D28](DECISIONS.md)），所以改了 `src/` 必须 `npm.cmd run build` 并把 `dist/` 一起提交。包的 `main`/`exports` 指向 `dist/index.js`，`type: "module"`，测试用 `node --test` 跑 `*.test.mjs`（测试本身是手写 JS，不参与编译）。
3. **工具入参用原始 JSON Schema**（对象级 `required: [...]`），本包自己做入参校验。每个工具必须显式声明 `output.schema` 与 `render`，注册表按该 schema 校验返回值。
4. **不新增任何 `tools/pre-execute` / `tools/post-execute` 拦截钩子。** 不写命令扫描、不做命令门闸。
5. **不 import、不修改 `@local/dsh-rea-plugin`**，不替它改配置。
6. 中文注释与文档，标识符英文。

## 目录与文件归属

见 [MODULE-MAP.md](MODULE-MAP.md)。**每个 ticket 只写自己 scope 内的文件**；跨 scope 的需求通过 Lead 记到后续 ticket，不要顺手改别人的文件。共享文件的唯一 owner 已在该表标注。

绕不开的外部事实（容量、任务板状态机、角色授权、depth、版本漂移、项目 skill 基线）**先读 [DECISIONS.md](DECISIONS.md)**，再读 [SEAMS.md](SEAMS.md)。DECISIONS 与 specs 冲突时以 DECISIONS 为准，并在报告里指出冲突。

## 代码风格

- 纯函数优先：决策（裁剪、匹配、校验、状态判定）写成接收显式输入的纯函数并单独测试；I/O 集中在 adapter 边界。
- 所有跨进程/磁盘写入走 `src/atomic.ts`（同目录临时文件 + 原子替换；不可变文件用独占创建）。
- 所有项目内路径走 `src/paths.ts` 校验后再用（`resolveInProject` 是唯一的解析入口，别再手写 `join(root, ...x.split('/'))`）；统一 `/` 分隔。
- 所有工具返回走 `src/envelope.ts` 的 `ok/blocked/partial/error` 信封；错误码只取 [编排契约](../specs/orchestration-contract.md#稳定错误码) 表里的稳定码。**`blocked` 与 `partial` 不是同义词**：前置拒绝（没有任何成员/任务/正式路线/正式证据变更）用 `blocked`；第一个持久副作用之后再失败一律 `partial`，并在 `data.phase` 带上阶段（`rt_conclude` 的分界线在 `archiveAttempt()`，见 `src/conclude.ts` 里的长注释）。
- 不吞异常：宿主/脚本失败要保留原始诊断与阶段，转成对应信封而非抛栈。
- 测试断言行为与状态，不断言内部函数名、日志文案或无意义调用顺序。

## 原子写与追加（`src/atomic.ts` 的唯一例外）

「原子替换」与「只追加」是两种不同的写入语义，不要互相冒充：

| 场景 | 入口 | 理由 |
|---|---|---|
| JSON / 提交 / 回执 / 纯文本（如 `INDEX.md`） | `writeJsonAtomic()` / `writeTextAtomic()` | 同目录临时文件 + `rename` 原子替换；失败自动清临时文件。 |
| 不可变文件（seal、契约、归档产物） | `createExclusive()` / `tryCreateExclusive()` | `O_EXCL` 独占创建；锁用后者（已存在即冲突，不读内容）。 |
| 审计日志 `re/team/audit.jsonl` | `appendLine()` | **追加**，不是替换。 |

- **为什么审计可以绕开原子替换**：契约要求审计 append-only（只追加、不重写、不回滚）。先读全文再原子替换会把并发的两次追加变成「后写覆盖先写」，破坏这个语义；`appendLine()` 用 `O_APPEND` 一次写到末尾。
- 这是本仓库里**唯一**允许的追加入口。业务模块不要 import `node:fs/promises` 的 `appendFile`；如果确实需要新的追加语义，先在这里加具名函数，再在 `CONVENTIONS` 里登记例外。

## 数据来源（不要重新定义）

| 需要什么 | 以什么为准 |
|---|---|
| 工具入参/出参形状 | `docs/specs/rt-tools.schema.json` 的 `$defs` |
| 跨字段/身份/路径/状态/恢复语义 | `docs/specs/orchestration-contract.md` |
| 四模板、岗位、能力族、优先级、锚点、禁止事项 | `docs/specs/roster-catalog.json` |
| 项目 skill 接入与写入归属 | `docs/specs/project-management-integration.md` |
| 工具清单与 provider 绑定 | `docs/specs/tool-discovery.md` |
| 验收编号 | `docs/specs/acceptance-matrix.md` |

**岗位目录与工具 Schema 是数据源，不是可改写对象。** 实现只读；若发现规格自洽性问题，报告 Lead，不要自行改 `docs/specs/`。

## 测试

- 位置：`packages/dsh-redteam-lead/test/<topic>.test.mjs`。
- **运行（唯一门禁命令，在仓库根执行）**：`npm run build && node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"`
  - **不要写 `node --test packages/dsh-redteam-lead/test`** —— 本机 Node v24.22.1 把位置参数当 glob，不展开目录，会报 `Cannot find module '…\test'`。
  - **也不要用裸 `node --test`** —— 默认发现规则会连 `test/helpers/*.mjs` 一起当测试文件执行，虚增计数并可能在将来产生副作用。显式 glob 只跑 `*.test.mjs`。
  - 只跑一层时同理，把 glob 换成对应子目录：`node --test "packages/dsh-redteam-lead/test/l2/*.test.mjs"`。
  - 用 `npm.cmd` 而不是 `npm`：PowerShell 执行策略会拦 `npm.ps1`。
- 接缝替身：团队服务用**契约级替身**（`test/helpers/fake-team.mjs`），项目 skill 用**真实 CLI**（L2）或 fake adapter（L1）。替身必须实现已核实的对外契约，不得简化状态机。
- 临时目录搭项目状态；不在测试里读写真实分析项目。
- 每个 ticket 交付的测试必须能在**干净 checkout** 上 `node --test` 全绿。

## 命名

- 工具名：`rt_roster` / `rt_dispatch` / `rt_conclude`。
- preset id：`redteam-lead`，显示名「红队指挥」，`order: 6`。
- 项目内新增路径只允许 `re/team/**`，见协作契约表格。
- 成员名建议 `rt-<post>`、`rt-<post>-2`；必须满足平台规则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64、≠`lead`。

## worktree 与分支协议（每个 implementer 必须执行）

基线：integration branch = **`feat/redteam-lead`**（仓库 `D:\workSpace\Rea-Multi-agent`）。

开工前：

```powershell
cd D:\workSpace\Rea-Multi-agent
git worktree add D:\workSpace\rea-ma-wt\<ticket> -b <ticket>-<slug> feat/redteam-lead
cd D:\workSpace\rea-ma-wt\<ticket>
git merge-base --is-ancestor feat/redteam-lead HEAD ; git log --oneline -1
```

若 worktree 未基于 `feat/redteam-lead` 的 tip，先 `git reset --hard feat/redteam-lead`。

开工第一件事：加载 `tdd` skill 并按其流程做（先写失败测试，再实现，再重构）。

报告完成前：

```powershell
npm.cmd run build                   # 改了 src/ 就必须重建：dist/ 随仓库提交（D28）
git add -A
git commit -m "<type>: <what>"      # 可多次提交
git fetch . feat/redteam-lead
git merge --no-ff feat/redteam-lead  # 把 integration tip 合进自己的分支
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"   # 唯一门禁命令，必须全绿
```

合并冲突自己解决，解决后再跑一次测试。**不要 push，不要动 main，不要动别人的 worktree。**

报告内容：分支名、commit 列表、`node --test` 尾行输出、新增/修改文件清单、未完成项与偏差、以及任何需要 Lead 决策的事实。
