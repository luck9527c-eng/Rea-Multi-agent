/**
 * 宿主团队服务适配器（SEAMS 第 3 节）。
 *
 * 设计要点：
 *
 * 1. **可选注入**：`agentTeams` 通过 `services.agentTeams` 拿；也支持 E2 笔记里记录的
 *    `ctx.get('agentTeams')` 写法。服务缺席时每个方法都返回
 *    `{ok:false, code:'TEAM_SERVICE_UNAVAILABLE'}`，不抛、不在模块初始化时崩。
 * 2. **永不 reject**：所有宿主异常都映射成 `{ok:false, code, hostCode, reason, retryable}`；
 *    原始错误码保留在 `hostCode`，原始文案保留在 `reason`（SEAMS 第 6 节：不把宿主异常串当 code）。
 * 3. **权威在宿主**：角色授权、任务板 CAS、成员名规则都由服务层判定，适配器只做投影与映射，
 *    不在本地重新实现一遍更弱的检查（D4）。
 * 4. **`usedSeats()` 只报能数到的那一件事**（T23）：已用席位恒从 `listMembers()` 数
 *    `role === 'teammate'` 得出（含失败成员）。宿主**不提供任何上限读数**：`maxMembers` 是
 *    `TeamService` 的构造函数参数（没有 getter），`maxActiveSubagents` 在团队服务里不存在。
 *    所以适配器不再回答「还剩几个」，也**不读任何容量声明文件**；上限的唯一体现是宿主自己的
 *    拒绝（`TEAM_MEMBER_LIMIT` / `ACTIVATION_LIMIT_REACHED` → `CAPACITY_EXHAUSTED`）。
 *
 * `usedSeats()` 的返回形状：
 *
 * ```js
 * { ok: boolean, used: number | null, code?, reason?, nextStep? }   // used === null 表示数不到，不是 0
 * ```
 *
 * 宿主服务的形状是**外部事实**：本模块只声明自己真正调用的方法子集，所有值按 `unknown`
 * 收、按需收窄（`guards.recordOf`），不假定宿主的对象形状。
 */
import { isRecord, recordOf, thrownCode } from './guards.js';
/** 适配器契约版本（写进 re/team/binding.json 的 `adapter.contract_version`）。 */
export const CONTRACT_VERSION = 1;
/** 同上，长名字别名，便于下游按字段名取值。 */
export const ADAPTER_CONTRACT_VERSION = CONTRACT_VERSION;
const SERVICE_UNAVAILABLE = 'TEAM_SERVICE_UNAVAILABLE';
const ROLE_REQUIRED = 'ROLE_REQUIRED';
const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
const CAPACITY_EXHAUSTED = 'CAPACITY_EXHAUSTED';
const DELIVERY_FAILED = 'DELIVERY_FAILED';
const REVISION_CONFLICT = 'REVISION_CONFLICT';
const RECOVERY_REQUIRED = 'RECOVERY_REQUIRED';
/** 任务板码按 D2 原样透传（`TEAM_TASK_*` 自带语义，不另造同义词）。 */
const TASK_PASSTHROUGH = new Set([
    'TEAM_TASK_BLOCKED',
    'TEAM_TASK_ALREADY_CLAIMED',
    'TEAM_TASK_UNAUTHORIZED',
    'TEAM_TASK_NOT_FOUND',
    'TEAM_TASK_DELETED',
    'TEAM_TASK_INVALID_TRANSITION',
    'TEAM_TASK_HAS_DEPENDENTS',
    'TEAM_TASK_DEPENDENCY_CYCLE',
]);
const COMMON = {
    TEAM_NOT_MEMBER: ROLE_REQUIRED,
    TEAM_LEAD_REQUIRED: ROLE_REQUIRED,
    TEAM_DISPOSED: SERVICE_UNAVAILABLE,
};
const MAPS = {
    spawn: {
        ...COMMON,
        ACTIVATION_LIMIT_REACHED: CAPACITY_EXHAUSTED,
        TEAM_MEMBER_LIMIT: CAPACITY_EXHAUSTED,
        TEAM_INVALID_MEMBER_NAME: INVALID_ARGUMENT,
        TEAM_MEMBER_NAME_TAKEN: INVALID_ARGUMENT,
        TEAM_INVALID_ARGUMENT: INVALID_ARGUMENT,
        TEAM_PROVISIONING_CONFLICT: RECOVERY_REQUIRED,
    },
    message: {
        ...COMMON,
        TEAM_MESSAGE_TOO_LARGE: DELIVERY_FAILED,
        TEAM_SELF_MESSAGE: DELIVERY_FAILED,
        TEAM_INVALID_TARGET: DELIVERY_FAILED,
        TEAM_MEMBER_NOT_FOUND: DELIVERY_FAILED,
        TEAM_INVALID_ARGUMENT: DELIVERY_FAILED,
    },
    task: {
        ...COMMON,
        TEAM_TASK_STALE_REVISION: REVISION_CONFLICT,
        TEAM_TASK_LIMIT: CAPACITY_EXHAUSTED,
        TEAM_INVALID_ARGUMENT: INVALID_ARGUMENT,
    },
    interrupt: {
        ...COMMON,
        TEAM_MEMBER_NOT_FOUND: INVALID_ARGUMENT,
        TEAM_INVALID_TARGET: INVALID_ARGUMENT,
        TEAM_INVALID_ARGUMENT: INVALID_ARGUMENT,
    },
    read: {
        ...COMMON,
        TEAM_INVALID_ARGUMENT: INVALID_ARGUMENT,
    },
};
const RETRYABLE = {
    [SERVICE_UNAVAILABLE]: true,
    [DELIVERY_FAILED]: true,
    TEAM_TASK_BLOCKED: true,
    [ROLE_REQUIRED]: false,
    [INVALID_ARGUMENT]: false,
    [CAPACITY_EXHAUSTED]: false,
    [REVISION_CONFLICT]: false,
    [RECOVERY_REQUIRED]: false,
};
/** 宿主支持的任务动作闭集（照 `TeamTaskAction`，不臆造 `reassignTask`/`completeTask`）。 */
const TASK_ACTIONS = new Set([
    'claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete',
]);
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/** 是否是「装配上下文里的 getter」（等价于原来的 `ctx && typeof ctx.get === 'function'`）。 */
function isGetterHost(value) {
    return isRecord(value) && typeof value.get === 'function';
}
/**
 * 宿主服务视图。
 *
 * 只校验「是对象或函数」，与原实现的信任边界一致（原来只判 `=== undefined`）：
 * 方法缺失/形状漂移会在调用处抛，由各方法的 `try/catch` 映射成 `RECOVERY_REQUIRED`。
 */
function asHostTeamService(value) {
    if (isRecord(value) || typeof value === 'function') {
        const service = value;
        // 不变式：宿主团队服务必然是对象/函数（服务层实例）；这里只把 `unknown` 认成
        // 「有这些方法的对象」，与迁移前直接 `teams.xxx(...)` 的信任边界一致。
        return service;
    }
    return null;
}
/** 把 string / ContentBlock[] 统一成宿主要的 ContentBlock[]。 */
function toContent(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value === 'string')
        return [{ type: 'text', text: value }];
    return undefined;
}
function unavailable(operation) {
    return {
        ok: false,
        code: SERVICE_UNAVAILABLE,
        reason: `agentTeams is not mounted; ${operation} needs the team profile bundle`,
        retryable: true,
        diagnostics: [{
                code: SERVICE_UNAVAILABLE,
                detail: 'ctx.services.agentTeams 缺席（团队 profile bundle 未启用，或未以可选注入方式拿到服务）',
                nextStep: '启用 @deepseek-ai/dsh-experimental-agent-team-profile，或运行 node <bundle-root>/bin/doctor.mjs 看具体修复路径',
            }],
    };
}
/** 参数不合法时的失败分支；`extra` 只带本方法特有的上下文（`actualRevision`/`supportedActions`）。 */
function invalid(operation, reason, extra = {}) {
    return {
        ok: false,
        code: INVALID_ARGUMENT,
        reason,
        retryable: false,
        diagnostics: [{ code: INVALID_ARGUMENT, detail: `${operation}: ${reason}` }],
        ...extra,
    };
}
/** 宿主异常 → 稳定码。原始码放 `hostCode`，原始文案放 `reason`。 */
function failureFrom(error, context) {
    const hostCode = thrownCode(error) ?? undefined;
    const map = MAPS[context] ?? MAPS.read;
    let code;
    if (hostCode !== undefined && TASK_PASSTHROUGH.has(hostCode) && (context === 'task' || context === 'read')) {
        code = hostCode;
    }
    else if (hostCode !== undefined && map[hostCode] !== undefined) {
        code = map[hostCode];
    }
    else {
        code = RECOVERY_REQUIRED;
    }
    const message = error instanceof Error
        ? error.message
        : (typeof error === 'string' ? error : 'host call failed with a non-Error value');
    return {
        ok: false,
        code,
        ...(hostCode === undefined ? {} : { hostCode }),
        reason: message,
        retryable: RETRYABLE[code] ?? false,
        diagnostics: [{
                code,
                hostCode: hostCode ?? null,
                detail: message,
                ...(code === RECOVERY_REQUIRED
                    ? { nextStep: '宿主侧状态未知：先按宿主快照核对实际结果（成员名/任务快照），再决定恢复动作，不要盲目重试' }
                    : {}),
            }],
    };
}
/**
 * 已用席位：恒从 listMembers 数 teammate（含 failed），这是唯一受支持的「已用」来源。
 *
 * 行按宿主形状标注（`{role}`）而不是 `recordOf` 兜底：迁移前的 `row.role` 在行不是对象时
 * 会抛，由 `usedSeats()` 的 `try/catch` 记成「数不到已用席位」；这里保持同一条路径。
 */
function countUsedSeats(service, agent) {
    const rows = service.listMembers(agent);
    if (!Array.isArray(rows))
        throw new TypeError('listMembers did not return an array');
    return rows.filter((row) => row.role === 'teammate').length;
}
function projectMember(view) {
    if (!isRecord(view))
        return null;
    const projected = {
        id: view.id,
        name: view.name,
        role: view.role,
        status: view.status,
        ...(Array.isArray(view.diagnostics) && view.diagnostics.length > 0
            ? { diagnostics: [...view.diagnostics] }
            : {}),
    };
    // 不变式：宿主成员视图由 SEAMS §3 钉死为 `{id, name, role, status}`；这里逐字段原样投影，
    // 不校验、不改值，与迁移前的 `{id: view.id, …}` 完全一致。
    return projected;
}
/** 宿主任务视图 → SEAMS 的 task 形状；`ownerName` 投影成 `owner`。 */
function projectTask(view) {
    if (!isRecord(view))
        return null;
    const projected = {
        id: view.id,
        revision: view.revision,
        status: view.status,
        owner: view.ownerName ?? null,
        subject: view.subject,
        description: view.description,
        blockedBy: Array.isArray(view.blockedBy) ? [...view.blockedBy] : [],
        ready: view.ready === true,
        writeScopes: Array.isArray(view.writeScopes) ? [...view.writeScopes] : [],
    };
    // 不变式：宿主任务视图由 SEAMS §3 钉死（`revision` 是 number、`status` 是三种字面量之一）；
    // 这里逐字段原样投影，与迁移前的 `{revision: view.revision, …}` 完全一致。
    return projected;
}
/**
 * 名册一行：宿主视图逐字段投影（`{id, name, role, status}` 见 SEAMS §3）。
 *
 * 入参按宿主行形状标注、不做 `recordOf` 兜底：与迁移前一样，行不是对象时读字段会抛
 * （由调用方的 `try/catch` 映射成失败），不会静默变成一行 undefined。
 */
function projectMemberRow(view) {
    const projected = { id: view.id, name: view.name, role: view.role, status: view.status };
    // 不变式：SEAMS §3 的 `listMembers()` 行形状是 `{id, name, role, status}`；投影不校验、不改值。
    return projected;
}
/**
 * 建一个 teamAdapter。
 *
 * 支持两种入参形态：
 * - `createTeamAdapter({ ctx })`：从装配上下文取 `services` / `exec`；
 * - `createTeamAdapter({ services, exec, agent })`：显式注入。
 *
 * `config` / `projectRoot` 仍然接受（装配层给两个适配器同一份 options），但不再被读取：
 * T23 起团队适配器不读项目里的容量声明文件，也不读 profile 配置里的容量段。
 */
export function createTeamAdapter(input = {}) {
    const ctx = input.ctx ?? undefined;
    const ctxView = recordOf(ctx);
    const services = input.services ?? ctxView.services ?? undefined;
    const exec = input.exec ?? ctxView.exec ?? undefined;
    const explicitAgent = input.agent ?? undefined;
    function service() {
        const injected = isRecord(services) ? services.agentTeams : undefined;
        if (injected !== undefined && injected !== null)
            return injected;
        if (isGetterHost(ctx)) {
            try {
                const resolved = ctx.get('agentTeams');
                if (resolved !== undefined && resolved !== null)
                    return resolved;
            }
            catch {
                return undefined;
            }
        }
        return undefined;
    }
    function callerAgent(override) {
        if (override !== undefined)
            return override;
        if (explicitAgent !== undefined)
            return explicitAgent;
        return isRecord(exec) ? exec.agent : undefined;
    }
    const adapter = {
        contract_version: CONTRACT_VERSION,
        CONTRACT_VERSION,
        /** 团队服务是否可用（doctor/identity 用）。 */
        hasService() {
            return service() !== undefined;
        },
        /** 解析调用者在团队里的身份；只接受宿主给的活 agent。 */
        async membership(...args) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('membership');
            // 显式传 undefined 表示「没有活 agent」；不传才回落到装配上下文里的 exec.agent。
            const live = args.length > 0 ? args[0] : callerAgent();
            if (live === undefined || live === null || typeof live !== 'object') {
                return {
                    ok: false,
                    code: ROLE_REQUIRED,
                    reason: '没有宿主的活 exec.agent，无法确定团队身份',
                    retryable: false,
                    diagnostics: [{
                            code: ROLE_REQUIRED,
                            detail: 'membership() 只接受宿主提供的活 Agent，不接受入参自报身份',
                            nextStep: '在 Agent 作用域内调用；非团队成员会被 TEAM_NOT_MEMBER / tryMembership()===undefined 拒绝',
                        }],
                };
            }
            try {
                const resolved = typeof teams.tryMembership === 'function'
                    ? teams.tryMembership(live)
                    : teams.membership(live);
                if (resolved === undefined || resolved === null) {
                    return {
                        ok: false,
                        code: ROLE_REQUIRED,
                        reason: 'caller is not a member of this Team (tryMembership returned undefined)',
                        retryable: false,
                        diagnostics: [{
                                code: ROLE_REQUIRED,
                                detail: '裸子代理/非成员不是团队角色',
                                nextStep: '只有 Team Lead 或真实 teammate 可以做编排操作；由 Lead 用 rt_dispatch 建岗',
                            }],
                    };
                }
                const member = recordOf(resolved);
                const rootView = member.root;
                const projected = {
                    id: member.id,
                    name: member.name,
                    role: member.role,
                    root: rootView !== null && typeof rootView === 'object' ? recordOf(rootView).id : null,
                };
                // 不变式：SEAMS §3 的成员视图是 `{id, name, role, root}`；这里逐字段原样投影。
                return { ok: true, member: projected };
            }
            catch (error) {
                return failureFrom(error, 'read');
            }
        },
        /** 名册（含 Lead 行与 failed 行）。 */
        async listMembers(agent) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('listMembers');
            const live = callerAgent(agent);
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            try {
                const rows = teams.listMembers(live);
                return {
                    ok: true,
                    members: (Array.isArray(rows) ? rows : []).map(projectMemberRow),
                };
            }
            catch (error) {
                return failureFrom(error, 'read');
            }
        },
        /**
         * 建一个 teammate。
         * @param {{name: string, prompt: string|object[], description?: string,
         *          context?: 'fresh'|'fork', provider?: string, signal?: AbortSignal}} request
         */
        async spawnTeammate(request = {}) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('spawnTeammate');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            const content = toContent(request.prompt);
            if (content === undefined || content.length === 0) {
                return invalid('spawnTeammate', 'prompt 必须是非空的字符串或 ContentBlock[]');
            }
            if (!isNonEmptyString(request.name)) {
                return invalid('spawnTeammate', 'name 必须是非空字符串');
            }
            const description = isNonEmptyString(request.description)
                ? request.description.trim().slice(0, 200)
                : deriveDescription(content, request.name);
            const hostRequest = {
                name: request.name,
                description,
                prompt: content,
                context: request.context === 'fork' ? 'fork' : 'fresh',
                provider: isNonEmptyString(request.provider) ? request.provider : 'spawn',
                signal: request.signal ?? new AbortController().signal,
            };
            try {
                const result = await teams.spawnTeammate(live, hostRequest);
                return { ok: true, member: projectMember(recordOf(result).member) };
            }
            catch (error) {
                return failureFrom(error, 'spawn');
            }
        },
        /**
         * 向一个成员投递消息。
         * @param {{target: string, message?: string, content?: object[], signal?: AbortSignal}} request
         */
        async sendMessage(request = {}) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('sendMessage');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            if (!isNonEmptyString(request.target))
                return invalid('sendMessage', 'target 必须是非空的成员名');
            const content = toContent(request.content ?? request.message);
            if (content === undefined || content.length === 0) {
                return invalid('sendMessage', 'message/content 必须是非空文本');
            }
            try {
                const result = await teams.sendMessage(live, {
                    target: request.target,
                    content,
                    signal: request.signal ?? new AbortController().signal,
                });
                return { ok: true, messageId: recordOf(result).messageId };
            }
            catch (error) {
                return failureFrom(error, 'message');
            }
        },
        /** 中断一个 teammate，返回中断前状态（只可能 running|inactive，D10）。 */
        async interruptAgent(request = {}) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('interruptAgent');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            if (!isNonEmptyString(request.target))
                return invalid('interruptAgent', 'target 必须是非空的成员名');
            try {
                const result = recordOf(teams.interrupt(live, request.target));
                if (result.previousStatus === 'running' || result.previousStatus === 'inactive') {
                    return { ok: true, previousStatus: result.previousStatus };
                }
                return {
                    ok: false,
                    code: RECOVERY_REQUIRED,
                    reason: `unexpected previousStatus ${JSON.stringify(result.previousStatus)}`,
                    retryable: false,
                    diagnostics: [{
                            code: RECOVERY_REQUIRED,
                            detail: '宿主 interrupt() 只允许返回 running|inactive，出现其它值说明服务行为漂移',
                            nextStep: '重新 listMembers 核对成员实际状态，并记录服务版本',
                        }],
                };
            }
            catch (error) {
                return failureFrom(error, 'interrupt');
            }
        },
        /**
         * 已用席位（T23）：只回答这一件能数到的事。
         *
         * 数不到就说数不到（`used: null` + 原因），**不**回落成 0，也**不**顺手编一个上限。
         * 上限由宿主自己强制：`spawnTeammate` 被拒时适配器把 `TEAM_MEMBER_LIMIT` /
         * `ACTIVATION_LIMIT_REACHED` 映射成 `CAPACITY_EXHAUSTED`，原始文案留在 `reason`。
         */
        async usedSeats() {
            const teams = service();
            if (teams === undefined) {
                return {
                    ok: false,
                    used: null,
                    code: SERVICE_UNAVAILABLE,
                    reason: 'agentTeams 未挂载，数不到已用席位',
                    nextStep: '启用团队 profile bundle 后重试',
                };
            }
            const live = callerAgent();
            if (live === undefined) {
                return {
                    ok: false,
                    used: null,
                    code: ROLE_REQUIRED,
                    reason: '没有宿主的活 exec.agent，数不到已用席位',
                    nextStep: '在 Agent 作用域内调用 rt_roster/rt_dispatch',
                };
            }
            try {
                const host = asHostTeamService(teams);
                if (host === null)
                    throw new TypeError('agentTeams is not an object');
                return { ok: true, used: countUsedSeats(host, live) };
            }
            catch (error) {
                return {
                    ok: false,
                    used: null,
                    code: RECOVERY_REQUIRED,
                    reason: `listMembers() 失败，数不到已用席位：${error instanceof Error ? error.message : String(error)}`,
                    nextStep: '先修好团队服务/身份，再读已用席位',
                };
            }
        },
        /**
         * 建任务；宿主保证 `pending` + 无 owner + revision 1。
         * @param {{subject: string, description: string, blockedBy?: string[]}} request
         */
        async createTask(request = {}) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('createTask');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            if (!isNonEmptyString(request.subject))
                return invalid('createTask', 'subject 必须是非空字符串');
            if (typeof request.description !== 'string' || request.description.trim().length === 0) {
                return invalid('createTask', 'description 必须是非空字符串');
            }
            if (request.blockedBy !== undefined && !Array.isArray(request.blockedBy)) {
                return invalid('createTask', 'blockedBy 必须是任务 ID 数组');
            }
            try {
                const view = await teams.createTask(live, {
                    subject: request.subject,
                    description: request.description,
                    ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy }),
                    ...(Array.isArray(request.writeScopes) ? { writeScopes: request.writeScopes } : {}),
                });
                return { ok: true, task: projectTask(view) };
            }
            catch (error) {
                return failureFrom(error, 'task');
            }
        },
        /**
         * CAS 任务变更；`action` 只用宿主枚举（reassign|complete|claim|release|edit|set_dependencies|reopen|delete）。
         * @param {{taskId: string, expectedRevision: number, action: string, owner?: string,
         *          subject?: string, description?: string, blockedBy?: string[],
         *          writeScopes?: string[]}} request
         */
        async updateTask(request = {}) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('updateTask');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            if (!isNonEmptyString(request.taskId))
                return invalid('updateTask', 'taskId 必须是非空字符串');
            const expectedRevision = request.expectedRevision;
            if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
                return invalid('updateTask', 'expectedRevision 必须是 >=1 的整数（提交的是变更前 revision）', {
                    actualRevision: null,
                });
            }
            if (typeof request.action !== 'string' || !TASK_ACTIONS.has(request.action)) {
                return invalid('updateTask', `unsupported task action ${JSON.stringify(request.action)}`, {
                    supportedActions: [...TASK_ACTIONS],
                });
            }
            const hostRequest = {
                taskId: request.taskId,
                expectedRevision,
                action: request.action,
                ...(request.owner === undefined ? {} : { owner: request.owner }),
                ...(request.subject === undefined ? {} : { subject: request.subject }),
                ...(request.description === undefined ? {} : { description: request.description }),
                ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy }),
                ...(request.writeScopes === undefined ? {} : { writeScopes: request.writeScopes }),
            };
            try {
                const view = await teams.updateTask(live, hostRequest);
                return { ok: true, task: projectTask(view) };
            }
            catch (error) {
                const failure = failureFrom(error, 'task');
                if (failure.code === REVISION_CONFLICT) {
                    return { ...failure, actualRevision: await readActualRevision(teams, live, request.taskId, failure) };
                }
                return failure;
            }
        },
        /** 读一条任务（含墓碑）。 */
        async getTask(taskId) {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('getTask');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            if (!isNonEmptyString(taskId))
                return invalid('getTask', 'taskId 必须是非空字符串');
            try {
                return { ok: true, task: projectTask(teams.getTask(live, taskId)) };
            }
            catch (error) {
                return failureFrom(error, 'read');
            }
        },
        /** 列当前未删除任务。 */
        async listTasks() {
            const teams = asHostTeamService(service());
            if (teams === null)
                return unavailable('listTasks');
            const live = callerAgent();
            if (live === undefined)
                return { ok: false, code: ROLE_REQUIRED, reason: 'no live exec.agent' };
            try {
                const views = teams.listTasks(live);
                return { ok: true, tasks: (Array.isArray(views) ? views : []).map(projectTask) };
            }
            catch (error) {
                return failureFrom(error, 'read');
            }
        },
    };
    return adapter;
    /** CAS 冲突时的「实际 revision」：先重读任务，读不到再从宿主文案里取。 */
    async function readActualRevision(teams, live, taskId, failure) {
        try {
            const view = recordOf(teams.getTask(live, taskId));
            const revision = view.revision;
            if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
                return revision;
            }
        }
        catch {
            // 读不到就退回文案解析
        }
        const message = typeof failure.reason === 'string' ? failure.reason : '';
        const matched = /current revision is (\d+)/u.exec(message);
        return matched === null ? null : Number.parseInt(matched[1], 10);
    }
}
/** 从 prompt 文本派生宿主需要的 description（≤200，非空）。 */
function deriveDescription(content, name) {
    const parts = [];
    for (const block of content) {
        const view = recordOf(block);
        if (view.type !== 'text' || typeof view.text !== 'string')
            continue;
        parts.push(view.text);
    }
    const text = parts.join('\n').trim();
    if (text.length === 0)
        return `teammate ${name}`;
    const firstLine = text.split(/\r?\n/u)[0].trim();
    return (firstLine.length > 0 ? firstLine : text).slice(0, 200);
}
