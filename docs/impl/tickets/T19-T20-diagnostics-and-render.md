# T19 / T20 — 诊断分寸收尾 与 `rt_roster` render 补字段

> **已被 T23 取代**（2026-10-30）：本票引入的容量推断机与容量声明文件已整体删除（见 [DECISIONS](../DECISIONS.md) D41）。原文保留作历史记录，**不再作为实现口径**。


**Blocked by:** T18c（已合并，593 用例绿）

---

## T19 — 非焚烧类拒绝的措辞与 `member` 字段

来源：T18c 的报告（三条「看起来像虚报的地方」）。已合并的 T18c 只改了 `TEAM_MEMBER_LIMIT` 的主诊断；这三条还没清。

### 要做

1. **闸门拒绝文案**：容量判决里有一句 `…不再创建成员（避免再烧一个名字与席位）`。当学到的上限来自**席位满**（`TEAM_MEMBER_LIMIT`，不焚烧）时，这句话是虚报。按拒绝类型分支：
   - 焚烧类（`ACTIVATION_LIMIT_REACHED` / 未知码）→ 保留"会烧掉"的措辞；
   - 非焚烧类（`TEAM_MEMBER_LIMIT`）→ 改成"宿主会在写成员行之前拒绝，名字与席位都不会被占用"。
2. **`data.member` 不得点名不存在的成员**：席位满的失败回执里现在写 `member: "rt-cross-check"`，而名册里没有这个成员 —— 等于承诺一个不存在的对象。非焚烧类拒绝时给 `member: null`；焚烧类才点名。
3. **typo**：`解析出的activation 池大小准确值` → 补分隔（`解析出的 activation 池大小准确值`）。

### 不要做

- 不要动 `capacityFailureReason` / `capacityFailureNextStep` 那条死路径（`envelope.fail()` 在 diagnostics 非空时丢这两个字段）。那是另一票的事，改动会动回执诊断条数。
- 不要改容量优先级、观测值语义、并发保护。

### 测试

- 席位满导致的拒绝：诊断里**不出现**"烧掉/再烧"这类措辞；`data.member === null`。
- activation 池满导致的拒绝：诊断里出现"已烧掉、不得同名重试"；`data.member` 点名。
- 未知宿主码：保持保守（"已烧掉"），且 `data.member` 点名。

---

## T20 — `rt_roster` 的 render 补上验收与排查需要的字段

来源：L3 两轮的共同阻塞。`rosterData` **数据里有** `capacity`、`gaps[].code`、`session`；但 `output.render` 只输出计数，所以：

- 模型（和验收）看不到"每个岗位缺什么能力"，只能去翻 `re/team/operations/*.json`；
- 三个验收行（A09 / A38 / A40）因此一直 `not-run`，因为它们的判据在工具面上不可观察。

### 要做

只改 `src/index.ts` 里 `rt_roster` 的 `render`（**不动 `output.schema`，不动 wire data**）：

1. `capacity`：把 4 个字段都打出来（`remaining_member_slots` / `remaining_activations` / `reserved_member_slots` / `reserved_activations`），未知显示 `null`。
2. `gaps`：每条打 `code` + 一行 `reason`（不再只有条数）。
3. `session`：打出 `session_id` / `team_id`（`rt_roster` 的 data 里有）。
4. 保持简短：`posts` 仍然只打摘要（`post_id` + `state` + 缺的能力族名），不要整段 JSON。
5. `render` 必须**纯且全能**（宿主对每个成功调用都跑它；抛错 = `INVALID_TOOL_OUTPUT`）。对缺字段/异常形状要降级而不能抛。

### 测试

- `capacity` 四个字段都出现在渲染文本里；未知值渲染成 `null` 而不是抛。
- 至少一条 `gaps` 的 `code` 出现在渲染文本里。
- `session_id` 出现在渲染文本里。
- 给 render 喂病态 data（缺 `gaps`、`gaps` 不是数组、`capacity` 为 null、`posts` 元素缺字段）→ **不抛**，输出可读降级文本。

---

## 共同门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线 **593 pass / 0 fail / 0 skip**、`tsc` 0 错。改 `src/` 必须重建并提交 `dist/`。不得改 `cordis.patch.yml` / `locale/` / `docs/specs/**`；无 `any` / `@ts-expect-error` / 裸 `!`。
