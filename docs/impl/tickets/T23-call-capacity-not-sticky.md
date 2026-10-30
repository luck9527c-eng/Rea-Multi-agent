# T23：按调用声明的容量不会传给 `rt_dispatch`，导致同一会话里反复报"容量未声明"

状态：待办（**含一处设计裁决**，见「需要拍板」）
来源：真会话 `session-eda089ea-1e8a-465d-958c-9959492b4db2`（人设/工具描述改造后的首次实测）

## 观测

同一会话、同一个项目 `D:\workSpace\攻防演练`：

1. `rt_roster{action:"inspect", capacity:{max_members:6, max_active_subagents:3}, reserved_member_slots:0, reserved_activations:6}`
   → 成功，`capacity_source=call`，诊断原文：
   > `[CAPACITY_SOURCE] 容量来源 capacity_source=call：本次调用声明 maxMembers=6、maxActiveSubagents=3（优先于 re/team/capacity.json 与 profile config.capacity）`
2. 紧接着 `rt_dispatch{operation_id:"op-r002-dispatch-01", ...}`（**没传 capacity**）→ 成功，但诊断：
   > `[CAPACITY_SOURCE] 容量来源 capacity_source=unknown：re/team/capacity.json 与 profile config.capacity 都没有声明，本会话也还没有观测值`
   > `[CAPACITY_UNDECLARED] 容量未声明（capacity_source=unknown）… 本次派发照派，但**不保证**有位置：宿主若因上限拒绝创建，最多可能损失一个成员名与一个席位…`
3. 第二次 `rt_dispatch`（`op-r003-dispatch-01`）同样报 `capacity_source=unknown`，`当前已用席位 1`。

即：**上一步刚用调用参数声明过容量，下一步就说"没声明"**，还带着"可能损失一个成员名与席位"的措辞。

## 根因（已核对代码与设计）

- 容量优先级是**逐次调用即时求值**（D40：`call > re/team/capacity.json > profile config.capacity > 本会话观测值 > unknown`）。
- 按调用传入的 `capacity` **不落盘**：`re/team/binding.json` 不存容量（第三轮 L3 记录 §2 已实测确认）；`re/team/capacity.json` 按 SEAMS §7 是"项目/操作者显式声明，插件只读、**不写**"。
- 因此后续 `rt_dispatch` 求值时确实看不到上一步的 `call` 声明 —— **这是实现忠实于当前设计**，但用户体验与措辞是错的：
  它把一个"你没重复传参"的情况说成了"项目没有任何容量来源"。

## 为什么值得修

1. 模型在实测里只能**每次派发都重新传 `capacity`**，多花调用、也容易漏；漏了就吃一段"最多可能损失一个成员名与席位"的恐吓式措辞（而这句话本身在席位满时并不成立，属 N2/T19 同类）。
2. 这条措辞会诱导模型为了"确认余额"去探测 —— 而 D40 明确禁止主动探测（诊断里自己就写着"不要为了试探余额而派发"）。**自相矛盾。**

## 需要拍板（两种走法，二选一）

**A. 会话内粘性**：`rt_roster(bind)` 成功后把该次 `call` 容量记进 `re/team/binding.json`（插件拥有该文件，不越权写 `capacity.json`），
`rt_dispatch` 求值时插入一档 `capacity_source=binding`（优先级介于 `project` 与 `observed` 之间），并在诊断里说明"来自本会话 bind 时的调用参数"。

- 优点：符合直觉，模型声明一次即可；不新增文件。
- 代价：**改 D40 的优先级表**（要写进 `docs/impl/DECISIONS.md`），且要处理"bind 之后换容量"的语义（重 bind？覆盖？下一次 bind 才生效？）。

**B. 明确"不粘性"，只修措辞与文档**：

- `rt_roster(inspect)` 的返回里显式说明"按调用容量只对本次调用有效，`rt_dispatch` 需再传"；
- `rt_dispatch` 在 `unknown` 且**本会话曾传过** `capacity` 时，措辞改为"本次未传容量，将按 unknown 处理"，不再说"项目没有任何容量来源"。

- 优点：不动 D40、风险低、随时可做。
- 代价：模型仍需每次传参（只是不再被误导）。

> 建议：先做 **B**（当天可交付），把 **A** 留作设计变更单独立票。B 能把"自相矛盾的恐吓措辞"立刻消掉。

## 验收

无论选 A 还是 B：

1. 构造用例：`rt_roster(bind)` 传 `capacity` → 紧接着不传 `capacity` 调 `rt_dispatch`。
   - 选 A：dispatch 诊断的 `capacity_source` 必须是 `binding`（或等价新值），且**不得**出现"都没有声明"。
   - 选 B：diagnostics 必须明确"本次未传容量"，**不得**出现"re/team/capacity.json 与 profile config.capacity 都没有声明"这种与事实不符的断言
     （项目里可能确实没有，但本会话刚刚传过 —— 措辞不能说"本会话也还没有"）。
2. 不得在"未声明"分支再出现"最多可能损失一个成员名与席位"这类在席位满时不成立的损坏描述（与 T19 同口径）。
3. `docs/impl/DECISIONS.md` 记录裁决；若选 A，同步改 D40 的优先级表与「落地口径」。
4. 回归：既有 `capacity.test.mjs` / `dispatch.test.mjs` / T18/T18b/T18c/T19 用例全绿；全量门禁跑 ≥10 次无新增红（见 T22）。

## 写作用域（预估）

- `src/capacity-source.ts`、`src/dispatch.ts`、`src/roster.ts`（若选 A 还要 `src/binding.ts`）、`dist/**`
- `docs/impl/DECISIONS.md`
- 测试：`test/capacity-*.test.mjs` / `test/dispatch*.test.mjs`（新增 2–4 例）
