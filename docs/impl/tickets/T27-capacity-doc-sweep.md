# T27：容量扫尾 —— 规格主文档与 L3 文档仍在教旧做法

状态：待办（**Lead 授权**：可改下方列出的 `docs/specs/**` 与 `docs/verify/**`）
背景：T23（删代码，净 −4848）→ T25（删规格键）→ T26（清 catalog 默认值与四份文档）之后，
仍有 **1 份规格 + 4 份 L3 文档**按"声明容量 / 读余额 / 未知就报未知"的旧口径写。
这轮反复出现的教训是：**删掉实现、文档还在教旧做法，模型就会照文档做**（人设那次就是）。

## 1. 规格主文档（最高优先，它和别的规格直接打架）

`docs/specs/rea-multi-agent.md`：

- `:214`、`:259` 仍写"成员/activation 的余额与预留""未知就报告未知"。
- 与 `docs/specs/orchestration-contract.md:44/48` **直接冲突** —— 后者已是现行口径：
  宿主不公开上限、本插件不预测/不预留/不为"学一次上限"而试探、只把已用席位作为诊断如实报出、被拒按宿主原话返回 `CAPACITY_EXHAUSTED`。

改法：把这两处改成与 `orchestration-contract.md` 一致，或注明"容量一节见 orchestration-contract"。
**不要整篇重写**，只动这两处口径。

## 2. L3 文档（操作手册与清单，会误导执行者）

| 文件 | 位置 | 问题 |
|---|---|---|
| `docs/verify/l3-checklist.md` | `:100`、`:106`、`:114-116`、`:126-127`、`:134`、`:139`、`:376` | 断言仍要求"读容量余额 / 未知就拒 / 声明后重跑" |
| `docs/verify/l3-record-template.md` | `:128`、`:138`、`:150` | 记录模板仍要填 `capacity` 字段 |
| `docs/verify/README.md` | `:228` | 仍把 `CAPACITY_UNKNOWN` 映射到"写 `re/team/capacity.json`" |
| `docs/verify/l3-runbook.md` | `:99` | 仍写 `remaining_activations` + `ACTIVATION_USAGE_UNOBSERVED`（语义已废） |
| `docs/verify/l3-round3-prompt.md` | 整份 | 是 T18 时代的容量探测提示词（`:14-15`、`:57-86`、`:138`），照它跑会测不存在的东西 |

改法：

- 清单里原来"容量"那几条断言，**改写成现行行为**而不是静默删掉：①传 `capacity` 应被当未知字段拒绝（`INVALID_ARGUMENT`）；
  ②宿主真的拒绝时，回执 `code=CAPACITY_EXHAUSTED` 且 diagnostics **逐字含宿主原话**，不出现"烧掉/损失一个席位"；
  ③`re/team/` 下不出现任何 capacity 相关文件。记不住编号就保留原编号、把判据换掉并在括号里注明 `(T23 起)`。
- `l3-record-template.md` 的 `capacity` 字段换成"已用席位（来自宿主名册）"。
- `README.md:228` 的错误码映射表删掉该行或改为"保留码，本插件不再产生"。
- `l3-runbook.md:99` 删 `remaining_activations` 那句。
- `l3-round3-prompt.md` **保留文件**（它是第三轮的取证提示词，属历史），**顶部加一段醒目说明**：
  该提示词的容量部分（步 A/B/C）对应已删除的机制，照它跑会得到与实现不符的结论；现行容量判据见 `l3-checklist.md`。

## 3. 用例数陈旧

`docs/verify/acceptance-status.md:41` 写"567 用例"，实际 **574**（T23/T25/T26/T24 之后）。改成 574，
并说明这是"全量用例数；不含 T22 的偶发红说明"。

## 验收

1. `git grep -n "capacity.json" -- docs/verify docs/specs README.md` → **0 命中**
   （`docs/verify/records/**` 与 `docs/impl/tickets/**` 里的历史记述**不算**，本票不动它们）。
2. `git grep -n "remaining_activations\|ACTIVATION_USAGE_UNOBSERVED\|recommended_members" -- docs/verify` → 0 命中（records/ 除外）。
3. `rea-multi-agent.md` 与 `orchestration-contract.md` 在容量口径上不再互相矛盾（引用同一结论）。
4. `l3-round3-prompt.md` 顶部有"已失效"说明，且未删正文。
5. `acceptance-status.md` 的用例数与实际门禁一致。
6. 全量门禁全绿（注意 T22 的 `l2/lock.test.mjs` 偶发红，约 1/3，别当回归）。

## 硬约束

- **不动** `docs/verify/records/**`（历史记录）、`docs/impl/tickets/T18*/T19*`（历史票）。
- 不动 `reserved_posts`（岗位名，与容量无关）。
- 不跑 L3、不碰 `D:\workSpace\_l3-verify`。
- 不 push、不合并、不动 `main`。Lead 审后合。
- 本票**只改文档**，预期不动 `src/`/`dist/`。若你发现必须改代码才能让文档自洽，**停下来报**，不要私自改实现。

## 写作用域（预估）

`docs/specs/rea-multi-agent.md`、`docs/verify/{l3-checklist,l3-record-template,README,l3-runbook,l3-round3-prompt,acceptance-status}.md`
