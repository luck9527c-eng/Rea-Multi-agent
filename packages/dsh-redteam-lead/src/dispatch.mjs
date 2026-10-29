/**
 * `rt_dispatch` handler —— **占位实现**。
 *
 * T6 会整体替换本文件（派发契约构建与持久化、成员 spawn/复用、任务板映射、交付信封、
 * 资源租用、阶段推进）。这里只保证入口可加载、可测试，并在缺团队服务时给出可执行的诊断。
 *
 * 契约（SEAMS §1）：`handleDispatch(ctx, input)` 已通过 `$defs.dispatchInput` 校验，
 * 返回 `{ envelope }`，**绝不 reject**。
 *
 * @module @local/dsh-redteam-lead/dispatch
 */

/** `$defs.id` 的形状。 */
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/

/**
 * @param {object} ctx HandlerCtx（`{ deps, exec, services, config, now }`）
 * @param {object} input 已通过 `$defs.dispatchInput` 校验的入参
 * @returns {Promise<{ envelope: object }>}
 */
export async function handleDispatch(ctx, input) {
  const envelope = ctx?.deps?.envelope
  if (envelope === undefined || typeof envelope.blocked !== 'function') {
    throw new Error('rt_dispatch: ctx.deps.envelope 未装配')
  }

  const operationId = typeof input?.operation_id === 'string' && OPERATION_ID.test(input.operation_id)
    ? input.operation_id
    : null

  return {
    envelope: envelope.blocked({
      code: 'TEAM_SERVICE_UNAVAILABLE',
      operationId,
      operation_id: operationId, // T1 的实现用 operationId、UPSTREAM-API 文档写 operation_id：两个都传，避免 operation id 被丢成 null
      reason:
        'rt_dispatch 尚未实现：派发契约、成员复用与任务板指派随 T6 合入；' +
        '此时没有团队服务（ctx.agentTeams），也没有可写的 re/team 契约目录。',
      nextStep:
        '先启用 @deepseek-ai/dsh-experimental-agent-team-profile，并用 bin/doctor.mjs 确认 profile/project 配置；' +
        'T6 合入后以同一 operation_id 重试',
      data: { phase: 'preflight' },
    }),
  }
}

