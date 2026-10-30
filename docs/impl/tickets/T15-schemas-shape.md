# T15 — P0：`tools.schemas()` 返回值建模错误，导致真会话里任何派发都被 `CAPABILITY_MISSING` 拒绝

**来源**：L3 真会话验收（`session-d9cdf339-83af-486a-ba59-a82baab7aa52`），证据在 `D:\workSpace\_l3-verify\evidence\`。

## 现象（真会话实测）

- `rt_dispatch`（`post_id=triage`、`route_id=R-001`、`target_ids=["T-001"]`）返回 `status=blocked`、`code=CAPABILITY_MISSING`、`phase=preflight`，诊断三条：
  - 能力族 `shell`：`pwsh` / `bash` 都不在执行者注册表
  - 能力族 `fs`：`read` 与 `write` 都缺
  - 能力族 `search`：`glob` 与 `grep` 都缺
- `rt_roster(inspect)` 同样把 5 个岗位全判 `vacant`，reason「执行者的工具注册表不可用」。
- 零副作用是对的：`re/team/` 下只有 `audit.jsonl` 与 `capacity.json`，没有成员/任务/契约。
- 证据文件：`s3-rt_dispatch.txt`、`s3-rt_dispatch-tool-event.json`、`s3-diff.json`、`s2-copy-operation.json`。

## 根因（已用宿主源码确证）

会话从运行中的宿主抽出的 `_dsh-tools.js:1472` 是宿主自己的用法：

```js
for (const schema of registry.schemas(exec.agent)) {
  if (schema.name === "run_code") continue;
  Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
}
```

⇒ **`tools.schemas(agent)` 返回的是「schema 对象数组」，工具名在元素的 `.name` 上**（`L2936` 的 `wireSchemas` 也印证：`schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false))`）。

而插件两处都把它当成「按名字为键的对象」：

- `packages/dsh-redteam-lead/src/dispatch.ts` 的 `toolNamesOf()`：`Object.keys(Object(schemas))`
- `packages/dsh-redteam-lead/src/roster.ts` 的取工具可见性那段：同一写法

数组上 `Object.keys` 得到 `["0","1","2",…]`，于是能力匹配拿到的是下标而非工具名 —— 所有能力族判缺失。

**为什么 L1/L2 没抓到**：`test/helpers/fake-team.mjs`（或 `host.mjs`）返回的是 `{ pwsh: {...}, read: {...} }` 这种名字为键的对象，把真实契约建模错了。真会话是唯一能证伪的地方 —— 这是第三层验收的直接价值。

## 交付

### 1. 修取值（src）

在**一处**实现「从 `schemas()` 结果里取出工具名集合」的纯函数（放 `src/capability.ts` 或 `src/guards.ts` 旁边，二选一但只一处），供 `dispatch.ts` 与 `roster.ts` 共用。必须**同时**支持：

- **数组元素带 `.name`**（真实宿主的形状，主路径）—— 也接受元素是 `{name}` / `{function:{name}}` 的常见变体，但**以 `.name` 为准**；
- 按名字为键的对象（测试替身与旧形状，保留以不破坏既有用例）；
- 可迭代对象（`Symbol.iterator`），退化到逐项取 `.name`；
- 以上都不是 → 返回空集合（保持现在的"未核对"降级语义，不抛）。

**不得**用 `Object.keys` 去读数组。

### 2. 修替身（更重要的一半）

把测试替身返回的工具集合改成**真实形状**（schema 对象数组，元素带 `name`），并保留一个用例覆盖"名字为键的对象"这种旧形状。**替身必须建模真实契约，否则测试会继续给错的契约背书。** 找出所有构造工具注册表的替身位置，一并改。

### 3. 回归测试

- 替身返回真实形状（数组 + `name`）时，`shell`/`fs`/`search` 三项**匹配成功**，`toolNames` 里出现 `pwsh`/`read`/`write`/`glob`/`grep`。
- `rt_dispatch` 在替身给出完整工具集时能进入下一阶段（不再 `CAPABILITY_MISSING`）。
- 反向：确实缺少某工具时仍然 `CAPABILITY_MISSING`（不能因为放宽解析就把缺口吃掉）。
- 针对 `Object.keys` 数组下标这个具体错误，加一条断言：`toolNames` 里**不含** `'0'`、`'1'` 这类下标字符串。

### 4. 顺带修两处 L3 暴露的问题

- **`rt_roster(action=inspect)` 写 `re/team/audit.jsonl`**：编排契约写的是「roster inspect 不落盘」。改 inspect **不审计**（bind/takeover 仍审），并让 `l3-checklist.md` 的「两次 `collect` digest 相同」判据重新成立。若你认为契约允许 inspect 审计，**不要**改实现，而是改清单判据并在报告里说明——但两者必须一致，不能一边说不落盘一边写盘。
- **容量变化不改 `proposal_hash`**：`maxMembers` 8→2 时 `proposal_hash` 与 5 个岗位的 `recommended_members` 都没变（证据 `s2-rt_roster-capacity2.txt` vs `s2-rt_roster-capacity8.txt`）。确认 `proposal_hash` 的输入是否漏了**已解析的容量**；若漏了，补进去（bind 才能拒绝"预算已经变了"的过期提议），并加用例。

## 门禁

```
cd D:\workSpace\Rea-Multi-agent
npm.cmd run build
node --test "packages/dsh-redteam-lead/test/**/*.test.mjs"
```
基线 **550 pass / 0 fail / 0 skip**、`tsc` 0 错。改了 `src/` 必须重建并提交 `dist/`。

## 验收

- [ ] tsc 0 错、门禁 0 fail、0 skip
- [ ] 一条用例证明：数组形状的 `schemas()` → `toolNames` 含真实工具名、不含下标
- [ ] 替身已改为真实形状（并在报告里点名改了哪些替身位置）
- [ ] `rt_dispatch` 在完整工具集下不再 `CAPABILITY_MISSING`
- [ ] inspect 审计与清单判据二者一致（改实现或改判据，说明选了哪个）
- [ ] `proposal_hash` 是否包含已解析容量给出明确结论
