# 历史归档 · 已失效 · 请勿按此执行

> **已失效（T27，2026-10-30）——只作第三轮取证的历史凭据，不要再照它执行。** 其中步 A/B/C 的容量探测对应已删除的机制（T23/T25），照跑会得到与实现不符的结论；现行判据见 [`l3-checklist.md`](l3-checklist.md) 第 2/3 步的 `(T23 起)` 条目。

> 用途：把下面「给执行者」那段整体发给新会话的执行者（需要能真实调用 `rt_*` 工具的会话）。
> 为什么要有第三轮：第二轮之后合入了 T15–T20 六个票，**全部改了运行时行为**；L1/L2 已经反复证明抓不到真契约问题。
> 本轮目标不是"再跑一遍七步"，而是**只打这六个票改动的那些路径**，并把 A09/A38/A40 从 `not-run` 变实。

## 本轮要证的六件事（对应票）

| # | 被改的东西 | 票 | 要看什么 |
|---|---|---|---|
| 1 | `tools.schemas()` 是**数组 + `.name`**，不是键名对象 | T15 | `rt_dispatch` 不再 `CAPABILITY_MISSING`；`rt_roster` 的 available 列表对得上 |
| 2 | `route.evidence` 曾经恒为 `[]` | T16 | 收口后 `route.evidence` **非空**，且与锚点一致 |
| 3 | baseline 从未冻结下游产物，篡改要到最后 `check --hashes` 才发现 | T17 | 篡改已封存 RUN 产物 → 收口**写盘之前**就 `BASELINE_MISMATCH`（`blocked`） |
| 4 | 容量：call > 项目 > profile > 观测 > unknown | T18 | 未声明时照派但带 `CAPACITY_UNDECLARED`；**不是** `CAPACITY_UNKNOWN` 拒绝 |
| 5 | 宿主真实上限从宿主错误消息里**学到** | T18b | `re/team/capacity-observed.json` 出现，`basis.parsed_limit` 是**准确数**而不是猜的 |
| 6 | 两条容量拒绝**损坏语义不同**；非焚烧类**不点名** | T18c/T19 | 席位满：不烧名字不烧席位、回执**不带 `member` 键**、措辞说"写成员行之前" |
| 7 | `rt_roster` 的 render 补了容量/缺口/会话身份 | T20 | render 里能看到这三样 → 解锁 A09/A38/A40 |

## 铁律（违反就别报 pass）

1. **只报告观察到的事实**，不做判定，不说"应该没问题"。
2. **不许预先假定宿主上限是几。** 学到多少记多少；没学到就记没学到。
3. **不许为了凑出 `ACTIVATION_LIMIT_REACHED` 而故意烧名字/席位。** 那条是"写成员行之后"才失败的，触发即真实损毁。本轮默认**不测**它；真撞上了如实记。
4. 某步失败：**立即停**，存完整信封 + `diagnostics[]` + before/after/diff + doctor 输出，然后报回来。**不要重跑同一会话。**
5. `capacity-observed.json` / `capacity-observing.json` / 锁文件：**只报告，不自动清理**。观察标记残留只在确认名册没变后手工删。
6. 本轮**不改代码**，所以**不需要重启 DSH**。若你改了 `dist/` 里任何字节，必须重启后才能再测，且要在报告里写明。

---

## 给执行者

你是第三轮 L3 验收执行者。前置 1–4 步先做完再动 `rt_*`。

**路径**

- 临时分析项目根：`D:\workSpace\_l3-verify\proj`
- 证据目录：`D:\workSpace\_l3-verify\evidence\`（本轮统一前缀 `r3-`）
- 取证脚本：`D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead\scripts\l3-verify.mjs`
- 判据清单：`D:\workSpace\Rea-Multi-agent\docs\verify\l3-checklist.md`
- 运行手册：`D:\workSpace\Rea-Multi-agent\docs\verify\l3-runbook.md`
- 第二轮记录：`D:\workSpace\Rea-Multi-agent\docs\verify\records\20261029-session-040cb6df.md`

**前置**

1. 读 `l3-checklist.md` 与 `l3-runbook.md`，再读第二轮记录，知道哪些已验过、哪些是 `not-run`。
2. 确认仓库在 `feat/redteam-lead` 且干净：`git -C D:\workSpace\Rea-Multi-agent log --oneline -1; git -C D:\workSpace\Rea-Multi-agent status --porcelain`。
3. 确认 `dist/` 与源码同步（**只读检查，不重建**）：
   `cd D:\workSpace\Rea-Multi-agent; npm.cmd run typecheck`（应 0 错）。
4. doctor：
   `node D:\workSpace\Rea-Multi-agent\packages\dsh-redteam-lead\bin\doctor.mjs --profile C:\Users\Administrator\.dsh\profiles\desktop --project D:\workSpace\_l3-verify\proj`
   记下 `status` / `configuration_ready` / `runtime_ready`。

**每一步的取证规矩**：开始前 `collect --out r3-sN-before.json`，结束后 `collect --out r3-sN-after.json`，再 `diff`。三个文件都留在证据目录。

---

### 步 A —— 未声明容量路径（T18 的 `CAPACITY_UNDECLARED`）

先把项目容量声明**移开**（不要删，要能还原）：

```powershell
Rename-Item D:\workSpace\_l3-verify\proj\re\team\capacity.json capacity.json.r3bak
```

然后：

1. `rt_roster`（inspect 或 bind，按清单）。
2. `rt_dispatch` 一个成员。

**要记**：有没有 `CAPACITY_UNDECLARED`；它是 `warning` 还是拒绝；`capacity_source` 是不是 `unknown`；派发**是否照派**（D40 规定照派 —— 如果被拒了，这是**与规格的偏差**，必须原样报回来，别自己解释掉）。完整 `diagnostics[]` 逐字贴。

> 背景：`docs/specs` 原文要求"无法取得额度时返回 `CAPACITY_UNKNOWN`"，我们**故意**偏离成"照派 + 警告"（D40）。本轮就是要在真实宿主上确认这个偏离没把插件变成不可用。

### 步 B —— 学到真实上限（T18b）

**保持 `capacity.json` 移开状态**（观测值优先级最低，项目声明会盖住它，必须在未声明下学）。

继续 `rt_dispatch`，直到宿主真的因为容量拒绝一次。

**要记**：

- 一共派了几个才撞上（这个数本身就是证据）。
- 宿主返回的**原始错误码与错误消息逐字**。
- `re/team/capacity-observed.json` 是否出现；把整个文件贴回来，特别确认 `basis.parsed_limit` 是**从消息里解析出的准确数**、`basis.used_at_observation`、`basis.host_code`。
- 学到之后再 `rt_roster`：容量显示是否变成**准确值**（而不是 `null`/unknown）。
- 有没有 `capacity-observing.json` 残留。

> 如果宿主一直不拒绝（比如上限远大于你愿意派的数量），**就停下**记"未触发学习"，不要硬灌。

### 步 C —— 按调用指定容量 + 非焚烧类拒绝（T18c / T19）

用 `rt_roster(bind)` 显式传一个**故意很小**的按调用容量（例：`maxMembers=1`）。按调用优先级最高，压过一切。

1. 派第 1 个：应成功。
2. 派第 2 个：应被**闸门**拒。

**要记**（这是 T19 的核心）：

- 回执里**有没有 `member` 键** —— 预期**没有**（不是 `null`，是键不存在）。若出现 `"member": null`，那是**回退到被否决的写法**，必须报。
- 措辞是否说"宿主会在**写成员行之前**拒绝，名字与席位都不会被占用"，还是仍说"避免再烧一个名字与席位"。**逐字贴。**
- `role` / 状态：拒绝回执是 `partial` 还是 `blocked`（T19 记录为 `partial`，要实测确认）。
- `collect` 前后 `digest` 是否相同（零副作用）。
- 名册：那个名字**是否被占**（可以用同名再试一次判断，`TEAM_MEMBER_LIMIT` 语义下同名重试合法）。

### 步 D —— `rt_roster` 的 render（T20 → A09/A38/A40）

把 `rt_roster` 的三次调用结果**原样保存**（不仅是 `data`，要**渲染出来的文本**）：

1. 未声明时
2. 学到上限后
3. 按调用指定容量时

**要记**：render 里能不能看到 **容量**、**缺口（gap）**、**会话身份** 三样。逐字贴渲染文本。

> 这三条在第二轮是 `not-run`，原因就是旧 render 看不到这些；T20 之后应该能判了。**判不了也要说判不了，别猜。**

### 步 E —— `route.evidence` 非空（T16）

走一次真实收口（按运行手册第六步的形状）：

**要记**：收口后 `re/team/…` 里 route 记录的 `evidence` 字段 —— 第二轮恒为 `[]`，T16 后应**非空**且与所交锚点对得上。贴原始 JSON 片段。

### 步 F —— baseline 前置拦截（T17）

交一个带真 RUN 和 `artifact_locator` 锚点的 `finding`；在收口**之前**，篡改那个已封存的 RUN 产物一个字节。

**要记**：

- 错误码是否 `BASELINE_MISMATCH`。
- 状态是否 `blocked`。
- **关键**：是不是在写 route/index **之前**就拦住了 —— 用 `collect` 的 `digest` 证明 route/index/台账都**没被写**（第二轮是到最后 `check --hashes` 才发现，本轮要证明提前了）。
- 篡改前记得备份原字节以便还原。

---

### 收尾

1. 还原 `capacity.json.r3bak` → `capacity.json`（若你判断应该保留未声明状态，说明理由再留）。
2. 还原被篡改的产物字节。
3. 报告：**每步原始返回文件清单**、每步 before/after/diff 摘要、以及**你观察到的异常（只描述事实，不判定）**。
4. 不要自己改 `docs/verify/records/`、不要改 `acceptance-status.md` —— 把结论留给 Lead 落。

## 报回来之后 Lead 要做的

- 把六件事的实测结果并进 `acceptance-status.md`，A09/A38/A40 该升级的升级（**只在有真实会话证据时**）。
- 若步 A 真的被拒（偏离失效）或步 C 出现 `member: null`（回退），开修复票 —— 这两个都是"文档说改了、实际没改"的典型。
- 写下一次记录：`docs/verify/records/YYYYMMDD-session-<id>.md`。
