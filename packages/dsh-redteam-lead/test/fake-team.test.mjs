// fake-team 自身的契约测试：替身必须复刻 D3 的真实状态机与 D12 的失败席位语义。
// 断言只经「宿主替身」的公开面：service 方法与 fixture 助手。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeTeam, HOST_CODES } from './helpers/fake-team.mjs';

/** 取一条抛出的宿主错误码；不抛就失败。 */
function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  assert.fail('expected the fake host to throw');
}

async function codeOfAsync(fn) {
  try {
    await fn();
  } catch (error) {
    return error.code;
  }
  assert.fail('expected the fake host to throw');
}

const spawnRequest = (name) => ({
  name,
  description: 'd',
  prompt: [{ type: 'text', text: 'p' }],
  context: 'fresh',
  provider: 'spawn',
  signal: new AbortController().signal,
});

test('createTask 产出 pending、无 owner、revision 1', async () => {
  const team = createFakeTeam();
  const task = await team.service.createTask(team.agent, {
    subject: '静态检查 T-001',
    description: '按 R-001 做静态检查',
  });
  assert.equal(task.status, 'pending');
  assert.equal(task.revision, 1);
  assert.equal(task.ownerName, undefined);
  assert.equal(task.ready, true);
  assert.equal(team.snapshot().tasks[0].ownerId, undefined);
});

test('reassign 总是写 in_progress + owner 并递增 revision', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  const next = await team.service.updateTask(team.agent, {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'reassign',
    owner: 'rt-scout',
  });
  assert.equal(next.status, 'in_progress');
  assert.equal(next.ownerName, 'rt-scout');
  assert.equal(next.revision, 2);
  assert.equal(next.ready, false);
});

test('reassign 传空 owner 退回 pending 且跳过就绪门（blocked 任务也能解绑）', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const blocker = await team.service.createTask(team.agent, { subject: 'b', description: 'd' });
  const task = await team.service.createTask(team.agent, {
    subject: 's',
    description: 'd',
    blockedBy: [blocker.id],
  });
  // 依赖未完成：指派具体成员被拒
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agent, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'rt-scout',
    })),
    HOST_CODES.TASK_BLOCKED,
  );
  // 但清空 owner 的分支在 gate 之前 early-return
  const released = await team.service.updateTask(team.agent, {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'reassign',
    owner: '',
  });
  assert.equal(released.status, 'pending');
  assert.equal(released.ownerName, undefined);
});

test('pending + owner 与 in_progress + 无 owner 都不可达', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  const claimed = await team.service.updateTask(team.agentFor('rt-scout'), {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'claim',
  });
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.ownerName, 'rt-scout');
  const released = await team.service.updateTask(team.agentFor('rt-scout'), {
    taskId: task.id,
    expectedRevision: claimed.revision,
    action: 'release',
  });
  assert.equal(released.status, 'pending');
  assert.equal(released.ownerName, undefined);
});

test('complete 只在 in_progress 且调用者是 owner 或 Lead', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }, { name: 'rt-audit' }] });
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  // pending 不能 complete
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agent, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'complete',
    })),
    HOST_CODES.TASK_INVALID_TRANSITION,
  );
  const claimed = await team.service.updateTask(team.agentFor('rt-scout'), {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'claim',
  });
  // 非 owner 的队友不能 complete
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agentFor('rt-audit'), {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'complete',
    })),
    HOST_CODES.TASK_UNAUTHORIZED,
  );
  // Lead 可以 complete，且 completed 保留 owner
  const done = await team.service.updateTask(team.agent, {
    taskId: task.id,
    expectedRevision: claimed.revision,
    action: 'complete',
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.ownerName, 'rt-scout');
});

test('依赖未完成不可 claim；重复认领返回 ALREADY_CLAIMED；CAS 错配返回 STALE_REVISION', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }, { name: 'rt-audit' }] });
  const blocker = await team.service.createTask(team.agent, { subject: 'b', description: 'd' });
  const task = await team.service.createTask(team.agent, {
    subject: 's',
    description: 'd',
    blockedBy: [blocker.id],
  });
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agentFor('rt-scout'), {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'claim',
    })),
    HOST_CODES.TASK_BLOCKED,
  );
  const free = await team.service.createTask(team.agent, { subject: 'f', description: 'd' });
  const claimed = await team.service.updateTask(team.agentFor('rt-scout'), {
    taskId: free.id,
    expectedRevision: free.revision,
    action: 'claim',
  });
  // 注意：宿主先做 revision CAS，再做认领归属检查，所以这里必须用当前 revision
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agentFor('rt-audit'), {
      taskId: free.id,
      expectedRevision: claimed.revision,
      action: 'claim',
    })),
    HOST_CODES.TASK_ALREADY_CLAIMED,
  );
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agentFor('rt-scout'), {
      taskId: free.id,
      expectedRevision: 99,
      action: 'complete',
    })),
    HOST_CODES.TASK_STALE_REVISION,
  );
});

test('reassign 是 Lead only', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agentFor('rt-scout'), {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'rt-scout',
    })),
    HOST_CODES.LEAD_REQUIRED,
  );
});

test('spawnTeammate 拒绝四种成员名违规', async () => {
  const team = createFakeTeam();
  const spawn = (name) => team.service.spawnTeammate(team.agent, spawnRequest(name));

  assert.equal(await codeOfAsync(() => spawn('RT-Scout')), HOST_CODES.INVALID_MEMBER_NAME); // 大写
  assert.equal(await codeOfAsync(() => spawn('rt scout')), HOST_CODES.INVALID_MEMBER_NAME); // 空格
  assert.equal(await codeOfAsync(() => spawn('lead')), HOST_CODES.INVALID_MEMBER_NAME); // 保留名
  assert.equal(
    await codeOfAsync(() => spawn(`rt-${'a'.repeat(64)}`)),
    HOST_CODES.INVALID_MEMBER_NAME,
  ); // 超长
  await spawn('rt-scout');
  assert.equal(await codeOfAsync(() => spawn('rt-scout')), HOST_CODES.MEMBER_NAME_TAKEN); // 团队内重复
});

test('spawnTeammate 非 Lead 拒绝；超席位与 activation 上限是两个错误码', async () => {
  const member = createFakeTeam({ role: 'teammate', agentName: 'rt-scout' });
  assert.equal(
    await codeOfAsync(() => member.service.spawnTeammate(member.agent, spawnRequest('rt-extra'))),
    HOST_CODES.LEAD_REQUIRED,
  );

  const full = createFakeTeam({ memberLimit: 1, members: [{ name: 'rt-existing' }] });
  assert.equal(
    await codeOfAsync(() => full.service.spawnTeammate(full.agent, spawnRequest('rt-scout'))),
    HOST_CODES.MEMBER_LIMIT,
  );

  const noSlot = createFakeTeam({ activationLimit: 0 });
  assert.equal(
    await codeOfAsync(() => noSlot.service.spawnTeammate(noSlot.agent, spawnRequest('rt-scout'))),
    HOST_CODES.ACTIVATION_LIMIT_REACHED,
  );
});

test('失败成员留在名册、占用席位、其 in_progress 任务仍被占用', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  await team.service.updateTask(team.agent, {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'reassign',
    owner: 'rt-scout',
  });

  // 一次失败的 spawn：名册留 failed 行、名字与席位都被烧掉
  team.failNextSpawn({ code: HOST_CODES.ACTIVATION_LIMIT_REACHED });
  await codeOfAsync(() => team.service.spawnTeammate(team.agent, spawnRequest('rt-audit')));
  const roster = team.service.listMembers(team.agent);
  const failed = roster.find((row) => row.name === 'rt-audit');
  assert.ok(failed, '失败的 spawn 仍留下名册行');
  assert.equal(failed.status, 'failed');
  assert.equal(team.snapshot().teammates, 2, '失败成员占用席位');
  assert.equal(
    await codeOfAsync(() => team.service.spawnTeammate(team.agent, spawnRequest('rt-audit'))),
    HOST_CODES.MEMBER_NAME_TAKEN,
  );

  // 成员失败后其任务仍被占用：别人 claim 报 ALREADY_CLAIMED
  team.failMember('rt-scout');
  assert.equal(
    await codeOfAsync(() => team.service.updateTask(team.agent, {
      taskId: task.id,
      expectedRevision: 2,
      action: 'claim',
    })),
    HOST_CODES.TASK_ALREADY_CLAIMED,
  );
});

test('sendMessage：自消息与未知目标被拒，正常投递可数', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  const signal = new AbortController().signal;
  assert.equal(
    await codeOfAsync(() => team.service.sendMessage(team.agent, {
      target: 'lead',
      content: [{ type: 'text', text: 'hi' }],
      signal,
    })),
    HOST_CODES.SELF_MESSAGE,
  );
  assert.equal(
    await codeOfAsync(() => team.service.sendMessage(team.agent, {
      target: 'rt-nobody',
      content: [{ type: 'text', text: 'hi' }],
      signal,
    })),
    HOST_CODES.MEMBER_NOT_FOUND,
  );
  const accepted = await team.service.sendMessage(team.agent, {
    target: 'rt-scout',
    content: [{ type: 'text', text: '开始干活' }],
    signal,
  });
  assert.ok(accepted.messageId);
  assert.equal(team.snapshot().messages.length, 1);
});

test('sendMessage 上限按含 `Team message from <name>:` 前缀的 JSON 字节数比较', async () => {
  const limit = 4096;
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }], maxMessageBytes: limit });
  const signal = new AbortController().signal;
  const sizeOf = (text) => Buffer.byteLength(JSON.stringify([
    { type: 'text', text: 'Team message from lead:' },
    { type: 'text', text },
  ]), 'utf8');
  const base = sizeOf('');
  const exact = 'x'.repeat(limit - base);
  assert.equal(sizeOf(exact), limit, '构造出恰好等于上限的消息');
  const accepted = await team.service.sendMessage(team.agent, {
    target: 'rt-scout',
    content: [{ type: 'text', text: exact }],
    signal,
  });
  assert.ok(accepted.messageId, '恰好等于上限应当通过（比较是 >）');
  assert.equal(
    await codeOfAsync(() => team.service.sendMessage(team.agent, {
      target: 'rt-scout',
      content: [{ type: 'text', text: `${exact}y` }],
      signal,
    })),
    HOST_CODES.MESSAGE_TOO_LARGE,
  );
});

test('interrupt 只回 running|inactive，且 Lead only', async () => {
  const team = createFakeTeam({ members: [{ name: 'rt-scout' }] });
  assert.equal(team.service.interrupt(team.agent, 'rt-scout').previousStatus, 'running');
  assert.equal(team.service.interrupt(team.agent, 'rt-scout').previousStatus, 'inactive');

  const asTeammate = createFakeTeam({ role: 'teammate', agentName: 'rt-scout' });
  assert.equal(
    codeOf(() => asTeammate.service.interrupt(asTeammate.agent, 'lead')),
    HOST_CODES.LEAD_REQUIRED,
  );
});

test('capacity fixture 两种形态：known:true 带余额，缺省表示没有声明', () => {
  const declared = createFakeTeam({
    capacity: { known: true, maxMembers: 5, maxActiveSubagents: 3, via: 'project' },
  });
  assert.deepEqual(declared.capacityDeclaration, {
    known: true,
    maxMembers: 5,
    maxActiveSubagents: 3,
    via: 'project',
  });
  assert.equal(createFakeTeam().capacityDeclaration, null);
});

test('故障注入 beforeHost：副作用未发生；afterHost：副作用已发生', async () => {
  const before = createFakeTeam();
  before.faults.beforeHost('spawnTeammate');
  await codeOfAsync(() => before.service.spawnTeammate(before.agent, spawnRequest('rt-scout')));
  assert.equal(before.service.listMembers(before.agent).length, 1, '只有 Lead 行');

  const after = createFakeTeam();
  after.faults.afterHost('spawnTeammate');
  await codeOfAsync(() => after.service.spawnTeammate(after.agent, spawnRequest('rt-scout')));
  const names = after.service.listMembers(after.agent).map((row) => row.name);
  assert.deepEqual(names, ['lead', 'rt-scout'], '响应丢失但成员已创建');
  assert.equal(after.snapshot().members.find((row) => row.name === 'rt-scout').phase, 'active');
});

test('故障注入 dropResponse：成功但返回丢失，任务仍被创建', async () => {
  const team = createFakeTeam();
  team.faults.dropResponse('createTask');
  const code = await codeOfAsync(() =>
    team.service.createTask(team.agent, { subject: 's', description: 'd' }));
  assert.equal(code, HOST_CODES.RESPONSE_LOST);
  assert.equal(team.service.listTasks(team.agent).length, 1);
});

test('故障注入只命中指定的第 n 次调用', async () => {
  const team = createFakeTeam();
  team.faults.afterHost('createTask', 2);
  await team.service.createTask(team.agent, { subject: 'a', description: 'd' });
  await codeOfAsync(() => team.service.createTask(team.agent, { subject: 'b', description: 'd' }));
  await team.service.createTask(team.agent, { subject: 'c', description: 'd' });
  assert.deepEqual(
    team.service.listTasks(team.agent).map((task) => task.subject),
    ['a', 'b', 'c'],
  );
  assert.equal(team.callsFor('createTask').length, 3);
});

test('delete 是墓碑：listTasks 不再列出，getTask 仍可取', async () => {
  const team = createFakeTeam();
  const task = await team.service.createTask(team.agent, { subject: 's', description: 'd' });
  await team.service.updateTask(team.agent, {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'delete',
  });
  assert.equal(team.service.listTasks(team.agent).length, 0);
  assert.equal(team.service.getTask(team.agent, task.id).status, 'deleted');
});
