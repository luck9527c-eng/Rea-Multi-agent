/**
 * `rt_roster` handler —— **占位实现**。
 *
 * T5 会整体替换本文件（inspect / bind / takeover 的真实逻辑：岗位目录、能力匹配、预算裁剪、
 * binding/roster/epoch、takeover 恢复核查）。这里只保证：
 * 入口可加载、可测试、缺团队服务时给出**可执行**的诊断，而不是抛栈。
 *
 * 契约（SEAMS §1）：`handleRoster(ctx, input)` 已通过 `$defs.rosterInput` 校验，
 * 返回 `{ envelope }`，**绝不 reject**。
 *
 * @module @local/dsh-redteam-lead/roster
 */

/** `$defs.id` 的形状；入参已校验，这里只是让占位实现不依赖校验结果。 */
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/

/**
 * @param {object} ctx HandlerCtx（`{ deps, exec, services, config, now }`）
 * @param {object} input 已通过 `$defs.rosterInput` 校验的入参
 * @returns {Promise<{ envelope: object }>}
 */
export async function handleRoster(ctx, input) {
  const envelope = ctx?.deps?.envelope
  if (envelope === undefined || typeof envelope.blocked !== 'function') {
    // 装配错误要显形，但仍然是 reject 由 index.js 兜成信封（见 index.js 的 catch）。
    throw new Error('rt_roster: ctx.deps.envelope 未装配')
  }

  const operationId = typeof input?.operation_id === 'string' && OPERATION_ID.test(input.operation_id)
    ? input.operation_id
    : null
  const action = typeof input?.action === 'string' ? input.action : 'inspect'

  return {
    envelope: envelope.blocked({
      code: 'TEAM_SERVICE_UNAVAILABLE',
      operationId,
      reason:
        `rt_roster(action=${action}) 尚未实现：本包当前交付的是入口、preset 与工具注册，` +
        '班底/能力/预算与 binding 逻辑随 T5 合入；此时没有可用的团队服务快照可读。',
      nextStep:
        '先启用 @deepseek-ai/dsh-experimental-agent-team-profile（profile 的 dsh.profile.bundles），' +
        '然后运行 node <bundle-root>/bin/doctor.mjs --profile <profile-root> --project <project-root> 自检；' +
        'T5 合入后重试同一调用',
      data: { phase: 'preflight' },
    }),
  }
}
