# T18b — 从宿主错误消息里读出**准确**上限，而不是推算"已到顶"

> **已被 T23 取代**（2026-10-30）：本票引入的容量推断机与容量声明文件已整体删除（见 [DECISIONS](../DECISIONS.md) D41）。原文保留作历史记录，**不再作为实现口径**。


**Blocked by:** T18

## 为什么

T18 的「撞一次就学」原本打算用 `used_at_observation`（观测当时的已用席位数）当上限 —— 那只能得出"你已经到顶了"，**不知道真实上限是多少**，所以学完之后只能一条路：继续拒绝。

对安装构建（`rc.3`）的 `app.asar` 核对后发现，**宿主抛错时把真实数字写在消息里**：

```js
// @deepseek-ai/dsh-subagent/lib/index.js:1047
throw new SubagentError(
  `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish or complete…`,
  "ACTIVATION_LIMIT_REACHED")

// @deepseek-ai/dsh-experimental-agent-team/lib/index.js:1024
throw new TeamError(`Team member limit ${this.maxMembers} reached`, "TEAM_MEMBER_LIMIT")
```

所以能拿到**准确值**，而不是推断值。差别很实际：

| | 用 `used_at_observation` | 用消息里的 N |
|---|---|---|
| 学到的 `max_members` | "≤ 上限"（已知到顶） | **准确 N** |
| 学到之后 | 只能拒绝继续建 | 能算出"别的 activation 释放后还能开几个"，`rt_roster` 也能给真实余量 |

## 另一个必须写进文档的事实

`dsh-subagent` 里容量是**每次预留时通过闭包读的**（`pool.reserve(this.maxActiveSubagents())`），说明它是**运行时可变**的 —— 用户在设置里改了就变。因此：

- 学到的值必须带 `observed_at`；
- 下一次撞到就用新值**覆盖**，不能当成永久常量；
- 文档里要写明"这个值可能因为改设置而失效"。

## 交付

1. **解析准确上限**（新增一个纯函数，放一处）：
   - `ACTIVATION_LIMIT_REACHED` → 从消息里取 `active child limit:\s*(\d+)`；
   - `TEAM_MEMBER_LIMIT` → 从消息里取 `Team member limit (\d+)`；
   - 取到就用它写 `max_members` / `max_active_subagents`；取不到回落到 T18 的 `used_at_observation`。
2. **`re/team/capacity-observed.json` 增加 `basis`**：`{ parsed_limit: <int|null>, used_at_observation: <int>, message: <原文> }`，让"这个数字从哪来"可查。
3. **覆盖语义**：同会话内再次撞到且解析出的值不同 → 覆盖并更新 `observed_at`；解析失败的一次**不得**把已有的准确值降级成推断值。
4. **不要**把解析失败当异常抛出 —— 拿不到就回落，回落在诊断里说明。

## 测试

1. 消息含 `active child limit: 4` → 学到 `max_active_subagents: 4`（不是 `used`）。
2. 消息含 `Team member limit 6 reached` → 学到 `max_members: 6`。
3. 消息格式不认识（例如宿主未来改了措辞）→ 回落到 `used_at_observation`，且**不抛**，诊断里写清是回落值。
4. 已有解析出的准确值，再撞一次但消息不可解析 → 保留原准确值（不降级）。
5. 同会话再撞一次且解析出不同的 N → 覆盖并更新 `observed_at`。

## 兼容与边界

- 不改 T18 的优先级顺序、并发保护、按会话生效这三条。
- 解析只针对这两种稳定码；不要把任意宿主消息都拿去正则。
- 不要去读宿主的私有字段（D1 仍有效）——本票读的是**它自己抛出来的错误消息**，属于被动观测。

## 门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线 = **T18 合并后的实际数字**（不要写死）。要求 0 fail / 0 skip、`tsc` 0 错。改 `src/` 必须重建并提交 `dist/`。

## 验收

- [ ] tsc 0 错、门禁 0 fail / 0 skip
- [ ] 两条解析正例 + 一条回落 + 一条不降级 + 一条覆盖
- [ ] `capacity-observed.json` 的 `basis` 三字段齐全
- [ ] `docs/impl/DECISIONS.md` 补一句：观察到上限的**两种**来源（解析成功 / 回落）与"值可能因改设置而失效"
- [ ] 在 `docs/impl/UPSTREAM-API.md` 记录这两条宿主消息格式（它们是本包依赖的外部事实）
