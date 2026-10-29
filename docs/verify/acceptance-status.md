# 验收总表（`acceptance-status.md`）

> **本文件是 T9 建的空壳，完整表由 T10 补。**
>
> T10 的交付要求是覆盖 **A01–A44 全部 44 行**（`docs/specs/acceptance-matrix.md`），状态只允许
> `pass` / `fail` / `not-run` / `out-of-scope`，每条 `pass` 必须能点到一个测试文件+用例名，或
> `docs/verify/` 下的一份记录。
>
> 本文件目前只列出 **L3 相关的 18 行**，全部为 `not-run`——因为第三层**一次都没有执行过**。
> 这里不是占位"通过"，是把"未执行"写清楚。

## 为什么这 18 行现在只能是 `not-run`

第三层要跑真实的 `ctx.agentTeams`，它不能进 `node --test`（宿主包只在打包的 `app.asar` 里）。当前状态：

- 七步清单已生成（`docs/verify/l3-checklist.md`，七步 × 54 条断言），**未执行**；
- 记录模板已就绪（`docs/verify/l3-record-template.md`），**没有填过的实例**；
- 取证脚本 `packages/dsh-redteam-lead/scripts/l3-verify.mjs` 只在意造目录上验证过，**没有在真实会话里用过**；
- 因此不存在任何可点开的 L3 记录 → 不能写 `pass`。

执行方式见 `docs/verify/README.md`。

## L3 行（18 条，全部 `not-run`）

| 编号 | 层 | 状态 | 证据位置（待产生） | 备注 |
|---|---|---|---|---|
| A01 | L3 | `not-run` | `docs/verify/records/<…>` §2.1（doctor 原始输出） | 清单第 1 步；空壳阶段唯一能离线观察的一半是 doctor 本身 |
| A02 | L3 | `not-run` | 记录 §4 第 1 步 | 同名工具的对照组已被 patch 删除，只能证明留下的是团队版 |
| A03 | L3 | `not-run` | 记录 §4 第 5 步 | 需真实 teammate 的原始返回 + 空 diff |
| A08 | L3 | `not-run` | 记录 §4 第 5 步 | 裸子代理"工具不存在"与"身份拒绝"必须分开记 |
| A09 | L3 | `not-run` | 记录 §4 第 2 步 | 容量未知/已声明两种返回 |
| A10 | L3 | `not-run` | 记录 §4 第 3 步 | 契约 SHA-256 == `contract_sha256`；`started_at` 为 null |
| A11 | L3 | `not-run` | 记录 §4 第 4 步 | 成员数不变、`task_id` 变、`MEMBER_BUSY` |
| A12 | L3 | `not-run` | 记录 §4 第 3 步 | 需构造（撑爆消息 / 极小超时） |
| A13 | L3 | `not-run` | — | 不可观察：造不出"成员不写 `start.json`" |
| A15 | L3 | `not-run` | 记录 §4 第 6 步 | 需构造（成员先自行 `complete`） |
| A22 | L3 | `not-run` | 记录 §4 第 4 步 | 需构造（声明 `resource_needs`）；残留进程项不可观察 |
| A25 | L3 | `not-run` | — | 不可观察：需故障注入（响应丢失） |
| A26 | L3 | `not-run` | 记录 §4 第 6 步 | 需构造（手工改 revision 后收口） |
| A31 | L3 | `not-run` | 记录 §4 第 6 步 | 需构造（第二个会话做 takeover） |
| A34 | L3 | `not-run` | 记录 §4 第 7 步 | 停止条件可读；"不承诺自动唤醒"只能旁证 |
| A38 | L3 | `not-run` | 记录 §4 第 1 步 | 只报 discovered/unknown 可观察 |
| A40 | L3 | `not-run` | 记录 §4 第 2 步 | `project_id`/`session_id` 可观察；换执行者需构造 |
| A44 | L3 | `not-run` | 记录 §4 第 6 步 | 需构造（连续两次 `rt_roster` 比对去重） |

## 待办（T10 接手时）

1. 把本文件扩成 A01–A44 全表（L1/L2 行此刻已可判定，L3 行保持 `not-run` 直到有记录）。
2. 每条 L3 `pass` 必须改指向一份填好的 `docs/verify/records/<YYYYMMDD>-<session id 前 8 位>.md`。
3. A13/A25 这类"不可观察"的行，`备注` 里要写清缺什么能力（故障注入 / 宿主查询），不要留空。
