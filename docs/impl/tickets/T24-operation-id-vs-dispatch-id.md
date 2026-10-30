# T24：`operation_id` 与 `dispatch_id` / `attempt_id` 的区别在工具描述里没说清，模型第一次收口就复用错 id

状态：待办（小改动，当天可交付）
来源：真会话 `session-eda089ea-1e8a-465d-958c-9959492b4db2`

## 观测

派发用的是 `operation_id="op-r003-dispatch-01"`，拿到 `dispatch_id="D-op-r003-dispatch-01-3236271b"`。
第一次收口时模型给的是：

```json
{"operation_id":"op-r003-dispatch-01","dispatch_id":"D-op-r003-dispatch-01-3236271b","attempt_id":"A-000001", ...}
```

即**把派发的 `operation_id` 又当成了收口的 `operation_id`**。工具正确拒绝了：

> `rt_conclude：前置拒绝（code OPERATION_CONFLICT）`
> `[OPERATION_CONFLICT] 同一 operation ID 的输入已改变：op-r003-dispatch-01（已存阶段 delivered）`
> 下一步：同一 ID 必须保持原输入与 expected_revision；换了请求内容请用新的 operation ID
> `phase：delivered`

模型随后改成 `op-r003-conclude-01`…`-05` 等，前后共 11 次 `rt_conclude`（2 次派发）。
诊断是**可操作的**，行为是对的 —— 但"第一次就撞上"说明描述没把三者的关系讲清。

## 根因

三个 id 的语义在实现里很清楚，但**工具描述只说了 `operation_id` 是幂等键**，没说：

- `operation_id` 是**本次调用**的幂等键，每次新操作都要新的；
- `dispatch_id` / `attempt_id` 是**被操作的对象**，要从 `rt_dispatch` 的回执里取；
- 拿派发的 `operation_id` 来收口，会命中"同一 ID 输入已改变"的冲突。

`rt_dispatch` 的描述同样没提醒回执里哪个字段该喂给 `rt_conclude`。

## 改法（只改描述，不动逻辑）

在 `src/index.ts` 的三个 `description` 上各加一句（英文，与现有风格一致）：

1. `rt_roster`：`operation_id is the idempotency key of this call — use a new one for every new operation.`
2. `rt_dispatch`：`Feed the returned dispatch_id and attempt_id to rt_conclude; this call's operation_id is not reusable there.`
3. `rt_conclude`：`operation_id is the idempotency key of this conclude — never reuse the dispatch's operation_id; pass its dispatch_id/attempt_id as the target.`

> 若认为三处都写太长，至少要在 `rt_conclude` 写死第 3 句（那就是实际撞上的地方）。

## 验收

1. 三条描述都含明确的 id 分工说明（`rt_conclude` 必须出现"不要复用 dispatch 的 operation_id"这一语义）。
2. `test/bundle.test.mjs` 现有的 `Step N` 断言之外，新增一条：`rt_conclude.description` 必须提到 `dispatch_id` 与 `operation_id` 的区别
   （用 ASCII token 断言，避免被中英混排干扰）。
3. 重建 `dist/` 与 `src/` 同步（`bundle.test.mjs` 有漂移用例，会自己抓）。
4. 全量门禁全绿（并注意 T22 的偶发红，别把偶发当回归）。

## 写作用域（预估）

- `src/index.ts`、`dist/index.js`
- `test/bundle.test.mjs`（1 条新断言）

## 备注

真会话里另有一处同源的困惑：`rt_roster` 的 `proposal_hash` 也被复用过（`op-bind-001` 撞 `OPERATION_CONFLICT`，当前目录版本变了）。
这类"该重新生成的令牌"最好在描述里点一句"inspect 之后目录/能力/预算任一变化都会换 `proposal_hash`"——可选，优先度低于 id 分工。
