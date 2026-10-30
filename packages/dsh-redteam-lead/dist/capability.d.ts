/** 一条能力缺口（`missing[]` 的一项）。投到 `$defs.diagnostic` 时只取 `code/reason/next_step`。 */
export interface CapabilityMissing {
    capability: string;
    code: string;
    reason: string;
    next_step: string;
    missing_capabilities: string[];
}
/** provider 记录（9 字段齐备才算可核验）；字段值原样透传。 */
export interface ProviderRecord {
    tool_id: unknown;
    entrypoint_id: unknown;
    inventory_revision: unknown;
    snapshot_ref: unknown;
    snapshot_sha256: unknown;
    transport_tools: unknown[];
    invocation_ref: unknown;
    readiness_ref: unknown;
    resource_needs: unknown;
}
/** provider 的一次可用性登记（`providers[]` 的一项）。 */
export type ProviderUse = ProviderRecord & {
    capability: string;
};
/** 一处匹配成功的岗位能力。 */
export interface MatchedCapability {
    capability: string;
    via: 'any_tool' | 'all_capabilities' | 'any_provider';
    tool?: string;
    parts?: MatchedCapability[];
    provider?: ProviderRecord;
}
/** `matchCapabilities()` 的返回。 */
export interface CapabilityMatch {
    matched: MatchedCapability[];
    missing: CapabilityMissing[];
    providers: ProviderUse[];
}
/**
 * `tools.schemas(agent)` 的返回值 → 完整工具名集合（去重、排序）。
 *
 * 宿主真实形状是**schema 对象数组**（`_dsh-tools.js` 的 `schemas(scope)` 对每个可见定义
 * 调 `schemaOf()`，名字在元素的 `.name` 上）。旧实现对这个返回值做 `Object.keys()`，
 * 数组上只会得到 `["0","1",…]`：能力族永远判缺失，真会话里任何派发都被 `CAPABILITY_MISSING`
 * 拒（T15）。因此这里的规则是「先按条目取名字，再谈容器」：
 *
 * 1. 值本身就是一个条目（`{name}` / `{function:{name}}`，即单个 schema）→ 单个名字；
 * 2. 数组 → 逐个元素取 `.name`（**绝不** `Object.keys` 数组）；
 * 3. 任意可迭代（`Set`/generator…）→ 逐项取 `.name`；
 * 4. 按名字为键的对象（测试替身与旧形状）→ 键；
 * 5. 其余（null/数字/字符串/没有名字的条目）→ 空集：保持「未核对」降级语义，**不抛**。
 *
 * 空集有两种含义（零个可见工具 / 认不出来的形状），由调用方按容器形状区分，见
 * `roster.ts` 的 `toolsFor()`。
 *
 * @param schemas `ctx.services.tools.schemas(agent)` 的原始返回值（未知形状）
 * @returns 去重并排序的完整工具名
 */
export declare function toolNamesFromSchemas(schemas: unknown): string[];
/**
 * 能力匹配纯函数。
 *
 * @param needs 岗位 required 与任务 capability_needs 的并集（可含 mcp:<server>）
 * @param toolNames 实际执行者注册的完整工具名
 * @param inventory re/env/tools.json 的快照内容
 * @param bindings re/team/capabilities.json 内容
 */
export declare function matchCapabilities(needs: unknown, toolNames: unknown, inventory: unknown, bindings: unknown): CapabilityMatch;
