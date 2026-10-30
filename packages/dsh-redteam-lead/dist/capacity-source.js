/**
 * 生效容量的解析（T18）：按调用声明 > 项目声明 > profile 声明 > 本会话观测值 > unknown。
 *
 * 三条硬规则（DECISIONS D1/D12/D25 + T18 的裁决）：
 *
 * 1. **上限只能来自显式声明或宿主拒绝的被动观测**：本模块不猜 8/16、不读宿主私有字段、
 *    也**不为了试探余额而派发**。`CAPACITY_EXHAUSTED` 观测值只在一次**真实需要**的派发
 *    被宿主拒绝后落盘（`re/team/capacity-observed.json`）。
 * 2. **观测值按会话生效**：`TeamId` 就是 Lead 会话 id，席位随会话重置，所以
 *    `session_id` 与当前会话不一致（或无法确定当前会话）的观测值**不得**套用。
 * 3. **「上限未知」与「占用不可观测」是两件事**（D25）：这里只回答“有没有上限”，
 *    activation 的占用仍然恒为 `null`，由派发/收口的 gap 如实报告。
 *
 * 观测值的语义（T18 → T18b）：
 *
 * - 宿主在两条容量拒绝消息里**写着真实数字**（`active child limit: N` / `Team member limit N reached`，
 *   见 `docs/impl/UPSTREAM-API.md`）。解析到就用准确的 N 写对应维度（`parseHostCapacityLimit` +
 *   `observeCapacity`，纯函数，不做 IO）。
 * - 解析不到（宿主改措辞）才回落到 T18 的语义：取**观测当时的已用席位数**（失败成员已计入），
 *   即“你已经到顶了”，是真实上限的**保守下限**。
 * - 落下的是哪一路必须可查（`basis.parsed_limit` / `basis.message`），且**不得降级**：
 *   已经解析到准确值之后，一次不可解析的碰撞不得把它改回推断值。
 */
import { readFile, stat, unlink } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.js';
import { isRecord, recordOf, thrownCode, thrownMessage } from './guards.js';
import { resolveInProject } from './paths.js';
/** 观测值文件（本插件唯一写它的地方：派发撞到宿主上限之后）。 */
export const OBSERVED_CAPACITY_PATH = 're/team/capacity-observed.json';
/** 「观测中」标记：容量未知时，一次真实派发在 spawn 之前写下、结束后删除。 */
export const OBSERVING_MARKER_PATH = 're/team/capacity-observing.json';
/** 观测值文件的 schema 版本。 */
export const OBSERVED_SCHEMA_VERSION = 1;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** `capacity` 入参只允许这两个键（wire schema 是封闭对象）。 */
const CALL_CAPACITY_KEYS = ['max_members', 'max_active_subagents'];
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function gap(code, detail, nextStep) {
    return { code, detail, nextStep };
}
/**
 * 解析按调用声明的 `capacity`。
 *
 * 校验在 `index.ts` 已按 wire schema 做过一遍；这里再判一次是因为 handler 也会被直接调用
 * （测试、恢复路径），而且 `dispatch` 自己实现了 `normalizeDispatchInput`。
 */
export function parseCallCapacity(raw) {
    if (raw === undefined || raw === null)
        return { present: false, value: null, issue: null };
    if (!isRecord(raw) || Array.isArray(raw)) {
        return { present: true, value: null, issue: 'capacity 必须是对象 {max_members, max_active_subagents}' };
    }
    const extra = Object.keys(raw).filter((key) => !CALL_CAPACITY_KEYS.some((allowed) => allowed === key));
    if (extra.length > 0) {
        return { present: true, value: null, issue: `capacity 只接受 ${CALL_CAPACITY_KEYS.join('/')}，多余的字段：${extra.join(', ')}` };
    }
    if (!isPositiveInteger(raw.max_members) || !isPositiveInteger(raw.max_active_subagents)) {
        return {
            present: true,
            value: null,
            issue: 'capacity.max_members 与 capacity.max_active_subagents 都必须是 >=1 的整数',
        };
    }
    return { present: true, value: { max_members: raw.max_members, max_active_subagents: raw.max_active_subagents }, issue: null };
}
/** 宿主消息里**真实数字**的两条格式（T18b 核对安装构建 `app.asar` 得来，见 UPSTREAM-API）。 */
const ACTIVE_CHILD_LIMIT = /active child limit:\s*(\d+)/u;
const TEAM_MEMBER_LIMIT_MESSAGE = /Team member limit (\d+) reached/u;
/** 这个宿主码的解析值落在哪个维度；不认识这条格式就给 `null`。 */
function limitDimension(hostCode) {
    if (hostCode === 'TEAM_MEMBER_LIMIT')
        return 'members';
    if (hostCode === 'ACTIVATION_LIMIT_REACHED')
        return 'activations';
    return null;
}
/**
 * 从宿主**自己抛出的**容量拒绝消息里读出准确上限（纯函数，不做 IO）。
 *
 * 只认这两条稳定码 —— 不把任意宿主消息拿去正则（T18b 边界）：文案是宿主私有实现细节，
 * 换个码就可能撞上同样的字样，届时语义并不相同。
 *
 * 读的是宿主抛给调用方的 `error.message`（被动观测），不碰任何私有字段（D1）。
 */
export function parseHostCapacityLimit(hostCode, message) {
    const dimension = hostCode === null ? null : limitDimension(hostCode);
    if (dimension === null)
        return { pattern: null, limit: null };
    const text = message ?? '';
    const matched = (dimension === 'members' ? TEAM_MEMBER_LIMIT_MESSAGE : ACTIVE_CHILD_LIMIT).exec(text);
    if (matched === null)
        return { pattern: null, limit: null };
    const limit = Number(matched[1]);
    // `\d+` 没有长度上限：只接受安全的 >=1 整数，避免把垃圾文案变成荒谬的上限。
    if (!isPositiveInteger(limit))
        return { pattern: null, limit: null };
    return { pattern: dimension === 'members' ? 'team_member_limit' : 'active_child_limit', limit };
}
/**
 * 把一次容量碰撞折算成观测值（纯函数，不做 IO）。
 *
 * 三条规则：
 *
 * 1. **解析到就写准确值**，只写消息讲到的那个维度；另一个维度取
 *    `max(已有值, used)` —— 既保持 T18 的「used 是保守下限」，也不会因为一条只讲
 *    activation 的消息把已经解析出的 `max_members` 降级回去。
 * 2. **解析不到且已有解析值 → 原样沿用**（`origin: 'retained'`，连 `observed_at` 都不改）：
 *    准确值仍然成立，只是这一次没重新读到；把它改回推断值就是降级。
 * 3. **解析不到且没有解析值 → 回落**为 `used_at_observation`（T18 的语义，`parsed_limit: null`）。
 */
export function observeCapacity(input) {
    const parsed = parseHostCapacityLimit(input.hostCode, input.message);
    const prior = input.existing !== null && input.existing.session_id === input.sessionId ? input.existing : null;
    const message = input.message ?? '';
    if (parsed.limit === null) {
        if (prior !== null && prior.basis.parsed_limit !== null) {
            return { record: prior, origin: 'retained', parsed_limit: null };
        }
        return {
            record: {
                schema_version: OBSERVED_SCHEMA_VERSION,
                session_id: input.sessionId,
                observed_at: input.observedAt,
                max_members: input.used,
                max_active_subagents: input.used,
                basis: {
                    host_code: input.hostCode,
                    parsed_limit: null,
                    used_at_observation: input.used,
                    message,
                },
            },
            origin: 'fallback',
            parsed_limit: null,
        };
    }
    // 消息没讲到的那个维度：沿用更大的那个（已解析值 / 观测当时的已用席位），绝不缩小。
    const untouched = (value) => value === undefined ? input.used : Math.max(value, input.used);
    const dimension = limitDimension(input.hostCode);
    return {
        record: {
            schema_version: OBSERVED_SCHEMA_VERSION,
            session_id: input.sessionId,
            observed_at: input.observedAt,
            max_members: dimension === 'members' ? parsed.limit : untouched(prior?.max_members),
            max_active_subagents: dimension === 'activations' ? parsed.limit : untouched(prior?.max_active_subagents),
            basis: {
                host_code: input.hostCode,
                parsed_limit: parsed.limit,
                used_at_observation: input.used,
                message,
            },
        },
        origin: 'parsed',
        parsed_limit: parsed.limit,
    };
}
/** 读观测值文件；缺失返回「没有」，坏形状/别的会话返回缺口（绝不抛）。 */
export async function readObservedCapacity(root, sessionId) {
    let text;
    try {
        text = await readFile(resolveInProject(root, OBSERVED_CAPACITY_PATH), 'utf8');
    }
    catch (error) {
        if (thrownCode(error) === 'ENOENT')
            return { record: null, gap: null, applies: false };
        return {
            record: null,
            gap: gap('CAPACITY_OBSERVED_UNREADABLE', `读不了 ${OBSERVED_CAPACITY_PATH}：${thrownMessage(error)}`, '确认文件权限/编码后重试；读不到观测值时按「容量未知」处理，不猜上限'),
            applies: false,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            record: null,
            gap: gap('CAPACITY_OBSERVED_INVALID', `${OBSERVED_CAPACITY_PATH} 不是合法 JSON：${thrownMessage(error)}`, `按 T18 的形状重写该文件（schema_version/session_id/observed_at/max_members/max_active_subagents/basis），或删掉它按「容量未知」处理`),
            applies: false,
        };
    }
    if (!isRecord(parsed) || Array.isArray(parsed)) {
        return {
            record: null,
            gap: gap('CAPACITY_OBSERVED_INVALID', `${OBSERVED_CAPACITY_PATH} 必须是 JSON 对象`, '按 T18 的形状重写该文件'),
            applies: false,
        };
    }
    const basis = recordOf(parsed.basis);
    const observedSessionId = nonEmptyString(parsed.session_id) ? parsed.session_id : null;
    const observedAt = nonEmptyString(parsed.observed_at) && ISO_WITH_ZONE.test(parsed.observed_at) ? parsed.observed_at : null;
    const maxMembers = isPositiveInteger(parsed.max_members) ? parsed.max_members : null;
    const maxActiveSubagents = isPositiveInteger(parsed.max_active_subagents) ? parsed.max_active_subagents : null;
    const usedAtObservation = isNonNegativeInteger(basis.used_at_observation) ? basis.used_at_observation : null;
    const hostCode = nonEmptyString(basis.host_code) ? basis.host_code : null;
    // `parsed_limit` 允许**显式 null**（回落路径），那与「字段缺失」是两件事，必须分开判。
    const parsedLimitMissing = !Object.hasOwn(basis, 'parsed_limit');
    const parsedLimit = basis.parsed_limit === null
        ? null
        : (isPositiveInteger(basis.parsed_limit) ? basis.parsed_limit : null);
    const parsedLimitOk = !parsedLimitMissing && (basis.parsed_limit === null || isPositiveInteger(basis.parsed_limit));
    const messageOk = typeof basis.message === 'string';
    const message = typeof basis.message === 'string' ? basis.message : '';
    const problems = [];
    if (parsed.schema_version !== OBSERVED_SCHEMA_VERSION)
        problems.push(`schema_version 必须是 ${OBSERVED_SCHEMA_VERSION}`);
    if (observedSessionId === null)
        problems.push('session_id 必须是非空字符串');
    if (observedAt === null)
        problems.push('observed_at 必须是带时区的 ISO 8601 时间');
    if (maxMembers === null)
        problems.push('max_members 必须是 >=1 的整数');
    if (maxActiveSubagents === null)
        problems.push('max_active_subagents 必须是 >=1 的整数');
    if (usedAtObservation === null)
        problems.push('basis.used_at_observation 必须是 >=0 的整数');
    if (hostCode === null)
        problems.push('basis.host_code 必须是非空字符串');
    if (!parsedLimitOk)
        problems.push('basis.parsed_limit 必须是 null 或 >=1 的整数（回落必须显式记 null）');
    if (!messageOk)
        problems.push('basis.message 必须是字符串（宿主原文，没有文案就是空串）');
    // 解析值只可能来自那两条消息：别的码配一个数字，说明文件被手改过。
    if (parsedLimit !== null && hostCode !== null && limitDimension(hostCode) === null) {
        problems.push('basis.parsed_limit 非 null 时 basis.host_code 必须是 ACTIVATION_LIMIT_REACHED 或 TEAM_MEMBER_LIMIT');
    }
    if (problems.length > 0
        || observedSessionId === null || observedAt === null || maxMembers === null
        || maxActiveSubagents === null || usedAtObservation === null || hostCode === null
        || !parsedLimitOk || !messageOk) {
        return {
            record: null,
            gap: gap('CAPACITY_OBSERVED_INVALID', `${OBSERVED_CAPACITY_PATH} 字段不合法：${problems.join('；')}`, '按 T18b 的形状重写该文件（basis 必须是 host_code/parsed_limit/used_at_observation/message 四字段），'
                + '或删掉它按「容量未知」处理（下一次真实碰撞会重新写一份）；不要手改出一个没观测过的上限'),
            applies: false,
        };
    }
    const record = {
        schema_version: OBSERVED_SCHEMA_VERSION,
        session_id: observedSessionId,
        observed_at: observedAt,
        max_members: maxMembers,
        max_active_subagents: maxActiveSubagents,
        basis: {
            host_code: hostCode,
            parsed_limit: parsedLimit,
            used_at_observation: usedAtObservation,
            message,
        },
    };
    // 会话不一致或无法确定当前会话 → 不套用（席位随会话重置）。
    if (sessionId === null || sessionId !== record.session_id) {
        const mine = sessionId === null ? '当前调用拿不到会话身份' : `当前会话是 ${sessionId}`;
        return {
            record,
            applies: false,
            gap: gap('CAPACITY_OBSERVED_OTHER_SESSION', `${OBSERVED_CAPACITY_PATH} 记录的会话是 ${record.session_id}（${mine}）：席位随会话重置，这个观测值不套用`, '在本会话里重新声明容量（re/team/capacity.json 或本次调用传 capacity），或让本会话的一次真实派发撞出上限；不要复用旧会话的观测值'),
        };
    }
    return { record, gap: null, applies: true };
}
/** 原子写观测值；返回项目内相对路径。 */
export async function writeObservedCapacity(root, record) {
    await writeJsonAtomic(resolveInProject(root, OBSERVED_CAPACITY_PATH), record);
    return OBSERVED_CAPACITY_PATH;
}
/**
 * 读「观测中」标记（缺失/坏 JSON 都不抛）。
 *
 * 同时取该文件自身的 mtime（`modified_at`）：`started_at` 缺失或不可信时，操作者仍要能判断
 * 「这是不是上一次派发崩溃留下的残骸」——一个几小时前的 mtime 与一个刚写下的 mtime，处置完全不同。
 */
export async function readObservationMarker(root) {
    const target = resolveInProject(root, OBSERVING_MARKER_PATH);
    let text;
    try {
        text = await readFile(target, 'utf8');
    }
    catch {
        // 缺失（以及任何读失败）都按「没有标记」处理：标记是本地并发提示，不是宿主事实。
        return {
            present: false,
            session_id: null,
            member: null,
            started_at: null,
            modified_at: null,
            operation_id: null,
            malformed: false,
        };
    }
    let modifiedAt = null;
    try {
        modifiedAt = (await stat(target)).mtime.toISOString();
    }
    catch {
        // 读到了内容却 stat 不到（极少见）：mtime 记为未知，不因此否认标记存在。
        modifiedAt = null;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return {
            present: true,
            session_id: null,
            member: null,
            started_at: null,
            modified_at: modifiedAt,
            operation_id: null,
            malformed: true,
        };
    }
    const view = recordOf(parsed);
    return {
        present: true,
        session_id: nonEmptyString(view.session_id) ? view.session_id : null,
        member: nonEmptyString(view.member) ? view.member : null,
        started_at: nonEmptyString(view.started_at) ? view.started_at : null,
        modified_at: modifiedAt,
        operation_id: nonEmptyString(view.operation_id) ? view.operation_id : null,
        malformed: !isRecord(parsed),
    };
}
/** 写「观测中」标记（spawn 之前；结束/失败后由调用方删除）。 */
export async function writeObservationMarker(root, marker) {
    await writeJsonAtomic(resolveInProject(root, OBSERVING_MARKER_PATH), {
        schema_version: 1,
        session_id: marker.sessionId,
        started_at: marker.startedAt,
        member: marker.member,
        operation_id: marker.operationId,
    });
}
/** 删「观测中」标记（不存在不算错）。 */
export async function clearObservationMarker(root) {
    try {
        await unlink(resolveInProject(root, OBSERVING_MARKER_PATH));
    }
    catch (error) {
        if (thrownCode(error) !== 'ENOENT')
            throw error;
    }
}
/**
 * 并发保护（ticket 第 3 节最后一条）：
 * 无已知容量 + 已有「观测中」标记 → 明确拒绝，避免并行撞出 N 个不可逆损失。
 *
 * 会话判定与观测值同口径：只有能证明「这是别的会话的标记」时才放行；证明不了（无 session_id、
 * 坏 JSON、本调用没有会话身份）一律按本会话处理 —— 拒绝的代价是多等一次，放行的代价是烧名字。
 */
export function capacityMarkerGuard(marker, sessionId) {
    if (!marker.present)
        return { blocked: false, reason: null, next_step: null, foreign: false };
    const sameSession = sessionId !== null && marker.session_id !== null && marker.session_id === sessionId;
    const provablyForeign = sessionId !== null && marker.session_id !== null && marker.session_id !== sessionId;
    if (provablyForeign) {
        return {
            blocked: false,
            reason: `${OBSERVING_MARKER_PATH} 是会话 ${marker.session_id} 留下的（当前会话 ${sessionId}）：席位随会话重置，本次不按「观测中」拒绝`,
            next_step: '确认旧会话的那次派发已结束；这个标记只会被本会话的下一次观测覆盖，不参与宿主判定',
            foreign: true,
        };
    }
    const who = sameSession ? `当前会话 ${String(sessionId)}` : '当前会话（标记里没有可用的 session_id）';
    const member = marker.member ?? '（未记录成员名）';
    const startedAt = marker.started_at ?? '（标记里没有 started_at）';
    const modifiedAt = marker.modified_at ?? '（取不到文件 mtime）';
    return {
        blocked: true,
        reason: `容量仍未声明，但 ${OBSERVING_MARKER_PATH} 显示上一次派发正在观测宿主上限`
            + `（成员 ${member}，标记内 started_at=${startedAt}，文件 mtime=${modifiedAt}，${who}）：`
            + '现在再派发可能再撞一次、再烧一个成员名与席位',
        next_step: `等那次派发结束（它会把观测值写进 ${OBSERVED_CAPACITY_PATH} 并删除标记）后再派发；`
            + `若两个时间都很久以前、或那次派发已经死了，这个标记就是**崩溃留下的残骸**：`
            + `先核对成员名册里 ${member} 是否已存在/失败，再手工删除 ${OBSERVING_MARKER_PATH} 重试`,
        foreign: false,
    };
}
/** 容量来源的缺口（诊断用；`capacity_source` 必须出现在 reason 里）。 */
export function capacitySourceGap(source, limits, observed) {
    if (source === 'call') {
        return gap('CAPACITY_SOURCE', `容量来源 capacity_source=call：本次调用声明 maxMembers=${String(limits.max_members)}、`
            + `maxActiveSubagents=${String(limits.max_active_subagents)}（优先于 re/team/capacity.json 与 profile config.capacity）`, '换一个上限就用新的 capacity 重新 inspect（提议与生效上限绑定）；要让项目长期按这个上限跑，把它写进 re/team/capacity.json');
    }
    if (source === 'observed') {
        const basis = observed === null
            ? ''
            : `（观测于 ${observed.observed_at}，宿主码 ${observed.basis.host_code}，观测当时已用 ${String(observed.basis.used_at_observation)} 席；`
                + `${observed.basis.parsed_limit === null
                    ? `宿主消息里没有可解析的数字 → 上限**回落**为观测当时的已用席位数，原文「${observed.basis.message}」`
                    : `上限是**从宿主消息里解析出的准确值** ${String(observed.basis.parsed_limit)}`}）`;
        const parsed = observed !== null && observed.basis.parsed_limit !== null;
        return gap('CAPACITY_SOURCE', `容量来源 capacity_source=observed：本会话上一次派发撞到宿主上限时观测到的上限 `
            + `maxMembers=${String(limits.max_members)}、maxActiveSubagents=${String(limits.max_active_subagents)}${basis}`, parsed
            ? '这是宿主消息里的准确值，但上限**可能因为改设置而失效**：下一次再撞到会用新解析出的数字覆盖（并更新 observed_at）；'
                + '要写死就在 re/team/capacity.json（或本次调用传 capacity）声明；不要为了刷新它而故意再撞一次'
            : '这是「你已经到顶了」的**回落**下限，不是宿主的真实声明：要放宽或写死上限请在 re/team/capacity.json'
                + '（或本次调用传 capacity）声明；不要靠再撞一次去试探余额');
    }
    return gap('CAPACITY_SOURCE', '容量来源 capacity_source=unknown：re/team/capacity.json 与 profile config.capacity 都没有声明，本会话也还没有观测值', '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents（或本次调用传 capacity）；'
        + '未声明时 rt_dispatch 会照派，并在宿主拒绝时学一次上限（最多烧一个成员名与席位）');
}
/**
 * 解析生效容量（纯函数，不做 IO）。
 *
 * 优先级：`call` > `project` > `profile` > `observed`（同会话）> `unknown`。
 * 适配器已经把「项目声明 > profile 声明」合过一次，`evidence.source` 只是来源标签。
 */
export function resolveCapacity({ call, declared, observed }) {
    const memberSlotsView = recordOf(declared.memberSlots);
    const activationsView = recordOf(declared.activations);
    const evidenceView = recordOf(declared.evidence);
    const used = typeof memberSlotsView.used === 'number' && Number.isSafeInteger(memberSlotsView.used)
        ? memberSlotsView.used
        : null;
    const declaredSource = nonEmptyString(evidenceView.source) ? evidenceView.source : 'unavailable';
    const declaredMembers = typeof memberSlotsView.total === 'number' ? memberSlotsView.total : null;
    const declaredActivations = typeof activationsView.total === 'number' ? activationsView.total : null;
    let source = 'unknown';
    let maxMembers = null;
    let maxActiveSubagents = null;
    let evidenceSource = declaredSource;
    if (call !== null) {
        source = 'call';
        maxMembers = call.max_members;
        maxActiveSubagents = call.max_active_subagents;
        evidenceSource = 'call';
    }
    else if (declaredSource === 'declared:re/team/capacity.json' || declaredSource === 'declared:profile-config') {
        source = declaredSource === 'declared:profile-config' ? 'profile' : 'project';
        maxMembers = declaredMembers;
        maxActiveSubagents = declaredActivations;
    }
    else if (observed.record !== null && observed.applies) {
        source = 'observed';
        maxMembers = observed.record.max_members;
        maxActiveSubagents = observed.record.max_active_subagents;
        evidenceSource = 'observed';
    }
    const remaining = maxMembers !== null && used !== null ? Math.max(0, maxMembers - used) : null;
    const memberSlots = {
        known: remaining !== null,
        remaining,
        total: maxMembers,
        used,
    };
    // D25：activation 的当前占用没有受支持的只读查询 —— `remaining` 恒为 null，只声明上限。
    const activations = {
        known: maxActiveSubagents !== null,
        remaining: null,
        total: maxActiveSubagents,
    };
    const gaps = [];
    for (const raw of Array.isArray(declared.gaps) ? declared.gaps : []) {
        const entry = recordOf(raw);
        const code = nonEmptyString(entry.code) ? entry.code : 'CAPACITY_UNKNOWN';
        // 高层已经给出上限时，「没有声明」这条已经过时（否则诊断会自相矛盾）。
        if (source !== 'project' && source !== 'profile'
            && (code === 'CAPACITY_DECLARATION_MISSING' || code === 'CAPACITY_DECLARATION_INVALID')) {
            continue;
        }
        gaps.push(gap(code, nonEmptyString(entry.detail) ? entry.detail : '容量声明或计数不可用', nonEmptyString(entry.nextStep) ? entry.nextStep : '在 re/team/capacity.json 声明 maxMembers/maxActiveSubagents 后重试'));
    }
    if (observed.gap !== null)
        gaps.push(observed.gap);
    // 项目/profile 声明是既有行为（D1）：不加新诊断，保证已声明容量的项目输出逐字不变。
    if (source === 'call' || source === 'observed' || source === 'unknown') {
        gaps.push(capacitySourceGap(source, { max_members: maxMembers, max_active_subagents: maxActiveSubagents }, observed.record));
    }
    return {
        source,
        evidence_source: evidenceSource,
        memberSlots,
        activations,
        gaps,
        observed: observed.record,
    };
}
