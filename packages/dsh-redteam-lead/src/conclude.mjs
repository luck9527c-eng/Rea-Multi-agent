/**
 * `rt_conclude` handler —— **占位实现**。
 *
 * T7 会整体替换本文件（submission 校验、六类锚点闭集、派发基准快照与 seal 复用、
 * 项目 skill 的 impact/seal/index/check 顺序、回执与任务 complete）。这里只保证入口可加载、
 * 可测试，并在缺团队服务/未实现时给出可执行的诊断。
 *
 * 契约（SEAMS §1）：`handleConclude(ctx, input)` 已通过 `$defs.concludeInput` 校验，
 * 返回 `{ envelope }`，**绝不 reject**。
 *
 * @module @local/dsh-redteam-lead/conclude
 */

/** `$defs.id` 的形状。 */
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/

/**
 * @param {object} ctx HandlerCtx（`{ deps, exec, services, config, now }`）
 * @param {object} input 已通过 `$defs.concludeInput` 校验的入参
 * @returns {Promise<{ envelope: object }>}
 */
export async function handleConclude(ctx, input) {
  const envelope = ctx?.deps?.envelope
  if (envelope === undefined || typeof envelope.blocked !== 'function') {
    throw new Error('rt_conclude: ctx.deps.envelope 未装配')
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
        'rt_conclude 尚未实现：提交校验、锚点闭集、基准比对与项目 skill 的 seal/check 顺序随 T7 合入；' +
        '任何完成判定都不会在没有校验的情况下冒充成功。',
      nextStep:
        '先启用 @deepseek-ai/dsh-experimental-agent-team-profile，并用 bin/doctor.mjs 确认项目 skill 副本与 Python 可达；' +
        'T7 合入后以同一 operation_id 重试',
      data: { phase: 'preflight' },
    }),
  }
}

