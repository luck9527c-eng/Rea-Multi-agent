/**
 * 契约级团队服务替身（SEAMS 第 5 节）。
 *
 * 它复刻的是**宿主** `ctx.agentTeams`（`@deepseek-ai/dsh-experimental-agent-team` 的
 * `TeamService`），不是本包的 `teamAdapter`。因此：
 *
 * - 方法名与参数形状照宿主：`membership(agent)` / `listMembers(agent)` /
 *   `spawnTeammate(caller, request)` / `sendMessage(caller, request)` /
 *   `createTask(caller, request)` / `updateTask(caller, request)` / `getTask(caller, id)` /
 *   `listTasks(caller)` / `interrupt(caller, name)` / `tryMembership(agent)`。
 * - 抛出的是**宿主错误码**（`TEAM_LEAD_REQUIRED`、`TEAM_TASK_STALE_REVISION`、
 *   `ACTIVATION_LIMIT_REACHED` …），由 `team-adapter.mjs` 负责映射成契约码。
 * - 状态机逐条照 DECISIONS.md D3：`pending` ⇔ 无 owner、`in_progress` ⇔ 有 owner、
 *   `completed` 保留 owner、`deleted` 是墓碑；`reassign` 总写 `in_progress` + owner，
 *   只有指派具体成员时才检查 `taskReady`（清空 owner 的分支在 gate 之前 early-return）；
 *   `complete` 要求 `in_progress` 且调用者是 owner 或 Lead；CAS 失败抛
 *   `TEAM_TASK_STALE_REVISION` 且消息里带当前 revision。
 * - D12 的失败席位语义按**宿主抛出的时机**分两种（T18c，见 UPSTREAM-API「宿主容量拒绝消息」）：
 *   `TEAM_MEMBER_LIMIT` / `TEAM_MEMBER_NAME_TAKEN` 在写成员行**之前**抛 → 没有成员行，
 *   名字仍空闲、席位没有消耗；`ACTIVATION_LIMIT_REACHED` 与运行期故障在成员行 append **之后**抛
 *   → 该行 settle 成 `failed` 并**永久占用名字与席位**（其已指派任务仍被占用）。
 *   替身两种都照抄；`failNextSpawn({code})` 也按码选抛出点（见 `PRE_APPEND_SPAWN_CODES`）。
 *
 * ## 公开面
 *
 * ```js
 * const team = createFakeTeam(options)
 * team.service            // 宿主形状的服务对象，塞进 services.agentTeams
 * team.agent              // 调用者 agent（对应 ctx.exec.agent）
 * team.agentFor(name)     // 取某个成员的 agent（用于“别人来改任务”）
 * team.calls              // [{op, args, at}] 宿主调用流水
 * team.callsFor(op)       // 过滤流水
 * team.resetCalls()
 * team.snapshot()         // {teamId, members, tasks, messages, teammates, activations}
 * team.capacityDeclaration// 容量声明 fixture（真实宿主没有 capacity API）
 * team.faults.beforeHost(op, n?, spec?)   // 副作用前抛错
 * team.faults.afterHost(op, n?, spec?)    // 副作用后抛错（响应丢失）
 * team.faults.dropResponse(op, n?, spec?) // 成功但返回丢失
 * team.faults.clear() / team.faults.list()
 * team.failNextSpawn(spec)                // 下一次 spawn 失败；spec.code 决定抛出时机（写成员行之前/之后）
 * team.failMember(name)                   // 把成员置为 failed（席位与任务都保留）
 * team.setActivations(n)
 * ```
 *
 * ## options
 *
 * | 键 | 默认 | 含义 |
 * |---|---|---|
 * | `role` | `'lead'` | 调用者角色：`'lead' \| 'teammate' \| 'none'`（`none` = 非成员） |
 * | `agentName` | 随角色 | 调用者名字；`lead` 角色固定 `'lead'` |
 * | `teamId` | `'session-root-1'` | 团队身份（真实实现是 root Session id） |
 * | `members` | `[]` | 预置队友 `[{name, status?: 'running'\|'inactive'\|'failed'}]` |
 * | `tasks` | `[]` | 预置任务 fixture `[{id?, subject, description, status?, owner?, blockedBy?, revision?}]` |
 * | `memberLimit` | 16（宿主默认） | 席位上限（`TEAM_MEMBER_LIMIT`） |
 * | `activationLimit` | 8（宿主默认） | activation 池上限（`ACTIVATION_LIMIT_REACHED`） |
 * | `activations` | 0 | 已占用 activation 数 |
 * | `maxMessageBytes` | 65536 | 含 `Team message from <name>:` 前缀的 JSON 字节上限 |
 * | `maxTasks` | 256 | 未删除任务上限（`TEAM_TASK_LIMIT`） |
 * | `clock` | `() => Date.now()` | 调用流水的时间戳 |
 *
 * 真实宿主**没有任何容量查询**（DECISIONS D1）：`maxMembers` 只是构造函数参数，`maxActiveSubagents`
 * 在团队服务里根本不存在。所以替身也没有 `capacity()` 之类的读取口 —— 上限的唯一体现是
 * `memberLimit` / `activationLimit` 触发的那两条宿主拒绝。
 */

/** 宿主错误码（与 E2 笔记的 27 个 `TEAM_*` 码 + `ACTIVATION_LIMIT_REACHED` 同名）。 */
export const HOST_CODES = Object.freeze({
  NOT_MEMBER: 'TEAM_NOT_MEMBER',
  LEAD_REQUIRED: 'TEAM_LEAD_REQUIRED',
  INVALID_ARGUMENT: 'TEAM_INVALID_ARGUMENT',
  INVALID_MEMBER_NAME: 'TEAM_INVALID_MEMBER_NAME',
  MEMBER_NAME_TAKEN: 'TEAM_MEMBER_NAME_TAKEN',
  MEMBER_LIMIT: 'TEAM_MEMBER_LIMIT',
  MEMBER_NOT_FOUND: 'TEAM_MEMBER_NOT_FOUND',
  INVALID_TARGET: 'TEAM_INVALID_TARGET',
  SELF_MESSAGE: 'TEAM_SELF_MESSAGE',
  MESSAGE_TOO_LARGE: 'TEAM_MESSAGE_TOO_LARGE',
  ACTIVATION_LIMIT_REACHED: 'ACTIVATION_LIMIT_REACHED',
  TASK_NOT_FOUND: 'TEAM_TASK_NOT_FOUND',
  TASK_STALE_REVISION: 'TEAM_TASK_STALE_REVISION',
  TASK_BLOCKED: 'TEAM_TASK_BLOCKED',
  TASK_ALREADY_CLAIMED: 'TEAM_TASK_ALREADY_CLAIMED',
  TASK_UNAUTHORIZED: 'TEAM_TASK_UNAUTHORIZED',
  TASK_INVALID_TRANSITION: 'TEAM_TASK_INVALID_TRANSITION',
  TASK_DELETED: 'TEAM_TASK_DELETED',
  TASK_HAS_DEPENDENTS: 'TEAM_TASK_HAS_DEPENDENTS',
  TASK_DEPENDENCY_CYCLE: 'TEAM_TASK_DEPENDENCY_CYCLE',
  TASK_LIMIT: 'TEAM_TASK_LIMIT',
  DISPOSED: 'TEAM_DISPOSED',
  PROVISIONING_CONFLICT: 'TEAM_PROVISIONING_CONFLICT',
  // 以下三个只属于替身的故障注入，真实宿主里没有同名错误。
  RESPONSE_LOST: 'TEAM_RESPONSE_LOST',
  HOST_FAILED_BEFORE_EFFECT: 'TEAM_HOST_FAILED_BEFORE_EFFECT',
  HOST_FAILED_AFTER_EFFECT: 'TEAM_HOST_FAILED_AFTER_EFFECT',
});

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEMBER_NAME_MAX = 64;
const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 16384;

/**
 * 在写成员行**之前**就抛出的宿主拒绝码（T18c）。
 *
 * 依据：`roster.ts` 的 `spawnTeammate()`（安装构建 `_agent-team.js:1021-1030`）先校验角色与名字、
 * 再在 `journal.transact` 内查重名与席位上限于 `appendAndFlush` **之前** —— 这几条拒绝都不产生
 * 成员行，名字与席位都还在。`ACTIVATION_LIMIT_REACHED` 恰好相反：它在 append 之后由
 * `subagents.startActivation` 抛出，catch 会把那一行 settle 成 `failed`。
 */
const PRE_APPEND_SPAWN_CODES = new Set([
  HOST_CODES.LEAD_REQUIRED,
  HOST_CODES.INVALID_MEMBER_NAME,
  HOST_CODES.MEMBER_NAME_TAKEN,
  HOST_CODES.MEMBER_LIMIT,
]);

const ACTIONS = new Set([
  'claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete',
]);

/** 宿主风格错误：`.code` 是稳定码，`.name` 区分 TeamError / SubagentError。 */
export class FakeHostError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = extra.name ?? (code === HOST_CODES.ACTIVATION_LIMIT_REACHED ? 'SubagentError' : 'TeamError');
    this.code = code;
    for (const [key, value] of Object.entries(extra)) {
      if (key !== 'name') this[key] = value;
    }
  }
}

function hostError(code, message, extra) {
  return new FakeHostError(message, code, extra);
}

function requiredText(value, field, max) {
  if (typeof value !== 'string') {
    throw hostError(HOST_CODES.INVALID_ARGUMENT, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw hostError(HOST_CODES.INVALID_ARGUMENT, `${field} must not be empty`);
  if (trimmed.length > max) {
    throw hostError(HOST_CODES.INVALID_ARGUMENT, `${field} exceeds ${max} characters`);
  }
  return trimmed;
}

function normalizeFaultError(spec, when) {
  if (spec instanceof Error) return spec;
  const defaults = {
    before: { code: HOST_CODES.HOST_FAILED_BEFORE_EFFECT, message: 'fake host failed before the effect' },
    after: { code: HOST_CODES.HOST_FAILED_AFTER_EFFECT, message: 'fake host failed after the effect' },
    drop: { code: HOST_CODES.RESPONSE_LOST, message: 'fake host applied the change but the response was lost' },
  };
  const base = defaults[when];
  if (typeof spec === 'string') return hostError(spec, base.message, { effectApplied: when !== 'before' });
  if (spec && typeof spec === 'object') {
    return hostError(spec.code ?? base.code, spec.message ?? base.message, {
      ...spec,
      effectApplied: when !== 'before',
      ...(when === 'drop' ? { droppedResponse: true } : {}),
    });
  }
  return hostError(base.code, base.message, {
    effectApplied: when !== 'before',
    ...(when === 'drop' ? { droppedResponse: true } : {}),
  });
}

/**
 * 建一个契约级团队服务替身。
 * @param {object} [options] 见文件头的 options 表。
 * @returns 替身 fixture（含 `service`）。
 */
export function createFakeTeam(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const role = options.role ?? 'lead';
  const agentName = options.agentName ?? (role === 'lead' ? 'lead' : 'rt-scout');
  const teamId = options.teamId ?? 'session-root-1';
  const memberLimit = options.memberLimit ?? 16;
  const activationLimit = options.activationLimit ?? 8;
  const maxMessageBytes = options.maxMessageBytes ?? 65536;
  const maxTasks = options.maxTasks ?? 256;

  /** @type {Array<{id:string,name:string,role:string,phase:string,running:boolean,description?:string,error?:string}>} */
  let teammates = [];
  /** @type {Array<object>} 任务快照（含墓碑） */
  let tasks = [];
  /** @type {Array<object>} */
  const messages = [];
  let activations = options.activations ?? 0;
  let nextTaskNumber = 1;
  /** @type {Array<{op:string,args:any[],at:number}>} */
  const calls = [];
  /** @type {Array<{op:string,when:string,n:number|'always',count:number,error:Error}>} */
  let faultsList = [];
  let pendingSpawnFailure = null;

  const lead = {
    id: `${teamId}-lead`,
    name: 'lead',
    role: 'lead',
    phase: 'active',
    running: true,
  };
  let counter = 0;
  const nextMemberId = () => `member-${(counter += 1)}`;

  function addTeammate({ name, status = 'running', description = '', phase }) {
    const resolvedPhase = phase ?? (status === 'failed' ? 'failed' : status === 'provisioning' ? 'provisioning' : 'active');
    const row = {
      id: nextMemberId(),
      name,
      role: 'teammate',
      phase: resolvedPhase,
      running: resolvedPhase === 'active' && status !== 'inactive',
      description,
    };
    teammates.push(row);
    return row;
  }

  for (const member of options.members ?? []) {
    addTeammate(member);
  }
  for (const task of options.tasks ?? []) {
    seedTask(task);
  }

  // ---- 调用者 ---------------------------------------------------------------
  let caller = null;
  if (role === 'lead') {
    caller = agentOf(lead);
  } else if (role === 'teammate') {
    let row = teammates.find((candidate) => candidate.name === agentName);
    if (row === undefined) row = addTeammate({ name: agentName });
    caller = agentOf(row);
  } else {
    caller = { id: `bare-${teamId}`, name: agentName };
  }

  function agentOf(row) {
    return { id: row.id, name: row.name, options: {} };
  }

  function resolveMember(agent) {
    if (!agent || typeof agent.id !== 'string') return undefined;
    if (agent.id === lead.id) return lead;
    return teammates.find((row) => row.id === agent.id);
  }

  function memberByName(name) {
    if (name === lead.name) return lead;
    return teammates.find((row) => row.name === name);
  }

  function requireMember(agent) {
    const member = resolveMember(agent);
    if (member === undefined) {
      throw hostError(HOST_CODES.NOT_MEMBER, 'caller is not a member of this Team');
    }
    return member;
  }

  function requireActiveMember(name) {
    const found = memberByName(name);
    if (found === undefined || found.phase !== 'active') {
      throw hostError(HOST_CODES.MEMBER_NOT_FOUND, `Team member "${name}" not found`);
    }
    return found;
  }

  // ---- 视图 -----------------------------------------------------------------
  function statusOf(row) {
    if (row.phase === 'failed') return 'failed';
    if (row.phase === 'provisioning') return 'provisioning';
    return row.running ? 'running' : 'inactive';
  }

  function memberView(row) {
    const view = {
      id: row.id,
      name: row.name,
      role: row.role,
      status: statusOf(row),
      diagnostics: [],
    };
    if (row.description) view.description = row.description;
    return view;
  }

  function taskReady(task) {
    return task.blockedBy.every((id) => tasks.find((candidate) => candidate.id === id)?.status === 'completed');
  }

  function writeScopeWarnings(task) {
    const warnings = [];
    for (const other of tasks) {
      if (other.id === task.id || other.status !== 'in_progress') continue;
      if (task.writeScopes.some((scope) => other.writeScopes.includes(scope))) {
        warnings.push(`write scopes overlap with ${other.id}`);
      }
    }
    return warnings;
  }

  function taskView(task) {
    const owner = task.ownerId === undefined ? undefined : ownerName(task.ownerId);
    return {
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      blockedBy: [...task.blockedBy],
      writeScopes: [...task.writeScopes],
      ...(owner === undefined ? {} : { ownerName: owner }),
      ready: task.status === 'pending' && taskReady(task),
      writeScopeWarnings: writeScopeWarnings(task),
    };
  }

  function ownerName(ownerId) {
    if (ownerId === lead.id) return lead.name;
    return teammates.find((row) => row.id === ownerId)?.name;
  }

  function withoutOwner(task) {
    const { ownerId: _ownerId, ...rest } = task;
    return rest;
  }

  function seedTask(spec) {
    const id = spec.id ?? `task-${nextTaskNumber}`;
    nextTaskNumber = Math.max(nextTaskNumber, Number.parseInt(String(id).replace(/^task-/, ''), 10) + 1 || nextTaskNumber);
    const owner = spec.owner ?? spec.ownerName;
    const status = spec.status ?? (owner ? 'in_progress' : 'pending');
    const task = {
      id,
      revision: spec.revision ?? 1,
      subject: spec.subject ?? 'seeded',
      description: spec.description ?? '',
      status,
      blockedBy: spec.blockedBy ?? [],
      writeScopes: spec.writeScopes ?? [],
    };
    if (owner !== undefined && owner !== null) {
      task.ownerId = owner === 'lead' ? lead.id : (memberByName(owner)?.id ?? owner);
    }
    if (task.status === 'pending' && task.ownerId !== undefined) delete task.ownerId;
    tasks.push(task);
    return task;
  }

  function validateDependencies(ids, selfId) {
    if (!Array.isArray(ids)) throw hostError(HOST_CODES.INVALID_ARGUMENT, 'blockedBy must be an array');
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw hostError(HOST_CODES.INVALID_ARGUMENT, 'blockedBy entries must be non-empty strings');
      }
      if (seen.has(id)) throw hostError(HOST_CODES.INVALID_ARGUMENT, `duplicate blockedBy "${id}"`);
      seen.add(id);
      const target = tasks.find((candidate) => candidate.id === id);
      if (target === undefined || target.status === 'deleted') {
        throw hostError(HOST_CODES.TASK_NOT_FOUND, `team task "${id}" not found`);
      }
      if (selfId !== undefined && id === selfId) {
        throw hostError(HOST_CODES.TASK_DEPENDENCY_CYCLE, `team task "${selfId}" cannot block itself`);
      }
    }
    if (selfId !== undefined) {
      // 环检测：从每个 blocker 出发沿 blockedBy 走，若回到自己即成环
      const visit = (id, path) => {
        if (id === selfId) {
          throw hostError(HOST_CODES.TASK_DEPENDENCY_CYCLE, `dependency cycle through "${[...path, id].join(' -> ')}"`);
        }
        const target = tasks.find((candidate) => candidate.id === id);
        for (const next of target?.blockedBy ?? []) visit(next, [...path, id]);
      };
      for (const id of ids) visit(id, []);
    }
    return [...ids];
  }

  // ---- 故障注入与调用流水 ---------------------------------------------------
  function record(op, args) {
    calls.push({ op, args, at: clock() });
  }

  function takeFault(op, when) {
    const index = faultsList.findIndex((fault) => fault.op === op && fault.when === when);
    if (index === -1) return undefined;
    const fault = faultsList[index];
    fault.count += 1;
    if (fault.n === 'always' || fault.count === fault.n) {
      faultsList.splice(index, 1);
      return fault.error;
    }
    return undefined;
  }

  function enter(op, args) {
    record(op, args);
    const before = takeFault(op, 'before');
    if (before !== undefined) throw before;
  }

  function exit(op) {
    const after = takeFault(op, 'after') ?? takeFault(op, 'drop');
    if (after !== undefined) throw after;
  }

  // ---- 宿主方法 -------------------------------------------------------------
  function membership(agent) {
    enter('membership', [agent]);
    const member = requireMember(agent);
    const view = {
      root: agentOf(lead),
      id: teamId,
      role: member.role,
      name: member.name,
    };
    exit('membership');
    return view;
  }

  function tryMembership(agent) {
    enter('tryMembership', [agent]);
    const member = resolveMember(agent);
    const view = member === undefined
      ? undefined
      : { root: agentOf(lead), id: teamId, role: member.role, name: member.name };
    exit('tryMembership');
    return view;
  }

  function listMembers(agent) {
    enter('listMembers', [agent]);
    requireMember(agent);
    const rows = [memberView(lead), ...teammates.map(memberView)];
    exit('listMembers');
    return rows;
  }

  async function spawnTeammate(callerAgent, request) {
    enter('spawnTeammate', [callerAgent, request]);
    const member = requireMember(callerAgent);
    if (member.role !== 'lead') {
      throw hostError(HOST_CODES.LEAD_REQUIRED, 'only the Team Lead can create teammates');
    }
    if (request === null || typeof request !== 'object') {
      throw hostError(HOST_CODES.INVALID_ARGUMENT, 'spawnTeammate requires a request object');
    }
    const name = request.name;
    if (typeof name !== 'string' || !MEMBER_NAME.test(name) || name.length > MEMBER_NAME_MAX || name === 'lead') {
      throw hostError(HOST_CODES.INVALID_MEMBER_NAME, `teammate name "${String(name)}" is not a valid member name`);
    }
    const description = requiredText(request.description, 'description', MAX_SUBJECT);
    const provider = requiredText(request.provider, 'provider', MAX_SUBJECT);
    if (request.context !== 'fresh' && request.context !== 'fork') {
      throw hostError(HOST_CODES.INVALID_ARGUMENT, 'context must be "fresh" or "fork"');
    }
    if (!Array.isArray(request.prompt) || request.prompt.length === 0) {
      throw hostError(HOST_CODES.INVALID_ARGUMENT, 'prompt must be a non-empty ContentBlock array');
    }
    if (teammates.some((row) => row.name === name)) {
      throw hostError(HOST_CODES.MEMBER_NAME_TAKEN, `teammate name "${name}" was already used in this Team`);
    }
    if (teammates.length >= memberLimit) {
      throw hostError(HOST_CODES.MEMBER_LIMIT, `Team member limit ${memberLimit} reached`);
    }

    // 注入的失败按宿主**抛出的时机**分两种（T18c）：写成员行之前就拒绝的码不产生成员行
    //（名字仍空闲、席位没有消耗）；其余（activation 池满、运行期故障）在 append 之后，
    // 会把那一行 settle 成 failed —— 名字与席位都被烧掉。
    const failure = pendingSpawnFailure;
    pendingSpawnFailure = null;
    if (failure !== null && PRE_APPEND_SPAWN_CODES.has(failure.code)) {
      throw hostError(failure.code, failure.message ?? 'spawn rejected before the member row');
    }

    // 真实实现先写 provisioning 行并 flush，再申请 activation。
    const row = addTeammate({ name, status: 'provisioning', phase: 'provisioning', description });
    try {
      if (failure !== null) {
        throw hostError(failure.code ?? HOST_CODES.HOST_FAILED_AFTER_EFFECT, failure.message ?? 'spawn failed');
      }
      if (activations >= activationLimit) {
        throw hostError(
          HOST_CODES.ACTIVATION_LIMIT_REACHED,
          `subagent limit reached (active child limit: ${activationLimit}); wait for an existing child to finish`,
        );
      }
      activations += 1;
      row.phase = 'active';
      row.running = true;
      row.provider = provider;
      row.context = request.context;
    } catch (error) {
      row.phase = 'failed';
      row.running = false;
      row.error = error.message;
      throw error;
    }
    // 注入口的 afterHost/dropResponse 在「副作用已发生」之后抛错，不能被上面的失败记录路径吞掉。
    const result = { member: memberView(row) };
    exit('spawnTeammate');
    return result;
  }

  async function sendMessage(callerAgent, request) {
    enter('sendMessage', [callerAgent, request]);
    const member = requireMember(callerAgent);
    if (!Array.isArray(request?.content) || request.content.length === 0) {
      throw hostError(HOST_CODES.INVALID_ARGUMENT, 'content must be a non-empty ContentBlock array');
    }
    const target = requireActiveMember(request.target);
    if (target.id === member.id) {
      throw hostError(HOST_CODES.SELF_MESSAGE, 'a Team member cannot message itself');
    }
    const content = [
      { type: 'text', text: `Team message from ${member.name}:` },
      ...structuredClone(request.content),
    ];
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > maxMessageBytes) {
      throw hostError(HOST_CODES.MESSAGE_TOO_LARGE, `team message exceeds ${maxMessageBytes} bytes`);
    }
    const message = {
      id: `message-${messages.length + 1}`,
      senderId: member.id,
      senderName: member.name,
      targetId: target.id,
      targetName: target.name,
      at: clock(),
    };
    messages.push(message);
    exit('sendMessage');
    return { messageId: message.id };
  }

  function interrupt(callerAgent, targetName) {
    enter('interrupt', [callerAgent, targetName]);
    const member = requireMember(callerAgent);
    if (member.role !== 'lead') {
      throw hostError(HOST_CODES.LEAD_REQUIRED, 'only the Team Lead can interrupt teammates');
    }
    const target = requireActiveMember(targetName);
    if (target.id === member.id) {
      throw hostError(HOST_CODES.INVALID_TARGET, 'the Team Lead cannot interrupt itself');
    }
    const previousStatus = target.running ? 'running' : 'inactive';
    target.running = false;
    exit('interrupt');
    return { previousStatus };
  }

  async function createTask(callerAgent, request) {
    enter('createTask', [callerAgent, request]);
    requireMember(callerAgent);
    const active = tasks.filter((task) => task.status !== 'deleted').length;
    if (active >= maxTasks) throw hostError(HOST_CODES.TASK_LIMIT, `Team task limit ${maxTasks} reached`);
    const task = {
      id: `task-${nextTaskNumber}`,
      revision: 1,
      subject: requiredText(request?.subject, 'subject', MAX_SUBJECT),
      description: requiredText(request?.description, 'description', MAX_DESCRIPTION),
      status: 'pending',
      blockedBy: validateDependencies(request?.blockedBy ?? [], undefined),
      writeScopes: [...(request?.writeScopes ?? [])],
    };
    nextTaskNumber += 1;
    tasks.push(task);
    const view = taskView(task);
    exit('createTask');
    return view;
  }

  function getTask(callerAgent, id) {
    enter('getTask', [callerAgent, id]);
    requireMember(callerAgent);
    const task = tasks.find((candidate) => candidate.id === id);
    if (task === undefined) throw hostError(HOST_CODES.TASK_NOT_FOUND, `team task "${id}" not found`);
    const view = taskView(task);
    exit('getTask');
    return view;
  }

  function listTasks(callerAgent) {
    enter('listTasks', [callerAgent]);
    requireMember(callerAgent);
    const views = tasks
      .filter((task) => task.status !== 'deleted')
      .sort((left, right) => Number.parseInt(left.id.slice(5), 10) - Number.parseInt(right.id.slice(5), 10))
      .map(taskView);
    exit('listTasks');
    return views;
  }

  async function updateTask(callerAgent, request) {
    enter('updateTask', [callerAgent, request]);
    const member = requireMember(callerAgent);
    const current = tasks.find((candidate) => candidate.id === request?.taskId);
    if (current === undefined) {
      throw hostError(HOST_CODES.TASK_NOT_FOUND, `team task "${String(request?.taskId)}" not found`);
    }
    if (current.revision !== request.expectedRevision) {
      throw hostError(
        HOST_CODES.TASK_STALE_REVISION,
        `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
      );
    }
    if (current.status === 'deleted') {
      throw hostError(HOST_CODES.TASK_DELETED, `team task "${current.id}" is deleted`);
    }
    if (!ACTIONS.has(request.action)) {
      throw hostError(HOST_CODES.INVALID_ARGUMENT, `unsupported task action ${String(request.action)}`);
    }
    const lead = member.role === 'lead';
    const owner = current.ownerId === member.id;
    const authorizeOwner = () => {
      if (!lead && !owner) {
        throw hostError(HOST_CODES.TASK_UNAUTHORIZED, 'task mutation requires its owner or Team Lead');
      }
    };

    let next;
    switch (request.action) {
      case 'claim': {
        if (current.ownerId !== undefined && current.ownerId !== member.id) {
          throw hostError(HOST_CODES.TASK_ALREADY_CLAIMED, `team task "${current.id}" is owned by another member`);
        }
        if (current.status !== 'pending' || !taskReady(current)) {
          throw hostError(HOST_CODES.TASK_BLOCKED, `team task "${current.id}" is not ready to claim`);
        }
        next = { ...current, status: 'in_progress', ownerId: member.id };
        break;
      }
      case 'release': {
        authorizeOwner();
        if (current.status !== 'in_progress') {
          throw hostError(HOST_CODES.TASK_INVALID_TRANSITION, 'only an in-progress task can be released');
        }
        next = withoutOwner({ ...current, status: 'pending' });
        break;
      }
      case 'edit': {
        authorizeOwner();
        if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
          throw hostError(HOST_CODES.INVALID_ARGUMENT, 'task edit requires subject, description, or write_scopes');
        }
        next = {
          ...current,
          ...(request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', MAX_SUBJECT) }),
          ...(request.description === undefined
            ? {}
            : { description: requiredText(request.description, 'description', MAX_DESCRIPTION) }),
          ...(request.writeScopes === undefined ? {} : { writeScopes: [...request.writeScopes] }),
        };
        break;
      }
      case 'set_dependencies': {
        authorizeOwner();
        if (request.blockedBy === undefined) {
          throw hostError(HOST_CODES.INVALID_ARGUMENT, 'set_dependencies requires blocked_by');
        }
        next = { ...current, blockedBy: validateDependencies(request.blockedBy, current.id) };
        break;
      }
      case 'complete': {
        authorizeOwner();
        if (current.status !== 'in_progress') {
          throw hostError(HOST_CODES.TASK_INVALID_TRANSITION, 'only an in-progress task can complete');
        }
        next = { ...current, status: 'completed' };
        break;
      }
      case 'reopen': {
        authorizeOwner();
        if (current.status !== 'completed') {
          throw hostError(HOST_CODES.TASK_INVALID_TRANSITION, 'only a completed task can reopen');
        }
        next = withoutOwner({ ...current, status: 'pending' });
        break;
      }
      case 'reassign': {
        if (!lead) throw hostError(HOST_CODES.LEAD_REQUIRED, 'only the Team Lead can reassign tasks');
        if (current.status !== 'pending' && current.status !== 'in_progress') {
          throw hostError(HOST_CODES.TASK_INVALID_TRANSITION, 'only a pending or in-progress task can be reassigned');
        }
        if (request.owner === undefined || request.owner.trim().length === 0) {
          // 清空 owner 的分支在 taskReady gate 之前 early-return
          next = withoutOwner({ ...current, status: 'pending' });
          break;
        }
        if (!taskReady(current)) throw hostError(HOST_CODES.TASK_BLOCKED, `team task "${current.id}" is blocked`);
        const assignee = requireActiveMember(request.owner);
        next = { ...current, status: 'in_progress', ownerId: assignee.id };
        break;
      }
      case 'delete': {
        authorizeOwner();
        const dependent = tasks.find((task) =>
          task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id));
        if (dependent !== undefined) {
          throw hostError(HOST_CODES.TASK_HAS_DEPENDENTS, `team task "${current.id}" still blocks "${dependent.id}"`);
        }
        next = { ...current, status: 'deleted' };
        break;
      }
      default:
        throw hostError(HOST_CODES.INVALID_ARGUMENT, `unsupported task action ${String(request.action)}`);
    }

    const index = tasks.indexOf(current);
    const committed = { ...next, revision: current.revision + 1 };
    tasks[index] = committed;
    const view = taskView(committed);
    exit('updateTask');
    return view;
  }

  // ---- fixture 助手 ---------------------------------------------------------
  const faults = {
    beforeHost(op, n = 1, spec) {
      faultsList.push({ op, when: 'before', n, count: 0, error: normalizeFaultError(spec, 'before') });
      return faults;
    },
    afterHost(op, n = 1, spec) {
      faultsList.push({ op, when: 'after', n, count: 0, error: normalizeFaultError(spec, 'after') });
      return faults;
    },
    dropResponse(op, n = 1, spec) {
      faultsList.push({ op, when: 'drop', n, count: 0, error: normalizeFaultError(spec, 'drop') });
      return faults;
    },
    clear() {
      faultsList = [];
      return faults;
    },
    list() {
      return faultsList.map((fault) => ({ op: fault.op, when: fault.when, n: fault.n, count: fault.count }));
    },
  };

  return {
    service: {
      membership,
      tryMembership,
      listMembers,
      spawnTeammate,
      sendMessage,
      createTask,
      getTask,
      listTasks,
      updateTask,
      interrupt,
    },
    agent: caller,
    teamId,
    calls,
    callsFor(op) {
      return calls.filter((call) => call.op === op);
    },
    resetCalls() {
      calls.length = 0;
    },
    agentFor(name) {
      if (name === lead.name) return agentOf(lead);
      const row = teammates.find((candidate) => candidate.name === name);
      if (row === undefined) throw new Error(`fake team has no member "${name}"`);
      return agentOf(row);
    },
    snapshot() {
      return {
        teamId,
        members: [memberView(lead), ...teammates.map((row) => ({
          id: row.id,
          name: row.name,
          role: row.role,
          phase: row.phase,
          status: statusOf(row),
          ...(row.error === undefined ? {} : { error: row.error }),
        }))],
        tasks: tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] })),
        messages: messages.map((message) => ({ ...message })),
        teammates: teammates.length,
        activations,
      };
    },
    faults,
    failNextSpawn(spec) {
      // `spec.code` 决定抛出时机：`PRE_APPEND_SPAWN_CODES` 里的码在写成员行之前抛（不产生行，
      // 名字与席位都还在），其余按「append 之后失败」处理（该行 settle 成 failed）。
      pendingSpawnFailure = spec ?? {};
    },
    failMember(name) {
      const row = teammates.find((candidate) => candidate.name === name);
      if (row === undefined) throw new Error(`fake team has no member "${name}"`);
      row.phase = 'failed';
      row.running = false;
      return row;
    },
    setActivations(count) {
      activations = count;
    },
  };
}
