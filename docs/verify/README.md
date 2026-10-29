# 第三层验收（真团队服务）怎么跑

> ## 状态：**未执行**
>
> 本目录里的东西是**待办与判定标准**，不是通过记录。截至本文件写下时：
>
> - `docs/verify/l3-checklist.md` 已生成（七步 × 54 条断言），**一条都没跑过**；
> - `packages/dsh-redteam-lead/scripts/l3-verify.mjs` 的 `collect` / `diff` / `checklist` 只在**人造的
>   `re/` 目录树**上验证过（见 T9 的报告），没有在真实会话里用过；
> - `docs/verify/acceptance-status.md`（T10 已补全 A01–A44 全表）里所有 L3 行都是 `not-run`，
>   直到有人按本文件填完记录；L1/L2 行的判定见该表的证据列。
>
> 不要把"脚本能生成清单"读成"验收已通过"。

## 这一层为什么不能自动化

第三层要跑真实的 `ctx.agentTeams`。宿主包只存在于打包的 `app.asar` 里，磁盘上没有可用的
`@deepseek-ai/dsh-tools` 入口，裸 `node` 也无法从 asar `require`。所以它只能是**一个人在一次性 DSH
会话里照清单做一遍**，把原始输出贴回来，再由第二个人（或 T10）判定。

本工具包能做的只有两件事：**给判据**（清单）和**给机读证据**（`collect`/`diff` 的项目侧文件哈希）。
它不能替人执行会话，也不能替人判定"这条断言是否成立"。

## 前置条件（五项，缺一项就别开始）

逐条核对，全部满足再开会话。任何一项不满足时，`bin/doctor.mjs` 会给出对应的 `next_step`——先按它修，
不要带着缺口开始验收（否则失败原因无法归因）。

### 1. 团队 profile bundle 已启用

`@deepseek-ai/dsh-experimental-agent-team-profile` 必须出现在 profile 的 `dsh.profile.bundles` 里。
它随安装提供但默认关闭，而且**没有**按 bundle 的 `disabled` 字段——唯一的启用方式是列进 `bundles`。
没有它就没有 `ctx.agentTeams`，三个 rt 工具只会返回 `TEAM_SERVICE_UNAVAILABLE`。

### 2. 本 bundle 已 `link:` 安装**并**列进 `bundles`

两件事都要做，只做一件都是"看起来装了、其实没生效"：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop          # 换成你实际用的 profile
pnpm add "link:<仓库根>\packages\dsh-redteam-lead"  # 或 npm install
```

然后编辑该目录的 `package.json`，把本包加进 `dsh.profile.bundles`，**放在团队 profile 之后**：

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

- 只改 `dependencies` 不改 `bundles`：patch 层不会生效。
- 只改 `bundles` 不装依赖：`node_modules/@local/dsh-redteam-lead` 不存在，加载失败。
- patch 里写错插件名在宿主里是 **WARN + SKIP**（不报错、也不生效），所以必须靠 doctor 的
  `profile.bundle_listed` / `profile.bundle_declared` / `profile.bundle_linked` 三项都 `true` 来确认。

### 3. 临时分析项目已接入项目 skill

**不要**拿真实分析项目做验收（会往 `re/` 里写派发/回执/封存）。新建一个一次性目录，按项目 skill 的
`init` 生成，并确认：

- `INDEX.md` 存在；
- `re/project.json` 存在；
- `.agents/skills/reverse-project-management/` 是**项目副本**，且含 `references/team-coordination.md`
  （团队规则段）与 `scripts/project.py`（含它 import 的 governance/impact/integrity 模块）。

团队规则段缺失 → `rt_roster` 的兼容性判定会是 `SKILL_INCOMPATIBLE`。这是**正确**行为（DECISIONS D8：
不得用全局副本覆盖项目副本，也不得自动 `init` 已有项目）。要验收主路径，先把项目副本补齐。

### 4. Python 可达

`rt_conclude` 的归档/封存/校验走项目副本的 `project.py`。`python` 必须在 `PATH` 上（或项目配置里
指向可用解释器）；doctor 的 `project.python.ok` 为 `true`。

### 5. 证据目录在项目之外

`collect --out` / `diff --out` 会拒绝写进 `--project` 之内（脚本对项目只读）。准备一个独立目录，
例如 `D:\workSpace\PJ\_l3-<日期>\`。

### 前置自检（在普通 shell 里跑，不需要开会话）

```powershell
node <仓库根>\packages\dsh-redteam-lead\bin\doctor.mjs `
  --profile $env:USERPROFILE\.dsh\profiles\desktop `
  --project <临时项目根>
```

判据：`data.configuration_ready === true`、退出码 `0`、`data.runtime_ready === "unknown"`（**永远是
`unknown`**——离线不可能知道团队服务是否在跑，doctor 也不会假装知道）。`configuration_ready` 为
`false` 时，按 `diagnostics[].next_step` 逐条修完再继续。

> `doctor` 本身也是 A01 的验收对象：它必须在**没有团队服务**的环境里可达、给修复路径、且不假报
> `runtime_ready`。所以这一步的完整 stdout + 退出码要原样贴进记录。

## L2 用例的运行前提（换机器必读）

L2 用例（`packages/dsh-redteam-lead/test/l2/*.test.mjs`）**不是纯离线的**：它们要真实 `python`，还要一份
权威 skill 副本（`project.py` + `references/` + `assets/`）。两个环境变量控制它们：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RPM_SKILL_ROOT` | `C:/Users/Administrator/.agents/skills/reverse-project-management` | 权威 skill 副本根目录（l2/helpers.mjs 的 `SKILL_SOURCE`）。 |
| `RT_L2_PYTHON` | `python` | 解释器：绝对路径，或 `PATH` 上的名字。 |

**在另一台主机上必须显式设 `RPM_SKILL_ROOT`**（默认值写死了开发机的用户目录）。前提缺失时 L2 用例是
**skip 而不是 fail**：`environment()` 会给出具体原因（缺 Python / 缺副本 / 副本不完整），`node --test`
照样全绿。后果是：`acceptance-status.md` 里**证据列点到 `test/l2/*.test.mjs` 的行，在那台机器上没有证据**。

> 换句话说：**门禁全绿 ≠ 本表的 L2 行有证据**。换机器后要么设好变量重跑，要么把这些行按 `not-run`
> 处理（并在备注里写明「本机缺 L2 前提」）。这也是为什么 L2 行不能只看"测试没红"。

## 开一次性会话

1. 新建会话，模式选「红队指挥」（preset id `redteam-lead`）。**已有会话保留它启动时的 preset 版本**，
   改完 profile 必须新开会话才生效。
2. 记下会话标识：`rt_roster` 返回里的 `data.session_id` 与 `data.team_id`（席位按会话计，这两个值就是
   本次验收的团队身份）。
3. 这个会话只用于验收：不要在同一个会话里做别的工作，也不要把同一个临时项目同时开在第二个会话里
   （那会被判成另一个会话的绑定）。
4. 验收完丢弃会话。席位随会话释放，`re/team/**` 事实留在项目里（一次性项目直接删掉即可）。

## 每一步怎么记

固定循环（第 N 步）：

```powershell
node <仓库根>\packages\dsh-redteam-lead\scripts\l3-verify.mjs collect --project <项目根> --out <证据目录>\sN-before.json
# … 在会话里做这一步的操作 …
node <仓库根>\packages\dsh-redteam-lead\scripts\l3-verify.mjs collect --project <项目根> --out <证据目录>\sN-after.json
node <仓库根>\packages\dsh-redteam-lead\scripts\l3-verify.mjs diff --before <证据目录>\sN-before.json --after <证据目录>\sN-after.json --out <证据目录>\sN-diff.json
```

记录里每一步至少要贴：

| 项目 | 怎么来 |
|---|---|
| 工具与入参 | 你在会话里实际发的调用（`rt_*` / `team_*` / `send_message` / `interrupt_agent`），原样抄 |
| 原始返回 | 工具返回的**整段** JSON（不要复述、不要摘要、不要"大概是这样"） |
| 项目侧变化 | `sN-before.json` / `sN-after.json` / `sN-diff.json` 三个文件 + 它们的 SHA-256 |
| 断言判定 | 对着 `l3-checklist.md` 第 N 步逐条 `[x]`，失败的写清第几条与实测值 |
| 本步结论 | `pass` / `fail` / `not-run`（`not-run` 要写清缺什么） |

`collect` 的输出里有两个键要会用：

- `digest`：只覆盖 `(path, bytes, sha256)`，**不含 mtime**。两次 `collect` 的 `digest` 相同 = 项目内容
  完全没变（这是"零副作用"的机读判据）。
- `gaps`：缺失/读不到的显式清单。刚开会话时 `binding.json`、`dispatches/`、`receipts/` 缺失是**正常**的，
  照实贴即可，不要为了让 gap 变少而手工建文件。

> `collect` 与 `diff` 的 JSON 都是 **UTF-8 无 BOM**（里面的 `label` 有中文）。Windows PowerShell 5.1 的
> `Get-Content`/`ConvertFrom-Json` 默认按 ANSI 读，会乱码甚至报 JSON 解析错——读的时候加
> `-Encoding utf8`，或者直接用编辑器打开：

```powershell
Get-Content <证据目录>\sN-diff.json -Raw -Encoding utf8 | ConvertFrom-Json
```

## 通过了怎么归档

1. 从 `docs/verify/l3-record-template.md` 复制一份，命名 `<YYYYMMDD>-<session_id 前 8 位>.md`，
   放到 `docs/verify/records/`。
2. 证据文件放到 `docs/verify/records/<同名>/`：每步的 `collect`/`diff` JSON、doctor 输出、必要的
   原始工具返回文本。
3. 记录里写一张"附件清单"：`文件名 + 字节数 + SHA-256`（`collect` 里已经有项目侧文件的哈希，
   这里给出的是**证据文件自身**的哈希）。
4. 只有在**七步全部有判定**（允许某些断言 `not-run`，但每步都要有结论）之后，才把整层判成 `pass`。
   部分执行的记录照样归档，结论写 `not-run` 或 `fail`。
5. 总表 `docs/verify/acceptance-status.md` 由 T10 汇总（本 ticket 只建了 L3 空壳）；本文件只负责记录本身。

## 失败了怎么留证

**不要**为了变绿而重跑同一会话。按下面顺序做一次，然后停：

1. 记住**第一个**不成立的断言编号与步骤（后面的失败通常是它的后果）。
2. 原样保存那一刻的：工具返回（含完整 `envelope` 与 `diagnostics[]`）、`collect` before/after、
   `diff`、`bin/doctor.mjs` 输出。
3. 在记录里写"最小复现"：项目初始状态（哪些文件存在）、会话 id、用的 `operation_id`、第几次调用。
4. 判定写 `fail`，并写清期望值 vs 实测值。**不要**改记录去迁就实现，也不要删证据。
5. 需要重试时**新开一个一次性会话**，并在记录里注明"重试 #N，前置失败记录见 <文件>"。

## 收尾

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
# 1) 从 package.json 的 dsh.profile.bundles 里删掉 "@local/dsh-redteam-lead"
# 2) pnpm remove @local/dsh-redteam-lead
```

临时项目直接删。本插件不写项目之外的全局状态，卸载不需要回滚别的东西。

## 这套工具包**不能**证明什么（已知边界）

这些是设计上的可观察性上限，不是验收失败。清单里对应的断言已标「需构造」/「不可观察」。

1. **`workflow` 不受 depth 限制（DECISIONS D5）**：`subagent`/`subagent_fork` 会被 depth 挡住，但
   `workflow` 传 `parent` 而不传 `maxDepth`。真要验证就得让它开出孙代——**不要在验收里跑 `workflow`**，
   它会烧掉 activation 名额并污染后续步骤。这一条只作为已知限制记录。
2. **activation 占用不可观测**：宿主没有任何查询 activation 占用的 API。所以 `remaining_activations`
   只能来自项目/配置的**声明**，`ACTIVATION_USAGE_UNOBSERVED` 是一条 gap 而不是错误。
3. **同名工具的对照组不存在**：本 preset 已经删掉了 `tool-subagent-control` /
   `tool-subagent-list-agents` 两行，所以会话里没有两个活着的 `send_message` 可对比。能证明的是
   「留下的那个的参数面/行为属于团队版」+「被删的行确实不在 patch 里」。
4. **`send_message` 的返回只是投递确认**，不是对方的答复。nonce 必须从**后续团队消息**里读到。
5. **故障注入做不了**：A25（响应丢失）、A13（无 `start.json` 超时）需要杀进程/断连接，一次性会话里
   不可靠复现，只能记 `not-run`。
6. **`interrupt` 与唤醒的时序**受模型调度影响；"它没回 nonce"可能是还没处理，不是没收到——记录里要
   写清两次调用之间的间隔。

## 常见故障

| 现象 | 原因 | 处置 |
|---|---|---|
| `doctor` 报 `[profile.bundle-listed]` | `dsh.profile.bundles` 里没有本包 | 加进去，重启 DSH |
| `doctor` 报 `[profile.bundle-declared]` / `[profile.bundle-linked]` | `dependencies` 没写 / `link:` 没落进 `node_modules` | `pnpm add "link:…"` 后 `pnpm install` |
| 模式列表里没有「红队指挥」 | 旧会话沿用旧 preset，或 patch 行没生效 | **新开**会话；再看 doctor 三项是否为 `true` |
| `rt_roster` 返回 `TEAM_SERVICE_UNAVAILABLE` | 团队 profile bundle 没启用 | 把团队 profile 列进 `bundles` |
| `rt_roster` 返回 `SKILL_INCOMPATIBLE` | 项目副本缺团队规则段/`project.py` | 按 skill 合并项目副本，**不要**全局覆盖 |
| `CAPACITY_UNKNOWN` | 没有容量声明（D1） | 写 `re/team/capacity.json` 或改 profile `config.capacity` |
| `collect` 报 "--out 不能落在 --project 之内" | 证据目录放进了项目 | 换到项目外目录 |
