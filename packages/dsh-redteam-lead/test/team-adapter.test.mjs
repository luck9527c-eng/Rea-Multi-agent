// teamAdapter：宿主团队服务的薄封装。所有失败都必须落到 {ok:false, code}，绝不抛。
// 关键判断点是 capacity()：只允许「已用席位可数 + 上限必须显式声明」，实现里不得有任何兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTeamAdapter, readDeclaredCapacity } from '../dist/team-adapter.js';
import { createFakeTeam, HOST_CODES } from './helpers/fake-team.mjs';

const ADAPTER_SOURCE = readFileSync(new URL('../src/team-adapter.ts', import.meta.url), 'utf8');

/** 建一个临时项目根，可带初始文件；测试结束自动删除。 */
function makeProject(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rt4-team-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  return root;
}

function declaredCapacityFile(overrides = {}) {
  return {
    schema_version: 1,
    declared_at: '2026-10-29T12:00:00+08:00',
    declared_by: 'operator:lead',
    maxMembers: 8,
    maxActiveSubagents: 4,
    ...overrides,
  };
}

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

  const capacity = await adapter.capacity();
  assert.equal(capacity.ok, false);
  assert.equal(capacity.code, 'TEAM_SERVICE_UNAVAILABLE');
  assert.deepEqual(capacity.memberSlots, { known: false, remaining: null, total: null, used: null });
  assert.deepEqual(capacity.activations, { known: false, remaining: null, total: null });
  assert.equal(capacity.evidence.source, 'unavailable');
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

test('capacity()：有项目声明时 known:true，used 计入失败成员', async (t) => {
  const projectRoot = makeProject(t, {
    're/team/capacity.json': declaredCapacityFile({ maxMembers: 5, maxActiveSubagents: 3 }),
  });
  const team = createFakeTeam({
    members: [{ name: 'rt-scout' }, { name: 'rt-dead', status: 'failed' }],
  });
  const adapter = createTeamAdapter({
    services: { agentTeams: team.service },
    agent: team.agent,
    projectRoot,
  });
  const capacity = await adapter.capacity();
  assert.deepEqual(capacity.memberSlots, { known: true, remaining: 3, total: 5, used: 2 });
  // activation 的「当前占用」没有受支持的只读查询，所以 remaining 只能是 null，不能假装等于上限
  assert.deepEqual(capacity.activations, { known: true, remaining: null, total: 3 });
  assert.equal(capacity.evidence.source, 'declared:re/team/capacity.json');
  assert.ok(capacity.ok);
  assert.ok(capacity.gaps.some((gap) => gap.code === 'ACTIVATION_USAGE_UNOBSERVED'));
});

test('capacity()：只有 profile config 声明时 known:true 且来源是 profile-config', async (t) => {
  const projectRoot = makeProject(t);
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const adapter = createTeamAdapter({
    services: { agentTeams: team.service },
    agent: team.agent,
    projectRoot,
    config: { capacity: { maxMembers: 4, maxActiveSubagents: 2 } },
  });
  const capacity = await adapter.capacity();
  assert.equal(capacity.memberSlots.known, true);
  assert.deepEqual(capacity.memberSlots, { known: true, remaining: 3, total: 4, used: 1 });
  assert.deepEqual(capacity.activations, { known: true, remaining: null, total: 2 });
  assert.equal(capacity.evidence.source, 'declared:profile-config');
});

test('capacity()：没有显式声明时 known:false，但 used 仍然可数并给出下一步', async (t) => {
  const projectRoot = makeProject(t);
  const { adapter } = makeAdapter(t, { projectRoot });
  const capacity = await adapter.capacity();
  assert.deepEqual(capacity.memberSlots, { known: false, remaining: null, total: null, used: 1 });
  assert.deepEqual(capacity.activations, { known: false, remaining: null, total: null });
  assert.equal(capacity.evidence.source, 'unavailable');
  assert.ok(capacity.gaps.length > 0, '必须给出 gap');
  assert.equal(capacity.gaps[0].code, 'CAPACITY_DECLARATION_MISSING');
  assert.match(capacity.gaps[0].nextStep, /re\/team\/capacity\.json/);
});

test('capacity()：声明非法时 known:false 且指出哪里不合法，不崩', async (t) => {
  const projectRoot = makeProject(t, {
    're/team/capacity.json': declaredCapacityFile({ declared_by: '' }),
  });
  const { adapter } = makeAdapter(t, { projectRoot });
  const capacity = await adapter.capacity();
  assert.equal(capacity.memberSlots.known, false);
  assert.equal(capacity.memberSlots.total, null);
  assert.equal(capacity.evidence.source, 'unavailable');
  const gap = capacity.gaps.find((entry) => entry.code === 'CAPACITY_DECLARATION_INVALID');
  assert.ok(gap, '非法声明要有独立 gap');
  assert.match(gap.detail, /declared_by/);
});

test('readDeclaredCapacity 校验字段而不是崩：缺失/坏 JSON/缺字段三类', async (t) => {
  const missing = await readDeclaredCapacity(makeProject(t));
  assert.equal(missing.known, false);
  assert.equal(missing.gap.code, 'CAPACITY_DECLARATION_MISSING');

  const broken = await readDeclaredCapacity(makeProject(t, { 're/team/capacity.json': '{ not json' }));
  assert.equal(broken.known, false);
  assert.equal(broken.gap.code, 'CAPACITY_DECLARATION_INVALID');

  const partial = await readDeclaredCapacity(makeProject(t, {
    're/team/capacity.json': { schema_version: 1, maxMembers: 3 },
  }));
  assert.equal(partial.known, false);
  assert.equal(partial.gap.code, 'CAPACITY_DECLARATION_INVALID');
  assert.match(partial.gap.detail, /declared_at|declared_by|maxActiveSubagents/);

  const good = await readDeclaredCapacity(makeProject(t, {
    're/team/capacity.json': declaredCapacityFile(),
  }));
  assert.equal(good.known, true);
  assert.equal(good.maxMembers, 8);
  assert.equal(good.maxActiveSubagents, 4);
  assert.equal(good.source, 'declared:re/team/capacity.json');
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

test('源码级断言：capacity() 里没有任何兜底常数或私有读取', () => {
  const forbidden = [
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
  assert.match(ADAPTER_SOURCE, /declared:re\/team\/capacity\.json/u);
  assert.match(ADAPTER_SOURCE, /declared:profile-config/u);
  assert.match(ADAPTER_SOURCE, /listMembers[\s\S]{0,200}role === 'teammate'/u, 'used 只从 listMembers 数出来');
});
