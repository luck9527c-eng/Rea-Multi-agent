/**
 * 可信调用者身份。
 *
 * **唯一**身份来源是宿主执行上下文：`ctx.exec.agent` + 团队服务的成员查询
 * （SEAMS §2：`ctx.deps.teamAdapter.membership(agent)`；T1 ticket 里写作 `ctx.agentTeams`）。
 * `deps.teamAdapter` 既可能是适配器实例，也可能是 SEAMS §1 规定的工厂函数，两种都接受。
 * 入参、提示词、agent 名字字符串、以及任何自报的 `role` 字段**一律忽略** ——
 * 否则普通裸子代理可以直接自称 Lead。
 *
 * 返回值是判别联合，绝不 reject：
 * - `{ ok: true, role: 'lead' | 'teammate' | 'other', name, root }`
 * - `{ ok: false, code: 'ROLE_REQUIRED' | 'TEAM_SERVICE_UNAVAILABLE', diagnostic }`
 *
 * 分支约定：
 * - 没有 `exec.agent`（缺可信执行身份）或没有成员查询能力 → `TEAM_SERVICE_UNAVAILABLE`。
 * - 团队服务明确回答「不是成员」→ `ROLE_REQUIRED`。
 * - 是成员但角色不是 lead/teammate → `role: 'other'`（不升级权限，由调用方拒绝）。
 */
import type { Diagnostic } from './types.js';
/** 调用者角色。`other` = 是团队成员但不是 lead/teammate（由 handler 拒）。 */
export type CallerRole = 'lead' | 'teammate' | 'other';
/** 解析成功。 */
export interface CallerSuccess {
    ok: true;
    role: CallerRole;
    name: string | null;
    root: string | null;
}
/** 解析失败（带一条可直接进信封的诊断）。 */
export interface CallerFailure {
    ok: false;
    code: 'ROLE_REQUIRED' | 'TEAM_SERVICE_UNAVAILABLE';
    diagnostic: Diagnostic;
}
/** `resolveCaller` 的结果：判别联合，绝不 reject。 */
export type CallerIdentity = CallerSuccess | CallerFailure;
/**
 * 解析当前工具调用的可信身份。
 *
 * `ctx` 是 `index.ts` 组装的 HandlerCtx；这里只按形状读 `exec.agent` 与团队服务，
 * 因此参数按 `unknown` 收（测试与降级路径会传不完整的上下文）。
 */
export declare function resolveCaller(ctx: unknown): Promise<CallerIdentity>;
