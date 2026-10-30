// teamAdapter：宿主团队服务的薄封装。所有失败都必须落到 {ok:false, code}，绝不抛。
// 关键判断点是 usedSeats()：T23 起只允许「已用席位从 listMembers 数出来」，
// 适配器不读任何容量声明、不猜上限，也不解析宿主拒绝消息里的数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTeamAdapter } from '../dist/team-adapter.js';
import { createFakeTeam, HOST_CODES } from './helpers/fake-team.mjs';

const ADAPTER_SOURCE = readFileSync(new URL('../src/team-adapter.ts', import.meta.url), 'utf8');

const LEAD = { name: 'lead', role: 'lead' };

/** 造一个「宿主 + 适配器」组合。 */
function makeAdapter(t, options = {}) {
  const team = options.team ?? createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const adapter = createTeamAdapter({
    services: { agentTeams: team.service },
    agent: team.agent,
    projectRoot: options.projectRoot,
    config: options.config ?? {},
  });
  return { team, adapter };
}

test('缺团队服务时所有方法返回 TEAM_SERVICE_UNAVAILABLE 且不抛', async () => {
  const adapter = createTeamAdapter({ services: {}, agent: undefined });
  assert.equal(adapter.hasService(), false);

  const results = {
    membership: await adapter.membership({ id: 'x' }),
    listMembers: await adapter.listMembers(),
    spawnTeammate: await adapter.spawnTeammate({ name: 'rt-scout', prompt: 'p' }),
    sendMessage: await adapter.sendMessage({ target: 'lead', message: 'hi' }),
    interruptAgent: await adapter.interruptAgent({ target: 'rt-scout' }),
    createTask: await adapter.createTask({ subject: 's', description: 'd' }),
    updateTask: await adapter.updateTask({ taskId: 'task-1', expectedRevision: 1, action: 'complete' }),
    getTask: await adapter.getTask('task-1'),
    listTasks: await adapter.listTasks(),
  };
  assert.deepEqual(
    Object.keys(results).sort(),
    ['createTask', 'getTask', 'interruptAgent', 'listMembers', 'listTasks', 'membership',
      'sendMessage', 'spawnTeammate', 'updateTask'],
    '方法集合与 SEAMS 第 3 节一致',
  );
  for (const [name, result] of Object.entries(results)) {
    assert.equal(result.ok, false, `${name} 必须 ok:false`);
    assert.equal(result.code, 'TEAM_SERVICE_UNAVAILABLE', `${name} 必须给出稳定码`);
  }

  const seats = await adapter.usedSeats();
  assert.equal(seats.ok, false);
  assert.equal(seats.used, null);
  assert.equal(seats.code, 'TEAM_SERVICE_UNAVAILABLE');
});

test('membership 只认宿主给的活 agent；非成员与缺失 agent 都是 ROLE_REQUIRED', async (t) => {
  const { team, adapter } = makeAdapter(t);
  const lead = await adapter.membership(team.agent);
  assert.equal(lead.ok, true);
  assert.equal(lead.member.name, 'lead');
  assert.equal(lead.member.role, 'lead');
  assert.equal(typeof lead.member.root, 'string');
  assert.equal(typeof lead.member.id, 'string');

  const bare = createFakeTeam({ role: 'none' });
  const bareAdapter = createTeamAdapter({
    services: { agentTeams: bare.service },
    agent: bare.agent,
  });
  const denied = await bareAdapter.membership(bare.agent);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'ROLE_REQUIRED');

  const noAgent = await adapter.membership(undefined);
  assert.equal(noAgent.ok, false);
  assert.equal(noAgent.code, 'ROLE_REQUIRED');
});

test('listMembers 投影出 id/name/role/status，失败成员也在名册里', async (t) => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }, { name: 'rt-dead', status: 'failed' }] });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });
  const listed = await adapter.listMembers();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.members.map((row) => [row.name, row.role, row.status]), [
    ['lead', 'lead', 'running'],
    ['rt-scout', 'teammate', 'running'],
    ['rt-dead', 'teammate', 'failed'],
  ]);
});

test('spawnTeammate 组装宿主请求并投影成员', async (t) => {
  const { team, adapter } = makeAdapter(t);
  const spawned = await adapter.spawnTeammate({ name: 'rt-audit', prompt: '从 re/team/work 开始' });
  assert.equal(spawned.ok, true);
  assert.equal(spawned.member.name, 'rt-audit');
  assert.equal(spawned.member.role, 'teammate');
  assert.equal(spawned.member.status, 'running');

  const request = team.callsFor('spawnTeammate')[0].args[1];
  assert.equal(request.name, 'rt-audit');
  assert.equal(request.context, 'fresh', '默认 fresh');
  assert.equal(request.provider, 'spawn', '默认 spawn');
  assert.equal(request.description, '从 re/team/work 开始');
  assert.deepEqual(request.prompt, [{ type: 'text', text: '从 re/team/work 开始' }]);
  assert.ok(request.signal, '必须带 AbortSignal');
});

test('spawnTeammate 的四种成员名违规都被拒且不抛', async (t) => {
  const { adapter } = makeAdapter(t);
  const cases = ['RT-Scout', 'rt scout', 'lead', `rt-${'a'.repeat(64)}`];
  for (const name of cases) {
    const result = await adapter.spawnTeammate({ name, prompt: 'p' });
    assert.equal(result.ok, false, `${name} 应被拒`);
    assert.equal(result.code, 'INVALID_ARGUMENT', `${name} 归为入参错误`);
    assert.equal(result.hostCode, HOST_CODES.INVALID_MEMBER_NAME);
  }
});

test('ACTIVATION_LIMIT_REACHED 与席位满都映射到 CAPACITY_EXHAUSTED（不重试）', async (t) => {
  const noSlotTeam = createFakeTeam({ activationLimit: 0 });
  const noSlot = createTeamAdapter({ services: { agentTeams: noSlotTeam.service }, agent: noSlotTeam.agent });
  const activation = await noSlot.spawnTeammate({ name: 'rt-scout', prompt: 'p' });
  assert.equal(activation.ok, false);
  assert.equal(activation.code, 'CAPACITY_EXHAUSTED');
  assert.equal(activation.hostCode, HOST_CODES.ACTIVATION_LIMIT_REACHED);
  assert.equal(activation.retryable, false);

  const fullTeam = createFakeTeam({ memberLimit: 1, members: [{ name: 'rt-existing' }] });
  const full = createTeamAdapter({ services: { agentTeams: fullTeam.service }, agent: fullTeam.agent });
  const seat = await full.spawnTeammate({ name: 'rt-scout', prompt: 'p' });
  assert.equal(seat.code, 'CAPACITY_EXHAUSTED');
  assert.equal(seat.hostCode, HOST_CODES.MEMBER_LIMIT);
});

test('spawnTeammate 非 Lead → ROLE_REQUIRED', async (t) => {
  const team = createFakeTeam({ role: 'teammate', agentName: 'rt-scout' });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });
  const denied = await adapter.spawnTeammate({ name: 'rt-extra', prompt: 'p' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'ROLE_REQUIRED');
  assert.equal(denied.hostCode, HOST_CODES.LEAD_REQUIRED);
});

test('createTask / updateTask / getTask / listTasks 用宿主 action 枚举并投影任务', async (t) => {
  const { team, adapter } = makeAdapter(t);
  const created = await adapter.createTask({ subject: '静态检查', description: '按 R-001' });
  assert.equal(created.ok, true);
  assert.deepEqual(created.task, {
    id: 'task-1',
    revision: 1,
    status: 'pending',
    owner: null,
    subject: '静态检查',
    description: '按 R-001',
    blockedBy: [],
    ready: true,
    writeScopes: [],
  });

  const assigned = await adapter.updateTask({
    taskId: created.task.id,
    expectedRevision: 1,
    action: 'reassign',
    owner: 'rt-scout',
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.task.status, 'in_progress');
  assert.equal(assigned.task.owner, 'rt-scout');
  assert.equal(assigned.task.revision, 2);
  assert.equal(team.callsFor('updateTask')[0].args[1].action, 'reassign', '不臆造 reassignTask');

  const fetched = await adapter.getTask('task-1');
  assert.equal(fetched.ok, true);
  assert.equal(fetched.task.revision, 2);

  const listed = await adapter.listTasks();
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].owner, 'rt-scout');

  const completed = await adapter.updateTask({ taskId: 'task-1', expectedRevision: 2, action: 'complete' });
  assert.equal(completed.ok, true);
  assert.equal(completed.task.status, 'completed');
  assert.equal(completed.task.owner, 'rt-scout', 'completed 保留 owner');
});

test('CAS 失败 → REVISION_CONFLICT + 实际 revision；非法 action 不触达宿主', async (t) => {
  const { team, adapter } = makeAdapter(t);
  await adapter.createTask({ subject: 's', description: 'd' });
  const stale = await adapter.updateTask({ taskId: 'task-1', expectedRevision: 99, action: 'complete' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(stale.actualRevision, 1, '带实际 revision');
  assert.equal(stale.hostCode, HOST_CODES.TASK_STALE_REVISION);

  team.resetCalls();
  const bogus = await adapter.updateTask({ taskId: 'task-1', expectedRevision: 1, action: 'reassignTask' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, 'INVALID_ARGUMENT');
  assert.equal(team.callsFor('updateTask').length, 0, '非法 action 不得触达宿主');
});

test('任务板错误按 D2 映射：BLOCKED / ALREADY_CLAIMED / UNAUTHORIZED 原样保留', async (t) => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }, { name: 'rt-audit' }] });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });
  const blocker = await adapter.createTask({ subject: 'b', description: 'd' });
  const blocked = await adapter.createTask({
    subject: 's',
    description: 'd',
    blockedBy: [blocker.task.id],
  });
  const denied = await adapter.updateTask({
    taskId: blocked.task.id,
    expectedRevision: 1,
    action: 'reassign',
    owner: 'rt-scout',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'TEAM_TASK_BLOCKED');
  assert.equal(denied.retryable, true);
});

test('sendMessage 把长度/拒绝映射为 DELIVERY_FAILED 并保留原文', async (t) => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }], maxMessageBytes: 4096 });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });

  const ok = await adapter.sendMessage({ target: 'rt-scout', message: '开始' });
  assert.equal(ok.ok, true);
  assert.ok(ok.messageId);
  const request = team.callsFor('sendMessage')[0].args[1];
  assert.deepEqual(request.content, [{ type: 'text', text: '开始' }]);

  const tooLarge = await adapter.sendMessage({ target: 'rt-scout', message: 'x'.repeat(9000) });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'DELIVERY_FAILED');
  assert.equal(tooLarge.hostCode, HOST_CODES.MESSAGE_TOO_LARGE);
  assert.match(tooLarge.reason, /exceeds 4096 bytes/, 'reason 保留宿主原文');

  const self = await adapter.sendMessage({ target: 'lead', message: 'hi' });
  assert.equal(self.code, 'DELIVERY_FAILED');
  assert.equal(self.hostCode, HOST_CODES.SELF_MESSAGE);
});

test('interruptAgent 只回 running|inactive，非法目标不抛', async (t) => {
  const { team, adapter } = makeAdapter(t);
  const first = await adapter.interruptAgent({ target: 'rt-scout' });
  assert.deepEqual(first, { ok: true, previousStatus: 'running' });
  const second = await adapter.interruptAgent({ target: 'rt-scout' });
  assert.deepEqual(second, { ok: true, previousStatus: 'inactive' });

  const missing = await adapter.interruptAgent({ target: 'rt-nobody' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_ARGUMENT');
  assert.equal(team.callsFor('interrupt').length, 3);
});

test('usedSeats()：已用席位只从 listMembers 数 teammate，失败成员也算在内', async () => {
  const team = createFakeTeam({
    members: [{ name: 'rt-scout' }, { name: 'rt-dead', status: 'failed' }],
  });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });
  const seats = await adapter.usedSeats();
  assert.deepEqual(seats, { ok: true, used: 2 }, 'lead 不计、两个 teammate（含 failed）都算');
  assert.equal(team.callsFor('listMembers').length, 1);
});

test('usedSeats()：数不到就说数不到（null），绝不回落成 0', async () => {
  const team = createFakeTeam();
  team.faults.beforeHost('listMembers', 1, { code: 'SOMETHING_NEW', message: 'host exploded' });
  const adapter = createTeamAdapter({ services: { agentTeams: team.service }, agent: team.agent });
  const seats = await adapter.usedSeats();
  assert.equal(seats.ok, false);
  assert.equal(seats.used, null);
  assert.equal(seats.code, 'RECOVERY_REQUIRED');
  assert.match(seats.reason, /host exploded/u);
});

test('usedSeats()：服务缺席 / 没有活 agent 都返回 {ok:false, used:null}', async () => {
  const noService = createTeamAdapter({ services: {}, agent: undefined });
  const missing = await noService.usedSeats();
  assert.equal(missing.ok, false);
  assert.equal(missing.used, null);
  assert.equal(missing.code, 'TEAM_SERVICE_UNAVAILABLE');

  const team = createFakeTeam();
  const noAgent = createTeamAdapter({ services: { agentTeams: team.service }, agent: undefined });
  const bare = await noAgent.usedSeats();
  assert.equal(bare.ok, false);
  assert.equal(bare.used, null);
  assert.equal(bare.code, 'ROLE_REQUIRED');
});

test('源码级断言：适配器不读任何容量声明，也没有兜底常数', () => {
  const forbidden = [
    [/\bcapacity\.json\b/u, 'T23：不得再读 re/team/capacity.json'],
    [/config\.capacity/u, 'T23：不得再读 profile 的 config.capacity'],
    [/\bgetCapacity\b/u, '不得假设宿主有 getCapacity'],
    [/\bprivate\b/u, '不得提及/读取 private 成员'],
    [/\.slots\b/u, '不得读 ActivationPool.slots'],
    [/service\.config/u, '不得读宿主 service.config'],
    [/service\.(?:maxMembers|maxActiveSubagents)\b/u, '不得直接读宿主的私有上限字段'],
    [/\blistChildren\b/u, '不得用 listChildren 算术当余额'],
    [/\bDEFAULT_MAX_MEMBERS\b/u, '不得引用宿主默认上限'],
    [/\b(?:8|16)\b/u, '不得出现 8/16 兜底常数'],
  ];
  for (const [pattern, why] of forbidden) {
    assert.doesNotMatch(ADAPTER_SOURCE, pattern, why);
  }
  assert.match(ADAPTER_SOURCE, /listMembers[\s\S]{0,200}role === 'teammate'/u, 'used 只从 listMembers 数出来');
});
test('createTask 失败（宿主校验拒绝/宿主异常）也返回 {ok:false, code}', async (t) => {
  const { adapter } = makeAdapter(t);
  const tooLong = await adapter.createTask({ subject: 'x'.repeat(201), description: 'd' });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'INVALID_ARGUMENT');
  assert.equal(tooLong.hostCode, HOST_CODES.INVALID_ARGUMENT);

  const missingSubject = await adapter.createTask({ description: 'd' });
  assert.equal(missingSubject.ok, false);
  assert.equal(missingSubject.code, 'INVALID_ARGUMENT');

  // 宿主抛出未知错误 → RECOVERY_REQUIRED（不把异常串当 code）
  const unknown = createFakeTeam();
  unknown.faults.beforeHost('createTask', 1, { code: 'SOMETHING_NEW', message: 'host exploded' });
  const tunnelled = createTeamAdapter({ services: { agentTeams: unknown.service }, agent: unknown.agent });
  const failed = await tunnelled.createTask({ subject: 's', description: 'd' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'RECOVERY_REQUIRED');
  assert.equal(failed.hostCode, 'SOMETHING_NEW');
  assert.match(failed.reason, /host exploded/u);
});

test('服务可以通过 ctx.get("agentTeams") 可选注入', async (t) => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const ctx = {
    services: {},
    exec: { agent: team.agent },
    config: {},
    get(name) {
      return name === 'agentTeams' ? team.service : undefined;
    },
  };
  const adapter = createTeamAdapter({ ctx });
  assert.equal(adapter.hasService(), true);
  const listed = await adapter.listMembers();
  assert.equal(listed.ok, true);
  assert.equal(listed.members.length, 2);
});

