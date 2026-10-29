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
 * 4. **capacity() 只说实话**：真实宿主没有任何容量查询（D1）。已用席位恒从
 *    `listMembers()` 数 `role === 'teammate'` 得出（含失败成员）；上限只认显式声明
 *    （`re/team/capacity.json` 或 profile 的 `config.capacity`）；两者都没有就 `known:false`。
 *    这里**绝不**猜常数、绝不读宿主内部结构、绝不靠 spawn 试探余额（D12：失败会烧掉名字与席位）。
 *
 * `capacity()` 的返回形状（在 SEAMS 之上加了 `ok` 与 `gaps`）：
 *
 * ```js
 * {
 *   ok: boolean,
 *   memberSlots: {known, remaining, total, used},   // used 恒可数；total/remaining 需声明
 *   activations: {known, remaining, total},         // 只声明上限；当前占用不可观测 → remaining 为 null
 *   evidence: {source: 'declared:re/team/capacity.json'|'declared:profile-config'|'unavailable', …},
 *   gaps: [{code, detail, nextStep}],
 * }
 * ```
 *
 * 宿主服务的形状是**外部事实**：本模块只声明自己真正调用的方法子集，所有值按 `unknown`
 * 收、按需收窄（`guards.recordOf`），不假定宿主的对象形状。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
/**
 * 已经过 `isPositiveInteger()` 校验的值。
 *
 * 存在的理由：`problems` 式校验只收集问题、不产生控制流收窄，返回对象时需要一处
 * 「命题已在上文证明」的断言点。不变式：每个调用点都紧跟在同一字段的
 * `isPositiveInteger()` 校验之后，且只有 `problems` 为空才会走到返回值。
 */
function provenPositive(value) {
    // 断言：调用点紧跟 isPositiveInteger() 校验，且只有 problems 为空才走到这里。
    return value;
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
/** 容量声明缺失/非法时的 gap（绝不猜上限）。 */
function capacityGap(code, detail, nextStep) {
    return { code, detail, nextStep };
}
const DECLARE_NEXT_STEP = '在项目里声明 re/team/capacity.json（schema_version:1、带时区的 declared_at、declared_by、'
    + 'maxMembers、maxActiveSubagents），或在 profile patch 的 redteam-lead-tools.config.capacity 里声明；'
    + '未声明时上层按 CAPACITY_UNKNOWN 处理，不拿常数猜余额。';
/**
 * 读并校验项目里的容量声明 `re/team/capacity.json`。
 * 文件缺失/JSON 坏/字段不合法都返回 `{known:false, gap}`，不抛。
 * @param {string} projectRoot 项目根
 */
export async function readDeclaredCapacity(projectRoot) {
    if (!isNonEmptyString(projectRoot)) {
        return {
            known: false,
            gap: capacityGap('CAPACITY_DECLARATION_MISSING', '没有项目根，读不到 re/team/capacity.json', DECLARE_NEXT_STEP),
        };
    }
    const file = path.join(projectRoot, 're', 'team', 'capacity.json');
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        const missing = thrownCode(error) === 'ENOENT';
        return {
            known: false,
            gap: capacityGap(missing ? 'CAPACITY_DECLARATION_MISSING' : 'CAPACITY_DECLARATION_INVALID', missing ? `没有找到 ${file}` : `读不了 ${file}: ${error instanceof Error ? error.message : String(error)}`, DECLARE_NEXT_STEP),
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            known: false,
            gap: capacityGap('CAPACITY_DECLARATION_INVALID', `${file} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, DECLARE_NEXT_STEP),
        };
    }
    if (!isRecord(parsed) || Array.isArray(parsed)) {
        return {
            known: false,
            gap: capacityGap('CAPACITY_DECLARATION_INVALID', `${file} 必须是 JSON 对象`, DECLARE_NEXT_STEP),
        };
    }
    const problems = [];
    if (parsed.schema_version !== 1)
        problems.push('schema_version 必须是 1');
    if (!isNonEmptyString(parsed.declared_at) || !ISO_WITH_ZONE.test(parsed.declared_at)) {
        problems.push('declared_at 必须是带时区的 ISO 8601 时间');
    }
    if (!isNonEmptyString(parsed.declared_by))
        problems.push('declared_by 必须是非空字符串');
    if (!isPositiveInteger(parsed.maxMembers))
        problems.push('maxMembers 必须是 >=1 的整数');
    if (!isPositiveInteger(parsed.maxActiveSubagents))
        problems.push('maxActiveSubagents 必须是 >=1 的整数');
    if (problems.length > 0) {
        return {
            known: false,
            gap: capacityGap('CAPACITY_DECLARATION_INVALID', `${file} 字段不合法：${problems.join('；')}`, DECLARE_NEXT_STEP),
        };
    }
    return {
        known: true,
        maxMembers: provenPositive(parsed.maxMembers),
        maxActiveSubagents: provenPositive(parsed.maxActiveSubagents),
        declaredAt: parsed.declared_at,
        declaredBy: parsed.declared_by,
        source: 'declared:re/team/capacity.json',
        path: 're/team/capacity.json',
    };
}
/** 归一 profile config 里的容量声明；没有声明返回 `null`，非法返回 `{ok:false, gap}`。 */
function normalizeConfigCapacity(config) {
    const declared = isRecord(config) ? config.capacity : undefined;
    if (declared === undefined || declared === null)
        return null;
    if (!isRecord(declared) || Array.isArray(declared)) {
        return {
            ok: false,
            gap: capacityGap('CAPACITY_DECLARATION_INVALID', 'config.capacity 必须是对象', DECLARE_NEXT_STEP),
        };
    }
    const problems = [];
    if (!isPositiveInteger(declared.maxMembers))
        problems.push('maxMembers 必须是 >=1 的整数');
    if (!isPositiveInteger(declared.maxActiveSubagents))
        problems.push('maxActiveSubagents 必须是 >=1 的整数');
    if (problems.length > 0) {
        return {
            ok: false,
            gap: capacityGap('CAPACITY_DECLARATION_INVALID', `config.capacity 字段不合法：${problems.join('；')}`, DECLARE_NEXT_STEP),
        };
    }
    return {
        ok: true,
        maxMembers: provenPositive(declared.maxMembers),
        maxActiveSubagents: provenPositive(declared.maxActiveSubagents),
        declaredAt: declared.declared_at ?? null,
        declaredBy: declared.declared_by ?? 'profile-config',
        source: 'declared:profile-config',
    };
}
/**
 * 已用席位：恒从 listMembers 数 teammate（含 failed），这是唯一受支持的「已用」来源。
 *
 * 行按宿主形状标注（`{role}`）而不是 `recordOf` 兜底：迁移前的 `row.role` 在行不是对象时
 * 会抛，由 `capacity()` 的 `try/catch` 记成 `CAPACITY_USED_UNKNOWN`；这里保持同一条路径。
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
 * - `createTeamAdapter({ ctx })`：从装配上下文取 `services` / `exec` / `config` / `root`；
 * - `createTeamAdapter({ services, exec, agent, config, projectRoot })`：显式注入。
 */
export function createTeamAdapter(input = {}) {
    const ctx = input.ctx ?? undefined;
    const ctxView = recordOf(ctx);
    const services = input.services ?? ctxView.services ?? undefined;
    const exec = input.exec ?? ctxView.exec ?? undefined;
    const config = input.config ?? ctxView.config ?? {};
    const explicitAgent = input.agent ?? undefined;
    const declaredProjectRoot = input.projectRoot
        ?? (typeof ctxView.root === 'string' ? ctxView.root : undefined)
        ?? (isRecord(config) ? config.projectRoot : undefined);
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
    function projectRoot() {
        if (isNonEmptyString(declaredProjectRoot))
            return declaredProjectRoot;
        return undefined;
    }
    const adapter = {
        contract_version: CONTRACT_VERSION,
        CONTRACT_VERSION,
        /** 团队服务是否可用（doctor/identity 用）。 */
        hasService() {
            return service() !== undefined;
        },
        /** 见文件头。 */
        async readDeclaredCapacity(root) {
            return readDeclaredCapacity(root ?? projectRoot());
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
         * 容量：已用席位可数，上限必须显式声明（见文件头与 D1）。
         */
        async capacity() {
            const teams = service();
            const root = projectRoot();
            const declaration = await readDeclaredCapacity(root);
            const configured = normalizeConfigCapacity(config);
            const gaps = [];
            let declared = null;
            if (declaration.known === true) {
                declared = {
                    maxMembers: declaration.maxMembers,
                    maxActiveSubagents: declaration.maxActiveSubagents,
                    declaredAt: declaration.declaredAt,
                    declaredBy: declaration.declaredBy,
                    source: declaration.source,
                };
            }
            else if (configured !== null && configured.ok === true) {
                declared = {
                    maxMembers: configured.maxMembers,
                    maxActiveSubagents: configured.maxActiveSubagents,
                    declaredAt: configured.declaredAt,
                    declaredBy: configured.declaredBy,
                    source: configured.source,
                };
            }
            else {
                gaps.push(declaration.gap ?? capacityGap('CAPACITY_DECLARATION_MISSING', 're/team/capacity.json 与 profile config.capacity 都没有声明容量', DECLARE_NEXT_STEP));
                if (configured !== null && configured.ok === false)
                    gaps.push(configured.gap);
            }
            let used = null;
            if (teams === undefined) {
                gaps.push(capacityGap('CAPACITY_USED_UNKNOWN', 'agentTeams 未挂载，数不到已用席位', '启用团队 profile bundle 后重试；未挂载时不要建岗'));
            }
            else {
                const live = callerAgent();
                if (live === undefined) {
                    gaps.push(capacityGap('CAPACITY_USED_UNKNOWN', '没有宿主的活 exec.agent，数不到已用席位', '在 Agent 作用域内调用 rt_roster/rt_dispatch'));
                }
                else {
                    try {
                        const host = asHostTeamService(teams);
                        if (host === null)
                            throw new TypeError('agentTeams is not an object');
                        used = countUsedSeats(host, live);
                    }
                    catch (error) {
                        gaps.push(capacityGap('CAPACITY_USED_UNKNOWN', `listMembers() 失败，数不到已用席位：${error instanceof Error ? error.message : String(error)}`, '先修好团队服务/身份，再决定是否建岗'));
                    }
                }
            }
            const memberSlotsKnown = declared !== null && used !== null;
            let remaining = null;
            if (declared !== null && used !== null)
                remaining = Math.max(0, declared.maxMembers - used);
            const memberSlots = {
                known: memberSlotsKnown,
                remaining,
                total: declared === null ? null : declared.maxMembers,
                used,
            };
            if (declared !== null && used !== null) {
                gaps.push(capacityGap('ACTIVATION_USAGE_UNOBSERVED', 'activation 池的当前占用没有受支持的只读查询（池内计数是私有的），只能声明上限', '把 maxActiveSubagents 当硬上限保守派发；真正的额度由宿主 ACTIVATION_LIMIT_REACHED 兜底，不要用成员名册或子代理列表推算占用'));
            }
            const activations = {
                known: declared !== null,
                remaining: null,
                total: declared === null ? null : declared.maxActiveSubagents,
            };
            const evidence = {
                source: declared === null ? 'unavailable' : declared.source,
                ...(declared === null ? {} : {
                    declaredAt: declared.declaredAt ?? null,
                    declaredBy: declared.declaredBy ?? null,
                    maxMembers: declared.maxMembers,
                    maxActiveSubagents: declared.maxActiveSubagents,
                }),
                usedSeats: used,
            };
            const base = { memberSlots, activations, evidence, gaps };
            if (teams === undefined) {
                return { ok: false, code: SERVICE_UNAVAILABLE, ...base };
            }
            return { ok: true, ...base };
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
