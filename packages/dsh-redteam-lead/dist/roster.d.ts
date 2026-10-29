import type { HandlerCtx, HandlerResult } from './types.js';
/**
 * `rt_roster` handler（SEAMS §1：`input` 已通过 `$defs.rosterInput` 校验，返回 `{envelope}`，绝不 reject）。
 *
 * @param {object} ctx 装配上下文
 * @param {object} rawInput 已校验/已填默认值的入参
 * @returns {Promise<{envelope: object}>}
 */
export declare function handleRoster(ctx: HandlerCtx, rawInput: unknown): Promise<HandlerResult>;
/** 工具名常量（index.js 注册时用；也便于诊断）。 */
export declare const ROSTER_TOOL_NAME = "rt_roster";
