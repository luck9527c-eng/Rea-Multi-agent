# T3 — 岗位目录、能力匹配与预算裁剪（纯函数）

**Blocked by:** 无（可立即开工）

> **与 T1 并行**：T1 正在另一 worktree 写 `src/errors.mjs` 等内核。你**不要**创建或修改 `src/errors.mjs`、`src/envelope.mjs`、`src/validate.mjs`、`src/paths.mjs`、`src/atomic.mjs`、`src/lock.mjs`、`src/identity.mjs`、`src/operation.mjs`、`src/audit.mjs`、`test/helpers/tmp.mjs`。
> 你返回的失败用**契约表里的字符串错误码**（如 `'UNKNOWN_CAPABILITY'`、`'CAPACITY_UNKNOWN'`）放在普通对象里，不要 import `errors.mjs`。T10 会统一常量来源。

## 这个 ticket 打通什么

三个 rt 工具的全部「决策算术」：读岗位目录 → 组合模板（含 mixed 并集去重）→ 按席位/activation 预算裁剪 → 判空岗/空位/延后/禁用 → 用显式工具名与 provider 绑定做能力匹配。产出全部是纯函数，可在无宿主环境下逐条验收。

**不做**：不注册工具、不读宿主 ctx、不写项目文件、不接触 `ctx.agentTeams`。

## 读什么

- [CONVENTIONS.md](../CONVENTIONS.md)、[MODULE-MAP.md](../MODULE-MAP.md)
- `docs/specs/roster-catalog.json`（唯一数据源）
- `docs/specs/orchestration-contract.md` 的 `## 岗位目录与预算裁剪` 与 `## 能力绑定与就绪判定`
- `docs/specs/tool-discovery.md` 的 `## 原生工具如何满足能力`
- `docs/specs/acceptance-matrix.md` 的 A06 / A07 / A08 / A09 / A38 / A39 / A41
- `docs/specs/rt-tools.schema.json` 的 `$defs.post`

## 交付

| 模块 | 内容 |
|---|---|
| `src/catalog.mjs` | 加载并**校验**岗位目录（ID 唯一、模板引用的岗位存在、模板不含 disabled 岗、required 族可解析、组合能力无环、精确别名无通配符、`enabled` 缺省 true）；`composeTemplate(templateId, targetKinds)` 返回候选岗位集合；mixed：`target_kinds.length >= 2`，按 post_id 取并集去重，绝不为凑数造岗；`on_demand_posts` 不自动入模板；`reserved_posts` 单列且不参与可用岗位计数 |
| `src/capability.mjs` | 能力族解析（`any_tool` / `any_provider` / `all_capabilities`，每族恰一种）；`matchCapabilities(needs, toolNames, inventory, bindings)` **纯函数**，返回 `{matched, missing, providers}`；未知族 → `UNKNOWN_CAPABILITY`；族名本身（`fs`/`search`/`jobs`/`web`）、插件 ID、子串/前缀不得当作命中；区分大小写；`all_capabilities` 组合必须全部满足，单个读工具不能顶替；`any_provider` 要求 `inventory_revision`/`snapshot_sha256`/`transport_tools`/`invocation_ref`/`readiness_ref`/`resource_needs` 齐全；只依名字猜 provider 归属一律不认 |
| `src/capacity.mjs` | `planBudget({candidates, remainingMemberSlots, remainingActivations, reuseCandidates, maxPosts, reservedMemberSlots, reservedActivations})` 纯函数：负值按 0；可新增成员数受两余额交集限制；复用成员只算 activation 增量不扣新席位；按 `priority` 升序、同值按 post_id 排序逐个选；已运行岗位保留为 `assigned` 且计入 max_posts；任一增量未知 → 该岗 `deferred` 并报 `CAPACITY_UNKNOWN`；余额未知 → 不猜、不按 8 假定；返回 `{assigned, vacant, deferred, disabled, gaps, recommended_members, capacity}` |

`src/catalog.mjs` 需导出 `defaultCatalog()`：从包内自带的一份目录副本读（T3 把 `docs/specs/roster-catalog.json` 的内容复制为 `src/catalog.data.json`，并加由 T3 负责的漂移测试）。

## 验收

- [ ] `node --test test` 全绿
- [ ] `test/catalog.test.mjs`：四模板可选岗位非空；模板不含 disabled 岗；`web-attack` 显式 disabled 且不计入可用岗位；mixed 给 game+webapp 得到两者并集、post_id 不重复、各自专岗都在；mixed 只给 1 个 target_kind 被拒；`environment` 不因默认模板自动建岗
- [ ] `test/capability.test.mjs`：`fs` 由 `read`+`write` 共同满足；只有 `read` 时 `fs` 缺失；`read` 存在但需求是族名 `fs` 时不误判；未知族 → `UNKNOWN_CAPABILITY`；`mcp:<server>` 未绑定即缺口；`any_provider` 缺 `snapshot_sha256` 被拒；`binary-static` 无任何默认工具名，未登记即缺口（不得因存在某个 REA/MCP 名而放行）
- [ ] `test/capacity.test.mjs`：不同席位/activation 余额各一组；`reserved` 预留生效；历史失败成员计入已用席位；复用成员不重复扣席位但扣 activation；余额未知 → `CAPACITY_UNKNOWN` 且不新建；预算只够两岗时按 priority 稳定裁剪，其余 `deferred`；混合 `vacant/deferred/disabled` 三类分开返回
- [ ] `test/schema-static.test.mjs`：对 `docs/specs/rt-tools.schema.json` 做零依赖结构元校验（`$defs` 齐备、`request`/`response` 的 `required` 引用存在、`enum` 值与契约表一致、`additionalProperties: false` 处确实封闭）；对 `docs/specs/roster-catalog.json` 做 T3 的全部目录不变量检查；并对 `src/catalog.data.json` 与 `docs/specs/roster-catalog.json` 做字节/内容一致性断言（漂移即失败）
- [ ] 不引入 ajv 或任何依赖；零 `@deepseek-ai/*` import
