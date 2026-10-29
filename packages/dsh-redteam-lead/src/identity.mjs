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

import { diagnostic } from './envelope.mjs'

const NEXT_STEP_SERVICE =
  '确认本 bundle 已挂载且在 Agent 团队会话内运行（ctx.exec.agent 与团队服务由宿主注入），然后重试'
const NEXT_STEP_ROLE =
  '由本团队 Lead 发起该操作，或先以团队成员身份被指派；不接受任何入参自报的角色'

function unavailable(reason) {
  return {
    ok: false,
    code: 'TEAM_SERVICE_UNAVAILABLE',
    diagnostic: diagnostic('TEAM_SERVICE_UNAVAILABLE', reason, NEXT_STEP_SERVICE),
  }
}

function roleRequired(reason) {
  return {
    ok: false,
    code: 'ROLE_REQUIRED',
    diagnostic: diagnostic('ROLE_REQUIRED', reason, NEXT_STEP_ROLE),
  }
}

/**
 * 找到成员查询来源：
 * 1. `ctx.deps.teamAdapter`（SEAMS 钉死的接缝，T4 薄封装，永不 reject）：
 *    SEAMS §1 的 deps 表把 `teamAdapter` 定为**工厂函数**，而 §2 又写
 *    `ctx.deps.teamAdapter.membership(...)` —— 两种形状这里都接受：
 *    实例（有 `membership` 方法）直接用；函数则按 `createTeamAdapter({services, exec, config, deps})`
 *    建一次当次调用的实例；
 * 2. `ctx.agentTeams` / `ctx.services.agentTeams`（宿主原始服务，T1 ticket 的形态；
 *    `tryMembership` 优先，缺失时退回会抛异常的 `membership`）。
 *
 * @returns {Promise<{ query: (agent: unknown) => Promise<object> } | { error: string } | null>}
 */
async function membershipSource(ctx) {
  const adapter = ctx?.deps?.teamAdapter
  if (adapter && typeof adapter.membership === 'function') {
    return { query: (agent) => adapter.membership(agent) }
  }
  if (typeof adapter === 'function') {
    // SEAMS §1：工厂函数形状，每次工具调用新建一次实例，把当次上下文绑进去。
    let instance
    try {
      instance = await adapter({ services: ctx.services, exec: ctx.exec, config: ctx.config, deps: ctx.deps })
    } catch (error) {
      return { error: `团队适配器工厂创建失败：${error?.message ?? String(error)}` }
    }
    if (instance && typeof instance.membership === 'function') {
      return { query: (agent) => instance.membership(agent) }
    }
    return { error: '团队适配器工厂没有返回带 membership 的实例' }
  }

  const host = ctx?.agentTeams ?? ctx?.services?.agentTeams
  if (host && typeof host.tryMembership === 'function') {
    return {
      query: async (agent) => {
        const member = await host.tryMembership(agent)
        return member ? { ok: true, member } : { ok: false, code: 'ROLE_REQUIRED' }
      },
    }
  }
  if (host && typeof host.membership === 'function') {
    return {
      query: async (agent) => {
        try {
          const member = await host.membership(agent)
          return member ? { ok: true, member } : { ok: false, code: 'ROLE_REQUIRED' }
        } catch (error) {
          // 宿主原始 API 对非成员/过时身份会抛异常，这里按「不是成员」处理。
          return { ok: false, code: 'ROLE_REQUIRED', reason: error?.message }
        }
      },
    }
  }

  return null
}

function roleOf(member) {
  if (!member || typeof member !== 'object') return 'other'
  if (member.role === 'lead') return 'lead'
  if (member.role === 'teammate') return 'teammate'
  return 'other'
}

function nameOf(member) {
  return typeof member?.name === 'string' && member.name.length > 0 ? member.name : null
}

function rootOf(member) {
  return typeof member?.root === 'string' && member.root.length > 0 ? member.root : null
}

/**
 * 解析当前工具调用的可信身份。
 *
 * @param {{
 *   exec?: { agent?: unknown },
 *   deps?: { teamAdapter?: { membership?: (agent: unknown) => Promise<object> } },
 *   agentTeams?: { tryMembership?: Function, membership?: Function },
 *   services?: { agentTeams?: { tryMembership?: Function, membership?: Function } },
 * }} ctx HandlerCtx（index.js 组装）
 * @returns {Promise<
 *   | { ok: true, role: 'lead' | 'teammate' | 'other', name: string | null, root: string | null }
 *   | { ok: false, code: 'ROLE_REQUIRED' | 'TEAM_SERVICE_UNAVAILABLE', diagnostic: object }
 * >}
 */
export async function resolveCaller(ctx) {
  const agent = ctx?.exec?.agent
  if (!agent) return unavailable('缺少可信执行身份 ctx.exec.agent，无法判定调用者角色')

  const source = await membershipSource(ctx)
  if (source === null) {
    return unavailable('宿主未注入团队服务（deps.teamAdapter 与 ctx.agentTeams 都不可用）')
  }
  if (source.error) {
    return unavailable(source.error)
  }

  let result
  try {
    result = await source.query(agent)
  } catch (error) {
    // adapter 契约要求永不 reject；真的抛了就是服务不可用，而不是「非成员」。
    return unavailable(`团队服务查询成员身份失败：${error?.message ?? String(error)}`)
  }

  if (!result || typeof result !== 'object') {
    return unavailable('团队服务返回了无法识别的成员查询结果')
  }

  if (result.ok === true && result.member) {
    return {
      ok: true,
      role: roleOf(result.member),
      name: nameOf(result.member),
      root: rootOf(result.member),
    }
  }

  if (result.code === 'TEAM_SERVICE_UNAVAILABLE') {
    return unavailable(result.reason ?? '团队服务不可用（teamAdapter 报告 TEAM_SERVICE_UNAVAILABLE）')
  }

  const detail = typeof result.reason === 'string' && result.reason ? `：${result.reason}` : ''
  return roleRequired(`调用者不是本团队的成员${detail}`)
}
