import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveCaller } from '../src/identity.mjs'

/** 契约级 teamAdapter 替身（形状见 SEAMS §3：永不 reject，失败用 {ok:false, code}）。 */
function fakeAdapter(result) {
  const calls = []
  return {
    calls,
    adapter: {
      async membership(agent) {
        calls.push(agent)
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

function ctxWith(adapter, agent = { id: 'agent-1', name: 'host-agent' }) {
  return { exec: { agent }, deps: { teamAdapter: adapter }, services: {} }
}

test('Lead：返回 role=lead 与成员名/团队根', async () => {
  const { adapter, calls } = fakeAdapter({
    ok: true,
    member: { id: 'm-1', name: 'lead', role: 'lead', root: 'session-root-1' },
  })
  const ctx = ctxWith(adapter)

  const caller = await resolveCaller(ctx)
  assert.deepEqual(caller, { ok: true, role: 'lead', name: 'lead', root: 'session-root-1' })
  assert.deepEqual(calls, [ctx.exec.agent], '必须用宿主执行上下文里的 agent 查询成员身份')
})

test('teammate：真实团队成员返回 role=teammate', async () => {
  const { adapter } = fakeAdapter({
    ok: true,
    member: { id: 'm-2', name: 'rt-binary-diff', role: 'teammate', root: 'session-root-1' },
  })

  const caller = await resolveCaller(ctxWith(adapter))
  assert.deepEqual(caller, { ok: true, role: 'teammate', name: 'rt-binary-diff', root: 'session-root-1' })
})

test('非成员：返回 ROLE_REQUIRED 而不是伪造角色', async () => {
  const { adapter } = fakeAdapter({ ok: false, code: 'ROLE_REQUIRED' })

  const caller = await resolveCaller(ctxWith(adapter))
  assert.equal(caller.ok, false)
  assert.equal(caller.code, 'ROLE_REQUIRED')
  assert.equal(caller.diagnostic.code, 'ROLE_REQUIRED')
  assert.ok(caller.diagnostic.reason.length > 0)
  assert.ok(caller.diagnostic.next_step.length > 0)
})

test('缺失团队服务：返回 TEAM_SERVICE_UNAVAILABLE', async () => {
  const caller = await resolveCaller({ exec: { agent: { id: 'agent-1' } }, deps: {}, services: {} })
  assert.equal(caller.ok, false)
  assert.equal(caller.code, 'TEAM_SERVICE_UNAVAILABLE')
  assert.equal(caller.diagnostic.code, 'TEAM_SERVICE_UNAVAILABLE')
})

test('缺失可信执行身份：同样不猜测角色', async () => {
  const { adapter, calls } = fakeAdapter({ ok: true, member: { role: 'lead', name: 'lead' } })
  const caller = await resolveCaller({ deps: { teamAdapter: adapter } })

  assert.equal(caller.ok, false)
  assert.equal(caller.code, 'TEAM_SERVICE_UNAVAILABLE')
  assert.deepEqual(calls, [], '没有 exec.agent 就不该调用成员查询')
})

test('入参里的自报 role/agent 被完全忽略', async () => {
  const { adapter, calls } = fakeAdapter({
    ok: true,
    member: { id: 'm-2', name: 'rt-binary-diff', role: 'teammate', root: 'session-root-1' },
  })
  const ctx = {
    ...ctxWith(adapter),
    input: { role: 'lead', agent: { id: 'forged' }, project_root: 'D:\\x' },
  }

  // 第二个参数即便伪装成调用方自报身份，也不参与判定
  const caller = await resolveCaller(ctx, { role: 'lead', agent: { id: 'forged' } })

  assert.equal(caller.role, 'teammate')
  assert.equal(caller.name, 'rt-binary-diff')
  assert.deepEqual(calls, [ctx.exec.agent])
})

test('成员角色不是 Lead/teammate 时归为 other（不升级权限）', async () => {
  const { adapter } = fakeAdapter({ ok: true, member: { id: 'm-3', name: 'guest-1', role: 'guest', root: 'r' } })
  const caller = await resolveCaller(ctxWith(adapter))
  assert.deepEqual(caller, { ok: true, role: 'other', name: 'guest-1', root: 'r' })
})

test('adapter 声称成功但没给成员，按非成员处理', async () => {
  const { adapter } = fakeAdapter({ ok: true, member: null })
  const caller = await resolveCaller(ctxWith(adapter))
  assert.equal(caller.ok, false)
  assert.equal(caller.code, 'ROLE_REQUIRED')
})

test('adapter 抛异常时降级为 TEAM_SERVICE_UNAVAILABLE，不冒泡', async () => {
  const { adapter } = fakeAdapter(new Error('ipc closed'))
  const caller = await resolveCaller(ctxWith(adapter))
  assert.equal(caller.ok, false)
  assert.equal(caller.code, 'TEAM_SERVICE_UNAVAILABLE')
  assert.match(caller.diagnostic.reason, /ipc closed/)
})

test('没有 teamAdapter 时可读宿主原始 agentTeams（T1 ticket 的 ctx.agentTeams 形态）', async () => {
  const ctx = {
    exec: { agent: { id: 'agent-1' } },
    agentTeams: {
      async tryMembership(agent) {
        assert.deepEqual(agent, { id: 'agent-1' })
        return { id: 'm-1', name: 'lead', role: 'lead', root: 'root-1' }
      },
    },
  }

  const caller = await resolveCaller(ctx)
  assert.deepEqual(caller, { ok: true, role: 'lead', name: 'lead', root: 'root-1' })

  const outsider = {
    exec: { agent: { id: 'agent-1' } },
    agentTeams: { async membership() { throw new Error('not a member') } },
  }
  const rejected = await resolveCaller(outsider)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'ROLE_REQUIRED')
})

test('resolveCaller 永不 reject：空 ctx 与 undefined 都返回结构化结果', async () => {
  for (const ctx of [undefined, null, {}, { exec: {} }]) {
    const caller = await resolveCaller(ctx)
    assert.equal(caller.ok, false)
    assert.equal(caller.code, 'TEAM_SERVICE_UNAVAILABLE')
  }
})
