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
 * 能力匹配纯函数。
 *
 * @param needs 岗位 required 与任务 capability_needs 的并集（可含 mcp:<server>）
 * @param toolNames 实际执行者注册的完整工具名
 * @param inventory re/env/tools.json 的快照内容
 * @param bindings re/team/capabilities.json 内容
 */
export declare function matchCapabilities(needs: unknown, toolNames: unknown, inventory: unknown, bindings: unknown): CapabilityMatch;
